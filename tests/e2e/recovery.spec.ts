import type { RequestLogEntry } from '../../src/shared/api.ts';
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
import { LONGEST_FIRST_RETRY_WAIT_MS, RETRY } from './rec/shaka.ts';
import {
  describeError,
  expectAtMostRebuffers,
  expectHealthyPlayback,
  expectNoErrors,
} from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { describeEntry, requestsFor, waitForRequest } from './support/waiting.ts';

// Shaka Player 5.3.3 with the lab's configuration A (its defaults): a failed HTTP request is retried by the networking layer
// (`streaming.retryParameters`: 2 attempts, 1 s base delay, fuzz 0.5), and only when the attempts run out does the streaming engine
// take its failure path (disable the rung for up to 30 s, switch to another, raise a recoverable error). Every spec of this file
// first proves that the fault fired (the request log names the rule on the request) and only then asserts how the player coped.

/**
 * The longest a retry can take to arrive: the delay before the second attempt is the base delay fuzzed by +-50 % (500 ms to
 * 1500 ms), and a loaded runner fires timers late, so twice that is the bound beyond which a retry has stopped being a retry.
 */
const RETRY_BOUND_MS = 2 * LONGEST_FIRST_RETRY_WAIT_MS;

/** How much media the second load plays to show that it is playing. */
const MEDIA_SECONDS_AFTER_RETRY = 2;

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

/**
 * The most requests the failing rung may be asked for once it is down. Two fetches of it can be in flight when it goes (its
 * initialization segment and a media segment) and each is attempted twice by the default retry policy; after that the player gives
 * up on the rung for `streaming.maxDisabledTime` (30 s), longer than this spec runs, so a request beyond the four is hammering.
 */
const OUTAGE_REQUESTS_MAX = RETRY.maxAttempts * 2;

/** The retry wait, then the streaming engine's own back-off before it gives up on the rung, each at its longest, doubled for late timers. */
const FAILOVER_BOUND_MS = 2 * 2 * LONGEST_FIRST_RETRY_WAIT_MS;

test(
  'PB-REC-003 persistent failure of one rung: the player moves to another rung and continues, and the failed requests to the rung stay bounded',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash' });
    const outage = profile('rung-outage');
    const rung = outage[0]?.match?.rep;
    const stream = await streamInfoOf(session);
    const height = stream.reps.find((rep) => rep.id === rung)?.height;
    if (rung === undefined || height === undefined)
      throw new Error(`the rung-outage profile names ${String(rung)}, which the stream does not have`);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');

    // The outage must find the player on the rung. Chromium starts there; WebKit and Firefox start on a lower one and only climb
    // after about a second, so the spec puts the player there (a pin, then the ABR is given back: a failover needs it) and waits
    // until the rung has delivered a segment. Only then does the rung go down, mid-title, for good.
    await qa.selectVariantByHeight(height);
    await qa.setAbr(true);
    await waitForRequest(
      session,
      (entry) => entry.kind === 'segment' && entry.rep === rung && entry.status === 200 && !entry.pending,
    );
    const since = await qa.cursor();
    const [rule] = await session.service.addFaults(session.id, outage);

    // The fault fired: the origin refused the rung's requests with the rule's 503 (a media segment, as the rung's init was served).
    const fired = await waitForFault(session, (rule as { id: string }).id);
    const [first] = fired as [(typeof fired)[0]];
    expect(first.status, 'status of the first request the rule fired on (request log)').toBe(503);
    expect(first.rep, 'rung of the first request the rule fired on (request log)').toBe(rung);
    const number = segmentOf(first);

    // The player moves on its own: a change of rung that the ABR made (nobody asked for it), to a rung below the one that failed.
    const moved = await qa.waitFor('variant-changed', { since, detail: { reason: 'abr' } });
    expect(moved.detail?.height, 'height of the rung the player moved to (variant-changed)').toBeLessThan(
      height,
    );

    // And it continues: the media clock passes the end of the segment the rung could not deliver.
    await qa.waitForMediaTime(number * stream.segmentDurationSec + 1);

    // The origin's side: that segment came from another rung, soon, and after the first refusal the rung was asked for nothing
    // that the origin delivered and only a bounded number of times.
    const log = await session.service.log(session.id);
    const attempts = videoAttemptsAt(log, number);
    const message = `attempts at video segment ${number} (request log): ${describeAttempts(attempts)}`;
    const delivered = deliveryAfter(attempts, first);
    if (!delivered) throw new Error(`the segment was never delivered by another rung, ${message}`);
    expect(delivered.rep, `rung that delivered segment ${number}, ${message}`).not.toBe(rung);
    const movedAfterMs = waitedMs(first, delivered);
    expect(
      movedAfterMs,
      `time from the first 503 to the delivery by another rung, ${message}`,
    ).toBeLessThanOrEqual(FAILOVER_BOUND_MS);
    const toRung = requestsFor(log, { rep: rung }).filter((entry) => entry.seq >= first.seq);
    const delivering = toRung.filter((entry) => entry.status >= 200 && entry.status < 300);
    expect(
      delivering.map(describeEntry),
      `requests to ${rung} after the outage began that the origin delivered (request log)`,
    ).toEqual([]);
    expect(
      toRung.length,
      `requests to ${rung} after the outage began (request log): ${toRung.map(describeEntry).join('; ')}`,
    ).toBeLessThanOrEqual(OUTAGE_REQUESTS_MAX);

    // The player's side: nothing critical, at most one stall, and every error it surfaced is the outage (the rung it names).
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectAtMostRebuffers(metrics, 1);
    expect(
      metrics.errors.filter((error) => rungOfError(error) !== rung).map(describeError),
      `errors that do not name ${rung} (metrics.errors): expected none`,
    ).toEqual([]);
    testInfo.annotations.push({
      type: 'recovery',
      description: `${toRung.length} requests to ${rung} after the outage began (${summariseAttempts(toRung)}); segment ${number} delivered by ${delivered.rep} ${Math.round(movedAfterMs)} ms after the first 503; ${metrics.errors.length} errors`,
    });
  },
);

