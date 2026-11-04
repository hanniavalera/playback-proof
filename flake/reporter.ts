// The flake reporter: a Playwright reporter that records every attempt of every test in one file, `reports/flake/run.json`
// (a `FlakeRun`, flake/run.ts). It is the source of the flake history: nothing else knows which test failed and then passed on a retry.
//
// It is configured in playwright.config.ts next to the other reporters. Where things come from:
//   PB_FLAKE_RUN_FILE     where to write the file (relative to the current directory); default reports/flake/run.json under the config
//   PB_RUN_ID             the id of the build this run belongs to (a wrapper that makes several invocations sets one for all of them)
//   GITHUB_RUN_ID, BUILD_TAG   the CI run id; without any of these a local id is generated
//   GITHUB_SHA, GIT_COMMIT     the commit that was tested; without them `git rev-parse HEAD`
//   PB_FLAKE_QUARANTINE   the quarantine list (default flake/quarantine.json under the config)
// A reporter that cannot write says so on stderr and lets the run end as it would have: bookkeeping must not turn a green run red, and
// the gate that reads the file says "no run file" (exit 2) when it is missing.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { detectEnvId } from '../src/shared/env.ts';
import { signatureOfError } from '../src/lab/signature.ts';
import type { ErrorLike } from '../src/lab/signature.ts';
import { findQuarantine, loadQuarantine, utcDay } from './quarantine.ts';
import type { QuarantineEntry } from './quarantine.ts';
import { RUN_SCHEMA_VERSION, tierOfTags } from './run.ts';
import type { Attempt, AttemptStatus, FlakeRun, Outcome, RunStatus, TestRecord } from './run.ts';

export const DEFAULT_RUN_FILE = 'reports/flake/run.json';
export const EXPERIMENTAL_ANNOTATION = 'experimental-engine';

/** What the reporter needs to know of one attempt, free of Playwright's classes so that a test can describe it. */
export interface AttemptObservation {
  status: AttemptStatus;
  durationMs: number;
  errors: ErrorLike[];
}

export interface TestObservation {
  title: string;
  /** The titles of the `describe` blocks around the test, outermost first; not the project and not the file. */
  describes: string[];
  /** Relative to the config directory, with `/`. */
  file: string;
  project: string;
  tags: string[];
  annotations: Array<{ type: string; description?: string | undefined }>;
  /** What the test is supposed to end as: `passed`, or `failed` for `test.fail()`, or `skipped` for `test.skip()`. */
  expectedStatus: AttemptStatus;
  retries: number;
  /** In the order they ran. Empty when the test never started. */
  attempts: AttemptObservation[];
}

/**
 * What a test came to over its attempts. It is Playwright's own `test.outcome()` (a skipped test, an expected one, an unexpected one,
 * a flaky one: mixed results) with two additions: a test that ran into its timeout is told apart from one that failed, and a test
 * the run was stopped on, with no attempt that passed, is `interrupted`, since nothing says whether the retry would have passed.
 */
export function outcomeOf(statuses: readonly AttemptStatus[], expected: AttemptStatus): Outcome {
  const ran = statuses.filter((status) => status !== 'interrupted');
  if (ran.length === 0) return 'interrupted';
  if (ran.every((status) => status === 'skipped')) return 'skipped';
  const unexpected = ran.filter((status) => status !== expected);
  if (unexpected.length === 0) return 'passed';
  if (unexpected.length < ran.length) return 'flaky';
  if (ran.length < statuses.length) return 'interrupted';
  return ran[ran.length - 1] === 'timedOut' ? 'timedOut' : 'failed';
}

const ID_AT_START = /^(PB-[A-Z]+-\d{3})(?![\dA-Za-z-])/;

/** The catalog id the title starts with, or the full title (the describe blocks and the title) when it has none. */
export function idOf(title: string, describes: readonly string[]): string {
  return ID_AT_START.exec(title)?.[1] ?? [...describes, title].join(' › ');
}

function skipReasonOf(annotations: TestObservation['annotations']): string | undefined {
  const skip = annotations.find(
    (a) => (a.type === 'skip' || a.type === 'fixme') && (a.description ?? '').trim() !== '',
  );
  return skip?.description?.trim();
}

