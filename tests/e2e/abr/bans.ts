import { SHAKA_SWITCH_INTERVAL_S, droppedFramesNote, upshiftBoundSeconds } from './conditions.ts';
import type { VariantChange } from './variants.ts';

// Shaka's temporary bans: the one thing besides the link that keeps a rung out of the player's reach, and the reason the first step up
// after a recovery can come later than the arithmetic of the link says. The evidence is in ADR-095 (docs/decisions/e2e-abr.md): two
// failed attempts of PB-ABR-003 on a GitHub macOS runner, where the page dropped 37 and 40 of 1,200 frames and the step up came 21.9 and
// 16.4 s after the recovery, against 7.8 to 9.9 s in every engine on a machine that dropped none.

/**
 * Shaka 5.3.3's dropped-frame protection and its defaults (`abr.droppedFrames` and `abr.advanced.droppedFrames*`), which configuration A
 * keeps. Every `checkSeconds` the ABR manager compares the frames dropped with the frames rendered since its last look and, at
 * `threshold` or more, calls `Player.disableStream`: every variant that uses the playing video stream is out of the choice for
 * `banSeconds`, and the player chooses again at once, without waiting for the switch interval. `Player.checkVariants_` gives the
 * variants back on a timer of `reenableTickSeconds` and chooses again, at once, when it does.
 */
export const DROPPED_FRAME_PROTECTION = {
  checkSeconds: 2,
  threshold: 0.15,
  banSeconds: 30,
  reenableTickSeconds: 1,
} as const;

/**
 * The longest, in media seconds, that a ban can keep the player from stepping up after the link recovers. A ban that was in force when
 * the link recovered began no later than the recovery, so it ends within `banSeconds` of it, and the player is told within
 * `reenableTickSeconds` of that and chooses at once, from an estimate that has had all this time to learn the recovered link (the bound
 * without a ban, 14 s, is less than half of it). One segment of margin, as in the bound of the link. The bans of every rung above the
 * one the player is on end by then, whatever the order they began in. Measured in the two failed attempts: 21.9 s (the first ban ended
 * 30.1 s after it began) and 16.4 s (the rung above was banned, and the estimate had to reach the top rung's own threshold).
 */
export function banBoundSeconds(segmentDurationSec: number): number {
  const { banSeconds, reenableTickSeconds } = DROPPED_FRAME_PROTECTION;
  return banSeconds + reenableTickSeconds + segmentDurationSec;
}

/**
 * How much sooner than the switch interval the page clock may show two decisions of the adaptation, in seconds. The manager chooses
 * at least `abr.switchInterval` after the choice before it; the hook records a change a moment after the decision (Shaka delays its
 * event), so two consecutive decisions can read a little under the interval.
 */
export const DECISION_JITTER_S = 0.25;

export interface ForcedChange {
  change: VariantChange;
  /** The change before it. */
  after: VariantChange;
  /** Seconds of the page clock between the two. */
  gapSeconds: number;
}

/**
 * The changes Shaka made sooner after the previous change than its switch interval allows. The adaptation decides at most once per
 * `abr.switchInterval` (and every choice, a ban's included, restarts the wait), so a change that comes sooner after another change of
 * the player's own was not a decision about the link: it was forced, by a ban or by a failover. The first change after the initial
 * selection is exempt (Shaka's start-up shortcut lets the first decision through at once), and so is a change the page asked for.
 * This is a proof and not a test: a ban that comes a full interval after the change before it is not found.
 */
export function forcedChanges(changes: readonly VariantChange[]): ForcedChange[] {
  const forced: ForcedChange[] = [];
  let previous: VariantChange | undefined;
  for (const change of changes) {
    if (previous?.reason === 'abr' && change.reason === 'abr') {
      const gapSeconds = (change.t - previous.t) / 1000;
      if (gapSeconds < SHAKA_SWITCH_INTERVAL_S - DECISION_JITTER_S) {
        forced.push({ change, after: previous, gapSeconds });
      }
    }
    previous = change;
  }
  return forced;
}

/** `240p at media time 21.91 s, 4.9 s after the change before it`. */
export function describeForcedChanges(forced: readonly ForcedChange[]): string {
  return forced
    .map(
      ({ change, gapSeconds }) =>
        `${change.height}p at media time ${change.mediaTime.toFixed(2)} s, ${gapSeconds.toFixed(1)} s after the change before it`,
    )
    .join('; ');
}

