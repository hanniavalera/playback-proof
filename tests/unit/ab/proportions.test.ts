import { describe, expect, it } from 'vitest';
import { clopperPearson, binomialCdf } from '../../../ab/stats/binomial.ts';
import { fisherExact } from '../../../ab/stats/fisher.ts';
import { holmAdjust } from '../../../ab/stats/holm.ts';
import { normalQuantile } from '../../../ab/stats/normal.ts';
import { newcombeDifference, wilsonInterval } from '../../../ab/stats/proportions.ts';
import { generator, shuffled } from './helpers.ts';

// Tests for the statistics of the rebuffer share (Fisher's exact test, Newcombe's interval) and for the correction over the family
// (Holm). References: the published tables, brute force with ordinary floating-point arithmetic where the implementation uses exact
// integers, and the defining equations of each interval.

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) result = (result * (n - Math.min(k, n - k) + i)) / i;
  return result;
}

/** Two-sided Fisher p by summing the hypergeometric pmf in floating point, with a relative tolerance for tables of equal probability. */
function referenceFisher(a: number, n1: number, b: number, n2: number): number {
  const events = a + b;
  const total = n1 + n2;
  const pmf = (k: number): number => (choose(n1, k) * choose(n2, events - k)) / choose(total, events);
  const observed = pmf(a);
  let p = 0;
  for (let k = Math.max(0, events - n2); k <= Math.min(n1, events); k++) {
    const probability = pmf(k);
    if (probability <= observed * (1 + 1e-12)) p += probability;
  }
  return p;
}

describe("PB-AB Fisher's exact test", () => {
  it("is 34/70 = 0.4857 for the lady tasting tea (3 of 4 against 1 of 4), the worked example of Fisher's own paper", () => {
    const result = fisherExact({ events: 3, total: 4 }, { events: 1, total: 4 });
    expect(result.p).toBeCloseTo(34 / 70, 14);
    expect(result.p).toBeCloseTo(0.4857, 4);
    expect(result.observedProbability).toBeCloseTo(16 / 70, 14);
  });

  it("is 64278 / 119759850 = 0.0005367 for the twin convictions of R's fisher.test documentation (2 of 17 against 10 of 13)", () => {
    expect(fisherExact({ events: 2, total: 17 }, { events: 10, total: 13 }).p).toBeCloseTo(
      64278 / 119759850,
      14,
    );
    expect(fisherExact({ events: 2, total: 17 }, { events: 10, total: 13 }).p).toBeCloseTo(0.0005367, 7);
  });

  it('matches the floating-point sum of the hypergeometric distribution for every table of several sizes', () => {
    for (const [n1, n2] of [
      [7, 9],
      [12, 12],
      [30, 30],
      [5, 20],
      [1, 1],
      [10, 3],
    ] as const) {
      for (let a = 0; a <= n1; a++) {
        for (let b = 0; b <= n2; b++) {
          const exact = fisherExact({ events: a, total: n1 }, { events: b, total: n2 }).p;
          expect(exact, `${a}/${n1} against ${b}/${n2}`).toBeCloseTo(referenceFisher(a, n1, b, n2), 12);
        }
      }
    }
  });

  it('is symmetric in the arms, 1 for equal shares and for a table with nothing to distribute, and always a probability', () => {
    for (const [a, n1, b, n2] of [
      [3, 30, 9, 30],
      [0, 30, 4, 30],
      [11, 25, 2, 40],
    ] as const) {
      const forward = fisherExact({ events: a, total: n1 }, { events: b, total: n2 }).p;
      expect(fisherExact({ events: b, total: n2 }, { events: a, total: n1 }).p).toBeCloseTo(forward, 14);
      expect(forward).toBeGreaterThan(0);
      expect(forward).toBeLessThanOrEqual(1);
    }
    expect(fisherExact({ events: 6, total: 30 }, { events: 6, total: 30 }).p).toBe(1);
    expect(fisherExact({ events: 0, total: 30 }, { events: 0, total: 30 }).p).toBe(1);
    expect(fisherExact({ events: 30, total: 30 }, { events: 30, total: 30 }).p).toBe(1);
  });

  it('tells 0 of 30 from 10 of 30, and does not tell 5 of 30 from 8 of 30', () => {
    expect(fisherExact({ events: 0, total: 30 }, { events: 10, total: 30 }).p).toBeLessThan(0.002);
    expect(fisherExact({ events: 5, total: 30 }, { events: 8, total: 30 }).p).toBeGreaterThan(0.5);
  });

  it('gives a smaller p to a bigger difference of shares (monotone in the count of arm B)', () => {
    let previous = 1;
    for (let b = 6; b <= 30; b++) {
      const p = fisherExact({ events: 6, total: 30 }, { events: b, total: 30 }).p;
      expect(p).toBeLessThanOrEqual(previous + 1e-12);
      previous = p;
    }
  });

  it('refuses counts that cannot be a table', () => {
    expect(() => fisherExact({ events: 5, total: 4 }, { events: 1, total: 4 })).toThrow(RangeError);
    expect(() => fisherExact({ events: -1, total: 4 }, { events: 1, total: 4 })).toThrow(RangeError);
    expect(() => fisherExact({ events: 1.5, total: 4 }, { events: 1, total: 4 })).toThrow(RangeError);
    expect(() => fisherExact({ events: 0, total: 0 }, { events: 1, total: 4 })).toThrow(RangeError);
    expect(() => fisherExact({ events: 1, total: 600 }, { events: 1, total: 600 })).toThrow(/at most 1000/);
  });
});

