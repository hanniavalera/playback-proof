import { describe, expect, it } from 'vitest';
import {
  MAD_TO_SIGMA,
  cv,
  mad,
  maximum,
  mean,
  median,
  minimum,
  p10,
  p90,
  percentile,
  relativeChange,
  robustCv,
  stdDev,
  summarize,
} from '../../../src/lab/measure/stats.ts';

// The numbers below can be checked with R (`quantile(x, p)`, type 7), NumPy (`np.percentile(x, 100 * p)`) or a spreadsheet's PERCENTILE.INC.

const ONE_TO_TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** A small seeded generator (mulberry32): the property tests are random but reproducible. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(random: () => number): number[] {
  const length = 1 + Math.floor(random() * 30);
  // Coarse values on purpose: ties and repeated values are where order statistics go wrong.
  return Array.from({ length }, () => Math.round(random() * 400) / 4 - 20);
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe('PB-PERF stats: the percentile is Hyndman-Fan type 7 (linear interpolation between order statistics)', () => {
  it.each([
    ['p90 of 1..10 sits a tenth of the way from the 9th to the 10th value', ONE_TO_TEN, 0.9, 9.1],
    ['p10 of 1..10', ONE_TO_TEN, 0.1, 1.9],
    ['the median of an even count is the mean of the two middle values', ONE_TO_TEN, 0.5, 5.5],
    ['the median of an odd count is the middle value', [7, 1, 3], 0.5, 3],
    [
      'the quartile lands exactly on an order statistic when (n - 1) q is an integer',
      [5, 1, 4, 2, 3],
      0.25,
      2,
    ],
    ['the upper quartile of the same five values', [5, 1, 4, 2, 3], 0.75, 4],
    ['p90 of two values is nine tenths of the way between them', [10, 20], 0.9, 19],
    ['one value is every percentile', [42], 0.9, 42],
    ['q = 0 is the minimum', [9, 3, 6], 0, 3],
    ['q = 1 is the maximum', [9, 3, 6], 1, 9],
    ['ties interpolate between equal values without drift', [4, 4, 4, 4], 0.9, 4],
  ])('%s', (_name, values, q, expected) => {
    expect(percentile(values, q)).toBeCloseTo(expected, 12);
  });

  it('is not nearest rank: ten runs and q = 0.9 move towards the largest run', () => {
    // Nearest rank would answer 9 whatever the largest run is; type 7 reacts to it by a tenth of the gap (9 + 0.1 x 11).
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeCloseTo(9.1, 12);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 20])).toBeCloseTo(10.1, 12);
  });

  it('has named shortcuts that agree with it', () => {
    expect(median(ONE_TO_TEN)).toBe(percentile(ONE_TO_TEN, 0.5));
    expect(p10(ONE_TO_TEN)).toBe(percentile(ONE_TO_TEN, 0.1));
    expect(p90(ONE_TO_TEN)).toBe(percentile(ONE_TO_TEN, 0.9));
    expect(minimum([3, 1, 2])).toBe(1);
    expect(maximum([3, 1, 2])).toBe(3);
  });

  it('does not reorder or modify its input', () => {
    const input = [3, 1, 2];
    percentile(input, 0.9);
    summarize(input);
    expect(input).toStrictEqual([3, 1, 2]);
  });

  it('refuses what has no answer instead of returning NaN', () => {
    expect(() => percentile([], 0.5)).toThrow(/at least one value/);
    expect(() => percentile([1, Number.NaN], 0.5)).toThrow(/value 1 is not a finite number/);
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 0.5)).toThrow(/finite/);
    expect(() => percentile([1, 2], 1.01)).toThrow(/between 0 and 1/);
    expect(() => percentile([1, 2], -0.01)).toThrow(/between 0 and 1/);
    expect(() => percentile([1, 2], Number.NaN)).toThrow(/between 0 and 1/);
    expect(() => summarize([])).toThrow(/at least one value/);
  });
});

describe('PB-PERF stats: spread', () => {
  it('computes the sample standard deviation (n - 1), not the population one', () => {
    // The classic vector: population sigma is exactly 2, the sample estimate is sqrt(32 / 7).
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
  });

  it('has no standard deviation for one run', () => {
    expect(stdDev([5])).toBeNull();
    expect(cv([5])).toBeNull();
  });

  it('computes the coefficient of variation as sample deviation over mean', () => {
    expect(cv([10, 12, 14])).toBeCloseTo(2 / 12, 12);
    expect(cv([5, 5, 5])).toBe(0);
  });

  it('has no coefficient of variation when the mean is zero (a count that never happened)', () => {
    expect(cv([0, 0, 0])).toBeNull();
    expect(cv([-1, 1])).toBeNull();
  });

  it('computes the MAD around the median, and shows why it is the robust one', () => {
    // Deviations from the median 3 are 2, 1, 0, 1, 97: their median is 1. One wild run does not move it.
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
    expect(mad([6, 6, 6])).toBe(0);
    const outlier = [1, 2, 3, 4, 100];
    expect(cv(outlier) ?? 0).toBeGreaterThan(1.5);
    expect(robustCv(summarize(outlier))).toBeCloseTo((MAD_TO_SIGMA * 1) / 3, 12);
  });

  it('has no robust coefficient of variation for one run or a zero median', () => {
    expect(robustCv(summarize([5]))).toBeNull();
    expect(robustCv(summarize([0, 0, 0, 1]))).toBeNull();
  });

  it('computes the relative change, and says so when it has no meaning', () => {
    expect(relativeChange(110, 100)).toBeCloseTo(0.1, 12);
    expect(relativeChange(90, 100)).toBeCloseTo(-0.1, 12);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(-90, -100)).toBeCloseTo(0.1, 12);
  });
});

