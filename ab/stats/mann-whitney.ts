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
// TWO P-VALUES (the brief's rule: exact for both arms <= 12 sessions, normal approximation otherwise; plus one extension, below)
//   exact       P(|S - E S| >= |s - E S|) over all C(N, n1) assignments of the pooled sessions to arm A, where S is the rank sum of A and s
//               the observed one. The enumeration is CONDITIONAL ON THE TIES THAT WERE OBSERVED (the pooled mid-ranks are fixed, only the
//               assignment varies), so it is exact with ties too, and equals the classical exact distribution when there are none. It is a
//               dynamic programme over the groups of tied values, not an enumeration of subsets.
//   asymptotic  z = (|U1 - n1 n2 / 2| - 1/2) / sigma, p = 2 (1 - Phi(z)), with the continuity correction of 1/2 (and z = 0 when the
//               deviation is below it), and the variance corrected for ties:
//                   sigma^2 = n1 n2 / 12 * [ (N + 1) - sum_j (t_j^3 - t_j) / (N (N - 1)) ]      t_j = size of the j-th group of tied values.
//               With every value equal sigma^2 = 0 and the answer is p = 1: nothing can be told apart.
//
// THE EXTENSION. `auto` is also exact when ties are heavy (on average three or more sessions share a value) and the programme is cheap
// (a few ms for 30 against 30). The A/A calibration found why: on a metric that is zero in most sessions the rank sum lives on a coarse
// lattice, and the normal approximation with a continuity correction of 1/2 declares identical samples different too often (78 of 1000
// random splits at alpha 5 % for the rebuffer counts of one synthetic pool of 60 sessions, 50 of them zero; the exact test: 34 of 1000, a
// test pins both numbers). The exact test does not have the problem and costs about 4 ms there (median 3.6 ms, p90 4.3 ms over 60 samples
// of 30 against 30, one thread, a machine shared with other work).

/** `method: 'auto'` computes the exact p-value when both arms have at most this many sessions. */
export const EXACT_MAX_PER_ARM = 12;

/**
 * The largest pooled sample the exact distribution is computed for. The counts are doubles: exact integers up to 2^53 (N = 56), and beyond
 * that accurate to a relative 1e-15 or so, which is all a p-value needs; the guard is the cost, `exactCost`, and C(400, 200) = 1e119 still
 * fits a double.
 */
export const MAX_EXACT_POOLED = 400;

/** The most work (additions) a forced `exact` computation may do: about a second. Beyond it the asymptotic method is the only one. */
export const MAX_EXACT_COST = 600_000_000;

/** `auto` also computes the exact p-value when ties are heavy and it costs at most this much (about 0.1 s): see the top of the file. */
export const AUTO_EXACT_COST = 60_000_000;

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
 * The work of the dynamic programme behind the exact p-value, in additions: for every group of tied values, every count of sessions
 * already in arm A, up to the size of the group, over the whole range of rank sums. A sample without ties is the worst case per group; a
 * sample with a few big groups (a rebuffer count that is zero in most sessions) is far cheaper.
 */
