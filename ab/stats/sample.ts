// Shared plumbing of the statistics: validation of a sample, ties, and the quantile of a sorted vector. Nothing here has an opinion.

/** A sample must have at least `min` values, all finite numbers: NaN and Infinity would corrupt a rank without a sound. */
export function assertSample(values: readonly number[], what: string, min = 1): void {
  if (!Array.isArray(values)) throw new TypeError(`${what}: expected an array of numbers`);
  if (values.length < min) {
    throw new RangeError(
      `${what}: at least ${min} value${min === 1 ? ' is' : 's are'} needed, got ${values.length}`,
    );
  }
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`${what}: value ${i} is not a finite number (${String(value)})`);
    }
  }
}

/** The sizes of the runs of equal values in a vector sorted ascending: [1, 1, 3, 2] for 4, 5, 7, 7, 7, 9, 9. */
export function tieGroupSizes(sorted: readonly number[]): number[] {
  const sizes: number[] = [];
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run += 1;
    if (i === sorted.length - 1 || sorted[i + 1] !== sorted[i]) {
      sizes.push(run);
      run = 0;
    }
  }
  return sizes;
}

/**
 * The q-quantile of an ALREADY SORTED vector by linear interpolation between order statistics: Hyndman and Fan type 7, the definition
 * of `percentile` in src/lab/measure/stats.ts (R's `quantile`, NumPy's `percentile`), so that a figure of this harness and a figure of
 * the performance baselines mean the same thing. A test pins the two against each other.
 */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) throw new RangeError('quantileSorted: at least one value is needed');
  if (!Number.isFinite(q) || q < 0 || q > 1)
    throw new RangeError(`quantileSorted: the probability must be between 0 and 1, got ${String(q)}`);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const fraction = position - below;
  const lower = sorted[below] as number;
  if (fraction === 0) return lower;
  return lower + fraction * ((sorted[below + 1] as number) - lower);
}

/** The exact binomial coefficient C(n, k) as a BigInt (0 when k is outside 0..n). */
export function chooseBig(n: number, k: number): bigint {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0)
    throw new RangeError(`chooseBig: n and k must be integers with n >= 0, got ${n} and ${k}`);
  if (k < 0 || k > n) return 0n;
  const m = Math.min(k, n - k);
  let result = 1n;
  for (let i = 1; i <= m; i++) result = (result * BigInt(n - m + i)) / BigInt(i);
  return result;
}
