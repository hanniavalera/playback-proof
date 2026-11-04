import { assertSample } from './sample.ts';

// Holm's step-down procedure (Holm 1979): the correction for looking at several metrics at once. It controls the probability of at least
// one false positive among them (the family-wise error rate) at alpha, under any dependence between the tests, and is never less
// powerful than Bonferroni.
//
// With m p-values sorted ascending, p(1) <= ... <= p(m), the ADJUSTED p-values are
//     adjusted(k) = min(1, max over i <= k of ( (m - i + 1) * p(i) ))
// so that "adjusted < alpha" rejects exactly the hypotheses that the sequential rule rejects ("reject p(1) if p(1) <= alpha / m, then p(2) if
// p(2) <= alpha / (m - 1), and stop at the first one that is not"). The running maximum is what makes the adjusted values monotone: a
// hypothesis with a larger p-value can never end up with a smaller adjusted p-value than one with a smaller p-value. Ties in the p-values
// are taken in the order they were given; they receive the same adjusted value anyway.

/** The Holm-adjusted p-values, in the order the p-values were given. */
export function holmAdjust(pValues: readonly number[]): number[] {
  assertSample(pValues, 'holmAdjust: the p-values');
  for (const [index, p] of pValues.entries()) {
    if (p < 0 || p > 1) throw new RangeError(`holmAdjust: p-value ${index} is ${p}, not a probability`);
  }
  const m = pValues.length;
  const order = pValues
    .map((_, index) => index)
    .sort((x, y) => (pValues[x] as number) - (pValues[y] as number) || x - y);
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach((index, rank) => {
    running = Math.max(running, (m - rank) * (pValues[index] as number));
    adjusted[index] = Math.min(1, running);
  });
  return adjusted;
}
