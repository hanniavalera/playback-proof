import { twoSidedNormalP } from './normal.ts';
import { assertSample, chooseBig, tieGroupSizes } from './sample.ts';

// The Mann-Whitney U test (Wilcoxon rank-sum), two-sided, between the sessions of arm A (the first sample, n1 of them) and of arm B (the
// second sample, n2 of them). It asks whether a session of one arm tends to be larger than a session of the other. It assumes nothing about
// the shape of the data, which is what startup times (right-skewed) and rebuffer ratios (zero for most sessions) need.
//
// DEFINITIONS
//   U1 = #{(i, j): a_i > b_j} + 1/2 #{(i, j): a_i = b_j}        U2 = n1 n2 - U1        (the U of scipy.stats.mannwhitneyu is U1)
//   Under "no difference" (every assignment of the N = n1 + n2 pooled sessions to the arms equally likely) E[U1] = n1 n2 / 2.
//   The rank sum of A, with ties given their average rank, is R1 = U1 + n1 (n1 + 1) / 2; U1 - E[U1] = R1 - n1 (N + 1) / 2.
//
// TWO P-VALUES, chosen by size (the brief's rule: exact for both arms <= 12 sessions, normal approximation otherwise)
//   exact       P(|S - E S| >= |s - E S|) over all C(N, n1) assignments of the pooled sessions to arm A, where S is the rank sum of A and s
//               the observed one. The enumeration is CONDITIONAL ON THE TIES THAT WERE OBSERVED (the pooled mid-ranks are fixed, only the
//               assignment varies), so it is exact with ties too, and equals the classical exact distribution when there are none. It is a
//               dynamic programme over the groups of tied values, not an enumeration of subsets.
//   asymptotic  z = (|U1 - n1 n2 / 2| - 1/2) / sigma, p = 2 (1 - Phi(z)), with the continuity correction of 1/2 (and z = 0 when the
//               deviation is below it), and the variance corrected for ties:
//                   sigma^2 = n1 n2 / 12 * [ (N + 1) - sum_j (t_j^3 - t_j) / (N (N - 1)) ]      t_j = size of the j-th group of tied values.
//               With every value equal sigma^2 = 0 and the answer is p = 1: nothing can be told apart.

/** `method: 'auto'` computes the exact p-value when both arms have at most this many sessions. */
export const EXACT_MAX_PER_ARM = 12;

/**
 * The exact enumeration counts assignments in doubles, exact up to 2^53. Every partial count is at most C(N, floor(N / 2)), which stays
 * below 2^53 up to N = 56 pooled sessions (C(56, 28) = 7.6e15; C(57, 28) = 1.6e16 does not).
 */
export const MAX_EXACT_POOLED = 56;

export type MannWhitneyMethod = 'auto' | 'exact' | 'asymptotic';

export interface MannWhitneyOptions {
  method?: MannWhitneyMethod;
  /** The size up to which `auto` is exact (both arms). Default 12. */
  exactMaxPerArm?: number;
}

export interface MannWhitneyResult {
  n1: number;
  n2: number;
  /** The U of the first sample (arm A): pairs where A is larger, plus half the ties. */
  u1: number;
  /** n1 n2 - u1: the U of arm B. */
  u2: number;
  method: 'exact' | 'asymptotic';
  /** Two-sided, in [0, 1]. */
  p: number;
  /** The continuity-corrected |z| of the normal approximation; null for the exact method. */
  z: number | null;
  /** Whether any two of the pooled values are equal. */
  ties: boolean;
}

/** 2 * U1, an integer even when ties contribute a half: counted pair by pair, straight from the definition. */
function twiceU1(a: readonly number[], b: readonly number[]): number {
  let twice = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) twice += 2;
      else if (x === y) twice += 1;
    }
  }
  return twice;
}

function smallChoose(n: number, k: number): number {
  return Number(chooseBig(n, k));
}

/**
 * The exact distribution of 2 x (the rank sum of n1 sessions drawn at random from the pooled ones), given the sizes of the groups of tied
 * values in ascending order of value: a map from the doubled rank sum to the NUMBER of assignments that give it. Doubling keeps every
 * mid-rank an integer. The counts add up to C(N, n1). This is the heart of the exact p-value, exposed so that a test can compare it with
 * an independent enumeration.
 */
