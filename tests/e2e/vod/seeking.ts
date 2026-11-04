import { expect } from '@playwright/test';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';
import type { StreamInfo, Track } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { describeEntry, requestsFor } from '../support/waiting.ts';
import { checked, failure } from './fail.ts';
import { videoFrameRate } from './instrument.ts';
import { distinctAscending, middleOfSegment, repsOfTrack, segmentNumbers } from './segments.ts';
import { CLOCK_RESOLUTION_MS, RESTART_CLOCK_STEP_SEC, UNBUFFERED_FROM_SEC } from './tolerances.ts';

/** How many of the origin's last requests a failure message of a seek lists. */
const ORIGIN_LINES_IN_MESSAGES = 8;

/**
 * A stopwatch on the wall clock of THIS process: call it to read the milliseconds since it was created. Start it before the call that
 * begins a span of the media clock and read it after the reading that ends the span: it brackets whatever the page did in between, however
 * late the page did it (`expectClockPace`).
 */
export function stopwatch(): () => number {
  const startedAt = performance.now();
  return () => performance.now() - startedAt;
}

export interface RecordedSeek {
  /** The cursor taken before the seek: `qa.events(since)` is the timeline of the seek and what followed. */
  since: number;
  seeking: QAEvent;
  seeked: QAEvent;
  /** Milliseconds of the wall clock of this process from just before `seek()` was called to just after it resolved. */
  wallMs: number;
  /** The stopwatch that `wallMs` was read from: read it again after what follows the seek (a wait for the clock) to bracket that too. */
  elapsed: () => number;
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
  const elapsed = stopwatch();
  try {
    await qa.seek(target);
  } catch (error) {
    throw failure(`${(error as Error).message}${origin ? await describeOriginSince(origin) : ''}`);
  }
  const wallMs = elapsed();
  const events = await qa.events(since);
  const seeking = events.find((event) => event.name === 'seeking');
  const seeked = seeking && events.find((event) => event.name === 'seeked' && event.index > seeking.index);
  if (!seeking || !seeked) {
    throw failure(
      `seek(${target}) resolved but the timeline has no seeking and seeked pair after index ${since}: ${events.map((event) => event.name).join(', ')}`,
    );
  }
  return { since, seeking, seeked, wallMs, elapsed };
}

/**
 * The last requests of the origin's log since a cursor, as lines of a failure message (empty when the log cannot be read). `since` says
 * what the cursor was taken before, for the sentence: the seek by default.
 */
export async function describeOriginSince(
  origin: {
    session: TestSession;
    logCursor: number;
  },
  since = 'the seek',
): Promise<string> {
  try {
    const { after } = await logAround(origin.session, origin.logCursor);
    if (after.length === 0) return `\nThe origin was not asked for anything since ${since}.`;
    const last = after.slice(-ORIGIN_LINES_IN_MESSAGES).map((entry) => `  ${describeEntry(entry)}`);
    return `\nThe origin was asked for ${after.length} requests since ${since}, the last ${last.length}:\n${last.join('\n')}`;
  } catch {
    return '';
  }
}

/** One video frame period and the resolution of the clocks compared, in seconds: the slack of every comparison of two readings of the media clock. */
function slackSec(info: StreamInfo): number {
  return 1 / videoFrameRate(info) + CLOCK_RESOLUTION_MS / 1000;
}

/** How far ahead of the wall clock a reading may be when the span contains a restart of the clock: the slack, and the step the clock takes then (`RESTART_CLOCK_STEP_SEC`). */
function aheadSlackSec(info: StreamInfo): number {
  return slackSec(info) + RESTART_CLOCK_STEP_SEC;
}

/** Two readings of the media clock of a player at rate 1, and the wall clock of this process around them. Every span contains a restart of the clock. */
export interface ClockSpan {
  /** Media time where the span began: the target of a seek, where a pause left the clock, the start of the title for a restart. */
  from: number;
  /** Media time the span ended at: an event's `mediaTime`, or what a wait for the clock returned. */
  to: number;
  /** Milliseconds of the wall clock of this process (`stopwatch`) from before the call that began the span to after the reading that ended it. */
  wallMs: number;
}