test(
  'PB-REC-004 slow segment: the player recovers by itself, with at most one rebuffer and no error',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('slow-segment'),
    });
    const [rule] = await ruleIdsOf(session);
    const [slow] = profile('slow-segment');
    if (slow?.type !== 'latency') throw new Error('the slow-segment profile is no longer a latency rule');
    const qa = await player(session).open();

    // The fault fired: the origin held the first byte of the segment back for the rule's whole delay, and answered it in the end
    // (the delay is below the 10 s connection timeout, so the player waited instead of giving up on the request).
    const [late] = await waitForFault(session, rule as string);
    const request = late as NonNullable<typeof late>;
    expect(request.ttfbMs, 'time to first byte of the delayed request (request log)').toBeGreaterThanOrEqual(
      slow.ms - 50,
    );
    expect(request.status, 'status of the delayed request (request log)').toBe(200);
    expect(request.aborted ?? false, 'delayed request aborted by the player (request log)').toBe(false);
    const number = segmentOf(request);

    // The playhead gets past the late segment: it stalls at the end of what was buffered and resumes by itself once the segment is in.
    const stream = await streamInfoOf(session);
    await qa.waitForMediaTime(number * stream.segmentDurationSec + 1);

    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
    expectAtMostRebuffers(metrics, 1);
    expect(
      metrics.rebuffer.events.filter((episode) => episode.ongoing),
      'stalls that have not ended (metrics.rebuffer.events)',
    ).toEqual([]);
    const [episode] = metrics.rebuffer.events;
    testInfo.annotations.push({
      type: 'recovery',
      description: episode
        ? `segment ${number} took ${Math.round(request.ttfbMs)} ms to its first byte; the player stalled for ${Math.round(episode.durationMs)} ms at media time ${episode.mediaTime.toFixed(2)} s and resumed by itself`
        : `segment ${number} took ${Math.round(request.ttfbMs)} ms to its first byte; the player did not stall`,
    });
  },
);

