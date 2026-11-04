import type { ShakaConfigPatch } from '../../player/configs.ts';
import type { RequestLogEntry } from '../../shared/api.ts';
import { LIVE_FACTS, LIVE_LIMITS } from '../../shared/criteria.ts';
import { originStall } from '../../shared/profiles.ts';
import type { QAEvent, QAInfo } from '../../shared/qa.ts';
import { median } from '../measure/stats.ts';
import {
  RELATIVE_TOLERANCE_MS,
  RESTORE_HOLD_MS,
  evaluateLatencyWindow,
  evaluateManifestCadence,
  evaluateStallRecovery,
  evaluateStart,
  restoreFrom,
  restoreRelativeOf,
  restoreWithin,
} from './evaluators.ts';
import type { JoinSample, LatencyPoint, RestoreSample, StallRun } from './evaluators.ts';
import { aggregate } from './verdict.ts';
import type { CheckId, Evaluation, Limits, Verdict } from './verdict.ts';
import type { ReadinessRun, ReadinessSession, ReadinessWorld } from './world.ts';

// The procedures of PB-RDY-001 to PB-RDY-004 (docs/decisions/readiness.md, ADR-151 to ADR-154): what a check does to a live session, in
// what order, and what it reads. They are written against `ReadinessWorld`, so the Playwright spec, the command line and the unit tests run
// the same code. Nothing here sleeps: every wait is on a player event, on the media clock or on the server's request log, and the only
// clock read is `world.now()`, to say how long after the recovery a read was taken.

export const CHECK_TITLES: Record<CheckId, string> = {
  'PB-RDY-001': 'Stream start',
  'PB-RDY-002': 'Live-edge latency over a window',
  'PB-RDY-003': 'Stall recovery after an injected origin stall',
  'PB-RDY-004': 'Manifest update cadence',
  'PB-RDY-005': 'Soak',
};

/** A join that has presented no first frame after this long has failed: startup is 0.06 to 1.6 s on localhost in the engines of docs/decisions/e2e-live.md (ADR-100), so this is a hang, not a slow join. */
export const JOIN_TIMEOUT_MS = 15_000;
/** One latency read per second of media time, as PB-LIVE-002 takes them. */
export const LATENCY_STEP_SEC = 1;
/** Media seconds a player plays before the outage is installed, so that the latency "before" is that of a player that is playing. */
export const SETTLE_SEC = 4;
/** Reads of the latency, one per media second and the last at the end of the settling, whose median is the session's own steady level (the relative reading of PB-RDY-003). */
export const STEADY_READS = 3;
/** The outage starts when the third segment from now is published: four to six seconds ahead, wherever the page's startup put the player (ADR-103). */
export const STALL_AFTER_SEGMENTS = 3;
/** The stream has been on air one DVR window when a session is created, so a window exists at once; the joins add their phase to it. */
export const BASE_OFFSET_SEC = LIVE_FACTS.segmentSec * LIVE_FACTS.windowSegments;

/** The buffer runs dry `presentationDelaySec` after the outage starts, and the outage starts at most `STALL_AFTER_SEGMENTS` segments from now; the rest is slack for a loaded runner. */
export const DRAIN_WITHIN_MS =
  (STALL_AFTER_SEGMENTS * LIVE_FACTS.segmentSec + LIVE_FACTS.presentationDelaySec) * 1000 + 15_000;
/** The player gets the stall-recovery limit and the same slack to resume; a player that has not by then is hung, not slow. */
export const resumeWithinMs = (limits: Limits): number => limits.stallRecoveryMaxMs + 15_000;

export interface PlayerEvidence {
  shakaVersion: string;
  userAgent: string;
  config: string;
  /** `qa.configure()` calls since boot: the proof that the configuration under test was applied. */
  configured: Array<Record<string, unknown>>;
  loadMode: QAInfo['loadMode'];
}

export function evidenceOf(info: QAInfo): PlayerEvidence {
  return {
    shakaVersion: info.shakaVersion,
    userAgent: info.userAgent,
    config: info.config,
    configured: info.configured,
    loadMode: info.loadMode,
  };
}

