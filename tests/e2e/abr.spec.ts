import { profile } from '../../src/shared/profiles.ts';
import { settleWindowSeconds, throttleOf, upshiftBoundSeconds } from './abr/conditions.ts';
import { bestRungCarriedBy, ladderOf, rungOf } from './abr/ladder.ts';
import { describeSegments, fromFirstOf, videoSegmentRequests } from './abr/log.ts';
import { describeVariantChanges, variantChanges } from './abr/variants.ts';
import {
  expectAtMostRebuffers,
  expectHealthyPlayback,
  expectNoErrors,
  expectNoRebuffer,
} from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestLogCursor, requestsFor, waitForRequest } from './support/waiting.ts';

// ABR tests are the slowest of the lab: the player's adaptation runs on seconds (Shaka's `abr.switchInterval` is 8 s, its buffering
// goal 10 s), so a test is 20 to 40 s of real playback. They need their own budget (the longest wait path of a test is under 120 s,
// the most a spec may ask for); every wait inside has its own, generous bound, so a failure is reported by the wait and not by the timeout.
const ABR_TEST_TIMEOUT_MS = 120_000;
const WAIT_MS = 40_000;
// 8 s until the link weakens + two decisions 8 s apart + one 720p segment in flight at 600 kbps (6 s) = 30 s, and 15 s of margin.
const DOWNSHIFT_WAIT_MS = 45_000;
// The link a recovered connection offers: 3.2 times the top rung's declared 1,845 kbps (video + audio), so it carries every rung with
// room to spare, and finite, so that a 75 KB segment of the lowest rung takes 100 ms to arrive: far above the 5 ms under which Shaka
// does not count a download (PB-ABR-003).
const RECOVERED_LINK_KBPS = 6000;

test(
  'PB-ABR-002 downshifts when bandwidth drops mid-playback (bandwidth-drop): at most one rebuffer, settles on a rung the network can carry',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(ABR_TEST_TIMEOUT_MS);
    const rules = profile('bandwidth-drop');
    const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: rules });
    const stream = await streamInfoOf(session);
    const ladder = ladderOf(stream);
    // The rung the arithmetic of the profile says the link can carry (600 kbps: 240p and its audio, 364 kbps; 360p needs 764).
    const throttle = throttleOf(rules);
    const settle = bestRungCarriedBy(ladder, throttle.kbps);
    expect(settle.rep, 'the ladder has a rung above the one the link carries to step down from').not.toBe(
      ladder.top.rep,
    );

    const qa = await player(session).open();
    await qa.waitFor('firstframe');

    // The start rung is Shaka's choice and differs per engine (720p in Chromium, 360p in the others): the test only needs the player to
    // end up on the rung the link carries. The link weakens 8 s after the first media request. Shaka decides at most every 8 s on a
    // segment download, and it may need two decisions (720p to 360p to 240p, seen in about half of the runs in Chromium) because its
    // estimate still holds the fast samples of the first 8 s at the first decision. The segment in flight when the link weakens takes
    // about 6 s at 600 kbps. So the step to 240p comes between 10 and 26 s into the playback in the runs measured; the wait is a
    // bound for a failure (8 s + two decisions 8 s apart + one 6 s segment + margin), never the pace of the test.
    const down = await qa.waitFor('variant-changed', {
      detail: { reason: 'abr', height: settle.height },
      timeoutMs: DOWNSHIFT_WAIT_MS,
    });
    expect(down.detail?.bandwidth, 'bandwidth declared by the variant the player stepped down to').toBe(
      settle.variantBandwidth,
    );

    // Settled: nothing can change before the switch interval has elapsed, so watch past it, and past the next segment decisions.
    const window = settleWindowSeconds(stream.segmentDurationSec);
    await qa.waitForMediaTime(down.mediaTime + window, { timeoutMs: WAIT_MS });

    const afterDown = await qa.events(down.index + 1);
    expect(
      describeVariantChanges(variantChanges(afterDown)),
      `rung changes in the ${window} s after the step down to ${settle.height}p (qa.events()): none`,
    ).toBe('none');
    const metrics = await qa.metrics();
    testInfo.annotations.push({
      type: 'measured',
      description: `rungs: ${describeVariantChanges(variantChanges(await qa.events()))}; rebuffers ${metrics.rebuffer.count}`,
    });
    expect(metrics.bitrate.current?.height, 'active rung (metrics.bitrate.current) at the end').toBe(
      settle.height,
    );
    expectAtMostRebuffers(metrics, 1);
    expectHealthyPlayback(metrics);

    // The origin's account: from the first segment of the settled rung on, nothing else is requested, and the last segments it
    // delivered are of that rung.
    const log = await session.service.log(session.id);
    const video = videoSegmentRequests(log);
    expect(
      video.some((entry) => entry.rep === settle.rep),
      `${settle.rep} segments in the request log: ${describeSegments(video)}`,
    ).toBe(true);
    expect(
      fromFirstOf(video, settle.rep)
        .filter((entry) => entry.rep !== settle.rep)
        .map((entry) => `${entry.rep} #${entry.number}`),
      `video segments requested after the first ${settle.rep} one (request log): ${describeSegments(video)}`,
    ).toEqual([]);
    const delivered = videoSegmentRequests(requestsFor(log, { status: 'ok' }));
    expect(
      delivered.slice(-3).map((entry) => entry.rep),
      `rungs of the last three video segments the origin delivered (request log): ${describeSegments(delivered)}`,
    ).toEqual([settle.rep, settle.rep, settle.rep]);
  },
);

