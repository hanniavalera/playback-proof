import { profile } from '../../src/shared/profiles.ts';
import {
  deliveryAfter,
  describeAttempts,
  rungOfError,
  ruleIdsOf,
  segmentOf,
  summariseAttempts,
  videoAttemptsAt,
  waitedMs,
  waitForFault,
} from './rec/faults.ts';
import { LONGEST_FIRST_RETRY_WAIT_MS } from './rec/shaka.ts';
import {
  describeError,
  expectAtMostRebuffers,
  expectHealthyPlayback,
  expectNoErrors,
} from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';

// Shaka Player 5.3.3 with the lab's configuration A (its defaults): a failed HTTP request is retried by the networking layer
// (`streaming.retryParameters`: 2 attempts, 1 s base delay, fuzz 0.5), and only when the attempts run out does the streaming engine
// take its failure path (disable the rung for up to 30 s, switch to another, raise a recoverable error). Every spec of this file
// first proves that the fault fired (the request log names the rule on the request) and only then asserts how the player coped.

/**
 * The longest a retry can take to arrive: the delay before the second attempt is the base delay fuzzed by +-50 % (500 ms to
 * 1500 ms), and a loaded runner fires timers late, so twice that is the bound beyond which a retry has stopped being a retry.
 */
const RETRY_BOUND_MS = 2 * LONGEST_FIRST_RETRY_WAIT_MS;

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
    const delivered = deliveryAfter(attempts, refused);
    if (!delivered)
      throw new Error(`the refused segment was never asked for again and delivered, ${message}`);
    const deliveredAfterMs = waitedMs(refused, delivered);
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

/**
 * The longest the burst can take to be absorbed. Three waits can follow each other: the retry of the first rung (500 ms to 1500 ms),
 * the streaming engine's own back-off before it gives up on that rung (the same), and the retry of the second rung, which takes the
 * third refusal; twice the sum covers timers that a loaded runner fires late.
 */
const BURST_BOUND_MS = 2 * 3 * LONGEST_FIRST_RETRY_WAIT_MS;

test(
  'PB-REC-002 5xx burst on one segment: playback continues by retry or rung switch, with no critical error and at most one rebuffer',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('flaky-segments'),
    });
    const [rule] = await ruleIdsOf(session);
    const qa = await player(session).open();

    // The fault fired three times, all on one video segment, all with the rule's 503. The third one exceeds the two attempts of the
    // default retry policy, so the player cannot get through on one rung with a retry alone.
    const fired = await waitForFault(session, rule as string, 3);
    expect(
      fired.map((entry) => entry.status),
      'status of the requests the rule fired on (request log)',
    ).toEqual([503, 503, 503]);
    const [first] = fired as [(typeof fired)[0]];
    const last = fired[fired.length - 1] as (typeof fired)[0];
    const number = segmentOf(first);
    expect(fired.map(segmentOf), 'segment numbers of the requests the rule fired on (request log)').toEqual([
      number,
      number,
      number,
    ]);

    // Playback goes on through the faulted segment.
    const stream = await streamInfoOf(session);
    await qa.waitForMediaTime(number * stream.segmentDurationSec + 1);

    // The origin's side: after the burst the segment was delivered, once, whichever way the player got there. Where it takes the
    // failure path (two refusals on one rung, the rung given up on) it moves to another rung; where the ABR moves the player while
    // the retry waits, the burst falls on two rungs. The annotation says which.
    const attempts = videoAttemptsAt(await session.service.log(session.id), number);
    const message = `attempts at video segment ${number} (request log): ${describeAttempts(attempts)}`;
    const delivered = deliveryAfter(attempts, last);
    if (!delivered)
      throw new Error(`the segment was never delivered after the burst of ${fired.length}, ${message}`);
    const deliveredAfterMs = waitedMs(first, delivered);
    expect(deliveredAfterMs, `time from the first 503 to the delivery, ${message}`).toBeLessThanOrEqual(
      BURST_BOUND_MS,
    );

    // The player's side: nothing critical reached the application and the viewer saw at most one stall. A recoverable error is
    // the failure path being taken; the rung it names is the one Shaka disabled, so it cannot be the one that delivered.
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectAtMostRebuffers(metrics, 1);
    const abandoned = metrics.errors.flatMap((error) => rungOfError(error) ?? []);
    expect(abandoned, `rungs the player gave up on (metrics.errors), ${message}`).not.toContain(
      delivered.rep,
    );
    testInfo.annotations.push({
      type: 'recovery',
      description: `${summariseAttempts(attempts)}; delivered ${Math.round(deliveredAfterMs)} ms after the first 503; ${
        metrics.errors.length === 0
          ? 'no error reached the application'
          : `errors: ${metrics.errors.map(describeError).join('; ')}`
      }`,
    });
  },
);
