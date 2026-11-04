import { chooseBig } from './sample.ts';

// Fisher's exact test for a 2 x 2 table, two-sided: the share of sessions with at least one rebuffer in arm A against arm B.
//
//                       rebuffered     not rebuffered
//     arm A               a (events)      n1 - a            n1 sessions
//     arm B               b (events)      n2 - b            n2 sessions
//                         K = a + b       N - K
//
// With the margins fixed and no difference between the arms, the number of rebuffered sessions that fall in arm A is hypergeometric:
//     P(k) = C(K, k) C(N - K, n1 - k) / C(N, n1).
// The two-sided p-value is the sum of P(k) over every table that is NO MORE LIKELY than the observed one (P(k) <= P(a)): the definition of
// R's fisher.test and scipy.stats.fisher_exact. The comparison of two probabilities is made on the exact integer numerators (BigInt), so
// two tables of equal probability are recognised as equal exactly, with no tolerance such as the 1 + 1e-7 those libraries need for floats.

/** More sessions than this and the counts leave the range of a double (C(1000, 500) is 2.7e299): nobody needs Fisher's test there. */
export const FISHER_MAX_TOTAL = 1000;

export interface Counts {
  /** Sessions with the property (at least one rebuffer). */
  events: number;
  /** Sessions in the arm. */
  total: number;
}

export interface FisherResult {
  /** Two-sided. */
  p: number;
  /** The probability of the observed table itself. */
  observedProbability: number;
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

export function fisherExact(a: Counts, b: Counts): FisherResult {
  assertCounts(a, "fisherExact: arm A's counts");
  assertCounts(b, "fisherExact: arm B's counts");
  const total = a.total + b.total;
  if (total > FISHER_MAX_TOTAL)
    throw new RangeError(`fisherExact: at most ${FISHER_MAX_TOTAL} sessions in all, got ${total}`);
  const events = a.events + b.events;
  const low = Math.max(0, events - b.total);
  const high = Math.min(a.total, events);

  const numerator = (k: number): bigint => chooseBig(a.total, k) * chooseBig(b.total, events - k);
  const observed = numerator(a.events);
  let atMostAsLikely = 0n;
  for (let k = low; k <= high; k++) {
    const candidate = numerator(k);
    if (candidate <= observed) atMostAsLikely += candidate;
  }
  const all = chooseBig(total, events);
  return {
    p: Math.min(1, Number(atMostAsLikely) / Number(all)),
    observedProbability: Number(observed) / Number(all),
  };
}