describe("PB-AB Holm's step-down correction", () => {
  it('reproduces the worked example of the literature: 0.01 0.04 0.03 0.005 adjust to 0.03 0.06 0.06 0.02', () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    [0.03, 0.06, 0.06, 0.02].forEach((expected, i) => expect(adjusted[i]).toBeCloseTo(expected, 14));
  });

  it('is the identity for one p-value and Bonferroni for the smallest of several', () => {
    expect(holmAdjust([0.031])).toStrictEqual([0.031]);
    expect(holmAdjust([0.01, 0.9, 0.5])[0]).toBeCloseTo(0.03, 14);
  });

  it('caps at 1, keeps 0 at 0 and 1 at 1', () => {
    expect(holmAdjust([0.6, 0.7])).toStrictEqual([1, 1]);
    // The smallest p is multiplied by m = 2 (0 stays 0); the next by m - 1 = 1, and the running maximum carries the 0.5 forward.
    expect(holmAdjust([0, 0.5])).toStrictEqual([0, 0.5]);
    expect(holmAdjust([1, 1, 1])).toStrictEqual([1, 1, 1]);
  });

  it('is monotone: sorted by raw p, the adjusted values never fall; and never below the raw p, never above Bonferroni', () => {
    const random = generator(21);
    for (let trial = 0; trial < 200; trial++) {
      const m = 1 + Math.floor(random() * 8);
      const raw = Array.from({ length: m }, () => (random() < 0.2 ? 0.05 : random() ** 2));
      const adjusted = holmAdjust(raw);
      const order = raw.map((_, i) => i).sort((x, y) => (raw[x] as number) - (raw[y] as number));
      for (let k = 1; k < m; k++) {
        expect(adjusted[order[k] as number] as number).toBeGreaterThanOrEqual(
          adjusted[order[k - 1] as number] as number,
        );
      }
      raw.forEach((p, i) => {
        expect(adjusted[i] as number).toBeGreaterThanOrEqual(p);
        expect(adjusted[i] as number).toBeLessThanOrEqual(Math.min(1, m * p) + 1e-15);
        expect(adjusted[i] as number).toBeLessThanOrEqual(1);
      });
    }
  });

  it('rejects exactly the hypotheses of the sequential rule (reject p(k) while p(k) <= alpha / (m - k + 1), stop at the first failure)', () => {
    const random = generator(22);
    for (let trial = 0; trial < 300; trial++) {
      const m = 1 + Math.floor(random() * 6);
      const raw = Array.from({ length: m }, () => random() ** 3);
      const alpha = [0.01, 0.05, 0.1][trial % 3] as number;
      const order = raw.map((_, i) => i).sort((x, y) => (raw[x] as number) - (raw[y] as number));
      const sequential = new Set<number>();
      for (let k = 0; k < m; k++) {
        if ((raw[order[k] as number] as number) <= alpha / (m - k)) sequential.add(order[k] as number);
        else break;
      }
      const adjusted = holmAdjust(raw);
      raw.forEach((_, i) =>
        expect((adjusted[i] as number) <= alpha, `p = ${JSON.stringify(raw)}, alpha ${alpha}`).toBe(
          sequential.has(i),
        ),
      );
    }
  });

  it('follows the p-values when they are reordered, and holds the family-wise error rate under the global null', () => {
    const random = generator(23);
    const raw = [0.003, 0.2, 0.04, 0.5, 0.012];
    const adjusted = holmAdjust(raw);
    const order = shuffled([0, 1, 2, 3, 4], random);
    const reordered = holmAdjust(order.map((i) => raw[i] as number));
    order.forEach((original, position) =>
      expect(reordered[position]).toBeCloseTo(adjusted[original] as number, 14),
    );

    // Four true nulls: the chance of any adjusted p of at most 0.05 is the family-wise error rate, which Holm keeps at or below 5 %.
    let anyRejected = 0;
    const families = 20000;
    for (let i = 0; i < families; i++) {
      if (holmAdjust(Array.from({ length: 4 }, () => random())).some((p) => p <= 0.05)) anyRejected += 1;
    }
    expect(anyRejected / families).toBeLessThan(0.056);
    expect(anyRejected / families).toBeGreaterThan(0.04);
  });

  it('refuses what is not a p-value', () => {
    expect(() => holmAdjust([])).toThrow(RangeError);
    expect(() => holmAdjust([0.5, 1.2])).toThrow(/not a probability/);
    expect(() => holmAdjust([-0.1])).toThrow(/not a probability/);
    expect(() => holmAdjust([Number.NaN])).toThrow(/not a finite number/);
  });
});