test(
  'PB-ABR-003 upshifts after the bandwidth recovers (the throttle is lifted once the downshift has happened)',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(ABR_TEST_TIMEOUT_MS);
    const rules = profile('bandwidth-drop');
    const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: rules });
    const stream = await streamInfoOf(session);
    const ladder = ladderOf(stream);
    const settle = bestRungCarriedBy(ladder, throttleOf(rules).kbps);
    expect(
      bestRungCarriedBy(ladder, RECOVERED_LINK_KBPS).rep,
      `the recovered link (${RECOVERED_LINK_KBPS} kbps) must carry the whole ladder (the ladder)`,
    ).toBe(ladder.top.rep);

    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    // The downshift first (PB-ABR-002 has the arithmetic of this wait): the recovery is the end of the drop the player answered.
    await qa.waitFor('variant-changed', {
      detail: { reason: 'abr', height: settle.height },
      timeoutMs: DOWNSHIFT_WAIT_MS,
    });

    // The link recovers to a link of its own: the rule is replaced, in one call, by a finite one. Removing the rule would leave the
    // player a link on which a segment arrives in under a millisecond, and Shaka (`abr.cacheLoadThreshold`, 5 ms) takes a download
    // that fast for a cache hit and does not count it: its estimate never hears of the recovery, and Chromium stays on the rung it
    // stepped down to for as long as the title lasts (28 s measured). A finite link is also what a recovered connection is.
    const eventsSince = await qa.cursor();
    const logSince = await requestLogCursor(session);
    const recoveredAt = (await qa.metrics()).playback.currentTime;
    await session.service.setFaults(session.id, [{ type: 'throttle', kbps: RECOVERED_LINK_KBPS }]);

    const [up] = variantChanges([
      await qa.waitFor('variant-changed', { since: eventsSince, timeoutMs: WAIT_MS }),
    ]);
    if (!up) throw new Error('the hook recorded no variant change');
    const elapsed = up.mediaTime - recoveredAt;
    const bound = upshiftBoundSeconds(stream.segmentDurationSec);
    testInfo.annotations.push({
      type: 'measured',
      description: `first step up to ${up.height}p ${elapsed.toFixed(1)} s of media time after the recovery (bound ${bound} s)`,
    });
    expect(
      `${up.height}p ${up.reason}`,
      `the first rung change after the link recovered (qa.events()), ${elapsed.toFixed(1)} s of media time after it: a step up from ${settle.height}p by ABR`,
    ).toMatch(/^\d+p abr$/);
    expect(
      up.height,
      `rung of the first change after the link recovered (qa.events()), ${elapsed.toFixed(1)} s of media time after it`,
    ).toBeGreaterThan(settle.height);
    expect(
      elapsed,
      `media time from the recovery to the first step up (qa.events()): the bound is the switch interval and three segments`,
    ).toBeLessThanOrEqual(bound);

    // The origin's account: the higher rung was asked for and delivered after the recovery, not only announced.
    const upRung = rungOf(ladder, { height: up.height });
    const delivered = await waitForRequest(
      session,
      (entry) =>
        entry.kind === 'segment' && entry.rep === upRung.rep && !entry.pending && entry.status === 200,
      { since: logSince, timeoutMs: WAIT_MS },
    );
    expect(delivered.rep, 'rung of a segment the origin delivered after the step up (request log)').toBe(
      upRung.rep,
    );
    expectHealthyPlayback(await qa.metrics());
  },
);

