import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';
import type { StreamInfo, Track } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { failure } from './fail.ts';
import { distinctAscending, middleOfSegment, repsOfTrack, segmentNumbers } from './segments.ts';
import { requestsFor } from '../support/waiting.ts';

/**
 * How far from the target a seek may land, in seconds: measured at 0.000 to 0.001 s in Chromium and WebKit (the clock is where it was
 * told to be when `seeked` fires and has not run on yet). A quarter of a second is a wide margin over that and a quarter of what a
 * landing at the start of the GOP costs: every target of the specs is the middle of a segment, a whole second from either boundary.
 */
export const SEEK_LANDING_TOLERANCE_SEC = 0.25;

/** How much media a player must play after a seek for "playback continues from the target" to be shown. */
export const CONTINUE_AFTER_SEEK_SEC = 1;

/** How far the clock may be past the position a wait was for: the wait is driven by `timeupdate` and by frames, so it overshoots by a frame or two. */
export const CLOCK_OVERSHOOT_TOLERANCE_SEC = 0.5;

export interface RecordedSeek {
  /** The cursor taken before the seek: `qa.events(since)` is the timeline of the seek and what followed. */
  since: number;
  seeking: QAEvent;
  seeked: QAEvent;
}

/**
 * Seeks and returns the `seeking` and the `seeked` events the timeline recorded for it (their media times say where the clock was
 * when the seek began and where it was when it finished). `seek()` resolves on the `seeked` that follows its own `seeking`, so both exist.
 */
export async function seekAndRecord(qa: PlayerHandle, target: number): Promise<RecordedSeek> {
  const since = await qa.cursor();
  await qa.seek(target);
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
 * The targets of five rapid seeks: positions spread over the second half of the title, forward and backward from one another, each in
 * the middle of a segment and all outside what a player two seconds in has buffered (about the first 14 s), so each needs the origin.
 * The last one differs from every other, so a player that lands on any of the others is caught (49, 21, 39, 31 and 27 s of 60).
 */
export function rapidTargets(info: StreamInfo): number[] {
  return [0.8, 0.35, 0.65, 0.5, 0.45].map((share) =>
    middleOfSegment(info, Math.floor(info.segmentCount * share) + 1),
  );
}
