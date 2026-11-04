import { LIVE_FACTS, LIVE_LIMITS } from '../../src/shared/criteria.ts';
import { originStall, staleManifest } from '../../src/shared/profiles.ts';
import { firedBy, ruleIdOf, waitForFault } from './rec/faults.ts';
import { currentEdge, originStalled, seekRangeLatencyBoundsMs, stallWindow } from './rec/live.ts';
import { expectAtMostRebuffers, expectHealthyPlayback } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { requestsFor, waitForRequest } from './support/waiting.ts';

// The recovery of a live event. A `live-stall` is timed by the live clock and fails no request: the origin stops publishing, the
// manifest it serves stays the same and nothing beyond its edge exists, until it catches up. So the request log does not name the
// rule on a request, and the proof that the fault happened is the origin's own state (`live.stalled`, read from the service) and
// what the player asked for while it lasted.

/** The stall starts when the third segment from now is published: four to six seconds from now. */
const STALL_AFTER_SEGMENTS = 3;

/**
 * The buffer runs dry `presentationDelaySec` after the stall starts (the playhead sits that far behind the edge), and the stall
 * starts at most `STALL_AFTER_SEGMENTS` segments from now; the rest is slack for a loaded runner.
 */
const DRAIN_WITHIN_MS =
  (STALL_AFTER_SEGMENTS * LIVE_FACTS.segmentSec + LIVE_FACTS.presentationDelaySec) * 1000 + 15_000;

/** The readiness limit of the recovery (the outage plus two segments), with the same slack: this spec asks whether the player resumes at all. */
const RESUME_WITHIN_MS = LIVE_LIMITS.stallRecoveryMaxMs + 15_000;

const PLAYED_AFTER_RESUME_SEC = 2;

