// Summary statistics of repeated measurements: what a baseline stores and what the gate compares. Pure and dependency free,
// so the definitions can be pinned by unit tests on small vectors whose answers can be checked by hand.
//
// PERCENTILE DEFINITION (the one used everywhere in the lab: baselines, reports, the gate):
//   Hyndman and Fan type 7, "linear interpolation between order statistics". With the n values sorted ascending as
//   x[0] <= ... <= x[n-1] and a probability q in [0, 1], let h = (n - 1) * q, i = floor(h), f = h - i; then
//   percentile(q) = x[i] + f * (x[i+1] - x[i]). It is the default of R (`quantile`), NumPy (`percentile`, method "linear") and the
//   spreadsheet function PERCENTILE.INC, so a reader can check a figure with a tool they already have.
//   Consequences worth knowing: q = 0 and q = 1 are the minimum and the maximum; the median of an even count is the mean of the
//   two middle values; and with n = 10, p90 sits at h = 8.1, a tenth of the way from the 9th to the 10th smallest value, so it is
//   essentially the second largest run. A p90 of ten runs is a coarse estimate of a tail, which is why the gate gives it a wider
//   threshold than the median (docs/decisions/perf.md).
//
// Nearest rank (the smallest value with at least 90 % of the runs at or below it) was the alternative: for ten runs it returns the
// 9th smallest and ignores the largest run completely, where type 7 moves a tenth of the way towards it and is continuous in q.

/** Scale factor that makes the MAD comparable to a standard deviation for normally distributed data. */
export const MAD_TO_SIGMA = 1.4826;

function assertUsable(values: readonly number[], what: string): void {
  if (values.length === 0) throw new RangeError(`${what}: at least one value is needed, got none`);
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`${what}: value ${index} is not a finite number (${String(value)})`);
    }
  });
}

function sortedCopy(values: readonly number[], what: string): number[] {
  assertUsable(values, what);
  return [...values].sort((a, b) => a - b);
}

/** The percentile of probability `q` (0 to 1), type 7: see the definition at the top of this file. */
export function percentile(values: readonly number[], q: number): number {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`percentile: the probability must be between 0 and 1, got ${String(q)}`);
  }
  const sorted = sortedCopy(values, 'percentile');
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const fraction = position - below;
  const lower = sorted[below] as number;
  if (fraction === 0) return lower;
  const upper = sorted[below + 1] as number;
  return lower + fraction * (upper - lower);
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export function p10(values: readonly number[]): number {
  return percentile(values, 0.1);
}

export function p90(values: readonly number[]): number {
  return percentile(values, 0.9);
}

export function minimum(values: readonly number[]): number {
  return sortedCopy(values, 'minimum')[0] as number;
}

export function maximum(values: readonly number[]): number {
  return sortedCopy(values, 'maximum').at(-1) as number;
}

export function mean(values: readonly number[]): number {
  assertUsable(values, 'mean');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The sample standard deviation (n - 1 in the denominator). null for a single value: one run has no spread to estimate. */
export function stdDev(values: readonly number[]): number | null {
  assertUsable(values, 'stdDev');
  if (values.length < 2) return null;
  const center = mean(values);
  const squares = values.reduce((sum, value) => sum + (value - center) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/** The median absolute deviation from the median (unscaled): half of the runs lie within this distance of the median. */
export function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * The coefficient of variation: sample standard deviation over the mean, a dimensionless "run-to-run noise" figure. null when it
 * is not defined: fewer than two runs, or a mean of zero (a count that was zero every time has no relative variation: such
 * metrics are judged by an absolute budget, not by a ratio).
 */
export function cv(values: readonly number[]): number | null {
  const spread = stdDev(values);
  const center = mean(values);
  if (spread === null || center === 0) return null;
  return spread / Math.abs(center);
}

/** The spread of the middle half of the runs as a share of the median, scaled like a standard deviation: robust to one outlier. */
export function robustCv(summary: Pick<Summary, 'n' | 'median' | 'mad'>): number | null {
  if (summary.n < 2 || summary.median === 0) return null;
  return (MAD_TO_SIGMA * summary.mad) / Math.abs(summary.median);
}

export interface Summary {
  /** Number of runs behind the figures. */
  n: number;
  median: number;
  /** The low tail: the worse end for a metric where higher is better (frame rate). */
  p10: number;
  /** The high tail: the worse end for a metric where lower is better (startup, rebuffering, dropped frames). */
  p90: number;
  min: number;
  max: number;
  /** Median absolute deviation from the median, unscaled. */
  mad: number;
  /** Coefficient of variation, or null when it is not defined (see `cv`). */
  cv: number | null;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = sortedCopy(values, 'summarize');
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    min: sorted[0] as number,
    max: sorted.at(-1) as number,
    mad: mad(sorted),
    cv: cv(sorted),
  };
}

/** (current - baseline) / |baseline|, or null when the baseline is zero and a relative change has no meaning. */
export function relativeChange(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return (current - baseline) / Math.abs(baseline);
}
