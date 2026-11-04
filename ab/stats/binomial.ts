// The exact (Clopper-Pearson) confidence interval of a binomial proportion: x events in n trials. It is the interval that reports how well
// the false-positive rate of the A/A calibration is known: "117 of 2000 splits were declared significant" has a share of 5.85 % and an
// interval, and the harness is judged on the interval, not on the point.
//
// For x events in n trials and a level c, with a = (1 - c) / 2:
//     lower = the p for which P(X >= x | n, p) = a            (0 when x = 0)
//     upper = the p for which P(X <= x | n, p) = a            (1 when x = n)
// Both tails are monotone in p, so each bound is found by bisection. "Exact" means guaranteed coverage of at least c, never less (it is
// conservative: the true coverage is a little above c).

const LOG_FACTORIALS: number[] = [0];

function logFactorial(n: number): number {
  for (let i = LOG_FACTORIALS.length; i <= n; i++)
    LOG_FACTORIALS.push((LOG_FACTORIALS[i - 1] as number) + Math.log(i));
  return LOG_FACTORIALS[n] as number;
}

/** log P(X = k) for X binomial with n trials and success probability p, 0 < p < 1. */
function logPmf(k: number, n: number, p: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

/** P(X <= k) for a binomial variable, summed from its probability mass function. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(logPmf(i, n, p));
  return Math.min(1, sum);
}

export interface BinomialInterval {
  lower: number;
  upper: number;
  level: number;
}

/** The p at which `fallingInP`, a function that falls from 1 to 0 as p goes from 0 to 1, equals `target`. */
function solveFalling(fallingInP: (p: number) => number, target: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 100; i++) {
    const middle = (low + high) / 2;
    if (fallingInP(middle) > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function clopperPearson(events: number, trials: number, level = 0.95): BinomialInterval {
  if (!Number.isInteger(trials) || trials < 1)
    throw new RangeError(
      `clopperPearson: the number of trials must be a positive integer, got ${String(trials)}`,
    );
  if (!Number.isInteger(events) || events < 0 || events > trials)
    throw new RangeError(
      `clopperPearson: the number of events must be an integer from 0 to ${trials}, got ${String(events)}`,
    );
  if (!(level > 0 && level < 1))
    throw new RangeError(`the confidence level must be strictly between 0 and 1, got ${String(level)}`);
  const tail = (1 - level) / 2;
  // P(X >= x | p) = tail is P(X <= x - 1 | p) = 1 - tail, and that falls as p rises; so does P(X <= x | p) for the upper bound.
  const lower = events === 0 ? 0 : solveFalling((p) => binomialCdf(events - 1, trials, p), 1 - tail);
  const upper = events === trials ? 1 : solveFalling((p) => binomialCdf(events, trials, p), tail);
  return { lower, upper, level };
}