test(
  'PB-REC-005 truncated segment: the segment is retried, with no decode-error loop and no critical error',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('truncated-segment'),
    });
    const [rule] = await ruleIdsOf(session);
    const [cut] = profile('truncated-segment');
    if (cut?.type !== 'abort' || cut.afterBytes === undefined)
      throw new Error('the truncated-segment profile is no longer an abort after a number of bytes');
    const sentBeforeCut = cut.afterBytes;
    const qa = await player(session).open();

    // The fault fired: the origin sent the response head (a 200) and exactly the rule's bytes of the body, then dropped the connection.
    const [truncated] = await waitForFault(session, rule as string);
    const first = truncated as NonNullable<typeof truncated>;
    expect(first.aborted ?? false, 'truncated request aborted by the origin (request log)').toBe(true);
    expect(
      first.bytes,
      'bytes of the body the origin sent before it dropped the connection (request log)',
    ).toBe(sentBeforeCut);
    const number = segmentOf(first);

    // Playback goes on through the damaged segment.
    const stream = await streamInfoOf(session);
    await qa.waitForMediaTime(number * stream.segmentDurationSec + 1);

    // The origin's side: the segment was asked for again and delivered whole (more than twice the bytes the cut let through, which
    // is less than half of the smallest segment), on the same rung or, where the ABR moved the player meanwhile, on another.
    const attempts = videoAttemptsAt(await session.service.log(session.id), number);
    const message = `attempts at video segment ${number} (request log): ${describeAttempts(attempts)}`;
    const whole = attempts.find(
      (attempt) =>
        attempt.seq > first.seq &&
        attempt.status === 200 &&
        attempt.aborted !== true &&
        attempt.bytes > 2 * sentBeforeCut,
    );
    if (!whole) throw new Error(`the truncated segment was never fetched again, whole, ${message}`);
    expect(waitedMs(first, whole), `time from the cut to the whole segment, ${message}`).toBeLessThanOrEqual(
      RETRY_BOUND_MS,
    );

    // The player's side: nothing critical, and no decode-error loop: a single fault can cost one error of a kind, never a
    // repeating one. The codes are what differs between engines (the media pipeline is not the same), so they are on record.
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    const codes = metrics.errors.map((error) => `${error.codeName ?? 'error'} ${error.code}`);
    expect(
      codes.filter((code, index) => codes.indexOf(code) !== index),
      `error kinds that repeat (metrics.errors), ${message}`,
    ).toEqual([]);
    testInfo.annotations.push({
      type: 'recovery',
      description: `cut after ${first.bytes} bytes of ${whole.bytes}; fetched again ${Math.round(waitedMs(first, whole))} ms later on ${whole.rep}; error codes: ${codes.length === 0 ? 'none' : codes.join(', ')}; ${metrics.rebuffer.count} rebuffers`,
    });
  },
);

/**
 * The longest `load()` can take to give up on a manifest that is refused: one attempt, the wait before the second (at most 1500 ms
 * with the fuzz at its top: `RETRY_BOUND_MS` is that wait doubled for a loaded runner), and the second attempt, which is the last.
 */
const LOAD_FAILURE_BOUND_MS = RETRY_BOUND_MS;

test(
  'PB-REC-006 manifest failure at load: load() fails with an error in bounded time, and a load after the origin returns plays',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('manifest-down'),
    });
    const [rule] = await ruleIdsOf(session);
    // A page without a manifest: it boots idle and the spec decides when the load starts.
    const qa = await player().open();
    const since = await qa.cursor();
    const loading = qa.load(session.manifestUrl).then(
      () => undefined,
      (error: Error) => error,
    );

    // The fault fired: the origin refused every attempt at the manifest, and the player made exactly the attempts its retry policy allows.
    const fired = await waitForFault(session, rule as string, RETRY.maxAttempts);
    expect(
      fired.map((entry) => `${entry.kind} ${entry.status}`),
      'requests the rule fired on (request log)',
    ).toEqual(Array.from({ length: RETRY.maxAttempts }, () => 'manifest 503'));

    // load() fails (it does not hang and it does not succeed), with a critical network error, and it did so within the retry policy.
    const failure = await loading;
    expect(failure, 'outcome of qa.load() against a manifest that answers 503 (a rejection)').toBeDefined();
    const events = await qa.events(since);
    const requested = events.find((event) => event.name === 'load-requested');
    const error = events.find((event) => event.name === 'error');
    if (!requested || !error)
      throw new Error(`the timeline has no load-requested and error pair: ${JSON.stringify(events)}`);
    const failedAfterMs = error.t - requested.t;
    expect(failedAfterMs, 'time from load() to its error (page clock)').toBeLessThanOrEqual(
      LOAD_FAILURE_BOUND_MS,
    );
    expect(
      { code: error.detail?.code, category: error.detail?.category, severity: error.detail?.severity },
      'the error load() failed with (Shaka: BAD_HTTP_STATUS 1001, NETWORK category 1, critical severity 2)',
    ).toEqual({ code: 1001, category: 1, severity: 2 });
    expect((await qa.metrics()).state, 'player state (metrics.state) after the failed load').toBe('error');

    // The origin returns and the same player loads again: the manifest is served, the title plays, and nothing fails this time.
    await session.service.removeFault(session.id, rule as string);
    const retry = await qa.cursor();
    await qa.load(session.manifestUrl);
    await qa.play();
    await qa.waitFor('firstframe', { since: retry });
    await qa.waitForMediaTime(MEDIA_SECONDS_AFTER_RETRY);
    const metrics = await qa.metrics();
    expect(metrics.state, 'player state (metrics.state) after the second load').toBe('playing');
    expect(metrics.startupMs, 'startup time (metrics.startupMs) of the second load').not.toBeNull();
    expect(
      (await qa.events(retry)).filter((event) => event.name === 'error').map((event) => event.detail),
      'errors since the second load started (qa.events)',
    ).toEqual([]);
    const manifests = requestsFor(await session.service.log(session.id), { kind: 'manifest' });
    expect(
      manifests.map((entry) => entry.status),
      'manifest requests of the session, in order (request log)',
    ).toEqual([...Array.from({ length: RETRY.maxAttempts }, () => 503), 200]);
    testInfo.annotations.push({
      type: 'recovery',
      description: `load() failed ${Math.round(failedAfterMs)} ms after it was called (${RETRY.maxAttempts} attempts, ${error.detail?.codeName}); after the origin returned the second load reached its first frame in ${Math.round(metrics.startupMs ?? 0)} ms`,
    });
  },
);

