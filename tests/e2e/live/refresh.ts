import type { LiveClockInfo, RequestLogEntry } from '../../../src/shared/api.ts';
import type { PlayerHandle } from '../support/player.ts';
import type { TestSession } from '../support/session.ts';
import { waitForRequests } from '../support/waiting.ts';
import { publishedEdge, publishedEndSec } from './edge.ts';

// What a live spec reads at each refresh of the manifest (or of the HLS media playlist): the origin's log says WHEN the refresh was
// answered, and only then are the player and the origin asked where the playhead is. Five refreshes means five reads, each after the
// window has slid by one more segment, and nothing in between that depends on a timer.

/**
 * A manifest or playlist request that the origin has answered with a 200: one refresh (the first one is the load). For DASH there is one
 * manifest and no `reps`; for HLS the media playlists carry the representation they list, and `reps` picks them (the master has none).
 */
export function answeredManifest(reps?: readonly string[]): (entry: RequestLogEntry) => boolean {
  return (entry) =>
    entry.kind === 'manifest' &&
    !entry.pending &&
    entry.status === 200 &&
    (reps === undefined || (entry.rep !== undefined && reps.includes(entry.rep)));
}

/** Milliseconds between consecutive entries of the log, by the time they arrived at the service (`msSinceStart`). */
export function gapsBetween(entries: readonly RequestLogEntry[]): number[] {
  return entries
    .slice(1)
    .map((entry, index) => Math.round(entry.msSinceStart - (entries[index]?.msSinceStart ?? 0)));
}

/** A request for a video segment numbered `number` or higher: the player asking for something that only a refreshed manifest lists. */
export function fetchesVideoSegmentFrom(number: number): (entry: RequestLogEntry) => boolean {
  return (entry) =>
    entry.kind === 'segment' &&
    entry.rep !== undefined &&
    /^v\d+$/.test(entry.rep) &&
    (entry.number ?? 0) >= number;
}

/** Where the playhead was, by the player and by the origin, right after a refresh was answered. */
export interface Checkpoint {
  /** 1 is the first refresh after the load. */
  refresh: number;
  /** When the service received that refresh, ms after the session was created. */
  arrivedMs: number;
  /** `video.currentTime`. */
  mediaTime: number;
  /** `metrics.live.latencyMs`. */
  latencyMs: number | null;
  /** The highest segment the origin had published, read just after the player's numbers. */
  edge: number;
}

/**
 * Waits for `refreshes` refreshes on the origin's log (those that `isRefresh` accepts; the answer that comes with the load is the first
 * entry and is not counted) and reads the player and the origin after each. Resolves with the readings and with every answered entry.
 */
export async function readCheckpoints(
  session: TestSession,
  qa: Pick<PlayerHandle, 'metrics'>,
  options: { isRefresh: (entry: RequestLogEntry) => boolean; refreshes: number },
): Promise<{ checkpoints: Checkpoint[]; answered: RequestLogEntry[] }> {
  const checkpoints: Checkpoint[] = [];
  let answered = await waitForRequests(session, options.isRefresh, { count: 1 });
  for (let refresh = 1; refresh <= options.refreshes; refresh++) {
    answered = await waitForRequests(session, options.isRefresh, { count: 1 + refresh });
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
  return { checkpoints, answered };
}

/**
 * What is wrong with the playhead at a checkpoint, as sentences (empty when nothing is). Two readings of "inside the seek range": the
 * player's own (latency is positive, so the playhead is behind the edge, and not more than the DVR depth, so it has not fallen out of the
 * window) and the origin's (the playhead is inside the stream the origin holds: no earlier than the start of the oldest segment of its
 * window, no later than the end of the newest published one).
 */
export function rangeProblems(point: Checkpoint, live: LiveClockInfo): string[] {
  const windowMs = live.windowSegments * live.segmentDurationSec * 1000;
  const problems: string[] = [];
  if (point.latencyMs === null) {
    problems.push('the player had no latency to report (metrics.live.latencyMs is null)');
  } else if (point.latencyMs <= 0) {
    problems.push(`the playhead is not behind the live edge (latency ${Math.round(point.latencyMs)} ms)`);
  } else if (point.latencyMs > windowMs) {
    problems.push(
      `the playhead is ${Math.round(point.latencyMs)} ms behind the edge, more than the ${windowMs} ms DVR window`,
    );
  }
  const windowStartSec = Math.max(0, point.edge - live.windowSegments) * live.segmentDurationSec;
  const publishedEnd = publishedEndSec(live, point.edge);
  if (point.mediaTime < windowStartSec) {
    problems.push(
      `the playhead ${point.mediaTime.toFixed(2)} s is before the start of the origin's window (${windowStartSec} s)`,
    );
  }
  if (point.mediaTime > publishedEnd) {
    problems.push(
      `the playhead ${point.mediaTime.toFixed(2)} s is past the edge the origin had published (${publishedEnd} s)`,
    );
  }
  return problems;
}

/**
 * Where playback did not go on: between two refreshes the media clock must have moved at least `minShare` of the time that passed (the
 * time is the origin's, from the arrival of the two refreshes), and after the first refresh it must have left the first frame.
 */
export function advanceProblems(
  checkpoints: readonly Checkpoint[],
  joinedAt: number,
  minShare: number,
): string[] {
  return checkpoints.flatMap((point, index) => {
    const previous = checkpoints[index - 1];
    if (!previous) {
      return point.mediaTime > joinedAt
        ? []
        : [`refresh 1: the media clock is still at the first frame, ${joinedAt.toFixed(2)} s`];
    }
    const elapsedSec = (point.arrivedMs - previous.arrivedMs) / 1000;
    const advancedSec = point.mediaTime - previous.mediaTime;
    return advancedSec >= elapsedSec * minShare
      ? []
      : [
          `refresh ${point.refresh}: the media clock advanced ${advancedSec.toFixed(2)} s in the ${elapsedSec.toFixed(2)} s since the previous refresh`,
        ];
  });
}

/** One line per checkpoint, for a failure message. */
export function describeCheckpoints(points: readonly Checkpoint[]): string {
  return points
    .map(
      (point) =>
        `  refresh ${point.refresh} answered at +${point.arrivedMs} ms: playhead ${point.mediaTime.toFixed(2)} s, latency ${point.latencyMs === null ? 'n/a' : `${Math.round(point.latencyMs)} ms`}, origin edge ${point.edge}`,
    )
    .join('\n');
}
