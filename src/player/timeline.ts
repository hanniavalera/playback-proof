import type { QAEvent, QAEventName, QAWaitOptions } from '../shared/qa.ts';

// The event timeline behind `window.__qa`: an append-only list of events with a cursor, and waiters that cannot miss an
// event. Every test, baseline and A/B run observes the player through it, so it has no DOM and no Shaka in it: the page
// feeds it, the unit tests drive it with a fake clock.

const KNOWN_NAMES: Record<QAEventName, true> = {
  'load-requested': true,
  'manifest-loaded': true,
  loaded: true,
  firstframe: true,
  playing: true,
  paused: true,
  seeking: true,
  seeked: true,
  'buffering-start': true,
  'buffering-end': true,
  'variant-changed': true,
  error: true,
  ended: true,
  'live-edge-seek': true,
  unloaded: true,
};

/** Every event name, from the type itself: a name added to `QAEventName` and missing above is a compile error. */
export const EVENT_NAMES = Object.keys(KNOWN_NAMES) as QAEventName[];

export const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
/** How many of the latest events a timeout message lists. */
export const RECENT_EVENTS_IN_MESSAGES = 15;

export function isEventName(name: unknown): name is QAEventName {
  return typeof name === 'string' && Object.hasOwn(KNOWN_NAMES, name);
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The page's real timers. */
export const REAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TimelineOptions {
  /** `performance.now()` */
  now: () => number;
  /** `video.currentTime` */
  mediaTime: () => number;
  /** Safety-net timers of the waiters. Injected so that the unit tests do not wait for real time. */
  timers?: Timers;
  /** Called with whatever a listener threw. Default: rethrow asynchronously, so the page records it as an unhandled error. */
  onListenerError?: (error: unknown) => void;
}

const MAX_STRING = 500;
const MAX_DEPTH = 6;

/**
 * A fresh, frozen, JSON-safe copy of a value: what an event may carry. Non-finite numbers become null (as in JSON),
 * `undefined` members and functions are dropped, errors become `{ name, message }`, long strings are cut, cycles and deep
 * nesting are cut, so a detail can always cross the Playwright boundary and can never be changed after the fact.
 */
export function toJsonSafe(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  const object = value as object;
  if (seen.has(object)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  seen.add(object);
  try {
    if (object instanceof Error)
      return Object.freeze({ name: object.name, message: toJsonSafe(object.message) });
    if (Array.isArray(object)) {
      return Object.freeze(object.map((item) => toJsonSafe(item, depth + 1, seen) ?? null));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const safe = toJsonSafe(item, depth + 1, seen);
      if (safe !== undefined) out[key] = safe;
    }
    return Object.freeze(out);
  } finally {
    seen.delete(object);
  }
}

function formatEvent(event: QAEvent): string {
  let line = `  #${event.index} t=${event.t.toFixed(1)} media=${event.mediaTime.toFixed(3)} ${event.name}`;
  if (event.detail !== undefined) {
    const detail = JSON.stringify(event.detail);
    line += ` ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}`;
  }
  return line;
}

interface Waiter {
  label: string;
  timer: unknown;
  resolve(value: never): void;
  reject(error: Error): void;
}

interface EventWaiter extends Waiter {
  name: QAEventName;
  since: number;
  predicate?: (event: QAEvent) => boolean;
  resolve(value: QAEvent): void;
}

interface MediaTimeWaiter extends Waiter {
  seconds: number;
  resolve(value: number): void;
}

export class Timeline {
  private readonly items: QAEvent[] = [];
  private readonly clock: Pick<TimelineOptions, 'now' | 'mediaTime'>;
  private readonly timers: Timers;
  private readonly onListenerError: (error: unknown) => void;
  private readonly listeners = new Set<(event: QAEvent) => void>();
  private readonly eventWaiters = new Set<EventWaiter>();
  private readonly mediaTimeWaiters = new Set<MediaTimeWaiter>();
  private readonly undelivered: QAEvent[] = [];
  private delivering = false;
  private closedBecause: string | null = null;

  constructor(options: TimelineOptions) {
    this.clock = { now: options.now, mediaTime: options.mediaTime };
    this.timers = options.timers ?? REAL_TIMERS;
    this.onListenerError =
      options.onListenerError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }

  /** The index the next event will get: take one before an action to wait for the events that action causes. */
  cursor(): number {
    return this.items.length;
  }

  /** A copy of the history (the events themselves are frozen). */
  events(): QAEvent[] {
    return this.items.slice();
  }

  record(name: QAEventName, detail?: Record<string, unknown>): QAEvent {
    const event: QAEvent = {
      index: this.items.length,
      t: this.clock.now(),
      name,
      mediaTime: this.clock.mediaTime(),
      ...(detail === undefined ? {} : { detail: toJsonSafe(detail) as Record<string, unknown> }),
    };
    Object.freeze(event);
    this.items.push(event);
    this.undelivered.push(event);
    this.deliver();
    return event;
  }

  /** Calls `listener` for every event recorded from now on, in index order. Returns the function that unsubscribes. */
  subscribe(listener: (event: QAEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitFor(name: QAEventName, options: QAWaitOptions = {}): Promise<QAEvent> {
    const { since = 0, predicate, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = options;
    const label = `qa.waitFor('${String(name)}')`;
    if (!isEventName(name)) {
      return Promise.reject(new Error(`${label}: unknown event name. Known: ${EVENT_NAMES.join(', ')}`));
    }
    if (!Number.isFinite(since) || since < 0) {
      return Promise.reject(new Error(`${label}: since must be a cursor >= 0, got ${String(since)}`));
    }
    const badTimeout = checkTimeout(timeoutMs);
    if (badTimeout) return Promise.reject(new Error(`${label}: ${badTimeout}`));

    // History first, then subscribe: an event that already happened resolves the wait, so there is no window in which it can be missed.
    for (let i = Math.ceil(since); i < this.items.length; i++) {
      const event = this.items[i];
      if (!event || event.name !== name) continue;
      try {
        if (predicate && !predicate(event)) continue;
      } catch (error) {
        return Promise.reject(this.predicateError(label, error));
      }
      return Promise.resolve(event);
    }

    if (this.closedBecause !== null) {
      return Promise.reject(this.failure(label, `cannot wait, the player page was ${this.closedBecause}`));
    }
    return new Promise<QAEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        label,
        name,
        since,
        ...(predicate ? { predicate } : {}),
        timer: undefined,
        resolve,
        reject,
      };
      waiter.timer = this.timers.setTimeout(() => {
        this.eventWaiters.delete(waiter);
        const where = `from index ${since}${predicate ? ', with a predicate' : ''}`;
        reject(this.failure(label, `timed out after ${timeoutMs} ms (looking ${where})`));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  /**
   * Resolves with the media time reached once it is >= `seconds`. Event driven: the page calls `notifyMediaTime` from
   * `timeupdate` and video frame callbacks. The timeout is a failure with the timeline attached, never a pass.
   */
  waitForMediaTime(seconds: number, options: { timeoutMs?: number } = {}): Promise<number> {
    const { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = options;
    const label = `qa.waitForMediaTime(${String(seconds)})`;
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
      return Promise.reject(new Error(`${label}: seconds must be a number`));
    }
    const badTimeout = checkTimeout(timeoutMs);
    if (badTimeout) return Promise.reject(new Error(`${label}: ${badTimeout}`));

    const reached = this.clock.mediaTime();
    if (reached >= seconds) return Promise.resolve(reached);
    if (this.closedBecause !== null) {
      return Promise.reject(this.failure(label, `cannot wait, the player page was ${this.closedBecause}`));
    }
    return new Promise<number>((resolve, reject) => {
      const waiter: MediaTimeWaiter = { label, seconds, timer: undefined, resolve, reject };
      waiter.timer = this.timers.setTimeout(() => {
        this.mediaTimeWaiters.delete(waiter);
        reject(
          this.failure(
            label,
            `timed out after ${timeoutMs} ms: the media clock is at ${this.clock.mediaTime().toFixed(3)} s`,
          ),
        );
      }, timeoutMs);
      this.mediaTimeWaiters.add(waiter);
    });
  }

  /** The page reports the media clock here (`timeupdate`, frame callbacks). Resolves the `waitForMediaTime` calls it satisfies. */
  notifyMediaTime(time: number): void {
    if (!Number.isFinite(time)) return;
    for (const waiter of [...this.mediaTimeWaiters]) {
      if (time < waiter.seconds) continue;
      this.mediaTimeWaiters.delete(waiter);
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(time);
    }
  }

  /**
   * The page is going away (destroy): every pending wait fails now, with the timeline, instead of timing out; waits that
   * the history can already answer still resolve.
   */
  close(reason: string): void {
    if (this.closedBecause !== null) return;
    this.closedBecause = reason;
    for (const waiter of [...this.eventWaiters]) {
      this.eventWaiters.delete(waiter);
      this.abort(waiter, reason);
    }
    for (const waiter of [...this.mediaTimeWaiters]) {
      this.mediaTimeWaiters.delete(waiter);
      this.abort(waiter, reason);
    }
  }

  /** The latest events as text, for an error message: name, t, media time and a short detail. */
  describeRecent(count = RECENT_EVENTS_IN_MESSAGES): string {
    if (this.items.length === 0) return 'No events were recorded.';
    const tail = this.items.slice(-count);
    return `${this.items.length} events so far, the last ${tail.length}:\n${tail.map(formatEvent).join('\n')}`;
  }

  private abort(waiter: Waiter, reason: string): void {
    this.timers.clearTimeout(waiter.timer);
    waiter.reject(this.failure(waiter.label, `aborted, the player page was ${reason}`));
  }

  private failure(label: string, headline: string): Error {
    return new Error(`${label} ${headline}.\n${this.describeRecent()}`);
  }

  private predicateError(label: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${label}: the predicate threw: ${message}`, { cause: error });
  }

  // Events are delivered one at a time, in index order, even when a listener records another event while it runs.
  private deliver(): void {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let event = this.undelivered.shift(); event; event = this.undelivered.shift()) {
        this.deliverOne(event);
      }
    } finally {
      this.delivering = false;
    }
  }

  private deliverOne(event: QAEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
    for (const waiter of [...this.eventWaiters]) {
      if (waiter.name !== event.name || event.index < waiter.since) continue;
      try {
        if (waiter.predicate && !waiter.predicate(event)) continue;
      } catch (error) {
        this.eventWaiters.delete(waiter);
        this.timers.clearTimeout(waiter.timer);
        waiter.reject(this.predicateError(waiter.label, error));
        continue;
      }
      this.eventWaiters.delete(waiter);
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
}

function checkTimeout(timeoutMs: number): string | null {
  // setTimeout(fn, Infinity) fires at once, and 0 would read as "do not wait": both are traps, so they are errors.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return `timeoutMs must be a finite number > 0, got ${String(timeoutMs)}`;
  }
  return null;
}
