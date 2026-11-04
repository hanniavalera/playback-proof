import { describe, expect, it } from 'vitest';
import { erfc } from '../../../ab/stats/normal.ts';
import {
  EXACT_MAX_PER_ARM,
  MAX_EXACT_POOLED,
  exactRankSumDistribution,
  heavyTies,
  mannWhitneyU,
  mannWhitneyVariance,
} from '../../../ab/stats/mann-whitney.ts';
import { mulberry32, seedFrom, shuffleInPlace } from '../../../ab/stats/random.ts';
import { tieGroupSizes } from '../../../ab/stats/sample.ts';
import {
  bruteForceExactP,
  bruteForceVariance,
  coarse,
  gaussian,
  generator,
  shuffled,
  uCounts,
} from './helpers.ts';
import { aaPool } from './synthetic.ts';

// Reference checks of the Mann-Whitney U test. The independent references are: brute force over every assignment of the pooled sessions
// (the definition of the exact permutation p-value, ties included), the Gaussian-binomial generating function of the untied distribution,
// the published two-sided 5 % critical values of U, and the exact variance of the rank sum with its correction for ties.

describe('PB-AB Mann-Whitney U: the exact p-value against brute force over every assignment', () => {
  it('matches the enumeration on samples without ties', () => {
    const a = [1.1, 2.3, 3.7, 4.2, 5.9];
    const b = [0.5, 2.9, 6.1, 7.7, 8.8, 9.3];
    const result = mannWhitneyU(a, b);
    expect(result.method).toBe('exact');
    expect(result.p).toBeCloseTo(bruteForceExactP(a, b), 12);
    expect(result.ties).toBe(false);
  });

  it('matches the enumeration on 40 random samples full of ties (values 0 to 4, sizes 1 to 8)', () => {
    const random = generator(2026);
    for (let i = 0; i < 40; i++) {
      const a = coarse(random, 1 + Math.floor(random() * 8), 4);
      const b = coarse(random, 1 + Math.floor(random() * 8), 4);
      const result = mannWhitneyU(a, b);
      expect(result.method).toBe('exact');
      expect(result.p, `a = ${JSON.stringify(a)}, b = ${JSON.stringify(b)}`).toBeCloseTo(
        bruteForceExactP(a, b),
        12,
      );
    }
  });

  it('matches the enumeration on 20 random samples without ties (sizes 3 to 9)', () => {
    const random = generator(77);
    for (let i = 0; i < 20; i++) {
      const a = gaussian(random, 3 + Math.floor(random() * 7));
      const b = gaussian(random, 3 + Math.floor(random() * 7), 0.5);
      expect(mannWhitneyU(a, b).p).toBeCloseTo(bruteForceExactP(a, b), 12);
    }
  });

  it('complete separation of two arms of 12 has p = 2 / C(24, 12): the smallest p the test can give', () => {
    const low = Array.from({ length: 12 }, (_, i) => i);
    const high = Array.from({ length: 12 }, (_, i) => 100 + i);
    expect(mannWhitneyU(low, high).p).toBeCloseTo(2 / 2704156, 14);
    expect(mannWhitneyU(high, low).p).toBeCloseTo(2 / 2704156, 14);
  });

  it('counts, for every U, the arrangements of the Gaussian binomial coefficient (the classical untied distribution)', () => {
    for (const [n1, n2] of [
      [3, 3],
      [4, 6],
      [5, 5],
      [7, 4],
      [8, 8],
      [10, 12],
    ] as const) {
      const distribution = exactRankSumDistribution(Array<number>(n1 + n2).fill(1), n1);
      const byU = new Map<number, number>();
      for (const [sum2, count] of distribution) byU.set((sum2 - n1 * (n1 + 1)) / 2, count);
      const expected = uCounts(n1, n2);
      expect([...byU.keys()].sort((x, y) => x - y)).toStrictEqual(expected.map((_, u) => u));
      expected.forEach((count, u) => expect(byU.get(u)).toBe(count));
    }
  });

  it('puts the counts of every assignment on the enumeration of tied data: they add up to C(N, n1)', () => {
    const groups = tieGroupSizes([1, 1, 2, 2, 2, 3, 4, 4, 5, 5, 5, 5]);
    const total = [...exactRankSumDistribution(groups, 5).values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(792); // C(12, 5)
  });
});

describe('PB-AB Mann-Whitney U: published critical values', () => {
  /**
   * Data with exactly `u` pairs in which A is the larger and no ties anywhere: each a_i sits above `c_i` of the b values (1 to n2), at
   * a distinct offset inside its gap, so that the classical table, which assumes no ties, applies.
   */
  function withU(n1: number, n2: number, u: number): { a: number[]; b: number[] } {
    const b = Array.from({ length: n2 }, (_, j) => j + 1);
    const a: number[] = [];
    let left = u;
    for (let i = 0; i < n1; i++) {
      const share = Math.min(n2, left);
      a.push(share + (i + 1) / (n1 + 2));
      left -= share;
    }
    return { a, b };
  }

  // Two-sided 5 % critical values of the smaller U for equal sample sizes: the entries of the standard tables (Zar, Siegel and Castellan):
  // the test rejects when U <= the entry, so the exact p of U = entry is at most 0.05 and that of U = entry + 1 is above it.
  it.each([
    [4, 0],
    [5, 2],
    [6, 5],
    [7, 8],
    [8, 13],
    [9, 17],
    [10, 23],
    [11, 30],
    [12, 37],
  ])('n1 = n2 = %i: rejects at U = %i and not at one more', (n, critical) => {
    const at = withU(n, n, critical);
    const above = withU(n, n, critical + 1);
    expect(mannWhitneyU(at.a, at.b).p).toBeLessThanOrEqual(0.05);
    expect(mannWhitneyU(above.a, above.b).p).toBeGreaterThan(0.05);
  });

  it('reproduces the worked values 8/252 for U = 2 and 14/252 for U = 3 with five sessions in each arm', () => {
    const two = withU(5, 5, 2);
    const three = withU(5, 5, 3);
    expect(mannWhitneyU(two.a, two.b).p).toBeCloseTo(8 / 252, 14);
    expect(mannWhitneyU(three.a, three.b).p).toBeCloseTo(14 / 252, 14);
  });

  it('is exactly 1 when each arm holds one session: one observation cannot tell two arms apart', () => {
    expect(mannWhitneyU([3], [9]).p).toBe(1);
    expect(mannWhitneyU([9], [3]).p).toBe(1);
    expect(mannWhitneyU([4], [4]).p).toBe(1);
  });
});

describe('PB-AB Mann-Whitney U: the correction for ties', () => {
  it('Var(U) of the formula is the exact variance of the rank sum over every assignment (so the sign of the correction is pinned)', () => {
    const random = generator(31);
    for (let i = 0; i < 12; i++) {
      const a = coarse(random, 3 + Math.floor(random() * 4), 3);
      const b = coarse(random, 3 + Math.floor(random() * 4), 3);
      const groups = tieGroupSizes([...a, ...b].sort((x, y) => x - y));
      expect(mannWhitneyVariance(a.length, b.length, groups)).toBeCloseTo(bruteForceVariance(a, b), 9);
    }
  });

  it('shrinks the variance when values tie, down to 0 when they all do', () => {
    expect(mannWhitneyVariance(5, 5, Array(10).fill(1))).toBeCloseTo((5 * 5 * 11) / 12, 12);
    expect(mannWhitneyVariance(5, 5, [3, 3, 4])).toBeLessThan((5 * 5 * 11) / 12);
    expect(mannWhitneyVariance(5, 5, [10])).toBe(0);
  });

  it('the asymptotic p-value is z = (|U - n1 n2 / 2| - 1/2) / sigma and p = erfc(z / sqrt 2), by hand on tied data', () => {
    // 20 sessions each. A: ten 0s, six 1s, four 2s. B: five 0s, five 1s, ten 2s. Pooled ties: 15, 11, 14.
    const a = [...Array(10).fill(0), ...Array(6).fill(1), ...Array(4).fill(2)] as number[];
    const b = [...Array(5).fill(0), ...Array(5).fill(1), ...Array(10).fill(2)] as number[];
    // U1 = A larger than B: (1s over B's 0s) 6x5 + (2s over B's 0s and 1s) 4x10 = 70; ties: 10x5 + 6x5 + 4x10 = 120, half = 60 -> 130.
    const u1 = 130;
    const sigma2 = (20 * 20 * (41 - (15 ** 3 - 15 + (11 ** 3 - 11) + (14 ** 3 - 14)) / (40 * 39))) / 12;
    const z = (Math.abs(u1 - 200) - 0.5) / Math.sqrt(sigma2);
    const result = mannWhitneyU(a, b, { method: 'asymptotic' });
    expect(result.method).toBe('asymptotic');
    expect(result.u1).toBe(u1);
    expect(result.z).toBeCloseTo(z, 12);
    expect(result.p).toBeCloseTo(erfc(z / Math.SQRT2), 14);
  });

  it('a deviation of half a unit from the mean U is inside the continuity correction: z = 0 and p = 1', () => {
    // 21 against 21: n1 n2 / 2 = 220.5, and U1 = 220 is built from the staircase "a_i sits above c_i of the b values".
    const b = Array.from({ length: 21 }, (_, j) => j + 1);
    const steps = [...Array<number>(10).fill(21), 10, ...Array<number>(10).fill(0)];
    const a = steps.map((above, i) => above + (i + 1) / 23);
    const result = mannWhitneyU(a, b);
    expect(result.method).toBe('asymptotic');
    expect(result.u1).toBe(220);
    expect(result.z).toBe(0);
    expect(result.p).toBe(1);
  });

  it('says p = 1 when every value is equal, with either method', () => {
    expect(mannWhitneyU([5, 5, 5], [5, 5, 5, 5]).p).toBe(1);
    expect(mannWhitneyU(Array(30).fill(2), Array(30).fill(2)).p).toBe(1);
    expect(mannWhitneyU([5, 5, 5], [5, 5, 5, 5], { method: 'asymptotic' }).p).toBe(1);
  });
});

describe('PB-AB Mann-Whitney U: the choice of method and the approximation', () => {
  it('uses the exact distribution when both arms have at most 12 sessions, and the approximation as soon as one has more', () => {
    expect(EXACT_MAX_PER_ARM).toBe(12);
    const twelve = Array.from({ length: 12 }, (_, i) => i);
    expect(
      mannWhitneyU(
        twelve,
        twelve.map((x) => x + 0.5),
      ).method,
    ).toBe('exact');
    expect(
      mannWhitneyU(
        [...twelve, 12],
        twelve.map((x) => x + 0.5),
      ).method,
    ).toBe('asymptotic');
    expect(
      mannWhitneyU(
        twelve,
        [...twelve, 12].map((x) => x + 0.5),
      ).method,
    ).toBe('asymptotic');
  });

  it('can be forced either way, and refuses an exact enumeration that is too big or too expensive', () => {
    const a = [1, 4, 9, 12];
    const b = [2, 3, 20];
    expect(mannWhitneyU(a, b, { method: 'asymptotic' }).method).toBe('asymptotic');
    expect(mannWhitneyU(a, b, { method: 'exact' }).method).toBe('exact');
    const beyond = Array.from({ length: MAX_EXACT_POOLED / 2 + 1 }, (_, i) => i);
    expect(() =>
      mannWhitneyU(
        beyond,
        beyond.map((x) => x + 0.5),
        { method: 'exact' },
      ),
    ).toThrow(/beyond the 400 it is computed for/);
    // 150 against 150 with no ties: 300 groups x 150 counts x 90,001 sums = 4e9 additions, far over the 6e8 a forced run may do.
    const wide = Array.from({ length: 150 }, (_, i) => i);
    expect(() =>
      mannWhitneyU(
        wide,
        wide.map((x) => x + 0.5),
        { method: 'exact' },
      ),
    ).toThrow(/operations, more than the 6e\+8 allowed/);
  });

  it('the normal approximation is close to the exact p-value at the edge of the exact range (12 against 12)', () => {
    const random = generator(404);
    for (let i = 0; i < 25; i++) {
      const a = gaussian(random, 12);
      const b = gaussian(random, 12, 0.4);
      const exact = mannWhitneyU(a, b, { method: 'exact' }).p;
      const approximate = mannWhitneyU(a, b, { method: 'asymptotic' }).p;
      expect(Math.abs(exact - approximate)).toBeLessThan(0.02);
    }
  });

  it('the normal approximation is also close to the exact p-value at 30 against 30 when there are no ties', () => {
    const random = generator(405);
    for (let i = 0; i < 6; i++) {
      const a = gaussian(random, 30);
      const b = gaussian(random, 30, 0.5);
      const exact = mannWhitneyU(a, b, { method: 'exact' }).p;
      const approximate = mannWhitneyU(a, b, { method: 'asymptotic' }).p;
      expect(Math.abs(exact - approximate)).toBeLessThan(0.01);
    }
  });
});

describe('PB-AB Mann-Whitney U: heavy ties use the exact distribution (the extension the A/A calibration asked for)', () => {
  it('calls ties heavy when on average three or more sessions share a value', () => {
    expect(heavyTies([20, 20, 20])).toBe(true);
    expect(heavyTies([3, 3, 3, 3])).toBe(true);
    expect(heavyTies([2, 2, 2, 2, 2, 2])).toBe(false);
    expect(heavyTies(Array<number>(60).fill(1))).toBe(false);
    expect(heavyTies([57, 1, 1, 1])).toBe(true);
  });

  it('chooses exact for a zero-inflated sample of 30 against 30 and the approximation for a continuous one', () => {
    const zeros = (events: number): number[] => [
      ...Array<number>(events).fill(0.5),
      ...Array<number>(30 - events).fill(0),
    ];
    const lumpy = mannWhitneyU(zeros(4), zeros(11));
    expect(lumpy.method).toBe('exact');
    expect(lumpy.ties).toBe(true);
    const random = generator(406);
    expect(mannWhitneyU(gaussian(random, 30), gaussian(random, 30)).method).toBe('asymptotic');
    // Five distinct values in 30 + 30 is heavy too; sixty distinct values is not.
    expect(mannWhitneyU(coarse(random, 30, 4), coarse(random, 30, 4)).method).toBe('exact');
  });

  it('computes the same p-value with or without the cache of distributions, and repeats it', () => {
    const a = [...Array<number>(26).fill(0), 1, 2, 3, 4];
    const b = [...Array<number>(18).fill(0), ...Array<number>(12).fill(1)];
    const first = mannWhitneyU(a, b);
    expect(first.method).toBe('exact');
    expect(mannWhitneyU(a, b)).toStrictEqual(first);
    expect(mannWhitneyU([...a].reverse(), [...b].reverse())).toStrictEqual(first);
  });

  it('adds the counts up to C(60, 30) = 1.18e17 for the sixty pooled sessions of an experiment (floating point, to a relative 1e-12)', () => {
    const groups = tieGroupSizes([
      ...Array<number>(40).fill(0),
      ...Array<number>(10).fill(1),
      ...Array<number>(10).fill(2),
    ]);
    const total = [...exactRankSumDistribution(groups, 30).values()].reduce((sum, count) => sum + count, 0);
    expect(Math.abs(total / 118264581564861424 - 1)).toBeLessThan(1e-12);
    const untied = [...exactRankSumDistribution(Array<number>(60).fill(1), 30).values()];
    expect(Math.abs(untied.reduce((sum, count) => sum + count, 0) / 118264581564861424 - 1)).toBeLessThan(
      1e-12,
    );
  });

  it('is symmetric about the mean when nothing ties, at 30 against 30 (the classical distribution is)', () => {
    const distribution = exactRankSumDistribution(Array<number>(60).fill(1), 30);
    const centre2 = 30 * 61;
    for (const [sum2, count] of distribution) {
      const mirror = distribution.get(2 * centre2 - sum2) ?? 0;
      expect(Math.abs(count / mirror - 1)).toBeLessThan(1e-12);
    }
  });

  it('agrees with a permutation test of 20000 draws on a zero-inflated sample of 30 against 30', () => {
    const random = generator(8);
    const a = coarse(random, 30, 3);
    const b = coarse(random, 30, 3).map((x) => Math.min(3, x + (random() < 0.3 ? 1 : 0)));
    const pooled = [...a, ...b];
    const observed = Math.abs(mannWhitneyU(a, b, { method: 'asymptotic' }).u1 - 450);
    let atLeastAsFar = 0;
    const draws = 20000;
    for (let i = 0; i < draws; i++) {
      const order = shuffled(pooled, random);
      const u = mannWhitneyU(order.slice(0, 30), order.slice(30), { method: 'asymptotic' }).u1;
      if (Math.abs(u - 450) >= observed) atLeastAsFar += 1;
    }
    const permutation = atLeastAsFar / draws;
    expect(mannWhitneyU(a, b).method).toBe('exact');
    expect(Math.abs(permutation - mannWhitneyU(a, b).p)).toBeLessThan(0.015);
    expect(Math.abs(permutation - mannWhitneyU(a, b, { method: 'asymptotic' }).p)).toBeLessThan(0.03);
  });

  it('keeps a metric that is zero in most sessions at its level where the approximation does not (a pool of 60, 1000 random splits)', () => {
    // The finding behind the extension: this pool of 60 sessions (a rebuffer count that is 0 in 50 of them) split into two arms of 30,
    // 1000 times, with the same splits: the normal approximation says "different" in 78 splits (7.8 %) at alpha 5 %, the exact distribution
    // in 34 (3.4 %).
    const pool = aaPool(generator(2026), 60).map((session) => session.values.rebufferCount as number);
    let approximate = 0;
    let exact = 0;
    for (let split = 0; split < 1000; split++) {
      const order = shuffleInPlace([...pool], mulberry32(seedFrom(1, 'split', split)));
      const a = order.slice(0, 30);
      const b = order.slice(30);
      if (mannWhitneyU(a, b, { method: 'asymptotic' }).p < 0.05) approximate += 1;
      if (mannWhitneyU(a, b).p < 0.05) exact += 1;
    }
    expect(approximate).toBe(78);
    expect(exact).toBe(34);
  });
});

describe('PB-AB Mann-Whitney U: properties', () => {
  const random = generator(12345);
  const samples = Array.from({ length: 30 }, () => ({
    a: coarse(random, 2 + Math.floor(random() * 25), 9),
    b: coarse(random, 2 + Math.floor(random() * 25), 9),
  }));

  it('does not depend on the order of the sessions inside an arm', () => {
    for (const { a, b } of samples) {
      const original = mannWhitneyU(a, b);
      const permuted = mannWhitneyU(shuffled(a, random), shuffled(b, random));
      expect(permuted).toStrictEqual(original);
    }
  });

  it('is symmetric when the arms are swapped: the same p, and the two U exchanged', () => {
    for (const { a, b } of samples) {
      const forward = mannWhitneyU(a, b);
      const backward = mannWhitneyU(b, a);
      expect(backward.p).toBeCloseTo(forward.p, 13);
      expect(backward.u1).toBe(forward.u2);
      expect(backward.u2).toBe(forward.u1);
      expect(forward.u1 + forward.u2).toBe(a.length * b.length);
    }
  });

  it('always gives a probability, and U between 0 and n1 n2', () => {
    for (const { a, b } of samples) {
      const result = mannWhitneyU(a, b);
      expect(result.p).toBeGreaterThanOrEqual(0);
      expect(result.p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.p)).toBe(true);
      expect(result.u1).toBeGreaterThanOrEqual(0);
      expect(result.u1).toBeLessThanOrEqual(a.length * b.length);
    }
  });

  it('only sees ranks: a shift of both arms, a positive scale and a monotone transformation change nothing', () => {
    for (const { a, b } of samples) {
      const original = mannWhitneyU(a, b);
      expect(
        mannWhitneyU(
          a.map((x) => x + 1000),
          b.map((x) => x + 1000),
        ),
      ).toStrictEqual(original);
      expect(
        mannWhitneyU(
          a.map((x) => x * 7),
          b.map((x) => x * 7),
        ),
      ).toStrictEqual(original);
      expect(
        mannWhitneyU(
          a.map((x) => x ** 3),
          b.map((x) => x ** 3),
        ),
      ).toStrictEqual(original);
    }
  });

  it('finds a large shift and not a null one (sanity of direction and size)', () => {
    const r = generator(3);
    const a = gaussian(r, 30);
    expect(mannWhitneyU(a, gaussian(r, 30, 3)).p).toBeLessThan(0.001);
    expect(
      mannWhitneyU(
        a,
        a.map((x) => x + 1e-9),
      ).p,
    ).toBeGreaterThan(0.5);
  });

  it('refuses what is not a sample: no values, NaN, Infinity', () => {
    expect(() => mannWhitneyU([], [1])).toThrow(RangeError);
    expect(() => mannWhitneyU([1], [])).toThrow(RangeError);
    expect(() => mannWhitneyU([1, Number.NaN], [1])).toThrow(/not a finite number/);
    expect(() => mannWhitneyU([1], [Infinity])).toThrow(/not a finite number/);
  });
});
