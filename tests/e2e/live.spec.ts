import { LIVE_LIMITS } from '../../src/shared/criteria.ts';
import { profile } from '../../src/shared/profiles.ts';
import {
  edgeAt,
  firstVideoSegmentRequest,
  liveClockOf,
  publishedEdge,
  publishedEndSec,
  seconds,
} from './live/edge.ts';
import { recordMeasured } from './live/measured.ts';
import { answeredManifest, describeCheckpoints, gapsBetween, rangeProblems } from './live/refresh.ts';
import type { Checkpoint } from './live/refresh.ts';
import { describeSeries, measuredLatencies, percentile, sampleLatency } from './live/series.ts';
import { expectHealthyPlayback, expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { requestsFor, waitForRequest, waitForRequests } from './support/waiting.ts';

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
    // `edge`; a player that misreads the live clock can agree with itself and still be far from this number (or past it).
    const publishedContext = `the origin had published segment ${edge}, which ends at ${publishedEndSec(live, edge)} s of the stream; the playhead was at ${joinedAt.toFixed(2)} s`;
    expect(
      behindPublishedMs,
      `distance behind the edge the origin had published: the playhead is ahead of what exists (${publishedContext})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      behindPublishedMs,
      `distance behind the edge the origin had published (${publishedContext}); the p95 limit is ${seconds(limitMs)}`,
    ).toBeLessThanOrEqual(limitMs);

    // Which request the join made first, and whether the origin could serve everything it asked for: a join that arrives in the
    // future (or before the window) is refused with a 404 long before a member sees it.
    expect(
      requestsFor(log, { status: 'error' }),
      'requests the origin refused or aborted during the join (request log)',
    ).toEqual([]);
    expect(segmentsBehind, 'the join requested no video segment (request log)').not.toBeNull();
    // Shaka asks for the segment BEFORE the one that holds the playhead (the buffer must reach behind it), so the first request is the
    // presentation delay plus one segment behind the edge at most; the p95 limit is the allowance on top of the delay.
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
    // where the playhead is: five reads, each of them after the window has slid by one more segment.
    const checkpoints: Checkpoint[] = [];
    let answered = await waitForRequests(session, answeredManifest(), { count: 1 });
    for (let refresh = 1; refresh <= REFRESHES; refresh++) {
      answered = await waitForRequests(session, answeredManifest(), { count: 1 + refresh });
      const metrics = await qa.metrics();
      const edge = await publishedEdge(session);
      checkpoints.push({
        refresh,
        arrivedMs: answered[refresh]?.msSinceStart ?? Number.NaN,
        mediaTime: metrics.playback.currentTime,
        latencyMs: metrics.live.latencyMs,
        edge,
      });
    }
    const cadenceMs = gapsBetween(answered);
    const loadEdge = edgeAt(live, (answered[0] as { t: string }).t);
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
      rangeProblems(point, live, { windowMs }).map((problem) => `refresh ${point.refresh}: ${problem}`),
    );
    expect(
      outside,
      `the playhead left the seek range at one of ${REFRESHES} manifest refreshes (the DVR window is ${windowMs / 1000} s). ${table}`,
    ).toEqual([]);

    // And playback went on: between two refreshes the media clock moved at least MIN_ADVANCE_SHARE of the time that passed.
    const stalled = checkpoints.flatMap((point, index) => {
      const previous = checkpoints[index - 1];
      if (!previous) {
        return point.mediaTime > joinedAt
          ? []
          : [`refresh 1: the media clock is still at the first frame, ${joinedAt.toFixed(2)} s`];
      }
      const elapsedSec = (point.arrivedMs - previous.arrivedMs) / 1000;
      const advancedSec = point.mediaTime - previous.mediaTime;
      return advancedSec >= elapsedSec * MIN_ADVANCE_SHARE
        ? []
        : [
            `refresh ${point.refresh}: the media clock advanced ${advancedSec.toFixed(2)} s in the ${elapsedSec.toFixed(2)} s since the previous refresh`,
          ];
    });
    expect(stalled, `playback did not go on across the manifest refreshes. ${table}`).toEqual([]);

    // The origin's side of "the player used the refreshes": the manifest it loaded listed segments up to `loadEdge`, so a segment
    // above it can only have been learned from a refresh, and the playhead only gets beyond the end of that first listing by playing it.
    const wanted = loadEdge + REFRESHES;
    await waitForRequest(
      session,
      (entry) =>
        entry.kind === 'segment' &&
        entry.rep !== undefined &&
        /^v\d+$/.test(entry.rep) &&
        (entry.number ?? 0) >= wanted,
    ).catch((error: Error) => {
      throw new Error(
        `the player never asked for a video segment from #${wanted} on, which only the refreshed manifests list (the one it loaded ended at #${loadEdge}). ${table}\n${error.message}`,
      );
    });
    // Nothing the player asked for was outside what the origin held: a segment older than its window or not yet published is a 404.
    expect(
      requestsFor(await session.service.log(session.id), { status: 'error' }),
      'requests the origin refused or aborted while the window slid (request log)',
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
