import { mulberry32, randomInt } from './random.ts';
import { assertSample, quantileSorted } from './sample.ts';

// The Hodges-Lehmann shift: the size of the difference between two arms, in the unit of the metric (milliseconds of startup), with no
// assumption about the shape of the data and no sensitivity to a few extreme sessions.
//
//   shift = median { b_j - a_i : i = 1..n1, j = 1..n2 }            every session of B against every session of A
//
// Positive means B is larger than A (slower to start, more rebuffering). It is the estimator that goes with the Mann-Whitney test: it is
// the amount by which B must be moved back for the test to see no difference. The median of an even number of differences is the mean of
// the two middle ones (the same definition as `percentile` in src/lab/measure/stats.ts).
//
// THE INTERVAL is a seeded percentile bootstrap: draw n1 sessions of A and n2 sessions of B with replacement, independently, compute the
// shift of the resample, repeat `resamples` times (5000 by default), and take the (1 - level) / 2 and 1 - (1 - level) / 2 quantiles (type 7)
// of the resampled shifts. The generator is mulberry32 from the seed of the pre-registration: the same data and the same seed give the same
// interval to the last bit, which is what lets a report be regenerated from the raw results.

export const DEFAULT_RESAMPLES = 5000;
export const DEFAULT_LEVEL = 0.95;

/**
 * Rearranges the first `length` values in place so that `values[k]` is the k-th smallest (counting from 0), everything before it is not
 * larger and everything after it is not smaller, and returns it: Hoare's FIND as Wirth wrote it, linear time on average. A full sort of
 * the n1 n2 differences would be the bottleneck of a bootstrap.
 */
export function selectInPlace(values: Float64Array, k: number, length: number = values.length): number {
  if (!Number.isInteger(k) || k < 0 || k >= length)
    throw new RangeError(`selectInPlace: k must be an integer from 0 to ${length - 1}, got ${String(k)}`);
  let left = 0;
  let right = length - 1;
  while (left < right) {
    const pivot = values[k] as number;
    let i = left;
    let j = right;
    do {
      while ((values[i] as number) < pivot) i++;
      while (pivot < (values[j] as number)) j--;
      if (i <= j) {
        const held = values[i] as number;
        values[i] = values[j] as number;
        values[j] = held;
        i++;
        j--;
      }
    } while (i <= j);
    if (j < k) left = i;
    if (k < i) right = j;
  }
  return values[k] as number;
}

/** The median of the n1 n2 differences b_j - a_i, using `scratch` (at least n1 n2 long) for the working copy. */
function medianOfDifferences(a: ArrayLike<number>, b: ArrayLike<number>, scratch: Float64Array): number {
  const n1 = a.length;
  const n2 = b.length;
  const count = n1 * n2;
  let at = 0;
  for (let i = 0; i < n1; i++) {
    const x = a[i] as number;
    for (let j = 0; j < n2; j++) scratch[at++] = (b[j] as number) - x;
  }
  if (count % 2 === 1) return selectInPlace(scratch, (count - 1) / 2, count);
  const lowerIndex = count / 2 - 1;
  const lower = selectInPlace(scratch, lowerIndex, count);
  // Everything after lowerIndex is not smaller: the next order statistic is the minimum of that part.
  let upper = Infinity;
  for (let t = lowerIndex + 1; t < count; t++) {
    const value = scratch[t] as number;
    if (value < upper) upper = value;
  }
  return (lower + upper) / 2;
}

/** The Hodges-Lehmann shift of B against A: the median of all the differences b - a. */
export function hodgesLehmann(a: readonly number[], b: readonly number[]): number {
  assertSample(a, "hodgesLehmann: arm A's sample");
  assertSample(b, "hodgesLehmann: arm B's sample");
  return medianOfDifferences(a, b, new Float64Array(a.length * b.length));
}

export interface BootstrapOptions {
  /** The seed of the generator: the same seed, the same interval. */
  seed: number;
  /** Number of resamples (default 5000, at least 100). */
  resamples?: number;
  /** Coverage of the interval (default 0.95). */
  level?: number;
}

export interface ShiftInterval {
  /** The Hodges-Lehmann shift of the sample itself. */
  estimate: number;
  lower: number;
  upper: number;
  level: number;
  resamples: number;
  seed: number;
}

/** The Hodges-Lehmann shift with its seeded percentile bootstrap interval (see the top of the file for the exact procedure). */
export function bootstrapHodgesLehmann(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions,
): ShiftInterval {
  assertSample(a, "bootstrapHodgesLehmann: arm A's sample");
  assertSample(b, "bootstrapHodgesLehmann: arm B's sample");
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const level = options.level ?? DEFAULT_LEVEL;
  if (!Number.isInteger(resamples) || resamples < 100)
    throw new RangeError(
      `the bootstrap needs an integer number of resamples of at least 100, got ${String(resamples)}`,
    );
  if (!(level > 0 && level < 1))
    throw new RangeError(`the confidence level must be strictly between 0 and 1, got ${String(level)}`);
  if (!Number.isInteger(options.seed))
    throw new RangeError(`the seed must be an integer, got ${String(options.seed)}`);

  const n1 = a.length;
  const n2 = b.length;
  const random = mulberry32(options.seed);
  const drawnA = new Float64Array(n1);
  const drawnB = new Float64Array(n2);
  const scratch = new Float64Array(n1 * n2);
  const shifts = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n1; i++) drawnA[i] = a[randomInt(random, n1)] as number;
    for (let j = 0; j < n2; j++) drawnB[j] = b[randomInt(random, n2)] as number;
    shifts[r] = medianOfDifferences(drawnA, drawnB, scratch);
  }
  shifts.sort();
  const tail = (1 - level) / 2;
  return {
    estimate: hodgesLehmann(a, b),
    lower: quantileSorted(shifts, tail),
    upper: quantileSorted(shifts, 1 - tail),
    level,
    resamples,
    seed: options.seed,
  };
}
