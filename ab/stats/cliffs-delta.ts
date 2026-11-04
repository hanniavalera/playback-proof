import { assertSample } from './sample.ts';

// Cliff's delta: how often a session of arm B is larger than a session of arm A, minus how often it is smaller. A scale-free effect size
// with no assumption about the shape of the data, and the natural companion of the Mann-Whitney test (it is the same pairs).
//
//   delta = ( #{(i, j): b_j > a_i} - #{(i, j): b_j < a_i} ) / (n1 n2)            in [-1, 1]
//         = 2 U_B / (n1 n2) - 1                                                    (U_B counts a tie as one half)
//
// The sign follows the Hodges-Lehmann shift: delta > 0 means B tends to be LARGER than A (for startup time and rebuffering, worse).
// A delta of 0 does not mean no difference in size, only no tendency for one arm to exceed the other.
//
// MAGNITUDE LABELS, the conventional ones of Romano, Kromrey, Coraggio and Skowronek (2006), who mapped Cohen's d of 0.2, 0.5 and 0.8 onto
// the delta of two normal distributions: |delta| < 0.147 negligible, < 0.33 small, < 0.474 medium, otherwise large. The labels describe
// the size of a tendency; they say nothing about whether a difference is worth a change (that is the practical threshold of the
// pre-registration) or whether it is statistically detectable (the p-value).

export type CliffsLabel = 'negligible' | 'small' | 'medium' | 'large';

export const CLIFFS_BOUNDS = { negligible: 0.147, small: 0.33, medium: 0.474 } as const;

export interface CliffsDelta {
  delta: number;
  label: CliffsLabel;
}

/** The conventional label of a delta (the sign is ignored). */
export function cliffsLabel(delta: number): CliffsLabel {
  const size = Math.abs(delta);
  if (size < CLIFFS_BOUNDS.negligible) return 'negligible';
  if (size < CLIFFS_BOUNDS.small) return 'small';
  if (size < CLIFFS_BOUNDS.medium) return 'medium';
  return 'large';
}

/** Cliff's delta of B against A, counted pair by pair from the definition. */
export function cliffsDelta(a: readonly number[], b: readonly number[]): CliffsDelta {
  assertSample(a, "cliffsDelta: arm A's sample");
  assertSample(b, "cliffsDelta: arm B's sample");
  let greater = 0;
  let smaller = 0;
  for (const x of a) {
    for (const y of b) {
      if (y > x) greater += 1;
      else if (y < x) smaller += 1;
    }
  }
  const delta = (greater - smaller) / (a.length * b.length);
  return { delta, label: cliffsLabel(delta) };
}
