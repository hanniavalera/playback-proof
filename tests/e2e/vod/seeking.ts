import { expect } from '@playwright/test';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';
import type { StreamInfo, Track } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { describeEntry, requestsFor } from '../support/waiting.ts';
import { checked, failure } from './fail.ts';
import { distinctAscending, middleOfSegment, repsOfTrack, segmentNumbers } from './segments.ts';
import {
  CLOCK_OVERSHOOT_TOLERANCE_SEC,
  SEEK_LANDING_TOLERANCE_SEC,
  UNBUFFERED_FROM_SEC,
} from './tolerances.ts';

/** How many of the origin's last requests a failure message of a seek lists. */
const ORIGIN_LINES_IN_MESSAGES = 8;

export interface RecordedSeek {
  /** The cursor taken before the seek: `qa.events(since)` is the timeline of the seek and what followed. */
  since: number;
  seeking: QAEvent;
  seeked: QAEvent;
}

/**
 * Seeks and returns the `seeking` and the `seeked` events the timeline recorded for it (their media times say where the clock was
 * when the seek began and where it was when it finished). `seek()` resolves on the `seeked` that follows its own `seeking`, so both exist.
 * When the seek does not finish, `origin` (the session and the log cursor taken before the seek) lets the message say what the origin
 * was asked for and what it answered since: a seek that waits for a segment the origin refused is the most common reason.
 */
export async function seekAndRecord(
  qa: PlayerHandle,
  target: number,
  origin?: { session: TestSession; logCursor: number },
): Promise<RecordedSeek> {
  const since = await qa.cursor();
  try {
    await qa.seek(target);
  } catch (error) {
    throw failure(`${(error as Error).message}${origin ? await describeOriginSince(origin) : ''}`);
  }
  const events = await qa.events(since);
  const seeking = events.find((event) => event.name === 'seeking');
  const seeked = seeking && events.find((event) => event.name === 'seeked' && event.index > seeking.index);
  if (!seeking || !seeked) {
    throw failure(
      `seek(${target}) resolved but the timeline has no seeking and seeked pair after index ${since}: ${events.map((event) => event.name).join(', ')}`,
    );
  }
  return { since, seeking, seeked };
}

/** The last requests of the origin's log since a cursor, as lines of a failure message (empty when the log cannot be read). */
export async function describeOriginSince(origin: {
  session: TestSession;
  logCursor: number;
}): Promise<string> {
  try {
    const { after } = await logAround(origin.session, origin.logCursor);
    if (after.length === 0) return '\nThe origin was not asked for anything since the seek.';
    const last = after.slice(-ORIGIN_LINES_IN_MESSAGES).map((entry) => `  ${describeEntry(entry)}`);
    return `\nThe origin was asked for ${after.length} requests since the seek, the last ${last.length}:\n${last.join('\n')}`;
  } catch {
    return '';
  }
}

/** The seek finished where it was asked to: the media time of its `seeked` event is within `SEEK_LANDING_TOLERANCE_SEC` of the target. */
export function expectLanded(seeked: Pick<QAEvent, 'mediaTime'>, target: number): void {
  checked(() => {
    expect(
      Math.abs(seeked.mediaTime - target),
      `distance in seconds between the media time of the seeked event (${seeked.mediaTime} s) and the target (${target} s)`,
    ).toBeLessThanOrEqual(SEEK_LANDING_TOLERANCE_SEC);
  });
}

/** The clock moved on continuously: a wait for `waitedFor` seconds of media time returned `reached`, and a jump of the clock would have taken it far beyond. */
export function expectClockContinued(reached: number, waitedFor: number, explanation: string): void {
  checked(() => {
    expect(
      reached - waitedFor,
      `media time reached (${reached} s) beyond the ${waitedFor} s the wait was for: ${explanation}`,
    ).toBeLessThanOrEqual(CLOCK_OVERSHOOT_TOLERANCE_SEC);
  });
}

/** The log of a session split at a cursor (`requestLogCursor`): what the origin had been asked for by then, and what it was asked for since. */
export async function logAround(
  session: TestSession,
  cursor: number,
): Promise<{ before: RequestLogEntry[]; after: RequestLogEntry[] }> {
  const log = await session.service.log(session.id);
  return {
    before: log.filter((entry) => entry.seq <= cursor),
    after: log.filter((entry) => entry.seq > cursor),
  };
}

type Around = { before: readonly RequestLogEntry[]; after: readonly RequestLogEntry[] };

const segmentRequests = (
  log: readonly RequestLogEntry[],
  info: StreamInfo,
  track: Track,
): RequestLogEntry[] => requestsFor(log, { kind: 'segment', rep: repsOfTrack(info, track) });

/**
 * The segments of a track that were requested before a point and again after it from the SAME representation (`['v720#3']`): a
 * refetch, a segment the player already had. The same number from ANOTHER representation is not one: it is the adaptation (WebKit
 * climbs a rung about a second in, and Shaka replaces what it had buffered at the lower rung with the higher one).
 */
export function refetched(info: StreamInfo, track: Track, around: Around): string[] {
  const label = (entry: RequestLogEntry): string => `${entry.rep}#${entry.number}`;
  const had = new Set(segmentRequests(around.before, info, track).map(label));
  return [...new Set(segmentRequests(around.after, info, track).map(label))].filter((request) =>
    had.has(request),
  );
}

/** The segment numbers of a track requested before a point and again after it, from whichever representation: the buffer did not hold them. */
export function fetchedAgain(info: StreamInfo, track: Track, around: Around): number[] {
  const had = new Set(segmentNumbers(around.before, info, track));
  return distinctAscending(segmentNumbers(around.after, info, track).filter((number) => had.has(number)));
}

/** Two thirds of the way through the title, in the middle of a segment: far from what a player that started at 0 has buffered (41 s of 60). */
export function farTarget(info: StreamInfo): number {
  return middleOfSegment(info, Math.floor((info.segmentCount * 2) / 3) + 1);
}

/**
 * The targets of five rapid seeks: segments spread over the part of the title that a player a few seconds in has not buffered (its
 * playhead plus about twelve seconds, so from the 16th second on) and that is not the last segment, forward and backward from one
 * another, each aimed at the middle of its segment, so each needs the origin. The last one differs from every other, so a player that
 * lands on any of the others is caught (57, 17, 47, 27 and 37 s of 60; 27, 17, 25, 19 and 23 s of 30).
 */
export function rapidTargets(info: StreamInfo): number[] {
  const first = Math.ceil(UNBUFFERED_FROM_SEC / info.segmentDurationSec) + 1;
  const candidates = Array.from({ length: info.segmentCount - 1 - first + 1 }, (_, index) => first + index);
  return [1, 0, 0.75, 0.25, 0.5].map((share) =>
    middleOfSegment(info, candidates[Math.round(share * (candidates.length - 1))] as number),
  );
}
