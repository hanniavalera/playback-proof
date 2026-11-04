// The arithmetic of the flake policy (TEST_STRATEGY.md section 7.2, ADR-022), as pure functions over the recorded runs. Nothing here
// reads a file or the clock: the history comes in, numbers and verdicts come out, so every rule can be tested against known answers.
//
//   per test    (id, project): the last `windowRuns` executions -> flake rate, failure rate, a verdict
//   per engine  project: the merge-tier tests of the last `windowRuns` builds -> the suite rate against the budget
//   per test    (id, project): the last `windowRuns` scheduled executions -> the share of invalid runs against its budget
//
// The flake rate is METRICS.md's: passed only after a retry / executions. Three choices of this module are not in that line, and each
// is argued in docs/decisions/flake.md:
//   - An execution whose configuration gave the test no retry cannot show a flake (it shows as a failure), so it is not an observation
//     of flakiness: it is left out of every rate and counted on its own (`unobserved`).
//   - A quarantined test is judged on all its executions, including the ones it ran non-blocking, because "back after one full clean
//     window" can only mean its own window. The suite rate, the budget of the gate, is the one that leaves quarantined executions out.
//   - The suite rate is judged once the window holds `minRunsToJudge` builds: the policy gives a test that minimum, and one flaky
//     outcome in the first build of a new history would otherwise read as 7 % of the suite.
//
// The invalid-run share (ADR-135a) is not a flake rate and shares none of those choices: it counts invalid runs (a skip whose reason
// starts with `INVALID_RUN_PREFIX`) over the scheduled executions (invalid runs and executions that ran to a verdict), retry or not;
// documented-gap skips and interrupted tests are neither; and quarantine is not an input, because it is about flakiness and cannot
// make an environment evaluate a claim: a quarantined test's scheduled executions count like any other.
import { FLAKE_LIMITS } from '../src/shared/criteria.ts';
import { executionsOf, scheduledOf } from './run.ts';
import type { ExecutedOutcome, Execution, FlakeRun, Scheduled, Tier } from './run.ts';

export interface FlakeLimits {
  readonly windowRuns: number;
  readonly minRunsToJudge: number;
  readonly quarantineTriggerRate: number;
  readonly suiteBudgetRate: number;
  readonly invalidRunBudgetRate: number;
}

export const DEFAULT_LIMITS: FlakeLimits = FLAKE_LIMITS;

export type Verdict = 'not-enough-data' | 'ok' | 'watch' | 'over-trigger';
export type SuiteVerdict = 'not-enough-data' | 'ok' | 'over-budget';
export type InvalidRunVerdict = 'not-enough-data' | 'ok' | 'over-invalid-budget';

export interface StatsOptions {
  limits?: FlakeLimits;
  /** Whether a test is quarantined now (the quarantine list, today): its executions leave the suite rate, old ones included. */
  quarantined?: (id: string, project: string) => boolean;
}

export interface LastFailure {
  outcome: 'flaky' | 'failed' | 'timedOut';
  date: string;
  runId: string;
  commit: string;
  /** The error signature of the first failed attempt (null when the run recorded none). */
  signature: string | null;
}

export interface TestStats {
  id: string;
  project: string;
  tier: Tier | null;
  /** Executions in the window (the last `windowRuns` that could have shown a flake). */
  executions: number;
  passed: number;
  flaky: number;
  /** Failed after every attempt: `failed` and `timedOut`. */
  failed: number;
  /** flaky / executions; 0 without executions. */
  flakeRate: number;
  /** failed / executions; 0 without executions. */
  failureRate: number;
  verdict: Verdict;
  /** The window, oldest first. */
  window: ExecutedOutcome[];
  /** Executions in the window that ran as quarantined: reported, and still part of the test's own window. */
  quarantinedExecutions: number;
  /** Every execution of the test the history holds, whatever the window (and whether or not it could show a flake). */
  executionsInHistory: number;
  /** Executions in the history that had no retry: they say nothing about flakiness and are in no rate. */
  unobserved: number;
  /** The newest flaky or failed execution of the window. */
  lastFailure: LastFailure | null;
  /** The window is full and nothing in it flaked or failed: what a quarantined test needs before it returns to its gate. */
  cleanWindow: boolean;
  experimental: boolean;
}

export interface FlakyContributor {
  id: string;
  flaky: number;
  executions: number;
}

export interface SuiteStats {
  project: string;
  /** The builds of the window: distinct runs in which this engine job ran merge-tier tests that count. */
  builds: number;
  /** Merge-tier executions of the engine job in those builds, quarantined ones left out. */
  executions: number;
  flaky: number;
  failed: number;
  flakeRate: number;
  budget: number;
  verdict: SuiteVerdict;
  /** Merge-tier executions of the same builds that were left out because the test is quarantined: reported, never counted. */
  quarantinedExecutions: number;
  quarantinedFlaky: number;
  /** Merge-tier executions with no retry: they say nothing about flakiness and are in no rate. */
  unobserved: number;
  /** The tests that flaked in the window, the worst first: where the suite's rate comes from. */
  contributors: FlakyContributor[];
  experimental: boolean;
}

