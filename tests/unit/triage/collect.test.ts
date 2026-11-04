import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collect,
  findReports,
  looksLikeReport,
  readReport,
  resolveAttachmentPath,
} from '../../../triage/collect.ts';
import type { PlaywrightReport } from '../../../triage/collect.ts';
import { record, run } from '../flake/fixtures.ts';
import { makeScratch } from '../support/scratch.ts';
import {
  diagnosticAttachments,
  event,
  metrics,
  report,
  requestEntry,
  sessionDetail,
  shakaError,
  stackOf,
} from './support.ts';
import type { PwAttachment, ReportOptions, TestFixture } from './support.ts';

const ROOT = '/home/runner/work/playback-proof/playback-proof';
const frame = (name: string | null, file: string, line: number): string =>
  name === null ? `${ROOT}/${file}:${line}:9` : `${name} (${ROOT}/${file}:${line}:9)`;

let scratch: string;
let counter = 0;

/** Writes a JSON (or text) file below the scratch directory. */
const write = (path: string, value: unknown): void => {
  mkdirSync(dirname(join(scratch, path)), { recursive: true });
  writeFileSync(join(scratch, path), typeof value === 'string' ? value : JSON.stringify(value));
};
/** A directory of its own for a test, so that two tests never read each other's files. */
const dir = (): string => {
  counter += 1;
  return `case-${counter}`;
};
const read = (tests: TestFixture[], options?: ReportOptions) =>
  readReport(report(tests, options), { from: scratch, source: 'reports/playwright.json' });
const failedWith = (message: string, attachments?: PwAttachment[]): TestFixture['attempts'][number] => ({
  status: 'failed',
  message,
  ...(attachments ? { attachments } : {}),
});

beforeAll(() => {
  scratch = makeScratch('triage-collect-');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const MESSAGE =
  'Error: the fault rule f1 {"type":"status"} named 2 of the 3 requests it was waited for within 15000 ms: the player stopped asking';

async function failedWithDiagnostics(): Promise<TestFixture> {
  const attachments = await diagnosticAttachments({
    events: [
      event(0, 'load-requested'),
      event(1, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, 'HTTP error status 404')),
    ],
    metrics: metrics({
      state: 'error',
      errors: [shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, 'HTTP error status 404')],
    }),
    info: { userAgent: 'Mozilla/5.0 Firefox/157.0', config: 'A', loadMode: 'media-source' },
    console: [{ type: 'error', text: 'Failed to load resource: the server responded with a status of 404' }],
    detail: sessionDetail([
      { id: 'f1', type: 'status', status: 404, match: { kind: 'segment', rep: 'v360' } },
    ]),
    log: [
      requestEntry(1),
      requestEntry(2, { status: 404, faults: ['f1'] }),
      requestEntry(3, { status: 404, faults: ['f1'] }),
    ],
  });
  const attempt = {
    status: 'failed' as const,
    message: MESSAGE,
    stack: stackOf(MESSAGE, [
      frame('waitForFault', 'tests/e2e/rec/faults.ts', 55),
      frame(null, 'tests/e2e/recovery.spec.ts', 130),
      frame(null, 'node_modules/playwright/lib/worker/testInfo.js', 337),
    ]),
    attachments,
  };
  return {
    title: 'PB-REC-002 recovers from a burst of 404s',
    file: 'e2e/recovery.spec.ts',
    line: 120,
    project: 'firefox',
    tags: ['merge', 'dash'],
    attempts: [attempt, attempt],
  };
}

