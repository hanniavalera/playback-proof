import { normalQuantile } from './normal.ts';
import type { Counts } from './fisher.ts';

// Intervals for proportions: the share of sessions that rebuffered, and the difference between two shares.
//
// WILSON SCORE INTERVAL for x events in n sessions at confidence level c, z = the standard normal quantile of (1 + c) / 2, p^ = x / n:
//     centre = (p^ + z^2 / 2n) / (1 + z^2 / n)        half-width = z sqrt( p^ (1 - p^) / n + z^2 / 4 n^2 ) / (1 + z^2 / n)
// Its two ends are the two values of p for which (p^ - p)^2 = z^2 p (1 - p) / n: the proportions a test at the chosen level would not
// reject. Unlike the textbook p^ +- z sqrt(p^ (1 - p^) / n) it stays inside [0, 1] and does not collapse to a point at x = 0 or x = n.
//
// NEWCOMBE'S HYBRID SCORE INTERVAL for the difference d = p_B - p_A (Newcombe 1998, "method 10"): with the Wilson intervals (l_A, u_A) and
// (l_B, u_B) of the two shares,
//     lower = d - sqrt( (p_B - l_B)^2 + (u_A - p_A)^2 )        upper = d + sqrt( (u_B - p_B)^2 + (p_A - l_A)^2 )
// A closed form with no seed, whose coverage is close to nominal even for 30 sessions per arm and shares near 0 or 1, where a percentile
// bootstrap of a 0/1 variable is discrete and rough. The share of sessions with a rebuffer is exactly that kind of variable.

export interface Interval {
  lower: number;
  upper: number;
}

export interface ProportionDifference extends Interval {
  /** p_B - p_A. */
  difference: number;
  level: number;
}

function zFor(level: number): number {
  if (!(level > 0 && level < 1))
    throw new RangeError(`the confidence level must be strictly between 0 and 1, got ${String(level)}`);
  return normalQuantile((1 + level) / 2);
}

function assertCounts(counts: Counts, what: string): void {
  if (!Number.isInteger(counts.total) || counts.total < 1)
    throw new RangeError(
      `${what}: the number of sessions must be a positive integer, got ${String(counts.total)}`,
    );
  if (!Number.isInteger(counts.events) || counts.events < 0 || counts.events > counts.total)
    throw new RangeError(
      `${what}: the number of events must be an integer from 0 to ${counts.total}, got ${String(counts.events)}`,
    );
}

/** The Wilson score interval of `events` in `total` sessions. */
export function wilsonInterval(counts: Counts, level = 0.95): Interval {
  assertCounts(counts, 'wilsonInterval');
  const z = zFor(level);
  const n = counts.total;
  const share = counts.events / n;
  const denominator = 1 + (z * z) / n;
  const centre = (share + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((share * (1 - share)) / n + (z * z) / (4 * n * n))) / denominator;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Newcombe's hybrid score interval for the share of arm B minus the share of arm A. */
export function newcombeDifference(a: Counts, b: Counts, level = 0.95): ProportionDifference {
  assertCounts(a, "newcombeDifference: arm A's counts");
  assertCounts(b, "newcombeDifference: arm B's counts");
  const shareA = a.events / a.total;
  const shareB = b.events / b.total;
  const wilsonA = wilsonInterval(a, level);
  const wilsonB = wilsonInterval(b, level);
  const difference = shareB - shareA;
  return {
    difference,
    lower: difference - Math.sqrt((shareB - wilsonB.lower) ** 2 + (wilsonA.upper - shareA) ** 2),
    upper: difference + Math.sqrt((wilsonB.upper - shareB) ** 2 + (shareA - wilsonA.lower) ** 2),
    level,
  };
}