/** One test as the history keeps it, or null when it never started (nothing to record). */
export function recordOf(
  observation: TestObservation,
  isQuarantined: (id: string, project: string) => boolean,
): TestRecord | null {
  if (observation.attempts.length === 0) return null;
  const statuses = observation.attempts.map((a) => a.status);
  const outcome = outcomeOf(statuses, observation.expectedStatus);
  const id = idOf(observation.title, observation.describes);
  const tags = [...new Set(observation.tags)].sort();
  const attempts: Attempt[] = observation.attempts.map((attempt) => {
    const failed = attempt.status !== observation.expectedStatus && attempt.status !== 'skipped';
    return {
      status: attempt.status,
      durationMs: Math.round(attempt.durationMs),
      ...(failed && attempt.errors.length > 0 ? { signature: signatureOfError(attempt.errors[0]) } : {}),
    };
  });
  const skipReason = outcome === 'skipped' ? skipReasonOf(observation.annotations) : undefined;
  const experimental = observation.annotations.some((a) => a.type === EXPERIMENTAL_ANNOTATION);
  return {
    id,
    title: [...observation.describes, observation.title].join(' › '),
    file: observation.file,
    project: observation.project,
    tags,
    tier: tierOfTags(tags),
    outcome,
    quarantined: isQuarantined(id, observation.project),
    retries: observation.retries,
    ...(skipReason !== undefined ? { skipReason } : {}),
    ...(experimental ? { experimental: true as const } : {}),
    attempts,
  };
}

/** Two tests of one engine that would share an id (the same title in two files) are told apart by their file: the rates must not mix them. */
export function separateSharedIds(records: TestRecord[]): TestRecord[] {
  const count = new Map<string, number>();
  for (const r of records)
    count.set(`${r.project}\u0000${r.id}`, (count.get(`${r.project}\u0000${r.id}`) ?? 0) + 1);
  return records.map((r) =>
    (count.get(`${r.project}\u0000${r.id}`) ?? 1) > 1 ? { ...r, id: `${r.id} [${r.file}]` } : r,
  );
}

export interface RunContext {
  runId: string;
  invocationId: string;
  date: string;
  commit: string;
  envId: string;
  playwrightVersion: string;
  shard?: { current: number; total: number } | null;
}