describe('PB-AB Wilson score interval', () => {
  const z = normalQuantile(0.975);

  it('its ends solve the score equation (p^ - p)^2 = z^2 p (1 - p) / n, for a range of counts', () => {
    for (const [x, n] of [
      [1, 30],
      [5, 30],
      [15, 30],
      [29, 30],
      [7, 100],
      [60, 200],
    ] as const) {
      const share = x / n;
      const { lower, upper } = wilsonInterval({ events: x, total: n });
      for (const p of [lower, upper]) expect((share - p) ** 2).toBeCloseTo((z * z * p * (1 - p)) / n, 12);
      expect(lower).toBeLessThan(share);
      expect(upper).toBeGreaterThan(share);
    }
  });

  it('has the closed form z^2 / (n + z^2) as the upper end at no events, stays in [0, 1] and mirrors itself', () => {
    const none = wilsonInterval({ events: 0, total: 10 });
    expect(none.lower).toBeCloseTo(0, 14);
    expect(none.upper).toBeCloseTo((z * z) / (10 + z * z), 12);
    const all = wilsonInterval({ events: 10, total: 10 });
    expect(all.upper).toBeCloseTo(1, 14);
    expect(all.lower).toBeCloseTo(1 - none.upper, 12);
  });

  it('narrows with more sessions and widens with a higher level', () => {
    const width = (x: number, n: number, level = 0.95): number => {
      const { lower, upper } = wilsonInterval({ events: x, total: n }, level);
      return upper - lower;
    };
    expect(width(30, 300)).toBeLessThan(width(3, 30));
    expect(width(3, 30, 0.99)).toBeGreaterThan(width(3, 30));
    expect(() => wilsonInterval({ events: 3, total: 30 }, 1)).toThrow(RangeError);
  });
});

