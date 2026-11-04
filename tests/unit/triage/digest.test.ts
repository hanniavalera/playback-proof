import { describe, expect, it } from 'vitest';
import {
  digestConsole,
  digestDiagnostics,
  digestEvents,
  digestMetrics,
  digestRequestLog,
  describeRule,
  emptyDiagnostics,
  EVENTS_AROUND,
  formatEvent,
  MAX_LISTED_REQUESTS,
  mergeErrors,
} from '../../../triage/digest.ts';
import type { AttachmentSet } from '../../../triage/digest.ts';
import { requestsFor } from '../../e2e/support/waiting.ts';
import { event, metrics, requestEntry, sessionDetail, shakaError } from './support.ts';

const set = (overrides: Partial<AttachmentSet> = {}): AttachmentSet => ({
  events: [],
  metrics: [],
  info: [],
  console: [],
  sessionDetail: [],
  requestLog: [],
  problems: null,
  attached: [],
  ...overrides,
});

describe('PB-LAB-005 triage digests: the timeline', () => {
  const timeline = (count: number, criticalAt?: number) =>
    Array.from({ length: count }, (_, index) =>
      index === criticalAt
        ? event(index, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, 'HTTP error status 503'))
        : event(index, 'playing'),
    );

  it('shows a few events around the first critical error, not the end of the timeline', () => {
    const { digest, errors } = digestEvents(timeline(100, 40));
    expect(digest.total).toBe(100);
    expect(digest.around).toHaveLength(EVENTS_AROUND);
    expect(digest.around[3]).toContain('#40 ');
    expect(digest.around[3]).toContain('error {"code":1001');
    expect(digest.around[0]).toContain('#37 ');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.codeName).toBe('BAD_HTTP_STATUS');
  });

  it('shows the end of the timeline when the player never reported a critical error', () => {
    const { digest } = digestEvents(timeline(30));
    expect(digest.around[EVENTS_AROUND - 1]).toContain('#29 ');
    expect(digest.around[0]).toContain('#22 ');
    expect(digestEvents(timeline(3)).digest.around).toHaveLength(3);
  });

  it('counts the same error once, with how many times it happened, and keeps the order of appearance', () => {
    const recoverable = shakaError(1001, 'BAD_HTTP_STATUS', 1, 1, 'HTTP error status 404');
    const reading = digestEvents([
      event(0, 'load-requested'),
      event(1, 'error', recoverable),
      event(2, 'error', shakaError(3016, 'VIDEO_ERROR', 3, 2)),
      event(3, 'error', recoverable),
    ]);
    expect(reading.errors.map(({ error, count }) => [error.code, count])).toStrictEqual([
      [1001, 2],
      [3016, 1],
    ]);
    expect(reading.digest.names).toStrictEqual({ 'load-requested': 1, error: 3 });
  });

  it('reads nothing as an empty timeline, and a malformed timeline without throwing', () => {
    expect(digestEvents(undefined).digest).toStrictEqual({ total: 0, names: {}, around: [] });
    expect(digestEvents('not a list').digest.total).toBe(0);
    expect(digestEvents([null, 7, { nothing: true }, event(0, 'playing')]).digest.total).toBe(2);
    expect(formatEvent({ index: 3, t: 12.25, name: 'seeked', mediaTime: 4 })).toBe(
      '#3 t=12.3 media=4.000 seeked',
    );
    expect(formatEvent(null)).toBeNull();
  });

  it('cuts a long detail the way the hook does in a failed wait', () => {
    const line = formatEvent(event(1, 'error', { message: 'x'.repeat(400) })) ?? '';
    expect(line.length).toBeLessThan(220);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('PB-LAB-005 triage digests: metrics and errors', () => {
  it('takes the numbers the metric assertions are about', () => {
    const { digest } = digestMetrics(metrics({ rebuffers: 2, dropped: 13, decoded: 366, latencyMs: 8120 }));
    expect(digest).toStrictEqual({
      state: 'playing',
      startupMs: 900,
      rebuffers: { count: 2, totalMs: 800 },
      frames: { decoded: 366, dropped: 13 },
      liveLatencyMs: 8120,
      bitrateSwitches: 1,
      currentTime: 4.2,
    });
  });

  it('reads a missing or malformed metrics document as no numbers', () => {
    expect(digestMetrics(undefined).digest.state).toBeNull();
    expect(digestMetrics({ state: 7, rebuffer: 'many' }).digest).toMatchObject({
      state: null,
      rebuffers: null,
    });
  });

  it('merges the errors of the timeline and of the metrics, each once; the first critical one is the primary', () => {
    const fromEvents = digestEvents([
      event(0, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 1)),
      event(1, 'error', shakaError(3016, 'VIDEO_ERROR', 3, 2)),
    ]).errors;
    const fromMetrics = digestMetrics(
      metrics({ errors: [shakaError(3016, 'VIDEO_ERROR', 3, 2), shakaError(1002, 'HTTP_ERROR', 1, 1)] }),
    ).errors;
    const { errors, primary } = mergeErrors(fromEvents, fromMetrics);
    expect(errors.map((e) => e.code)).toStrictEqual([1001, 3016, 1002]);
    expect(primary?.code).toBe(3016);
    expect(mergeErrors([], []).primary).toBeNull();
  });
});

describe('PB-LAB-005 triage digests: the server’s log, read the way the contract says', () => {
  it('counts an origin failure as a status of 400 or more or a response the origin cut, and a client hang-up as neither', () => {
    const log = [
      requestEntry(1, { kind: 'manifest', rep: undefined, number: undefined }),
      requestEntry(2),
      requestEntry(3, { status: 503, faults: ['f1'] }),
      requestEntry(4, { status: 404 }),
      requestEntry(5, { status: 200, aborted: true, abortReason: 'fault-abort', faults: ['f2'] }),
      requestEntry(6, { status: 200, aborted: true, abortReason: 'client-closed' }),
      requestEntry(7, { status: 200, aborted: true, abortReason: 'error' }),
      requestEntry(8, { status: 0, pending: true }),
    ];
    const { digest, fired } = digestRequestLog(log);
    expect(digest).toMatchObject({
      entries: 8,
      segments: 7,
      manifests: 1,
      originFailures: 4,
      originFailuresWithoutFault: 2,
      clientAborted: 1,
      pending: 1,
      byStatus: { '200': 5, '404': 1, '503': 1 },
    });
    expect(digest.failed.map((f) => [f.seq, f.status, f.abortReason])).toStrictEqual([
      [3, 503, null],
      [4, 404, null],
      [5, 200, 'fault-abort'],
      [7, 200, 'error'],
    ]);
    expect(Object.fromEntries(fired)).toStrictEqual({ f1: 1, f2: 1 });
  });

  it('agrees with the e2e helper that decides what an origin failure is (requestsFor, status: error)', () => {
    const log = [
      requestEntry(1),
      requestEntry(2, { status: 500 }),
      requestEntry(3, { status: 200, aborted: true, abortReason: 'client-closed' }),
      requestEntry(4, { status: 200, aborted: true, abortReason: 'fault-abort' }),
      requestEntry(5, { status: 200, aborted: true }),
      requestEntry(6, { status: 0, pending: true }),
    ];
    expect(digestRequestLog(log).digest.originFailures).toBe(requestsFor(log, { status: 'error' }).length);
  });

  it('lists only the first failures', () => {
    const log = Array.from({ length: 20 }, (_, index) => requestEntry(index + 1, { status: 503 }));
    const { digest } = digestRequestLog(log);
    expect(digest.originFailures).toBe(20);
    expect(digest.failed).toHaveLength(MAX_LISTED_REQUESTS);
  });

  it('describes a fault rule as a sentence a person can check against the log', () => {
    expect(
      describeRule({
        type: 'status',
        status: 503,
        match: { kind: 'segment', rep: 'v360', number: { from: 3, to: 5 } },
        times: 2,
      }),
    ).toBe('status 503 on segment v360 #3-5 first 2');
    expect(describeRule({ type: 'throttle', kbps: 600, afterMs: 8000 })).toBe(
      'throttle 600 kbps after 8000 ms',
    );
    expect(describeRule({ type: 'abort', afterBytes: 20000, match: { kind: 'media', number: 4 } })).toBe(
      'abort after 20000 bytes on media #4',
    );
    expect(describeRule({ type: 'live-stall', atNumber: 12, ms: 10000 })).toBe(
      'live-stall at segment 12 for 10000 ms',
    );
    expect(describeRule(null)).toBe('a rule');
  });
});

describe('PB-LAB-005 triage digests: the browser console', () => {
  it('counts by type and keeps the first distinct lines of errors and page errors', () => {
    const digest = digestConsole([
      {
        type: 'error',
        text: "Refused to execute inline script because it violates the following Content Security Policy directive: 'script-src'",
      },
      {
        type: 'error',
        text: "Refused to execute inline script because it violates the following Content Security Policy directive: 'script-src'",
      },
      { type: 'warning', text: 'a warning' },
      { type: 'pageerror', text: 'Uncaught TypeError: x is undefined' },
      { type: 'log', text: 'ignored' },
    ]);
    expect(digest).toMatchObject({ errors: 2, warnings: 1, pageErrors: 1 });
    expect(digest.samples).toHaveLength(2);
    expect(digest.samples[0]).toContain('Content Security Policy');
  });
});

describe('PB-LAB-005 triage digests: everything one failed test attached', () => {
  it('has nothing to say about a test that attached nothing', () => {
    expect(digestDiagnostics(set())).toStrictEqual(emptyDiagnostics());
  });

  it('adds the fault rules of the session and how many requests of the log name each', () => {
    const digest = digestDiagnostics(
      set({
        sessionDetail: [
          sessionDetail([
            { id: 'f1', type: 'status', status: 503, match: { kind: 'segment', rep: 'v360' } },
            { id: 'f2', type: 'latency', ms: 800 },
          ]),
        ],
        requestLog: [
          [
            requestEntry(1, { status: 503, faults: ['f1'] }),
            requestEntry(2, { status: 503, faults: ['f1'] }),
          ],
        ],
      }),
    );
    expect(digest.faults).toStrictEqual([
      { id: 'f1', type: 'status', description: 'status 503 on segment v360', fired: 2 },
      { id: 'f2', type: 'latency', description: 'latency 800 ms', fired: 0 },
    ]);
    expect(digest.requestLog?.originFailures).toBe(2);
    expect(digest.sessions).toBe(1);
  });

  it('keeps the rules of a second session apart from the first (their ids repeat), and survives a second player without the first', () => {
    const digest = digestDiagnostics(
      set({
        sessionDetail: [
          sessionDetail([{ id: 'f1', type: 'abort' }]),
          sessionDetail([{ id: 'f1', type: 'status', status: 404 }]),
        ],
        requestLog: [
          [requestEntry(1, { faults: ['f1'], aborted: true, abortReason: 'fault-abort' })],
          [requestEntry(1)],
        ],
      }),
    );
    expect(digest.faults.map((f) => [f.id, f.fired])).toStrictEqual([
      ['f1', 1],
      ['s2/f1', 0],
    ]);
    const holes: AttachmentSet = set({ events: [] });
    holes.events[1] = [event(0, 'error', shakaError(3015, 'MEDIA_SOURCE_OPERATION_THREW', 3, 2))];
    const withHole = digestDiagnostics(holes);
    expect(withHole.players).toBe(2);
    expect(withHole.primaryError?.code).toBe(3015);
  });

  it('says what the fixture could not read', () => {
    const digest = digestDiagnostics(set({ problems: { 'qa-events.json': 'no answer within 5000 ms' } }));
    expect(digest.problems).toStrictEqual({ 'qa-events.json': 'no answer within 5000 ms' });
  });
});
