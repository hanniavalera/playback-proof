import { loadavg } from 'node:os';
import { configFor } from '../src/player/configs.ts';
import type { QAInfo, QAMetrics } from '../src/shared/qa.ts';
import type { StreamId } from '../src/shared/streams.ts';
import type { Environment } from '../src/lab/gaps.ts';
import { gapForStream } from '../src/lab/gaps.ts';
import type { Launcher, LaunchedBrowser, RunPage } from '../src/lab/measure/browser.ts';
import { QaPage } from '../src/lab/measure/page.ts';
import type { PlayerDriver } from '../src/lab/measure/page.ts';
import { HarnessError } from '../src/lab/measure/runner.ts';
import type { Driver, SessionApi } from '../src/lab/measure/runner.ts';
import { withTimeout } from '../src/lab/measure/timeouts.ts';
import type { PerfProfile } from '../src/lab/measure/types.ts';
import { canonicalJson } from './prereg.ts';
import type { ConditionPlan, Preregistration } from './prereg.ts';
import type { ConditionResult } from './results.ts';
import type { ArmId, ConfigLetter, FailureKind, SessionRecord } from './types.ts';

// THE RUNNER of an experiment: for each condition of the pre-registration, a block design that interleaves the two arms, one fresh browser
// context and one service session per session, the warm-up recorded and left out, and every session that fails recorded as a failure
// (ADR-144 and ADR-145 in docs/decisions/ab.md). It drives the engine through the measurement library of the performance harness
// (src/lab/measure) and reads the player only through `window.__qa`, as every other harness does.

/** What a session needs from the page: the driver of the performance harness, plus `qa.info()` for the proof of what was configured. */
export interface SessionDriver extends Driver {
  info(): Promise<QAInfo>;
}

export interface ScheduledSession {
  /** 0-based position in the condition, warm-up included. */
  index: number;
  /** 0-based pair of sessions. */
  block: number;
  arm: ArmId;
  config: ConfigLetter;
  warmup: boolean;
}

/**
 * The order of the sessions: blocks of two, one session of each arm, and the arm that goes first ALTERNATES from block to block (A B, B A,
 * A B, B A, ...). A drift of the machine over the run (a thermal throttle, a background job starting, a cache warming) then falls on both
 * arms alike: with an even number of measured blocks the two arms have exactly the same average position in time, so a linear drift
 * cancels in the comparison. The first `warmupPerArm` blocks are the warm-up: executed like the rest, recorded, and left out.
 */
export function blockSchedule(
  sessionsPerArm: number,
  warmupPerArm: number,
  arms: { A: ConfigLetter; B: ConfigLetter },
): ScheduledSession[] {
  if (!Number.isInteger(sessionsPerArm) || sessionsPerArm < 1)
    throw new RangeError(`sessionsPerArm must be a positive integer, got ${String(sessionsPerArm)}`);
  if (!Number.isInteger(warmupPerArm) || warmupPerArm < 0)
    throw new RangeError(`warmupPerArm must be a non-negative integer, got ${String(warmupPerArm)}`);
  const schedule: ScheduledSession[] = [];
  for (let block = 0; block < warmupPerArm + sessionsPerArm; block++) {
    const order: ArmId[] = block % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    for (const arm of order) {
      schedule.push({ index: schedule.length, block, arm, config: arms[arm], warmup: block < warmupPerArm });
    }
  }
  return schedule;
}

export type ExperimentProgress =
  | { kind: 'condition'; condition: string; sessions: number; warmup: number }
  | { kind: 'session'; condition: string; record: SessionRecord; total: number };

export interface ExperimentDeps {
  service: { origin: string; client: SessionApi };
  launch: Launcher;
  environment: Environment;
  /** The page driver of a session. Default: `QaPage` over the session's Playwright page. */
  driverFor?: (run: RunPage, origin: string) => SessionDriver;
  now?: () => Date;
  loadAverage?: () => number;
  onProgress?: (event: ExperimentProgress) => void;
}

export interface ConditionRun {
  result: ConditionResult;
  browser: { name: string; version: string; userAgent: string | null };
}

const SESSION_TTL_SEC = 600;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const describeError = (error: QAMetrics['errors'][number]): string =>
  `${error.codeName ?? error.code}/${error.severity}`;

/**
 * Plays until the media clock reaches `mediaTime`, or fails the moment the player reports a critical error: a player that has given up
 * never gets there, and a session must not wait out its whole timeout to say so (the same helper as the performance scenarios, which
 * does not export it).
 */
async function playUntil(qa: PlayerDriver, mediaTime: number, timeoutMs: number): Promise<number> {
  const critical = new Promise<never>((_, reject) => {
    qa.waitFor('error', { detail: { severity: 2 }, timeoutMs }).then(
      (event) =>
        reject(
          new Error(
            `the player reported a critical error before media time ${mediaTime.toFixed(1)} s: ${JSON.stringify(event.detail)}`,
          ),
        ),
      () => {},
    );
  });
  return Promise.race([qa.waitForMediaTime(mediaTime, timeoutMs), critical]);
}

