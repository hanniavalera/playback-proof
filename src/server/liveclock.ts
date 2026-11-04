import { GONE_MARGIN_SEGMENTS } from './constants.ts';

// The virtual live clock (docs/CONTRACTS.md section 3, "Live simulation", and section 5 for `live-stall`). Pure functions over data and
// a "now": no timers, no state. A session keeps the parameters and the installed stalls; every question is answered for a given instant.
//
//   segment n covers [(n-1)*d, n*d) of the stream timeline and is published at AST + n*d
//   free-running edge at wall clock t:  floor((t - AST) / d)

export interface LiveParams {
  /** Epoch ms of stream time 0 (DASH availabilityStartTime). */
  availabilityStartMs: number;
  segmentDurationMs: number;
  windowSegments: number;
  presentationDelaySec: number;
}

/** An installed `live-stall` rule. */
export interface LiveStall {
  ruleId: string;
  /** Live segment number at which the origin stops publishing. */
  atNumber: number;
  ms: number;
  /** Epoch ms at which the rule was installed: a stall installed after `atNumber` was published starts now. */
  installedAtMs: number;
}

export interface LiveView {
  /** The highest segment number published at this instant (the frozen one during a stall). */
  edge: number;
  /** First segment number the manifest lists. */
  firstNumber: number;
  /** Last segment number the manifest lists (= edge). */
  lastNumber: number;
  /** When this manifest version was published: the publication instant of the edge segment. Frozen during a stall. */
  publishTimeMs: number;
  stalled: boolean;
}

export type Availability = 'available' | 'not-yet' | 'gone';

/** The edge of an origin that never stalls. 0 before the first segment is published. */
export function freeEdge(params: LiveParams, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - params.availabilityStartMs) / params.segmentDurationMs));
}

/** The instant a stall starts: when segment `atNumber` would be published, or its installation when that is already in the past. */
export function stallStartMs(params: LiveParams, stall: LiveStall): number {
  return Math.max(
    params.availabilityStartMs + stall.atNumber * params.segmentDurationMs,
    stall.installedAtMs,
  );
}

/**
 * What the origin publishes at `nowMs`. During a stall the edge is frozen at the free-running edge of the instant the stall
 * started; when several stalls are active the earliest freeze wins (min), so the edge never moves backwards and a segment that
 * was published is never unpublished. When the last stall ends the origin catches up: the edge is the free-running one again.
 */
export function liveView(params: LiveParams, stalls: readonly LiveStall[], nowMs: number): LiveView {
  let edge = freeEdge(params, nowMs);
  let stalled = false;
  for (const stall of stalls) {
    const start = stallStartMs(params, stall);
    if (nowMs < start || nowMs >= start + stall.ms) continue;
    stalled = true;
    edge = Math.min(edge, freeEdge(params, start));
  }
  return {
    edge,
    firstNumber: Math.max(1, edge - params.windowSegments + 1),
    lastNumber: edge,
    publishTimeMs: params.availabilityStartMs + edge * params.segmentDurationMs,
    stalled,
  };
}

/** Is live segment `n` served? Not yet published: 404. Older than the window by more than the margin: 404 (gone). */
export function availability(view: LiveView, n: number): Availability {
  if (!Number.isInteger(n) || n < 1 || n > view.lastNumber) return 'not-yet';
  if (n < view.firstNumber - GONE_MARGIN_SEGMENTS) return 'gone';
  return 'available';
}
