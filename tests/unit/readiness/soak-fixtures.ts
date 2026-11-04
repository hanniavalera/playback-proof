import type {
  FaultWindow,
  HeapSample,
  SoakEpisode,
  SoakError,
  SoakInput,
  SoakSample,
} from '../../../src/lab/readiness/soak-evaluators.ts';

// A synthetic soak: the same shape the harness records, with numbers chosen so that the arithmetic of a limit can be done by hand.

export const T0 = 1_760_000_000_000;

export interface SoakOptions {
  minutes?: number;
  warmupSec?: number;
  cadenceSec?: number;
  engine?: SoakInput['engine'];
  /** Latency at `sec` seconds after the first frame, ms. */
  latency?: (sec: number) => number | null;
  faults?: FaultWindow[];
  episodes?: SoakEpisode[];
  errors?: SoakError[];
  heap?: HeapSample[] | null;
  frames?: SoakInput['frames'];
  manifestEverySec?: number;
}

export const at = (sec: number): number => T0 + sec * 1000;

/** A stall of `durationSec` that starts `startSec` after the first frame, as the hook reports it. */
export const episode = (startSec: number, durationSec: number, ongoing = false): SoakEpisode => ({
  startMs: at(startSec),
  durationMs: durationSec * 1000,
  ongoing,
  mediaTime: startSec,
});

export const fault = (
  startSec: number,
  durationSec: number,
  kind: FaultWindow['kind'] = 'origin-stall',
): FaultWindow => ({
  kind,
  startMs: at(startSec),
  endMs: at(startSec + durationSec),
});

export const error = (sec: number, severity: number, codeName = 'BAD_HTTP_STATUS'): SoakError => ({
  atMs: at(sec),
  severity,
  code: 1001,
  codeName,
  source: 'shaka',
  message: 'HTTP error status 404',
});

/** A heap reading every `everySec` after the first frame, from `fromSec`, the value given by `mb(sec)`. */
export const heapSeries = (minutes: number, everySec: number, mb: (sec: number) => number): HeapSample[] =>
  Array.from({ length: Math.floor((minutes * 60) / everySec) + 1 }, (_, i) => ({
    atMs: at(i * everySec),
    usedMb: mb(i * everySec),
  }));

export function soak(options: SoakOptions = {}): SoakInput {
  const minutes = options.minutes ?? 5;
  const cadence = options.cadenceSec ?? 5;
  const latency = options.latency ?? (() => 6200);
  const episodes = options.episodes ?? [];
  const samples: SoakSample[] = [];
  for (let sec = 0; sec <= minutes * 60; sec += cadence) {
    const stalled = episodes.some((e) => at(sec) >= e.startMs && at(sec) < e.startMs + e.durationMs);
    // The media clock stands still for as long as a stall lasts, so after it the clock is behind the wall clock by what was stalled.
    const behind = episodes.reduce(
      (sum, e) => sum + Math.min(Math.max(0, at(sec) - e.startMs), e.durationMs) / 1000,
      0,
    );
    samples.push({
      atMs: at(sec),
      mediaTime: sec - behind,
      latencyMs: latency(sec),
      state: stalled ? 'buffering' : 'playing',
      playbackRate: 1,
      bufferedAheadSec: 6,
      decodedFrames: sec * 30,
      droppedFrames: 0,
      rebufferCount: 0,
      rebufferMs: 0,
      edgeSeeks: 0,
      errors: 0,
    });
  }
  const every = options.manifestEverySec ?? 2;
  return {
    engine: options.engine ?? 'chromium',
    firstFrameMs: at(0),
    endMs: at(minutes * 60),
    requestedMinutes: minutes,
    warmupMs: (options.warmupSec ?? 60) * 1000,
    samples,
    episodes,
    errors: options.errors ?? [],
    frames: options.frames === undefined ? { decoded: minutes * 60 * 30, dropped: 0 } : options.frames,
    heap:
      options.heap === undefined
        ? (options.engine ?? 'chromium') === 'chromium'
          ? heapSeries(minutes, 30, () => 14)
          : null
        : options.heap,
    faults: options.faults ?? [],
    manifestArrivalsMs: Array.from({ length: Math.floor((minutes * 60) / every) + 1 }, (_, i) =>
      at(i * every),
    ),
  };
}
