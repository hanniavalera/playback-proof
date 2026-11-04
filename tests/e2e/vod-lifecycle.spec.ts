import { profile } from '../../src/shared/profiles.ts';
import { expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestLogCursor, requestsFor } from './support/waiting.ts';
import { expectEndedAtTheEnd, waitForEnded } from './vod/ending.ts';
import { expectClockContinued, expectLanded, logAround, seekAndRecord } from './vod/seeking.ts';
import { allSegments, distinctAscending, middleOfSegment, segmentNumbers } from './vod/segments.ts';
import {
  CONTINUE_SEC,
  MIN_CONTROL_ADVANCE_SEC,
  OBSERVED_FRAMES,
  RESTART_TOLERANCE_SEC,
  RESUME_TOLERANCE_SEC,
} from './vod/tolerances.ts';

test(
  'PB-VOD-003 plays a short title to the end (vod-cmaf-short): ended fires near the duration, no rebuffer, no error',
  { tag: ['@release', '@dash'] },
  async ({ newSession, player }) => {
    const session = await newSession({
      stream: 'vod-cmaf-short',
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const ended = await waitForEnded(qa, session, info);

    // The player's side: the clock reached the end of the title (the catalog's duration, not the player's own idea of it).
    expectEndedAtTheEnd(ended, info);
    const metrics = await qa.metrics();
    expect(metrics.state, 'player state (metrics.state) after the end of the title').toBe('ended');
    expectNoRebuffer(metrics);
    expectNoErrors(metrics);

    // The origin's side: every segment of the title, the last one included, was delivered for both tracks.
    const log = await session.service.log(session.id);
    for (const track of ['video', 'audio'] as const) {
      expect(
        distinctAscending(segmentNumbers(log, info, track, { status: 'ok' })),
        `${track} segment numbers the origin delivered (request log), over every representation`,
      ).toEqual(allSegments(info.segmentCount));
    }
  },
);

test(
  'PB-VOD-004 pause stops the media clock: no media-time advance and no playing event while paused',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(middleOfSegment(await streamInfoOf(session), 2));

    // The positive control: the same window of frames moves the clock of a playing player, so "it did not move" below can fail.
    const beforeControl = (await qa.metrics()).playback.currentTime;
    await qa.observeFrames(OBSERVED_FRAMES);
    const afterControl = (await qa.metrics()).playback.currentTime;
    expect(
      afterControl - beforeControl,
      `media time (metrics.playback.currentTime) a playing player advanced across ${OBSERVED_FRAMES} frames of the page`,
    ).toBeGreaterThan(MIN_CONTROL_ADVANCE_SEC);

    const since = await qa.cursor();
    await qa.pause();
    const paused = (await qa.metrics()).playback;
    expect(paused.paused, 'the element is paused once pause() has resolved (metrics.playback.paused)').toBe(
      true,
    );

    await qa.observeFrames(OBSERVED_FRAMES);
    const held = await qa.metrics();
    expect(
      held.playback.currentTime,
      `media time (metrics.playback.currentTime) after ${OBSERVED_FRAMES} frames of the page while paused: it was ${paused.currentTime} s when pause() resolved`,
    ).toBe(paused.currentTime);
    expect(
      (await qa.events(since)).filter((event) => event.name === 'playing'),
      'playing events since the pause was acknowledged (qa.events())',
    ).toEqual([]);
  },
);

test(
  'PB-VOD-005 resume continues from the paused position: no jump, no seek, no rebuffer',
  { tag: ['@release', '@dash'] },
  async ({ newSession, streamFor, player }) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime(middleOfSegment(await streamInfoOf(session), 2));
    const beforePause = await qa.cursor();
    await qa.pause();
    const pausedAt = (await qa.waitFor('paused', { since: beforePause })).mediaTime;
    await qa.observeFrames(OBSERVED_FRAMES);

    const since = await qa.cursor();
    await qa.play();
    const resumedAt = (await qa.waitFor('playing', { since })).mediaTime;
    const reached = await qa.waitForMediaTime(pausedAt + CONTINUE_SEC);
    const timeline = await qa.events(since);

    // No jump: the clock restarts where it stopped (the `paused` and `playing` events of qa.events()) and goes on from there.
    expect(
      Math.abs(resumedAt - pausedAt),
      `distance in seconds between the media time of the playing event after the resume (${resumedAt} s) and of the paused event (${pausedAt} s)`,
    ).toBeLessThanOrEqual(RESUME_TOLERANCE_SEC);
    expectClockContinued(reached, pausedAt + CONTINUE_SEC, 'the clock jumped forward after the resume');
    // No seek: the element did not seek to resume.
    expect(
      timeline.filter((event) => event.name === 'seeking' || event.name === 'seeked'),
      'seeking and seeked events since play() was called (qa.events())',
    ).toEqual([]);
    expectNoRebuffer(await qa.metrics());
  },
);

