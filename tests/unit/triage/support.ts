import type { RequestLogEntry, SessionDetail } from '../../../src/shared/api.ts';
import { explainUndocumentedGap } from '../../../src/lab/gaps.ts';
import type { Environment } from '../../../src/lab/gaps.ts';
import { Timeline } from '../../../src/player/timeline.ts';
import type { QAEvent, QAEventName, QAMetrics, QAState } from '../../../src/shared/qa.ts';
import type { PlaywrightReport } from '../../../triage/collect.ts';
import { digestDiagnostics, emptyDiagnostics } from '../../../triage/digest.ts';
import type { AttachmentSet } from '../../../triage/digest.ts';
import type { DiagnosticsDigest, Failure, FailureError } from '../../../triage/types.ts';
import { expectAtMostRebuffers } from '../../e2e/support/assertions.ts';
import { attachDiagnostics } from '../../e2e/support/diagnostics.ts';
import type { DiagnosticSources } from '../../e2e/support/diagnostics.ts';
import { describeUnreadyService } from '../../e2e/support/global-setup.ts';
import type { TestSession } from '../../e2e/support/session.ts';
import { waitForRequest } from '../../e2e/support/waiting.ts';
import { FakeClock } from '../player/fake-clock.ts';

// Builders for the input of triage: a Playwright JSON report (the shape of `reports/playwright.json`, written by the JSON reporter of
// @playwright/test) whose tests carry the failure attachments. The attachments are made by the lab's own `attachDiagnostics`, so their
// names and shapes are the contract of docs/CONTRACTS.md section 7.2 and not what a test of triage assumed. A fixture says what
// happened to a test ("it failed twice with this message and this timeline"), not how Playwright writes it down.

export interface PwAttachment {
  name: string;
  contentType: string;
  body?: string;
  path?: string;
}

/** What one player and one session of a failed test held. */
export interface Documents {
  events?: unknown;
  metrics?: unknown;
  info?: unknown;
  console?: unknown;
  detail?: unknown;
  log?: unknown;
  /** A second player and a second session (`-2`). */
  second?: Documents;
  /** Attachments the fixture could not read (`diagnostics-problems.json` names them). */
  unreadable?: string[];
}

/** The attachments of a failed result, as the JSON reporter keeps them: the body in base64, in the report itself. */
export async function diagnosticAttachments(documents: Documents): Promise<PwAttachment[]> {
  const attached: PwAttachment[] = [];
  const testInfo = {
    attach: async (name: string, options?: { body?: string | Buffer; contentType?: string }) => {
      attached.push({
        name,
        contentType: options?.contentType ?? 'application/json',
        body: Buffer.from(String(options?.body)).toString('base64'),
      });
    },
  };
  const all = [documents, ...(documents.second ? [documents.second] : [])];
  const unreadable = new Set(all.flatMap((one) => one.unreadable ?? []));
  const read = (name: string, value: unknown): Promise<unknown> =>
    unreadable.has(name) ? Promise.reject(new Error('no answer within 5000 ms')) : Promise.resolve(value);
  const players = all
    .filter((one) => [one.events, one.metrics, one.info, one.console].some((value) => value !== undefined))
    .map((one) => ({
      events: () => read('qa-events.json', one.events ?? []),
      metrics: () => read('qa-metrics.json', one.metrics ?? {}),
      info: () => read('qa-info.json', one.info ?? {}),
      consoleEntries: () => (one.console ?? []) as never,
    }));
  const sessions = all.filter((one) => one.detail !== undefined || one.log !== undefined);
  const sources: DiagnosticSources = {
    service: {
      detail: (id: string) => Promise.resolve(sessions[Number(id.slice(1)) - 1]?.detail as SessionDetail),
      log: (id: string) =>
        Promise.resolve((sessions[Number(id.slice(1)) - 1]?.log ?? []) as RequestLogEntry[]),
    },
    sessions: sessions.map((_, index) => ({ id: `s${index + 1}` })),
    players: players as unknown as DiagnosticSources['players'],
  };
  await attachDiagnostics(testInfo, sources);
  return attached;
}

// ---------------------------------------------------------------------------------------------------------------------
// The documents themselves

