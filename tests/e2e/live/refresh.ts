import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { LiveClockInfo } from '../../../src/shared/api.ts';
import { publishedEndSec } from './edge.ts';

// What a live spec reads at each refresh of the manifest (or of the HLS media playlist): the server's log says WHEN the refresh was
// answered, and the player and the origin are asked where the playhead is at that moment.

/** The request log entry of a manifest or playlist request that the origin has answered with a 200: one refresh (the first one is the load). */
export function answeredManifest(rep?: string | RegExp): (entry: RequestLogEntry) => boolean {
  return (entry) =>
    entry.kind === 'manifest' &&
    !entry.pending &&
    entry.status === 200 &&
    (rep === undefined ||
      (entry.rep !== undefined && (typeof rep === 'string' ? entry.rep === rep : rep.test(entry.rep))));
}

/** Milliseconds between consecutive entries of the log, by the time they arrived at the service (`msSinceStart`). */
export function gapsBetween(entries: readonly RequestLogEntry[]): number[] {
  return entries
    .slice(1)
    .map((entry, index) => Math.round(entry.msSinceStart - (entries[index]?.msSinceStart ?? 0)));
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

export interface RangeLimits {
  /** The DVR depth, ms (`windowSegments * segmentDuration`). */
  windowMs: number;
}

/**
 * What is wrong with the playhead at a checkpoint, as sentences (empty when nothing is). Two readings of "inside the seek range": the
 * player's own (latency is positive, so the playhead is behind the edge, and not more than the DVR depth, so it has not fallen out of the
 * window) and the origin's (the playhead is inside the stream the origin holds: no earlier than the start of the oldest segment of its window, no later than the end
 * of the newest published one).
 */
export function rangeProblems(point: Checkpoint, live: LiveClockInfo, limits: RangeLimits): string[] {
  const problems: string[] = [];
  if (point.latencyMs === null)
    problems.push('the player had no latency to report (metrics.live.latencyMs is null)');
  else if (point.latencyMs <= 0)
    problems.push(`the playhead is not behind the live edge (latency ${Math.round(point.latencyMs)} ms)`);
  else if (point.latencyMs > limits.windowMs)
    problems.push(
      `the playhead is ${Math.round(point.latencyMs)} ms behind the edge, more than the ${limits.windowMs} ms DVR window`,
    );
  const windowStartSec = Math.max(0, point.edge - live.windowSegments) * live.segmentDurationSec;
  const publishedEnd = publishedEndSec(live, point.edge);
  if (point.mediaTime < windowStartSec)
    problems.push(
      `the playhead ${point.mediaTime.toFixed(2)} s is before the start of the origin's window (${windowStartSec} s)`,
    );
  if (point.mediaTime > publishedEnd)
    problems.push(
      `the playhead ${point.mediaTime.toFixed(2)} s is past the edge the origin had published (${publishedEnd} s)`,
    );
  return problems;
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
