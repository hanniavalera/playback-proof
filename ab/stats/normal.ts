// The normal distribution, written out so that every p-value of the harness can be traced to code in this repository.
//
//   erfc(x) = 1 - erf(x) = (2 / sqrt(pi)) * integral from x to infinity of exp(-t^2) dt
//   Phi(z)  = P(Z <= z) = erfc(-z / sqrt(2)) / 2                    (Z standard normal)
//
// Two evaluations that overlap on [1.5, 3], so each is checked against the other and both against published values:
//   - for x < 2 the series erf(x) = (2/sqrt(pi)) exp(-x^2) * sum_{n>=0} 2^n x^(2n+1) / (1 * 3 * ... * (2n+1)), whose terms are all positive
//     (no cancellation), and erfc = 1 - erf;
//   - for x >= 2 Laplace's continued fraction  erfc(x) = exp(-x^2) / sqrt(pi) * 1 / (x + (1/2) / (x + (2/2) / (x + (3/2) / (x + ...)))),
//     evaluated from a fixed depth backwards, which keeps the relative precision of a tail of 1e-12 or less.
// Relative error: about 1e-14 over the range that matters for a p-value.

const SQRT_PI = Math.sqrt(Math.PI);
const SERIES_BELOW = 2;
const FRACTION_DEPTH = 120;

function erfSeries(x: number): number {
  const squareTwice = 2 * x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 400; n++) {
    term *= squareTwice / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return (2 / SQRT_PI) * Math.exp(-x * x) * sum;
}

function erfcFraction(x: number): number {
  let tail = x;
  for (let k = FRACTION_DEPTH; k >= 1; k--) tail = x + k / 2 / tail;
  return Math.exp(-x * x) / SQRT_PI / tail;
}

/** The complementary error function, for any finite x (and +-Infinity). */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x === 0) return 1;
  if (x > 27) return 0;
  return x < SERIES_BELOW ? 1 - erfSeries(x) : erfcFraction(x);
}

/** The two evaluations of `erfc`, exposed so that a test can check them against each other where both are valid. */
export const erfcParts = { series: (x: number): number => 1 - erfSeries(x), fraction: erfcFraction };

/** Phi(z): the probability that a standard normal variable is at most z. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** 1 - Phi(z), computed without cancellation in the upper tail. */
export function normalSurvival(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/** The two-sided tail probability of a standard normal: P(|Z| >= |z|). */
export function twoSidedNormalP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}

/**
 * The z with Phi(z) = p, for 0 < p < 1, found by bisection on `normalCdf` (200 halvings: the answer is exact to the last bit of a double).
 * Slower than a rational approximation and needs no table of coefficients: it is only used to turn a confidence level into its z.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1))
    throw new RangeError(`normalQuantile: p must be strictly between 0 and 1, got ${String(p)}`);
  let low = -40;
  let high = 40;
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (normalCdf(middle) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