export interface CheckResult {
  id: CheckId;
  title: string;
  verdict: Verdict;
  evaluations: Evaluation[];
  /** The player did something that ends the check and is a NO-GO of its own: it hung, or stopped refreshing. */
  failure?: string;
  /** The harness could not run the check (a page that did not boot, a service that did not answer): a result about the run, not about the build. */
  error?: string;
  /** What was measured, for the result file. */
  samples: Record<string, unknown>;
  player: PlayerEvidence | null;
  durationMs: number;
  notes: string[];
}

export interface CheckOptions {
  /** The candidate configuration, in force before Shaka loads (`bootPlayer`): applied with `qa.configure()` to an idle page that is then told to load. null evaluates A, the defaults. */
  patch?: ShakaConfigPatch | null;
  limits?: Limits;
  log?: (line: string) => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** What the hook says when a wait runs out starts with one line; the timeline it appends is for the failure report, not for a result file. */
const headline = (error: unknown): string => messageOf(error).split('\n')[0]?.slice(0, 300) ?? '';

function finish(
  id: CheckId,
  world: ReadinessWorld,
  began: number,
  parts: {
    evaluations: Evaluation[];
    samples: Record<string, unknown>;
    player: PlayerEvidence | null;
    failure?: string | undefined;
    notes?: string[];
  },
): CheckResult {
  const verdict = parts.failure ? 'NO-GO' : aggregate(parts.evaluations);
  return {
    id,
    title: CHECK_TITLES[id],
    verdict,
    evaluations: parts.evaluations,
    ...(parts.failure ? { failure: parts.failure } : {}),
    samples: parts.samples,
    player: parts.player,
    durationMs: Math.round(world.now() - began),
    notes: parts.notes ?? [],
  };
}

/**
 * Boots the page for the run and reports what the page said it applied. A candidate configuration has to be in place before Shaka loads:
 * Shaka 5.3.3 registers the `timeupdate` listener that holds the live-sync target (`Player.onTimeUpdate_`) inside `load()`, and only when
 * `streaming.liveSync.enabled` is on at that moment (lib/player.js, the two places that call `loadEventManager_.listen(mediaElement,
 * 'timeupdate', onTimeUpdate)`); `configure()` does not add it later. A page that is given the manifest loads at once, so a candidate
 * applied to it afterwards runs the defaults whatever the page says it applied, which is what the first plumbing run of this phase did
 * (ADR-153). A candidate is therefore opened idle, configured, and only then told to load and play; the defaults are opened the way a
 * viewer's page opens, with the manifest.
 */
export async function bootPlayer(
  run: Pick<ReadinessRun, 'player' | 'session'>,
  patch: ShakaConfigPatch | null | undefined,
): Promise<PlayerEvidence> {
  if (patch) {
    await run.player.openIdle();
    await run.player.configure(patch as Record<string, unknown>);
    await run.player.loadAndPlay(run.session.manifestUrl);
  } else {
    await run.player.open();
  }
  return evidenceOf(await run.player.info());
}

/** Waits for the first frame; the hook's own words when it does not come, or null when it did. */
async function firstFrame(run: ReadinessRun): Promise<{ event: QAEvent } | { failure: string }> {
  try {
    return { event: await run.player.waitFor('firstframe', { timeoutMs: JOIN_TIMEOUT_MS }) };
  } catch (error) {
    return { failure: headline(error) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-001

export interface StartOptions extends CheckOptions {
  joins: number;
  /**
   * Make one join first and leave it out (default true). The first page of a browser process pays for the browser (its first renderer, its
   * media pipeline), not for the player, so it is an outlier by construction, and it would be the "worst of N" of the first configuration
   * that runs and of no other: the lab records that run and discards it (ADR-120, docs/decisions/perf.md).
   */
  warmup?: boolean;
}

/** The join that is recorded and left out: its first-frame time, or why it had none. */
export interface WarmupSample {
  startupMs: number | null;
  failure?: string;
}

/** Where inside the segment interval a request reached the origin, ms after the last segment was published. */
function phaseOf(session: ReadinessSession, entry: RequestLogEntry): number | null {
  if (!session.live) return null;
  const segmentMs = session.live.segmentDurationSec * 1000;
  const sinceAst = Date.parse(entry.t) - Date.parse(session.live.availabilityStartTime);
  return Number.isFinite(sinceAst) ? ((sinceAst % segmentMs) + segmentMs) % segmentMs : null;
}

/** One join as the measured ones are made, with the configuration under test (a candidate's idle path is warmed as well), and nothing judged. */
async function warmUpJoin(world: ReadinessWorld, options: StartOptions): Promise<WarmupSample> {
  const run = await world.newRun({
    label: 'PB-RDY-001 warm-up join',
    live: { startOffsetSec: BASE_OFFSET_SEC },
  });
  try {
    await bootPlayer(run, options.patch);
    const frame = await firstFrame(run);
    if ('failure' in frame) return { startupMs: null, failure: frame.failure };
    return { startupMs: (await run.player.metrics()).startupMs };
  } finally {
    await run.close();
  }
}

/**
 * N fresh joins, one after another, each in a session of its own and a browser context of its own, at different places in the segment
 * interval: the session is created with the stream already on air for a DVR window plus the join's share of a segment (`startOffsetSec`),
 * so the first request of every join reaches the origin at a different phase of its publication clock. The phase is read back from the
 * request log (it also contains the page's own start), so the claim "different positions" is in the result file and not assumed. A warm-up
 * join comes first and is left out of the verdict (`StartOptions.warmup`); it is in the result.
 */
export async function runStartCheck(world: ReadinessWorld, options: StartOptions): Promise<CheckResult> {
  const began = world.now();
  const limits = options.limits ?? LIVE_LIMITS;
  const joins: JoinSample[] = [];
  let player: PlayerEvidence | null = null;
  const warmup = options.warmup === false ? null : await warmUpJoin(world, options);
  if (warmup)
    options.log?.(
      warmup.startupMs === null
        ? `  warm-up join (left out): no first frame (${warmup.failure})`
        : `  warm-up join (left out): first frame after ${Math.round(warmup.startupMs)} ms`,
    );
  for (let index = 0; index < options.joins; index++) {
    const join = index + 1;
    const phaseSec = (index * LIVE_FACTS.segmentSec) / options.joins;
    const run = await world.newRun({
      label: `PB-RDY-001 join ${join} of ${options.joins}`,
      live: { startOffsetSec: BASE_OFFSET_SEC + phaseSec },
    });
    try {
      player = await bootPlayer(run, options.patch);
      const frame = await firstFrame(run);
      if ('failure' in frame) {
        joins.push({ join, startupMs: null, failure: frame.failure });
        options.log?.(`  join ${join}: no first frame (${frame.failure})`);
        continue;
      }
      const metrics = await run.player.metrics();
      const critical = metrics.errors.filter((error) => error.severity >= 2);
      const manifest = (await run.session.service.log(run.session.id)).find(
        (entry) => entry.kind === 'manifest',
      );
      if (metrics.startupMs === null || critical.length > 0 || metrics.state === 'error') {
        const why =
          critical.length > 0
            ? `critical error ${critical[0]?.codeName ?? critical[0]?.code}: ${critical[0]?.message}`
            : 'the player is in the error state or has no startup time';
        joins.push({ join, startupMs: null, failure: why });
        continue;
      }
      joins.push({
        join,
        startupMs: metrics.startupMs,
        phaseMs: manifest ? phaseOf(run.session, manifest) : null,
      });
      options.log?.(`  join ${join}: first frame after ${Math.round(metrics.startupMs)} ms`);
    } finally {
      await run.close();
    }
  }
  return finish('PB-RDY-001', world, began, {
    evaluations: evaluateStart(joins, limits),
    samples: { joins, ...(warmup ? { warmup } : {}) },
    player,
    notes: [
      `${options.joins} fresh sessions in fresh browser contexts, started ${(LIVE_FACTS.segmentSec / options.joins).toFixed(2)} s apart inside the ${LIVE_FACTS.segmentSec} s segment interval`,
      ...(warmup
        ? [
            `a warm-up join was made first and left out (${
              warmup.startupMs === null
                ? `it had no first frame: ${warmup.failure}`
                : `first frame after ${Math.round(warmup.startupMs)} ms`
            }): the first page of a browser process pays for the browser, not for the player`,
          ]
        : []),
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-002

export interface LatencyOptions extends CheckOptions {
  windowSec: number;
}

/**
 * Latency read once per second of media time over a window that starts at the first frame, on the media clock (`waitForMediaTime`, then
 * `metrics()`), plus the player's own maximum, which `timeupdate` keeps and which sees what happens between two reads. A window that
 * ends in a stall ends the check: the clock stopped, the latency of a player that is not playing is the evidence, and the check is a NO-GO.
 */
export async function runLatencyCheck(world: ReadinessWorld, options: LatencyOptions): Promise<CheckResult> {
  const began = world.now();
  const limits = options.limits ?? LIVE_LIMITS;
  const run = await world.newRun({ label: `PB-RDY-002 latency over ${options.windowSec} s` });
  try {
    const player = await bootPlayer(run, options.patch);
    const frame = await firstFrame(run);
    if ('failure' in frame) {
      return finish('PB-RDY-002', world, began, {
        evaluations: evaluateLatencyWindow({ samples: [] }, limits),
        samples: { reads: [] },
        player,
        failure: `no first frame to start the window from: ${frame.failure}`,
      });
    }
    const from = (await run.player.metrics()).playback.currentTime;
    const reads: LatencyPoint[] = [];
    let failure: string | undefined;
    for (let elapsed = LATENCY_STEP_SEC; elapsed <= options.windowSec; elapsed += LATENCY_STEP_SEC) {
      try {
        await run.player.waitForMediaTime(from + elapsed);
      } catch (error) {
        failure = `the media clock stopped ${elapsed - LATENCY_STEP_SEC} s into the ${options.windowSec} s window: ${headline(error)}`;
      }
      const metrics = await run.player.metrics();
      reads.push({ mediaTime: metrics.playback.currentTime, latencyMs: metrics.live.latencyMs });
      if (failure) break;
    }
    const final = await run.player.metrics();
    options.log?.(
      `  ${reads.length} latency reads, the player's maximum ${final.live.latencyMaxMs === null ? 'n/a' : `${Math.round(final.live.latencyMaxMs)} ms`}`,
    );
    return finish('PB-RDY-002', world, began, {
      evaluations: evaluateLatencyWindow(
        {
          samples: reads,
          playerMaxMs: final.live.latencyMaxMs,
          rebuffers: final.rebuffer.count,
          edgeSeeks: final.live.edgeSeeks,
        },
        limits,
      ),
      samples: {
        windowSec: options.windowSec,
        reads,
        playerMaxMs: final.live.latencyMaxMs,
        rebuffers: final.rebuffer.count,
        edgeSeeks: final.live.edgeSeeks,
        errors: final.errors.length,
      },
      player,
      failure,
    });
  } finally {
    await run.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-003

export interface StallOptions extends CheckOptions {
  runs: number;
}

interface StallOutcome {
  run: StallRun;
  failure?: string;
  notes: string[];
  player: PlayerEvidence | null;
  /** What the origin was told: where the outage began, in live segment numbers. */
  outage: { atNumber: number; ms: number } | null;
}

/**
 * One origin outage in a fresh session: the player plays, the origin stops publishing for `injectedStallMs` three segments from now
 * (`originStall`, longer than the presentation delay, so the buffer must drain), the player runs dry (`buffering-start`, with the origin's own
 * state read at that moment as the proof that the fault was in force), resumes (`playing`), and is then watched until latency is back
 * within the maximum and has stayed there, or until the limit and the hold have passed.
 */
async function runStallOnce(
  world: ReadinessWorld,
  index: number,
  options: StallOptions,
): Promise<StallOutcome> {
  const limits = options.limits ?? LIVE_LIMITS;
  const notes: string[] = [];
  const empty = (overrides: Partial<StallRun> = {}): StallRun => ({
    run: index,
    stalled: false,
    recoveryMs: null,
    waitedMs: null,
    latencyBeforeMs: null,
    after: [],
    observedMs: 0,
    ...overrides,
  });
  // The runs are staggered inside the segment interval, as the joins are: where the player stands on the origin's publication clock could
  // change when it sees the origin back, and three runs at one position would be one measurement three times.
  const run = await world.newRun({
    label: `PB-RDY-003 outage ${index} of ${options.runs}`,
    live: { startOffsetSec: BASE_OFFSET_SEC + ((index - 1) * LIVE_FACTS.segmentSec) / options.runs },
  });
  try {
    const player = await bootPlayer(run, options.patch);
    const frame = await firstFrame(run);
    if ('failure' in frame)
      return {
        run: empty(),
        failure: `run ${index}: no first frame before the outage: ${frame.failure}`,
        notes,
        player,
        outage: null,
      };
    // The session's own steady level: the median of a few reads, one per media second, the last where the settling ends.
    const steady: number[] = [];
    for (let back = STEADY_READS - 1; back >= 0; back--) {
      await run.player.waitForMediaTime(frame.event.mediaTime + SETTLE_SEC - back);
      const read = (await run.player.metrics()).live.latencyMs;
      if (read !== null) steady.push(read);
    }
    const latencyBeforeMs = steady.length === 0 ? null : median(steady);
    const before = { latencyBeforeMs, latencyBeforeReadsMs: steady };

    const live = (await run.session.service.detail(run.session.id)).live;
    if (!live) throw new Error(`the service reports no live clock for session ${run.session.id}`);
    const atNumber = live.edgeNumber + STALL_AFTER_SEGMENTS;
    await run.session.service.addFaults(run.session.id, originStall(atNumber, limits.injectedStallMs));
    const since = await run.player.cursor();

    let dry: QAEvent;
    try {
      dry = await run.player.waitFor('buffering-start', { since, timeoutMs: DRAIN_WITHIN_MS });
    } catch (error) {
      notes.push(
        `run ${index}: the player never ran dry within ${DRAIN_WITHIN_MS} ms of the outage being installed (${headline(error)})`,
      );
      return {
        run: empty(before),
        notes,
        player,
        outage: { atNumber, ms: limits.injectedStallMs },
      };
    }
    const stalledNow = (await run.session.service.detail(run.session.id)).live?.stalled === true;
    if (!stalledNow) {
      notes.push(
        `run ${index}: the player ran dry while the origin was not stalled: a stall of its own, not the outage's`,
      );
      return {
        run: empty(before),
        notes,
        player,
        outage: { atNumber, ms: limits.injectedStallMs },
      };
    }

    const wait = resumeWithinMs(limits);
    let resumed: QAEvent;
    try {
      resumed = await run.player.waitFor('playing', { since: dry.index, timeoutMs: wait });
    } catch (error) {
      notes.push(`run ${index}: the player did not resume within ${wait} ms (${headline(error)})`);
      return {
        run: empty({ stalled: true, waitedMs: wait, ...before }),
        notes,
        player,
        outage: { atNumber, ms: limits.injectedStallMs },
      };
    }

    // From the recovery on: one read per second of media time, stamped with the harness's wall clock since the recovery, until the latency
    // has been back within the maximum for the hold and (the relative reading, an advisory line next to the criterion) back within a
    // segment of its own level before the outage for the hold, or until the limit and the hold are over.
    const resumedAt = world.now();
    const after: RestoreSample[] = [];
    const read = async (): Promise<void> => {
      const metrics = await run.player.metrics();
      after.push({
        sinceResumeMs: world.now() - resumedAt,
        latencyMs: metrics.live.latencyMs,
        playbackRate: metrics.playback.playbackRate,
      });
    };
    const restoredBoth = (): boolean => {
      const sinceMs = world.now() - resumedAt;
      const relative =
        latencyBeforeMs === null
          ? true
          : restoreWithin(after, sinceMs, latencyBeforeMs + RELATIVE_TOLERANCE_MS).restored;
      return restoreFrom(after, sinceMs, limits).restored && relative;
    };
    await read();
    const budgetMs = limits.latencyRestoreMaxMs + RESTORE_HOLD_MS;
    for (let step = 1; world.now() - resumedAt < budgetMs; step++) {
      // A second stall in the observation makes the media clock wait: the read is taken anyway, it is what the viewer lives through.
      await run.player.waitForMediaTime(resumed.mediaTime + step * LATENCY_STEP_SEC).catch(() => undefined);
      await read();
      if (restoredBoth()) break;
    }
    const observedMs = world.now() - resumedAt;
    const restore = restoreFrom(after, observedMs, limits);
    const relativeRestore = restoreRelativeOf({ ...empty(before), after, observedMs });
    const describeRestore = (found: typeof restore | null): string =>
      found === null
        ? 'n/a'
        : found.restored
          ? `restored ${Math.round(found.atMs)} ms after the recovery`
          : `not restored after ${Math.round(observedMs)} ms (last ${found.finalLatencyMs === null ? 'n/a' : Math.round(found.finalLatencyMs)} ms)`;
    options.log?.(
      `  outage ${index}: stalled ${Math.round(resumed.t - dry.t)} ms, latency ${latencyBeforeMs === null ? 'n/a' : Math.round(latencyBeforeMs)} ms before; absolute: ${describeRestore(restore)}; relative to its own level: ${describeRestore(relativeRestore)}`,
    );
    return {
      run: {
        run: index,
        stalled: true,
        recoveryMs: resumed.t - dry.t,
        waitedMs: null,
        ...before,
        after,
        observedMs,
      },
      notes,
      player,
      outage: { atNumber, ms: limits.injectedStallMs },
    };
  } finally {
    await run.close();
  }
}

/** The origin outage, `runs` times in fresh sessions: the worst recovery and the worst restoration are judged. */
export async function runStallCheck(world: ReadinessWorld, options: StallOptions): Promise<CheckResult> {
  const began = world.now();
  const limits = options.limits ?? LIVE_LIMITS;
  const runs: StallRun[] = [];
  const notes: string[] = [];
  const outages: Array<StallOutcome['outage']> = [];
  let player: PlayerEvidence | null = null;
  let failure: string | undefined;
  for (let index = 1; index <= options.runs; index++) {
    const outcome = await runStallOnce(world, index, options);
    runs.push(outcome.run);
    notes.push(...outcome.notes);
    outages.push(outcome.outage);
    player = outcome.player ?? player;
    failure = failure ?? outcome.failure;
  }
  return finish('PB-RDY-003', world, began, {
    evaluations: evaluateStallRecovery(runs, limits),
    samples: {
      runs,
      outages,
      outageMs: limits.injectedStallMs,
      relativeToleranceMs: RELATIVE_TOLERANCE_MS,
    },
    player,
    failure,
    notes,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-004

export interface CadenceOptions extends CheckOptions {
  /** Refreshes to watch after the load. */
  refreshes: number;
}

/**
 * The requests that make up the refresh series of a session: for DASH every manifest request; for HLS the media playlists of the audio
 * (one rendition: the playlists of the video change files at every rung switch, and a switch is not a refresh, as in PB-LIVE-004).
 */
export function refreshSeries(
  log: readonly RequestLogEntry[],
  protocol: ReadinessWorld['protocol'],
  audioReps: readonly string[],
): RequestLogEntry[] {
  return log.filter(
    (entry) =>
      entry.kind === 'manifest' &&
      (protocol === 'dash' || (entry.rep !== undefined && audioReps.includes(entry.rep))),
  );
}

/**
 * The gaps between the player's own requests for the manifest (or the audio playlist), read from the server's request log by the time they
 * reached the origin. The check waits on the log for the number of refreshes it wants; a player that stops asking is a NO-GO, with the
 * gaps so far.
 */
export async function runCadenceCheck(world: ReadinessWorld, options: CadenceOptions): Promise<CheckResult> {
  const began = world.now();
  const limits = options.limits ?? LIVE_LIMITS;
  const run = await world.newRun({ label: `PB-RDY-004 cadence over ${options.refreshes} refreshes` });
  try {
    const player = await bootPlayer(run, options.patch);
    const frame = await firstFrame(run);
    if ('failure' in frame) {
      return finish('PB-RDY-004', world, began, {
        evaluations: evaluateManifestCadence([], [], limits),
        samples: { arrivalsMs: [] },
        player,
        failure: `no first frame, so no refreshes to watch: ${frame.failure}`,
      });
    }
    const audioReps =
      world.protocol === 'hls'
        ? ((await run.session.service.streams()).find((stream) => stream.id === world.stream)?.reps ?? [])
            .filter((rep) => rep.track === 'audio')
            .map((rep) => rep.id)
        : [];
    const wanted = 1 + options.refreshes;
    const timeoutMs = (options.refreshes + 5) * limits.manifestPeriodMs + 30_000;
    let failure: string | undefined;
    try {
      await run.session.service.waitForLog(
        run.session.id,
        (entries) => refreshSeries(entries, world.protocol, audioReps).length >= wanted,
        { timeoutMs },
      );
    } catch {
      failure = `the player asked the origin for its ${world.protocol === 'dash' ? 'manifest' : 'audio playlist'} fewer than ${wanted} times in ${Math.round(timeoutMs / 1000)} s: it stopped tracking the live window`;
    }
    const series = refreshSeries(await run.session.service.log(run.session.id), world.protocol, audioReps);
    const arrivals = series.map((entry) => Date.parse(entry.t));
    options.log?.(
      `  ${series.length} requests for the ${world.protocol === 'dash' ? 'manifest' : 'audio playlist'} in the log`,
    );
    return finish('PB-RDY-004', world, began, {
      evaluations: evaluateManifestCadence(arrivals, [], limits),
      samples: {
        series: world.protocol === 'dash' ? 'manifest' : `media playlist of ${audioReps.join(', ')}`,
        arrivalsMs: arrivals,
        statuses: series.map((entry) => entry.status),
      },
      player,
      failure,
    });
  } finally {
    await run.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// All the checks of one configuration

export interface ReadinessRunOptions extends CheckOptions {
  checks: readonly CheckId[];
  joins: number;
  stallRuns: number;
  windowSec: number;
  refreshes: number;
}

/**
 * The selected checks, in the order of the catalog, one after another (a check occupies a browser and a clock). A check that cannot run
 * because the harness failed (a page that did not boot, a service that did not answer) does not stop the others: it is reported as
 * INCONCLUSIVE with the reason, which is a statement about the run and never a pass.
 */
export async function runReadinessChecks(
  world: ReadinessWorld,
  options: ReadinessRunOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const id of options.checks) {
    options.log?.(`${id} ${CHECK_TITLES[id]}`);
    const began = world.now();
    try {
      switch (id) {
        case 'PB-RDY-001':
          results.push(await runStartCheck(world, { ...options, joins: options.joins }));
          break;
        case 'PB-RDY-002':
          results.push(await runLatencyCheck(world, { ...options, windowSec: options.windowSec }));
          break;
        case 'PB-RDY-003':
          results.push(await runStallCheck(world, { ...options, runs: options.stallRuns }));
          break;
        case 'PB-RDY-004':
          results.push(await runCadenceCheck(world, { ...options, refreshes: options.refreshes }));
          break;
        case 'PB-RDY-005':
          throw new Error('PB-RDY-005 is the soak: `npm run soak`');
      }
    } catch (error) {
      options.log?.(`  could not run: ${headline(error)}`);
      results.push({
        id,
        title: CHECK_TITLES[id],
        verdict: 'INCONCLUSIVE',
        evaluations: [],
        error: messageOf(error).slice(0, 2000),
        samples: {},
        player: null,
        durationMs: Math.round(world.now() - began),
        notes: [],
      });
    }
    const last = results.at(-1);
    if (last) options.log?.(`  ${last.verdict}`);
  }
  return results;
}