/**
 * The media clock moved on like a clock: it did not go back by more than a frame, and it did not run faster than the wall clock did (plus
 * a frame, the resolution of the clocks, and the step the clock takes when it restarts). The page reads the clock when it gets to it and a
 * starved page gets to it seconds late, so no distance in seconds from a position is a sound bound for a reading (ADR-092); the time the
 * clock had to run is. But the clock is not wall-synchronous right after a restart: Chromium's read 49 to 60 ms ahead of the paused
 * position at the `playing` event after a resume, 8 to 10 ms of wall clock after the call (nightly run 41793007785), so every span that
 * contains a restart (a resume, a replay, the landing of a seek and what follows it, which is every span this function judges) gets
 * `RESTART_CLOCK_STEP_SEC` once, and no more: it is forward only and far below a real defect. A landing at the start of the segment is a
 * second behind its target and a skip to the next segment or GOP is a second or two ahead of a wall clock that ran for a fraction of
 * one, so both still fail. `subject` says what was read, for the message.
 */
export function expectClockPace(span: ClockSpan, info: StreamInfo, subject: string): void {
  const slack = slackSec(info);
  checked(() => {
    expect(
      span.to,
      `${subject}: it is before the ${span.from} s the clock started from, which it may be by a frame at most (${(slack * 1000).toFixed(1)} ms with the resolution of the clocks)`,
    ).toBeGreaterThanOrEqual(span.from - slack);
    expect(
      span.to,
      `${subject}: it is past the ${span.from} s the clock started from by more than the ${Math.round(span.wallMs)} ms of wall clock it had to run in (the clock cannot run faster than that), plus a frame and the ${Math.round(RESTART_CLOCK_STEP_SEC * 1000)} ms step the clock may take when it restarts`,
    ).toBeLessThanOrEqual(span.from + span.wallMs / 1000 + aheadSlackSec(info));
  });
}

/**
 * The seek finished where it was asked to, judged by two readings of the clock that cannot be late: the one of the call (`target`, the
 * position the element takes at once, to the wall clock of this process from the call to the resolution of `seek()`), and the page's own
 * pair (the `seeking` and the `seeked` event carry the media time and the page time of the same instant, so the clock cannot have moved
 * between them faster than the page clock did, whenever the page got to record them; the clock restarts at the landing, so a handler
 * that reads after it may read the restart step). The two together are what a seek that skipped ahead, or fell back to the start of its
 * segment, fails, and what a seek that was merely read late, or that the player's stall detector nudged forward by 0.1 s for every
 * second it waited, does not.
 */
export function expectLanded(
  seek: Pick<RecordedSeek, 'seeking' | 'seeked' | 'wallMs'>,
  target: number,
  info: StreamInfo,
): void {
  const { seeking, seeked } = seek;
  expectClockPace(
    { from: target, to: seeked.mediaTime, wallMs: seek.wallMs },
    info,
    `media time of the seeked event after a seek to ${target} s`,
  );
  const pageMs = seeked.t - seeking.t;
  checked(() => {
    expect(
      seeked.mediaTime,
      `media time of the seeked event (page clock ${seeked.t.toFixed(0)} ms) against the seeking event (${seeking.mediaTime} s, page clock ${seeking.t.toFixed(0)} ms): the clock cannot have run past it by more than the ${Math.round(pageMs)} ms of the page's own clock between the two, plus a frame and the ${Math.round(RESTART_CLOCK_STEP_SEC * 1000)} ms step the clock may take when it restarts`,
    ).toBeLessThanOrEqual(seeking.mediaTime + pageMs / 1000 + aheadSlackSec(info));
  });
}

/**
 * The clock moved on after a seek, a resume or a restart: a wait for it (`waitForMediaTime`) returned `span.to`, which is as far from
 * where it began as the wall clock allows, with the restart step (`expectClockPace`), however late the wait was served. `explanation`
 * says what a failure means.
 */
export function expectClockContinued(span: ClockSpan, info: StreamInfo, explanation: string): void {
  expectClockPace(span, info, `media time reached (${span.to} s) after ${span.from} s, ${explanation}`);
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
