import { profile } from '../../src/shared/profiles.ts';
import { expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestLogCursor } from './support/waiting.ts';
import { middleOfSegment, segmentCovering, segmentNumbers } from './vod/segments.ts';
import {
  expectClockContinued,
  expectLanded,
  farTarget,
  fetchedAgain,
  logAround,
  rapidTargets,
  refetched,
  seekAndRecord,
} from './vod/seeking.ts';
import { CONTINUE_SEC, EVICTION_PLAY_SEC } from './vod/tolerances.ts';

test(
  'PB-VOD-006 seek forward inside the buffered range: seeked fires and playback continues from the target with no rebuffer',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(2);

    // Two seconds in, the player holds about ten seconds ahead of the playhead (its buffering goal): the middle of the fourth segment is inside.
    const target = middleOfSegment(info, 4);
    const { playback } = await qa.metrics();
    expect(
      playback.bufferedAheadSec,
      `premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (${playback.currentTime} s) when the seek to ${target} s is made (metrics.playback.bufferedAheadSec)`,
    ).toBeGreaterThan(target - playback.currentTime + 1);

    const logCursor = await requestLogCursor(session);
    const seek = await seekAndRecord(qa, target);
    const reached = await qa.waitForMediaTime(target + CONTINUE_SEC);

    // What the viewer got: the seek finished where it was asked to, playback went on from there and did not jump.
    expectLanded(seek.seeked, target);
    expectClockContinued(reached, target + CONTINUE_SEC, 'the clock jumped after the seek');
    expectNoRebuffer(await qa.metrics());

    // What the origin saw: a seek inside the buffer is served by the buffer, so nothing the player already had is asked for again.
    const around = await logAround(session, logCursor);
    expect(
      refetched(info, 'video', around),
      'video segments requested before the seek and again after it from the same representation (request log): the buffer did not serve the seek',
    ).toEqual([]);
  },
);

test(
  'PB-VOD-007 seek to an unbuffered position: seeked, playback from the target, and the request log shows the segment that covers it and no refetch of earlier ones',
  { tag: ['@merge', '@cpu', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(2);

    const target = farTarget(info);
    const covering = segmentCovering(info, target);
    const logCursor = await requestLogCursor(session);
    const seek = await seekAndRecord(qa, target);
    const reached = await qa.waitForMediaTime(target + CONTINUE_SEC);

    expectLanded(seek.seeked, target);
    expectClockContinued(reached, target + CONTINUE_SEC, 'the clock jumped after the seek');

    // The origin's side. The player may start a segment early (Shaka looks the first segment up `inaccurateManifestTolerance` before the
    // target, 2 s, in the engines that do not use cross-boundary logic), so what is required is the covering segment and no refetch.
    const around = await logAround(session, logCursor);
    expect(
      segmentNumbers(around.after, info, 'video'),
      `video segments requested after the seek (request log): segment ${covering} covers ${target} s`,
    ).toContain(covering);
    expect(
      refetched(info, 'video', around),
      'video segments requested before the seek and again after it from the same representation (request log): segments the player already had',
    ).toEqual([]);
  },
);

test(
  'PB-VOD-008 seek backward to a position the buffer has already evicted: playback resumes from the target',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(2);

    // The beginning of the title has been played and fetched. A seek to an unbuffered position far ahead empties the buffer (Shaka
    // flushes it), and three seconds of playback there leave the beginning more than the 30 s that `streaming.bufferBehind` keeps behind.
    const early = middleOfSegment(info, 2);
    const far = farTarget(info);
    await qa.seek(far);
    await qa.waitForMediaTime(far + EVICTION_PLAY_SEC);

    const logCursor = await requestLogCursor(session);
    const back = await seekAndRecord(qa, early);
    const reached = await qa.waitForMediaTime(early + CONTINUE_SEC);

    expectLanded(back.seeked, early);
    expectClockContinued(reached, early + CONTINUE_SEC, 'the clock jumped after the seek back');

    // The origin's side, and the proof that the premise held: the segment that covers the target had been fetched at the start and is
    // fetched again, so the buffer did not have it any more.
    const around = await logAround(session, logCursor);
    const covering = segmentCovering(info, early);
    expect(
      fetchedAgain(info, 'video', around),
      `video segment numbers requested before the seek back (${segmentNumbers(around.before, info, 'video').join(', ')}) and again after it (${segmentNumbers(around.after, info, 'video').join(', ')}) in the request log: segment ${covering} covers ${early} s, so it must be among the ones fetched again, or the player still had it and the position was not evicted`,
    ).toContain(covering);
  },
);

test(
  'PB-VOD-009 rapid repeated seeks: five seeks issued back to back, the last target wins, playback resumes, no error',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(2);

    const targets = rapidTargets(info);
    const last = targets[targets.length - 1] as number;
    const since = await qa.cursor();
    const logCursor = await requestLogCursor(session);
    // Five calls on the handle without awaiting in between: the commands reach the page one after the other within a few milliseconds,
    // long before the first of them can be satisfied (every target is outside the buffer, so each needs a segment from the origin).
    const outcomes = await Promise.allSettled(targets.map((target) => qa.seek(target)));
    const unresolved = outcomes.flatMap((outcome, index) =>
      outcome.status === 'rejected'
        ? [`seek ${index + 1} of ${targets.length} (to ${targets[index]} s): ${String(outcome.reason)}`]
        : [],
    );
    expect(unresolved, 'seeks that never resolved on a seeked of their own').toEqual([]);

    // The race was run: no seek finished before the last one was issued. Then the last one wins: the seeked that follows the last seeking
    // is where the clock is, and playback goes on from there.
    const timeline = await qa.events(since);
    const lastSeeking = timeline.filter((event) => event.name === 'seeking').at(-1);
    const settled = timeline.find(
      (event) => event.name === 'seeked' && lastSeeking !== undefined && event.index > lastSeeking.index,
    );
    expect(
      timeline.filter((event) => event.name === 'seeked' && event.index < (lastSeeking?.index ?? 0)),
      'seeked events before the last seeking: a seek finished before the last one was issued, so the five seeks did not overlap and the run did not exercise the race',
    ).toEqual([]);
    expect(settled, 'the seeked event that follows the last seeking (qa.events())').toBeDefined();
    expectLanded({ mediaTime: settled?.mediaTime ?? Number.NaN }, last);
    const reached = await qa.waitForMediaTime(last + CONTINUE_SEC);
    expectClockContinued(reached, last + CONTINUE_SEC, 'the clock jumped after the seeks');
    const metrics = await qa.metrics();
    expect(
      metrics.state,
      'player state (metrics.state) once the clock has moved on from the last target',
    ).toBe('playing');
    expectNoErrors(metrics);

    const around = await logAround(session, logCursor);
    expect(
      segmentNumbers(around.after, info, 'video'),
      `video segments requested after the seeks (request log): segment ${segmentCovering(info, last)} covers the last target, ${last} s`,
    ).toContain(segmentCovering(info, last));
  },
);