/** The classes of a session that did not produce a measurement: what the player did, not what the harness did. */
function classify(error: unknown): { kind: FailureKind; message: string } {
  const message = messageOf(error);
  if (/critical error/.test(message)) return { kind: 'critical-error', message };
  if (/did not finish within|timed out/.test(message)) return { kind: 'timeout', message };
  return { kind: 'page', message };
}

/** The configuration the page reports must be the one the arm is meant to run: a mismatch is the harness's defect and ends the run. */
export function assertConfiguration(info: QAInfo, letter: ConfigLetter, where: string): void {
  if (info.config !== letter)
    throw new HarnessError(
      'run',
      `${where}: the page runs configuration ${info.config}, the arm needs ${letter}`,
    );
  const expected = canonicalJson(configFor(letter));
  if (canonicalJson(info.configOverrides) !== expected)
    throw new HarnessError(
      'run',
      `${where}: the overrides the page applied (${JSON.stringify(info.configOverrides)}) are not those of configuration ${letter} (${expected})`,
    );
  if (!info.params.abr)
    throw new HarnessError(
      'run',
      `${where}: ABR was off in the page, but an experiment compares the player's own adaptation`,
    );
}

interface SessionContext {
  prereg: Preregistration;
  condition: ConditionPlan;
  stream: StreamId;
  deps: ExperimentDeps;
  browser: LaunchedBrowser;
}

async function runSession(context: SessionContext, spec: ScheduledSession): Promise<SessionRecord> {
  const { prereg, condition, stream, deps, browser } = context;
  const now = deps.now ?? ((): Date => new Date());
  const driverFor = deps.driverFor ?? ((run, origin): SessionDriver => new QaPage(run.page, origin));
  const label = `${prereg.id} ${condition.id} ${spec.warmup ? 'warm-up ' : ''}${spec.arm} #${spec.index + 1}`;
  const startedAt = now().toISOString();
  const started = performance.now();
  const record: SessionRecord = {
    index: spec.index,
    block: spec.block,
    arm: spec.arm,
    config: spec.config,
    condition: condition.id,
    warmup: spec.warmup,
    status: 'ok',
    values: {},
    startRungHeight: null,
    rungs: [],
    errors: [],
    info: null,
    sessionId: null,
    startedAt,
    durationMs: 0,
  };

  let sessionId: string | undefined;
  let page: RunPage | undefined;
  try {
    // The service and the browser are the harness's: if they fail, no number says anything about the player, and the run stops.
    let manifestUrl: string;
    try {
      const session = await deps.service.client.createSession({
        stream,
        protocol: prereg.protocol,
        label: `ab ${label}`,
        ttlSec: SESSION_TTL_SEC,
        faults: structuredClone(condition.rules),
      });
      sessionId = session.id;
      manifestUrl = session.manifestUrl;
      record.sessionId = session.id;
      page = await browser.newRun();
    } catch (error) {
      throw new HarnessError('run', `${label}: could not set the session up: ${messageOf(error)}`, {
        cause: error,
      });
    }
    const driver = driverFor(page, deps.service.origin);
    try {
      const observed = await withTimeout(
        observe(driver, prereg, manifestUrl, spec, label),
        prereg.observation.sessionTimeoutMs,
        label,
      );
      record.values = observed.values;
      record.startRungHeight = observed.startRungHeight;
      record.rungs = observed.rungs;
      record.errors = observed.errors;
      record.info = observed.info;
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const failure = classify(error);
      const diagnostics = await driver.diagnostics().catch(() => '');
      record.status = 'failed';
      record.failure = {
        kind: failure.kind,
        message: `${failure.message}${diagnostics ? `\n${diagnostics}` : ''}`.slice(0, 2000),
      };
      record.values = {};
    }
  } finally {
    await page?.close().catch(() => {});
    if (sessionId !== undefined) await deps.service.client.deleteSession(sessionId).catch(() => {});
    record.durationMs = Math.round(performance.now() - started);
  }
  return record;
}

interface Observed {
  values: Record<string, number | null>;
  startRungHeight: number | null;
  rungs: SessionRecord['rungs'];
  errors: string[];
  info: SessionRecord['info'];
}

