import type { TestInfo } from '@playwright/test';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import { forcedClimb, forcedDownshift, invalidDownshiftReason, invalidRunReason } from './bans.ts';
import type { ForcedChange, ForcedDownshift } from './bans.ts';
import { firstSegmentStart, originFailures, repeatedAudioSegments } from './log.ts';
import type { VariantChange } from './variants.ts';

// The end of an attempt that cannot evaluate its claim (ADR-106). PB-ABR-002 and PB-ABR-006 claim that after the step down the player
// stays on the rung the link carries; when the player leaves it sooner than its adaptation can decide, on a load that dropped frames
// (the shape of a ban by Shaka's dropped-frame protection), the attempt has not seen the adaptation decide anything, so it is neither
// a pass nor a failure: it is skipped, with the numbers that say why, in an annotation and in an attachment, and the flake report
// counts it as a skip and not as an execution. PB-ABR-001 claims that the player holds the top rung of an unconstrained link and is
// ended the same way by a forced downshift (amendment 3 of the ADR), which the log has to prove because the interval cannot.

export interface InvalidRunInput {
  /** Every rung change of the load, in order. */
  changes: readonly VariantChange[];
  /** The timeline index of the step down (or of the settling on the rung the link carries). */
  afterIndex: number;
  carriedHeight: number;
  /** The `rep` of the rung the link carries (`v240`): its first segment in the log is where the playhead entered it. */
  carriedRep: string;
  frames: { decoded: number; dropped: number };
  log: readonly RequestLogEntry[];
  segmentDurationSec: number;
  linkKbps: number;
}

export interface InvalidRun {
  reason: string;
  climb: ForcedChange;
  /** The facts of the attachment `invalid-run.json`: what a reader needs to check the reason, and to add up invalid runs. */
  facts: Record<string, unknown>;
}

/** The invalid run the load shows, or null when it shows none: the attempt then goes on to its assertions. */
export function invalidRunOf(input: InvalidRunInput): InvalidRun | null {
  const failures = originFailures(input.log);
  const climb = forcedClimb({
    changes: input.changes,
    afterIndex: input.afterIndex,
    carriedHeight: input.carriedHeight,
    frames: input.frames,
    originFailures: failures.length,
  });
  if (!climb) return null;
  const boundaryMedia = firstSegmentStart(input.log, input.carriedRep, input.segmentDurationSec);
  const reason = invalidRunReason({
    climb,
    frames: input.frames,
    carriedHeight: input.carriedHeight,
    linkKbps: input.linkKbps,
    boundaryMedia,
  });
  return {
    reason,
    climb,
    facts: {
      reason,
      climb: {
        toHeight: climb.change.height,
        atMediaSeconds: climb.change.mediaTime,
        atPageMs: climb.change.t,
        secondsAfterTheStepDown: climb.gapSeconds,
        stepDownToHeight: climb.after.height,
        stepDownAtMediaSeconds: climb.after.mediaTime,
        stepDownAtPageMs: climb.after.t,
      },
      frames: input.frames,
      carriedHeight: input.carriedHeight,
      linkKbps: input.linkKbps,
      firstSegmentOfTheCarriedRungStartsAtMediaSeconds: boundaryMedia,
      secondsAfterThePlayheadEnteredIt:
        boundaryMedia === null ? null : climb.change.mediaTime - boundaryMedia,
      changes: input.changes,
    },
  };
}

/**
 * Ends the attempt as skipped when the load shows a forced climb, and returns when it does not. The annotation `invalid-run` and the
 * attachment `invalid-run.json` come first, because a skipped attempt gets no diagnostics from the shared fixture; the skip carries the
 * same reason, which is what the CI summary and the flake report print.
 */
export async function skipIfForcedClimb(testInfo: TestInfo, input: InvalidRunInput): Promise<void> {
  const invalid = invalidRunOf(input);
  if (!invalid) return;
  await endAsInvalidRun(testInfo, invalid.reason, invalid.facts);
}

async function endAsInvalidRun(
  testInfo: TestInfo,
  reason: string,
  facts: Record<string, unknown>,
): Promise<void> {
  testInfo.annotations.push({ type: 'invalid-run', description: reason });
  await testInfo.attach('invalid-run.json', {
    body: JSON.stringify(facts, null, 2),
    contentType: 'application/json',
  });
  testInfo.skip(true, reason);
}

export interface InvalidDownshiftInput {
  /** Every rung change of the load, in order. */
  changes: readonly VariantChange[];
  /** The timeline index of the change that reached the rung the link carries. */
  afterIndex: number;
  carriedHeight: number;
  /** The `rep` of the rung the link carries (`v720`): its first segment in the log is where the playhead entered it. */
  carriedRep: string;
  frames: { decoded: number; dropped: number };
  /** The player's errors of the load (`metrics.errors.length`). */
  playerErrors: number;
  segmentDurationSec: number;
  linkKbps: number;
  /** Reads the origin's request log. It is called only when the timeline shows a change after the rung was reached. */
  log: () => Promise<readonly RequestLogEntry[]>;
}

export interface InvalidDownshift {
  reason: string;
  downshift: ForcedDownshift;
  /** The facts of the attachment `invalid-run.json`. */
  facts: Record<string, unknown>;
}

/**
 * The invalid run that a forced downshift from the rung the link carries makes of the load, or null when it shows none: the attempt
 * then goes on to its assertions. A load with no change after the rung was reached has nothing to classify, so the log is not even read
 * (an attempt that holds the rung is the passing path of the test and is left as it was).
 */
export async function invalidDownshiftOf(input: InvalidDownshiftInput): Promise<InvalidDownshift | null> {
  if (!input.changes.some((change) => change.index > input.afterIndex)) return null;
  const log = await input.log();
  const boundaryMedia = firstSegmentStart(log, input.carriedRep, input.segmentDurationSec);
  const repeatedAudio = repeatedAudioSegments(log);
  const downshift = forcedDownshift({
    changes: input.changes,
    afterIndex: input.afterIndex,
    carriedHeight: input.carriedHeight,
    frames: input.frames,
    boundaryMedia,
    originFailures: originFailures(log).length,
    playerErrors: input.playerErrors,
    repeatedAudio,
  });
  if (!downshift) return null;
  const reason = invalidDownshiftReason({
    downshift,
    frames: input.frames,
    carriedHeight: input.carriedHeight,
    linkKbps: input.linkKbps,
  });
  return {
    reason,
    downshift,
    facts: {
      reason,
      downshift: {
        toHeight: downshift.change.height,
        atMediaSeconds: downshift.change.mediaTime,
        atPageMs: downshift.change.t,
        secondsAfterTheClimb: downshift.gapSeconds,
        climbToHeight: downshift.after.height,
        climbAtMediaSeconds: downshift.after.mediaTime,
        climbAtPageMs: downshift.after.t,
      },
      frames: input.frames,
      carriedHeight: input.carriedHeight,
      linkKbps: input.linkKbps,
      firstSegmentOfTheCarriedRungStartsAtMediaSeconds: downshift.boundaryMedia,
      secondsAfterThePlayheadEnteredIt: downshift.secondsAfterEntry,
      audioSegmentsAskedForTwice: downshift.repeatedAudio,
      changes: input.changes,
    },
  };
}

/** Ends the attempt as skipped when the load shows a forced downshift (`invalidDownshiftOf`), and returns when it does not. */
export async function skipIfForcedDownshift(testInfo: TestInfo, input: InvalidDownshiftInput): Promise<void> {
  const invalid = await invalidDownshiftOf(input);
  if (!invalid) return;
  await endAsInvalidRun(testInfo, invalid.reason, invalid.facts);
}
