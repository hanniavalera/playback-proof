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
import { describeSeries, measuredLatencies, percentile, sampleLatency } from './live/series.ts';
import { expectHealthyPlayback, expectNoErrors, expectNoRebuffer } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { requestsFor } from './support/waiting.ts';

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
