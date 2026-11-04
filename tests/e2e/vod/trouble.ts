import type { QAEvent } from '../../../src/shared/qa.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { failure } from './fail.ts';
import { describeOriginSince } from './seeking.ts';
import { RECOVERY_LOOKOUT_MS } from './tolerances.ts';

// What the player and the origin say when something a spec waits for does not happen. The first CI run on a macOS runner failed the
// suites three times with a headline that named the wait ("timed out", "was rejected") and not the cause, which was in the timeline and
// the metrics each time: these helpers put it in the message (ADR-094).

/**
 * What the player says about stalls and errors, for the message of a measurement that could not be made: a window the media clock
 * jumped in (or that no frame came in) is most often a stall of the player's own, and the first CI run on a macOS runner showed it. The
 * release run's window "jumped from 3.633 s to 4.733 s", and the run's own record says why: one rebuffer of 2838 ms that began at media
 * time 0 (the clock had fallen back to the start), a seek to 4.748 s that nobody asked for, segments 3 to 8 of both tracks requested again
 * (the buffer was gone) and counters that had restarted (23 decoded, 1 presented): WebKit's media pipeline was torn down and rebuilt. A
 * clock that jumps because a late frame callback was delivered late would show none of that. Empty when the metrics cannot be read.
 */
export async function describePlayerTrouble(qa: PlayerHandle): Promise<string> {
  try {
    const { state, rebuffer, errors, playback, frames } = await qa.metrics();
    const stalls = rebuffer.events.map(
      (stall) =>
        `${Math.round(stall.durationMs)} ms at media time ${stall.mediaTime.toFixed(3)} s${stall.ongoing ? ' (not over)' : ''}`,
    );
    const failed = errors.map((error) =>
      `${error.code} ${error.codeName ?? ''} (${error.source ?? '?'})`.trim(),
    );
    return `\nThe player says: state ${state}, media time ${playback.currentTime.toFixed(3)} s, ${rebuffer.count} rebuffers${stalls.length > 0 ? ` (${stalls.join('; ')})` : ''}, ${errors.length} errors${failed.length > 0 ? ` (${failed.join('; ')})` : ''}, ${frames.decoded} decoded and ${frames.presented} presented frames since the load.`;
  } catch {
    return '';
  }
}

/**
 * Waits for the first frame (the spec's precondition: the title started) and, when it does not come, says whether the player had given
 * up on the load. A critical error (Shaka severity 2) ends the load, and a first frame cannot follow it, so the wait can only time out:
 * in the release run of the first CI on macOS, PB-VOD-006 "timed out after 15000 ms" with the timeline holding `error 4032
 * CONTENT_UNSUPPORTED_BY_BROWSER` 103 ms after the load was requested (the browser said it could play none of the manifest's variants):
 * the first frame never took 15 s, it was never going to come. The message then names that error first.
 */
export async function waitForFirstFrame(qa: PlayerHandle): Promise<QAEvent> {
  try {
    return await qa.waitFor('firstframe');
  } catch (error) {
    throw failure(`${await describeLoadFailure(qa)}${(error as Error).message}`);
  }
}

async function describeLoadFailure(qa: PlayerHandle): Promise<string> {
  try {
    const { errors } = await qa.metrics();
    const critical = errors.filter((error) => error.severity === 2);
    if (critical.length === 0) return '';
    const events = await qa.events();
    const loadRequested = events.find((event) => event.name === 'load-requested');
    const lines = critical.map(
      (error) =>
        `  error ${error.code} ${error.codeName ?? ''} (source ${error.source ?? '?'}, critical) ${loadRequested ? `${Math.round(error.t - loadRequested.t)} ms after the load was requested` : `at page time ${Math.round(error.t)} ms`}: ${error.message}`,
    );
    return `The player gave up on the load before the wait did, so no first frame could follow (this is the player or the browser refusing the content, not a slow start):\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}

/**
 * `qa.play()` on an ended title. When it is rejected the message says what the element looked like afterwards, whether the player
 * restarted by itself within `RECOVERY_LOOKOUT_MS`, and what the origin was asked for since: the verdict stays the rejection, the lookout
 * is the evidence for what it means. A pending `play()` is rejected with an AbortError when the element is paused or its media is reset
 * (the media element load algorithm of HTML), not when a seek is slow. In the release run of the first CI on macOS WebKit rejected it
 * in both attempts, 0.4 s and 3.8 s after the restart's own seek began, with the element left at readyState 0 and no duration, no Shaka
 * error, no `unloaded` event and nothing asked of the origin, and neither `seeked` nor `playing` had come for a spec to wait for
 * instead (ADR-094). Shaka resets the MediaSource of a player whose browser closed it and plays on after the reset, which fits; the runs
 * ended at the rejection, so whether it did is what the lookout will say.
 */
export async function playAfterEnded(
  qa: PlayerHandle,
  session: TestSession,
  from: { since: number; logCursor: number },
): Promise<void> {
  try {
    await qa.play();
  } catch (error) {
    let after = '';
    try {
      const { playback } = await qa.metrics();
      after = `\nThe element afterwards: readyState ${playback.readyState}, duration ${playback.duration} s, media time ${playback.currentTime} s, paused ${playback.paused}, ended ${playback.ended}.${playback.readyState === 0 ? ' It has no media any more: the browser reset the element (a reset rejects the pending play() with an AbortError); this is not a slow restart.' : ''}`;
    } catch {
      // The page may be gone: the message above is all there is.
    }
    const lookout = await qa.waitFor('playing', { since: from.since, timeoutMs: RECOVERY_LOOKOUT_MS }).then(
      (playing) =>
        `\nThe player then restarted by itself: a playing event at media time ${playing.mediaTime} s since play() was called, which play() had not delivered.`,
      (lookoutError: unknown) =>
        /timed out/.test(String(lookoutError))
          ? `\nThe player did not restart by itself either: no playing event within ${RECOVERY_LOOKOUT_MS} ms of the rejection.`
          : '',
    );
    throw failure(
      `${(error as Error).message}${after}${lookout}${await describeOriginSince({ session, logCursor: from.logCursor }, 'play() was called')}`,
    );
  }
}