describe('PB-LAB-005 triage collection: a failed test becomes a Failure', () => {
  it('reads the identity, the error, the frames of the lab’s own code and the digests of the attachments', async () => {
    const { failures } = read([await failedWithDiagnostics()]);
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure).toMatchObject({
      scope: 'test',
      id: 'PB-REC-002',
      title: 'PB-REC-002 recovers from a burst of 404s',
      file: 'tests/e2e/recovery.spec.ts',
      line: 120,
      project: 'firefox',
      tags: ['@dash', '@merge'],
      tier: 'merge',
      outcome: 'failed',
      retries: 1,
      attempts: 2,
      failedAttempts: 2,
      attempt: 0,
      quarantined: false,
      experimental: false,
      source: 'reports/playwright.json',
      missing: [],
    });
    expect(failure.error.message).toBe(MESSAGE);
    expect(failure.error.frames).toStrictEqual([
      { file: 'tests/e2e/rec/faults.ts', fn: 'waitForFault', line: 55 },
      { file: 'tests/e2e/recovery.spec.ts', fn: null, line: 130 },
    ]);
    const d = failure.diagnostics;
    expect(d.attached).toStrictEqual([
      'page-console.json',
      'qa-events.json',
      'qa-info.json',
      'qa-metrics.json',
      'request-log.json',
      'session-detail.json',
    ]);
    expect(d.primaryError).toMatchObject({ code: 1001, codeName: 'BAD_HTTP_STATUS', severity: 2 });
    expect(d.metrics.state).toBe('error');
    expect(d.faults).toStrictEqual([
      { id: 'f1', type: 'status', description: 'status 404 on segment v360', fired: 2 },
    ]);
    expect(d.requestLog).toMatchObject({ entries: 3, originFailures: 2, originFailuresWithoutFault: 0 });
    expect(d.console.samples).toStrictEqual([
      'Failed to load resource: the server responded with a status of 404',
    ]);
    expect(d.userAgent).toContain('Firefox/157.0');
  });

  it('reads a flaky test as flaky, with the error and the attachments of the attempt that failed, not of the one that passed', async () => {
    const failed = (await failedWithDiagnostics()).attempts[0]!;
    const { failures, summary } = read([
      { title: 'PB-ABR-006 steps down', file: 'e2e/abr.spec.ts', attempts: [failed, { status: 'passed' }] },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ outcome: 'flaky', attempts: 2, failedAttempts: 1, attempt: 0 });
    expect(failures[0]?.diagnostics.attached).toContain('qa-events.json');
    expect(summary).toMatchObject({ tests: 1, flaky: 1, failed: 0, passed: 0 });
  });

  it('tells a timeout from a failure by how the last attempt ended', () => {
    const timeout = { status: 'timedOut' as const, message: 'Error: Test timeout of 45000ms exceeded.' };
    const { failures } = read([
      { title: 'PB-VOD-003 ends', attempts: [failedWith('Error: x'), timeout] },
      { title: 'PB-VOD-004 pauses', attempts: [timeout, failedWith('Error: y')] },
    ]);
    expect(failures.map((f) => [f.id, f.outcome])).toStrictEqual([
      ['PB-VOD-003', 'timedOut'],
      ['PB-VOD-004', 'failed'],
    ]);
  });

  it('uses the describe blocks in the title, and the whole title as the id of a test that has no catalog id', () => {
    const { failures } = read([
      { title: 'plays the stream', describes: ['smoke', 'dash'], attempts: [failedWith('Error: x')] },
    ]);
    expect(failures[0]).toMatchObject({
      id: 'smoke › dash › plays the stream',
      title: 'smoke › dash › plays the stream',
    });
  });

  it('says a launch failure has no attachments instead of failing on it', () => {
    const message =
      'Error: browserType.launch: Failed to launch the browser process: Could not find profile folder.';
    const { failures } = read([
      {
        title: 'PB-VOD-001 starts',
        project: 'firefox',
        attempts: [failedWith(message), failedWith(message)],
      },
    ]);
    expect(failures[0]?.missing[0]).toMatch(/^no failure attachments/);
    expect(failures[0]?.diagnostics.attached).toStrictEqual([]);
    expect(failures[0]?.diagnostics.primaryError).toBeNull();
  });

  it('takes the attachments of a later failing attempt when the first has none, and says so', async () => {
    const withAttachments = (await failedWithDiagnostics()).attempts[0]!;
    const { failures } = read([
      { title: 'PB-REC-002 recovers', attempts: [failedWith('Error: first'), withAttachments] },
    ]);
    expect(failures[0]?.error.message).toBe('Error: first');
    expect(failures[0]?.diagnostics.attached).toContain('request-log.json');
    expect(failures[0]?.missing[0]).toMatch(/attempt 2/);
  });

  it('reports a second player and a second session next to the first, and what the fixture could not read', async () => {
    const attachments = await diagnosticAttachments({
      events: [event(0, 'load-requested')],
      metrics: metrics(),
      info: { userAgent: 'x' },
      console: [],
      detail: sessionDetail([{ id: 'f1', type: 'abort' }]),
      log: [requestEntry(1)],
      unreadable: ['qa-metrics.json'],
      second: {
        events: [event(0, 'error', shakaError(3016, 'VIDEO_ERROR', 3, 2))],
        metrics: metrics({ state: 'error' }),
        info: { userAgent: 'x' },
        console: [],
        detail: sessionDetail([{ id: 'f1', type: 'status', status: 503 }]),
        log: [requestEntry(1, { status: 503, faults: ['f1'] })],
      },
    });
    expect(attachments.map((a) => a.name)).toContain('qa-events-2.json');
    expect(attachments.map((a) => a.name)).toContain('diagnostics-problems.json');
    const { failures } = read([
      { title: 'PB-EME-001 plays', attempts: [failedWith('Error: x', attachments)] },
    ]);
    const d = failures[0]!.diagnostics;
    expect(d.players).toBe(2);
    expect(d.sessions).toBe(2);
    expect(d.primaryError?.code).toBe(3016);
    expect(d.faults.map((f) => f.id)).toStrictEqual(['f1', 's2/f1']);
    expect(d.problems['qa-metrics.json']).toMatch(/no answer/);
    expect(failures[0]?.missing).toContain('qa-metrics.json: not attached');
  });

  it('names an attachment that is not JSON, and one that was written to a file the artifacts do not have', () => {
    const attachments: PwAttachment[] = [
      {
        name: 'qa-events.json',
        contentType: 'application/json',
        body: Buffer.from('{ truncated').toString('base64'),
      },
      {
        name: 'request-log.json',
        contentType: 'application/json',
        path: '/runner/work/x/test-results/dir-a/request-log.json',
      },
      { name: 'trace', contentType: 'application/zip', path: '/runner/work/x/test-results/dir-a/trace.zip' },
    ];
    const { failures } = readReport(
      report([{ title: 'PB-VOD-001 starts', attempts: [failedWith('Error: x', attachments)] }]),
      { from: scratch, source: 'r.json', roots: [scratch] },
    );
    expect(failures[0]?.missing).toStrictEqual([
      'qa-events.json: is not valid JSON',
      'request-log.json: the file request-log.json is not in the artifacts',
    ]);
  });
});

