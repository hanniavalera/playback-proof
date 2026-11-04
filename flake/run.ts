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

/** The tier a set of tags stands for (docs/CONTRACTS.md section 7): `@merge` gates every pull request and wins over `@release`. */
export function tierOfTags(tags: readonly string[]): Tier | null {
  if (tags.includes('@merge')) return 'merge';
  if (tags.includes('@release')) return 'release';
  return null;
}

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

export const RUN_STATUSES = ['passed', 'failed', 'timedout', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

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

// ---------------------------------------------------------------------------------------------------------------------
// Reading a record back: the history and the run files are read by tools that act on them, so everything is checked.

export class RunFormatError extends Error {
  override name = 'RunFormatError';
}

type Json = Record<string, unknown>;

function bad(source: string, path: string, message: string): never {
  throw new RunFormatError(`${source}: ${path}: ${message}`);
}

function asObject(value: unknown, source: string, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(source, path, 'expected an object');
  }
  return value as Json;
}

function asText(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') bad(source, path, 'expected a non-empty string');
  return value;
}

function asCount(value: unknown, source: string, path: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    bad(source, path, `expected an integer >= ${min}`);
  }
  return value;
}

function asMillis(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    bad(source, path, 'expected a number >= 0');
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], source: string, path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    bad(source, path, `expected one of ${allowed.join(', ')}, found ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** `new Date().toISOString()`: UTC, with a `Z`. Anything else would not sort as text, and the history is ordered by it. */
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseAttempt(value: unknown, source: string, path: string): Attempt {
  const attempt = asObject(value, source, path);
  oneOf(attempt.status, ATTEMPT_STATUSES, source, `${path}.status`);
  asMillis(attempt.durationMs, source, `${path}.durationMs`);
  if (attempt.signature !== undefined) asText(attempt.signature, source, `${path}.signature`);
  return attempt as unknown as Attempt;
}

function parseTest(value: unknown, source: string, path: string): TestRecord {
  const test = asObject(value, source, path);
  for (const field of ['id', 'title', 'file', 'project']) asText(test[field], source, `${path}.${field}`);
  if (!Array.isArray(test.tags) || test.tags.some((tag) => typeof tag !== 'string')) {
    bad(source, `${path}.tags`, 'expected a list of strings');
  }
  const tier =
    test.tier === null ? null : oneOf(test.tier, ['merge', 'release'] as const, source, `${path}.tier`);
  const expectedTier = tierOfTags(test.tags as string[]);
  if (tier !== expectedTier) {
    bad(
      source,
      `${path}.tier`,
      `says ${String(tier)} but the tags ${JSON.stringify(test.tags)} are ${String(expectedTier)}`,
    );
  }
  const outcome = oneOf(test.outcome, OUTCOMES, source, `${path}.outcome`);
  if (typeof test.quarantined !== 'boolean') bad(source, `${path}.quarantined`, 'expected a boolean');
  asCount(test.retries, source, `${path}.retries`);
  if (test.skipReason !== undefined) asText(test.skipReason, source, `${path}.skipReason`);
  if (test.experimental !== undefined && test.experimental !== true) {
    bad(source, `${path}.experimental`, 'expected true, or the field absent');
  }
  if (!Array.isArray(test.attempts) || test.attempts.length === 0) {
    bad(source, `${path}.attempts`, 'expected at least one attempt');
  }
  test.attempts.forEach((attempt: unknown, index: number) =>
    parseAttempt(attempt, source, `${path}.attempts[${index}]`),
  );
  if (outcome === 'flaky' && test.attempts.length < 2) {
    bad(
      source,
      `${path}.outcome`,
      'flaky needs at least two attempts: a test that ran once cannot have been retried',
    );
  }
  return test as unknown as TestRecord;
}

/** A run record read from JSON: every field the tools rely on is checked, and fields it does not know are kept, not dropped. */
export function parseRun(value: unknown, source = 'run'): FlakeRun {
  const run = asObject(value, source, '$');
  if (run.schemaVersion !== RUN_SCHEMA_VERSION) {
    bad(
      source,
      '$.schemaVersion',
      `expected ${RUN_SCHEMA_VERSION}, found ${JSON.stringify(run.schemaVersion)}: this tool does not read that version`,
    );
  }
  for (const field of ['runId', 'invocationId', 'commit', 'envId', 'playwrightVersion']) {
    asText(run[field], source, `$.${field}`);
  }
  const date = asText(run.date, source, '$.date');
  if (!ISO_UTC.test(date) || Number.isNaN(Date.parse(date))) {
    bad(
      source,
      '$.date',
      `expected an ISO 8601 UTC time like 2026-11-03T22:19:10.045Z, found ${JSON.stringify(date)}`,
    );
  }
  oneOf(run.status, RUN_STATUSES, source, '$.status');
  asMillis(run.durationMs, source, '$.durationMs');
  if (run.shard !== undefined) {
    const shard = asObject(run.shard, source, '$.shard');
    const current = asCount(shard.current, source, '$.shard.current', 1);
    const total = asCount(shard.total, source, '$.shard.total', 1);
    if (current > total) bad(source, '$.shard', `shard ${current} of ${total}`);
  }
  if (!Array.isArray(run.tests)) bad(source, '$.tests', 'expected a list');
  run.tests.forEach((test: unknown, index: number) => parseTest(test, source, `$.tests[${index}]`));
  return run as unknown as FlakeRun;
}
