import { describe, expect, it } from 'vitest';
import { percentile } from '../../../src/lab/measure/stats.ts';
import { cliffsDelta, cliffsLabel } from '../../../ab/stats/cliffs-delta.ts';
import { bootstrapHodgesLehmann, hodgesLehmann, selectInPlace } from '../../../ab/stats/hodges-lehmann.ts';
import { mannWhitneyU } from '../../../ab/stats/mann-whitney.ts';
import { quantileSorted } from '../../../ab/stats/sample.ts';
import { coarse, gaussian, generator, shuffled } from './helpers.ts';

// Effect sizes: the Hodges-Lehmann shift (checked against a full sort of every pairwise difference), its seeded bootstrap interval
// (reproducibility, exact equivariances, nesting of levels, coverage) and Cliff's delta (against the definition and against U).

/** The median of every pairwise difference b - a, by sorting them all: the definition, with no selection algorithm. */
function referenceShift(a: readonly number[], b: readonly number[]): number {
  const differences: number[] = [];
  for (const x of a) for (const y of b) differences.push(y - x);
  differences.sort((p, q) => p - q);
  const middle = differences.length / 2;
  return differences.length % 2 === 1
    ? (differences[(differences.length - 1) / 2] as number)
    : ((differences[middle - 1] as number) + (differences[middle] as number)) / 2;
}

describe('PB-AB selection of an order statistic', () => {
  it('returns the k-th smallest for every k, on random arrays with many ties', () => {
    const random = generator(1);
    for (let trial = 0; trial < 60; trial++) {
      const values = coarse(random, 1 + Math.floor(random() * 60), 1 + Math.floor(random() * 12));
      const sorted = [...values].sort((x, y) => x - y);
      for (let k = 0; k < values.length; k++) {
        const copy = Float64Array.from(values);
        expect(selectInPlace(copy, k)).toBe(sorted[k]);
        // The partition guarantee the median code leans on: nothing after k is smaller than the answer.
        for (let t = k + 1; t < copy.length; t++)
          expect(copy[t] as number).toBeGreaterThanOrEqual(sorted[k] as number);
        for (let t = 0; t < k; t++) expect(copy[t] as number).toBeLessThanOrEqual(sorted[k] as number);
      }
    }
  });

  it('works on sorted, reversed and constant arrays, and on a prefix of a longer buffer', () => {
    const ascending = Float64Array.from({ length: 200 }, (_, i) => i);
    expect(selectInPlace(Float64Array.from(ascending), 100)).toBe(100);
    expect(selectInPlace(Float64Array.from([...ascending].reverse()), 37)).toBe(37);
    expect(selectInPlace(new Float64Array(50).fill(3), 25)).toBe(3);
    const buffer = Float64Array.from([9, 1, 8, 2, 7, 3, 100, 100, 100]);
    expect(selectInPlace(buffer, 2, 6)).toBe(3);
  });

  it('refuses an index outside the array', () => {
    expect(() => selectInPlace(new Float64Array(3), 3)).toThrow(RangeError);
    expect(() => selectInPlace(new Float64Array(3), -1)).toThrow(RangeError);
    expect(() => selectInPlace(new Float64Array(3), 1.5)).toThrow(RangeError);
  });
});