export interface LastInvalid {
  date: string;
  runId: string;
  commit: string;
  /** The reason of the skip, whole: the numbers of the attempt come first (`invalidRunReason`). */
  reason: string;
}

export interface InvalidRunStats {
  id: string;
  project: string;
  tier: Tier | null;
  /** Scheduled executions in the window: the last `windowRuns` that were invalid runs or ran to a verdict. */
  scheduled: number;
  /** Of those, the ones ended as invalid runs. */
  invalid: number;
  /** invalid / scheduled; 0 without scheduled executions. */
  share: number;
  budget: number;
  verdict: InvalidRunVerdict;
  /** The newest invalid run of the window. */
  lastInvalid: LastInvalid | null;
  experimental: boolean;
}

export interface FlakeStats {
  tests: TestStats[];
  suites: SuiteStats[];
  /** Per test and engine with at least one scheduled execution, a test that was only ever an invalid run included. */
  invalidRuns: InvalidRunStats[];
}

/** `0.0667` as `6.7%`. */
export function percent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

const divide = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** The last `n` items. `slice(-0)` would be everything, hence the guard. */
function lastOf<T>(items: readonly T[], n: number): T[] {
  return n <= 0 ? [] : items.slice(-n);
}

function judge(flaky: number, executions: number, limits: FlakeLimits): Verdict {
  if (executions < limits.minRunsToJudge) return 'not-enough-data';
  // "Above" the trigger: 1 flaky of the minimum 20 is exactly 5 % and is not above it. Both sides are the nearest double of the same
  // real number when they are equal, and any k/n with n <= 30 that differs from it differs by far more than a rounding error.
  if (flaky / executions > limits.quarantineTriggerRate) return 'over-trigger';
  return flaky > 0 ? 'watch' : 'ok';
}

const key = (id: string, project: string): string => `${project}\u0000${id}`;

