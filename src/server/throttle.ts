// A shared token bucket for response bodies (the `throttle` fault). One bucket models one link: its tokens are body bytes and every
// response the link carries draws from the same pool, so audio and video fetched at the same time compete for the configured rate
// the way they would on a real connection. Decisions and measurements: docs/decisions/server-delivery.md (ADR-050 to ADR-054).

/** The largest piece of body granted at once, and the most credit a bucket banks while nobody is asking (the burst allowance). */
export const CHUNK_BYTES = 16 * 1024;

/** Target time between grants: fine enough that 1.5 Mbps looks like a steady stream, coarse enough to stay clear of the 1 ms timer floor. */
const SLICE_MS = 15;

/** Below one full-size Ethernet segment a "slice" is only a packet fragment, so a grant is never smaller (unless less is left to send). */
const MIN_GRANT_BYTES = 1460;

export interface Bucket {
  readonly kbps: number;
}

export interface BucketOptions {
  /** Monotonic clock in milliseconds. Tests inject their own; the default is `performance.now()`. */
  now?: () => number;
}

/** What one response uses to draw bytes from the buckets that limit it. */
export interface Pacer {
  /**
   * Resolves with how many bytes (1 to min(wanted, CHUNK_BYTES)) may be written now, once every bucket has granted them.
   * Resolves with 0 after `leave()`. One call at a time: wait for it before asking again.
   */
  take(wanted: number): Promise<number>;
  /** Stops waiting and leaves every bucket. Idempotent; the pending `take` resolves with 0. */
  leave(): void;
}

export interface BucketState {
  kbps: number;
  /** Bytes available right now (may exceed CHUNK_BYTES only while a late timer's catch-up is being paid out). */
  tokens: number;
  /** Consumers queued for a grant. */
  waiting: number;
  /** Pacers that have joined and not left yet. */
  consumers: number;
  /** True only while somebody is waiting: an idle bucket has no timer. */
  timerArmed: boolean;
}

interface Waiter {
  wanted: number;
  resolve(granted: number): void;
}

class TokenBucket implements Bucket {
  readonly kbps: number;
  readonly bytesPerMs: number;
  readonly minGrant: number;
  readonly now: () => number;
  // A link that has been idle is full: the first chunk of a response goes out at once.
  tokens = CHUNK_BYTES;
  last: number;
  consumers = 0;
  // First come, first served, and a consumer that was just served re-queues behind the others: round robin, chunk by chunk.
  queue: Waiter[] = [];
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(kbps: number, now: () => number) {
    this.kbps = kbps;
    this.bytesPerMs = (kbps * 1000) / 8 / 1000;
    this.minGrant = Math.min(CHUNK_BYTES, Math.max(MIN_GRANT_BYTES, Math.round(this.bytesPerMs * SLICE_MS)));
    this.now = now;
    this.last = now();
  }
}

export function createBucket(kbps: number, options: BucketOptions = {}): Bucket {
  if (!Number.isFinite(kbps) || kbps <= 0)
    throw new RangeError(`kbps must be a positive number, got ${kbps}`);
  return new TokenBucket(kbps, options.now ?? (() => performance.now()));
}

function internal(bucket: Bucket): TokenBucket {
  if (!(bucket instanceof TokenBucket)) throw new TypeError('not a bucket created by createBucket()');
  return bucket;
}

/**
 * Adds the time since the last call. While somebody is waiting the time is owed to them and is never discarded: a timer that
 * fires 40 ms late must not lower the long-run rate. While nobody is asking, at most one chunk is banked and credit that is
 * already owed is left alone.
 */
function refill(b: TokenBucket): void {
  const t = b.now();
  if (t <= b.last) return;
  const gained = (t - b.last) * b.bytesPerMs;
  b.last = t;
  b.tokens =
    b.queue.length > 0 ? b.tokens + gained : Math.max(b.tokens, Math.min(CHUNK_BYTES, b.tokens + gained));
}

/** How many bytes a consumer wanting `wanted` could take right now: 0 until a slice (or all it wants, if less) is available. */
function grantable(b: TokenBucket, wanted: number): number {
  if (b.tokens < Math.min(wanted, b.minGrant)) return 0;
  return Math.min(wanted, CHUNK_BYTES, Math.floor(b.tokens));
}

function msUntilGrant(b: TokenBucket, wanted: number): number {
  return Math.max(0, (Math.min(wanted, b.minGrant) - b.tokens) / b.bytesPerMs);
}

function clearTimer(b: TokenBucket): void {
  if (b.timer !== undefined) clearTimeout(b.timer);
  b.timer = undefined;
}