describe('PB-LAB-005 triage collection: what is not a failure', () => {
  it('lists a skip with its reason, and flags a skip with none', () => {
    const { failures, skipped, summary } = read([
      {
        title: 'PB-VOD-001 starts',
        project: 'firefox',
        attempts: [
          {
            status: 'skipped',
            annotations: [
              { type: 'skip', description: 'documented gap in local-darwin-arm64: firefox does not start' },
            ],
          },
        ],
      },
      { title: 'PB-VOD-002 plays', project: 'webkit', attempts: [{ status: 'skipped' }] },
      { title: 'PB-VOD-003 ends', attempts: [{ status: 'passed' }] },
    ]);
    expect(failures).toStrictEqual([]);
    expect(skipped.map((s) => [s.id, s.project, s.reason])).toStrictEqual([
      ['PB-VOD-001', 'firefox', 'documented gap in local-darwin-arm64: firefox does not start'],
      ['PB-VOD-002', 'webkit', null],
    ]);
    expect(summary).toMatchObject({ tests: 3, passed: 1, skipped: 2 });
  });

  it('does not call a test with no attempt a skip: a listing, or a run stopped before it, has nothing to blame and no bug to flag', () => {
    const { failures, skipped, summary } = read([
      { title: 'PB-VOD-001 starts', attempts: [] },
      { title: 'PB-VOD-002 plays', project: 'webkit', attempts: [] },
      { title: 'PB-VOD-003 ends', attempts: [{ status: 'skipped' }] },
    ]);
    expect(failures).toStrictEqual([]);
    // Only the test that ran up to a skip is a skip, and without a reason it is still the bug it was.
    expect(skipped.map((s) => [s.id, s.reason])).toStrictEqual([['PB-VOD-003', null]]);
    expect(summary).toMatchObject({ tests: 3, passed: 0, skipped: 1, notRun: 2 });
  });

  it('does not make a failure of a test the run stopped on, and counts it', () => {
    const { failures, summary } = read([
      { title: 'PB-VOD-005 seeks', attempts: [{ status: 'interrupted' }] },
    ]);
    expect(failures).toStrictEqual([]);
    expect(summary.interrupted).toBe(1);
  });

  it('turns an error of the run itself (a global setup that threw) into a failure of the run, with no test to blame', () => {
    const message =
      'Error: the test data service at http://127.0.0.1:4750 is not answering (fetch failed): start it with `npm run build:player && npm run serve`';
    const stack = stackOf(message, [frame('globalSetup', 'tests/e2e/support/global-setup.ts', 22)]);
    const { failures, summary } = read([], { errors: [{ message, stack }] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      scope: 'run',
      id: '(run)',
      project: '(run)',
      outcome: 'failed',
      error: { message },
    });
    expect(failures[0]?.error.frames[0]).toMatchObject({ fn: 'globalSetup' });
    expect(summary.runErrors).toBe(1);
  });

  it('removes the colour codes of an assertion from the message', () => {
    const esc = String.fromCharCode(27);
    const message = `Error: ${esc}[2mexpect(${esc}[22m${esc}[31mreceived${esc}[39m${esc}[2m).${esc}[22mtoBe${esc}[2m(${esc}[22m${esc}[32mexpected${esc}[39m${esc}[2m)${esc}[22m`;
    const { failures } = read([{ title: 'PB-VOD-001 starts', attempts: [failedWith(message)] }]);
    expect(failures[0]?.error.message).toBe('Error: expect(received).toBe(expected)');
  });
});

