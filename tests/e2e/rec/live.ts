import type { TestSession } from '../support/fixtures.ts';

// The live side of the recovery specs: where an injected origin stall sits on the clock of the request log, and the origin's own
// state. A `live-stall` is timed by the live clock, so the log does not name its rule on a request (the origin does not fail any
// request: it stops publishing); the evidence that it happened is the origin's state and what the player requested while it lasted.

export interface StallWindow {
  /** The instant the origin stops publishing, in ms since the session was created: the unit of `RequestLogEntry.msSinceStart`. */
  startMs: number;
  /** The instant the origin catches up. */
  endMs: number;
}

/**
 * Where `originStall(atNumber, ms)` falls on the log's clock: it starts when segment `atNumber` is published (`AST + atNumber * d`;
 * a stall installed after that instant starts at installation, which only moves the window later) and lasts `ms`.
 */
export function stallWindow(session: TestSession, atNumber: number, ms: number): StallWindow {
  const { live } = session;
  if (!live) throw new Error(`the session ${session.id} is not live: it has no live clock to stall`);
  const publishedAtMs =
    Date.parse(live.availabilityStartTime) +
    atNumber * live.segmentDurationSec * 1000 -
    Date.parse(session.createdAt);
  return { startMs: publishedAtMs, endMs: publishedAtMs + ms };
}

/** The highest segment number the origin has published right now, read from the service (not from the creation of the session). */
export async function currentEdge(session: TestSession): Promise<number> {
  const { live } = await session.service.detail(session.id);
  if (!live) throw new Error(`the session ${session.id} is not live`);
  return live.edgeNumber;
}

/** Whether the origin is inside an injected stall right now: the service's own state. */
export async function originStalled(session: TestSession): Promise<boolean> {
  const { live } = await session.service.detail(session.id);
  if (!live) throw new Error(`the session ${session.id} is not live`);
  return live.stalled;
}
