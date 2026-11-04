import type { LiveClockInfo, RequestLogEntry } from '../../../src/shared/api.ts';
import type { TestSession } from '../support/session.ts';
import { requestsFor, rungsFetched } from '../support/waiting.ts';

// The live edge as the ORIGIN keeps it, which is the second channel of every live spec: the player says how far behind the edge it is
// (`qa.metrics().live.latencyMs`, measured against Shaka's own idea of the edge), the service says which segments it has published.
// A player whose idea of the edge is wrong (a manifest that misstates `availabilityStartTime`, a clock that is not the service's) can
// pass every check made with its own numbers; the published edge cannot be argued with.

/** The live clock the service reported when it created the session. A live spec needs a live stream; a VOD session has none. */
export function liveClockOf(session: Pick<TestSession, 'id' | 'stream' | 'live'>): LiveClockInfo {
  if (!session.live) {
    throw new Error(
      `session ${session.id} plays ${session.stream}, which has no live clock: a live spec must ask streamFor('live', ...)`,
    );
  }
  return session.live;
}

/** The highest live segment number the origin has published at this moment (docs/CONTRACTS.md section 3: the service's clock, not the page's). */
export async function publishedEdge(session: TestSession): Promise<number> {
  const live = (await session.service.detail(session.id)).live;
  if (!live)
    throw new Error(`the service reports no live clock for session ${session.id} (${session.stream})`);
  return live.edgeNumber;
}

/**
 * The edge of an origin that is not stalled, at an instant (an ISO time of the log, or epoch milliseconds):
 * `floor((t - availabilityStartTime) / segmentDuration)`, the formula of docs/CONTRACTS.md section 3. For turning the arrival time of a
 * logged request into "the origin had published segment N when this was asked". Do not use it while a `live-stall` rule is active.
 */
export function edgeAt(live: LiveClockInfo, instant: string | number): number {
  const at = typeof instant === 'number' ? instant : Date.parse(instant);
  const elapsedMs = at - Date.parse(live.availabilityStartTime);
  return Math.max(0, Math.floor(elapsedMs / (live.segmentDurationSec * 1000)));
}

/** Seconds of stream time the origin had published when its newest segment was `edge`: segment n covers [(n-1)*d, n*d), so the edge ends at `edge * d`. */
export function publishedEndSec(live: LiveClockInfo, edge: number): number {
  return edge * live.segmentDurationSec;
}

/** The first request for a video segment (arrival order), or undefined when none was made. Audio is not the picture a member joins. */
export function firstVideoSegmentRequest(log: readonly RequestLogEntry[]): RequestLogEntry | undefined {
  const rungs = rungsFetched(log);
  return requestsFor(log, { kind: 'segment', rep: rungs })[0];
}

/**
 * What the origin REFUSED: requests it answered with an error status (a segment outside its window is a 404, one not yet published too).
 * A request that the client abandoned is not one: a player cancels the segments it no longer needs when the viewer seeks or the
 * rung changes, and the log shows them as `aborted` with the status they had when the socket closed (a 200 with no body). The
 * support library's `status: 'error'` filter counts both, which is what a recovery spec wants and a seeking spec must not.
 */
export function refusedRequests(log: readonly RequestLogEntry[]): RequestLogEntry[] {
  return log.filter((entry) => !entry.pending && entry.status >= 400);
}

/** The video segment numbers the origin delivered whole (answered with a 2xx and not abandoned by the player), in arrival order. */
export function deliveredVideoSegments(
  log: readonly RequestLogEntry[],
  videoReps: readonly string[],
): number[] {
  return requestsFor(log, { kind: 'segment', rep: videoReps, status: 'ok' })
    .filter((entry) => entry.aborted !== true)
    .flatMap((entry) => (entry.number === undefined ? [] : [entry.number]));
}

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
