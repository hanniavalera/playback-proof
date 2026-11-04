import { median } from '../measure/stats.ts';

// Least squares for the soak's drift and heap trends. Pure and dependency free; the cases that matter (a flat line is not a drift, a step
// is not a slope, noise does not flip a verdict) are pinned by tests/unit/readiness/regression.test.ts.
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

/**
 * `median(last quarter) - median(first quarter)` of a series in time order: the definition the strategy gave the drift limit before the
 * regression was chosen. Kept as a cross-check of the fitted drift; null below eight points (a quarter would be a single sample).
 */
export function quartileShift(values: readonly number[]): number | null {
  if (values.length < 8) return null;
  const quarter = Math.floor(values.length / 4);
  return median(values.slice(-quarter)) - median(values.slice(0, quarter));
}