test(
  'PB-VOD-010 seek into the last segment: playback runs on to ended',
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
    await qa.waitForMediaTime(1);

    const target = middleOfSegment(info, info.segmentCount);
    const logCursor = await requestLogCursor(session);
    const seek = await seekAndRecord(qa, target, { session, logCursor });
    const ended = await waitForEnded(qa, session, info, {
      since: seek.since,
      remainingSec: info.durationSec - target,
    });

    expectLanded(seek.seeked, target);
    expectEndedAtTheEnd(ended, info);
    expect((await qa.metrics()).state, 'player state (metrics.state) after the end of the title').toBe(
      'ended',
    );

    // The origin's side: the last segment of both tracks was asked for after the seek, and delivered.
    const { after } = await logAround(session, logCursor);
    for (const track of ['video', 'audio'] as const) {
      expect(
        segmentNumbers(after, info, track, { status: 'ok' }),
        `${track} segments the origin delivered after the seek (request log): the last one is ${info.segmentCount}`,
      ).toContain(info.segmentCount);
    }
  },
);

test(
  'PB-VOD-011 play after ended: play() restarts from the beginning without reloading',
  { tag: ['@release', '@dash'] },
  async ({ newSession, player }) => {
    const session = await newSession({
      stream: 'vod-cmaf-short',
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await waitForEnded(qa, session, info);

    const since = await qa.cursor();
    const logCursor = await requestLogCursor(session);
    await qa.play();
    const restartedAt = (await qa.waitFor('playing', { since })).mediaTime;
    const reached = await qa.waitForMediaTime(CONTINUE_SEC);
    const timeline = await qa.events(since);

    // From the beginning: the first `playing` after play() is at the start of the title and the clock runs on from there. A player that
    // stayed at the end would have the clock at 12 s here, which `waitForMediaTime(1)` accepts at once: the distance to 1 s is what shows it.
    expect(
      restartedAt,
      `media time of the playing event after play() (qa.events()); the title had ended at ${info.durationSec} s`,
    ).toBeLessThanOrEqual(RESTART_TOLERANCE_SEC);
    expectClockContinued(reached, CONTINUE_SEC, 'the clock did not restart from the beginning');
    const metrics = await qa.metrics();
    expect(metrics.state, 'player state (metrics.state) after play() on an ended title').toBe('playing');

    // Without reloading: the timeline has no load, and the origin was not asked for the manifest again.
    expect(
      timeline.filter((event) =>
        ['load-requested', 'manifest-loaded', 'loaded', 'unloaded'].includes(event.name),
      ),
      'load, manifest and unload events since play() was called (qa.events())',
    ).toEqual([]);
    const { after } = await logAround(session, logCursor);
    expect(
      requestsFor(after, { kind: 'manifest' }),
      'manifest requests the origin saw since play() was called (request log)',
    ).toEqual([]);
  },
);