export function testStats(runs: readonly FlakeRun[], limits: FlakeLimits = DEFAULT_LIMITS): TestStats[] {
  const groups = new Map<string, Execution[]>();
  for (const execution of executionsOf(runs)) {
    const k = key(execution.id, execution.project);
    const group = groups.get(k);
    if (group) group.push(execution);
    else groups.set(k, [execution]);
  }

  const out: TestStats[] = [];
  for (const history of groups.values()) {
    const [first] = history;
    if (!first) continue;
    const observed = history.filter((e) => e.retries > 0);
    const window = lastOf(observed, limits.windowRuns);
    const flaky = window.filter((e) => e.outcome === 'flaky').length;
    const failed = window.filter((e) => e.outcome === 'failed' || e.outcome === 'timedOut').length;
    const newest = [...window].reverse().find((e) => e.outcome !== 'passed');
    out.push({
      id: first.id,
      project: first.project,
      // The newest record decides: a test that gains a tag moves tier.
      tier: history[history.length - 1]?.tier ?? null,
      executions: window.length,
      passed: window.length - flaky - failed,
      flaky,
      failed,
      flakeRate: divide(flaky, window.length),
      failureRate: divide(failed, window.length),
      verdict: judge(flaky, window.length, limits),
      window: window.map((e) => e.outcome),
      quarantinedExecutions: window.filter((e) => e.quarantined).length,
      executionsInHistory: history.length,
      unobserved: history.length - observed.length,
      lastFailure:
        newest && newest.outcome !== 'passed'
          ? {
              outcome: newest.outcome,
              date: newest.date,
              runId: newest.runId,
              commit: newest.commit,
              signature: newest.signature,
            }
          : null,
      cleanWindow: window.length >= limits.windowRuns && flaky === 0 && failed === 0,
      experimental: history.some((e) => e.experimental),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.project.localeCompare(b.project));
}

/**
 * The suite rate of every engine job (project): retried-then-passed / executions of the merge-tier tests, over the last
 * `windowRuns` builds. A build is a run (CI run id) in which the engine job executed merge-tier tests that were not quarantined.
 */
export function suiteStats(runs: readonly FlakeRun[], options: StatsOptions = {}): SuiteStats[] {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const quarantinedNow = options.quarantined ?? (() => false);
  const mergeTier = executionsOf(runs).filter((e) => e.tier === 'merge');

  const projects = [...new Set(mergeTier.map((e) => e.project))].sort();
  const out: SuiteStats[] = [];
  for (const project of projects) {
    const executions = mergeTier.filter((e) => e.project === project);
    const unobserved = executions.filter((e) => e.retries === 0).length;
    const observed = executions.filter((e) => e.retries > 0);

    const builds: string[] = [];
    for (const e of observed) {
      if (!e.quarantined && !builds.includes(e.runId)) builds.push(e.runId);
    }
    const inWindow = new Set(lastOf(builds, limits.windowRuns));
    const ofWindow = observed.filter((e) => inWindow.has(e.runId));

    const left = ofWindow.filter((e) => e.quarantined || quarantinedNow(e.id, e.project));
    const counted = ofWindow.filter((e) => !(e.quarantined || quarantinedNow(e.id, e.project)));
    const flaky = counted.filter((e) => e.outcome === 'flaky').length;
    const failed = counted.filter((e) => e.outcome === 'failed' || e.outcome === 'timedOut').length;

    const perTest = new Map<string, FlakyContributor>();
    for (const e of counted) {
      const entry = perTest.get(e.id) ?? { id: e.id, flaky: 0, executions: 0 };
      entry.executions += 1;
      if (e.outcome === 'flaky') entry.flaky += 1;
      perTest.set(e.id, entry);
    }
    const flakeRate = divide(flaky, counted.length);
    out.push({
      project,
      builds: inWindow.size,
      executions: counted.length,
      flaky,
      failed,
      flakeRate,
      budget: limits.suiteBudgetRate,
      verdict:
        inWindow.size < limits.minRunsToJudge
          ? 'not-enough-data'
          : flakeRate > limits.suiteBudgetRate
            ? 'over-budget'
            : 'ok',
      quarantinedExecutions: left.length,
      quarantinedFlaky: left.filter((e) => e.outcome === 'flaky').length,
      unobserved,
      contributors: [...perTest.values()]
        .filter((c) => c.flaky > 0)
        .sort((a, b) => b.flaky - a.flaky || a.id.localeCompare(b.id)),
      experimental: ofWindow.some((e) => e.experimental),
    });
  }
  return out;
}

function judgeInvalid(invalid: number, scheduled: number, limits: FlakeLimits): InvalidRunVerdict {
  if (scheduled < limits.minRunsToJudge) return 'not-enough-data';
  // Above the budget, strictly, as the other two are: 8 invalid runs of 20, or 12 of 30, are exactly 40% and within it.
  return invalid / scheduled > limits.invalidRunBudgetRate ? 'over-invalid-budget' : 'ok';
}

/**
 * The invalid-run share of every test and engine that has a scheduled execution: invalid runs / scheduled executions over the last
 * `windowRuns` of them, judged from `minRunsToJudge`. A test that was only ever an invalid run is in it (it has no execution, so it is
 * in no flake statistic: it would otherwise be invisible, which is the case the budget exists for). Quarantine is not an input.
 */
export function invalidRunStats(
  runs: readonly FlakeRun[],
  limits: FlakeLimits = DEFAULT_LIMITS,
): InvalidRunStats[] {
  const groups = new Map<string, Scheduled[]>();
  for (const scheduled of scheduledOf(runs)) {
    const k = key(scheduled.id, scheduled.project);
    const group = groups.get(k);
    if (group) group.push(scheduled);
    else groups.set(k, [scheduled]);
  }

  const out: InvalidRunStats[] = [];
  for (const history of groups.values()) {
    const [first] = history;
    if (!first) continue;
    const window = lastOf(history, limits.windowRuns);
    const invalid = window.filter((s) => s.invalid);
    const newest = invalid[invalid.length - 1];
    out.push({
      id: first.id,
      project: first.project,
      tier: history[history.length - 1]?.tier ?? null,
      scheduled: window.length,
      invalid: invalid.length,
      share: divide(invalid.length, window.length),
      budget: limits.invalidRunBudgetRate,
      verdict: judgeInvalid(invalid.length, window.length, limits),
      lastInvalid: newest
        ? { date: newest.date, runId: newest.runId, commit: newest.commit, reason: newest.reason ?? '' }
        : null,
      experimental: history.some((s) => s.experimental),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.project.localeCompare(b.project));
}

/** The most invalid runs that a full window can hold and still be within the budget: 12 of 30 at 40%. */
export function invalidRunsAllowed(limits: FlakeLimits = DEFAULT_LIMITS): number {
  let allowed = 0;
  while ((allowed + 1) / limits.windowRuns <= limits.invalidRunBudgetRate) allowed += 1;
  return allowed;
}

export function flakeStats(runs: readonly FlakeRun[], options: StatsOptions = {}): FlakeStats {
  return {
    tests: testStats(runs, options.limits),
    suites: suiteStats(runs, options),
    invalidRuns: invalidRunStats(runs, options.limits),
  };
}
