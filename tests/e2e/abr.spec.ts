import { profile } from '../../src/shared/profiles.ts';
import { ladderOf } from './abr/ladder.ts';
import { describeSegments, videoSegmentRequests } from './abr/log.ts';
import { describeVariantChanges, variantChanges } from './abr/variants.ts';
import { expectHealthyPlayback, expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestLogCursor, waitForRequest } from './support/waiting.ts';

// ABR tests are the slowest of the lab: the player's adaptation runs on seconds (Shaka's `abr.switchInterval` is 8 s, its buffering
// goal 10 s), so a test is 20 to 40 s of real playback. They need their own budget; every wait inside has its own, generous one.
const ABR_TEST_TIMEOUT_MS = 90_000;
const WAIT_MS = 40_000;

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
    const stragglers = after
      .slice(after.findIndex((entry) => entry.rep === target.rep))
      .filter((entry) => entry.rep !== target.rep);
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
