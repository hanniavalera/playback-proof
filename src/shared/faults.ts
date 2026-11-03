// Fault injection contract. A fault rule is data: tests send it to the service, the service applies it to the requests of
// ONE session. Faults are applied on the server side so that the network conditions are identical in every browser engine
// (CDP network emulation exists in Chromium only). See docs/DESIGN_DECISIONS.md (ADR-002).

export type RequestKind = 'manifest' | 'init' | 'segment';

export interface FaultMatch {
  /**
   * Which requests a rule applies to. 'media' = init + segment. 'any' = everything including the manifest.
   * Default: 'media' for throttle/latency/stall/abort, and required (no default) for status.
   */
  kind?: RequestKind | 'media' | 'any';
  track?: 'video' | 'audio' | 'any';
  /** Exact representation id, e.g. 'v720'. */
  rep?: string;
  /** Segment number (1-based, the DASH $Number$ / HLS media sequence), or an inclusive range. VOD: 1..segmentCount. Live: the live segment number. */
  number?: number | { from: number; to: number };
}

interface FaultBase {
  /** Assigned by the service when omitted. Returned in request logs ("faults": [...ids]) so a log line explains itself. */
  id?: string;
  match?: FaultMatch;
  /** Apply to the first N matching requests only (then the rule goes quiet). Default: unlimited. */
  times?: number;
  /** Rule becomes active this many ms after the session's first media request. Default 0. */
  afterMs?: number;
  /** Rule stays active this long once active. Default: forever. */
  forMs?: number;
}

export type FaultRule = FaultBase &
  (
    | {
        type: 'throttle';
        /** Cap on response body throughput, kilobits per second. One token bucket per session, shared by concurrent responses, like a real link. */
        kbps: number;
      }
    | {
        type: 'latency';
        /** Delay before the first byte, milliseconds. Jitter (if any) comes from a PRNG seeded with the session id: repeatable. */
        ms: number;
        jitterMs?: number;
      }
    | {
        type: 'status';
        /** HTTP status to answer with instead of the content (404, 500, 503...). Empty body. */
        status: number;
      }
    | {
        type: 'stall';
        /** Send this many body bytes, pause for ms, then finish the response. */
        afterBytes: number;
        ms: number;
      }
    | {
        type: 'abort';
        /** Send this many body bytes (default 0) and then destroy the socket. */
        afterBytes?: number;
      }
    | {
        type: 'live-stall';
        /**
         * Live only. The origin stops publishing at live segment number `atNumber` for `ms` milliseconds: the manifest does not
         * advance and segments beyond `atNumber` are 404 (not yet published). When the stall ends the origin catches up: every
         * segment that should exist by then is published at once, timeline unchanged (no discontinuity).
         */
        atNumber: number;
        ms: number;
      }
    | {
        type: 'manifest-stale';
        /** Live only. For ms milliseconds the manifest endpoint keeps answering with the last version it served before the rule started. */
        ms: number;
      }
  );

export type FaultRuleWithId = FaultRule & { id: string };
