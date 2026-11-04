import type { SoakSample } from './soak-evaluators.ts';

// The soak's sampler runs IN THE PAGE, at the page's own cadence, and the harness only collects what it took. Why in the page: a read taken
// by a timer of the harness is delayed by whatever the harness is doing (a forced collection through DevTools takes hundreds of
// milliseconds, a log read a few), and is stamped with the harness's clock; a read taken by the page is stamped with the page's own clock,
// the one the player's event timeline uses, and keeps coming while the harness is busy. It keeps coming while the player is stalled, too,
// which a wait on the media clock would not: a soak must watch a hang, not wait for it to end.
//
// The code is a string, evaluated as an expression: it does not go through the transformer that compiles the harness (tsx keeps function
// names with a helper that does not exist in the page), and it can be run in a Node `vm` with a fake `window` by the unit test, which is
// the only way to test it without a browser.

/** The most reads the page keeps while the harness is not collecting them: the oldest are dropped and counted. */
export const MAX_KEPT_SAMPLES = 2000;

/** One read as the page took it, on the page's clock (`performance.now()`), before it is placed on the epoch axis. */
export interface RawSample {
  t: number;
  mediaTime: number;
  latencyMs: number | null;
  state: string;
  rate: number;
  buffered: number;
  decoded: number;
  dropped: number;
  rebufferCount: number;
  rebufferMs: number;
  edgeSeeks: number;
  errors: number;
}

export interface InstallResult {
  /** `performance.timeOrigin`: epoch ms of the page clock's zero. */
  timeOrigin: number;
  /** A sampler was already running in the page (it is left alone). */
  reused: boolean;
}

export interface Drained {
  samples: RawSample[];
  /** Reads dropped since the last drain because the harness did not collect them in time. */
  lost: number;
  /** What went wrong inside the sampler (the hook threw), the first few. */
  problems: string[];
}

/** An expression that starts the sampler in the page: one read now, then one every `everyMs`. */
export function installExpression(everyMs: number, maxKept: number = MAX_KEPT_SAMPLES): string {
  if (!Number.isFinite(everyMs) || everyMs < 100)
    throw new RangeError(`the sampler cadence must be at least 100 ms, got ${String(everyMs)}`);
  return `(function () {
  var w = window;
  if (w.__pbSoak) return { timeOrigin: performance.timeOrigin, reused: true };
  var state = { samples: [], lost: 0, problems: [], timer: 0 };
  function read() {
    try {
      var m = w.__qa.metrics();
      state.samples.push({
        t: performance.now(),
        mediaTime: m.playback.currentTime,
        latencyMs: m.live.latencyMs,
        state: m.state,
        rate: m.playback.playbackRate,
        buffered: m.playback.bufferedAheadSec,
        decoded: m.frames.decoded,
        dropped: m.frames.dropped,
        rebufferCount: m.rebuffer.count,
        rebufferMs: m.rebuffer.totalMs,
        edgeSeeks: m.live.edgeSeeks,
        errors: m.errors.length
      });
      if (state.samples.length > ${Math.floor(maxKept)}) { state.samples.shift(); state.lost += 1; }
    } catch (e) {
      if (state.problems.length < 20) state.problems.push(String(e && e.message ? e.message : e));
    }
  }
  w.__pbSoak = state;
  state.timer = w.setInterval(read, ${Math.floor(everyMs)});
  read();
  return { timeOrigin: performance.timeOrigin, reused: false };
})()`;
}

/** An expression that hands over the reads taken since the last time, and empties the page's list: what the page holds stays bounded. */
export const DRAIN_EXPRESSION = `(function () {
  var s = window.__pbSoak;
  if (!s) return null;
  var out = { samples: s.samples.splice(0, s.samples.length), lost: s.lost, problems: s.problems.splice(0, s.problems.length) };
  s.lost = 0;
  return out;
})()`;

/** An expression that stops the sampler. */
export const STOP_EXPRESSION = `(function () {
  var s = window.__pbSoak;
  if (!s) return false;
  window.clearInterval(s.timer);
  return true;
})()`;

/** A read on the epoch axis, in the shape the soak evaluators take. */
export function toSoakSample(raw: RawSample, timeOrigin: number): SoakSample {
  return {
    atMs: timeOrigin + raw.t,
    mediaTime: raw.mediaTime,
    latencyMs: raw.latencyMs,
    state: raw.state,
    playbackRate: raw.rate,
    bufferedAheadSec: raw.buffered,
    decodedFrames: raw.decoded,
    droppedFrames: raw.dropped,
    rebufferCount: raw.rebufferCount,
    rebufferMs: raw.rebufferMs,
    edgeSeeks: raw.edgeSeeks,
    errors: raw.errors,
  };
}
