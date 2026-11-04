// The record of one Playwright invocation: the unit of the flake history. The reporter writes it (`reports/flake/run.json`), the
// history keeps a line per record, and the statistics, the gate and the report read it. The shapes are a contract: change one and
// the version below, together with `parseRun` (history.ts), which refuses what it does not understand.

export const RUN_SCHEMA_VERSION = 1;

/** The status of one attempt, as Playwright reports it. */
export const ATTEMPT_STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/**
 * What a test came to, over all its attempts:
 *   passed       the first attempt passed
 *   flaky        failed, then passed on a retry (a retried pass is not a pass: METRICS.md)
 *   failed       never passed; the last attempt failed
 *   timedOut     never passed; the last attempt ran into its timeout
 *   skipped      every attempt was skipped (a documented gap, `test.skip`)
 *   interrupted  the run was stopped (`--max-failures`, the global timeout, Ctrl-C) before the test finished: nothing was learnt
 */
export const OUTCOMES = ['passed', 'flaky', 'failed', 'timedOut', 'skipped', 'interrupted'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The outcomes of a test that really executed: the denominator of every rate. A skipped or an interrupted test is not an execution. */
export const EXECUTED_OUTCOMES = ['passed', 'flaky', 'failed', 'timedOut'] as const;
export type ExecutedOutcome = (typeof EXECUTED_OUTCOMES)[number];

export function isExecuted(outcome: Outcome): outcome is ExecutedOutcome {
  return (EXECUTED_OUTCOMES as readonly string[]).includes(outcome);
}

export type Tier = 'merge' | 'release';

export interface Attempt {
  status: AttemptStatus;
  durationMs: number;
  /** Of the first error of a failed attempt (`src/lab/signature.ts`): the same cause reads the same whatever its ids and numbers. */
  signature?: string;
}

export interface TestRecord {
  /** `PB-VOD-001`, or the full title of a test that has no catalog id. */
  id: string;
  /** The title with its describe blocks, without the project and the file. */
  title: string;
  /** Relative to the repository root, with `/`. */
  file: string;
  project: string;
  /** Sorted, with the `@`. */
  tags: string[];
  /** From the tags: `@merge` is `merge`, `@release` is `release`. */
  tier: Tier | null;
  outcome: Outcome;
  /** The quarantine list said so when the test ran: the execution is reported but does not count in the gate's suite rate. */
  quarantined: boolean;
  /** The retries the configuration gave the test. With 0 a flake cannot be seen (it shows as a failure), so it is not a flake observation. */
  retries: number;
  /** Why a skipped test was skipped (the `skip` annotation: a documented gap carries its evidence). Only on skipped tests. */
  skipReason?: string;
  /** The test ran in an experimental engine (the `experimental-engine` annotation of the shared fixture). Only when true. */
  experimental?: true;
  attempts: Attempt[];
}

export type RunStatus = 'passed' | 'failed' | 'timedout' | 'interrupted';

export interface FlakeRun {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** The CI run (shared by the jobs of a workflow run), or one generated for a local run. */
  runId: string;
  /** Unique to this Playwright invocation: recording the same run file twice does not count it twice. */
  invocationId: string;
  /** ISO 8601, UTC: when the run started. */
  date: string;
  /** The commit that was tested. */
  commit: string;
  /** `detectEnvId()`. Histories are per environment and never compared across them. */
  envId: string;
  playwrightVersion: string;
  /** Playwright's verdict on the whole run. */
  status: RunStatus;
  durationMs: number;
  /** Present when the run was a shard (`--shard=1/3`). */
  shard?: { current: number; total: number };
  tests: TestRecord[];
}

/** An execution of one test in one run: what the rates count. */
export interface Execution {
  runId: string;
  invocationId: string;
  date: string;
  commit: string;
  id: string;
  project: string;
  tier: Tier | null;
  outcome: ExecutedOutcome;
  quarantined: boolean;
  retries: number;
  /** The signature of the error that explains a flaky or failed outcome: the first failed attempt's. */
  signature: string | null;
  experimental: boolean;
}

/** Every execution of the runs, in the order given (oldest first). Skipped and interrupted tests are not executions. */
export function executionsOf(runs: readonly FlakeRun[]): Execution[] {
  const out: Execution[] = [];
  for (const run of runs) {
    for (const test of run.tests) {
      if (!isExecuted(test.outcome)) continue;
      out.push({
        runId: run.runId,
        invocationId: run.invocationId,
        date: run.date,
        commit: run.commit,
        id: test.id,
        project: test.project,
        tier: test.tier,
        outcome: test.outcome,
        quarantined: test.quarantined,
        retries: test.retries,
        signature: test.attempts.find((attempt) => attempt.signature !== undefined)?.signature ?? null,
        experimental: test.experimental === true,
      });
    }
  }
  return out;
}
