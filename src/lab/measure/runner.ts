import { loadavg } from 'node:os';
import type { SessionInfo, SessionRequest } from '../../shared/api.ts';
import type { StreamId } from '../../shared/streams.ts';
import { profile as faultsOf } from '../../shared/profiles.ts';
import { chooseStream } from '../gaps.ts';
import type { Environment } from '../gaps.ts';
import type { LaunchedBrowser, Launcher, RunPage } from './browser.ts';
import { QaPage } from './page.ts';
import type { PlayerDriver } from './page.ts';
import type { Scenario } from './scenarios.ts';
import { withTimeout } from './timeouts.ts';
import type { BatchMeasurement, PerfProfile, RunRecord } from './types.ts';

// One BATCH: a scenario measured N times, in one browser process, after a warm-up run. The batch is the unit the statistics, the baseline
// and the re-measure are made of (ADR-120).

/**
 * Something is wrong with the harness or the environment, not with the player: the engine cannot play the stream here, the browser did not
 * start, a run could not produce a valid measurement. The gate turns it into exit code 2, never into a verdict about the code.
 */
export class HarnessError extends Error {
  override name = 'HarnessError';
  readonly kind: 'gap' | 'launch' | 'run';
  constructor(kind: HarnessError['kind'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

/** The part of the service client a batch uses. */
export interface SessionApi {
  createSession(request: SessionRequest): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
}

export type Driver = PlayerDriver & { diagnostics(): Promise<string> };

export type BatchProgress =
  | {
      kind: 'batch';
      scenario: string;
      profile: PerfProfile;
      stream: StreamId;
      runs: number;
      warmupRuns: number;
    }
  | { kind: 'run'; scenario: string; index: number; total: number; warmup: boolean; record: RunRecord };

export interface BatchRequest {
  scenario: Scenario;
  profile: PerfProfile;
  /** Measured runs, the warm-up not counted. */
  runs: number;
  /** 0 or 1: the first run of the batch executed like the others and left out of every statistic. */
  warmupRuns: number;
  environment: Environment;
  service: { origin: string; client: SessionApi };
  launch: Launcher;
  /** A run that has not finished by then fails the batch. Default 120 s. */
  runTimeoutMs?: number;
  onProgress?: (event: BatchProgress) => void;
  /** The page driver of a run. Default: `QaPage` over the run's Playwright page. */
  driverFor?: (run: RunPage, origin: string) => Driver;
  /** Injectable for the unit tests. */
  now?: () => Date;
  load?: () => number;
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const SESSION_TTL_SEC = 300;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Measures `scenario` on `profile` `warmupRuns + runs` times. The browser is launched once and closed at the end (also when a run fails);
 * every run gets a fresh context and a session of its own (created before, deleted after, also when the run fails). A run that fails, or
 * that the scenario refuses as invalid, ends the batch with a HarnessError: dropping it and carrying on would bias the statistics towards
 * the runs that went well.
 */
export async function runBatch(request: BatchRequest): Promise<BatchMeasurement> {
  const { scenario, profile, environment, service } = request;
  if (!Number.isInteger(request.runs) || request.runs < 1)
    throw new RangeError(`runs must be an integer >= 1, got ${String(request.runs)}`);
  if (request.warmupRuns !== 0 && request.warmupRuns !== 1)
    throw new RangeError(`warmupRuns must be 0 or 1, got ${String(request.warmupRuns)}`);
  const now = request.now ?? ((): Date => new Date());
  const load = request.load ?? ((): number => loadavg()[0] ?? 0);
  const driverFor = request.driverFor ?? ((run, origin): Driver => new QaPage(run.page, origin));
  const timeoutMs = request.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  // The stream is chosen from the committed probe of THIS environment, as the specs choose it: a documented gap is a reason, not a number.
  const choice = chooseStream(environment, 'vod', scenario.protocol);
  if ('gap' in choice) {
    throw new HarnessError(
      'gap',
      `${scenario.id} cannot run on ${profile} in ${environment.envId}: ${choice.gap}`,
    );
  }
  const stream = choice.stream;

  const startedAt = now().toISOString();
  const loadBefore = load();
  let browser: LaunchedBrowser;
  try {
    browser = await request.launch(profile);
  } catch (error) {
    throw new HarnessError('launch', `the browser of ${profile} did not start: ${messageOf(error)}`, {
      cause: error,
    });
  }
  request.onProgress?.({
    kind: 'batch',
    scenario: scenario.id,
    profile,
    stream,
    runs: request.runs,
    warmupRuns: request.warmupRuns,
  });

  const total = request.warmupRuns + request.runs;
  const records: RunRecord[] = [];
  try {
    for (let index = 0; index < total; index++) {
      const warmup = index < request.warmupRuns;
      const label = warmup ? 'the warm-up run' : `run ${index - request.warmupRuns + 1} of ${request.runs}`;
      const started = performance.now();
      let session: SessionInfo | undefined;
      let page: RunPage | undefined;
      try {
        session = await service.client.createSession({
          stream,
          protocol: scenario.protocol,
          label: `perf ${scenario.id} ${profile} ${warmup ? 'warm-up' : `#${index - request.warmupRuns + 1}`}`,
          ttlSec: SESSION_TTL_SEC,
          faults: faultsOf(scenario.faultProfile),
        });
        page = await browser.newRun();
        const driver = driverFor(page, service.origin);
        try {
          const measured = await withTimeout(
            scenario.run({ qa: driver, session, stream, profile }),
            timeoutMs,
            `${scenario.id} ${label}`,
          );
          const record: RunRecord = { ...measured, durationMs: Math.round(performance.now() - started) };
          records.push(record);
          request.onProgress?.({ kind: 'run', scenario: scenario.id, index, total, warmup, record });
        } catch (error) {
          const diagnostics = await driver.diagnostics().catch(() => '');
          throw new HarnessError(
            'run',
            `${scenario.id} on ${profile}, ${label}: ${messageOf(error)}${diagnostics ? `\n${diagnostics}` : ''}`,
            { cause: error },
          );
        }
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError('run', `${scenario.id} on ${profile}, ${label}: ${messageOf(error)}`, {
          cause: error,
        });
      } finally {
        await page?.close().catch(() => {});
        if (session) await service.client.deleteSession(session.id).catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    scenarioId: scenario.id,
    profile,
    stream,
    protocol: scenario.protocol,
    faultProfile: scenario.faultProfile,
    pinnedHeight: scenario.pinnedHeight,
    warmup: request.warmupRuns === 1 ? (records[0] ?? null) : null,
    runs: records.slice(request.warmupRuns),
    loadAverage: { before: loadBefore, after: load() },
    startedAt,
    finishedAt: now().toISOString(),
  };
}