export function event(
  index: number,
  name: QAEvent['name'],
  detail?: Record<string, unknown>,
  at: { t?: number; mediaTime?: number } = {},
): QAEvent {
  return {
    index,
    t: at.t ?? 100 + index * 250,
    name,
    mediaTime: at.mediaTime ?? 0,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The detail of an `error` event, and an element of `metrics.errors`. */
export function shakaError(
  code: number,
  codeName: string,
  category: number,
  severity: number,
  message = 'an error',
): Record<string, unknown> {
  return { code, codeName, category, severity, message: `${codeName}: ${message}`, source: 'shaka' };
}

export interface MetricsOptions {
  state?: QAState;
  errors?: Array<Record<string, unknown>>;
  rebuffers?: number;
  dropped?: number;
  decoded?: number;
  latencyMs?: number | null;
}

export function metrics(options: MetricsOptions = {}): QAMetrics {
  const rebuffers = options.rebuffers ?? 0;
  return {
    state: options.state ?? 'playing',
    startupMs: 900,
    startup: { manifestMs: 120, loadedMs: 400 },
    rebuffer: { count: rebuffers, totalMs: rebuffers * 400, ratio: 0, events: [] },
    frames: {
      decoded: options.decoded ?? 300,
      dropped: options.dropped ?? 0,
      droppedRatio: 0,
      presented: 300,
    },
    bitrate: { switches: 1, current: null, history: [] },
    live: {
      isLive: false,
      latencyMs: options.latencyMs ?? null,
      latencyMaxMs: null,
      presentationDelayMs: null,
      edgeSeeks: 0,
    },
    errors: (options.errors ?? []) as unknown as QAMetrics['errors'],
    playback: {
      currentTime: 4.2,
      duration: 12,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 6,
      readyState: 4,
    },
  };
}

export function requestEntry(seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    seq,
    t: '2026-11-04T05:00:00.000Z',
    msSinceStart: seq * 100,
    method: 'GET',
    path: `/s/1a2b3c4d5e6f/vod-cmaf/dash/v360/${seq}.m4s`,
    kind: 'segment',
    rep: 'v360',
    number: seq,
    status: 200,
    bytes: 170_000,
    ttfbMs: 4,
    totalMs: 9,
    faults: [],
    ...overrides,
  };
}

export function sessionDetail(rules: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    id: '1a2b3c4d5e6f',
    stream: 'vod-cmaf',
    protocol: 'dash',
    createdAt: '2026-11-04T05:00:00.000Z',
    ttlSec: 900,
    manifestUrl: '/s/1a2b3c4d5e6f/vod-cmaf/dash/manifest.mpd',
    faults: rules,
    counters: { requests: 12, bytes: 1_000_000, errors: 0, byKind: {} },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A Playwright JSON report

export type AttemptStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface AttemptFixture {
  status: AttemptStatus;
  /** The message of the error, as Playwright reports it (`Error: ...`). */
  message?: string;
  stack?: string;
  attachments?: PwAttachment[];
  annotations?: Array<{ type: string; description?: string }>;
  durationMs?: number;
}

export interface TestFixture {
  /** The title, which starts with the catalog id. */
  title: string;
  /** Relative to the test directory, as the report writes it. */
  file?: string;
  line?: number;
  describes?: string[];
  project?: string;
  tags?: string[];
  expected?: 'passed' | 'failed';
  attempts: AttemptFixture[];
  annotations?: Array<{ type: string; description?: string }>;
}

type Outcome = 'skipped' | 'expected' | 'unexpected' | 'flaky';

/** Playwright's own `test.outcome()`. */
function outcomeOf(statuses: readonly AttemptStatus[], expected: string): Outcome {
  if (statuses.every((status) => status === 'skipped')) return 'skipped';
  const bad = statuses.filter((status) => status !== expected && status !== 'skipped');
  if (bad.length === 0) return 'expected';
  return bad.length < statuses.length ? 'flaky' : 'unexpected';
}

/** The stack of an error: its message, then the frames, as Node writes them. */
export function stackOf(message: string, frames: string[]): string {
  return [message, ...frames.map((frame) => `    at ${frame}`)].join('\n');
}

export interface ReportOptions {
  rootDir?: string;
  retries?: number;
  errors?: Array<{ message?: string; stack?: string }>;
  startTime?: string;
}

interface SuiteNode {
  title: string;
  specs: Array<Record<string, unknown>>;
  suites: SuiteNode[];
}

/**
 * A report of the shape the JSON reporter writes: a suite per file, the `describe` blocks nested in it, a spec per title with one test
 * per project (the reporter merges the projects of a spec), and in each test the results of its attempts.
 */
export function report(tests: readonly TestFixture[], options: ReportOptions = {}): PlaywrightReport {
  const rootDir = options.rootDir ?? '/home/runner/work/playback-proof/playback-proof/tests';
  const projects = [...new Set(tests.map((fixture) => fixture.project ?? 'chromium'))];
  const files = new Map<string, SuiteNode>();
  const specs = new Map<string, Record<string, unknown>>();
  tests.forEach((fixture, index) => {
    const file = fixture.file ?? 'e2e/vod-start.spec.ts';
    const project = fixture.project ?? 'chromium';
    const describes = fixture.describes ?? [];
    const expected = fixture.expected ?? 'passed';
    const status = outcomeOf(
      fixture.attempts.map((attempt) => attempt.status),
      expected,
    );
    const test = {
      timeout: 45_000,
      annotations: fixture.annotations ?? [],
      expectedStatus: expected,
      projectId: project,
      projectName: project,
      status,
      results: fixture.attempts.map((attempt, retry) => ({
        workerIndex: index,
        parallelIndex: index,
        status: attempt.status,
        duration: attempt.durationMs ?? 1500,
        ...(attempt.message === undefined
          ? {}
          : { error: { message: attempt.message, stack: attempt.stack ?? attempt.message } }),
        errors: [],
        stdout: [],
        stderr: [],
        retry,
        startTime: `2026-11-04T05:0${index % 10}:00.000Z`,
        annotations: attempt.annotations ?? [],
        attachments: attempt.attachments ?? [],
      })),
    };
    const specKey = [file, ...describes, fixture.title, fixture.line ?? 20].join('\u0000');
    const known = specs.get(specKey);
    if (known) {
      (known.tests as unknown[]).push(test);
      return;
    }
    const spec = {
      title: fixture.title,
      ok: status === 'expected' || status === 'skipped',
      tags: (fixture.tags ?? ['merge']).map((tag) => tag.replace(/^@/, '')),
      tests: [test],
      id: `spec-${specs.size}`,
      file,
      line: fixture.line ?? 20,
      column: 5,
    };
    specs.set(specKey, spec);
    const fileNode: SuiteNode = files.get(file) ?? { title: file, specs: [], suites: [] };
    files.set(file, fileNode);
    let node = fileNode;
    for (const title of describes) {
      const existing = node.suites.find((suite) => suite.title === title);
      const child: SuiteNode = existing ?? { title, specs: [], suites: [] };
      if (!existing) node.suites.push(child);
      node = child;
    }
    node.specs.push(spec);
  });
  const outcomes = tests.map((fixture) =>
    outcomeOf(
      fixture.attempts.map((attempt) => attempt.status),
      fixture.expected ?? 'passed',
    ),
  );
  const count = (wanted: Outcome): number => outcomes.filter((outcome) => outcome === wanted).length;
  return {
    config: {
      rootDir,
      projects: projects.map((name) => ({ name, retries: options.retries ?? 1 })),
    },
    suites: [...files.values()],
    errors: options.errors ?? [],
    stats: {
      startTime: options.startTime ?? '2026-11-04T05:00:00.000Z',
      duration: 42_000,
      expected: count('expected'),
      unexpected: count('unexpected'),
      flaky: count('flaky'),
      skipped: count('skipped'),
    },
  } as PlaywrightReport;
}

// ---------------------------------------------------------------------------------------------------------------------
// A Failure, for the tests of what is done with one (signatures, rules, clusters)

export interface FailureOverrides extends Partial<Omit<Failure, 'error' | 'diagnostics'>> {
  message?: string;
  frames?: FailureError['frames'];
  diagnostics?: Partial<DiagnosticsDigest>;
}

export function failure(overrides: FailureOverrides = {}): Failure {
  const { message, frames, diagnostics, ...rest } = overrides;
  return {
    scope: 'test',
    id: 'PB-VOD-001',
    title: 'PB-VOD-001 starts and reaches 3 s of media time',
    file: 'tests/e2e/vod-start.spec.ts',
    line: 20,
    project: 'chromium',
    tags: ['@merge'],
    tier: 'merge',
    outcome: 'failed',
    retries: 1,
    attempts: 2,
    failedAttempts: 2,
    attempt: 0,
    durationMs: 4000,
    quarantined: false,
    experimental: false,
    annotations: [],
    envId: 'local-darwin-arm64',
    source: 'reports/playwright.json',
    error: { message: message ?? 'Error: something failed', frames: frames ?? [] },
    diagnostics: { ...emptyDiagnostics(), ...diagnostics },
    missing: [],
    ...rest,
  };
}

/** The digest of what a failed test attached, made from the documents themselves the way the collector does. */
export function diagnosticsOf(documents: {
  events?: unknown;
  metrics?: unknown;
  info?: unknown;
  console?: unknown;
  detail?: unknown;
  log?: unknown;
  attached?: string[];
}): DiagnosticsDigest {
  const one = (value: unknown): unknown[] => (value === undefined ? [] : [value]);
  const set: AttachmentSet = {
    events: one(documents.events),
    metrics: one(documents.metrics),
    info: one(documents.info),
    console: one(documents.console),
    sessionDetail: one(documents.detail),
    requestLog: one(documents.log),
    problems: null,
    attached: documents.attached ?? ['qa-events.json'],
  };
  return digestDiagnostics(set);
}

// ---------------------------------------------------------------------------------------------------------------------
// The messages the lab itself writes when it fails, made by the lab's own code: a rule of triage is keyed to a sentence the lab says, and
// a test that makes the sentence with the lab's function fails when someone rewords it.

const quiet = (sentence: string): string => `Error: ${sentence}`;

/** `qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).` and the timeline, from the hook's own `Timeline`. */
export async function hookWaitTimeout(
  name: QAEventName,
  options: {
    timeoutMs?: number;
    detail?: Record<string, string | number | boolean | null>;
    seen?: QAEventName[];
  } = {},
): Promise<string> {
  const clock = new FakeClock();
  const timeline = new Timeline({ now: clock.now, mediaTime: clock.mediaTime, timers: clock.timerApi });
  for (const seen of options.seen ?? ['load-requested', 'manifest-loaded', 'loaded', 'buffering-start']) {
    clock.advance(120);
    timeline.record(seen);
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const waiting = timeline
    .waitFor(name, { timeoutMs, ...(options.detail ? { detail: options.detail } : {}) })
    .then(
      () => 'the wait did not time out',
      (error: Error) => error.message,
    );
  clock.advance(timeoutMs + 1);
  return quiet(await waiting);
}

/** `qa.waitForMediaTime(7) timed out after 15000 ms: the media clock is at 5.973 s.` and the timeline. */
export async function hookMediaTimeTimeout(
  seconds: number,
  atSeconds: number,
  timeoutMs = 15_000,
): Promise<string> {
  const clock = new FakeClock();
  const timeline = new Timeline({ now: clock.now, mediaTime: clock.mediaTime, timers: clock.timerApi });
  timeline.record('load-requested');
  clock.media = atSeconds;
  const waiting = timeline.waitForMediaTime(seconds, { timeoutMs }).then(
    () => 'the wait did not time out',
    (error: Error) => error.message,
  );
  clock.advance(timeoutMs + 1);
  return quiet(await waiting);
}

/** `waited 15000 ms for a request of session ... matching ...` from the real `waitForRequest`. */
export async function requestWaitTimeout(timeoutMs = 15_000): Promise<string> {
  const session = {
    id: '1a2b3c4d5e6f',
    service: { waitForLog: () => Promise.reject(new Error('the log did not reach the expected state')) },
  } as unknown as TestSession;
  try {
    await waitForRequest(session, (entry) => entry.kind === 'segment' && entry.number === 7, { timeoutMs });
  } catch (error) {
    return quiet((error as Error).message);
  }
  return 'the wait did not time out';
}

/** The failure of `expectAtMostRebuffers`: the message names the metric and the value, then Playwright's own matcher lines. */
export function rebufferAssertion(limit: number, rebuffers: number): string {
  const events = Array.from({ length: rebuffers }, (_, index) => ({
    startMs: 11_939 + index * 2000,
    durationMs: 24 + index * 100,
    mediaTime: 8.01 + index * 1.96,
    ongoing: false,
  }));
  const state = metrics({ rebuffers });
  state.rebuffer.events = events;
  try {
    expectAtMostRebuffers(state, limit);
  } catch (error) {
    return (error as Error).message;
  }
  return 'the assertion did not fail';
}

/** PB-ENV-001's failure text, from `explainUndocumentedGap`. */
export function environmentCheckFailure(cause = "qa.waitFor('firstframe') timed out after 15000 ms"): string {
  const environment: Environment = {
    envId: 'jenkins-linux-arm64',
    engine: 'chromium',
    platform: 'linux',
    capabilities: null,
    basis:
      'no committed probe result for jenkins-linux-arm64 (docs/results/codec-matrix/jenkins-linux-arm64.json)',
    experimental: null,
  };
  return quiet(
    explainUndocumentedGap(environment, {
      stream: 'vod-cmaf',
      protocol: 'dash',
      actualVersion: '156.0.8078.4',
      cause,
    }),
  );
}

/** The global setup's refusal to run against a service that cannot serve the specs. */
export function notReadyFailure(): string {
  const text = describeUnreadyService('http://127.0.0.1:4750', {
    status: 'ok',
    version: '1',
    ffmpeg: 'ffmpeg 6.1',
    uptimeSec: 3,
    player: 'missing',
    streams: { 'vod-cmaf': 'ready', 'vod-webm': 'missing' } as never,
  });
  return quiet(text ?? 'the service is ready');
}