test(
  'PB-ABR-004 a manual rung change (selectVariantByHeight) is seamless: no rebuffer, no error, continuous playhead',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    test.setTimeout(ABR_TEST_TIMEOUT_MS);
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const stream = await streamInfoOf(session);
    const ladder = ladderOf(stream);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    // A few seconds of steady playback first: the engines start on different rungs (Shaka's defaults, ADR-064) and some climb in
    // their first second. The test does not care which rung it leaves, only that the change is a real one.
    await qa.waitForMediaTime(3, { timeoutMs: WAIT_MS });

    const before = (await qa.metrics()).bitrate.current;
    expect(before, 'the active variant (metrics.bitrate.current) after the first frame').not.toBeNull();
    // The biggest step the ladder offers from where the player is: down to the lowest rung, or up to the top from the lowest.
    const target = before?.height === ladder.lowest.height ? ladder.top : ladder.lowest;

    const eventsSince = await qa.cursor();
    const logSince = await requestLogCursor(session);
    await qa.selectVariantByHeight(target.height);
    const change = await qa.waitFor('variant-changed', {
      since: eventsSince,
      detail: { reason: 'manual', height: target.height },
      timeoutMs: WAIT_MS,
    });
    expect(change.detail?.bandwidth, 'bandwidth declared by the variant the player moved to').toBe(
      target.variantBandwidth,
    );

    // Shaka keeps what is buffered and applies the choice to what is fetched next, so the new rung reaches the screen only when the
    // playhead gets to the first segment fetched after the change. Play through that segment: a change that breaks the pipeline does it
    // there (a new init segment, a new resolution), not at the click.
    const firstNew = await waitForRequest(
      session,
      (entry) => entry.kind === 'segment' && entry.rep === target.rep,
      { since: logSince, timeoutMs: WAIT_MS },
    );
    const playedThrough = (firstNew.number as number) * stream.segmentDurationSec;
    await qa.waitForMediaTime(playedThrough + 1, { timeoutMs: WAIT_MS });

    // The player's side, from the change on (the pin has switched ABR off by then, so the one change is the viewer's): no further
    // change of rung, and nothing that interrupts or moves the playhead.
    const afterChange = await qa.events(change.index + 1);
    expect(
      describeVariantChanges(variantChanges(afterChange)),
      'rung changes after the manual one (qa.events()): none, ABR is off',
    ).toBe('none');
    const interruptions = afterChange.filter((event) =>
      ['seeking', 'seeked', 'buffering-start', 'buffering-end', 'paused', 'error', 'ended'].includes(
        event.name,
      ),
    );
    expect(
      interruptions.map((event) => `${event.name} at ${event.mediaTime.toFixed(2)} s`),
      'events after the change that interrupt or move the playhead (qa.events())',
    ).toEqual([]);
    const metrics = await qa.metrics();
    expectNoRebuffer(metrics);
    expectNoErrors(metrics);
    expectHealthyPlayback(metrics);
    expect(metrics.bitrate.current?.height, 'active rung (metrics.bitrate.current) at the end').toBe(
      target.height,
    );

    // The origin's side: the segments after the choice follow on from the ones before it (none skipped, none fetched again except the one
    // the switch may have cut off), and from the first fetch of the new rung on, every video segment is of that rung.
    const video = videoSegmentRequests(await session.service.log(session.id));
    const after = video.filter((entry) => entry.seq > logSince);
    const lastBefore = video.filter((entry) => entry.seq <= logSince).at(-1);
    const stragglers = fromFirstOf(after, target.rep).filter((entry) => entry.rep !== target.rep);
    expect(
      stragglers.map((entry) => `${entry.rep} #${entry.number}`),
      `video segments requested after the first ${target.rep} one (request log): ${describeSegments(video)}`,
    ).toEqual([]);
    const numbers = [lastBefore, ...after].map((entry) => entry?.number as number);
    const jumps = numbers
      .slice(1)
      .map((number, i) => ({ from: numbers[i] as number, to: number }))
      .filter(({ from, to }) => to !== from && to !== from + 1);
    expect(
      jumps,
      `video segment numbers must follow on without a gap or a step back across the choice (request log): ${describeSegments(video)}`,
    ).toEqual([]);
  },
);

