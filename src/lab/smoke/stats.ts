// Binomial arithmetic for "N runs, k failures: how far does that evidence go?". Pure, so it is unit-tested against known values.

function logFactorials(n: number): number[] {
  const table = [0];
  for (let i = 1; i <= n; i++) table.push((table[i - 1] ?? 0) + Math.log(i));
  return table;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lf = logFactorials(n);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    const logTerm =
      (lf[n] ?? 0) - (lf[i] ?? 0) - (lf[n - i] ?? 0) + i * Math.log(p) + (n - i) * Math.log(1 - p);
    sum += Math.exp(logTerm);
  }
  return Math.min(1, sum);
}

/**
 * The exact (Clopper-Pearson) one-sided upper confidence bound of a failure rate: the largest rate p that still has a
 * probability of at least `1 - confidence` of producing k or fewer failures in n runs. With 0 failures in 20 runs and 95 %
 * confidence it is 13.9 %: the evidence cannot rule out that one run in seven fails.
 */
export function upperBound(failures: number, runs: number, confidence = 0.95): number {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`runs must be an integer >= 1, got ${runs}`);
  if (!Number.isInteger(failures) || failures < 0 || failures > runs) {
    throw new RangeError(`failures must be an integer between 0 and ${runs}, got ${failures}`);
  }
  if (!(confidence > 0 && confidence < 1))
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  if (failures === runs) return 1;
  const alpha = 1 - confidence;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    // P(X <= k) falls as p rises: the bound is where it crosses alpha.
    if (binomialCdf(failures, runs, mid) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

/** The "rule of three": with 0 failures in n runs, the 95 % upper bound is about 3 / n. Quoted next to the exact value. */
export function ruleOfThree(runs: number): number {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`runs must be an integer >= 1, got ${runs}`);
  return Math.min(1, 3 / runs);
}

/** `<passes>/<runs> passed (<rate>); failure rate <rate>, 95 % upper bound <rate>`, with the rule of three added when nothing failed. */
export function describeEvidence(passes: number, runs: number): string {
  const failures = runs - passes;
  const rate = (value: number): string => `${(value * 100).toFixed(1)} %`;
  let text = `${passes}/${runs} passed (${rate(passes / runs)}); failure rate ${rate(failures / runs)}, 95 % upper bound ${rate(upperBound(failures, runs))}`;
  if (failures === 0) text += ` (rule of three: ${rate(ruleOfThree(runs))})`;
  return text;
}
