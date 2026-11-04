import type { SessionInfo } from '../../shared/api.ts';
import type { QAError, QAMetrics } from '../../shared/qa.ts';
import type { StreamId } from '../../shared/streams.ts';
import type { PlayerDriver } from './page.ts';
import type { MetricSpec, PerfProfile, RunRecord, ScenarioSpec } from './types.ts';

// The scenarios of the catalog (TEST_STRATEGY.md section 9, PB-PERF-001 to PB-PERF-004), each a typed object: what it is (its `ScenarioSpec`:
// the condition, the rung it holds, the metrics it yields and which of them gate, by which rule), and how to take ONE measurement
// (`run`, in a fresh browser context with a session of its own). The numbers that decide a verdict live in src/shared/criteria.ts; a
// scenario only says which rule judges which metric.
//
// The player is the page's configuration A (Shaka's defaults, docs/decisions/player.md ADR-064). Its first rung depends on the engine
// (720p in Chromium, whose reported downlink is high; 360p in the others), so every run records the rung it started on, and the
// scenarios that depend on it (startup, rebuffering) are compared only with a baseline that started on the same one.

/** Media seconds that play, after the first frame, before the frame window opens: the decoder, the compositor and the JIT settle first. */
export const FRAME_WARMUP_MEDIA_SEC = 2;
/** Media seconds counted by the frame window (PB-PERF-002: "a 5 s measured window"). */
export const FRAME_WINDOW_MEDIA_SEC = 5;
/** The rung the frame windows hold. The ladder's top rung: the one that costs the most per frame. */
export const PINNED_HEIGHT = 720;
/**
 * Media seconds that PB-PERF-003 plays after the first frame: the first 8 s are four segments before the link drops (the profile's
 * `afterMs`), and about 10 s more are what the player needs to react (its default minimum switch interval is 8 s).
 */
export const REBUFFER_OBSERVE_MEDIA_SEC = 18;
/** Wall-clock the rebuffering run may take to play those seconds: stalls make it longer than the media. */
const REBUFFER_WAIT_MS = 90_000;

export interface RunContext {
  qa: PlayerDriver;
  session: Pick<SessionInfo, 'id' | 'manifestUrl'>;
  stream: StreamId;
  profile: PerfProfile;
}

/** What one run measured. The runner adds how long it took. */
export type Measured = Omit<RunRecord, 'durationMs'>;

export interface Scenario extends ScenarioSpec {
  /** One measurement. Throws when the run is not valid (the player failed, a precondition of the scenario did not hold): never returns a number it cannot stand behind. */
  run(context: RunContext): Promise<Measured>;
}

const describeError = (error: QAError): string => `${error.codeName ?? error.code}/${error.severity}`;

/** A critical Shaka error ends a viewing session: a run that had one measured something that is not playback. */
function assertNoCriticalError(metrics: QAMetrics, where: string): void {
  const critical = metrics.errors.filter((error) => error.severity === 2);
  if (critical.length > 0)
    throw new Error(
      `${where}: the player reported a critical error: ${critical.map(describeError).join(', ')}`,
    );
}

/**
 * Plays until the media clock reaches `mediaTime`, or fails the moment the player reports a critical error: a player that has given up
 * never gets there, and the run must not wait out its whole safety net (90 s for the rebuffering scenario) to say so.
 */
async function playUntil(qa: PlayerDriver, mediaTime: number, timeoutMs?: number): Promise<number> {
  const critical = new Promise<never>((_, reject) => {
    qa.waitFor('error', { detail: { severity: 2 }, ...(timeoutMs === undefined ? {} : { timeoutMs }) }).then(
      (event) =>
        reject(
          new Error(
            `the player reported a critical error before media time ${mediaTime.toFixed(1)} s: ${JSON.stringify(event.detail)}`,
          ),
        ),
      // No critical error within the wait is the normal case: the media-time wait decides.
      () => {},
    );
  });
  return Promise.race([qa.waitForMediaTime(mediaTime, timeoutMs), critical]);
}

function recorded(metrics: QAMetrics, values: Record<string, number | null>): Measured {
  const history = metrics.bitrate.history;
  return {
    values,
    startRungHeight: history.find((change) => change.reason === 'start')?.height ?? null,
    rungs: history.map((change) => ({ ...change })),
    errors: metrics.errors.map(describeError),
  };
}

/** dropped / decoded of a frame window; null when nothing was decoded in it (no number is better than 0 / 0). */
const droppedRatioOf = (decoded: number, dropped: number): number | null =>
  decoded > 0 ? dropped / decoded : null;

const startupMetrics = (rule: MetricSpec['rule']): MetricSpec[] => [
  { id: 'startupMs', label: 'Startup time', unit: 'ms', rule },
  { id: 'manifestMs', label: 'Manifest time', unit: 'ms', rule: null },
  { id: 'loadedMs', label: 'Load time', unit: 'ms', rule: null },
];

