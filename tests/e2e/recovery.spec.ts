import { profile } from '../../src/shared/profiles.ts';
import { describeAttempts, ruleIdsOf, segmentOf, videoAttemptsAt, waitForFault } from './rec/faults.ts';
import { expectAtMostRebuffers, expectHealthyPlayback, expectNoErrors } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';

// Shaka Player 5.3.3 with the lab's configuration A (its defaults): a failed HTTP request is retried by the networking layer
// (`streaming.retryParameters`: 2 attempts, 1 s base delay, fuzz 0.5), and only when the attempts run out does the streaming engine
// take its failure path (disable the rung for up to 30 s, switch to another, raise a recoverable error). Every spec of this file
// first proves that the fault fired (the request log names the rule on the request) and only then asserts how the player coped.

/**
 * The longest a retry can wait: the delay before the second attempt is the base delay fuzzed by +-50 % (500 ms to 1500 ms), and a
 * loaded runner fires timers late, so twice that is the bound beyond which a retry has stopped being a retry.
 */
const RETRY_BOUND_MS = 2 * 1000 * (1 + 0.5);

test(
  'PB-REC-001 transient segment 404: the failed request is retried and succeeds, playback continues with no critical error and at most one rebuffer',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('transient-404'),
    });
    const [rule] = await ruleIdsOf(session);
    const qa = await player(session).open();

    // The fault fired: the origin answered the first request for the segment with the rule's 404.
    const fired = await waitForFault(session, rule as string);
    const [refused] = fired as [(typeof fired)[0]];
    expect(fired.length, 'requests the rule fired on (request log)').toBe(1);
    expect(refused.status, 'status of the faulted request (request log)').toBe(404);
    const number = segmentOf(refused);

    // Playback goes on through the faulted segment: the media clock passes its end. Had the segment never arrived, the clock would
    // have stopped where the buffer ends, at the start of the segment.
    const stream = await streamInfoOf(session);
    await qa.waitForMediaTime(number * stream.segmentDurationSec + 1);

    // The origin's side: the segment was asked for again and delivered, after one refusal. Usually that is the retry of the same
    // URL; in an engine that starts on a low rung the ABR can move up while the retry waits out its back-off (macOS WebKit, 1 run in
    // 8), and then the segment is fetched again from the new rung. The annotation says which. The failure path would show as a
    // second refusal or as an error event (below), whichever rung asked.
    const attempts = videoAttemptsAt(await session.service.log(session.id), number);
    const message = `attempts at video segment ${number} (request log): ${describeAttempts(attempts)}`;
    expect(
      attempts.filter((attempt) => attempt.status >= 400).map((attempt) => attempt.status),
      `refused attempts, ${message}`,
    ).toEqual([404]);
    const delivered = attempts.find((attempt) => attempt.seq > refused.seq && attempt.status === 200);
    if (!delivered)
      throw new Error(`the refused segment was never asked for again and delivered, ${message}`);
    const deliveredAfterMs = delivered.msSinceStart - (refused.msSinceStart + refused.totalMs);
    testInfo.annotations.push({
      type: 'recovery',
      description:
        delivered.rep === refused.rep
          ? `segment ${number} was retried on ${refused.rep} ${Math.round(deliveredAfterMs)} ms after the 404`
          : `segment ${number} (${refused.rep}, 404) was fetched again on ${delivered.rep} ${Math.round(deliveredAfterMs)} ms after the 404`,
    });
    expect(deliveredAfterMs, `time from the 404 to its delivery, ${message}`).toBeLessThanOrEqual(
      RETRY_BOUND_MS,
    );

    // The player's side: the failure was absorbed below the application, so no error of any severity reached it (a failure that
    // took the failure path would be a recoverable error and a move to another rung), and the viewer saw at most one stall.
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
    expectAtMostRebuffers(metrics, 1);
  },
);
