import { describe, expect, it } from 'vitest';
import { GONE_MARGIN_SEGMENTS } from '../../../src/server/constants.ts';
import { availability, freeEdge, liveView, stallStartMs } from '../../../src/server/liveclock.ts';
import type { LiveParams, LiveStall } from '../../../src/server/liveclock.ts';

// Stream time 0 is wall-clock 0 here, so "t" below is both: segment n is published at 2000 * n ms.
const P: LiveParams = {
  availabilityStartMs: 0,
  segmentDurationMs: 2000,
  windowSegments: 15,
  presentationDelaySec: 6,
};

const stall = (atNumber: number, ms: number, installedAtMs: number, ruleId = `s${atNumber}`): LiveStall => ({
  ruleId,
  atNumber,
  ms,
  installedAtMs,
});

describe('the free-running edge', () => {
  it('is floor((t - AST) / d): a segment is published exactly at AST + n*d', () => {
    expect(freeEdge(P, 30_000)).toBe(15); // the defaults: 30 s on air at creation
    expect(freeEdge(P, 31_999)).toBe(15);
    expect(freeEdge(P, 32_000)).toBe(16);
  });

  it('is 0 before the first segment is published, never negative', () => {
    expect(freeEdge(P, 1999)).toBe(0);
    expect(freeEdge(P, -50_000)).toBe(0);
  });
});

describe('the manifest window', () => {
  it('lists [edge - 14, edge] with the 15 segments of the default DVR window, and the publication instant of the edge segment', () => {
    const view = liveView(P, [], 40_500);
    expect(view).toEqual({ edge: 20, firstNumber: 6, lastNumber: 20, publishTimeMs: 40_000, stalled: false });
  });

  it('starts at segment 1 while the stream is younger than the window', () => {
    const view = liveView(P, [], 10_000);
    expect(view.firstNumber).toBe(1);
    expect(view.lastNumber).toBe(5);
  });

  it('slides by one segment every 2 s', () => {
    const before = liveView(P, [], 41_999);
    const after = liveView(P, [], 42_000);
    expect(after.firstNumber - before.firstNumber).toBe(1);
    expect(after.lastNumber - before.lastNumber).toBe(1);
  });
});

describe('segment availability', () => {
  const view = liveView(P, [], 40_000); // edge 20, window 6..20

  it('404s a segment that is not published yet', () => {
    expect(availability(view, 21)).toBe('not-yet');
    expect(availability(view, 20)).toBe('available');
  });

  it('serves a segment up to GONE_MARGIN_SEGMENTS older than the window, and 404s older ones (gone)', () => {
    const oldestServed = view.firstNumber - GONE_MARGIN_SEGMENTS;
    expect(availability(view, oldestServed)).toBe('available');
    expect(availability(view, oldestServed - 1)).toBe('gone');
    expect(availability(view, 1)).toBe('gone');
  });

  it('treats a number that cannot be a segment as not available', () => {
    expect(availability(view, 0)).toBe('not-yet');
    expect(availability(view, -3)).toBe('not-yet');
    expect(availability(view, 2.5)).toBe('not-yet');
  });
});

describe('live-stall', () => {
  // Installed at t = 30 s (edge 15), the origin stops at segment 18 (published at 36 s) for 10 s.
  const stalls = [stall(18, 10_000, 30_000)];

  it('starts when segment atNumber would be published and not before', () => {
    expect(stallStartMs(P, stalls[0]!)).toBe(36_000);
    expect(liveView(P, stalls, 35_999)).toMatchObject({ edge: 17, stalled: false });
    expect(liveView(P, stalls, 36_000)).toMatchObject({ edge: 18, stalled: true });
  });

  it('freezes the edge, the window and the manifest publish time for the whole stall', () => {
    const frozen = liveView(P, stalls, 36_000);
    for (const t of [38_000, 41_000, 45_999]) {
      expect(liveView(P, stalls, t)).toEqual(frozen);
    }
    expect(frozen.publishTimeMs).toBe(36_000);
    expect(availability(liveView(P, stalls, 41_000), 19)).toBe('not-yet');
  });

  it('catches up when it ends: the edge jumps to the free-running one, timeline unchanged', () => {
    expect(liveView(P, stalls, 46_000)).toMatchObject({ edge: 23, stalled: false });
    // every segment that was missing during the stall exists now, with its normal number
    expect(availability(liveView(P, stalls, 46_000), 19)).toBe('available');
    expect(availability(liveView(P, stalls, 46_000), 23)).toBe('available');
  });

  it('starts now when it is installed after segment atNumber was published', () => {
    const late = [stall(5, 6000, 40_000)]; // segment 5 was published at 10 s
    expect(stallStartMs(P, late[0]!)).toBe(40_000);
    expect(liveView(P, late, 43_000)).toMatchObject({ edge: 20, stalled: true });
    expect(liveView(P, late, 46_000)).toMatchObject({ edge: 23, stalled: false });
  });

  it('keeps the earliest freeze when stalls overlap, and the edge never moves backwards', () => {
    const overlap = [stall(18, 10_000, 30_000, 'a'), stall(20, 20_000, 30_000, 'b')]; // a: 36-46 s at 18; b: 40-60 s at 20
    expect(liveView(P, overlap, 41_000).edge).toBe(18);
    expect(liveView(P, overlap, 47_000).edge).toBe(20);
    expect(liveView(P, overlap, 60_000).edge).toBe(30);
  });

  it('never publishes beyond the free-running edge and never unpublishes (random stalls, sampled every 250 ms)', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let run = 0; run < 25; run++) {
      const many: LiveStall[] = [];
      for (let i = 0; i < 4; i++) {
        many.push(
          stall(
            1 + Math.floor(random() * 60),
            1000 + Math.floor(random() * 30_000),
            Math.floor(random() * 60_000),
            `r${i}`,
          ),
        );
      }
      let previous = 0;
      for (let t = 0; t <= 200_000; t += 250) {
        const view = liveView(P, many, t);
        expect(view.edge).toBeLessThanOrEqual(freeEdge(P, t));
        expect(view.edge).toBeGreaterThanOrEqual(previous);
        previous = view.edge;
      }
    }
  });
});