/** One session of the player: open the page with the arm's configuration, wait for the first frame, play for the observed media seconds, read the numbers. */
async function observe(
  qa: SessionDriver,
  prereg: Preregistration,
  manifestUrl: string,
  spec: ScheduledSession,
  label: string,
): Promise<Observed> {
  const info = await qa.open(manifestUrl, { config: spec.config });
  assertConfiguration(info, spec.config, label);
  const { sessionTimeoutMs, mediaSecondsAfterFirstFrame } = prereg.observation;
  const first = await qa.waitFor('firstframe', { timeoutMs: sessionTimeoutMs });
  if (mediaSecondsAfterFirstFrame > 0)
    await playUntil(qa, first.mediaTime + mediaSecondsAfterFirstFrame, sessionTimeoutMs);
  const metrics = await qa.metrics();
  const critical = metrics.errors.filter((error) => error.severity === 2);
  if (critical.length > 0)
    throw new Error(`the player reported a critical error: ${critical.map(describeError).join(', ')}`);
  const finalInfo = await qa.info();
  if (finalInfo.loadMode !== 'media-source')
    throw new Error(
      `the player did not play through Media Source Extensions (load mode ${String(finalInfo.loadMode)}): it is not the player the lab measures`,
    );

  const played = mediaSecondsAfterFirstFrame >= 1;
  const playback = <T>(value: T): T | null => (played ? value : null);
  const history = metrics.bitrate.history;
  return {
    values: {
      startupMs: metrics.startupMs,
      manifestMs: metrics.startup.manifestMs,
      rebufferCount: playback(metrics.rebuffer.count),
      rebufferMs: playback(metrics.rebuffer.totalMs),
      rebufferRatio: playback(metrics.rebuffer.ratio),
      switches: playback(metrics.bitrate.switches),
      droppedRatio: playback(metrics.frames.decoded > 0 ? metrics.frames.droppedRatio : null),
    },
    startRungHeight: history.find((change) => change.reason === 'start')?.height ?? null,
    rungs: history.map((change) => ({ ...change })),
    errors: metrics.errors.map(describeError),
    info: {
      config: finalInfo.config,
      configOverrides: finalInfo.configOverrides,
      configDefaults: finalInfo.configDefaults,
      loadMode: finalInfo.loadMode,
      userAgent: finalInfo.userAgent,
    },
  };
}

/**
 * Runs ONE condition: one browser process for the condition (as in a performance batch, ADR-120), a fresh context and a service session
 * for every session, the sessions in the order of `blockSchedule`. A session that fails is recorded and the run goes on; the condition
 * stops, with what it has, after `abortAfterConsecutiveFailures` failures in a row (the harness is broken, not the player). A defect of
 * the harness itself (the service, the browser, a configuration that is not the arm's) throws a `HarnessError` and ends everything.
 */
export async function runCondition(
  prereg: Preregistration,
  condition: ConditionPlan,
  deps: ExperimentDeps,
): Promise<ConditionRun> {
  const now = deps.now ?? ((): Date => new Date());
  const load = deps.loadAverage ?? ((): number => loadavg()[0] ?? 0);
  const gap = gapForStream(deps.environment, prereg.stream);
  if (gap !== null)
    throw new HarnessError('gap', `${prereg.id} cannot run in ${deps.environment.envId}: ${gap}`);

  const schedule = blockSchedule(prereg.sessionsPerArm, prereg.warmupSessionsPerArm, prereg.arms);
  const profile: PerfProfile = prereg.engine;
  const startedAt = now().toISOString();
  const loadBefore = load();
  let browser: LaunchedBrowser;
  try {
    browser = await deps.launch(profile);
  } catch (error) {
    throw new HarnessError('launch', `the browser of ${profile} did not start: ${messageOf(error)}`, {
      cause: error,
    });
  }
  deps.onProgress?.({
    kind: 'condition',
    condition: condition.id,
    sessions: schedule.length,
    warmup: 2 * prereg.warmupSessionsPerArm,
  });
  const userAgent = await browser.userAgent().catch(() => null);

  const sessions: SessionRecord[] = [];
  let aborted: string | null = null;
  let consecutive = 0;
  try {
    for (const spec of schedule) {
      const record = await runSession({ prereg, condition, stream: prereg.stream, deps, browser }, spec);
      sessions.push(record);
      deps.onProgress?.({ kind: 'session', condition: condition.id, record, total: schedule.length });
      consecutive = record.status === 'failed' ? consecutive + 1 : 0;
      if (consecutive >= prereg.exclusionRule.abortAfterConsecutiveFailures) {
        aborted = `${consecutive} sessions failed in a row (the last: ${record.failure?.kind ?? 'unknown'}: ${record.failure?.message.split('\n')[0] ?? ''}): the harness or the environment is broken, not one session`;
        break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    result: {
      id: condition.id,
      rules: structuredClone(condition.rules),
      stream: prereg.stream,
      startedAt,
      finishedAt: now().toISOString(),
      loadAverage: { before: loadBefore, after: load() },
      sessions,
      aborted,
    },
    browser: { name: browser.engine, version: browser.version, userAgent },
  };
}
