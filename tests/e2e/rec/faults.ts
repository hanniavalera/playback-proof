import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import type { QAError } from '../../../src/shared/qa.ts';
import type { TestSession } from '../support/fixtures.ts';
import { DEFAULT_WAIT_MS } from '../support/player.ts';
import { atCaller } from '../support/stack.ts';
import { describeEntry, requestsFor, waitForRequests } from '../support/waiting.ts';
import type { RequestWaitOptions } from '../support/waiting.ts';

// What every recovery spec needs and the library does not give: the id of the rule a session was created with, the proof that the
// fault really fired, and the attempts the player made at one segment. A recovery test that does not first prove the fault fired
// proves nothing: a player that never asks for what the rule matches "recovers" from it too.

const VIDEO_REP = /^v\d+$/;
const REC_FRAME = /[\\/]tests[\\/]e2e[\\/]rec[\\/]/;

/** The requests a fault fired on, at least one (a wait that succeeded guarantees it): the type that spares the specs a cast. */
export type Fired = [RequestLogEntry, ...RequestLogEntry[]];

/** The id the service gave the rule a session was created with (`f1`). A session made with a profile of one rule has exactly one. */
export async function ruleIdOf(session: TestSession): Promise<string> {
  const detail = await session.service.detail(session.id);
  const [rule] = detail.faults;
  if (!rule) throw new Error(`the session ${session.id} has no fault rule: it was created without faults`);
  return rule.id;
}

/** Installs rules on a running session and returns the id of the first one, the one the request log will name. */
export async function installRule(session: TestSession, rules: FaultRule[]): Promise<string> {
  const [stored] = await session.service.addFaults(session.id, rules);
  if (!stored) throw new Error(`the service stored none of the ${rules.length} rules it was sent`);
  return stored.id;
}

/** Whether the origin applied the rule to this request (the request log names the rules that fired on it). */
export function firedBy(entry: RequestLogEntry, ruleId: string): boolean {
  return entry.faults.includes(ruleId);
}

/**
 * The proof that a fault happened, taken before anything is asserted about how the player coped: waits on the server's log until
 * `count` requests that the rule fired on have been answered, and returns every such request so far, in arrival order.
 */
export async function waitForFault(
  session: TestSession,
  ruleId: string,
  count = 1,
  options: RequestWaitOptions = {},
): Promise<Fired> {
  try {
    const fired = await waitForRequests(session, (entry) => firedBy(entry, ruleId) && !entry.pending, {
      ...options,
      count,
    });
    return fired as Fired;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('waited ')) throw error;
    const detail = await session.service.detail(session.id).catch(() => null);
    const rule = detail?.faults.find((candidate) => candidate.id === ruleId);
    const what = rule ? `${ruleId} ${JSON.stringify(rule)}` : ruleId;
    const named = (await session.service.log(session.id).catch(() => [])).filter((entry) =>
      firedBy(entry, ruleId),
    ).length;
    const cause =
      named === 0
        ? 'the player never asked for what the rule matches'
        : 'the player stopped asking for what the rule matches before the rule was used up';
    // The log part of the library's message is kept: it is what shows what the player did ask for instead.
    const log = error.message.split('\n').slice(1).join('\n');
    throw atSpec(
      new Error(
        `the fault rule ${what} named ${named} of the ${count} request${count === 1 ? '' : 's'} it was waited for within ${options.timeoutMs ?? DEFAULT_WAIT_MS} ms: ${cause}, so nothing after this line says how the player copes with the fault.\n${log}`,
      ),
    );
  }
}

/** `error` with the frames of the support library and of these helpers removed, so that the report's code frame is the spec's own line. */
export function atSpec<E extends Error>(error: E): E {
  atCaller(error);
  if (typeof error.stack === 'string') {
    error.stack = error.stack
      .split('\n')
      .filter((line) => !(/^\s+at /.test(line) && REC_FRAME.test(line)))
      .join('\n');
  }
  return error;
}

/** The last of the requests a fault fired on. */
export function lastOf(fired: Fired): RequestLogEntry {
  return fired[fired.length - 1] as RequestLogEntry;
}

/** The segment number a request was for. A request the fault engine matched by number always has one. */
export function segmentOf(entry: RequestLogEntry): number {
  if (entry.number === undefined)
    throw atSpec(new Error(`the request has no segment number: ${describeEntry(entry)}`));
  return entry.number;
}

/** Every request for video segment `number`, whichever rung it was for, in arrival order: each attempt the player made at it. */
export function videoAttemptsAt(log: readonly RequestLogEntry[], number: number): RequestLogEntry[] {
  return requestsFor(log, { kind: 'segment', number }).filter(
    (entry) => entry.rep !== undefined && VIDEO_REP.test(entry.rep),
  );
}

/** `#8 v720 #3 -> 404 [faults f1] at +129 ms; #9 v720 #3 -> 200 at +666 ms`: attempts as a line of a failure message. */
export function describeAttempts(entries: readonly RequestLogEntry[]): string {
  if (entries.length === 0) return 'no request';
  return entries
    .map((entry) => `${describeEntry(entry)} at +${Math.round(entry.msSinceStart)} ms`)
    .join('; ');
}

/** `v360 503, v360 503, v720 503, v720 200`: the same attempts as the short line of an annotation. */
export function summariseAttempts(entries: readonly RequestLogEntry[]): string {
  return entries.map((entry) => `${entry.rep ?? '?'} ${entry.aborted ? 'aborted' : entry.status}`).join(', ');
}

/** The first attempt that arrived after `after` and delivered the segment (2xx), or undefined when none did. */
export function deliveryAfter(
  attempts: readonly RequestLogEntry[],
  after: RequestLogEntry,
): RequestLogEntry | undefined {
  return attempts.find((attempt) => attempt.seq > after.seq && attempt.status >= 200 && attempt.status < 300);
}

/** Milliseconds between the end of `first`'s response and the arrival of `second`: what the player spent waiting between the two. */
export function waitedMs(first: RequestLogEntry, second: RequestLogEntry): number {
  return second.msSinceStart - (first.msSinceStart + first.totalMs);
}

/** The rung a Shaka network error was about: the first datum of its digest is the URL of the request (`.../seg/v720/3.m4s`). */
export function rungOfError(error: QAError): string | undefined {
  const [uri] = error.data ?? [];
  return typeof uri === 'string' ? /\/seg\/([^/]+)\//.exec(uri)?.[1] : undefined;
}
