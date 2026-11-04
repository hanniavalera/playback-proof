import type { RequestLogEntry, SessionDetail } from '../../../src/shared/api.ts';
import type { QAEvent, QAMetrics, QAState } from '../../../src/shared/qa.ts';
import type { PlaywrightReport } from '../../../triage/collect.ts';
import { attachDiagnostics } from '../../e2e/support/diagnostics.ts';
import type { DiagnosticSources } from '../../e2e/support/diagnostics.ts';

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