describe('PB-AB Hodges-Lehmann shift', () => {
  it('is the median of all pairwise differences b - a: two worked examples', () => {
    // differences of [1,2,3] and [2,3,4]: 1 0 -1 / 2 1 0 / 3 2 1 -> sorted -1 0 0 1 1 1 2 2 3 -> 1
    expect(hodgesLehmann([1, 2, 3], [2, 3, 4])).toBe(1);
    // differences of [1,2] and [1,5,9]: 0 4 8 / -1 3 7 -> sorted -1 0 3 4 7 8 -> (3 + 4) / 2
    expect(hodgesLehmann([1, 2], [1, 5, 9])).toBe(3.5);
  });

  it('agrees with the full sort of every difference on 150 random samples (odd and even counts, with ties)', () => {
    const random = generator(2);
    for (let trial = 0; trial < 150; trial++) {
      const a =
        trial % 2 === 0
          ? coarse(random, 1 + Math.floor(random() * 15), 8)
          : gaussian(random, 1 + Math.floor(random() * 15));
      const b =
        trial % 2 === 0
          ? coarse(random, 1 + Math.floor(random() * 15), 8)
          : gaussian(random, 1 + Math.floor(random() * 15), 0.7);
      expect(hodgesLehmann(a, b)).toBeCloseTo(referenceShift(a, b), 12);
    }
  });

  it('moves with the data: a shift of B by c moves it by c, a scale by k scales it, swapping the arms negates it', () => {
    const random = generator(3);
    const a = gaussian(random, 20, 100, 15);
    const b = gaussian(random, 25, 130, 20);
    const shift = hodgesLehmann(a, b);
    expect(
      hodgesLehmann(
        a,
        b.map((x) => x + 42),
      ),
    ).toBeCloseTo(shift + 42, 9);
    expect(
      hodgesLehmann(
        a.map((x) => x + 42),
        b.map((x) => x + 42),
      ),
    ).toBeCloseTo(shift, 9);
    expect(
      hodgesLehmann(
        a.map((x) => x * 3),
        b.map((x) => x * 3),
      ),
    ).toBeCloseTo(shift * 3, 9);
    expect(hodgesLehmann(b, a)).toBeCloseTo(-shift, 12);
    expect(hodgesLehmann(shuffled(a, random), shuffled(b, random))).toBe(shift);
  });

  it('is zero for an arm against itself and for constant data, and the one difference for one session each', () => {
    expect(hodgesLehmann([4, 8, 15, 16, 23, 42], [4, 8, 15, 16, 23, 42])).toBe(0);
    expect(hodgesLehmann([5, 5, 5], [5, 5])).toBe(0);
    expect(hodgesLehmann([3], [10])).toBe(7);
  });

  it('is not moved by one extreme session, where the difference of means is', () => {
    const a = [100, 102, 98, 101, 99, 103, 97, 100, 101, 99];
    const b = [110, 112, 108, 111, 109, 113, 107, 110, 111, 5000];
    const meanShift = b.reduce((s, x) => s + x, 0) / b.length - a.reduce((s, x) => s + x, 0) / a.length;
    expect(hodgesLehmann(a, b)).toBeGreaterThan(9);
    expect(hodgesLehmann(a, b)).toBeLessThan(12);
    expect(meanShift).toBeGreaterThan(400);
  });

  it('refuses what is not a sample', () => {
    expect(() => hodgesLehmann([], [1])).toThrow(RangeError);
    expect(() => hodgesLehmann([1], [Number.NaN])).toThrow(/not a finite number/);
  });
});

