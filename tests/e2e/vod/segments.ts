import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { StreamInfo, Track } from '../../../src/shared/streams.ts';
import type { RequestFilter } from '../support/waiting.ts';
import { requestsFor } from '../support/waiting.ts';

// What the origin's request log says about the segments of a title, per track. The video is a ladder of representations the player
// may switch between (`v240`, `v360`, `v720`) and the audio is a separate one (`a-aac`, `a-opus`): "segment 21 was requested" is a
// statement about a track, over whichever rung the player was on, so the numbers are collected over every representation of it.

/** The ids of the representations of one track, from the stream's catalog entry (never hard-coded: `a-aac` is not `a-opus`). */
export function repsOfTrack(info: StreamInfo, track: Track): string[] {
  return info.reps.filter((rep) => rep.track === track).map((rep) => rep.id);
}

/** The segment numbers requested for a track, over all its representations, in arrival order and with repeats (a refetch shows twice). */
export function segmentNumbers(
  log: readonly RequestLogEntry[],
  info: StreamInfo,
  track: Track,
  filter: Pick<RequestFilter, 'status'> = {},
): number[] {
  return requestsFor(log, { ...filter, kind: 'segment', rep: repsOfTrack(info, track) })
    .map((entry) => entry.number)
    .filter((number): number is number => number !== undefined);
}

/** Without repeats, ascending: "which segments were delivered at all". */
export function distinctAscending(numbers: readonly number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** `[1, 2, ..., last]`: every segment of a title of `last` segments. */
export function allSegments(last: number): number[] {
  return Array.from({ length: last }, (_, index) => index + 1);
}

/** The number of the segment that covers a media time: segment `k` covers `[(k - 1) d, k d)`. */
export function segmentCovering(info: StreamInfo, mediaTime: number): number {
  return Math.floor(mediaTime / info.segmentDurationSec) + 1;
}

/** The middle of segment `number`: half a segment (a GOP: every rung starts one on every segment) from any boundary, whatever its duration. */
export function middleOfSegment(info: StreamInfo, number: number): number {
  return (number - 0.5) * info.segmentDurationSec;
}
