import { LIVE_FACTS, LIVE_LIMITS } from '../../src/shared/criteria.ts';
import { originStall } from '../../src/shared/profiles.ts';
import { currentEdge, originStalled, stallWindow } from './rec/live.ts';
import { expectAtMostRebuffers, expectHealthyPlayback } from './support/assertions.ts';
import { expect, test } from './support/fixtures.ts';
import { requestsFor } from './support/waiting.ts';

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
