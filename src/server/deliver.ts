// How a response body reaches the socket, with the faults the lab injects below the browser (ADR-002): delayed before the first
// byte (latency), limited by token buckets shared with the other responses of the session (throttle), paused inside the body
// (stall) or cut off (abort). Which request gets which behaviour is decided elsewhere; this module only carries it out, and
// measures what it did. Decisions and measurements: docs/decisions/server-delivery.md (ADR-050 to ADR-054).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHUNK_BYTES, createPacer } from './throttle.ts';
import type { Bucket, Pacer } from './throttle.ts';

export interface DeliverPlan {
  /** Wait this long before writing the response head. */
  latencyMs?: number;
  /** Limit the body. Every bucket must grant a chunk before it is sent, so the slowest one decides the rate. */
  buckets?: Bucket[];
  /** Send `afterBytes` of the body, pause `ms`, send the rest. */
  stall?: { afterBytes: number; ms: number };
  /** Send `afterBytes` (default 0) of the body, then destroy the socket. */
  abort?: { afterBytes?: number };
}

export interface DeliverInput {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | string;
  /** A HEAD request: the same headers, Content-Length of the would-be body, no body. Only `latencyMs` of the plan applies. */
  head?: boolean;
  plan?: DeliverPlan;
}

export interface DeliverHooks {
  /** Called once, when the head has been flushed to the socket. */
  onHead?(ttfbMs: number): void;
  /** Called after each piece of the body has been flushed to the socket, with the running total. */
  onBytes?(totalBytesSent: number): void;
}

export interface DeliverOutcome {
  /** Body bytes flushed to the socket (the head is not counted). */
  bytesSent: number;
  aborted: boolean;
  /** 'error' means the response could not be written at all (an invalid status or header value): a bug of the caller, see `error`. */
  reason?: 'client-closed' | 'fault-abort' | 'error';
  /** Set when something other than the client or a fault went wrong, including a hook that threw (which does not stop the response). */
  error?: string;
  /** From arrival (the moment `deliver` was called) to the head flushed to the socket. When no head was ever sent, the same as totalMs. */
  ttfbMs: number;
  /** From arrival to the end of the response or to the abort. */
  totalMs: number;
}

let active = 0;

/** Responses currently being written, from the call of `deliver` until its promise settles. Tests use it to prove nothing leaks. */
export function activeDeliveries(): number {
  return active;
}

/**
 * Writes the response. The promise never rejects: every failure is an outcome. `Content-Length` is always the real size of the
 * body (also when an abort will cut it short: the client then sees a premature close, which is the point) and the response is
 * never chunked. The body must not be modified until the promise has settled.
 */
export async function deliver(
  req: IncomingMessage,
  res: ServerResponse,
  input: DeliverInput,
  hooks: DeliverHooks = {},
): Promise<DeliverOutcome> {
  active++;
  try {
    return await new Delivery(req, res, input, hooks).run();
  } finally {
    active--;
  }
}

