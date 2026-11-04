import { describe, expect, it } from 'vitest';
import type { RepInfo } from '../../../src/shared/streams.ts';
import { bestRungCarriedBy, ladderOf, rungOf, rungsCarriedBy } from '../../../tests/e2e/abr/ladder.ts';
import { SHAKA_MIN_ESTIMATE_BYTES, startupBound } from '../../../tests/e2e/abr/startup.ts';

// The arithmetic the ABR specs derive their expectations from. The numbers are the declared bandwidths of the generated `vod-cmaf`
// (GET /api/streams): 305000, 709900 and 1808424 bps of video, 36878 of audio.

function rep(id: string, track: 'video' | 'audio', bandwidth: number, height?: number): RepInfo {
  return {
    id,
    track,
    mimeType: track === 'video' ? 'video/mp4' : 'audio/mp4',
    codecs: track === 'video' ? 'vp09.00.21.08' : 'mp4a.40.2',
    bandwidth,
    ...(height === undefined ? {} : { height }),
    initExt: 'mp4',
    segmentExt: 'm4s',
  };
}

const vodCmaf = {
  id: 'vod-cmaf' as const,
  segmentDurationSec: 2,
  // Deliberately out of order: the ladder must sort by bandwidth, not trust the catalog's order.
  reps: [
    rep('v720', 'video', 1_808_424, 720),
    rep('a-aac', 'audio', 36_878),
    rep('v240', 'video', 305_000, 240),
    rep('v360', 'video', 709_900, 360),
  ],
};

describe('ladderOf', () => {
  it('lists the video rungs from the lowest to the top, each with what its variant declares (video plus audio)', () => {
    const ladder = ladderOf(vodCmaf);
    expect(ladder.rungs.map((r) => [r.rep, r.height, r.variantBandwidth])).toEqual([
      ['v240', 240, 341_878],
      ['v360', 360, 746_778],
      ['v720', 720, 1_845_302],
    ]);
    expect(ladder.lowest.rep).toBe('v240');
    expect(ladder.top.rep).toBe('v720');
    expect(ladder.audio.id).toBe('a-aac');
  });

  it('refuses a stream that cannot be adaptive: no audio, no height, or a single rung', () => {
    expect(() => ladderOf({ id: 'vod-cmaf', reps: [rep('v240', 'video', 305_000, 240)] })).toThrow(
      /no audio/,
    );
    expect(() =>
      ladderOf({ id: 'vod-cmaf', reps: [rep('v240', 'video', 305_000), rep('a-aac', 'audio', 36_878)] }),
    ).toThrow(/no height/);
    expect(() =>
      ladderOf({ id: 'vod-cmaf', reps: [rep('v240', 'video', 305_000, 240), rep('a-aac', 'audio', 36_878)] }),
    ).toThrow(/at least two video rungs/);
  });
});

describe('what a link carries (the arithmetic of the profiles in src/shared/profiles.ts)', () => {
  const ladder = ladderOf(vodCmaf);

  it('600 kbps carries 240p only: 360p needs 764 kbps with its audio', () => {
    expect(rungsCarriedBy(ladder, 600).map((r) => r.rep)).toEqual(['v240']);
    expect(bestRungCarriedBy(ladder, 600).rep).toBe('v240');
  });

  it('1500 kbps carries 360p and not 720p; 6000 kbps carries the whole ladder', () => {
    expect(bestRungCarriedBy(ladder, 1500).rep).toBe('v360');
    expect(rungsCarriedBy(ladder, 6000).map((r) => r.rep)).toEqual(['v240', 'v360', 'v720']);
  });

  it('is exact at the boundary and refuses a link that carries nothing', () => {
    expect(bestRungCarriedBy(ladder, 342).rep).toBe('v240'); // 342,000 bps against the 341,878 the 240p variant declares
    expect(() => bestRungCarriedBy(ladder, 341)).toThrow(/carries no rung/);
  });
});

describe('rungOf', () => {
  it('finds a rung by representation or by height, and says what the ladder has when there is none', () => {
    const ladder = ladderOf(vodCmaf);
    expect(rungOf(ladder, { rep: 'v360' }).height).toBe(360);
    expect(rungOf(ladder, { height: 720 }).rep).toBe('v720');
    expect(() => rungOf(ladder, { height: 480 })).toThrow(/v240 \(240p\), v360 \(360p\), v720 \(720p\)/);
  });
});

describe('startupBound: the first frame on a 600 kbps link', () => {
  const ladder = ladderOf(vodCmaf);
  const bound = (start: string, linkKbps = 600) =>
    startupBound({ stream: vodCmaf, ladder, start: rungOf(ladder, { rep: start }), linkKbps });

  it('counts, for a start the link cannot carry, what is fetched before Shaka can know and then the lowest rung', () => {
    const b = bound('v720');
    // 128 kB sampled + two 16 kB chunks of the throttle, then 240p segment 1 (+1 %), the audio's, and the initialization segments.
    const lowest = Math.ceil(((305_000 * 2) / 8) * 1.01);
    const audio = Math.ceil(((36_878 * 2) / 8) * 1.01);
    expect(b.bytes).toBe(SHAKA_MIN_ESTIMATE_BYTES + 2 * 16 * 1024 + lowest + audio + 4096);
    // 600 kbps less the throttle's 10 % tolerance, plus 2 s for everything that is not the link.
    expect(b.transferMs).toBe(Math.ceil(((b.bytes * 8) / (600_000 * 0.9)) * 1000));
    expect(b.boundMs).toBe(b.transferMs + 2000);
    expect(b.boundMs).toBeGreaterThan(5000);
    expect(b.boundMs).toBeLessThan(6000);
  });

  it('is the same for 360p, whose first segment (177 kB) is also cut off after the same sampling', () => {
    expect(bound('v360').bytes).toBe(bound('v720').bytes);
  });

  it('is a third for a start on the lowest rung, which needs no cut-off, and grows as the link slows', () => {
    expect(bound('v240').bytes).toBeLessThan(bound('v720').bytes / 2);
    expect(bound('v720', 300).transferMs).toBeCloseTo(bound('v720', 600).transferMs * 2, -1);
  });

  it('says in words what it counted, for the message of a failure', () => {
    expect(bound('v720').summary).toMatch(
      /started on 720p: at most 25\d kB before the first frame \(161 kB of v720 segment 1 before it is abandoned \+ v240 segment 1 77 kB \+ audio 9 kB/,
    );
  });
});
