// The live loop's timeline arithmetic, in one place: the media store, the manifest builders, the tests and the verification tool all
// use it, so they cannot disagree about where live segment n sits (docs/CONTRACTS.md section 3, "Live simulation").

import type { RepIndex } from './types.ts';

export function assertLiveNumber(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError(`live segment numbers are integers >= 1, got ${n}`);
}

/** Live segment n is source segment `source` (1-based) of loop `loop` (0-based). */
export function liveSource(segmentCount: number, n: number): { source: number; loop: number } {
  assertLiveNumber(n);
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1)
    throw new RangeError(`invalid segment count ${segmentCount}`);
  return { source: ((n - 1) % segmentCount) + 1, loop: Math.floor((n - 1) / segmentCount) };
}

/** Start and duration of live segment n on the live timeline, in the ticks of the representation. */
export function liveTiming(rep: RepIndex, n: number): { start: number; duration: number } {
  const { source, loop } = liveSource(rep.segments.length, n);
  const seg = rep.segments[source - 1];
  if (!seg) throw new RangeError(`representation ${rep.rep.id} has no source segment ${source}`);
  const start = seg.start + loop * rep.loopTicks;
  if (!Number.isSafeInteger(start))
    throw new RangeError(`live segment ${n} of ${rep.rep.id} starts beyond 2^53 ticks`);
  return { start, duration: seg.duration };
}
