import { profile } from '../../src/shared/profiles.ts';
import { expectHealthyPlayback, expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestsFor } from './support/waiting.ts';
import { originStartupSpanMs, sinceLoadRequested, videoFrameRate } from './vod/instrument.ts';
import { allSegments, distinctAscending, segmentNumbers } from './vod/segments.ts';
import {
  CLOCK_RESOLUTION_MS,
  FPS_MAX_SHARE,
  FPS_MIN_SHARE,
  FRAME_AGREEMENT_TOLERANCE,
  FRAME_WINDOW_SEC,
} from './vod/tolerances.ts';

test(
  'PB-VOD-012 metrics integrity on a clean network: decoded frames above zero, dropped no more than decoded, presented frames agree with decoded, no rebuffer, startup defined, no error',
  { tag: ['@merge', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('vod', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const info = await streamInfoOf(session);
    const frameRate = videoFrameRate(info);

    const openedAt = performance.now();
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const firstFrameWallMs = performance.now() - openedAt;
    await qa.waitForMediaTime(3);
    const windowStartedAt = performance.now();
    const measured = await qa.measureFrames(FRAME_WINDOW_SEC);
    const windowWallMs = performance.now() - windowStartedAt;
    const metrics = await qa.metrics();
    const events = await qa.events();
    const log = await session.service.log(session.id);
    const firstFrame = events.find((event) => event.name === 'firstframe');
    testInfo.annotations.push({
      type: 'readings',
      description: `decoded ${metrics.frames.decoded}, presented ${metrics.frames.presented}, dropped ${metrics.frames.dropped}; the first frame at ${firstFrame?.mediaTime} s of media time; the window: ${measured.presented} presented and ${measured.decoded} decoded frames in ${measured.mediaSeconds} s, ${measured.fps} fps; startup ${metrics.startupMs} ms`,
    });

    // Frames. Decoded and dropped are the browser's own counters; presented is counted from the browser's frame callbacks.
    const { decoded, dropped, droppedRatio, presented } = metrics.frames;
    expect(decoded, 'decoded frames (metrics.frames.decoded, from getVideoPlaybackQuality)').toBeGreaterThan(
      0,
    );
    expect(dropped, 'dropped frames (metrics.frames.dropped) against decoded frames').toBeLessThanOrEqual(
      decoded,
    );
    expect(droppedRatio, 'dropped ratio (metrics.frames.droppedRatio) is dropped / decoded').toBeCloseTo(
      dropped / decoded,
      9,
    );
    expect(
      presented,
      'presented frames (metrics.frames.presented) are null: requestVideoFrameCallback is missing in this engine, so the counter cannot be checked',
    ).not.toBeNull();
    // The decoded counter counts every frame since the load; the presented one counts from the first frame callback, so the frames the
    // clock ran through before the first presented frame (a slow first paint: media time 0.35 s at the first frame in a loaded Linux WebKit,
    // 0.00 to 0.02 s elsewhere) are decoded and never presented. They are the startup's, and are added back before the two are compared.
    const beforeFirstFrame = Math.round(frameRate * (firstFrame?.mediaTime ?? 0));
    expect(
      Math.abs((presented as number) + beforeFirstFrame - decoded),
      `distance in frames between presented (${presented}, plus ${beforeFirstFrame} for the ${firstFrame?.mediaTime} s of media time before the first frame) and decoded (${decoded}) frames since the load, ${dropped} dropped`,
    ).toBeLessThanOrEqual(FRAME_AGREEMENT_TOLERANCE);

    // The same counters over a window of media time, against what the stream and the clocks say: the stream is `frameRate` fps, and the
    // media clock cannot have run faster than the wall clock of this process (the window was measured with a player at rate 1).
    expect(
      measured.presented,
      'presented frames of the window (qa.measureFrames) are null: requestVideoFrameCallback is missing',
    ).not.toBeNull();
    expect(
      measured.fps,
      `effective frame rate (qa.measureFrames): ${measured.presented} presented and ${measured.decoded} decoded frames in ${measured.mediaSeconds} s of media time; the stream is ${frameRate} fps`,
    ).toBeGreaterThanOrEqual(frameRate * FPS_MIN_SHARE);
    expect(
      measured.fps,
      `effective frame rate (qa.measureFrames) above the stream's ${frameRate} fps: a page cannot present more frames than the stream has`,
    ).toBeLessThanOrEqual(frameRate * FPS_MAX_SHARE);
    expect(
      Math.abs((measured.presented as number) - measured.decoded),
      `distance in frames between presented (${measured.presented}) and decoded (${measured.decoded}) frames in the window`,
    ).toBeLessThanOrEqual(FRAME_AGREEMENT_TOLERANCE);
    expect(measured.dropped, 'dropped frames of the window against decoded frames').toBeLessThanOrEqual(
      measured.decoded,
    );
    // The window is anchored at frame callbacks, and the first one can report a frame that was presented up to one frame period before
    // the call was made: so the media time may exceed the wall time of the call by a frame period (and the clocks' resolution), no more.
    const frameMs = 1000 / frameRate;
    expect(
      measured.mediaSeconds * 1000,
      `milliseconds of media time the window says it covered, against the ${Math.round(windowWallMs)} ms of wall clock it took (plus a ${frameMs.toFixed(1)} ms frame)`,
    ).toBeLessThanOrEqual(windowWallMs + frameMs + CLOCK_RESOLUTION_MS);
    expect(measured.mediaSeconds, 'media seconds of the window (qa.measureFrames)').toBeGreaterThanOrEqual(
      FRAME_WINDOW_SEC,
    );

    // Startup is defined and plausible: it is the difference of the timeline's own events, the manifest and the load come before the
    // first frame in order, and it fits between what the origin's clock says the player cannot have done faster and the wall clock of
    // this process, which it cannot have outlasted.
    expect(
      metrics.startupMs,
      'startup time (metrics.startupMs) is null: the first frame was never presented',
    ).not.toBeNull();
    const startupMs = metrics.startupMs as number;
    const { manifestMs, loadedMs } = metrics.startup;
    expect(manifestMs, 'manifest time (metrics.startup.manifestMs) is null').not.toBeNull();
    expect(loadedMs, 'load time (metrics.startup.loadedMs) is null').not.toBeNull();
    expect(
      startupMs,
      'startup time (metrics.startupMs) against the load-requested and firstframe events',
    ).toBe(sinceLoadRequested(events, 'firstframe'));
    expect(manifestMs as number, 'manifest time (metrics.startup.manifestMs)').toBeGreaterThan(0);
    expect(
      manifestMs as number,
      `manifest time (metrics.startup.manifestMs) against load time (${loadedMs} ms): the manifest is parsed before the load resolves`,
    ).toBeLessThanOrEqual(loadedMs as number);
    expect(
      manifestMs as number,
      `manifest time (metrics.startup.manifestMs) against startup time (${startupMs} ms): the manifest comes before the first frame`,
    ).toBeLessThanOrEqual(startupMs);
    const manifestRequest = requestsFor(log, { kind: 'manifest' }).find((entry) => entry.rep === undefined);
    expect(manifestRequest, 'the manifest request in the origin log').toBeDefined();
    expect(
      manifestMs as number,
      `manifest time (metrics.startup.manifestMs) against the ${manifestRequest?.totalMs} ms the origin took to answer the manifest request (request log)`,
    ).toBeGreaterThanOrEqual((manifestRequest?.totalMs ?? 0) - CLOCK_RESOLUTION_MS);
    expect(
      startupMs,
      'startup time (metrics.startupMs) against the origin clock: from the manifest request to the delivery of the first video segment (request log)',
    ).toBeGreaterThanOrEqual(originStartupSpanMs(log, info) - CLOCK_RESOLUTION_MS);
    expect(
      startupMs,
      'startup time (metrics.startupMs) against the wall clock of the test from navigation to the first frame',
    ).toBeLessThanOrEqual(firstFrameWallMs);

    expectNoRebuffer(metrics);
    expectNoErrors(metrics);
  },
);

test(
  'PB-VOD-013 open-codec path (vod-webm, DASH): starts and plays 3 s',
  { tag: ['@release', '@dash'] },
  async ({ newSession, player }) => {
    const session = await newSession({ stream: 'vod-webm', protocol: 'dash', faults: profile('clean') });
    const info = await streamInfoOf(session);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const reached = await qa.waitForMediaTime(3);
    expect(reached, 'media time reached').toBeGreaterThanOrEqual(3);

    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
    expect(
      (await qa.info()).loadMode,
      'load mode (qa.info().loadMode): the lab plays everything through MSE',
    ).toBe('media-source');

    // It is the open-codec flavour that played: the player's variant carries the codecs of the WebM files, and the origin delivered
    // WebM initialization and media segments for both tracks and nothing else.
    const { current } = metrics.bitrate;
    const video = info.reps.find((rep) => rep.track === 'video' && rep.height === current?.height);
    const audio = info.reps.find((rep) => rep.track === 'audio');
    expect(
      current?.videoCodec,
      `video codec of the active variant (metrics.bitrate.current), the catalog says ${video?.codecs}`,
    ).toBe(video?.codecs);
    expect(
      current?.audioCodec,
      `audio codec of the active variant (metrics.bitrate.current), the catalog says ${audio?.codecs}`,
    ).toBe(audio?.codecs);
    const log = await session.service.log(session.id);
    expect(
      requestsFor(log, { kind: ['init', 'segment'], status: 'ok' })
        .filter((entry) => !entry.path.endsWith('.webm'))
        .map((entry) => entry.path),
      'media requests the origin answered that are not WebM (request log)',
    ).toEqual([]);
    for (const track of ['video', 'audio'] as const) {
      expect(
        distinctAscending(segmentNumbers(log, info, track, { status: 'ok' })),
        `${track} segment numbers the origin delivered (request log) for the first 3 s of media time`,
      ).toEqual(expect.arrayContaining(allSegments(2)));
    }
  },
);
