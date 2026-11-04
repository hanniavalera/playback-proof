import type { TestInfo } from '@playwright/test';
import type { ServiceClient } from '../../../src/lab/service-client.ts';
import type { SessionInfo } from '../../../src/shared/api.ts';
import type { PlayerHandle } from './player.ts';

// Failure diagnostics: when a test fails or times out, everything needed to explain it is attached to its result under FIXED names.
// Failure triage (Phase 8) clusters failures from exactly these attachments, so the names and shapes are a contract
// (docs/CONTRACTS.md section 7). The first player and the first session have the plain names; the second ones carry `-2`, and so on.

export const ATTACHMENT_NAMES = {
  /** `QAEvent[]`: the whole timeline of the player page. */
  events: 'qa-events.json',
  /** `QAMetrics`: the metrics snapshot at the moment of the failure. */
  metrics: 'qa-metrics.json',
  /** `QAInfo`: the player configuration (letter, overrides), `loadMode`, the page parameters and the user agent. */
  info: 'qa-info.json',
  /** `ConsoleEntry[]`: the errors and warnings the browser console showed, and uncaught page errors. */
  console: 'page-console.json',
  /** `SessionDetail`: the session, its fault rules (with ids) and the counters. */
  sessionDetail: 'session-detail.json',
  /** `RequestLogEntry[]`: every request the server saw for the session. */
  requestLog: 'request-log.json',
  /** `{ [attachment name]: reason }`: what could not be read (a closed page, a service that did not answer). Present only then. */
  problems: 'diagnostics-problems.json',
} as const;

/** `qa-events.json` for the first player, `qa-events-2.json` for the second. */
export function attachmentName(name: string, index: number): string {
  if (index === 0) return name;
  return name.replace(/\.json$/, `-${index + 1}.json`);
}

/** A read must not outlive the diagnostics: a page whose main thread is stuck is exactly the failure that needs them. */
export const READ_TIMEOUT_MS = 5000;

export interface DiagnosticSources {
  service: Pick<ServiceClient, 'detail' | 'log'>;
  sessions: ReadonlyArray<Pick<SessionInfo, 'id'>>;
  players: ReadonlyArray<Pick<PlayerHandle, 'events' | 'metrics' | 'info' | 'consoleEntries'>>;
}

/** A deadline for a read, not a sleep: the read is abandoned, never waited out. */
function withDeadline<T>(read: () => Promise<T>, ms: number): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  return Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      deadline.addEventListener('abort', () => reject(new Error(`no answer within ${ms} ms`)), {
        once: true,
      });
    }),
  ]);
}

/**
 * Attaches the diagnostics of a failed test: for every player the timeline, metrics, info and console; for every session its detail
 * and its request log. Every read is independent and bounded: one that fails (a closed page, a deleted session) is listed in
 * `diagnostics-problems.json` and does not stop the others. Never throws: diagnostics must not replace the failure they explain.
 */
export async function attachDiagnostics(
  testInfo: Pick<TestInfo, 'attach'>,
  sources: DiagnosticSources,
  options: { readTimeoutMs?: number } = {},
): Promise<void> {
  const ms = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const problems: Record<string, string> = {};
  const attachments: Array<{ name: string; read: () => Promise<unknown> }> = [];

  sources.players.forEach((player, index) => {
    attachments.push(
      { name: attachmentName(ATTACHMENT_NAMES.events, index), read: () => player.events() },
      { name: attachmentName(ATTACHMENT_NAMES.metrics, index), read: () => player.metrics() },
      { name: attachmentName(ATTACHMENT_NAMES.info, index), read: () => player.info() },
      { name: attachmentName(ATTACHMENT_NAMES.console, index), read: async () => player.consoleEntries() },
    );
  });
  sources.sessions.forEach((session, index) => {
    attachments.push(
      {
        name: attachmentName(ATTACHMENT_NAMES.sessionDetail, index),
        read: () => sources.service.detail(session.id),
      },
      {
        name: attachmentName(ATTACHMENT_NAMES.requestLog, index),
        read: () => sources.service.log(session.id, 0),
      },
    );
  });

  const store = async (name: string, value: unknown): Promise<void> => {
    try {
      await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
    } catch {
      // Diagnostics are best effort: a failure to store one must not replace the test failure they explain.
    }
  };

  const results = await Promise.allSettled(attachments.map(({ read }) => withDeadline(read, ms)));
  for (const [index, result] of results.entries()) {
    const name = attachments[index]?.name ?? 'unknown';
    if (result.status === 'rejected') {
      problems[name] = result.reason instanceof Error ? result.reason.message : String(result.reason);
      continue;
    }
    await store(name, result.value);
  }
  if (Object.keys(problems).length > 0) await store(ATTACHMENT_NAMES.problems, problems);
}
