import { mulberry32 } from '../../../ab/stats/random.ts';
import type { Random } from '../../../ab/stats/random.ts';

// Independent references for the statistics tests. Nothing here imports the code under test except the seeded generator (whose own
// test compares it with the published algorithm): the references are brute force over every assignment, textbook formulas and
// published values, written separately from the implementations they check.

export const generator = (seed: number): Random => mulberry32(seed);

/** `n` integers from 0 to `max` inclusive: coarse on purpose, so that ties are common. */
export function coarse(random: Random, n: number, max: number): number[] {
  return Array.from({ length: n }, () => Math.floor(random() * (max + 1)));
}

/** `n` values from a normal distribution (Box-Muller): continuous, so no ties. */
export function gaussian(random: Random, n: number, mean = 0, sd = 1): number[] {
  return Array.from({ length: n }, () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  });
}

/** Doubled average rank of every pooled value, recomputed from the definition: 2 * (number below) + (number equal) + 1. */
export function doubledMidRanks(pooled: readonly number[]): number[] {
  return pooled.map((value) => {
    const below = pooled.filter((other) => other < value).length;
    const equal = pooled.filter((other) => other === value).length;
    return 2 * below + equal + 1;
  });
}

function popcount(mask: number): number {
  let count = 0;
  for (let m = mask; m !== 0; m &= m - 1) count += 1;
  return count;
}

export interface Enumeration {
  /** The doubled rank sum of arm A for every one of the C(N, n1) assignments. */
  sums2: number[];
  /** The doubled rank sum of the arm A that was observed (the first n1 pooled values). */
  observed2: number;
  /** n1 (N + 1): the doubled mean of the rank sum. */
  centre2: number;
}

/** Every way of choosing which n1 of the pooled sessions are arm A, by bitmask: only for N up to about 20. */
export function enumerate(a: readonly number[], b: readonly number[]): Enumeration {
  const pooled = [...a, ...b];
  const total = pooled.length;
  if (total > 22) throw new RangeError('enumerate: too many sessions for a brute-force reference');
  const ranks2 = doubledMidRanks(pooled);
  const sums2: number[] = [];
  for (let mask = 0; mask < 2 ** total; mask++) {
    if (popcount(mask) !== a.length) continue;
    let sum2 = 0;
    for (let i = 0; i < total; i++) if (mask & (1 << i)) sum2 += ranks2[i] as number;
    sums2.push(sum2);
  }
  const observed2 = ranks2.slice(0, a.length).reduce((sum, rank) => sum + rank, 0);
  return { sums2, observed2, centre2: a.length * (total + 1) };
}

/** The exact two-sided p-value by brute force: the share of assignments at least as far from the mean rank sum as the observed one. */
export function bruteForceExactP(a: readonly number[], b: readonly number[]): number {
  const { sums2, observed2, centre2 } = enumerate(a, b);
  const farthest = Math.abs(observed2 - centre2);
  return sums2.filter((s) => Math.abs(s - centre2) >= farthest).length / sums2.length;
}

/** The variance of U1 (= the variance of the rank sum) over every assignment, by brute force. */
export function bruteForceVariance(a: readonly number[], b: readonly number[]): number {
  const { sums2 } = enumerate(a, b);
  const sums = sums2.map((s) => s / 2);
  const mean = sums.reduce((sum, s) => sum + s, 0) / sums.length;
  return sums.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sums.length;
}

/**
 * The number of arrangements of n1 + n2 untied values with each value of U, from the generating function
 * prod_{i=1..n1} (1 - q^(n2 + i)) / (1 - q^i), the Gaussian binomial coefficient: a textbook identity, nothing to do with a
 * dynamic programme over ranks.
 */
export function uCounts(n1: number, n2: number): number[] {
  const degree = n1 * n2;
  let poly = new Array<number>(degree + 1).fill(0);
  poly[0] = 1;
  for (let i = 1; i <= n1; i++) {
    // multiply by (1 - q^(n2 + i))
    const multiplied = [...poly];
    for (let k = n2 + i; k <= degree; k++)
      multiplied[k] = (multiplied[k] as number) - (poly[k - (n2 + i)] as number);
    // divide by (1 - q^i): c[k] += c[k - i]
    for (let k = i; k <= degree; k++)
      multiplied[k] = (multiplied[k] as number) + (multiplied[k - i] as number);
    poly = multiplied;
  }
  return poly;
}

/** Fisher-Yates with the harness generator, for the property tests. */
export function shuffled<T>(values: readonly T[], random: Random): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}
