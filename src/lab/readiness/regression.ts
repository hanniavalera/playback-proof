import { median } from '../measure/stats.ts';

// The line fits behind the soak's drift and heap trends: Theil-Sen (the median of the pairwise slopes, which the drift verdict is made of)
// and ordinary least squares (the cross-check next to it, and the trend of the heap). Pure and dependency free; the cases that matter (a
// flat line is not a drift, a step is not a slope, a wild read does not flip a verdict, noise does not either) are pinned by
// tests/unit/readiness/regression.test.ts.
//
// Everything is computed on values centred on their means: the x of a soak is a time in epoch milliseconds (1.7e12), and the products of
// such numbers lose most of their digits in a double.

export interface Point {
  x: number;
  y: number;
}

export interface LineFit {
  n: number;
  /** y per x: with x in ms and y in ms it is dimensionless; `perHour` converts. */
  slope: number;
  /** The fitted line's value at the first x: the LEVEL at the start of the window, which is what separates a high flat series from a drift. */
  intercept: number;
  firstX: number;
  lastX: number;
  meanX: number;
  meanY: number;
  /** Share of the variance of y that the line explains; null when y does not vary (a flat series has nothing to explain). */
  r2: number | null;
  /** The scatter of y around the line, the sample standard deviation of the residuals (n - 2 degrees of freedom); null below three points. */
  residualSd: number | null;
}

const MS_PER_HOUR = 3_600_000;

/** A slope of y per millisecond, as y per hour. */
export function perHour(slopePerMs: number): number {
  return slopePerMs * MS_PER_HOUR;
}

/** The least-squares line through the points; null when there are fewer than two or every x is the same (no slope can be fitted). */
export function fitLine(points: readonly Point[]): LineFit | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const firstX = Math.min(...points.map((p) => p.x));
  const lastX = Math.max(...points.map((p) => p.x));
  const intercept = meanY + slope * (firstX - meanX);
  const ssResidual = Math.max(0, syy - slope * sxy);
  return {
    n,
    slope,
    intercept,
    firstX,
    lastX,
    meanX,
    meanY,
    r2: syy === 0 ? null : 1 - ssResidual / syy,
    residualSd: n > 2 ? Math.sqrt(ssResidual / (n - 2)) : null,
  };
}

export interface PooledFit {
  /** The one slope of all segments (y per x), from the within-segment variation only. */
  slope: number;
  /** Points that contributed (segments with fewer than two points or no spread in x do not). */
  n: number;
  /** One line per contributing segment, each with its own level but the pooled slope. */
  segments: Array<{
    n: number;
    firstX: number;
    lastX: number;
    /** The level (fitted value) at the segment's first x, under the pooled slope. */
    intercept: number;
    meanY: number;
    /** Scatter of the segment's points around its line under the pooled slope. */
    residualSd: number | null;
    /** The slope this segment would have had alone, for the reader who wants to see that the segments agree. */
    ownSlope: number;
  }>;
}

/**
 * One slope for several separate stretches of a series, each with a level of its own: the "within" estimator of a fixed-effects
 * regression, `sum(sxy_k) / sum(sxx_k)`. A soak with an injected outage is cut into the stretch before it and the stretch after it; the
 * player may sit at a different latency after the outage (that is a finding of the stall check, not a drift), and fitting one line across
 * both would read that step as a slope. Pooling uses all the fault-free time to estimate the slope and none of the level steps.
 */
