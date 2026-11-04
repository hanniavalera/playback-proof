import { describe, expect, it } from 'vitest';
import { fitLine, perHour, pooledSlope, quartileShift } from '../../../src/lab/readiness/regression.ts';
import type { Point } from '../../../src/lab/readiness/regression.ts';
import { mulberry32, normal } from './random.ts';

// The least-squares helpers behind the soak's drift and heap trends. The cases are the ones where a wrong answer would turn a verdict:
// the sign of the slope, a high flat level read as a trend, a step read as a slope, and noise flipping a verdict.

const T0 = 1_760_000_000_000; // an epoch in ms: the real x of a soak, 1.7e12, where an uncentred sum of squares has lost its digits
const line = (n: number, stepMs: number, level: number, slopePerHour: number, noise: () => number): Point[] =>
  Array.from({ length: n }, (_, i) => ({
    x: T0 + i * stepMs,
    y: level + (slopePerHour * (i * stepMs)) / 3_600_000 + noise(),
  }));
const exact = (): number => 0;

describe('fitLine', () => {
  it('recovers a known line exactly, with the intercept at the first x and not at x = 0', () => {
    const fit = fitLine(line(40, 5000, 6000, 1800, exact));
    expect(fit).not.toBeNull();
    expect(perHour(fit?.slope ?? 0)).toBeCloseTo(1800, 6);
    expect(fit?.intercept).toBeCloseTo(6000, 6);
    expect(fit?.firstX).toBe(T0);
    expect(fit?.r2).toBeCloseTo(1, 12);
    expect(fit?.residualSd).toBeCloseTo(0, 6);
  });

  it('gives the slope the sign of the trend: positive when latency grows, negative when it shrinks', () => {
    expect(perHour(fitLine(line(30, 5000, 6200, +3000, exact))?.slope ?? 0)).toBeCloseTo(3000, 6);
    expect(perHour(fitLine(line(30, 5000, 6200, -3000, exact))?.slope ?? 0)).toBeCloseTo(-3000, 6);
  });

  it('reads a high but flat series as level, not as drift: the slope is zero and the intercept carries the 10.1 s', () => {
    const fit = fitLine(line(60, 5000, 10_100, 0, exact));
    expect(fit?.slope).toBeCloseTo(0, 12);
    expect(fit?.intercept).toBeCloseTo(10_100, 6);
    expect(fit?.r2).toBeNull();
  });

  it('cannot fit fewer than two points, or points that share one x', () => {
    expect(fitLine([])).toBeNull();
    expect(fitLine([{ x: 1, y: 1 }])).toBeNull();
    expect(
      fitLine([
        { x: 5, y: 1 },
        { x: 5, y: 9 },
      ]),
    ).toBeNull();
  });

  it('reports no residual scatter from two points, which a line fits exactly whatever they are', () => {
    const fit = fitLine([
      { x: 0, y: 1 },
      { x: 10, y: 5 },
    ]);
    expect(fit?.slope).toBeCloseTo(0.4, 12);
    expect(fit?.residualSd).toBeNull();
  });

  it('is stable under noise: the same verdict for 300 different seeds, a flat series and a drifting one', () => {
    // 5 minutes after the warm-up, one read every 5 s, 100 ms of scatter: the standard error of the fitted change over the window is
    // about 45 ms, so a 1 s limit is 20 standard errors away and the verdict must not depend on the seed.
    const spanMs = 59 * 5000;
    const verdicts = { flat: 0, drifting: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const random = normal(mulberry32(seed), 100);
      const flat = fitLine(line(60, 5000, 6200, 0, random));
      const drifting = fitLine(line(60, 5000, 6200, 3 * 1000 * (3_600_000 / spanMs), random)); // +3 s over the window
      if (Math.abs((flat?.slope ?? 0) * spanMs) <= 1000) verdicts.flat += 1;
      if (Math.abs((drifting?.slope ?? 0) * spanMs) > 1000) verdicts.drifting += 1;
    }
    expect(verdicts).toEqual({ flat: 300, drifting: 300 });
  });
});

describe('pooledSlope', () => {
  const segment = (from: number, n: number, level: number, slopePerHour: number): Point[] =>
    Array.from({ length: n }, (_, i) => ({
      x: T0 + (from + i) * 5000,
      y: level + (slopePerHour * ((from + i) * 5000)) / 3_600_000,
    }));

  it('finds the slope of both sides of an outage and ignores the step the outage left', () => {
    // 6.2 s before the outage, 10.1 s after it, the same slope of +600 ms/h on both sides.
    const before = segment(0, 20, 6200, 600);
    const after = segment(40, 20, 10_100 - 600 * ((40 * 5000) / 3_600_000), 600);
    const pooled = pooledSlope([before, after]);
    expect(perHour(pooled?.slope ?? 0)).toBeCloseTo(600, 6);
    expect(pooled?.segments).toHaveLength(2);
    expect(pooled?.segments[0]?.intercept).toBeCloseTo(6200, 6);
    expect(pooled?.segments[1]?.intercept).toBeCloseTo(10_100, 6);

    // One line through both would call the step a drift: this is the reason for the pooling.
    const naive = fitLine([...before, ...after]);
    expect(perHour(naive?.slope ?? 0)).toBeGreaterThan(5000);
  });

  it('is flat when every stretch is flat, whatever their levels', () => {
    const pooled = pooledSlope([segment(0, 20, 6200, 0), segment(40, 20, 10_100, 0)]);
    expect(Math.abs(perHour(pooled?.slope ?? 1))).toBeLessThan(1e-6);
  });

  it('skips a stretch that cannot give a slope, and gives up when none can', () => {
    const lone: Point[] = [{ x: T0, y: 5 }];
    const pooled = pooledSlope([lone, segment(0, 10, 6000, 1200)]);
    expect(pooled?.segments).toHaveLength(1);
    expect(perHour(pooled?.slope ?? 0)).toBeCloseTo(1200, 6);
    expect(pooledSlope([lone, []])).toBeNull();
  });
});

describe('quartileShift', () => {
  it('is the median of the last quarter minus the median of the first quarter', () => {
    expect(quartileShift([1, 1, 1, 1, 5, 5, 5, 5])).toBe(4);
    expect(quartileShift([5, 5, 5, 5, 1, 1, 1, 1])).toBe(-4);
  });
  it('is not defined below eight points: a quarter would be one sample', () => {
    expect(quartileShift([1, 2, 3, 4, 5, 6, 7])).toBeNull();
  });
});
