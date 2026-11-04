// The flake gate (`npm run flake:gate`, the `gate:flake` stage of TEST_STRATEGY.md section 6.1): it judges the runs just recorded against the
// history and the quarantine list, and says, for everything that fails, which decision the failure drives.
//
//   exit 0  nothing to act on
//   exit 1  a flaky test above the trigger that is not quarantined; an engine job above the suite budget; an expired quarantine
//           (and, said apart, an expired quarantine of a merge-tier test); a quarantine list that is not valid
//   exit 2  the gate could not judge: no run file, a history it cannot read, arguments it cannot use
//
// It is not a verdict on the pull request's own failures: a test that failed after its retry already failed the browser job.
// This file is the judgement and its rendering, as pure functions of their input; the command line is at the end.
import { FLAKE_LIMITS } from '../src/shared/criteria.ts';
import { CATALOG_AREAS } from '../tools/catalog.ts';
import type { AreaCode } from '../tools/catalog.ts';
import { mergeHistories } from './history.ts';
import { addDays, assessQuarantine, expiredEntries, findQuarantine, maxAgeDays } from './quarantine.ts';
import type {
  CatalogFacts,
  ExpiredEntry,
  QuarantineEntry,
  QuarantineLimits,
  ReadResult,
} from './quarantine.ts';
import { isExecuted } from './run.ts';
import type { FlakeRun } from './run.ts';
import { flakeStats, percent } from './stats.ts';
import type { FlakeLimits, SuiteStats, TestStats } from './stats.ts';

export type FailureKind =
  'over-trigger' | 'suite-budget' | 'quarantine-expired' | 'merge-quarantine-expired' | 'quarantine-invalid';

export interface GateFailure {
  kind: FailureKind;
  /** The test and engine, the engine job, or the quarantine file. */
  subject: string;
  /** What is wrong, with the numbers. */
  message: string;
  /** What to do about it, who, and by when. */
  decision: string;
}

export interface JudgedTest {
  stats: TestStats;
  /** The entry that quarantines the test today, or null. */
  quarantine: QuarantineEntry | null;
}

export interface GateInput {
  /** What was recorded before this build, oldest first. Runs of other environments are not used. */
  history: readonly FlakeRun[];
  /** The runs just recorded by this build (one per Playwright invocation). A run already in the history is not counted twice. */
  current: readonly FlakeRun[];
  /** `YYYY-MM-DD`, UTC. */
  today: string;
  /** The quarantine list as read from the file (its shape problems included). */
  quarantine: ReadResult;
  catalog: CatalogFacts;
  limits?: FlakeLimits & QuarantineLimits;
}

export interface GateReport {
  pass: boolean;
  today: string;
  envId: string;
  /** Runs the judgement is made of: the history of the environment with this build's runs. */
  runsJudged: number;
  currentRuns: number;
  failures: GateFailure[];
  /** What is worth knowing and does not fail the gate. */
  notes: string[];
  /** The tests this build ran, with their window. */
  tests: JudgedTest[];
  /** The engine jobs this build ran. */
  suites: SuiteStats[];
  quarantine: { effective: QuarantineEntry[]; expired: ExpiredEntry[]; problems: string[] };
}

const defaultLimits = (): FlakeLimits & QuarantineLimits => FLAKE_LIMITS;