const frameCounts: MetricSpec[] = [
  { id: 'decodedFrames', label: 'Frames decoded in the window', unit: 'count', rule: null },
  { id: 'droppedFrames', label: 'Frames dropped in the window', unit: 'count', rule: null },
];

const BROWSERS: readonly PerfProfile[] = ['chromium', 'firefox', 'webkit'];

/** PB-PERF-001: how long after `load()` the first frame is presented, on a clean network. */
const startup: Scenario = {
  id: 'PB-PERF-001',
  name: 'startup',
  title: 'Startup baseline (vod-cmaf, clean): load-requested to the first frame presented',
  profiles: BROWSERS,
  faultProfile: 'clean',
  protocol: 'dash',
  pinnedHeight: null,
  startRungMatters: true,
  metrics: startupMetrics('startup'),
  async run({ qa, session }) {
    await qa.open(session.manifestUrl);
    await qa.waitFor('firstframe');
    const metrics = await qa.metrics();
    assertNoCriticalError(metrics, 'PB-PERF-001');
    return recorded(metrics, {
      startupMs: metrics.startupMs,
      manifestMs: metrics.startup.manifestMs,
      loadedMs: metrics.startup.loadedMs,
    });
  },
};

/**
 * PB-PERF-002: the frame rate and dropped frames of steady playback at the pinned rung. The rung is pinned BEFORE playback starts (the
 * page loads without autoplay and with ABR off, `selectVariantByHeight` flushes what was buffered, then it plays): pinning after the first
 * frame would leave seconds of the first rung in the buffer, and the window would count them as 720p.
 */
const frameRate: Scenario = {
  id: 'PB-PERF-002',
  name: 'frame-rate',
  title: `Steady-state frame rate and dropped frames (vod-cmaf, clean, pinned ${PINNED_HEIGHT}p, a ${FRAME_WINDOW_MEDIA_SEC} s window)`,
  profiles: BROWSERS,
  faultProfile: 'clean',
  protocol: 'dash',
  pinnedHeight: PINNED_HEIGHT,
  startRungMatters: false,
  metrics: [
    { id: 'fps', label: 'Effective frame rate', unit: 'fps', rule: 'fps' },
    { id: 'droppedRatio', label: 'Dropped-frame ratio', unit: 'ratio', rule: 'frameDropped' },
    ...frameCounts,
  ],
  async run({ qa, session }) {
    await qa.open(session.manifestUrl, { autoplay: false, abr: false });
    // The page loads the manifest itself (autoplay only decides whether it then plays), so the load is awaited and not requested again:
    // a second load() interrupts one that is still running (LOAD_INTERRUPTED, a critical error) and then no first frame arrives. On
    // Firefox in the container that happened in about one run in twelve, and the A/A check of the first version of this scenario found it.
    await qa.waitFor('loaded');
    await qa.selectVariantByHeight(PINNED_HEIGHT);
    await qa.play();
    const first = await qa.waitFor('firstframe');
    await playUntil(qa, first.mediaTime + FRAME_WARMUP_MEDIA_SEC);
    const frames = await qa.measureFrames(FRAME_WINDOW_MEDIA_SEC);
    const metrics = await qa.metrics();
    assertNoCriticalError(metrics, 'PB-PERF-002');
    assertPinned(metrics, 'PB-PERF-002');
    return recorded(metrics, {
      fps: frames.fps,
      droppedRatio: droppedRatioOf(frames.decoded, frames.dropped),
      decodedFrames: frames.decoded,
      droppedFrames: frames.dropped,
    });
  },
};

/** The window must have been played on the rung the scenario pins: no rung change after the pin, and the active rung is the pinned one. */
function assertPinned(metrics: QAMetrics, where: string): void {
  const height = metrics.bitrate.current?.height ?? null;
  if (height !== PINNED_HEIGHT)
    throw new Error(
      `${where}: the window was meant to play at ${PINNED_HEIGHT}p but the active rung is ${String(height)}p`,
    );
  const moved = metrics.bitrate.history.filter((change) => change.reason === 'abr');
  if (moved.length > 0)
    throw new Error(
      `${where}: the rung changed by itself (${moved.map((change) => `${String(change.height)}p`).join(', ')}) although ABR was meant to be off: the window is not one rung`,
    );
}

/**
 * PB-PERF-003: rebuffering under `bandwidth-drop`. The player plays with its own adaptation for a fixed number of MEDIA seconds (so a
 * stall makes the run longer, never the window shorter) and the run reports what the metrics of docs/METRICS.md counted: stalls that began
 * after the first frame and outside a seek (the scenario never seeks).
 */