describe('PB-PERF stats: summarize', () => {
  it('summarizes ten runs', () => {
    const summary = summarize(ONE_TO_TEN);
    expect(summary).toMatchObject({ n: 10, min: 1, max: 10, mad: 2.5 });
    expect(summary.median).toBeCloseTo(5.5, 12);
    expect(summary.p10).toBeCloseTo(1.9, 12);
    expect(summary.p90).toBeCloseTo(9.1, 12);
    expect(summary.cv).toBeCloseTo(Math.sqrt(82.5 / 9) / 5.5, 12);
  });

  it('summarizes the shortest useful batch', () => {
    const summary = summarize([300, 100, 200]);
    expect(summary.n).toBe(3);
    expect(summary.median).toBeCloseTo(200, 9);
    expect(summary.p10).toBeCloseTo(120, 9);
    expect(summary.p90).toBeCloseTo(280, 9);
    expect([summary.min, summary.max, summary.mad]).toStrictEqual([100, 300, 100]);
    expect(summary.cv).toBeCloseTo(0.5, 12);
  });

  it('summarizes one run without inventing a spread', () => {
    expect(summarize([7])).toStrictEqual({
      n: 1,
      median: 7,
      p10: 7,
      p90: 7,
      min: 7,
      max: 7,
      mad: 0,
      cv: null,
    });
  });

  it('summarizes zeros: the usual baseline of a rebuffer count', () => {
    expect(summarize([0, 0, 0, 0])).toStrictEqual({
      n: 4,
      median: 0,
      p10: 0,
      p90: 0,
      min: 0,
      max: 0,
      mad: 0,
      cv: null,
    });
  });
});

describe('PB-PERF stats: invariants over random vectors', () => {
  const CASES = 300;

  it('does not depend on the order of the runs', () => {
    const random = generator(1);
    for (let i = 0; i < CASES; i++) {
      const values = randomVector(random);
      const a = summarize(values);
      const b = summarize(shuffled(values, random));
      expect({ ...b, cv: undefined }).toStrictEqual({ ...a, cv: undefined });
      if (a.cv === null) expect(b.cv).toBeNull();
      else expect(b.cv).toBeCloseTo(a.cv, 9);
    }
  });

  it('moves with a constant shift: percentiles shift, spread does not', () => {
    const random = generator(2);
    for (let i = 0; i < CASES; i++) {
      const values = randomVector(random);
      const shift = Math.round(random() * 1000 - 500) / 4;
      const moved = values.map((value) => value + shift);
      const a = summarize(values);
      const b = summarize(moved);
      for (const key of ['median', 'p10', 'p90', 'min', 'max'] as const) {
        expect(b[key], key).toBeCloseTo(a[key] + shift, 9);
      }
      expect(b.mad).toBeCloseTo(a.mad, 9);
      const spreadA = stdDev(values);
      const spreadB = stdDev(moved);
      if (spreadA === null) expect(spreadB).toBeNull();
      else expect(spreadB).toBeCloseTo(spreadA, 8);
    }
  });

  it('scales with a positive factor: percentiles and spread scale, the coefficient of variation does not', () => {
    const random = generator(3);
    for (let i = 0; i < CASES; i++) {
      const values = randomVector(random).map((value) => Math.abs(value) + 1);
      const factor = 0.5 + random() * 4;
      const a = summarize(values);
      const b = summarize(values.map((value) => value * factor));
      for (const key of ['median', 'p10', 'p90', 'min', 'max', 'mad'] as const) {
        expect(b[key], key).toBeCloseTo(a[key] * factor, 9);
      }
      if (a.cv === null) expect(b.cv).toBeNull();
      else expect(b.cv).toBeCloseTo(a.cv, 9);
    }
  });

  it('mirrors under negation: the p10 of the negated runs is minus the p90', () => {
    const random = generator(4);
    for (let i = 0; i < CASES; i++) {
      const values = randomVector(random);
      expect(p10(values.map((value) => -value))).toBeCloseTo(-p90(values), 9);
    }
  });

  it('keeps its order: min <= p10 <= median <= p90 <= max, and the percentile never falls as q rises', () => {
    const random = generator(5);
    for (let i = 0; i < CASES; i++) {
      const values = randomVector(random);
      const s = summarize(values);
      expect(s.min).toBeLessThanOrEqual(s.p10);
      expect(s.p10).toBeLessThanOrEqual(s.median);
      expect(s.median).toBeLessThanOrEqual(s.p90);
      expect(s.p90).toBeLessThanOrEqual(s.max);
      const [q1, q2] = [random(), random()].sort((a, b) => a - b) as [number, number];
      expect(percentile(values, q1)).toBeLessThanOrEqual(percentile(values, q2) + 1e-12);
    }
  });
});
