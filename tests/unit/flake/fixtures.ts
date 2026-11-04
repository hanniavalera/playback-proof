import type { Attempt, ExecutedOutcome, FlakeRun, Outcome, TestRecord } from '../../../flake/run.ts';
import { RUN_SCHEMA_VERSION } from '../../../flake/run.ts';

// Builders for recorded runs. A test is described by its outcome and the attempts follow from it, so a fixture says what happened
// ("this test flaked in the third run") and not how Playwright reports it.

const BASE_DATE = Date.UTC(2026, 9, 1, 12, 0, 0);
let counter = 0;

/** A fresh, strictly increasing run counter: dates and ids never collide between fixtures. */
export function nextCounter(): number {
  counter += 1;
  return counter;
}

export const SIGNATURE_FLAKE = 'the player page did not boot (<url>): Timeout <n>ms exceeded';
export const SIGNATURE_FAIL = 'media time reached: expected >= <n>';

export function attemptsFor(outcome: Outcome, signature = SIGNATURE_FLAKE): Attempt[] {
  const failed = (status: 'failed' | 'timedOut'): Attempt => ({ status, durationMs: 4000, signature });
  switch (outcome) {
    case 'passed':
      return [{ status: 'passed', durationMs: 1000 }];
    case 'flaky':
      return [failed('failed'), { status: 'passed', durationMs: 1200 }];
    case 'failed':
      return [failed('failed'), failed('failed')];
    case 'timedOut':
      return [failed('timedOut'), failed('timedOut')];
    case 'skipped':
      return [{ status: 'skipped', durationMs: 0 }];
    case 'interrupted':
      return [{ status: 'interrupted', durationMs: 500 }];
  }
}

export interface RecordOptions {
  id?: string;
  project?: string;
  outcome?: Outcome;
  tier?: 'merge' | 'release' | null;
  quarantined?: boolean;
  retries?: number;
  signature?: string;
  experimental?: boolean;
  skipReason?: string;
}

export function record(options: RecordOptions = {}): TestRecord {
  const outcome = options.outcome ?? 'passed';
  const tier = options.tier === undefined ? 'merge' : options.tier;
  const id = options.id ?? 'PB-VOD-001';
  return {
    id,
    title: `${id} a scenario`,
    file: 'tests/e2e/vod-start.spec.ts',
    project: options.project ?? 'chromium',
    tags: tier === null ? [] : [`@${tier}`],
    tier,
    outcome,
    quarantined: options.quarantined ?? false,
    retries: options.retries ?? 1,
    ...(options.skipReason !== undefined ? { skipReason: options.skipReason } : {}),
    ...(options.experimental ? { experimental: true as const } : {}),
    attempts: attemptsFor(outcome, options.signature),
  };
}

export interface RunOptions {
  runId?: string;
  invocationId?: string;
  date?: string;
  commit?: string;
  envId?: string;
}

/** One run holding the given tests. Runs built one after the other are one minute apart, oldest first. */
export function run(tests: TestRecord[], options: RunOptions = {}): FlakeRun {
  const n = nextCounter();
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: options.runId ?? `run-${n}`,
    invocationId: options.invocationId ?? `inv-${n}`,
    date: options.date ?? new Date(BASE_DATE + n * 60_000).toISOString(),
    commit: options.commit ?? n.toString(16).padStart(40, '0'),
    envId: options.envId ?? 'gha-linux-x64',
    playwrightVersion: '1.64.1',
    status: tests.some((t) => t.outcome === 'failed' || t.outcome === 'timedOut') ? 'failed' : 'passed',
    durationMs: 30_000,
    tests,
  };
}

/** One run per outcome, each holding a single test: the history of one test. */
export function historyOf(
  id: string,
  outcomes: readonly ExecutedOutcome[],
  options: Omit<RecordOptions, 'id' | 'outcome'> = {},
): FlakeRun[] {
  return outcomes.map((outcome) => run([record({ ...options, id, outcome })]));
}

/** `n` passes, with the given outcome at each (0-based) position of the list: `sequence(30, { 4: 'flaky' })`. */
export function sequence(n: number, at: Record<number, ExecutedOutcome> = {}): ExecutedOutcome[] {
  return Array.from({ length: n }, (_, i) => at[i] ?? 'passed');
}