/**
 * What a failure message says about bans: the dropped frames of the load (Shaka's reason to ban) and, when the timeline proves one,
 * the changes that came sooner than the switch interval allows.
 */
export function banNote(
  frames: { decoded: number; dropped: number },
  changes: readonly VariantChange[],
): string {
  const forced = forcedChanges(changes);
  if (forced.length === 0) return droppedFramesNote(frames);
  return (
    `${droppedFramesNote(frames)}. Changes that came sooner than the ${SHAKA_SWITCH_INTERVAL_S} s the adaptation waits between ` +
    `decisions were not decisions about the link, they were forced (a ban): ${describeForcedChanges(forced)}`
  );
}

export interface RunEvidence {
  frames: { decoded: number; dropped: number };
  /** The rung changes of the load from its start to the recovery. */
  changesBeforeRecovery: readonly VariantChange[];
}

/**
 * Why a ban may have been in force when the link recovered, from what the spec can see; an empty list says none can have been.
 * (1) Any dropped frame: a ban needs 15 % of the frames of one 2 s window, and the window after a rung change or after a stall holds
 * only the few frames rendered since, so no number of drops above zero is a safe lower limit. (2) A change that the switch interval
 * proves was forced. Both are about the whole load up to the step up, which includes every moment a ban can have begun.
 */
export function banEvidence(run: RunEvidence): string[] {
  const reasons: string[] = [];
  if (run.frames.dropped > 0) {
    reasons.push(`${run.frames.dropped} of ${run.frames.decoded} frames were dropped`);
  }
  const forced = forcedChanges(run.changesBeforeRecovery);
  if (forced.length > 0) {
    reasons.push(`a change came sooner than the switch interval allows (${describeForcedChanges(forced)})`);
  }
  return reasons;
}

export interface UpshiftBound {
  /** `link`: only the link and the adaptation's clock can delay the step up. `ban`: a ban may also have held the rungs above. */
  regime: 'link' | 'ban';
  /** Media seconds from the recovery to the first step up. */
  seconds: number;
  /** The sentence for the message of the assertion: why this bound. */
  basis: string;
}

/**
 * The bound on the first step up after the recovery, from the evidence of the run. Where no ban can have been in force it is the bound
 * of the link: the switch interval and three segments, 14 s; measured 7.8 to 9.9 s in the four engines. Where one may have been it is
 * the bound of the ban, `banBoundSeconds`: 33 s. A player that does not climb, or climbs after a minute, fails in both.
 */
export function upshiftBound(segmentDurationSec: number, evidence: readonly string[]): UpshiftBound {
  const link = upshiftBoundSeconds(segmentDurationSec);
  if (evidence.length === 0) {
    return {
      regime: 'link',
      seconds: link,
      basis: `no frame was dropped and no change came sooner than the switch interval allows, so no ban can have held a rung: the switch interval and three segments (${link} s)`,
    };
  }
  const { banSeconds, reenableTickSeconds } = DROPPED_FRAME_PROTECTION;
  const ban = banBoundSeconds(segmentDurationSec);
  return {
    regime: 'ban',
    seconds: Math.max(link, ban),
    basis:
      `a ban may have held the rungs above (${evidence.join('; ')}): Shaka's ban lasts ${banSeconds} s and the player is told within ` +
      `${reenableTickSeconds} s of its end, plus one segment (${ban} s); the bound without a ban is ${link} s`,
  };
}

/**
 * How long the step up is waited for, in ms: the bound of the ban plus ten seconds for the stalls that media time does not count.
 * A bound for a failure, never the pace of a test.
 */
export function upshiftWaitMs(segmentDurationSec: number): number {
  return Math.round((banBoundSeconds(segmentDurationSec) + 10) * 1000);
}

// ---------------------------------------------------------------------------------------------------------------------
// A climb that the adaptation cannot have decided (the shape of a ban by the dropped-frame protection): an attempt that cannot say
// whether the player flaps (ADR-106). The two settle checks of the lab (PB-ABR-002, PB-ABR-006: "no rung change in the window after
// the step down") are claims about the link; a change that is not a decision about it leaves the attempt it happens in without an
// evaluation of the claim.