function areaTitle(id: string): string {
  const code = /^PB-([A-Z]+)-\d{3}$/.exec(id)?.[1];
  const area = code ? CATALOG_AREAS[code as AreaCode] : undefined;
  return area ? `${area.title} (${code})` : 'the test';
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const rate = (flaky: number, runs: number): string =>
  runs === 0 ? 'no executions' : `${flaky} flaky of ${plural(runs, 'execution')} (${percent(flaky / runs)})`;

function overTriggerFailure(
  t: TestStats,
  today: string,
  limits: FlakeLimits & QuarantineLimits,
  expired: ExpiredEntry | undefined,
): GateFailure {
  const tier = t.tier === 'merge' ? 'merge' : 'release';
  const days = maxAgeDays(tier, limits);
  const last = t.lastFailure;
  const where = last
    ? ` Last ${last.outcome === 'flaky' ? 'flake' : 'failure'}: ${last.signature ?? 'no error message recorded'} (run ${last.runId}, ${last.date.slice(0, 10)}, commit ${last.commit.slice(0, 8)}).`
    : '';
  const lapsed = expired
    ? ` Its quarantine expired on ${expired.entry.expires}, so it is back on the gate.`
    : '';
  return {
    kind: 'over-trigger',
    subject: `${t.id} on ${t.project}`,
    message: `${t.id} on ${t.project} is above the quarantine trigger: ${rate(t.flaky, t.executions)}, the trigger is ${percent(limits.quarantineTriggerRate)}, over the last ${plural(t.executions, 'execution')}.${where}${lapsed}`,
    decision: `Fix ${t.id} on ${t.project} today, or quarantine it today. Who: the owner of the ${areaTitle(t.id)} area, named as the owner of the entry. To quarantine, add an entry to flake/quarantine.json with the owner, the reason with the evidence that the failure is not deterministic (the same commit failed and passed), the evidence (an issue or a CI run), since ${today} and an expiry no later than ${addDays(today, days)} (a ${tier}-tier test: at most ${days} days). The gate stays red until one of the two has happened. Do not rerun the job: look first at the trace of the first failed attempt, not the green retry.`,
  };
}

function suiteFailure(s: SuiteStats, today: string, limits: FlakeLimits & QuarantineLimits): GateFailure {
  const who = s.contributors.length
    ? ` The tests that flaked: ${s.contributors.map((c) => `${c.id} (${c.flaky} of ${c.executions})`).join(', ')}.`
    : '';
  return {
    kind: 'suite-budget',
    subject: `engine job ${s.project}`,
    message: `The suite flake rate of the ${s.project} engine job is above its budget: ${rate(s.flaky, s.executions)} over the last ${plural(s.builds, 'build')}, the budget is ${percent(s.budget)}.${who}`,
    decision: `Look at the environment first (the runner, the browser version, PB-ENV-001 in this build), since flakiness spread across tests points there. Then fix, or quarantine today (an expiry no later than ${addDays(today, maxAgeDays('merge', limits))} for a merge-tier test), the tests that contribute most: a quarantined test leaves the suite rate, the old executions with it. Who: the lab maintainer with the owners of those tests. The gate stays red until the rate is within the budget.`,
  };
}

function expiredFailure(e: ExpiredEntry, catalog: CatalogFacts): GateFailure {
  const { entry } = e;
  const age = plural(e.daysOver, 'day');
  const subject = `${entry.id}${entry.project ? ` on ${entry.project}` : ''}`;
  const tier = e.tier ?? catalog.get(entry.id)?.tier ?? null;
  if (tier === 'merge') {
    return {
      kind: 'merge-quarantine-expired',
      subject,
      message: `The quarantine of the merge-tier test ${subject} expired on ${entry.expires} (${age} ago). It has left a hole in the merge gate over a high-risk scenario for longer than the policy allows. Owner: ${entry.owner}. Reason given: ${entry.reason}`,
      decision: `Fix ${entry.id} or replace it with a cheaper, deterministic test of the same risk (assert on the request log rather than on timing), and remove the entry from flake/quarantine.json in the same pull request. Who: ${entry.owner}. By when: now. A merge-tier quarantine is not renewed; the gate stays red until the entry is gone, and the test is on the gate again from the day it expired.`,
    };
  }
  return {
    kind: 'quarantine-expired',
    subject,
    message: `The quarantine of ${subject} expired on ${entry.expires} (${age} ago). Owner: ${entry.owner}. Reason given: ${entry.reason}`,
    decision: `Fix ${entry.id} and remove the entry from flake/quarantine.json (the test returns to its gate), or retire it by removing its row from the catalog in a pull request that says why. Who: ${entry.owner}. By when: now; the gate stays red until the entry is gone. The test is on the gate again from the day it expired.`,
  };
}

function invalidFailure(problem: string): GateFailure {
  return {
    kind: 'quarantine-invalid',
    subject: 'flake/quarantine.json',
    message: `The quarantine list is not valid: ${problem}`,
    decision: `Fix flake/quarantine.json (git log flake/quarantine.json says who changed it last). By when: before this merge. An entry with a problem quarantines nothing, so a test that is named wrongly is on the gate until it is right.`,
  };
}

/** Judges a build. A pure function of what it is given: the history, the build's runs, the list, the catalog and the day. */
export function evaluateGate(input: GateInput): GateReport {
  const limits = input.limits ?? defaultLimits();
  const { today, catalog } = input;
  const envs = new Set(input.current.map((run) => run.envId));
  const envId = [...envs].sort().join(', ');
  const runs = mergeHistories([input.history.filter((run) => envs.has(run.envId)), input.current]);

  const assessed = assessQuarantine(input.quarantine, { catalog, today, limits });
  const expired = expiredEntries(input.quarantine.entries, today, catalog);
  const quarantinedNow = (id: string, project: string): boolean =>
    findQuarantine(assessed.effective, id, project, today) !== null;

  const stats = flakeStats(runs, { limits, quarantined: quarantinedNow });

  const ran = new Set<string>();
  const projects = new Set<string>();
  for (const run of input.current) {
    for (const test of run.tests) {
      if (!isExecuted(test.outcome)) continue;
      ran.add(`${test.project}\u0000${test.id}`);
      projects.add(test.project);
    }
  }
  const tests: JudgedTest[] = stats.tests
    .filter((t) => ran.has(`${t.project}\u0000${t.id}`))
    .map((t) => ({ stats: t, quarantine: findQuarantine(assessed.effective, t.id, t.project, today) }));
  const suites = stats.suites.filter((s) => projects.has(s.project));

  const failures: GateFailure[] = [];
  const notes: string[] = [];

  for (const problem of assessed.problems) failures.push(invalidFailure(problem));
  for (const e of expired) failures.push(expiredFailure(e, catalog));

  for (const { stats: t, quarantine } of tests) {
    if (t.verdict === 'over-trigger') {
      if (quarantine) {
        notes.push(
          `${t.id} on ${t.project} is above the trigger (${rate(t.flaky, t.executions)}) and quarantined until ${quarantine.expires} (owner ${quarantine.owner}): it still runs, non-blocking, and is not in the suite rate.`,
        );
      } else {
        const lapsed = expired.find(
          (e) => e.entry.id === t.id && (e.entry.project ?? t.project) === t.project,
        );
        failures.push(overTriggerFailure(t, today, limits, lapsed));
      }
    } else if (quarantine && t.cleanWindow) {
      notes.push(
        `${t.id} on ${t.project} has had a full clean window (${plural(t.executions, 'execution')}, none flaky or failed) while quarantined: ${quarantine.owner} can remove the entry and the test returns to its gate.`,
      );
    }
  }
  for (const s of suites) {
    if (s.verdict === 'over-budget') failures.push(suiteFailure(s, today, limits));
    else if (s.verdict === 'not-enough-data') {
      notes.push(
        `${s.project}: the suite flake rate is not judged yet: ${s.builds} of the ${limits.minRunsToJudge} builds it needs (${rate(s.flaky, s.executions)}).`,
      );
    }
  }
  const unjudged = tests.filter((t) => t.stats.verdict === 'not-enough-data');
  if (unjudged.length > 0) {
    notes.push(
      `${plural(unjudged.length, 'test')} of this build ${unjudged.length === 1 ? 'has' : 'have'} fewer than ${limits.minRunsToJudge} executions in the window and no verdict yet.`,
    );
  }

  const order: FailureKind[] = [
    'quarantine-invalid',
    'merge-quarantine-expired',
    'quarantine-expired',
    'over-trigger',
    'suite-budget',
  ];
  failures.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.subject.localeCompare(b.subject),
  );

  return {
    pass: failures.length === 0,
    today,
    envId,
    runsJudged: runs.length,
    currentRuns: input.current.length,
    failures,
    notes,
    tests,
    suites,
    quarantine: { effective: assessed.effective, expired, problems: assessed.problems },
  };
}