test(
  'PB-REC-008 live origin stall: the player resumes after the origin returns, with at most one stall episode and no critical error left',
  { tag: ['@merge', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({ stream: streamFor('live', 'dash'), protocol: 'dash' });
    const qa = await player(session).open();
    await qa.waitFor('firstframe');

    // The origin stops publishing three segments from now and stays silent for 10 s, longer than the 6 s the player lives on.
    const atNumber = (await currentEdge(session)) + STALL_AFTER_SEGMENTS;
    await session.service.addFaults(session.id, originStall(atNumber, LIVE_LIMITS.injectedStallMs));
    const window = stallWindow(session, atNumber, LIVE_LIMITS.injectedStallMs);
    const since = await qa.cursor();

    // The player lives on its buffer until the buffer runs dry, and the origin is stalled at that moment (the service says so): the
    // fault happened and it is what the player is waiting for. The edge the service reports during the stall is the frozen one.
    const stalled = await qa.waitFor('buffering-start', { since, timeoutMs: DRAIN_WITHIN_MS });
    expect(
      await originStalled(session),
      'origin stalled when the player ran dry (service state live.stalled)',
    ).toBe(true);
    const frozenEdge = await currentEdge(session);
    expect(
      frozenEdge,
      'frozen edge (service state live.edgeNumber) against the stall start',
    ).toBeGreaterThanOrEqual(atNumber);

    // The player resumes once the origin is back: `playing` after the stall, and the service says the origin is not stalled.
    const resumed = await qa.waitFor('playing', { since: stalled.index, timeoutMs: RESUME_WITHIN_MS });
    expect(
      await originStalled(session),
      'origin stalled when the player resumed (service state live.stalled)',
    ).toBe(false);
    const latencyAtResumeMs = (await qa.metrics()).live.latencyMs;
    await qa.waitForMediaTime(resumed.mediaTime + PLAYED_AFTER_RESUME_SEC);

    // The origin's side: while it was stalled the player asked for nothing beyond the frozen edge, and it did ask for it afterwards.
    const log = await session.service.log(session.id);
    const beyond = requestsFor(log, {
      kind: 'segment',
      number: { from: frozenEdge + 1, to: Number.MAX_SAFE_INTEGER },
    });
    expect(
      beyond
        .filter((entry) => entry.msSinceStart < window.endMs)
        .map((entry) => `#${entry.seq} ${entry.rep} ${entry.number}`),
      `segments above the frozen edge ${frozenEdge} requested before the origin returned at +${window.endMs} ms (request log)`,
    ).toEqual([]);
    expect(
      beyond.length,
      `segments above the frozen edge ${frozenEdge} requested after the origin returned (request log)`,
    ).toBeGreaterThan(0);

    // The player's side: no critical error is left, the viewer saw one stall (at most), and the player is playing again.
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectAtMostRebuffers(metrics, 1);
    expect(metrics.playback.paused, 'paused (metrics.playback.paused) after the recovery').toBe(false);
    const [episode] = metrics.rebuffer.events;
    testInfo.annotations.push({
      type: 'recovery',
      description: `stall window +${Math.round(window.startMs)}..+${Math.round(window.endMs)} ms on the log clock, frozen edge ${frozenEdge}; the player stalled for ${Math.round(episode?.durationMs ?? 0)} ms at media time ${episode?.mediaTime.toFixed(2)} s; latency ${Math.round(latencyAtResumeMs ?? 0)} ms at resume and ${Math.round(metrics.live.latencyMs ?? 0)} ms ${PLAYED_AFTER_RESUME_SEC} s of media later (target ${metrics.live.presentationDelayMs} ms); ${metrics.errors.length} errors`,
    });
  },
);

/**
 * The manifest stays stale longer than the DVR window is deep, so the origin's window slides past the playhead. The stale body lists
 * the segments up to the edge of the moment the window opens (about 30 s of media), the playhead plays them (it sits 6 s behind
 * that edge) and stops at the end of the list. The seek range starts `DVR depth` behind the origin's edge, which keeps moving: it
 * passes the stopped playhead one DVR depth after the window opened, and the window lasts one segment more, so for 2 s the
 * playhead is outside the seek range when fresh manifests return. With the default DVR depth (30 s) that takes 36 s, too long for
 * a test; a window of 5 segments (10 s, the shortest that holds the 6 s presentation delay with room to spare) takes 12 s.
 * It opens one second after the first media request, so that the player has loaded a good manifest first.
 */
const DVR_SEGMENTS = 5;
const STALE_AFTER_MS = 1000;
const STALE_MS = (DVR_SEGMENTS + 1) * LIVE_FACTS.segmentSec * 1000;

/** The stale refreshes the log must show: one every update period for the length of the window, two fewer for late timers. */
const MIN_STALE_ANSWERS = STALE_MS / (LIVE_FACTS.manifestUpdatePeriodSec * 1000) - 2;

/** Media played after the player resumes, to show that it keeps playing and not just that it blinked. */
const PLAYED_AFTER_RECOVERY_SEC = 3;

test(
  'PB-REC-009 stale live manifest: playback continues from the buffer, and after fresh manifests return the playhead is inside the seek range',
  { tag: ['@release', '@live', '@dash'] },
  async ({ newSession, streamFor, player }, testInfo) => {
    test.setTimeout(60_000);
    const session = await newSession({
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      live: { windowSegments: DVR_SEGMENTS },
      faults: staleManifest(STALE_MS, STALE_AFTER_MS),
    });
    const rule = await ruleIdOf(session);
    const qa = await player(session).open();
    const firstFrame = await qa.waitFor('firstframe');

    // The fault fired: the player polled during the window and the origin answered with the body it had served before the window
    // opened (the same bytes as the first manifest, which no rule touched).
    const [stale] = await waitForFault(session, rule);
    const [initial] = requestsFor(await session.service.log(session.id), { kind: 'manifest' });
    expect(stale.kind, 'kind of the request the rule fired on (request log)').toBe('manifest');
    expect(stale.status, 'status of the stale answer (request log)').toBe(200);
    expect(
      initial && firedBy(initial, rule),
      'the first manifest answered before the window (request log)',
    ).toBe(false);
    expect(stale.bytes, 'bytes of the stale answer against the first manifest (request log)').toBe(
      initial?.bytes,
    );

    // The player lives on its buffer: it plays everything the stale manifest lists, to within a second, and only then does it stall.
    const stalled = await qa.waitFor('buffering-start', { since: firstFrame.index });

    // Fresh manifests return: the first request the rule no longer answers.
    const fresh = await waitForRequest(
      session,
      (entry) =>
        entry.kind === 'manifest' && entry.seq > stale.seq && !entry.pending && !firedBy(entry, rule),
      { timeoutMs: STALE_MS + 10_000 },
    );
    expect(fresh.status, 'status of the first manifest after the window (request log)').toBe(200);
    const log = await session.service.log(session.id);
    const listedEndSec =
      Math.max(
        ...requestsFor(log, { kind: 'segment' })
          .filter((entry) => entry.seq < fresh.seq && /^v\d+$/.test(entry.rep ?? ''))
          .map((entry) => entry.number ?? 0),
      ) * LIVE_FACTS.segmentSec;
    expect(
      stalled.mediaTime,
      `media time of the stall: the end of the media the stale manifest lists (${listedEndSec} s), less a second`,
    ).toBeGreaterThanOrEqual(listedEndSec - 1);

    // The playhead was stranded: when fresh manifests return the seek range has moved past the point where it stopped. This is the
    // spec's own condition (the window outlived the DVR depth), checked on the origin's state and not assumed.
    const edgeNow = await currentEdge(session);
    const seekStartSec = (edgeNow - DVR_SEGMENTS) * LIVE_FACTS.segmentSec;
    expect(
      stalled.mediaTime,
      `media time of the stall against the start of the seek range when fresh manifests returned (edge ${edgeNow} less ${DVR_SEGMENTS} segments)`,
    ).toBeLessThan(seekStartSec);

    // The player resumes and keeps playing.
    const resumed = await qa.waitFor('playing', { since: stalled.index, timeoutMs: STALE_MS + 10_000 });
    await qa.waitForMediaTime(resumed.mediaTime + PLAYED_AFTER_RECOVERY_SEC);

    // The origin's side: the player kept polling at the pace of the manifest through the whole window, and it was answered stale.
    const manifests = requestsFor(await session.service.log(session.id), { kind: 'manifest' });
    const answeredStale = manifests.filter((entry) => firedBy(entry, rule));
    expect(
      answeredStale.length,
      `manifest requests answered stale (request log: ${manifests.map((entry) => `+${Math.round(entry.msSinceStart)}${firedBy(entry, rule) ? ' stale' : ''}`).join(', ')})`,
    ).toBeGreaterThanOrEqual(MIN_STALE_ANSWERS);
    const gaps = manifests
      .slice(1)
      .map((entry, index) => entry.msSinceStart - (manifests[index]?.msSinceStart ?? 0));
    expect(Math.max(...gaps), 'longest gap between manifest requests (request log)').toBeLessThanOrEqual(
      LIVE_LIMITS.manifestMaxGapMs,
    );

    // The player's side: nothing critical, at most one stall, and the playhead is back inside the seek range.
    const metrics = await qa.metrics();
    expectHealthyPlayback(metrics);
    expectAtMostRebuffers(metrics, 1);
    const { minMs, maxMs } = seekRangeLatencyBoundsMs(session);
    const latencyMs = metrics.live.latencyMs ?? Number.NaN;
    expect(
      latencyMs,
      'live latency (metrics.live.latencyMs) after the fresh manifests: not behind the seek range',
    ).toBeLessThanOrEqual(maxMs);
    expect(
      latencyMs,
      'live latency (metrics.live.latencyMs) after the fresh manifests: not ahead of the seek range',
    ).toBeGreaterThanOrEqual(minMs);
    testInfo.annotations.push({
      type: 'recovery',
      description: `${answeredStale.length} manifest requests answered stale (${stale.bytes} bytes) from +${Math.round(stale.msSinceStart)} ms, the first fresh one at +${Math.round(fresh.msSinceStart)} ms; the playhead stopped at ${stalled.mediaTime.toFixed(2)} s (the stale list ends at ${listedEndSec} s) and the seek range started at ${seekStartSec} s when fresh manifests returned; ${metrics.live.edgeSeeks} jumps forward by the player while stale; resumed at ${resumed.mediaTime.toFixed(2)} s; latency ${Math.round(latencyMs)} ms (inside the range up to ${maxMs} ms); longest gap between manifest requests ${Math.round(Math.max(...gaps))} ms; ${metrics.errors.length} errors`,
    });
  },
);
