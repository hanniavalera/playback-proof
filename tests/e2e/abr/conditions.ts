import type { FaultRule } from '../../../src/shared/faults.ts';

// The conditions the ABR specs set up, read back as numbers the assertions are derived from: a spec never repeats "600" or "8 s".

export type ThrottleRule = Extract<FaultRule, { type: 'throttle' }>;

/** The one throttle rule of a list of rules (a profile). The ABR scenarios have exactly one link, so two is a mistake of the spec. */
export function throttleOf(rules: readonly FaultRule[]): ThrottleRule {
  const throttles = rules.filter((rule): rule is ThrottleRule => rule.type === 'throttle');
  const [only] = throttles;
  if (throttles.length !== 1 || !only) {
    throw new Error(`expected exactly one throttle rule in the profile, found ${throttles.length}`);
  }
  return only;
}

/**
 * Shaka 5.3.3's default `abr.switchInterval`, which configuration A keeps (no override: `qa.info().configOverrides` is empty): after the
 * ABR manager has chosen a variant it does not choose again for this long. Every "the player settled" window is derived from it.
 */
export const SHAKA_SWITCH_INTERVAL_S = 8;

/**
 * How long, in media seconds, a spec watches a rung to call it settled: the switch interval (nothing can change before it has
 * elapsed) plus two segments, because the manager decides when a segment download completes, so the first decision after the interval
 * comes up to one segment later, and one more segment makes sure a decision that follows is seen. A flapping manager shows inside it.
 */
export function settleWindowSeconds(segmentDurationSec: number): number {
  return SHAKA_SWITCH_INTERVAL_S + 2 * segmentDurationSec;
}