/** The tests worth a row in the gate's output: everything that is not a plain `ok`. */
export function interestingTests(report: GateReport): JudgedTest[] {
  return report.tests.filter((t) => t.stats.verdict !== 'ok' || t.quarantine !== null || t.stats.flaky > 0);
}

export function exitCode(report: GateReport): 0 | 1 {
  return report.pass ? 0 : 1;
}

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

/** The gate's output: the verdict, the tables, then each failure with the decision it drives. */
export function renderGate(report: GateReport, limits: FlakeLimits = FLAKE_LIMITS): string {
  const out: string[] = [];
  out.push(
    `flake gate: ${report.pass ? 'PASS' : `FAIL (${plural(report.failures.length, 'failure')})`}  [${report.envId}, ${report.today}, ${plural(report.currentRuns, 'run')} in this build, ${plural(report.runsJudged, 'run')} judged]`,
  );

  if (report.suites.length > 0) {
    out.push(
      '',
      `Suite flake rate per engine job (merge-tier tests, the last ${limits.windowRuns} builds, quarantined tests left out)`,
    );
    out.push(
      row([
        'engine job',
        'builds',
        'executions',
        'flaky',
        'rate',
        'budget',
        'verdict',
        'left out (quarantined)',
      ]),
    );
    out.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
    for (const s of report.suites) {
      out.push(
        row([
          s.project + (s.experimental ? ' (experimental)' : ''),
          s.builds,
          s.executions,
          s.flaky,
          percent(s.flakeRate),
          percent(s.budget),
          s.verdict,
          s.quarantinedExecutions,
        ]),
      );
    }
  }

  const shown = interestingTests(report);
  if (report.tests.length > 0) {
    out.push(
      '',
      `Tests of this build (the last ${limits.windowRuns} executions each, judged from ${limits.minRunsToJudge}; ${report.tests.length - shown.length} with no flaky outcome are not listed)`,
    );
    if (shown.length > 0) {
      out.push(row(['test', 'engine', 'executions', 'flaky', 'failed', 'rate', 'verdict', 'quarantine']));
      out.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
      for (const { stats: t, quarantine } of shown) {
        out.push(
          row([
            t.id,
            t.project,
            t.executions,
            t.flaky,
            t.failed,
            percent(t.flakeRate),
            t.verdict,
            quarantine ? `until ${quarantine.expires} (${quarantine.owner})` : 'no',
          ]),
        );
      }
    }
  }

  if (report.notes.length > 0) out.push('', 'Notes', ...report.notes.map((n) => `- ${n}`));
  if (report.failures.length > 0) {
    out.push('', 'Failures, and the decision each one drives');
    report.failures.forEach((f, i) => {
      out.push(`${i + 1}. [${f.kind}] ${f.message}`, `   Decision: ${f.decision}`);
    });
  }
  return out.join('\n');
}
