// The numbers of the contract (docs/CONTRACTS.md sections 3 to 5). They live in one place so that a change is one edit and one
// diff in the contract. Deliberately NOT imported from src/shared/criteria.ts: that file is test policy, this is the simulation.

export const LIVE_DEFAULTS = {
  /** The stream has been "on air" this long when a session is created: a DVR window exists immediately. */
  startOffsetSec: 30,
  /** DVR depth in segments (DASH timeShiftBufferDepth, HLS playlist length). */
  windowSegments: 15,
  presentationDelaySec: 6,
  /** DASH minimumUpdatePeriod. */
  minimumUpdatePeriodSec: 2,
} as const;

/** A live segment older than the window by more than this many segments is gone (404); inside the margin it is still served, like a CDN that keeps a little more than it advertises. */
export const GONE_MARGIN_SEGMENTS = 2;

export const SESSION_DEFAULT_TTL_SEC = 900;
export const SESSION_MAX_TTL_SEC = 24 * 60 * 60;
/** More concurrent sessions than this are refused with 503: a runaway test must not exhaust the service's memory. */
export const SESSION_LIMIT = 500;
/** Entries kept in a session's request log. */
export const LOG_CAPACITY = 5000;
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_LABEL_LENGTH = 200;
export const MAX_FAULT_RULES_PER_SESSION = 100;