export interface ClimbEvidence {
  /** Every rung change of the load, in order (`variantChanges(await qa.events())`). */
  changes: readonly VariantChange[];
  /** The timeline index of the step down: only what came after it is looked at. */
  afterIndex: number;
  /** The height of the best rung the link carries: a change above it is a rung the link cannot justify. */
  carriedHeight: number;
  frames: { decoded: number; dropped: number };
  /** `originFailures(log).length`: the other way Shaka disables a rung is a failed request, which is no frame-drop ban. */
  originFailures: number;
}

/**
 * The first change after the step down, when it is a climb that the adaptation cannot have decided (a ban by the dropped-frame
 * protection fits it): all of
 *  - it is the FIRST change after the step down: the first thing that contradicts the claim decides, so a real flap that comes first
 *    is never hidden by a forced change that follows it;
 *  - it is a change Shaka made itself (`abr`) after a change of its own (`abr`);
 *  - it is to a rung ABOVE the one the link carries: a climb the link cannot justify (a change between carried rungs is not one);
 *  - it came sooner than the switch interval after the change before it: the adaptation decides at most once per interval, so a
 *    change that comes sooner was not its decision (the jitter of the clocks is allowed, as in `forcedChanges`);
 *  - the load dropped frames: the protection has nothing to act on without them;
 *  - no response of the origin failed: the only other path in Shaka 5.3.3 that skips the interval is the disabling of a rung after a
 *    failed request.
 * A proof of exclusion and not of cause: it says "this was not the adaptation", which is enough to say the attempt cannot evaluate the
 * claim; a forced climb that comes a full interval after the step down, or on a load that dropped no frame, is not found, and the test
 * fails as it always did.
 */
export function forcedClimb(evidence: ClimbEvidence): ForcedChange | null {
  const position = evidence.changes.findIndex((change) => change.index > evidence.afterIndex);
  if (position < 1) return null;
  const change = evidence.changes[position];
  const previous = evidence.changes[position - 1];
  if (!change || !previous) return null;
  if (previous.reason !== 'abr' || change.reason !== 'abr') return null;
  if (change.height <= evidence.carriedHeight) return null;
  const gapSeconds = (change.t - previous.t) / 1000;
  if (gapSeconds >= SHAKA_SWITCH_INTERVAL_S - DECISION_JITTER_S) return null;
  if (evidence.frames.dropped <= 0) return null;
  if (evidence.originFailures > 0) return null;
  return { change, after: previous, gapSeconds };
}

export interface InvalidRunFacts {
  climb: ForcedChange;
  frames: { decoded: number; dropped: number };
  carriedHeight: number;
  /** The rate of the link the spec set up. */
  linkKbps: number;
  /** The media time at which the first segment of the rung the player stepped down to starts (`firstSegmentStart`), or null. */
  boundaryMedia: number | null;
}

/**
 * The reason of an invalid run, for the `skip` and `invalid-run` annotations. The numbers come first, because the flake report cuts a
 * cell at 90 characters; the sentence after them says what it means. When the request log gives it, it also says how long after the
 * playhead entered the first segment of the rung the climb came: the number that tests the hypothesis of ADR-106 on every invalid run.
 */
export function invalidRunReason(facts: InvalidRunFacts): string {
  const { climb, frames, carriedHeight, linkKbps, boundaryMedia } = facts;
  const { change, gapSeconds } = climb;
  const head = `invalid run: forced climb to ${change.height}p ${gapSeconds.toFixed(1)} s after the step down, ${frames.dropped} of ${frames.decoded} frames dropped`;
  const entered =
    boundaryMedia === null
      ? ''
      : `, ${(change.mediaTime - boundaryMedia).toFixed(1)} s after the playhead entered the first ${carriedHeight}p segment (media time ${boundaryMedia.toFixed(1)} s)`;
  return (
    `${head}. The ${SHAKA_SWITCH_INTERVAL_S} s switch interval allows no decision of the adaptation that soon after the step down, and ` +
    `the load dropped frames: Shaka's dropped-frame protection, which bans the rung that plays for ${DROPPED_FRAME_PROTECTION.banSeconds} s, ` +
    `fits, and it leaves only rungs above the ${carriedHeight}p that the ${linkKbps} kbps link carries, so this attempt cannot say ` +
    `whether the player flaps (ADR-106). The climb is at media time ${change.mediaTime.toFixed(2)} s${entered}.`
  );
}