describe('PB-LAB-005 triage collection: a directory of reports and of downloaded artifacts', () => {
  const failing = (project: string, title = 'PB-VOD-002 plays HLS'): TestFixture => ({
    title,
    project,
    attempts: [failedWith('Error: HLS media playlists requested (request log)')],
  });

  it('reads every leg of a downloaded run, in the order of their paths, naming each by its path', () => {
    const root = dir();
    write(`${root}/artifacts/reports-firefox/playwright.json`, report([failing('firefox')]));
    write(`${root}/artifacts/reports-chromium/playwright.json`, report([failing('chromium')]));
    write(
      `${root}/artifacts/reports-webkit/playwright.json`,
      report([
        failing('webkit'),
        { title: 'PB-VOD-001 starts', project: 'webkit', attempts: [{ status: 'passed' }] },
      ]),
    );
    const collection = collect(join(scratch, root, 'artifacts'));
    expect(collection.problems).toStrictEqual([]);
    expect(collection.sources.map((s) => s.path)).toStrictEqual([
      join('reports-chromium', 'playwright.json'),
      join('reports-firefox', 'playwright.json'),
      join('reports-webkit', 'playwright.json'),
    ]);
    expect(collection.failures.map((f) => [f.project, f.id])).toStrictEqual([
      ['chromium', 'PB-VOD-002'],
      ['firefox', 'PB-VOD-002'],
      ['webkit', 'PB-VOD-002'],
    ]);
  });

  it('reads the layout of the Jenkins job (reports/<engine>/playwright.json) and the default one (reports/playwright.json)', () => {
    const root = dir();
    write(`${root}/reports/playwright.json`, report([failing('chromium')]));
    write(`${root}/reports/firefox/playwright.json`, report([failing('firefox')]));
    expect(
      findReports(join(scratch, root)).map((p) => p.slice(join(scratch, root).length + 1)),
    ).toStrictEqual([join('reports', 'firefox', 'playwright.json'), join('reports', 'playwright.json')]);
    expect(collect(join(scratch, root)).failures).toHaveLength(2);
  });

  it('reads one report file given by its path', () => {
    const root = dir();
    write(`${root}/anything.json`, report([failing('chromium')]));
    expect(collect(join(scratch, root, 'anything.json')).failures).toHaveLength(1);
  });

  it('counts a report that was uploaded twice once', () => {
    const root = dir();
    const same = report([failing('chromium')]);
    write(`${root}/a/playwright.json`, same);
    write(`${root}/b/playwright.json`, same);
    const collection = collect(join(scratch, root));
    expect(collection.sources).toHaveLength(2);
    expect(collection.failures).toHaveLength(1);
  });

  it('marks the failures of the quarantined invocation (reports/quarantined/), which never blocks', () => {
    const root = dir();
    write(`${root}/reports/quarantined/playwright.json`, report([failing('chromium')]));
    write(`${root}/reports/playwright.json`, report([failing('webkit')]));
    const byProject = Object.fromEntries(
      collect(join(scratch, root)).failures.map((f) => [f.project, f.quarantined]),
    );
    expect(byProject).toStrictEqual({ chromium: true, webkit: false });
  });

  it('takes the environment of a run from the flake run file next to the reports, else from the environment annotation', () => {
    const environment = {
      type: 'environment',
      description: 'docker-linux-arm64: webkit 27.2; evidence: the committed matrix',
    };
    const envTest: TestFixture = {
      title: 'PB-ENV-001 plays',
      project: 'webkit',
      attempts: [failedWith('Error: x')],
      annotations: [environment],
    };
    const root = dir();
    write(`${root}/reports/playwright.json`, report([failing('chromium'), failing('firefox'), envTest]));
    write(
      `${root}/reports/flake/run.json`,
      run([record({ id: 'PB-VOD-002', project: 'chromium', outcome: 'failed' })], { envId: 'gha-linux-x64' }),
    );
    // The run file names the test it knows; the one it does not know has the run's only environment; a test that says where it ran says so.
    expect(collect(join(scratch, root)).failures.map((f) => [f.project, f.envId])).toStrictEqual([
      ['chromium', 'gha-linux-x64'],
      ['firefox', 'gha-linux-x64'],
      ['webkit', 'docker-linux-arm64'],
    ]);
    const alone = dir();
    write(`${alone}/reports/playwright.json`, report([envTest, failing('chromium')]));
    expect(collect(join(scratch, alone)).failures.map((f) => f.envId)).toStrictEqual([
      'docker-linux-arm64',
      null,
    ]);
  });

  it('looks for an attachment kept as a file in the test-results of the artifacts, whatever the machine called the directory', () => {
    const root = dir();
    write(`${root}/artifacts/test-results-chromium/e2e-vod-chromium/qa-events.json`, [
      event(0, 'load-requested'),
      event(1, 'error', shakaError(3016, 'VIDEO_ERROR', 3, 2)),
    ]);
    const attachments: PwAttachment[] = [
      {
        name: 'qa-events.json',
        contentType: 'application/json',
        path: '/home/runner/work/x/x/test-results/e2e-vod-chromium/qa-events.json',
      },
    ];
    write(
      `${root}/artifacts/reports-chromium/playwright.json`,
      report([{ title: 'PB-VOD-001 starts', attempts: [failedWith('Error: x', attachments)] }]),
    );
    const failure = collect(join(scratch, root, 'artifacts')).failures[0]!;
    expect(failure.missing.join('\n')).not.toContain('qa-events');
    expect(failure.diagnostics.primaryError?.code).toBe(3016);
    expect(
      resolveAttachmentPath('/nowhere/test-results/a/b.json', [join(scratch, root, 'artifacts')]),
    ).toBeNull();
    expect(resolveAttachmentPath('/no/test-results-dir/a.json', [scratch])).toBeNull();
  });
});