test(
  'PB-ABR-005 ABR disabled stays on the pinned rung even when the network cannot carry it (constrained-1500, pinned at 720p)',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(ABR_TEST_TIMEOUT_MS);
    const rules = profile('constrained-1500');
    const session = await newSession({ stream: streamFor('vod', 'dash'), protocol: 'dash', faults: rules });
    const stream = await streamInfoOf(session);
    const ladder = ladderOf(stream);
    const pinned = ladder.top;
    const link = throttleOf(rules).kbps;
    // The scenario is only meaningful if ABR would want to leave the pinned rung: the arithmetic of the profile says that a link of
    // 1500 kbps carries 360p (764 kbps with its audio) and not 720p (1864).
    expect(
      pinned.variantBandwidth,
      `declared bandwidth of the pinned rung (the ladder): it must be more than the ${link} kbps link carries`,
    ).toBeGreaterThan(link * 1000);

    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    // The engines start on different rungs and ABR is free to move until the pin: Chromium starts on 720p and steps down to 360p
    // within its first second, the others start on 360p. A few seconds of playback first, so that the pin is the first thing
    // that moves the rung after that, whichever engine this is.
    await qa.waitForMediaTime(3, { timeoutMs: WAIT_MS });

    const logSince = await requestLogCursor(session);
    await qa.selectVariantByHeight(pinned.height);
    // From here on ABR is off. The cursor is taken after the pin has returned, so that nothing ABR decided before it can be counted.
    const eventsSince = await qa.cursor();
    const pinnedAt = (await qa.metrics()).playback.currentTime;

    // The positive event that opens the window: the origin is asked for the pinned rung. Then play the settle window past the
    // moment ABR would have stepped down (it decides at most every 8 s, on a segment download).
    await waitForRequest(session, (entry) => entry.kind === 'segment' && entry.rep === pinned.rep, {
      since: logSince,
      timeoutMs: WAIT_MS,
    });
    const window = settleWindowSeconds(stream.segmentDurationSec);
    await qa.waitForMediaTime(pinnedAt + window, { timeoutMs: WAIT_MS });

    // The player's account: not one change of rung after the pin, of any reason.
    const metrics = await qa.metrics();
    testInfo.annotations.push({
      type: 'measured',
      description: `pinned ${pinned.height}p at media ${pinnedAt.toFixed(1)} s, held to ${metrics.playback.currentTime.toFixed(1)} s; rebuffers ${metrics.rebuffer.count}`,
    });
    expect(
      describeVariantChanges(variantChanges(await qa.events(eventsSince))),
      `rung changes in the ${window} s after pinning ${pinned.height}p with selectVariantByHeight (qa.events()): none, ABR is off`,
    ).toBe('none');
    expect(metrics.bitrate.current?.height, 'active rung (metrics.bitrate.current) at the end').toBe(
      pinned.height,
    );
    expectHealthyPlayback(metrics);

    // The origin's account: from the first request of the pinned rung on, no other video segment was asked for, however late the
    // pinned ones arrived. The request that was in flight when the pin was made may be of the old rung, so it is not counted.
    const log = await session.service.log(session.id, logSince);
    const video = videoSegmentRequests(log);
    const fromPin = fromFirstOf(video, pinned.rep);
    expect(
      fromPin.filter((entry) => entry.rep !== pinned.rep).map((entry) => `${entry.rep} #${entry.number}`),
      `video segments requested after the first ${pinned.rep} one (request log): ${describeSegments(video)}`,
    ).toEqual([]);
    expect(
      fromPin.length,
      `${pinned.rep} segments requested in the window (request log): the player must keep fetching the pinned rung`,
    ).toBeGreaterThanOrEqual(3);
    // The precondition, from the origin: the link really could not carry the pinned rung (a segment took longer than it plays),
    // otherwise this test would pass on a lab that applied no throttle.
    const late = requestsFor(log, { kind: 'segment', rep: pinned.rep, status: 'ok' }).filter(
      (entry) => entry.totalMs > stream.segmentDurationSec * 1000,
    );
    expect(
      late.length,
      `${pinned.rep} segments the origin delivered in more than their ${stream.segmentDurationSec} s of playing time (request log): the ${link} kbps link must not carry the pinned rung`,
    ).toBeGreaterThan(0);
  },
);
