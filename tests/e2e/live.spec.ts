import { LIVE_LIMITS } from '../../src/shared/criteria.ts';
import { profile } from '../../src/shared/profiles.ts';
import {
  deliveredVideoSegments,
  edgeAt,
  firstVideoSegmentRequest,
  liveClockOf,
  publishedEdge,
  publishedEndSec,
  refusedRequests,
  seconds,
} from './live/edge.ts';
import { recordMeasured } from './live/measured.ts';
import {
  advanceProblems,
  answeredManifest,
  describeCheckpoints,
  fetchesVideoSegmentFrom,
  gapsBetween,
  rangeProblems,
  readCheckpoints,
} from './live/refresh.ts';
import { describeSeries, measuredLatencies, percentile, sampleLatency } from './live/series.ts';
import { expectHealthyPlayback, expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { streamInfoOf } from './support/session.ts';
import { requestLogCursor, requestsFor, waitForRequest, waitForRequests } from './support/waiting.ts';

// A join plays this much media before the health of the instrument is read: a first frame alone proves the instrument little
// (the frame counters of some engines lag it), one segment of playing proves the join was not a single picture.
const PLAYED_AFTER_JOIN_SEC = 2;

/** The window of PB-LIVE-002, in seconds of media time from the first frame (the row says 20 s; media plays at 1x, so it is also 20 s of wall clock). */
const LATENCY_WINDOW_SEC = 20;

/**
 * Catch-up jumps to the live edge that a healthy window may contain. None: Shaka's live-sync is off in configurations A and B, so
 * nothing in the player is supposed to move the playhead on its own; a jump of 2 s or more to the edge means the playhead fell behind
 * far enough for something to correct it, and repeated jumps are the loop the row is about. The first one is already the finding.
 */
const MAX_EDGE_SEEKS = 0;

/** Refreshes of the manifest (or media playlist) that PB-LIVE-003 and PB-LIVE-004 live through after the load: the catalog says at least five. */
const REFRESHES = 5;

/**
 * The share of the time between two refreshes that the media clock must have advanced for the player to count as "playing on": a player
 * at 1x advances all of it (the refreshes are 2 s apart), one that has stalled for half of it has not kept playing. A margin, not a rate.
 */
const MIN_ADVANCE_SHARE = 0.5;

/** PB-LIVE-005: how far the viewer rewinds (the row's ten seconds), and how much is played before and after each seek so that it is a seek of a player that plays. */
const REWIND_SEC = 10;
const PLAYED_BEFORE_REWIND_SEC = 2;
const PLAYED_AFTER_SEEK_SEC = 2;

/** A seek lands within half a segment of its target: a clip to the start of the window is seconds away, a frame of slack is not. */
const LANDING_TOLERANCE_SEC = 1;

/**
 * PB-LIVE-006: how many live segments the origin publishes while the viewer is paused (the pause is bounded by the origin's clock, not
 * by a number of seconds), and how far the media clock may move while paused (a paused element's clock does not move at all: this is
 * the slack for the engine's own rounding) or differ from the paused position at the first `playing` after the resume.
 */
const PAUSED_SEGMENTS = 4;
const HELD_TOLERANCE_SEC = 0.1;
const RESUME_TOLERANCE_SEC = 0.5;
const PLAYED_BEFORE_PAUSE_SEC = 2;
const PLAYED_AFTER_RESUME_SEC = 2;

test(
  'PB-LIVE-001 joins near the live edge: first frame, and latency at the first frame within the p95 limit',
  { tag: ['@merge', '@cpu', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const limitMs = LIVE_LIMITS.latencyP95MaxMs;
    const qa = await player(session).open();

    await qa.waitFor('firstframe');
    // Everything is read at the first frame, before anything else can happen: the player's own number first, then the origin's.
    const atJoin = await qa.metrics();
    const edge = await publishedEdge(session);
    const log = await session.service.log(session.id);
    const joinedAt = atJoin.playback.currentTime;
    const behindPublishedMs = (publishedEndSec(live, edge) - joinedAt) * 1000;
    const first = firstVideoSegmentRequest(log);
    const edgeWhenAsked = first ? edgeAt(live, first.t) : null;
    const segmentsBehind =
      first?.number !== undefined && edgeWhenAsked !== null ? edgeWhenAsked - first.number : null;
    recordMeasured(testInfo, {
      latencyMs: atJoin.live.latencyMs,
      behindPublishedMs,
      startupMs: atJoin.startupMs,
      firstVideoSegment: first?.number ?? null,
      edgeWhenAsked,
      segmentsBehind,
    });

    // Channel 1, the player: the distance to the live edge by Shaka's own clock (docs/METRICS.md, "Live latency").
    expect(
      atJoin.live.isLive,
      'live presentation (metrics.live.isLive): the manifest was not played as live',
    ).toBe(true);
    expect(
      atJoin.live.latencyMs,
      'latency at the first frame (metrics.live.latencyMs) is null: it was never measured',
    ).not.toBeNull();
    const latencyMs = atJoin.live.latencyMs as number;
    expect(
      latencyMs,
      `latency at the first frame (metrics.live.latencyMs): the member joined at ${joinedAt.toFixed(2)} s of the stream, ${seconds(latencyMs)} behind the edge; the p95 limit is ${seconds(limitMs)} (LIVE_LIMITS.latencyP95MaxMs)`,
    ).toBeLessThanOrEqual(limitMs);

    // Channel 2, the origin: how far behind the edge the OTHER side says the playhead is. The edge it has published is the end of segment
    // `edge`; a player that misreads the live clock can agree with itself and still be far from this number (or past it). The origin
    // publishes whole segments while Shaka's edge is continuous, so this reading differs from the player's by up to a segment either
    // way (5.6 to 7.5 s against 6.2 to 7.2 s in the stability runs of ADR-100): it is held to the maximum limit, not to the p95 one.
    const publishedContext = `the origin had published segment ${edge}, which ends at ${publishedEndSec(live, edge)} s of the stream; the playhead was at ${joinedAt.toFixed(2)} s`;
    expect(
      behindPublishedMs,
      `distance behind the edge the origin had published: the playhead is ahead of what exists (${publishedContext})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      behindPublishedMs,
      `distance behind the edge the origin had published (${publishedContext}); the limit is ${seconds(LIVE_LIMITS.latencyMaxMs)} (LIVE_LIMITS.latencyMaxMs: the p95 limit and a segment of publication granularity)`,
    ).toBeLessThanOrEqual(LIVE_LIMITS.latencyMaxMs);

    // Which request the join made first, and whether the origin could serve everything it asked for: a join that arrives in the
    // future (or before the window) is refused with a 404 long before a member sees it.
    expect(refusedRequests(log), 'requests the origin refused during the join (request log)').toEqual([]);
    expect(segmentsBehind, 'the join requested no video segment (request log)').not.toBeNull();
    // The first request is for the segment that holds the playhead or, in Chromium and Firefox, the one before it (the buffer must reach
    // behind the playhead); the p95 limit in segments is the allowance on top of the presentation delay, plus that one segment.
    const allowedSegments = Math.ceil(limitMs / (live.segmentDurationSec * 1000)) + 1;
    expect(
      segmentsBehind as number,
      `segments between the origin's edge (${edgeWhenAsked}) and the first video segment requested (${first?.rep} #${first?.number}) when it was asked (request log)`,
    ).toBeLessThanOrEqual(allowedSegments);

    // It plays: a first frame that is followed by nothing is a join that failed.
    await qa.waitForMediaTime(joinedAt + PLAYED_AFTER_JOIN_SEC);
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
  },
);

test(
  'PB-LIVE-002 latency stays bounded over a 20 s window: maximum within the limit, no live-edge seek loop, no rebuffer',
  { tag: ['@merge', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const qa = await player(session).open();

    await qa.waitFor('firstframe');
    const from = (await qa.metrics()).playback.currentTime;
    // One read per second of media time, on the media clock: the series is what a failure is read from (drift or jitter).
    const samples = await sampleLatency(qa, { from, seconds: LATENCY_WINDOW_SEC });
    const metrics = await qa.metrics();
    const edge = await publishedEdge(session);
    const series = measuredLatencies(samples);
    const first = series[0] ?? null;
    const last = series.at(-1) ?? null;
    const behindPublishedMs = (publishedEndSec(live, edge) - metrics.playback.currentTime) * 1000;
    recordMeasured(testInfo, {
      latencyMaxMs: metrics.live.latencyMaxMs,
      latencyP95Ms: percentile(series, 95),
      latencyFirstMs: first,
      latencyLastMs: last,
      driftMs: first === null || last === null ? null : last - first,
      behindPublishedMs,
      edgeSeeks: metrics.live.edgeSeeks,
      rebuffers: metrics.rebuffer.count,
      windowSec: LATENCY_WINDOW_SEC,
      series,
    });

    // The player's maximum since the first frame, over every timeupdate of the window (not only the reads above).
    expect(
      metrics.live.latencyMaxMs,
      'maximum latency (metrics.live.latencyMaxMs) is null: it was never measured',
    ).not.toBeNull();
    const maxMs = metrics.live.latencyMaxMs as number;
    expect(
      maxMs,
      `maximum latency over ${LATENCY_WINDOW_SEC} s from the first frame (metrics.live.latencyMaxMs), limit ${seconds(LIVE_LIMITS.latencyMaxMs)} (LIVE_LIMITS.latencyMaxMs). Latency at each second of the window: ${describeSeries(samples, from)}`,
    ).toBeLessThanOrEqual(LIVE_LIMITS.latencyMaxMs);
    // The same claim from the origin's side: the playhead against the edge the service had published at the end of the window.
    expect(
      behindPublishedMs,
      `distance behind the edge the origin had published at the end of the window (segment ${edge} ends at ${publishedEndSec(live, edge)} s, the playhead was at ${metrics.playback.currentTime.toFixed(2)} s), limit ${seconds(LIVE_LIMITS.latencyMaxMs)}`,
    ).toBeLessThanOrEqual(LIVE_LIMITS.latencyMaxMs);

    expect(
      metrics.live.edgeSeeks,
      `jumps to the live edge the player made on its own (metrics.live.edgeSeeks, 'live-edge-seek' events): the playhead fell behind and was corrected`,
    ).toBeLessThanOrEqual(MAX_EDGE_SEEKS);
    expectNoRebuffer(metrics);
    expectHealthyPlayback(metrics);
  },
);

test(
  'PB-LIVE-003 manifest refresh keeps the playhead inside the seek range across at least five refreshes',
  { tag: ['@merge', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const windowMs = live.windowSegments * live.segmentDurationSec * 1000;
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const joinedAt = (await qa.metrics()).playback.currentTime;

    // Each refresh is awaited on the origin's log (the load is the first answer), and only then the player and the origin are asked
    // where the playhead is. The observation lasts until there were five refreshes AND the window has slid five segments.
    const { checkpoints, answered, loadEdge } = await readCheckpoints(session, qa, {
      isRefresh: answeredManifest(),
      refreshes: REFRESHES,
      slideSegments: REFRESHES,
      live,
    });
    const cadenceMs = gapsBetween(answered);
    recordMeasured(testInfo, {
      refreshesAnswered: answered.length - 1,
      refreshGapsMs: cadenceMs,
      playheads: checkpoints.map((point) => point.mediaTime),
      latenciesMs: checkpoints.map((point) => point.latencyMs),
      loadEdge,
      lastEdge: checkpoints.at(-1)?.edge ?? null,
    });
    const table = `The manifest was answered at these gaps (ms): ${cadenceMs.join(', ')}.\n${describeCheckpoints(checkpoints)}`;

    // Where the playhead is after each refresh, by the player's reading and by the origin's: the claim of the row.
    const outside = checkpoints.flatMap((point) =>
      rangeProblems(point, live).map((problem) => `refresh ${point.refresh}: ${problem}`),
    );
    expect(
      outside,
      `the playhead left the seek range at one of ${REFRESHES} manifest refreshes (the DVR window is ${windowMs / 1000} s). ${table}`,
    ).toEqual([]);

    // And playback went on: between two refreshes the media clock moved at least MIN_ADVANCE_SHARE of the time that passed.
    expect(
      advanceProblems(checkpoints, joinedAt, MIN_ADVANCE_SHARE),
      `playback did not go on across the manifest refreshes. ${table}`,
    ).toEqual([]);

    // The origin's side of "the player used the refreshes": the manifest it loaded listed segments up to `loadEdge`, so a segment
    // above it can only have been learned from a refresh, and the playhead only gets beyond the end of that first listing by playing it.
    const wanted = loadEdge + REFRESHES;
    await waitForRequest(session, fetchesVideoSegmentFrom(wanted)).catch((error: Error) => {
      throw new Error(
        `the player never asked for a video segment from #${wanted} on, which only the refreshed manifests list (the one it loaded ended at #${loadEdge}). ${table}\n${error.message}`,
      );
    });
    // Nothing the player asked for was outside what the origin held: a segment older than its window or not yet published is a 404.
    expect(
      refusedRequests(await session.service.log(session.id)),
      'requests the origin refused while the window slid (request log)',
    ).toEqual([]);

    const metrics = await qa.metrics();
    expect(
      metrics.playback.currentTime,
      `media time (metrics.playback.currentTime): the playhead has not played past the last second the manifest it loaded listed (${publishedEndSec(live, loadEdge)} s). ${table}`,
    ).toBeGreaterThan(publishedEndSec(live, loadEdge));
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
  },
);

test(
  'PB-LIVE-004 HLS live: joins, plays and stays inside the sliding window across at least five playlist refreshes',
  { tag: ['@merge', '@live', '@hls'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'hls'),
      protocol: 'hls',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const windowMs = live.windowSegments * live.segmentDurationSec * 1000;
    const { reps } = await streamInfoOf(session);
    const audioReps = reps.filter((rep) => rep.track === 'audio').map((rep) => rep.id);
    const videoReps = reps.filter((rep) => rep.track === 'video').map((rep) => rep.id);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const joinedAt = (await qa.metrics()).playback.currentTime;

    // The refresh that is counted is the one of the audio playlist: the player reloads the playlists of the variant it plays together
    // and the audio has a single representation, whereas the video playlist is another file each time ABR changes rung (a switch
    // would be one more request that is not a refresh). The video playlist is held to the same count below.
    const { checkpoints, answered, loadEdge } = await readCheckpoints(session, qa, {
      isRefresh: answeredManifest(audioReps),
      refreshes: REFRESHES,
      slideSegments: REFRESHES,
      live,
    });
    await waitForRequests(session, answeredManifest(videoReps), { count: 1 + REFRESHES }).catch(
      (error: Error) => {
        throw new Error(
          `the video playlist was not refreshed ${REFRESHES} times while the audio playlist was: the player stopped tracking the window of the picture.\n${error.message}`,
        );
      },
    );
    const log = await session.service.log(session.id);
    const cadenceMs = gapsBetween(answered);
    recordMeasured(testInfo, {
      refreshesAnswered: answered.length - 1,
      refreshGapsMs: cadenceMs,
      videoPlaylistAnswers: requestsFor(log, { kind: 'manifest', rep: videoReps, status: 'ok' }).length,
      playheads: checkpoints.map((point) => point.mediaTime),
      latenciesMs: checkpoints.map((point) => point.latencyMs),
      loadEdge,
      lastEdge: checkpoints.at(-1)?.edge ?? null,
    });
    const table = `The audio playlist was answered at these gaps (ms): ${cadenceMs.join(', ')}.\n${describeCheckpoints(checkpoints)}`;

    const outside = checkpoints.flatMap((point) =>
      rangeProblems(point, live).map((problem) => `refresh ${point.refresh}: ${problem}`),
    );
    expect(
      outside,
      `the playhead left the seek range at one of ${REFRESHES} playlist refreshes (the sliding window is ${windowMs / 1000} s). ${table}`,
    ).toEqual([]);
    expect(
      advanceProblems(checkpoints, joinedAt, MIN_ADVANCE_SHARE),
      `playback did not go on across the playlist refreshes. ${table}`,
    ).toEqual([]);

    // The playlist the player loaded listed segments up to `loadEdge` (the sequence number of a segment is its number in the URL), so a
    // segment above it can only have been learned from a refreshed playlist.
    const wanted = loadEdge + REFRESHES;
    await waitForRequest(session, fetchesVideoSegmentFrom(wanted)).catch((error: Error) => {
      throw new Error(
        `the player never asked for a video segment from #${wanted} on, which only the refreshed playlists list (the one it loaded ended at #${loadEdge}). ${table}\n${error.message}`,
      );
    });
    expect(
      refusedRequests(await session.service.log(session.id)),
      'requests the origin refused while the window slid (request log)',
    ).toEqual([]);

    const metrics = await qa.metrics();
    expect(
      metrics.live.isLive,
      'live presentation (metrics.live.isLive): the playlist was not played as live',
    ).toBe(true);
    expect(
      (await qa.info()).loadMode,
      'load mode (qa.info().loadMode): the lab plays HLS through Media Source Extensions, with the player parsing the playlists',
    ).toBe('media-source');
    expect(
      metrics.playback.currentTime,
      `media time (metrics.playback.currentTime): the playhead has not played past the last second the playlist it loaded listed (${publishedEndSec(live, loadEdge)} s). ${table}`,
    ).toBeGreaterThan(publishedEndSec(live, loadEdge));
    expectHealthyPlayback(metrics);
    expectNoErrors(metrics);
  },
);

test(
  'PB-LIVE-005 seek back into the DVR window, then return to the live edge',
  { tag: ['@release', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const windowMs = live.windowSegments * live.segmentDurationSec * 1000;
    const segmentMs = live.segmentDurationSec * 1000;
    const { reps } = await streamInfoOf(session);
    const videoReps = reps.filter((rep) => rep.track === 'video').map((rep) => rep.id);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    const joined = await qa.metrics();
    // A member rewinds after watching for a while, not in the first frame: one segment of playing first.
    await qa.waitForMediaTime(joined.playback.currentTime + PLAYED_BEFORE_REWIND_SEC);
    const before = await qa.metrics();
    const joinLatencyMs = before.live.latencyMs;
    expect(joinLatencyMs, 'latency before the rewind (metrics.live.latencyMs) is null').not.toBeNull();

    // The rewind: ten seconds back, well inside the 30 s window (the playhead sits about 6 s behind the edge, so the target is about
    // 16 s behind it). `seek` resolves on the `seeked` of its own `seeking`.
    const target = before.playback.currentTime - REWIND_SEC;
    const logBeforeRewind = await requestLogCursor(session);
    await qa.seek(target);
    const rewound = await qa.metrics();
    const edgeAtRewind = await publishedEdge(session);
    await qa.waitForMediaTime(rewound.playback.currentTime + PLAYED_AFTER_SEEK_SEC);
    const rewindLog = await session.service.log(session.id, logBeforeRewind);

    // The return: `seekToLiveEdge` resolves on its `seeked`; then the live edge has to be playing, not only reached.
    await qa.seekToLiveEdge();
    const returned = await qa.metrics();
    await qa.waitForMediaTime(returned.playback.currentTime + PLAYED_AFTER_SEEK_SEC);
    const settled = await qa.metrics();

    const returnLatencyMs = settled.live.latencyMs;
    const targetSegment = Math.floor(target / live.segmentDurationSec) + 1;
    const rewoundSegments = deliveredVideoSegments(rewindLog, videoReps);
    recordMeasured(testInfo, {
      joinLatencyMs,
      rewindTarget: target,
      rewindLandedAt: rewound.playback.currentTime,
      latencyAfterRewindMs: rewound.live.latencyMs,
      targetSegment,
      segmentsFetchedForRewind: rewoundSegments,
      returnedAt: returned.playback.currentTime,
      latencyAfterReturnMs: returnLatencyMs,
      edgeSeeks: settled.live.edgeSeeks,
    });

    // 1. The rewind lands where it was asked, inside the window: the seek range has not clipped it to its start.
    expect(
      Math.abs(rewound.playback.currentTime - target),
      `media time after seek(${target.toFixed(2)}) (metrics.playback.currentTime = ${rewound.playback.currentTime.toFixed(2)} s): the rewind did not land where it was asked; the origin's window starts at ${Math.max(0, edgeAtRewind - live.windowSegments) * live.segmentDurationSec} s`,
    ).toBeLessThanOrEqual(LANDING_TOLERANCE_SEC);
    expect(
      rewound.live.latencyMs,
      'latency after the rewind (metrics.live.latencyMs) is null: it was never measured',
    ).not.toBeNull();
    const rewoundLatencyMs = rewound.live.latencyMs as number;
    expect(
      rewoundLatencyMs,
      `latency after the rewind (metrics.live.latencyMs): ${seconds(rewoundLatencyMs)} behind the edge, and the DVR window is ${seconds(windowMs)}`,
    ).toBeLessThanOrEqual(windowMs);

    // 2. The origin served the rewound region: a video segment that covers the target, delivered whole, and nothing refused. (A request
    // the player abandoned is not a refusal: after the jump back to the edge Shaka cancels what it had asked for in the rewound region.)
    expect(
      rewoundSegments,
      `video segments the origin delivered after the rewind to ${target.toFixed(2)} s (request log): the segment that covers it is #${targetSegment}`,
    ).toContain(targetSegment);
    expect(
      refusedRequests(await session.service.log(session.id)),
      'requests the origin refused (request log)',
    ).toEqual([]);

    // 3. Back at the edge: the latency is that of the join, within the positioning granularity of one segment, and within the p95 limit.
    expect(returnLatencyMs, 'latency after the return (metrics.live.latencyMs) is null').not.toBeNull();
    const returnMs = returnLatencyMs as number;
    expect(
      returnMs,
      `latency after seekToLiveEdge() (metrics.live.latencyMs): ${seconds(returnMs)} behind the edge, the p95 limit is ${seconds(LIVE_LIMITS.latencyP95MaxMs)} (LIVE_LIMITS.latencyP95MaxMs); before the rewind it was ${seconds(joinLatencyMs as number)}`,
    ).toBeLessThanOrEqual(LIVE_LIMITS.latencyP95MaxMs);
    expect(
      Math.abs(returnMs - (joinLatencyMs as number)),
      `difference between the latency after seekToLiveEdge() (${seconds(returnMs)}) and before the rewind (${seconds(joinLatencyMs as number)}), limit one segment`,
    ).toBeLessThanOrEqual(segmentMs);
    expectHealthyPlayback(settled);
    expectNoErrors(settled);
  },
);

test(
  'PB-LIVE-006 pause and resume in live: resume continues from the paused position while it is inside the DVR window',
  { tag: ['@release', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      faults: profile('clean'),
    });
    const live = liveClockOf(session);
    const windowMs = live.windowSegments * live.segmentDurationSec * 1000;
    const segmentMs = live.segmentDurationSec * 1000;
    const { reps } = await streamInfoOf(session);
    const videoReps = reps.filter((rep) => rep.track === 'video').map((rep) => rep.id);
    const qa = await player(session).open();
    await qa.waitFor('firstframe');
    await qa.waitForMediaTime((await qa.metrics()).playback.currentTime + PLAYED_BEFORE_PAUSE_SEC);

    // The pause. `pause()` resolves on `paused`; the position, the origin's edge and both cursors are taken at that moment.
    await qa.pause();
    const atPause = await qa.metrics();
    const pausedAt = atPause.playback.currentTime;
    const edgeAtPause = await publishedEdge(session);
    const eventsFrom = await qa.cursor();
    const logFrom = await requestLogCursor(session);
    expect(atPause.playback.paused, 'media element after pause() (metrics.playback.paused)').toBe(true);

    // The pause lasts until the origin has published PAUSED_SEGMENTS more segments, and says so to the player: a manifest answered
    // after the edge reached that number. The window is the origin's clock, so the wait is a positive event of the server's log.
    const targetEdge = edgeAtPause + PAUSED_SEGMENTS;
    await waitForRequest(
      session,
      (entry) => answeredManifest()(entry) && edgeAt(live, entry.t) >= targetEdge,
      { since: logFrom, timeoutMs: (PAUSED_SEGMENTS + 3) * segmentMs },
    ).catch((error: Error) => {
      throw new Error(
        `the player did not ask for a manifest listing segment ${targetEdge} (the origin published ${edgeAtPause} when it was paused): it stopped tracking the live window while paused.\n${error.message}`,
      );
    });
    const held = await qa.metrics();
    const edgeAtResume = await publishedEdge(session);
    const duringPause = await qa.events(eventsFrom);
    const logDuringPause = await session.service.log(session.id, logFrom);

    // The resume. The first `playing` after it says where the media clock was when the player went on. That the clock then gets 2 s
    // beyond the paused position is this wait: a player that stalled at the resume rejects it, with its timeline. It is not asserted
    // again on `metrics()`: the wait resolves on the media time of a PRESENTED frame, which can be a few milliseconds ahead of
    // `video.currentTime` when that is read next (1.4 ms short in one of the first five runs).
    const resumeFrom = await qa.cursor();
    await qa.play();
    const playing = await qa.waitFor('playing', { since: resumeFrom });
    await qa.waitForMediaTime(pausedAt + PLAYED_AFTER_RESUME_SEC);
    const resumed = await qa.metrics();
    const afterResume = await qa.events(resumeFrom);
    recordMeasured(testInfo, {
      pausedAt,
      heldAt: held.playback.currentTime,
      pausedSegments: edgeAtResume - edgeAtPause,
      latencyBeforePauseMs: atPause.live.latencyMs,
      latencyAtResumeMs: held.live.latencyMs,
      latencyAfterResumeMs: resumed.live.latencyMs,
      playingAt: playing.mediaTime,
      resumedAt: resumed.playback.currentTime,
      manifestsWhilePaused: requestsFor(logDuringPause, { kind: 'manifest' }).length,
      videoSegmentsWhilePaused: requestsFor(logDuringPause, { kind: 'segment', rep: videoReps })
        .map((entry) => entry.number)
        .filter((n): n is number => n !== undefined),
    });

    // 1. The pause held the clock where it was, while the origin went on: nothing played, nothing jumped, in between.
    expect(
      Math.abs(held.playback.currentTime - pausedAt),
      `media time moved while paused: it is ${held.playback.currentTime.toFixed(2)} s after the origin published ${edgeAtResume - edgeAtPause} more segments, the player was paused at ${pausedAt.toFixed(2)} s (metrics.playback.currentTime)`,
    ).toBeLessThanOrEqual(HELD_TOLERANCE_SEC);
    expect(
      duringPause.filter((event) =>
        ['playing', 'seeking', 'seeked', 'live-edge-seek', 'error'].includes(event.name),
      ),
      'player events between the pause and the resume (qa.events()): none is expected from a paused player',
    ).toEqual([]);
    expect(
      edgeAtResume - edgeAtPause,
      'segments the origin published during the pause',
    ).toBeGreaterThanOrEqual(PAUSED_SEGMENTS);

    // 2. The resume continued from the paused position (not from the live edge, which is the paused latency plus the pause away) ...
    expect(
      Math.abs(playing.mediaTime - pausedAt),
      `media time of the first 'playing' after the resume, ${playing.mediaTime.toFixed(2)} s, against the paused position ${pausedAt.toFixed(2)} s`,
    ).toBeLessThanOrEqual(RESUME_TOLERANCE_SEC);
    expect(
      afterResume.filter((event) => ['seeking', 'live-edge-seek'].includes(event.name)),
      'seeks after the resume (qa.events()): the player must continue, not jump',
    ).toEqual([]);
    // ... and that position is still inside the DVR window: it is behind the edge by what it was before the pause plus the pause.
    expect(
      resumed.live.latencyMs,
      'latency after the resume (metrics.live.latencyMs) is null',
    ).not.toBeNull();
    const latencyMs = resumed.live.latencyMs as number;
    const latencyBeforeMs = atPause.live.latencyMs as number;
    expect(
      latencyMs,
      `latency after the resume (metrics.live.latencyMs): ${seconds(latencyMs)} behind the edge, and the DVR window is ${seconds(windowMs)}`,
    ).toBeLessThanOrEqual(windowMs);
    // The pause was longer than (published - 1) segments and the two latencies are read a moment apart, so one more segment is the margin.
    expect(
      latencyMs - latencyBeforeMs,
      `growth of the latency across the pause (metrics.live.latencyMs: ${seconds(latencyBeforeMs)} before, ${seconds(latencyMs)} after): the origin published ${edgeAtResume - edgeAtPause} segments meanwhile, so a resume from the paused position is about that many segments further behind; a much smaller growth is a jump towards the edge`,
    ).toBeGreaterThanOrEqual((edgeAtResume - edgeAtPause - 2) * segmentMs);
    expectNoRebuffer(resumed);
    expectHealthyPlayback(resumed);
    expectNoErrors(resumed);
  },
);
