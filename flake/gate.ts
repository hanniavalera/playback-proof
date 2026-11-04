// The flake gate (`npm run flake:gate`, the `gate:flake` stage of TEST_STRATEGY.md section 6.1): it judges the runs just recorded against the
// history and the quarantine list, and says, for everything that fails, which decision the failure drives.
//
//   exit 0  nothing to act on
//   exit 1  a flaky test above the trigger that is not quarantined; an engine job above the suite budget; a test whose invalid runs are
//           above their budget, quarantined or not (ADR-135a); an expired quarantine (and, said apart, an expired quarantine of a
//           merge-tier test); a quarantine list that is not valid
//   exit 2  the gate could not judge: no run file, a history it cannot read, arguments it cannot use
//
// It is not a verdict on the pull request's own failures: a test that failed after its retry already failed the browser job.
// This file is the judgement and its rendering, as pure functions of their input; the command line is at the end.
import { FLAKE_LIMITS } from '../src/shared/criteria.ts';
import { CATALOG_AREAS } from '../tools/catalog.ts';
import type { AreaCode } from '../tools/catalog.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  appendStepSummary,
  EnvironmentProblem,
  environmentOf,
  findRunFiles,
  parseCliArgs,
  readRunFiles,
  storeFromArgs,
} from './cli.ts';
import { HistoryError, mergeHistories } from './history.ts';
import {
  addDays,
  assessQuarantine,
  expiredEntries,
  findQuarantine,
  loadList,
  maxAgeDays,
  utcDay,
} from './quarantine.ts';
import type {
  CatalogFacts,
  ExpiredEntry,
  QuarantineEntry,
  QuarantineLimits,
  ReadResult,
} from './quarantine.ts';
import { invalidRunHead, isExecuted, isInvalidRun } from './run.ts';
import type { FlakeRun } from './run.ts';
import { flakeStats, invalidRunsAllowed, percent } from './stats.ts';
import type { FlakeLimits, InvalidRunStats, SuiteStats, TestStats } from './stats.ts';
import { StoreError } from './store.ts';
import type { AppendResult, FlakeStore } from './store.ts';

export type FailureKind =
  | 'over-trigger'
  | 'over-invalid-budget'
  | 'suite-budget'
  | 'quarantine-expired'
  | 'merge-quarantine-expired'
  | 'quarantine-invalid';

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

