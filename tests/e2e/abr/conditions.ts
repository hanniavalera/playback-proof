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

/**
 * The longest, in media seconds, that the first step up may take after the link recovers, when the recovery comes right after the
 * step down: the switch interval since that decision (the manager cannot decide before), up to one segment until a download completes
 * and it decides, one more segment of samples for its estimate to cross the threshold of the next rung (each segment of the lowest
 * rung moves the slow estimate by about 80 kbps: bytes x 8 x ln 2 / its 5 s half-life), and one segment of margin. Measured in the
 * runs behind this number (Chromium and WebKit, 6000 kbps): 9.6 s; on a CI runner, in the three engines that dropped no frame: 8.2 to
 * 9.8 s. It is the bound of the link alone: where a ban can have held a rung it is `upshiftBound` in bans.ts that says how long.
 */
export function upshiftBoundSeconds(segmentDurationSec: number): number {
  return SHAKA_SWITCH_INTERVAL_S + 3 * segmentDurationSec;
}

/**
 * Shaka's other reason to leave a rung, unrelated to the network: with `abr.droppedFrames` on (the default) it disables the variant that
 * is playing for 30 s when 15 % or more of the frames of a 2 s window were dropped, and chooses another. A machine that is busy
 * decoding in software can trigger it, and a spec that sees a rung change it cannot explain by the link must say so.
 */
export function droppedFramesNote(frames: { decoded: number; dropped: number }): string {
  const ratio = frames.decoded === 0 ? 0 : (100 * frames.dropped) / frames.decoded;
  return (
    `Shaka also leaves a rung, whatever the link, when 15 % of the frames of a 2 s window are dropped (it disables that variant for 30 s); ` +
    `dropped frames in this load: ${frames.dropped} of ${frames.decoded} (${ratio.toFixed(1)} %)`
  );
}