class Delivery {
  private readonly arrival = performance.now();
  private bytesSent = 0;
  private ttfbMs: number | undefined;
  private clientGone: boolean;
  private reason: DeliverOutcome['reason'];
  private error: string | undefined;
  private pacer: Pacer | undefined;
  // Everything parked on something other than the clock, so a disconnect can release it at once.
  private readonly parked = new Set<() => void>();

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    private readonly input: DeliverInput,
    private readonly hooks: DeliverHooks,
  ) {
    this.clientGone = res.destroyed;
    // 'close' is also emitted after a normal finish; only a close before the response finished is a disconnect. The 'error'
    // listener stays for the life of the response: an unhandled 'error' event would be an uncaught exception.
    res.on('close', this.onClose);
    res.on('error', this.onClose);
  }

  async run(): Promise<DeliverOutcome> {
    try {
      await this.send();
    } catch (err) {
      this.fail(err);
    } finally {
      this.pacer?.leave();
    }
    if (this.clientGone && this.reason === undefined) {
      this.reason = 'client-closed';
      // Writes that were in flight when the connection went away settle on the next turn; count the ones that made it.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const totalMs = performance.now() - this.arrival;
    const outcome: DeliverOutcome = {
      bytesSent: this.bytesSent,
      aborted: this.reason !== undefined,
      ttfbMs: this.ttfbMs ?? totalMs,
      totalMs,
    };
    if (this.reason !== undefined) outcome.reason = this.reason;
    if (this.error !== undefined) outcome.error = this.error;
    return outcome;
  }

  private async send(): Promise<void> {
    const { res, input } = this;
    const plan = input.plan ?? {};
    const body = typeof input.body === 'string' ? Buffer.from(input.body) : input.body;
    const headOnly = input.head === true || this.req.method === 'HEAD';

    if (this.clientGone) return;
    // Small paced writes must not wait for an acknowledgement (Nagle): node defaults to this already, the lab depends on it.
    res.socket?.setNoDelay(true);

    await this.sleep(plan.latencyMs);
    if (this.clientGone) return;

    const headers: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (lower !== 'content-length' && lower !== 'transfer-encoding') headers[name] = value;
    }
    headers['Content-Length'] = body.length;
    res.removeHeader('Transfer-Encoding');
    res.writeHead(input.status, headers);

    if (headOnly) {
      if (await this.end()) this.noteHead();
      return;
    }
    // The head goes out alone and first: the throttle limits the body, and the client must see the status while the body is paced.
    if (!(await this.flush(''))) return;
    this.noteHead();

    const total = body.length;
    const stallAt = plan.stall ? clamp(plan.stall.afterBytes, total) : undefined;
    const abortAt = plan.abort ? clamp(plan.abort.afterBytes ?? 0, total) : undefined;
    if (plan.buckets && plan.buckets.length > 0) this.pacer = createPacer(plan.buckets);
    let stalled = false;
    let offset = 0;

    for (;;) {
      if (stallAt !== undefined && !stalled && offset >= stallAt) {
        stalled = true;
        // A stall is only a stall if the bytes before it have really left: wait for the socket to take them, then pause.
        if (!(await this.flush(''))) return;
        await this.sleep(plan.stall?.ms);
        if (this.clientGone) return;
      }
      if (abortAt !== undefined && offset >= abortAt) {
        if (!(await this.flush(''))) return;
        this.reason = 'fault-abort';
        res.socket?.destroy();
        return;
      }
      if (offset >= total) break;

      let boundary = total;
      if (stallAt !== undefined && !stalled) boundary = Math.min(boundary, stallAt);
      if (abortAt !== undefined) boundary = Math.min(boundary, abortAt);
      const wanted = Math.min(CHUNK_BYTES, boundary - offset);
      const granted = this.pacer ? await this.pacer.take(wanted) : wanted;
      if (granted === 0 || this.clientGone) return;

      const piece = body.subarray(offset, offset + granted);
      offset += granted;
      // Back-pressure: when the socket's buffer is full the write returns false, and nothing more is written until it drains.
      // A throttled response never gets there unless the client reads slower than the throttle, an unthrottled one does on
      // anything larger than the buffer, which is what keeps a 20 MB body from being queued in memory.
      if (!res.write(piece, this.counted(piece.length))) {
        await this.park((resume) => {
          res.once('drain', resume);
          return () => res.off('drain', resume);
        });
        if (this.clientGone) return;
      }
    }
    await this.end();
  }

  private readonly onClose = (): void => {
    if (!this.res.writableFinished) this.clientGone = true;
    if (this.clientGone) {
      // A consumer that left must not wait in a bucket for a grant it will never use.
      this.pacer?.leave();
      for (const resume of [...this.parked]) resume();
    }
  };

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.reason = 'error';
    this.res.socket?.destroy();
  }

  /** Runs an observer. A hook that throws would otherwise be an uncaught exception inside a stream callback. */
  private notify(hook: () => void): void {
    try {
      hook();
    } catch (err) {
      this.error ??= `hook threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private noteHead(): void {
    this.ttfbMs = performance.now() - this.arrival;
    this.notify(() => this.hooks.onHead?.(this.ttfbMs ?? 0));
  }

  /** The write callback of a body piece: it is counted once the socket has taken it, not when it was queued. */
  private counted(bytes: number): (err?: Error | null) => void {
    return (err) => {
      if (err) return;
      this.bytesSent += bytes;
      this.notify(() => this.hooks.onBytes?.(this.bytesSent));
    };
  }

  /** Writes a piece (or nothing) and waits until the socket has taken it and everything written before. False if the client went away. */
  private async flush(piece: string): Promise<boolean> {
    let failed = false;
    await this.park((resume) => {
      this.res.write(piece, (err) => {
        failed = err != null;
        resume();
      });
    });
    return !failed && !this.clientGone;
  }

  private async end(): Promise<boolean> {
    await this.park((resume) => {
      this.res.end(resume);
    });
    return !this.clientGone;
  }

  /** Waits for `register` to call `resume`; returns early when the client goes away. `register` may return a cleanup. */
  private park(register: (resume: () => void) => (() => void) | void): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.clientGone) return resolve();
      // `register` may call `resume` before it returns its cleanup, so the cleanup is run by whoever comes second.
      const state: { done: boolean; cleanup: (() => void) | void } = { done: false, cleanup: undefined };
      const resume = (): void => {
        if (state.done) return;
        state.done = true;
        this.parked.delete(resume);
        state.cleanup?.();
        resolve();
      };
      this.parked.add(resume);
      state.cleanup = register(resume);
      if (state.done) state.cleanup?.();
    });
  }

  /**
   * A cancellable delay that is never short: node may fire a timer a fraction of a millisecond early, and the delay a test asked
   * for must be a lower bound, so the clock is checked and the timer re-armed for the rest.
   */
  private sleep(ms: number | undefined): Promise<void> {
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    const deadline = performance.now() + ms;
    return this.park((resume) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = (): void => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) resume();
        else timer = setTimeout(check, Math.ceil(remaining));
      };
      check();
      return () => clearTimeout(timer);
    });
  }
}

function clamp(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
}