describe('PB-AB bootstrap interval of the shift', () => {
  const random = generator(4);
  const a = gaussian(random, 30, 500, 60);
  const b = gaussian(random, 30, 540, 60);

  it('is reproducible: the same seed gives the same interval to the last bit, another seed another one', () => {
    const first = bootstrapHodgesLehmann(a, b, { seed: 20261104, resamples: 1000 });
    expect(bootstrapHodgesLehmann(a, b, { seed: 20261104, resamples: 1000 })).toStrictEqual(first);
    const other = bootstrapHodgesLehmann(a, b, { seed: 20261105, resamples: 1000 });
    expect(other.lower === first.lower && other.upper === first.upper).toBe(false);
    expect(first.estimate).toBe(hodgesLehmann(a, b));
  });

  it('takes its draws by position, so a permuted arm is another resampling: the interval moves only by resampling noise', () => {
    const original = bootstrapHodgesLehmann(a, b, { seed: 9, resamples: 2000 });
    const permuted = bootstrapHodgesLehmann(shuffled(a, random), shuffled(b, random), {
      seed: 9,
      resamples: 2000,
    });
    expect(Math.abs(permuted.lower - original.lower)).toBeLessThan(0.25 * (original.upper - original.lower));
    expect(Math.abs(permuted.upper - original.upper)).toBeLessThan(0.25 * (original.upper - original.lower));
  });

  it('brackets the estimate, and a higher level gives a wider interval that contains the narrower one', () => {
    const narrow = bootstrapHodgesLehmann(a, b, { seed: 5, resamples: 1500, level: 0.8 });
    const standard = bootstrapHodgesLehmann(a, b, { seed: 5, resamples: 1500 });
    const wide = bootstrapHodgesLehmann(a, b, { seed: 5, resamples: 1500, level: 0.99 });
    for (const interval of [narrow, standard, wide]) {
      expect(interval.lower).toBeLessThanOrEqual(interval.estimate);
      expect(interval.upper).toBeGreaterThanOrEqual(interval.estimate);
    }
    expect(wide.lower).toBeLessThanOrEqual(standard.lower);
    expect(wide.upper).toBeGreaterThanOrEqual(standard.upper);
    expect(standard.lower).toBeLessThanOrEqual(narrow.lower);
    expect(standard.upper).toBeGreaterThanOrEqual(narrow.upper);
    expect(standard.level).toBe(0.95);
    expect(standard.resamples).toBe(1500);
  });

  it('moves exactly with the data: shifting B by c shifts the interval by c, scaling by k scales it (the same draws are taken)', () => {
    const base = bootstrapHodgesLehmann(a, b, { seed: 77, resamples: 500 });
    const shifted = bootstrapHodgesLehmann(
      a,
      b.map((x) => x + 1000),
      { seed: 77, resamples: 500 },
    );
    expect(shifted.lower).toBeCloseTo(base.lower + 1000, 8);
    expect(shifted.upper).toBeCloseTo(base.upper + 1000, 8);
    const scaled = bootstrapHodgesLehmann(
      a.map((x) => x * 4),
      b.map((x) => x * 4),
      { seed: 77, resamples: 500 },
    );
    expect(scaled.lower).toBeCloseTo(base.lower * 4, 8);
    expect(scaled.upper).toBeCloseTo(base.upper * 4, 8);
  });

  it('narrows as the sample grows (about with the square root of n)', () => {
    const r = generator(6);
    const small = bootstrapHodgesLehmann(gaussian(r, 10), gaussian(r, 10), { seed: 1, resamples: 1000 });
    const large = bootstrapHodgesLehmann(gaussian(r, 100), gaussian(r, 100), { seed: 1, resamples: 1000 });
    expect(large.upper - large.lower).toBeLessThan(0.6 * (small.upper - small.lower));
  });

  it('covers the true shift about 95 % of the time (150 simulated experiments of 30 against 30)', () => {
    const r = generator(7);
    const trueShift = 25;
    let covered = 0;
    const experiments = 150;
    for (let i = 0; i < experiments; i++) {
      const x = gaussian(r, 30, 500, 60);
      const y = gaussian(r, 30, 500 + trueShift, 60);
      const interval = bootstrapHodgesLehmann(x, y, { seed: 1000 + i, resamples: 400 });
      if (interval.lower <= trueShift && trueShift <= interval.upper) covered += 1;
    }
    // Binomial spread of 150 experiments at 95 % is 1.8 points; the percentile bootstrap of 400 resamples is a little short of nominal.
    expect(covered / experiments).toBeGreaterThan(0.88);
    expect(covered / experiments).toBeLessThanOrEqual(1);
  });

  it('collapses to the single value when nothing varies, and to the one difference for one session each', () => {
    expect(bootstrapHodgesLehmann([5, 5, 5], [5, 5, 5], { seed: 1, resamples: 100 })).toMatchObject({
      estimate: 0,
      lower: 0,
      upper: 0,
    });
    expect(bootstrapHodgesLehmann([3], [10], { seed: 1, resamples: 100 })).toMatchObject({
      estimate: 7,
      lower: 7,
      upper: 7,
    });
  });

  it('refuses a bootstrap it cannot stand behind', () => {
    expect(() => bootstrapHodgesLehmann(a, b, { seed: 1, resamples: 99 })).toThrow(/at least 100/);
    expect(() => bootstrapHodgesLehmann(a, b, { seed: 1, resamples: 1000.5 })).toThrow(RangeError);
    expect(() => bootstrapHodgesLehmann(a, b, { seed: 1, level: 1 })).toThrow(/strictly between/);
    expect(() => bootstrapHodgesLehmann(a, b, { seed: 1, level: 0 })).toThrow(/strictly between/);
    expect(() => bootstrapHodgesLehmann(a, b, { seed: 1.5 })).toThrow(/seed must be an integer/);
    expect(() => bootstrapHodgesLehmann([], b, { seed: 1 })).toThrow(RangeError);
  });
});

