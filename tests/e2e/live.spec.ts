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
import { expectHealthyPlayback, expectNoErrors } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { requestsFor } from './support/waiting.ts';

// A join plays this much media before the health of the instrument is read: a first frame alone proves the instrument little
// (the frame counters of some engines lag it), one segment of playing proves the join was not a single picture.
const PLAYED_AFTER_JOIN_SEC = 2;

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
