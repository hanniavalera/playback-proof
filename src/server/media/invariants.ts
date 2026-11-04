// The invariants a StreamIndex must satisfy, as a checker that returns the list of violations (empty = fine). The generator runs it on
// what it just wrote, the media store runs it on what it loads, the unit tests run it on hand-made broken indexes, and
// tools/verify-streams.ts runs it again next to ffprobe. docs/CONTRACTS.md section 3 and types.ts define each rule.

import type { RepIndex, StreamIndex } from './types.ts';

export interface IndexCheckOptions {
  /** Longest audio frame in seconds (1024 / 48000 for AAC). VOD audio may be shorter than the video by less than one frame. */
  audioFrameSec?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
export const AAC_FRAME_SEC = 1024 / 48_000;

function checkRep(r: RepIndex, segmentCount: number, out: string[]): void {
  const id = r.rep.id;
  if (!Number.isSafeInteger(r.timescale) || r.timescale < 1)
    out.push(`${id}: invalid timescale ${r.timescale}`);
  if (r.segments.length !== segmentCount)
    out.push(`${id}: ${r.segments.length} segments, expected ${segmentCount}`);
  let expectedStart = 0;
  r.segments.forEach((s, i) => {
    if (s.number !== i + 1) out.push(`${id}: segment at position ${i + 1} is numbered ${s.number}`);
    if (!Number.isSafeInteger(s.start) || s.start < 0)
      out.push(`${id}/${s.number}: invalid start ${s.start}`);
    if (!Number.isSafeInteger(s.duration) || s.duration < 1)
      out.push(`${id}/${s.number}: invalid duration ${s.duration}`);
    if (!Number.isSafeInteger(s.bytes) || s.bytes < 1) out.push(`${id}/${s.number}: invalid size ${s.bytes}`);
    if (!SHA256.test(s.sha256)) out.push(`${id}/${s.number}: invalid sha256`);
    // Gapless and overlap-free: every segment starts exactly where the previous one ended, the first one at 0.
    if (s.start !== expectedStart)
      out.push(`${id}/${s.number}: starts at ${s.start}, expected ${expectedStart} (gap or overlap)`);
    expectedStart = s.start + s.duration;
  });
  if (r.loopTicks !== expectedStart)
    out.push(`${id}: loopTicks ${r.loopTicks} is not the sum of the segment durations ${expectedStart}`);
}

export function checkStreamIndex(index: StreamIndex, options: IndexCheckOptions = {}): string[] {
  const out: string[] = [];
  const { info, reps } = index;
  const frameSec = options.audioFrameSec ?? AAC_FRAME_SEC;
  if (reps.length !== info.reps.length || reps.some((r, i) => r.rep.id !== info.reps[i]?.id)) {
    out.push('index.reps and info.reps list different representations');
  }
  if (!(info.segmentCount >= 1)) out.push(`invalid segmentCount ${info.segmentCount}`);
  for (const r of reps) checkRep(r, info.segmentCount, out);

  const video = reps.filter((r) => r.rep.track === 'video');
  const audio = reps.filter((r) => r.rep.track === 'audio');
  const ref = video[0];
  if (!ref) {
    out.push('no video representation');
    return out;
  }
  // All rungs share one timeline: identical timescale, segment starts and durations, so that switching rungs is seamless.
  for (const r of video.slice(1)) {
    if (r.timescale !== ref.timescale)
      out.push(`${r.rep.id}: timescale ${r.timescale} differs from ${ref.rep.id} (${ref.timescale})`);
    r.segments.forEach((s, i) => {
      const o = ref.segments[i];
      if (o && (s.start !== o.start || s.duration !== o.duration)) {
        out.push(
          `${r.rep.id}/${s.number}: ${s.start}+${s.duration} differs from ${ref.rep.id} ${o.start}+${o.duration} (rungs are not aligned)`,
        );
      }
    });
  }
  const videoSec = ref.loopTicks / ref.timescale;
  if (Math.abs(info.durationSec - videoSec) > 1e-9)
    out.push(`durationSec ${info.durationSec} is not the video duration ${videoSec}`);
  ref.segments.forEach((s) => {
    if (s.duration !== info.segmentDurationSec * ref.timescale) {
      out.push(
        `${ref.rep.id}/${s.number}: video segment lasts ${s.duration / ref.timescale} s, not ${info.segmentDurationSec} s`,
      );
    }
  });
  for (const a of audio) {
    const audioSec = a.loopTicks / a.timescale;
    if (info.kind === 'live') {
      // The loop invariant, exact to the tick (integer cross-multiplication, no floating point): audio and video of one loop have
      // the same length, so a live loop cannot drift one against the other however many times it repeats.
      if (a.loopTicks * ref.timescale !== ref.loopTicks * a.timescale) {
        out.push(
          `${a.rep.id}: loop is ${a.loopTicks}/${a.timescale} s but video is ${ref.loopTicks}/${ref.timescale} s (live loops must be equal to the tick)`,
        );
      }
    } else if (!(audioSec <= videoSec + 1e-9 && videoSec - audioSec < frameSec)) {
      out.push(
        `${a.rep.id}: duration ${audioSec} s is not within one frame (${frameSec} s) below the video ${videoSec} s`,
      );
    }
    a.segments.forEach((s) => {
      if (Math.abs(s.duration / a.timescale - info.segmentDurationSec) >= frameSec) {
        out.push(
          `${a.rep.id}/${s.number}: lasts ${s.duration / a.timescale} s, more than one frame away from ${info.segmentDurationSec} s`,
        );
      }
    });
  }
  return out;
}