/**
 * The longest the first critical error can take. The audio has one rendition, so its first failed fetch has nowhere to go: the retry
 * waits (at most 1500 ms), the second attempt fails, the streaming engine waits again (at most 1500 ms) before it reports the
 * error. Doubled for the timers of a loaded runner.
 */
const FIRST_CRITICAL_BOUND_MS = 2 * 2 * LONGEST_FIRST_RETRY_WAIT_MS;

test(
  'PB-REC-007 persistent segment failure: a critical error is surfaced in bounded time and the state becomes error',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('segments-down'),
    });
    const [rule] = await ruleIdsOf(session);
    const stream = await streamInfoOf(session);
    const videoRungs = stream.reps.filter((rep) => rep.track === 'video').map((rep) => rep.id);
    const qa = await player(session).open();

    // The fault fired: the origin refused segments, more than once (the first attempt and its retry), and nothing else.
    const fired = await waitForFault(session, rule as string, RETRY.maxAttempts);
    expect(
      fired.map((entry) => `${entry.kind} ${entry.status}`),
      'requests the rule fired on (request log)',
    ).toEqual(fired.map(() => 'segment 503'));

    // The player gives up: a critical error, not a spinner, within the time the retry policy explains.
    const critical = await qa.waitFor('error', { detail: { severity: 2 } });
    const requested = await qa.waitFor('load-requested');
    const giveUpAfterMs = critical.t - requested.t;
    expect(giveUpAfterMs, 'time from load() to the first critical error (page clock)').toBeLessThanOrEqual(
      FIRST_CRITICAL_BOUND_MS,
    );
    const metrics = await qa.metrics();
    expect(metrics.state, 'player state (metrics.state) after the critical error').toBe('error');
    expect(metrics.startupMs, 'startup time (metrics.startupMs): no first frame can exist').toBeNull();

    // Every rung was tried and given up on: after the first rung fails the player moves to the next, and it goes on until none is left.
    // Each rung costs the same two waits as the audio, so the last one is refused within that many of them, doubled.
    const allRungsBound = 2 * videoRungs.length * 2 * LONGEST_FIRST_RETRY_WAIT_MS;
    const refusedSegment = (entry: RequestLogEntry): boolean =>
      entry.kind === 'segment' && entry.status === 503 && !entry.pending;
    for (const rung of videoRungs) {
      await waitForRequest(session, (entry) => refusedSegment(entry) && entry.rep === rung, {
        timeoutMs: allRungsBound,
      });
    }
    const log = await session.service.log(session.id);
    const refused = requestsFor(log, { kind: 'segment' }).filter(refusedSegment);
    const firstRequestAt = requestsFor(log, { kind: ['init', 'segment'] })[0]?.msSinceStart ?? 0;
    const lastRungGivenUpAt = Math.max(
      ...videoRungs.map(
        (rung) => refused.find((entry) => entry.rep === rung)?.msSinceStart ?? Number.POSITIVE_INFINITY,
      ),
    );
    expect(
      lastRungGivenUpAt - firstRequestAt,
      `time from the first media request to the last video rung refused (${videoRungs.join(', ')}; request log)`,
    ).toBeLessThanOrEqual(allRungsBound);
    expect((await qa.metrics()).state, 'player state (metrics.state) after every rung was refused').toBe(
      'error',
    );
    testInfo.annotations.push({
      type: 'recovery',
      description: `first critical error ${Math.round(giveUpAfterMs)} ms after load() (${critical.detail?.codeName}); rungs refused in the order ${[...new Set(refused.map((entry) => entry.rep))].join(', ')}, the last ${Math.round(lastRungGivenUpAt - firstRequestAt)} ms after the first media request; ${refused.length} segment requests refused by then; ${(await qa.metrics()).errors.length} errors`,
    });
  },
);
