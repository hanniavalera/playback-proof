import type { RequestLogEntry } from '../shared/api.ts';
import { LOG_CAPACITY } from './constants.ts';

// The per-session request log: the second observation channel of the lab (docs/CONTRACTS.md section 4). An entry is listed from the
// request's ARRIVAL and completed in place, so `seq` order is arrival order and a cursor cannot skip a request that completes late.

export type LogStart = Pick<RequestLogEntry, 'method' | 'path' | 'kind' | 'rep' | 'number'> & {
  /** Epoch ms of the arrival. */
  arrivedAtMs: number;
  /** Epoch ms of the session's creation (msSinceStart is computed from it). */
  sessionStartMs: number;
};

export class RequestLog {
  private readonly capacity: number;
  private entries: RequestLogEntry[] = [];
  private lastSeq = 0;

  constructor(capacity: number = LOG_CAPACITY) {
    this.capacity = capacity;
  }

  /** The sequence number the next `begin` will assign. Jitter is seeded with it, so it must be known before the plan is made. */
  peekNextSeq(): number {
    return this.lastSeq + 1;
  }

  /** Lists a request that has just arrived. The returned entry is live: the delivery code completes it in place. */
  begin(start: LogStart): RequestLogEntry {
    const entry: RequestLogEntry = {
      seq: ++this.lastSeq,
      t: new Date(start.arrivedAtMs).toISOString(),
      msSinceStart: Math.max(0, start.arrivedAtMs - start.sessionStartMs),
      method: start.method,
      path: start.path,
      kind: start.kind,
      ...(start.rep === undefined ? {} : { rep: start.rep }),
      ...(start.number === undefined ? {} : { number: start.number }),
      status: 0,
      bytes: 0,
      ttfbMs: 0,
      totalMs: 0,
      faults: [],
      pending: true,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return entry;
  }

  /** Copies of the entries with seq > `since`, in seq order. A copy: a reader never sees an entry change under it. */
  since(since = 0): RequestLogEntry[] {
    const out: RequestLogEntry[] = [];
    for (const entry of this.entries) {
      if (entry.seq > since) out.push({ ...entry, faults: [...entry.faults] });
    }
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Highest seq assigned so far (0 when nothing has arrived). A test takes it as a cursor before an action. */
  get lastSequence(): number {
    return this.lastSeq;
  }
}