const rebuffering: Scenario = {
  id: 'PB-PERF-003',
  name: 'rebuffering',
  title: `Rebuffering on a changing network (bandwidth-drop): count, duration and ratio over ${REBUFFER_OBSERVE_MEDIA_SEC} s of media`,
  profiles: BROWSERS,
  faultProfile: 'bandwidth-drop',
  protocol: 'dash',
  pinnedHeight: null,
  startRungMatters: true,
  metrics: [
    { id: 'rebufferCount', label: 'Rebuffers', unit: 'count', rule: 'rebufferCount' },
    { id: 'rebufferMs', label: 'Rebuffer time', unit: 'ms', rule: 'rebufferMs' },
    { id: 'rebufferRatio', label: 'Rebuffer ratio', unit: 'ratio', rule: 'rebufferRatio' },
    { id: 'switches', label: 'Rung switches', unit: 'count', rule: null },
  ],
  async run({ qa, session }) {
    await qa.open(session.manifestUrl);
    const first = await qa.waitFor('firstframe');
    await playUntil(qa, first.mediaTime + REBUFFER_OBSERVE_MEDIA_SEC, REBUFFER_WAIT_MS);
    const metrics = await qa.metrics();
    assertNoCriticalError(metrics, 'PB-PERF-003');
    return recorded(metrics, {
      rebufferCount: metrics.rebuffer.count,
      rebufferMs: metrics.rebuffer.totalMs,
      rebufferRatio: metrics.rebuffer.ratio,
      switches: metrics.bitrate.switches,
    });
  },
};

/**
 * PB-PERF-004: the low-end profile (4x CPU throttle): startup, then the dropped frames of a window at the pinned rung. The startup is the
 * unmodified autoplay load, so it is the number PB-PERF-001 would give on a slow device. The window pins the rung AFTER the first frame,
 * which can only avoid mixing rungs when the player already started on it (a pin on the active rung changes nothing and flushes
 * nothing), so a run that started elsewhere is refused instead of measured: with ABR on, the buffer would hold the other rung.
 */
const lowEnd: Scenario = {
  id: 'PB-PERF-004',
  name: 'low-end',
  title: `Low-end device (4x CPU throttle, vod-cmaf, clean): startup, and dropped frames at ${PINNED_HEIGHT}p`,
  profiles: ['chromium-cpu4x'],
  faultProfile: 'clean',
  protocol: 'dash',
  pinnedHeight: PINNED_HEIGHT,
  startRungMatters: true,
  metrics: [
    ...startupMetrics('lowEndStartup'),
    { id: 'droppedRatio', label: 'Dropped-frame ratio', unit: 'ratio', rule: 'lowEndDropped' },
    { id: 'fps', label: 'Effective frame rate', unit: 'fps', rule: null },
    ...frameCounts,
  ],
  async run({ qa, session }) {
    await qa.open(session.manifestUrl);
    const first = await qa.waitFor('firstframe');
    const started = await qa.metrics();
    assertNoCriticalError(started, 'PB-PERF-004');
    const startHeight = started.bitrate.history.find((change) => change.reason === 'start')?.height ?? null;
    if (startHeight !== PINNED_HEIGHT) {
      throw new Error(
        `PB-PERF-004: the player started on ${String(startHeight)}p, not on ${PINNED_HEIGHT}p: pinning ${PINNED_HEIGHT}p now would leave the first rung in the buffer and the window would mix rungs. The first rung follows the browser's reported downlink (ADR-064 in docs/decisions/player.md).`,
      );
    }
    await qa.selectVariantByHeight(PINNED_HEIGHT);
    await playUntil(qa, first.mediaTime + FRAME_WARMUP_MEDIA_SEC);
    const frames = await qa.measureFrames(FRAME_WINDOW_MEDIA_SEC);
    const metrics = await qa.metrics();
    assertNoCriticalError(metrics, 'PB-PERF-004');
    assertPinned(metrics, 'PB-PERF-004');
    return recorded(metrics, {
      startupMs: started.startupMs,
      manifestMs: started.startup.manifestMs,
      loadedMs: started.startup.loadedMs,
      droppedRatio: droppedRatioOf(frames.decoded, frames.dropped),
      fps: frames.fps,
      decodedFrames: frames.decoded,
      droppedFrames: frames.dropped,
    });
  },
};

export const SCENARIOS: readonly Scenario[] = [startup, frameRate, rebuffering, lowEnd];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** The scenarios a profile runs, in catalog order; `ids` (when given) narrows them. */
export function scenariosFor(profile: PerfProfile, ids: readonly string[] | null = null): Scenario[] {
  return SCENARIOS.filter(
    (scenario) => scenario.profiles.includes(profile) && (ids === null || ids.includes(scenario.id)),
  );
}
