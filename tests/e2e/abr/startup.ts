import type { StreamInfo } from '../../../src/shared/streams.ts';
import type { Ladder, Rung } from './ladder.ts';

// The bound on the first frame of a session on a slow link (PB-ABR-006), derived from the link and the stream and not from a run.
//
// What the player may legitimately fetch before it can show a frame, over a shared link of `linkKbps` that delivers at least
// `1 - LINK_TOLERANCE` of it (the throttle's contract, docs/CONTRACTS.md section 5: goodput within +-10 %):
//   - the first segment of the rung it starts on. It may be abandoned: Shaka does not trust its own estimate until it has sampled
//     `abr.advanced.minTotalBytes` (128 kB), and the first segment of a rung the link cannot carry is cut off, at the earliest, at that
//     point, plus what was in flight (two 16 kB chunks of the throttle's grants);
//   - then, when it abandoned the start rung, the first segment of the lowest rung;
//   - the first audio segment, which shares the link with the video;
//   - the initialization segments (a few hundred bytes each).
// The bytes of a segment are bounded by its representation's declared bandwidth, which the pipeline defines as the peak of
// bytes x 8 / real duration over all its segments (docs/CONTRACTS.md section 3).
//
// To that transfer time the bound adds a fixed allowance for everything that is not the link: the manifest, the player's work, the
// decode and the first presented frame. Unthrottled, the first frame came 42 to 317 ms after the load in the smoke runs of all five
// engine builds (docs/results/player-smoke), and on a link of 600 kbps the first frame of the runs behind this bound came within 0.1 s
// of the transfer time. 2 s is six times the slowest of those smoke runs: room for a machine shared with other browsers, and still
// well below what the player would cost by not cutting off a start rung the link cannot carry (3 s more in Chromium).

/** Shaka 5.3.3 `abr.advanced.minTotalBytes`: the bytes it must have sampled before it trusts its estimate over its default. */
export const SHAKA_MIN_ESTIMATE_BYTES = 128_000;
/** The throttle grants a response at most 16 kB at a time (src/server/throttle.ts), so a transfer is cut off up to a chunk or two late. */
export const THROTTLE_CHUNK_BYTES = 16 * 1024;
/** The throttle's contract: goodput within 10 % of the configured rate. */
export const LINK_TOLERANCE = 0.1;
/** Initialization segments of video and audio together: 677 + 631 + 677 bytes measured, rounded up. */
export const INIT_SEGMENTS_BYTES = 4096;
/** Everything that is not the link, ms: six times the slowest unthrottled first frame of the smoke runs (317 ms). */
export const STARTUP_OVERHEAD_MS = 2000;

export interface StartupBound {
  /** The most the player may fetch before its first frame, bytes. */
  bytes: number;
  /** What the link needs for them, ms (at the slowest rate the throttle's contract allows). */
  transferMs: number;
  boundMs: number;
  /** The arithmetic in one line, for the message of a failure. */
  summary: string;
}

/** The most bytes a segment of a representation can have: its declared bandwidth over one segment, plus 1 % for audio's real durations. */
function segmentBytesBound(bandwidth: number, segmentDurationSec: number): number {
  return Math.ceil(((bandwidth * segmentDurationSec) / 8) * 1.01);
}

export function startupBound(input: {
  stream: Pick<StreamInfo, 'segmentDurationSec'>;
  ladder: Ladder;
  /** The rung the player started on (the `start` variant change). */
  start: Rung;
  linkKbps: number;
}): StartupBound {
  const { stream, ladder, start, linkKbps } = input;
  const d = stream.segmentDurationSec;
  const audio = segmentBytesBound(ladder.audio.bandwidth, d);
  const lowest = segmentBytesBound(ladder.lowest.videoBandwidth, d);
  const startSegment = segmentBytesBound(start.videoBandwidth, d);
  const abandoned = Math.min(startSegment, SHAKA_MIN_ESTIMATE_BYTES + 2 * THROTTLE_CHUNK_BYTES);
  const video = start.rep === ladder.lowest.rep ? lowest : abandoned + lowest;
  const bytes = video + audio + INIT_SEGMENTS_BYTES;
  const transferMs = Math.ceil(((bytes * 8) / (linkKbps * 1000 * (1 - LINK_TOLERANCE))) * 1000);
  const boundMs = transferMs + STARTUP_OVERHEAD_MS;
  const kb = (n: number): string => `${(n / 1000).toFixed(0)} kB`;
  const summary =
    `started on ${start.height}p: at most ${kb(bytes)} before the first frame ` +
    `(${start.rep === ladder.lowest.rep ? `${ladder.lowest.rep} segment 1 ${kb(lowest)}` : `${kb(abandoned)} of ${start.rep} segment 1 before it is abandoned + ${ladder.lowest.rep} segment 1 ${kb(lowest)}`}` +
    ` + audio ${kb(audio)} + inits ${kb(INIT_SEGMENTS_BYTES)}) at ${linkKbps} kbps less ${LINK_TOLERANCE * 100} % = ` +
    `${(transferMs / 1000).toFixed(1)} s, plus ${(STARTUP_OVERHEAD_MS / 1000).toFixed(0)} s for everything that is not the link`;
  return { bytes, transferMs, boundMs, summary };
}