export function exactCost(groupSizes: readonly number[], n1: number): number {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  const widest = 2 * total * n1 + 1;
  return groupSizes.reduce((sum, size) => sum + n1 * Math.min(size, n1) * widest, 0);
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
      `the exact distribution of ${total} pooled sessions is beyond the ${MAX_EXACT_POOLED} it is computed for: use the asymptotic method`,
    );
  if (exactCost(groupSizes, n1) > MAX_EXACT_COST)
    throw new RangeError(
      `the exact distribution of this sample needs ${exactCost(groupSizes, n1).toExponential(1)} operations, more than the ${MAX_EXACT_COST.toExponential(0)} allowed: use the asymptotic method`,
    );
  const widest = 2 * total * n1;
  // ways[c][s]: assignments that put c sessions of the groups seen so far into arm A with a doubled rank sum of s.
  const ways: Float64Array[] = Array.from({ length: n1 + 1 }, () => new Float64Array(widest + 1));
  (ways[0] as Float64Array)[0] = 1;
  let before = 0;
  for (const size of groupSizes) {
    const rank2 = 2 * before + size + 1;
    const choose = Array.from({ length: Math.min(size, n1) + 1 }, (_, k) => smallChoose(size, k));
    // In place, counts from high to low: ways[c - k] below still holds the values from before this group.
    for (let c = n1; c >= 1; c--) {
      const row = ways[c] as Float64Array;
      for (let k = 1; k <= Math.min(size, c); k++) {
        const source = ways[c - k] as Float64Array;
        const multiplicity = choose[k] as number;
        const shift = k * rank2;
        for (let s = widest; s >= shift; s--) {
          const w = source[s - shift] as number;
          if (w !== 0) row[s] = (row[s] as number) + w * multiplicity;
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

/**
 * The two-sided tail of an exact distribution as a lookup by distance from the mean: `tail[d]` = P(|S - E S| >= d / 2), in doubled
 * units. The distribution depends only on the sizes of the groups of tied values and on n1, not on the values, so thousands of simulated
 * experiments with the same ties (a power simulation, an A/A calibration) build it once.
 */
const TAIL_CACHE = new Map<string, Float64Array>();
const TAIL_CACHE_ENTRIES = 1500;

function exactTail(groupSizes: readonly number[], n1: number): Float64Array {
  const key = `${n1}|${groupSizes.join(',')}`;
  const cached = TAIL_CACHE.get(key);
  if (cached) return cached;
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  const centre2 = n1 * (total + 1);
  const distribution = exactRankSumDistribution(groupSizes, n1);
  let farthest = 0;
  let all = 0;
  for (const [sum2, count] of distribution) {
    farthest = Math.max(farthest, Math.abs(sum2 - centre2));
    all += count;
  }
  const tail = new Float64Array(farthest + 2);
  for (const [sum2, count] of distribution)
    tail[Math.abs(sum2 - centre2)] = (tail[Math.abs(sum2 - centre2)] as number) + count;
  for (let d = farthest - 1; d >= 0; d--) tail[d] = (tail[d] as number) + (tail[d + 1] as number);
  for (let d = 0; d < tail.length; d++) tail[d] = Math.min(1, (tail[d] as number) / all);
  if (TAIL_CACHE.size >= TAIL_CACHE_ENTRIES) TAIL_CACHE.clear();
  TAIL_CACHE.set(key, tail);
  return tail;
}

function exactTwoSidedP(groupSizes: readonly number[], n1: number, observed2: number): number {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  const tail = exactTail(groupSizes, n1);
  return (tail[Math.abs(observed2 - n1 * (total + 1))] as number | undefined) ?? 0;
}

/** Var(U1) under no difference, with the correction for ties of the pooled sample (see the definitions at the top of the file). */
export function mannWhitneyVariance(n1: number, n2: number, groupSizes: readonly number[]): number {
  const total = n1 + n2;
  const tieTerm = groupSizes.reduce((sum, t) => sum + (t ** 3 - t), 0) / (total * (total - 1));
  return (n1 * n2 * (total + 1 - tieTerm)) / 12;
}

/**
 * Whether ties are heavy enough that the normal approximation is unreliable and the exact conditional distribution is cheap: on average
 * three or more pooled sessions share a value. The rank sum of such data lives on a coarse lattice (a zero-inflated count: the sum moves
 * in steps of the size of the ranks of the few non-zero sessions, a continuity correction of 1/2 is far too small for it) and the
 * approximation is too eager: on a synthetic A/A pool of 60 sessions (50 of them zero), split 1000 times, it declared identical sessions
 * different in 7.8 % of the splits at alpha 5 %, against 3.4 % for the exact test (ADR-141 in docs/decisions/ab.md; pinned by a test).
 */
export function heavyTies(groupSizes: readonly number[]): boolean {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  return groupSizes.length * 3 <= total;
}

/**
 * Two-sided Mann-Whitney U test of `a` against `b`. `method: 'auto'` (default) is exact when both samples have at most
 * `EXACT_MAX_PER_ARM` values (the brief's rule), or when ties are heavy (`heavyTies`) and the exact distribution costs at most
 * `AUTO_EXACT_COST`; otherwise it is the normal approximation with continuity and tie corrections.
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

  const twice = twiceU1(a, b);
  const u1 = twice / 2;
  const groups = tieGroupSizes([...a, ...b].sort((x, y) => x - y));
  const ties = groups.length < n1 + n2;
  const small = n1 <= limit && n2 <= limit;
  const cheapAndLumpy =
    n1 + n2 <= MAX_EXACT_POOLED && heavyTies(groups) && exactCost(groups, n1) <= AUTO_EXACT_COST;
  const method: 'exact' | 'asymptotic' =
    requested === 'auto' ? (small || cheapAndLumpy ? 'exact' : 'asymptotic') : requested;

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
