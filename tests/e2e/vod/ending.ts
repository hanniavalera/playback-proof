import type { QAEvent } from '../../../src/shared/qa.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { failure } from './fail.ts';
import { allSegments, distinctAscending, segmentNumbers } from './segments.ts';

/**
 * How close to the end of the title `ended` must fire, in seconds. The video track is exactly as long as the title (`durationSec`),
 * the audio ends up to one frame (21.3 ms) before it, and the last video frame is 33 ms long: an `ended` that comes from the clock
 * reaching the end of the media is within about 55 ms of `durationSec`, and 0.1 s (three video frames) leaves room for the event's own
 * dispatch. A title cut short by a missing last segment ends two seconds early, or never.
 */
export const END_TOLERANCE_SEC = 0.1;

/** Real time allowed on top of the media still to play. The wait is on the media clock's `ended` event: a slow runner takes longer, not fail. */
export const END_MARGIN_MS = 15_000;

/** What the player and the origin say about how far a title got, for the message of a wait that gave up. */
async function describeProgress(qa: PlayerHandle, session: TestSession, info: StreamInfo): Promise<string> {
  try {
    const { playback, state } = await qa.metrics();
    const log = await session.service.log(session.id);
    const wanted = allSegments(info.segmentCount);
    const lines = (['video', 'audio'] as const).map((track) => {
      const delivered = distinctAscending(segmentNumbers(log, info, track, { status: 'ok' }));
      const missing = wanted.filter((number) => !delivered.includes(number));
      return `  ${track} segments delivered by the origin: [${delivered.join(', ')}]${missing.length > 0 ? `, never delivered: [${missing.join(', ')}]` : ', all of them'}`;
    });
    return [
      `The player says: state ${state}, media time ${playback.currentTime.toFixed(2)} s of ${playback.duration} s (the title is ${info.durationSec} s), paused ${playback.paused}, ended ${playback.ended}, ${playback.bufferedAheadSec.toFixed(2)} s buffered ahead, readyState ${playback.readyState}.`,
      `The origin says (${info.segmentCount} segments in the title):`,
      ...lines,
    ].join('\n');
  } catch (error) {
    return `(the player and the origin could not be read for this message: ${(error as Error).message})`;
  }
}

/**
 * Waits for the `ended` event (after `since`) with a deadline of the media still to play plus `END_MARGIN_MS`, and when it does not
 * come says how far the title got: the media time, and which segments the origin delivered, so that a missing last segment reads
 * differently from a player that had everything and did not end.
 */
export async function waitForEnded(
  qa: PlayerHandle,
  session: TestSession,
  info: StreamInfo,
  options: { since?: number; remainingSec?: number } = {},
): Promise<QAEvent> {
  const remainingSec = options.remainingSec ?? info.durationSec;
  const timeoutMs = Math.ceil(remainingSec * 1000) + END_MARGIN_MS;
  try {
    return await qa.waitFor('ended', { since: options.since ?? 0, timeoutMs });
  } catch (error) {
    throw failure(
      `the title did not end: no \`ended\` event within ${timeoutMs} ms (${remainingSec} s of media still to play).\n${await describeProgress(qa, session, info)}\n${(error as Error).message}`,
    );
  }
}
