// The numbers of Shaka Player 5.3.3's defaults (configuration A) that the recovery specs reason about, with the file they were read
// in. A spec derives its time bounds from them as arithmetic instead of writing a bare number. They are the lab's reading of the
// pinned version: when the player is upgraded the specs are the first thing to re-read (the unit tests of the lab do not cover them).

/** `shaka.net.Backoff.defaultRetryParameters()` (lib/net/backoff.js), the value of `streaming.retryParameters` and of `manifest.retryParameters`. */
export const RETRY = {
  /** Attempts per request, the first one included: one request, one retry. */
  maxAttempts: 2,
  baseDelayMs: 1000,
  backoffFactor: 2,
  /** The delay is drawn uniformly from +-50 % of its nominal value. */
  fuzzFactor: 0.5,
  /** A request with no first byte after this long is aborted and counted as a failed attempt (it is the only timeout a stalled origin hits). */
  connectionTimeoutMs: 10_000,
  /** A response whose bytes stop for this long is aborted. */
  stallTimeoutMs: 5000,
} as const;

/** The longest wait before the next attempt of one request: the base delay with the fuzz at its top (the first retry; later ones double). */
export const LONGEST_FIRST_RETRY_WAIT_MS = RETRY.baseDelayMs * (1 + RETRY.fuzzFactor);

/** `streaming.maxDisabledTime` (lib/util/player_configuration.js): how long a rung is out of the player's choices after it failed. */
export const DISABLED_RUNG_SECONDS = 30;