export function pooledSlope(segments: ReadonlyArray<readonly Point[]>): PooledFit | null {
  let sxx = 0;
  let sxy = 0;
  const used: Array<{ points: readonly Point[]; own: LineFit }> = [];
  for (const points of segments) {
    const own = fitLine(points);
    if (own === null) continue;
    for (const p of points) {
      sxx += (p.x - own.meanX) ** 2;
      sxy += (p.x - own.meanX) * (p.y - own.meanY);
    }
    used.push({ points, own });
  }
  if (used.length === 0 || sxx === 0) return null;
  const slope = sxy / sxx;
  return {
    slope,
    n: used.reduce((sum, segment) => sum + segment.points.length, 0),
    segments: used.map(({ points, own }) => {
      const ss = points.reduce((sum, p) => sum + (p.y - (own.meanY + slope * (p.x - own.meanX))) ** 2, 0);
      return {
        n: points.length,
        firstX: own.firstX,
        lastX: own.lastX,
        intercept: own.meanY + slope * (own.firstX - own.meanX),
        meanY: own.meanY,
        residualSd: points.length > 2 ? Math.sqrt(ss / (points.length - 2)) : null,
        ownSlope: own.slope,
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Theil-Sen: the robust slope the drift verdict is made of

/**
 * Most points of one stretch whose pairs are all used. n points have n(n-1)/2 pairwise slopes, held in memory at once: 1,200 points are
 * 719,400 slopes (5.8 MB). A soak reads every few seconds, so 30 minutes at 5 s is 360 points and nothing is thinned; only a very long
 * soak read very often is, to evenly spaced points (first and last kept), and the fit says so.
 */
export const MAX_THEIL_SEN_POINTS = 1200;

export interface RobustFit {
  /** The median of the pairwise slopes of every stretch (y per x), pairs from different stretches never mixed. */
  slope: number;
  /** Points of the stretches that contributed. */
  n: number;
  /** Pairwise slopes the median was taken over. */
  pairs: number;
  /** A stretch had more than `MAX_THEIL_SEN_POINTS` points and was thinned. */
  thinned: boolean;
  /** One line per contributing stretch, each with a level of its own and the pooled slope. */
  segments: Array<{
    n: number;
    /** Points used after thinning. */
    used: number;
    firstX: number;
    lastX: number;
    /** The level at the stretch's first x: the median of `y - slope * (x - firstX)`, the median-of-intercepts line. */
    intercept: number;
    medianY: number;
    /** The scatter around the line as a standard deviation would say it: 1.4826 times the median absolute residual. Null below three points. */
    scatter: number | null;
    /** The median of this stretch's own pairwise slopes, for the reader who wants to see that the stretches agree. */
    ownSlope: number;
  }>;
}

const medianOfSorted = (sorted: ArrayLike<number>): number => {
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** Evenly spaced points, the first and the last kept: thinning that does not favour any part of the series. */
function thinned(points: readonly Point[], max: number): readonly Point[] {
  if (points.length <= max) return points;
  return Array.from(
    { length: max },
    (_, i) => points[Math.floor((i * (points.length - 1)) / (max - 1))] as Point,
  );
}

/** Every slope between two points of the stretch with different x, sorted. */
function pairwiseSlopes(points: readonly Point[]): Float64Array {
  const slopes = new Float64Array((points.length * (points.length - 1)) / 2);
  let count = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as Point;
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j] as Point;
      const dx = b.x - a.x;
      if (dx !== 0) slopes[count++] = (b.y - a.y) / dx;
    }
  }
  return slopes.subarray(0, count).sort();
}

/**
 * One slope for several stretches of a series, each with a level of its own, by the Theil-Sen method: the median of all the slopes between
 * two points of the same stretch (a stretch that an outage cut in two gives pairs on each side, never across, so the step an outage
 * leaves is not read as a slope), and for each stretch the median of `y - slope * x` as its level. The median of n(n-1)/2 slopes is not
 * moved by a few wild reads wherever they are in the series (up to 29 % of the points can be wild before it is), where the least-squares
 * slope is moved by one read at either end in proportion to its distance from the middle. Null when no stretch has two points with
 * different x.
 */
export function pooledTheilSen(segments: ReadonlyArray<readonly Point[]>): RobustFit | null {
  const used: Array<{ points: readonly Point[]; original: number; slopes: Float64Array }> = [];
  for (const original of segments) {
    const points = thinned(original, MAX_THEIL_SEN_POINTS);
    if (points.length < 2) continue;
    const slopes = pairwiseSlopes(points);
    if (slopes.length === 0) continue;
    used.push({ points, original: original.length, slopes });
  }
  if (used.length === 0) return null;
  const all = new Float64Array(used.reduce((sum, segment) => sum + segment.slopes.length, 0));
  let offset = 0;
  for (const { slopes } of used) {
    all.set(slopes, offset);
    offset += slopes.length;
  }
  all.sort();
  const slope = medianOfSorted(all);
  return {
    slope,
    n: used.reduce((sum, segment) => sum + segment.original, 0),
    pairs: all.length,
    thinned: used.some((segment) => segment.original > segment.points.length),
    segments: used.map(({ points, original, slopes }) => {
      const firstX = Math.min(...points.map((p) => p.x));
      const lastX = Math.max(...points.map((p) => p.x));
      const intercept = medianOfSorted(points.map((p) => p.y - slope * (p.x - firstX)).sort((a, b) => a - b));
      const absolute = points
        .map((p) => Math.abs(p.y - (intercept + slope * (p.x - firstX))))
        .sort((a, b) => a - b);
      return {
        n: original,
        used: points.length,
        firstX,
        lastX,
        intercept,
        medianY: median(points.map((p) => p.y)),
        scatter: points.length > 2 ? 1.4826 * medianOfSorted(absolute) : null,
        ownSlope: medianOfSorted(slopes),
      };
    }),
  };
}

/**
 * `median(last quarter) - median(first quarter)` of a series in time order: the definition the strategy gave the drift limit before the
 * regression was chosen. Kept as a cross-check of the fitted drift; null below eight points (a quarter would be a single sample).
 */
export function quartileShift(values: readonly number[]): number | null {
  if (values.length < 8) return null;
  const quarter = Math.floor(values.length / 4);
  return median(values.slice(-quarter)) - median(values.slice(0, quarter));
}