export interface JudgedInvalidRuns {
  stats: InvalidRunStats;
  /** The entry that quarantines the test today, or null: shown, and never a reason not to fail. */
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
  /** The tests this build scheduled (ran, or ended as invalid runs), with the share of invalid runs of their window. */
  invalidRuns: JudgedInvalidRuns[];
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

function invalidBudgetFailure(
  s: InvalidRunStats,
  quarantine: QuarantineEntry | null,
  limits: FlakeLimits,
): GateFailure {
  const last = s.lastInvalid;
  const where = last
    ? ` Last invalid run: ${invalidRunHead(last.reason)} (run ${last.runId}, ${last.date.slice(0, 10)}, commit ${last.commit.slice(0, 8)}).`
    : '';
  const held = quarantine
    ? ` It is quarantined until ${quarantine.expires} (owner ${quarantine.owner}): a quarantine is about flakiness and does not cover this.`
    : '';
  const clears = limits.windowRuns - invalidRunsAllowed(limits);
  return {
    kind: 'over-invalid-budget',
    subject: `${s.id} on ${s.project}`,
    message: `${s.id} on ${s.project} was an invalid run in ${s.invalid} of ${s.scheduled} of its last scheduled executions (${percent(s.share)}), the budget is ${percent(s.budget)}: the claim is no longer evaluated on this leg.${where}${held}`,
    decision: `Fix the machine (load, decode), or declare the leg a documented gap with evidence (src/lab/gaps.ts), or retire the test on this leg: do not widen the budget to make it green. Who: the owner of the ${areaTitle(s.id)} area. By when: before this merge; the gate stays red while more than ${percent(s.budget)} of the last ${plural(limits.windowRuns, 'scheduled execution')} of the leg are invalid runs. A fixed machine clears it only as newer executions push the old invalid runs out of the window (at most ${plural(clears, 'valid execution')} of this leg); a documented gap or a retirement in the same pull request ends the judgement of the leg at once, because its next run no longer schedules the test. A quarantine does not clear it.`,
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
  const scheduled = new Set<string>();
  const projects = new Set<string>();
  for (const run of input.current) {
    for (const test of run.tests) {
      const key = `${test.project}\u0000${test.id}`;
      // A test is scheduled by this build when it ran or was ended as an invalid run; any other skip (a documented gap) is neither,
      // so declaring a gap takes the test out of the judgement of its invalid runs in the build that declares it.
      if (isExecuted(test.outcome) || isInvalidRun(test)) scheduled.add(key);
      if (!isExecuted(test.outcome)) continue;
      ran.add(key);
      projects.add(test.project);
    }
  }
  const tests: JudgedTest[] = stats.tests
    .filter((t) => ran.has(`${t.project}\u0000${t.id}`))
    .map((t) => ({ stats: t, quarantine: findQuarantine(assessed.effective, t.id, t.project, today) }));
  const invalidRuns: JudgedInvalidRuns[] = stats.invalidRuns
    .filter((s) => scheduled.has(`${s.project}\u0000${s.id}`))
    .map((s) => ({ stats: s, quarantine: findQuarantine(assessed.effective, s.id, s.project, today) }));
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
  // Quarantine is not looked at: it is about flakiness, and an environment that cannot evaluate the claim is not fixed by it.
  for (const { stats: s, quarantine } of invalidRuns) {
    if (s.verdict === 'over-invalid-budget') failures.push(invalidBudgetFailure(s, quarantine, limits));
    else if (s.verdict === 'not-enough-data' && s.invalid > 0) {
      notes.push(
        `${s.id} on ${s.project}: ${s.invalid} of ${plural(s.scheduled, 'scheduled execution')} ended as invalid runs (${percent(s.share)}); no verdict yet, the invalid-run budget (${percent(s.budget)}) is judged from ${limits.minRunsToJudge}.`,
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
    'over-invalid-budget',
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
    invalidRuns,
    suites,
    quarantine: { effective: assessed.effective, expired, problems: assessed.problems },
  };
}

/** The tests worth a row in the gate's output: everything that is not a plain `ok`. */
export function interestingTests(report: GateReport): JudgedTest[] {
  return report.tests.filter((t) => t.stats.verdict !== 'ok' || t.quarantine !== null || t.stats.flaky > 0);
}

/** The tests of this build that have an invalid run in their window: the others have nothing to show. */
export function withInvalidRuns(report: GateReport): JudgedInvalidRuns[] {
  return report.invalidRuns.filter((t) => t.stats.invalid > 0);
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

  const invalidShown = withInvalidRuns(report);
  if (invalidShown.length > 0) {
    out.push(
      '',
      `Invalid runs of the tests of this build (the last ${limits.windowRuns} scheduled executions each, judged from ${limits.minRunsToJudge}, budget ${percent(limits.invalidRunBudgetRate)}; ${report.invalidRuns.length - invalidShown.length} with none are not listed)`,
    );
    out.push(row(['test', 'engine', 'invalid', 'scheduled', 'share', 'budget', 'verdict', 'quarantine']));
    out.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
    for (const { stats: s, quarantine } of invalidShown) {
      out.push(
        row([
          s.id,
          s.project + (s.experimental ? ' (experimental)' : ''),
          s.invalid,
          s.scheduled,
          percent(s.share),
          percent(s.budget),
          s.verdict,
          quarantine ? `until ${quarantine.expires} (${quarantine.owner})` : 'no',
        ]),
      );
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

// ---------------------------------------------------------------------------------------------------------------------
// The command

export const GATE_USAGE = `Usage: tsx flake/gate.ts [--runs <file or directory>]... [--record [--push]] [options]

Judges the runs of this build (default: every run*.json under reports/flake) against the history of their environment and the quarantine
list. Exit 0: nothing to act on. Exit 1: a failure (printed with the decision it drives). Exit 2: it could not judge.

  --runs <path>        a run file, or a directory searched for run*.json at any depth; repeat for several
  --record             after judging, append the runs to the history (also when the verdict is a failure: a build that
                       flaked is data); without it the runs are judged and forgotten, as for a pull request
  --push               git store: publish what --record recorded (a build of main), never a pull request
  --store file|git     where the history lives (default file; PB_FLAKE_STORE)
  --history-dir <dir>  file store: its directory (default flake/history; PB_FLAKE_HISTORY_DIR)
  --git-remote <r>     git store: a remote name or URL (default origin; PB_FLAKE_GIT_REMOTE)
  --git-branch <b>     git store: the branch (default ci-data; PB_FLAKE_GIT_BRANCH)
  --git-repo <dir>     git store: a checkout whose remote and credentials are used (default .)
  --git-identity "N <e>"  git store: who the commits are made as (PB_FLAKE_GIT_IDENTITY)
  --env <id>           the environment (default: the one of the run files)
  --quarantine <file>  the quarantine list (default flake/quarantine.json)
  --strategy <file>    the strategy document whose catalog is the list of tests (default TEST_STRATEGY.md)
  --json <file>        where to write the decision as JSON (default reports/flake/gate.json)
  --today <YYYY-MM-DD> judge as of this day (default: today, UTC)`;

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Where flake/quarantine.json and TEST_STRATEGY.md live. */
  root: string;
  now: () => Date;
  /** For tests: the history to use instead of the one the arguments name. */
  store?: FlakeStore;
}

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export function defaultIo(): Io {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    env: process.env,
    cwd: process.cwd(),
    root: ROOT,
    now: () => new Date(),
  };
}

function decisionJson(report: GateReport, recorded: AppendResult | null): unknown {
  return {
    decision: report.pass ? 'pass' : 'fail',
    envId: report.envId,
    today: report.today,
    runsJudged: report.runsJudged,
    currentRuns: report.currentRuns,
    failures: report.failures,
    notes: report.notes,
    suites: report.suites.map((s) => ({
      project: s.project,
      builds: s.builds,
      executions: s.executions,
      flaky: s.flaky,
      flakeRate: s.flakeRate,
      budget: s.budget,
      verdict: s.verdict,
      quarantinedExecutions: s.quarantinedExecutions,
    })),
    tests: report.tests.map(({ stats: t, quarantine }) => ({
      id: t.id,
      project: t.project,
      executions: t.executions,
      flaky: t.flaky,
      failed: t.failed,
      flakeRate: t.flakeRate,
      verdict: t.verdict,
      quarantined: quarantine ? { owner: quarantine.owner, expires: quarantine.expires } : null,
    })),
    invalidRuns: report.invalidRuns.map(({ stats: s, quarantine }) => ({
      id: s.id,
      project: s.project,
      invalid: s.invalid,
      scheduled: s.scheduled,
      share: s.share,
      budget: s.budget,
      verdict: s.verdict,
      lastInvalid: s.lastInvalid,
      quarantined: quarantine ? { owner: quarantine.owner, expires: quarantine.expires } : null,
    })),
    recorded: recorded
      ? {
          added: recorded.added,
          trimmed: recorded.trimmed,
          pushed: recorded.pushed,
          attempts: recorded.attempts,
        }
      : null,
  };
}

/** The gate as a command. Returns the exit code: 0, 1 (a failure to act on) or 2 (it could not judge). */
export async function gateCommand(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  let report: GateReport | null = null;
  try {
    const args = parseCliArgs(argv, io.env);
    if (args.help) {
      io.log(GATE_USAGE);
      return 0;
    }
    const files = findRunFiles(
      args.runs.length > 0 ? args.runs : ['reports/flake'],
      io.cwd,
      args.runs.length > 0,
    );
    if (files.length === 0) {
      throw new EnvironmentProblem(
        `no run file found (${args.runs.length > 0 ? args.runs.join(', ') : 'reports/flake/run*.json'}): the tests did not run with the flake reporter, or this step did not get their files`,
      );
    }
    const current = readRunFiles(files);
    const envId = environmentOf(current, args.env);
    const today = args.today ?? utcDay(io.now());

    const store = io.store ?? storeFromArgs(args, io.cwd);
    let history: FlakeRun[];
    try {
      history = await store.load(envId);
    } catch (error) {
      if (error instanceof HistoryError || error instanceof StoreError) {
        throw new EnvironmentProblem(`cannot read the history (${store.description}): ${error.message}`);
      }
      throw error;
    }

    let list;
    try {
      list = loadList({
        quarantineFile: resolve(io.cwd, args.quarantine ?? resolve(io.root, 'flake/quarantine.json')),
        strategyFile: resolve(io.cwd, args.strategy ?? resolve(io.root, 'TEST_STRATEGY.md')),
        today,
      });
    } catch (error) {
      throw new EnvironmentProblem(
        `cannot read the catalog of the strategy document: ${(error as Error).message}`,
      );
    }

    report = evaluateGate({ history, current, today, quarantine: list.read, catalog: list.catalog });
    const text = renderGate(report);
    io.log(text);

    // A build that failed is recorded all the same: leaving it out would make the history a record of the good builds only.
    let recorded: AppendResult | null = null;
    let recordProblem: string | null = null;
    if (args.record) {
      try {
        recorded = await store.append(envId, current, { push: args.push });
        io.log(
          `\nrecorded in the history (${store.description}): ${recorded.added} new run${recorded.added === 1 ? '' : 's'}, ${recorded.trimmed} trimmed${args.push ? `, ${recorded.pushed ? `pushed (${recorded.attempts} ${recorded.attempts === 1 ? 'try' : 'tries'})` : 'nothing to push'}` : ''}`,
        );
      } catch (error) {
        recordProblem = `cannot record the runs in the history (${store.description}): ${(error as Error).message}`;
        io.error(`flake gate: ${recordProblem}`);
      }
    }

    const jsonFile = resolve(io.cwd, args.json ?? 'reports/flake/gate.json');
    mkdirSync(dirname(jsonFile), { recursive: true });
    writeFileSync(jsonFile, `${JSON.stringify(decisionJson(report, recorded), null, 2)}\n`);
    appendStepSummary(
      io.env,
      `### Flake gate: ${report.pass ? 'pass' : `FAIL (${plural(report.failures.length, 'failure')})`}\n\n\`\`\`text\n${text}\n\`\`\`\n`,
    );

    if (!report.pass) return exitCode(report);
    return recordProblem ? 2 : 0;
  } catch (error) {
    if (error instanceof EnvironmentProblem || error instanceof HistoryError || error instanceof StoreError) {
      io.error(`flake gate: ${error.message}`);
      return report && !report.pass ? 1 : 2;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  gateCommand(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`flake gate: ${(error as Error).stack ?? String(error)}`);
      process.exit(2);
    },
  );
}
