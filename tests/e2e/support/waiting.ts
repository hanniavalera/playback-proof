import type { RequestLogEntry } from '../../../src/shared/api.ts';
import { DEFAULT_WAIT_MS } from './player.ts';
import type { TestSession } from './session.ts';
import { atCaller } from './stack.ts';

// The waits that are not player events, and what a spec asserts on once it has the server's request log. The server is the second
// observation channel (docs/CONTRACTS.md section 4): the player says what it did, the log says what was asked of the origin.
// Waiting on the log is the one place that polls, and it does so inside `ServiceClient.waitForLog` (lab code, 25 ms by default);
// a spec never sleeps and never polls.

export interface RequestWaitOptions {
  /** Consider only entries with `seq > since`. Default 0. Take `await requestLogCursor(session)` before an action to wait for NEW requests. */
  since?: number;
  /** Default `DEFAULT_WAIT_MS`. */
  timeoutMs?: number;
}

const ABORTED_BY: Record<NonNullable<RequestLogEntry['abortReason']> | 'unknown', string> = {
  'client-closed': 'aborted by the client',
  'fault-abort': 'aborted by a fault',
  error: 'aborted by a service error',
  unknown: 'aborted',
};

/** `#12 GET segment v360 #7 -> 200 in 4 ms`: one entry as a line of a failure message. An aborted one says who ended it. */
export function describeEntry(entry: RequestLogEntry): string {
  const what = [entry.kind, entry.rep, entry.number === undefined ? undefined : `#${entry.number}`]
    .filter((part) => part !== undefined)
    .join(' ');
  const answer = entry.status === 0 ? 'no response' : String(entry.status);
  const abort = entry.aborted ? `, ${ABORTED_BY[entry.abortReason ?? 'unknown']}` : '';
  const outcome = entry.pending ? 'pending' : `${answer}${abort} in ${entry.totalMs} ms`;
  const faults = entry.faults.length > 0 ? ` [faults ${entry.faults.join(', ')}]` : '';
  return `#${entry.seq} ${entry.method} ${what} -> ${outcome}${faults}`;
}

function describeLog(entries: readonly RequestLogEntry[], last = 12): string {
  if (entries.length === 0) return 'The log has no entries after the cursor.';
  const shown = entries.slice(-last).map((entry) => `  ${describeEntry(entry)}`);
  return `The log after the cursor has ${entries.length} entries, the last ${shown.length}:\n${shown.join('\n')}`;
}

/** The highest `seq` of the session's log so far (0 when empty): the `since` that selects only requests made from now on. */
export async function requestLogCursor(session: TestSession): Promise<number> {
  const entries = await session.service.log(session.id, 0);
  return entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0);
}

/**
 * Resolves with the first request of the session's log (after `since`) that satisfies `predicate`: a request that has STARTED is
 * enough, so "segment 7 was asked for" does not wait for its answer (add `!entry.pending` to wait for that). Rejects on timeout with
 * the predicate and the last entries in the message.
 */
export async function waitForRequest(
  session: TestSession,
  predicate: (entry: RequestLogEntry) => boolean,
  options: RequestWaitOptions = {},
): Promise<RequestLogEntry> {
  const [first] = await waitForRequests(session, predicate, { ...options, count: 1 });
  return first as RequestLogEntry;
}

/** Like `waitForRequest`, for `count` matching requests ("at least five manifest refreshes"). Resolves with all matching entries so far. */
export async function waitForRequests(
  session: TestSession,
  predicate: (entry: RequestLogEntry) => boolean,
  options: RequestWaitOptions & { count: number },
): Promise<RequestLogEntry[]> {
  const { count, since = 0, timeoutMs = DEFAULT_WAIT_MS } = options;
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError(`waitForRequests: count must be an integer >= 1, got ${count}`);
  let latest: RequestLogEntry[] = [];
  try {
    const entries = await session.service.waitForLog(
      session.id,
      (log) => {
        latest = log;
        return log.filter(predicate).length >= count;
      },
      { since, timeoutMs },
    );
    return entries.filter(predicate);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('did not reach the expected state')) throw error;
    const wanted = count === 1 ? 'a request' : `${count} requests`;
    throw atCaller(
      new Error(
        `waited ${timeoutMs} ms for ${wanted} of session ${session.id} matching ${String(predicate).slice(0, 200)}.\n${describeLog(latest)}`,
      ),
    );
  }
}