export function exactRankSumDistribution(groupSizes: readonly number[], n1: number): Map<number, number> {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isInteger(n1) || n1 < 0 || n1 > total)
    throw new RangeError(
      `exactRankSumDistribution: n1 must be an integer from 0 to ${total}, got ${String(n1)}`,
    );
  if (total > MAX_EXACT_POOLED)
    throw new RangeError(
      `the exact distribution of ${total} pooled sessions needs counts beyond 2^53 (at most ${MAX_EXACT_POOLED}): use the asymptotic method`,
    );
  const widest = 2 * total * n1;
  // ways[c][s]: assignments that put c sessions of the groups seen so far into arm A with a doubled rank sum of s.
  const ways: Float64Array[] = Array.from({ length: n1 + 1 }, () => new Float64Array(widest + 1));
  (ways[0] as Float64Array)[0] = 1;
  let before = 0;
  for (const size of groupSizes) {
    const rank2 = 2 * before + size + 1;
    // In place, counts from high to low: ways[c - k] below still holds the values from before this group.
    for (let c = n1; c >= 1; c--) {
      const row = ways[c] as Float64Array;
      for (let k = 1; k <= Math.min(size, c); k++) {
        const source = ways[c - k] as Float64Array;
        const choose = smallChoose(size, k);
        const shift = k * rank2;
        for (let s = widest; s >= shift; s--) {
          const w = source[s - shift] as number;
          if (w !== 0) row[s] = (row[s] as number) + w * choose;
        }
      }
    }
    before += size;
  }
  const distribution = new Map<number, number>();
  const last = ways[n1] as Float64Array;
  for (let s = 0; s <= widest; s++) {
    if ((last[s] as number) !== 0) distribution.set(s, last[s] as number);
  }
  return distribution;
}

function exactTwoSidedP(groupSizes: readonly number[], n1: number, observed2: number): number {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  const distribution = exactRankSumDistribution(groupSizes, n1);
  const centre2 = n1 * (total + 1);
  const farthest = Math.abs(observed2 - centre2);
  let atLeastAsFar = 0;
  let all = 0;
  for (const [sum2, count] of distribution) {
    all += count;
    if (Math.abs(sum2 - centre2) >= farthest) atLeastAsFar += count;
  }
  return Math.min(1, atLeastAsFar / all);
}

/** Var(U1) under no difference, with the correction for ties of the pooled sample (see the definitions at the top of the file). */
export function mannWhitneyVariance(n1: number, n2: number, groupSizes: readonly number[]): number {
  const total = n1 + n2;
  const tieTerm = groupSizes.reduce((sum, t) => sum + (t ** 3 - t), 0) / (total * (total - 1));
  return (n1 * n2 * (total + 1 - tieTerm)) / 12;
}

/**
 * Two-sided Mann-Whitney U test of `a` against `b`. `method: 'auto'` (default) is exact when both samples have at most
 * `EXACT_MAX_PER_ARM` values and the normal approximation, with continuity and tie corrections, otherwise.
 */
export function mannWhitneyU(
  a: readonly number[],
  b: readonly number[],
  options: MannWhitneyOptions = {},
): MannWhitneyResult {
  assertSample(a, 'mannWhitneyU: the first sample');
  assertSample(b, 'mannWhitneyU: the second sample');
  const n1 = a.length;
  const n2 = b.length;
  const requested = options.method ?? 'auto';
  const limit = options.exactMaxPerArm ?? EXACT_MAX_PER_ARM;
  const method: 'exact' | 'asymptotic' =
    requested === 'auto' ? (n1 <= limit && n2 <= limit ? 'exact' : 'asymptotic') : requested;

  const twice = twiceU1(a, b);
  const u1 = twice / 2;
  const groups = tieGroupSizes([...a, ...b].sort((x, y) => x - y));
  const ties = groups.length < n1 + n2;

  if (method === 'exact') {
    // Doubled rank sum of A: 2 R1 = 2 U1 + n1 (n1 + 1).
    const p = exactTwoSidedP(groups, n1, twice + n1 * (n1 + 1));
    return { n1, n2, u1, u2: n1 * n2 - u1, method, p, z: null, ties };
  }
  const variance = mannWhitneyVariance(n1, n2, groups);
  if (!(variance > 0)) return { n1, n2, u1, u2: n1 * n2 - u1, method, p: 1, z: 0, ties };
  const z = Math.max(0, Math.abs(u1 - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance);
  return { n1, n2, u1, u2: n1 * n2 - u1, method, p: Math.min(1, twoSidedNormalP(z)), z, ties };
}