describe('PB-LAB-005 triage collection: input that is not what it should be never throws', () => {
  it('says so for a directory with no report, a missing directory, a file that is not JSON and JSON that is not a report', () => {
    const empty = dir();
    mkdirSync(join(scratch, empty), { recursive: true });
    expect(collect(join(scratch, empty)).problems[0]).toMatch(/no Playwright JSON report/);
    expect(collect(join(scratch, 'does-not-exist')).problems[0]).toMatch(/does not exist/);

    const mixed = dir();
    write(`${mixed}/playwright.json`, '{ not json');
    write(`${mixed}/sub/playwright-b.json`, { hello: 'world' });
    write(
      `${mixed}/sub2/playwright.json`,
      report([{ title: 'PB-VOD-001 starts', attempts: [failedWith('Error: x')] }]),
    );
    const collection = collect(join(scratch, mixed));
    expect(collection.failures).toHaveLength(1);
    expect(collection.problems).toHaveLength(2);
    expect(collection.problems.join('\n')).toMatch(/playwright\.json: could not be read/);
    expect(collection.problems.join('\n')).toMatch(/is not a Playwright JSON report/);
  });

  it('recognises a report by its shape, and reads half a report as far as it goes', () => {
    expect(looksLikeReport(report([]))).toBe(true);
    expect(looksLikeReport({ suites: [] })).toBe(false);
    expect(looksLikeReport([])).toBe(false);
    expect(looksLikeReport(null)).toBe(false);
    const half: PlaywrightReport = {
      config: {},
      suites: [
        {
          title: 'f',
          specs: [
            {
              title: 'PB-VOD-001 x',
              tests: [{ projectName: 'chromium', status: 'unexpected', results: [{ status: 'failed' }] }],
            },
            { title: 'broken' },
          ],
        },
      ],
    };
    const reading = readReport(half, { from: scratch, source: 'half.json' });
    expect(reading.failures).toHaveLength(1);
    expect(reading.failures[0]?.error.message).toBe('');
    expect(reading.summary.tests).toBe(1);
  });

  it('does not read the HTML report’s data, which holds attachments and is not a report', () => {
    const root = dir();
    write(
      `${root}/reports/html/data/playwright-1.json`,
      report([{ title: 'PB-VOD-001 starts', attempts: [failedWith('Error: x')] }]),
    );
    expect(findReports(join(scratch, root))).toStrictEqual([]);
  });
});