export interface RequestFilter {
  kind?: RequestLogEntry['kind'] | readonly RequestLogEntry['kind'][];
  rep?: string | readonly string[];
  /** One segment number, or an inclusive range. */
  number?: number | { from: number; to: number };
  /**
   * What the origin answered, for a request that has finished (a request still in flight has none of these):
   * - a number: that status (an aborted response keeps the status of the head it sent);
   * - `'ok'`: a 2xx that reached the client whole, so a response that was cut (by anybody) is not ok;
   * - `'error'`: what the ORIGIN got wrong: a 4xx or 5xx, or a response it cut short (an `abort` fault, or a write failure of the service).
   *   A client that hung up on an in-flight request is NOT an error: a player cancels requests when it seeks or switches rung, on a slow
   *   machine more often. A log without `abortReason` (an older service) counts every abort as an error. Ask for those with `clientAborted`.
   */
  status?: number | 'ok' | 'error';
  /**
   * `true`: only the requests the CLIENT ended by hanging up before it had received every byte (`abortReason: 'client-closed'`): the
   * oracle for "the player cancelled the in-flight request when it seeked or switched rung". `false`: every other request.
   */
  clientAborted?: boolean;
  method?: string;
  pending?: boolean;
}

const asList = <T>(value: T | readonly T[]): readonly T[] => (Array.isArray(value) ? value : [value as T]);

const hungUpOn = (entry: RequestLogEntry): boolean =>
  entry.aborted === true && entry.abortReason === 'client-closed';

function matches(entry: RequestLogEntry, filter: RequestFilter): boolean {
  if (filter.kind !== undefined && !asList(filter.kind).includes(entry.kind)) return false;
  if (filter.rep !== undefined && (entry.rep === undefined || !asList(filter.rep).includes(entry.rep)))
    return false;
  if (filter.number !== undefined) {
    if (entry.number === undefined) return false;
    const { from, to } =
      typeof filter.number === 'number' ? { from: filter.number, to: filter.number } : filter.number;
    if (entry.number < from || entry.number > to) return false;
  }
  if (filter.status !== undefined) {
    const done = !entry.pending;
    if (
      filter.status === 'ok' &&
      !(done && entry.status >= 200 && entry.status < 300 && entry.aborted !== true)
    )
      return false;
    if (
      filter.status === 'error' &&
      !(done && (entry.status >= 400 || (entry.aborted === true && !hungUpOn(entry))))
    )
      return false;
    if (typeof filter.status === 'number' && !(done && entry.status === filter.status)) return false;
  }
  if (filter.clientAborted !== undefined && hungUpOn(entry) !== filter.clientAborted) return false;
  if (filter.method !== undefined && entry.method !== filter.method) return false;
  if (filter.pending !== undefined && (entry.pending === true) !== filter.pending) return false;
  return true;
}

/** The entries of `log` that satisfy every field of `filter`, in arrival order. */
export function requestsFor(log: readonly RequestLogEntry[], filter: RequestFilter): RequestLogEntry[] {
  return log.filter((entry) => matches(entry, filter));
}

/**
 * The segment numbers requested for one representation, in the order they arrived and with repeats (a refetch shows twice: a seek
 * test asserts there is none, and a request the client cancelled and then repeated shows twice as well). Pass `{ status: 'ok' }` for the
 * ones that were delivered whole, `{ clientAborted: true }` for the ones the player hung up on. Manifests and init segments are not segments.
 */
export function segmentNumbersFetched(
  log: readonly RequestLogEntry[],
  rep: string,
  filter: Pick<RequestFilter, 'status' | 'pending' | 'clientAborted'> = {},
): number[] {
  return requestsFor(log, { ...filter, kind: 'segment', rep })
    .map((entry) => entry.number)
    .filter((number): number is number => number !== undefined);
}

const isVideoRep = (rep: string): boolean => /^v\d+$/.test(rep);

/** The representations that had at least one segment requested, in the order of their first request (`['v240', 'v360']`). Default: video only. */
export function rungsFetched(
  log: readonly RequestLogEntry[],
  options: { track?: 'video' | 'audio' | 'any' } = {},
): string[] {
  const { track = 'video' } = options;
  const reps: string[] = [];
  for (const entry of requestsFor(log, { kind: 'segment' })) {
    const rep = entry.rep;
    if (rep === undefined || reps.includes(rep)) continue;
    if (track === 'video' && !isVideoRep(rep)) continue;
    if (track === 'audio' && isVideoRep(rep)) continue;
    reps.push(rep);
  }
  return reps;
}
