import { describe, expect, it } from 'vitest';
import { checkStreamIndex } from '../../../src/server/media/invariants.ts';
import type { StreamIndex } from '../../../src/server/media/types.ts';
import { syntheticIndex } from './support/support.ts';

/** A deep copy that the test can damage without touching the next test's input. */
const clone = (i: StreamIndex): StreamIndex => JSON.parse(JSON.stringify(i)) as StreamIndex;

describe('checkStreamIndex', () => {
  it('accepts a VOD index and a live index built by the rules', () => {
    expect(checkStreamIndex(syntheticIndex({ segmentCount: 30 }))).toEqual([]);
    expect(checkStreamIndex(syntheticIndex({ segmentCount: 6 }))).toEqual([]);
    expect(checkStreamIndex(syntheticIndex({ kind: 'live', segmentCount: 12 }))).toEqual([]);
    expect(
      checkStreamIndex(syntheticIndex({ packaging: 'webm', segmentCount: 15 }), { audioFrameSec: 0.02 }),
    ).toEqual([]);
  });

  it('flags a gap between segments', () => {
    const i = clone(syntheticIndex());
    (i.reps[0]?.segments[2] as { start: number }).start += 512;
    expect(checkStreamIndex(i).join('\n')).toMatch(/v240\/3: starts at \d+, expected \d+ \(gap or overlap\)/);
  });

  it('flags an overlap between segments', () => {
    const i = clone(syntheticIndex());
    (i.reps[3]?.segments[1] as { start: number }).start -= 1024;
    expect(checkStreamIndex(i).join('\n')).toMatch(/a-aac\/2: starts at .* \(gap or overlap\)/);
  });

  it('flags rungs that are not aligned with each other', () => {
    const i = clone(syntheticIndex());
    const seg = i.reps[1]?.segments[3] as { duration: number };
    seg.duration += 512;
    const problems = checkStreamIndex(i).join('\n');
    expect(problems).toMatch(/v360\/4/);
  });

  it('flags a loop whose audio and video differ by even one tick', () => {
    const i = clone(syntheticIndex({ kind: 'live', segmentCount: 12 }));
    const audio = i.reps[3];
    if (!audio) throw new Error('no audio');
    (audio.segments[11] as { duration: number }).duration += 1;
    audio.loopTicks += 1;
    expect(checkStreamIndex(i).join('\n')).toMatch(/live loops must be equal to the tick/);
  });

  it('allows VOD audio to end up to one frame before the video, but not after it or further before', () => {
    const shorter = clone(syntheticIndex({ segmentCount: 6 }));
    expect(checkStreamIndex(shorter)).toEqual([]);
    const audio = shorter.reps[3];
    if (!audio) throw new Error('no audio');
    // 563 frames instead of 562: 10.7 ms past the 12 s video
    const last = audio.segments[5] as { duration: number };
    last.duration += 1024;
    audio.loopTicks += 1024;
    expect(checkStreamIndex(shorter).join('\n')).toMatch(/not within one frame/);
  });

  it('flags a durationSec that is not the video duration, a bad hash and a wrong loopTicks', () => {
    const a = clone(syntheticIndex());
    a.info.durationSec = 13;
    expect(checkStreamIndex(a).join('\n')).toMatch(/durationSec 13/);
    const b = clone(syntheticIndex());
    (b.reps[0]?.segments[0] as { sha256: string }).sha256 = 'xyz';
    expect(checkStreamIndex(b).join('\n')).toMatch(/invalid sha256/);
    const c = clone(syntheticIndex());
    (c.reps[2] as { loopTicks: number }).loopTicks += 5;
    expect(checkStreamIndex(c).join('\n')).toMatch(/loopTicks .* is not the sum/);
  });

  it('flags a video segment that is not the nominal length and a missing segment', () => {
    const a = clone(syntheticIndex());
    for (const r of a.reps.filter((x) => x.rep.track === 'video')) {
      const s = r.segments[1] as { duration: number };
      s.duration = 30_000;
    }
    expect(checkStreamIndex(a).length).toBeGreaterThan(0);
    const b = clone(syntheticIndex());
    b.reps[0]?.segments.pop();
    expect(checkStreamIndex(b).join('\n')).toMatch(/5 segments, expected 6/);
  });
});