describe('PB-AB quantile of a sorted vector', () => {
  it('is the percentile of the performance harness (Hyndman and Fan type 7), so the two reports mean the same thing', () => {
    const random = generator(8);
    for (let trial = 0; trial < 40; trial++) {
      const values = coarse(random, 1 + Math.floor(random() * 50), 30).map((x) => x / 3);
      const sorted = [...values].sort((x, y) => x - y);
      for (const q of [0, 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 1]) {
        expect(quantileSorted(sorted, q)).toBeCloseTo(percentile(values, q), 12);
      }
    }
  });

  it('refuses an empty vector and a probability outside [0, 1]', () => {
    expect(() => quantileSorted([], 0.5)).toThrow(RangeError);
    expect(() => quantileSorted([1, 2], 1.1)).toThrow(RangeError);
    expect(() => quantileSorted([1, 2], Number.NaN)).toThrow(RangeError);
  });
});

describe("PB-AB Cliff's delta", () => {
  it('is (pairs where B is larger - pairs where B is smaller) / n1 n2: a worked example', () => {
    // a = 1 2 3, b = 2 3 4: B larger in 6 pairs, smaller in 1 (b = 2 against a = 3), equal in 2: (6 - 1) / 9.
    expect(cliffsDelta([1, 2, 3], [2, 3, 4]).delta).toBeCloseTo(5 / 9, 14);
  });

  it('is +1 when every session of B is larger, -1 when every one is smaller, 0 for identical arms and for all ties', () => {
    expect(cliffsDelta([1, 2, 3], [10, 11]).delta).toBe(1);
    expect(cliffsDelta([10, 11], [1, 2, 3]).delta).toBe(-1);
    expect(cliffsDelta([1, 2, 3, 4], [1, 2, 3, 4]).delta).toBe(0);
    expect(cliffsDelta([2, 2, 2], [2, 2]).delta).toBe(0);
  });

  it('equals 2 U_B / (n1 n2) - 1 where U_B is the Mann-Whitney U of B, on 40 random samples with ties', () => {
    const random = generator(9);
    for (let trial = 0; trial < 40; trial++) {
      const a = coarse(random, 1 + Math.floor(random() * 20), 6);
      const b = coarse(random, 1 + Math.floor(random() * 20), 6);
      const uB = mannWhitneyU(b, a, { method: 'asymptotic' }).u1;
      expect(cliffsDelta(a, b).delta).toBeCloseTo((2 * uB) / (a.length * b.length) - 1, 12);
    }
  });

  it('changes sign with the arms, keeps its value under a monotone transformation and ignores the order of sessions', () => {
    const random = generator(10);
    const a = coarse(random, 25, 9);
    const b = coarse(random, 30, 9);
    const { delta } = cliffsDelta(a, b);
    expect(cliffsDelta(b, a).delta).toBeCloseTo(-delta, 14);
    expect(
      cliffsDelta(
        a.map((x) => Math.exp(x / 3)),
        b.map((x) => Math.exp(x / 3)),
      ).delta,
    ).toBe(delta);
    expect(cliffsDelta(shuffled(a, random), shuffled(b, random)).delta).toBe(delta);
    expect(Math.abs(delta)).toBeLessThanOrEqual(1);
  });

  it.each([
    [0, 'negligible'],
    [0.146, 'negligible'],
    [0.147, 'small'],
    [0.329, 'small'],
    [0.33, 'medium'],
    [0.473, 'medium'],
    [0.474, 'large'],
    [1, 'large'],
    [-0.2, 'small'],
    [-0.9, 'large'],
  ])('labels a delta of %d as %s (the conventional bounds 0.147, 0.33 and 0.474)', (delta, label) => {
    expect(cliffsLabel(delta)).toBe(label);
  });

  it('carries its label, and refuses what is not a sample', () => {
    expect(cliffsDelta([1, 2, 3], [10, 11])).toStrictEqual({ delta: 1, label: 'large' });
    expect(() => cliffsDelta([], [1])).toThrow(RangeError);
    expect(() => cliffsDelta([1], [Infinity])).toThrow(/not a finite number/);
  });
});