/** Serves the queue in order as far as the tokens go, then sleeps until the head of the queue can be served (never while it is empty). */
function serve(b: TokenBucket): void {
  clearTimer(b);
  refill(b);
  for (let head = b.queue[0]; head !== undefined; head = b.queue[0]) {
    const grant = grantable(b, head.wanted);
    if (grant === 0) break;
    b.tokens -= grant;
    b.queue.shift();
    head.resolve(grant);
  }
  const head = b.queue[0];
  if (head === undefined) return;
  // Node can fire a timer a fraction of a millisecond early; the arithmetic uses the real clock, so an early wake simply sleeps again.
  const delay = Math.max(1, Math.ceil(msUntilGrant(b, head.wanted)));
  b.timer = setTimeout(() => {
    b.timer = undefined;
    serve(b);
  }, delay);
}

function enqueue(b: TokenBucket, waiter: Waiter): void {
  refill(b);
  b.queue.push(waiter);
  // Behind somebody: the timer already armed is for the head. At the head: try at once, then arm.
  if (b.queue.length === 1) serve(b);
}

function cancel(b: TokenBucket, waiter: Waiter): void {
  const index = b.queue.indexOf(waiter);
  if (index === -1) return;
  refill(b);
  b.queue.splice(index, 1);
  waiter.resolve(0);
  if (b.queue.length === 0) clearTimer(b);
  else if (index === 0) serve(b);
}

/** Returns bytes that were taken but not used. Like idle time, a refund never lifts a bucket above one chunk. */
function credit(b: TokenBucket, bytes: number): void {
  if (bytes <= 0) return;
  refill(b);
  b.tokens = Math.max(b.tokens, Math.min(CHUNK_BYTES, b.tokens + bytes));
  if (b.queue.length > 0) serve(b);
}

/**
 * Takes now what the bucket can give and never waits (and never jumps ahead of consumers already queued). It is the arithmetic of
 * the bucket without timers, so the tests can drive it with an injected clock.
 */
export function tryTake(bucket: Bucket, wanted: number): number {
  const b = internal(bucket);
  refill(b);
  if (b.queue.length > 0) return 0;
  const grant = grantable(b, wanted);
  b.tokens -= grant;
  return grant;
}

/** Milliseconds until a consumer wanting `wanted` bytes could be served, as of now, ignoring the queue. */
export function msUntilTake(bucket: Bucket, wanted: number): number {
  const b = internal(bucket);
  refill(b);
  return msUntilGrant(b, wanted);
}

export function bucketState(bucket: Bucket): BucketState {
  const b = internal(bucket);
  refill(b);
  return {
    kbps: b.kbps,
    tokens: b.tokens,
    waiting: b.queue.length,
    consumers: b.consumers,
    timerArmed: b.timer !== undefined,
  };
}

/**
 * Joins the buckets that limit one response. A chunk is written only when every bucket has granted it, so the slowest bucket
 * decides the rate. The buckets are asked slowest first: the slow one is the one the response really waits for, and asking the
 * fast one last means it is only held for the instant between two grants. Whatever a later bucket grants less than an earlier
 * one did is handed back, so a contended bucket does not charge a response for bytes it could not send.
 */
export function createPacer(buckets: readonly Bucket[]): Pacer {
  const list = [...new Set(buckets)].map(internal).sort((a, c) => a.kbps - c.kbps);
  for (const b of list) b.consumers++;
  let left = false;
  let pending: { bucket: TokenBucket; waiter: Waiter } | undefined;

  function acquire(bucket: TokenBucket, wanted: number): Promise<number> {
    return new Promise<number>((resolve) => {
      const waiter: Waiter = {
        wanted,
        resolve: (granted) => {
          if (pending?.waiter === waiter) pending = undefined;
          resolve(granted);
        },
      };
      pending = { bucket, waiter };
      enqueue(bucket, waiter);
    });
  }

  return {
    async take(wanted: number): Promise<number> {
      if (Number.isNaN(wanted)) throw new RangeError('wanted must be a number');
      if (left) return 0;
      let granted = Math.max(1, Math.min(CHUNK_BYTES, Math.floor(wanted)));
      const held: { bucket: TokenBucket; bytes: number }[] = [];
      for (const bucket of list) {
        const got = await acquire(bucket, granted);
        if (got === 0 || left) {
          for (const h of held) credit(h.bucket, h.bytes);
          if (got > 0) credit(bucket, got);
          return 0;
        }
        if (got < granted) {
          for (const h of held) {
            credit(h.bucket, h.bytes - got);
            h.bytes = got;
          }
          granted = got;
        }
        held.push({ bucket, bytes: got });
      }
      return granted;
    },
    leave(): void {
      if (left) return;
      left = true;
      if (pending) cancel(pending.bucket, pending.waiter);
      for (const b of list) {
        b.consumers--;
        // Credit still owed to a consumer that is gone must not become a bonus burst for the next one.
        if (b.consumers === 0) b.tokens = Math.min(b.tokens, CHUNK_BYTES);
      }
    },
  };
}