describe('PB-AB Newcombe hybrid score interval of a difference of shares', () => {
  it('reproduces the published example of Newcombe (1998), table II: 56/70 against 48/80, 0.2 (0.0524 to 0.3339)', () => {
    // B is the first proportion of the paper (56/70), A the second (48/80).
    const result = newcombeDifference({ events: 48, total: 80 }, { events: 56, total: 70 });
    expect(result.difference).toBeCloseTo(0.2, 14);
    expect(result.lower).toBeCloseTo(0.0524, 3);
    expect(result.upper).toBeCloseTo(0.3339, 3);
  });

  it('negates and swaps its ends when the arms are swapped, and brackets the difference inside [-1, 1]', () => {
    const random = generator(31);
    for (let trial = 0; trial < 60; trial++) {
      const n1 = 5 + Math.floor(random() * 60);
      const n2 = 5 + Math.floor(random() * 60);
      const a = { events: Math.floor(random() * (n1 + 1)), total: n1 };
      const b = { events: Math.floor(random() * (n2 + 1)), total: n2 };
      const forward = newcombeDifference(a, b);
      const backward = newcombeDifference(b, a);
      expect(backward.difference).toBeCloseTo(-forward.difference, 14);
      expect(backward.lower).toBeCloseTo(-forward.upper, 12);
      expect(backward.upper).toBeCloseTo(-forward.lower, 12);
      expect(forward.lower).toBeLessThanOrEqual(forward.difference);
      expect(forward.upper).toBeGreaterThanOrEqual(forward.difference);
      expect(forward.lower).toBeGreaterThanOrEqual(-1);
      expect(forward.upper).toBeLessThanOrEqual(1);
    }
  });

  it('is symmetric about zero for two arms with the same share, even at 0 of 30 against 0 of 30', () => {
    const none = newcombeDifference({ events: 0, total: 30 }, { events: 0, total: 30 });
    expect(none.difference).toBe(0);
    expect(none.lower).toBeCloseTo(-none.upper, 14);
    expect(none.upper).toBeGreaterThan(0.1);
  });

  it('excludes zero when Fisher finds a clear difference and includes it when the shares are close', () => {
    const clear = newcombeDifference({ events: 2, total: 30 }, { events: 14, total: 30 });
    expect(clear.lower).toBeGreaterThan(0);
    const close = newcombeDifference({ events: 6, total: 30 }, { events: 7, total: 30 });
    expect(close.lower).toBeLessThan(0);
    expect(close.upper).toBeGreaterThan(0);
  });
});

describe('PB-AB Clopper-Pearson interval', () => {
  /** P(X >= x | n, p) summed from exact binomial coefficients and ordinary powers: no logarithms, unlike the implementation. */
  const upperTail = (x: number, n: number, p: number): number => {
    let sum = 0;
    for (let k = x; k <= n; k++) sum += choose(n, k) * p ** k * (1 - p) ** (n - k);
    return sum;
  };
  const lowerTail = (x: number, n: number, p: number): number => {
    let sum = 0;
    for (let k = 0; k <= x; k++) sum += choose(n, k) * p ** k * (1 - p) ** (n - k);
    return sum;
  };

  it('its ends are the proportions at which each tail is exactly 2.5 %', () => {
    for (const [x, n] of [
      [1, 10],
      [3, 10],
      [5, 30],
      [12, 40],
      [29, 30],
    ] as const) {
      const { lower, upper } = clopperPearson(x, n);
      expect(upperTail(x, n, lower)).toBeCloseTo(0.025, 9);
      expect(lowerTail(x, n, upper)).toBeCloseTo(0.025, 9);
    }
  });

  it('has the closed forms at no events and at all events, and matches the textbook value for 3 of 10', () => {
    expect(clopperPearson(0, 10)).toMatchObject({ lower: 0 });
    expect(clopperPearson(0, 10).upper).toBeCloseTo(1 - 0.025 ** (1 / 10), 12);
    expect(clopperPearson(0, 10).upper).toBeCloseTo(0.3085, 4);
    expect(clopperPearson(10, 10)).toMatchObject({ upper: 1 });
    expect(clopperPearson(10, 10).lower).toBeCloseTo(0.025 ** (1 / 10), 12);
    const three = clopperPearson(3, 10);
    expect(three.lower).toBeCloseTo(0.0667, 3);
    expect(three.upper).toBeCloseTo(0.6525, 3);
  });

  it('knows a false-positive rate of 100 in 2000 to about a percentage point, and contains the nominal 5 %', () => {
    const { lower, upper } = clopperPearson(100, 2000);
    expect(lower).toBeGreaterThan(0.04);
    expect(lower).toBeLessThan(0.042);
    expect(upper).toBeGreaterThan(0.06);
    expect(upper).toBeLessThan(0.0615);
  });

  it('computes a binomial CDF that adds up, and refuses what is not a count', () => {
    expect(binomialCdf(10, 10, 0.3)).toBe(1);
    expect(binomialCdf(-1, 10, 0.3)).toBe(0);
    expect(binomialCdf(3, 10, 0.5)).toBeCloseTo((1 + 10 + 45 + 120) / 1024, 12);
    expect(() => clopperPearson(11, 10)).toThrow(RangeError);
    expect(() => clopperPearson(1, 0)).toThrow(RangeError);
    expect(() => clopperPearson(1, 10, 1.5)).toThrow(RangeError);
  });
});