export function buildRun(
  context: RunContext,
  observations: readonly TestObservation[],
  result: { status: RunStatus; durationMs: number },
  isQuarantined: (id: string, project: string) => boolean,
): FlakeRun {
  const records = observations
    .map((observation) => recordOf(observation, isQuarantined))
    .filter((record): record is TestRecord => record !== null);
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: context.runId,
    invocationId: context.invocationId,
    date: context.date,
    commit: context.commit,
    envId: context.envId,
    playwrightVersion: context.playwrightVersion,
    status: result.status,
    durationMs: Math.round(result.durationMs),
    ...(context.shard ? { shard: { current: context.shard.current, total: context.shard.total } } : {}),
    tests: separateSharedIds(records),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where a run comes from

/** The CI run: the same for every job of one GitHub workflow run (an attempt of a re-run is its own run), null outside CI. */
export function ciRunId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PB_RUN_ID) return env.PB_RUN_ID;
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_RUN_ID) {
    return `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  }
  if (env.BUILD_TAG) return env.BUILD_TAG;
  if (env.JENKINS_URL && env.JOB_NAME && env.BUILD_NUMBER) {
    return `jenkins-${env.JOB_NAME.replace(/[^\w.-]+/g, '-')}-${env.BUILD_NUMBER}`;
  }
  return null;
}

/** `local-20261103T221910Z-a1b2c3`: when it started and a few random digits, for a run that has no CI run to belong to. */
export function generatedRunId(
  now: Date = new Date(),
  random: string = randomBytes(3).toString('hex'),
): string {
  return `local-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${random}`;
}

export function gitCommit(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GITHUB_SHA ?? env.GIT_COMMIT;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv.trim())) return fromEnv.trim().toLowerCase();
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (/^[0-9a-f]{40}$/.test(out)) return out;
  } catch {
    // Not a git checkout, or no git: the run is recorded all the same, with no commit to name.
  }
  return 'unknown';
}

export function newInvocationId(): string {
  return randomBytes(6).toString('hex');
}

export function runFilePath(
  configDir: string,
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (env.PB_FLAKE_RUN_FILE) return resolve(cwd, env.PB_FLAKE_RUN_FILE);
  return resolve(configDir, option ?? DEFAULT_RUN_FILE);
}

/** The text of a run file: indented, since a person opens it; the history keeps the compact form. */
export function renderRunFile(run: FlakeRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

/** Written to a neighbour and renamed, so that a reader never sees half a file. */
export function writeRunFile(path: string, run: FlakeRun): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, renderRunFile(run));
  renameSync(partial, path);
}

// ---------------------------------------------------------------------------------------------------------------------
// The adapter

function toStatus(status: TestResult['status'] | TestCase['expectedStatus']): AttemptStatus {
  return status;
}

function describesOf(test: TestCase): string[] {
  const titles: string[] = [];
  for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
    if (suite.type === 'describe') titles.unshift(suite.title);
  }
  return titles;
}

function projectNameOf(test: TestCase): string {
  for (let suite: Suite | undefined = test.parent; suite; suite = suite.parent) {
    const project = suite.project();
    if (project) return project.name;
  }
  return '';
}

/** A Playwright test as an observation. */
export function observe(test: TestCase, configDir: string): TestObservation {
  return {
    title: test.title,
    describes: describesOf(test),
    file: relative(configDir, test.location.file).split(sep).join('/'),
    project: projectNameOf(test),
    tags: [...test.tags],
    annotations: test.annotations.map((a) => ({ type: a.type, description: a.description })),
    expectedStatus: toStatus(test.expectedStatus),
    retries: test.retries,
    attempts: test.results.map((result) => ({
      status: toStatus(result.status),
      durationMs: result.duration,
      errors: result.errors.map((e) => ({ message: e.message, stack: e.stack, value: e.value })),
    })),
  };
}

export interface FlakeReporterOptions {
  /** Where to write, relative to the config directory. Default `reports/flake/run.json`. */
  outputFile?: string;
  /** The quarantine list, relative to the config directory. Default `flake/quarantine.json`. */
  quarantineFile?: string;
  configDir?: string;
  _mode?: string;
}

function runStatus(status: FullResult['status']): RunStatus {
  return status;
}

export default class FlakeReporter implements Reporter {
  private config: FullConfig | undefined;
  private suite: Suite | undefined;
  private startedAt = new Date();
  private readonly configDir: string;
  private readonly enabled: boolean;

  constructor(private readonly options: FlakeReporterOptions = {}) {
    this.configDir = options.configDir ?? process.cwd();
    // `--list` and `merge-reports` build reporters too: nothing ran, so there is nothing to record.
    this.enabled = options._mode === undefined || options._mode === 'test';
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.startedAt = new Date();
  }

  onEnd(result: FullResult): void {
    if (!this.enabled || !this.config || !this.suite) return;
    const file = runFilePath(this.configDir, this.options.outputFile);
    try {
      const quarantine = loadQuarantine(
        resolve(
          this.configDir,
          process.env.PB_FLAKE_QUARANTINE ?? this.options.quarantineFile ?? 'flake/quarantine.json',
        ),
      );
      const today = utcDay(this.startedAt);
      const entries: readonly QuarantineEntry[] = quarantine.entries;
      const run = buildRun(
        {
          runId: ciRunId() ?? generatedRunId(this.startedAt),
          invocationId: newInvocationId(),
          date: this.startedAt.toISOString(),
          commit: gitCommit(this.configDir),
          envId: detectEnvId(),
          playwrightVersion: this.config.version,
          shard: this.config.shard,
        },
        this.suite.allTests().map((test) => observe(test, this.configDir)),
        { status: runStatus(result.status), durationMs: result.duration },
        (id, project) => findQuarantine(entries, id, project, today) !== null,
      );
      writeRunFile(file, run);
    } catch (error) {
      process.stderr.write(`flake reporter: could not write ${file}: ${(error as Error).message}\n`);
    }
  }
}
