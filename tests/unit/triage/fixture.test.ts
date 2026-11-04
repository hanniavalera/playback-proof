import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertClean,
  DEFAULT_WORKSPACE,
  FixtureError,
  main,
  reduceReport,
  writeFixture,
} from '../../../tools/triage-fixture.ts';
import { cluster } from '../../../triage/cluster.ts';
import { collect, readReport } from '../../../triage/collect.ts';
import { makeScratch } from '../support/scratch.ts';
import { SECRETS } from './secrets.ts';
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
import type { PwAttachment, TestFixture } from './support.ts';

const HOME_ROOT = '/Users/someone/repos/playback-proof';
const frame = (name: string | null, file: string, line: number): string =>
  name === null ? `${HOME_ROOT}/${file}:${line}:9` : `${name} (${HOME_ROOT}/${file}:${line}:9)`;

let scratch: string;
let counter = 0;
const dir = (name: string): string => {
  counter += 1;
  return join(scratch, `${name}-${counter}`);
};

beforeAll(() => {
  scratch = makeScratch('triage-fixture-');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const MESSAGE = `Error: the fault rule f1 {"type":"status"} named 2 of the 3 requests it was waited for within 15000 ms: the player stopped asking (from ${HOME_ROOT}/dist/player)`;
const picture: PwAttachment = {
  name: 'screenshot',
  contentType: 'image/png',
  path: `${HOME_ROOT}/test-results/x/test-failed-1.png`,
};
const trace: PwAttachment = {
  name: 'trace',
  contentType: 'application/zip',
  path: `${HOME_ROOT}/test-results/x/trace.zip`,
};

async function failedTest(
  overrides: Partial<TestFixture> = {},
  log = [requestEntry(1), requestEntry(2, { status: 404, faults: ['f1'] })],
): Promise<TestFixture> {
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
    log,
  });
  const attempt = {
    status: 'failed' as const,
    message: MESSAGE,
    stack: stackOf(MESSAGE, [
      frame('waitForFault', 'tests/e2e/rec/faults.ts', 55),
      frame(null, 'tests/e2e/recovery.spec.ts', 130),
      frame(null, 'node_modules/playwright/lib/worker/testInfo.js', 337),
    ]),
    attachments: [...attachments, picture, trace],
  };
  return {
    title: 'PB-REC-002 recovers from a burst of 404s',
    file: 'e2e/recovery.spec.ts',
    line: 120,
    project: 'firefox',
    tags: ['merge', 'dash'],
    attempts: [attempt, attempt],
    ...overrides,
  };
}

const passed = (title: string, project = 'chromium'): TestFixture => ({
  title,
  project,
  attempts: [{ status: 'passed' }],
});
const options = { rootDir: `${HOME_ROOT}/tests` };

const signatures = (failures: ReturnType<typeof cluster>) =>
  failures.map((one) => ({
    signature: one.signature,
    category: one.category,
    rule: one.rule.rule,
    size: one.size,
  }));

describe('PB-LAB-005 triage fixtures: what stays', () => {
  it('keeps the tests that did not pass, drops the others, and says how many', async () => {
    const flaky = {
      ...(await failedTest({ title: 'PB-REC-001 recovers from one 404', project: 'chromium' })),
      attempts: [{ status: 'failed' as const, message: 'Error: once' }, { status: 'passed' as const }],
    };
    const skipped: TestFixture = {
      title: 'PB-EME-004 plays protected content',
      project: 'webkit',
      attempts: [{ status: 'skipped' }],
      annotations: [{ type: 'skip', description: 'documented gap in local-darwin-arm64: no decryptor' }],
    };
    const { report: reduced, kept } = reduceReport(
      report(
        [passed('PB-VOD-001 starts'), await failedTest(), flaky, skipped, passed('PB-VOD-002 plays')],
        options,
      ),
    );
    expect(kept).toMatchObject({ failed: 1, flaky: 1, skipped: 1, passedDropped: 2 });
    const titles = JSON.stringify(reduced);
    expect(titles).toContain('PB-REC-002');
    expect(titles).toContain('PB-REC-001');
    expect(titles).toContain('documented gap in local-darwin-arm64: no decryptor');
    expect(titles).not.toContain('PB-VOD-001');
  });

  it('keeps the lab’s attachments of the first failing attempt as files, and not the screenshot, the trace or the second attempt’s', async () => {
    const reduction = reduceReport(report([await failedTest()], options));
    expect(Object.keys(reduction.files).sort()).toStrictEqual([
      expect.stringMatching(/^test-results\/01-.*\/page-console\.json$/),
      expect.stringMatching(/\/qa-events\.json$/),
      expect.stringMatching(/\/qa-info\.json$/),
      expect.stringMatching(/\/qa-metrics\.json$/),
      expect.stringMatching(/\/request-log\.json$/),
      expect.stringMatching(/\/session-detail\.json$/),
    ]);
    expect(reduction.kept.attachments).toBe(6);
    const json = JSON.stringify(reduction.report);
    expect(json).not.toContain('trace.zip');
    expect(json).not.toContain('test-failed-1.png');
    const attempts = (
      reduction.report as {
        suites: Array<{ specs: Array<{ tests: Array<{ results: Array<{ attachments: unknown[] }> }> }> }>;
      }
    ).suites[0]!.specs[0]!.tests[0]!.results;
    expect(attempts.map((result) => result.attachments.length)).toStrictEqual([6, 0]);
  });

  it('takes the attachments of a later attempt when the first failing one has none, as the collector does', async () => {
    const withDiagnostics = await failedTest();
    const [, second] = withDiagnostics.attempts;
    const reduction = reduceReport(
      report([{ ...withDiagnostics, attempts: [{ status: 'failed', message: MESSAGE }, second!] }], options),
    );
    expect(reduction.kept.attachments).toBe(6);
    const results = (
      reduction.report as {
        suites: Array<{ specs: Array<{ tests: Array<{ results: Array<{ attachments: unknown[] }> }> }> }>;
      }
    ).suites[0]!.specs[0]!.tests[0]!.results;
    expect(results.map((result) => result.attachments.length)).toStrictEqual([0, 6]);
  });

  it('reads an attachment that was kept as a file, where it is found', async () => {
    const outside = dir('kept-as-file');
    const pathAttachment: PwAttachment = {
      name: 'qa-metrics.json',
      contentType: 'application/json',
      path: `${HOME_ROOT}/test-results/some-test/qa-metrics.json`,
    };
    mkdirSync(join(outside, 'test-results', 'some-test'), { recursive: true });
    writeFileSync(
      join(outside, 'test-results', 'some-test', 'qa-metrics.json'),
      JSON.stringify(metrics({ state: 'error' })),
    );
    const test: TestFixture = {
      title: 'PB-VOD-001 starts',
      attempts: [{ status: 'failed', message: 'Error: boom', attachments: [pathAttachment] }],
    };
    expect(reduceReport(report([test], options), { roots: [outside] }).kept.attachments).toBe(1);
    expect(reduceReport(report([test], options)).kept.attachments).toBe(0);
  });

  it('keeps the error of the run, the one a failed global setup leaves with no test to blame', () => {
    const reduction = reduceReport(
      report([], {
        ...options,
        errors: [
          {
            message: 'Error: the service did not answer',
            stack: `Error: the service did not answer\n    at ${HOME_ROOT}/tests/e2e/support/global-setup.ts:40:9`,
          },
        ],
      }),
    );
    const collected = readReport(reduction.report as never, { from: scratch, source: 'playwright.json' });
    expect(collected.failures).toHaveLength(1);
    expect(collected.failures[0]).toMatchObject({
      scope: 'run',
      error: { message: 'Error: the service did not answer' },
    });
    expect(JSON.stringify(reduction.report)).toContain(
      `${DEFAULT_WORKSPACE}/tests/e2e/support/global-setup.ts`,
    );
  });
});

describe('PB-LAB-005 triage fixtures: the clusters do not change', () => {
  it('collects from the written fixture the same failures, signatures and categories as from the report it came from', async () => {
    const tests: TestFixture[] = [
      passed('PB-VOD-001 starts'),
      await failedTest(),
      await failedTest({ project: 'chromium' }),
      await failedTest({ title: 'PB-REC-003 loses a rung', line: 200, project: 'webkit' }, [
        requestEntry(1, { status: 503 }),
      ]),
      {
        title: 'PB-VOD-005 seeks',
        file: 'e2e/vod-seek.spec.ts',
        project: 'chromium',
        attempts: [
          {
            status: 'timedOut',
            message: "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).",
          },
        ],
      },
    ];
    const original = readReport(report(tests, options), { from: scratch, source: 'reports/playwright.json' });
    const out = dir('roundtrip');
    await writeFixture(reduceReport(report(tests, options)), out);
    const rebuilt = collect(out);

    expect(rebuilt.problems).toStrictEqual([]);
    expect(original.failures).toHaveLength(4);
    expect(rebuilt.failures).toHaveLength(4);
    expect(rebuilt.failures.map((one) => [one.id, one.project, one.outcome])).toStrictEqual(
      original.failures.map((one) => [one.id, one.project, one.outcome]),
    );
    expect(signatures(cluster(rebuilt.failures))).toStrictEqual(signatures(cluster(original.failures)));
    for (const failure of rebuilt.failures.filter((one) => one.id !== 'PB-VOD-005')) {
      expect(failure.diagnostics.attached).toContain('request-log.json');
      expect(failure.missing).toStrictEqual([]);
    }
  });

  it('shortens a long request log around what failed, and the digest still names the failed requests', async () => {
    const log = Array.from({ length: 300 }, (_, index) => requestEntry(index + 1));
    log[150] = requestEntry(151, { status: 503 });
    log[151] = requestEntry(152, { status: 503, faults: ['f1'] });
    const test = await failedTest({}, log);
    const reduction = reduceReport(report([test], options), { maxAttachmentBytes: 6000 });
    const note = reduction.notes.find((line) => line.includes('request-log.json'));
    expect(note).toMatch(/request-log\.json shortened from 300 to \d+ entries/);
    const kept = JSON.parse(
      Object.entries(reduction.files).find(([path]) => path.endsWith('request-log.json'))![1],
    ) as Array<{ seq: number }>;
    expect(kept.length).toBeLessThan(60);
    expect(kept.map((entry) => entry.seq)).toStrictEqual(expect.arrayContaining([1, 151, 152, 300]));
    const rebuiltOut = dir('shortened');
    await writeFixture(reduction, rebuiltOut);
    const failure = collect(rebuiltOut).failures[0]!;
    expect(failure.diagnostics.requestLog?.originFailures).toBe(2);
    expect(failure.diagnostics.requestLog?.failed.map((one) => one.seq)).toStrictEqual([151, 152]);
  });

  it('does not shorten what is small', async () => {
    const reduction = reduceReport(report([await failedTest()], options));
    expect(reduction.notes).toStrictEqual([]);
  });
});

describe('PB-LAB-005 triage fixtures: nothing of the machine, nothing secret', () => {
  it('writes the checkout as the workspace, and the rest of a home directory as <home>', async () => {
    const reduction = reduceReport(
      report(
        [
          await failedTest({
            attempts: [
              {
                status: 'failed',
                message: `${MESSAGE}\nsee /Users/someone/Downloads/x.log`,
                stack: stackOf(MESSAGE, [frame('waitForFault', 'tests/e2e/rec/faults.ts', 55)]),
              },
            ],
          }),
        ],
        options,
      ),
    );
    const json = JSON.stringify(reduction.report);
    expect(json).not.toContain('/Users/someone');
    expect(json).toContain(`${DEFAULT_WORKSPACE}/tests/e2e/rec/faults.ts:55:9`);
    expect(json).toContain('<home>/Downloads/x.log');
    expect((reduction.report as { config: { rootDir: string } }).config.rootDir).toBe(
      `${DEFAULT_WORKSPACE}/tests`,
    );
    for (const content of Object.values(reduction.files)) expect(content).not.toContain('/Users/someone');
  });

  it('leaves the lab’s own addresses and paths alone: they are the evidence', async () => {
    const message = 'Error: connect ECONNREFUSED 127.0.0.1:4750 (http://localhost:4750/health?x=1)';
    const reduction = reduceReport(
      report([{ title: 'PB-ENV-001 environment', attempts: [{ status: 'failed', message }] }], options),
    );
    expect(JSON.stringify(reduction.report)).toContain(
      'connect ECONNREFUSED 127.0.0.1:4750 (http://localhost:4750/health?x=1)',
    );
  });

  it('takes a secret out of a message and a document instead of copying it', async () => {
    const token = SECRETS['jwt'] as string;
    const reduction = reduceReport(
      report(
        [
          {
            title: 'PB-VOD-001 starts',
            attempts: [
              {
                status: 'failed',
                message: `Error: the service answered ${token} to the request`,
                attachments: await diagnosticAttachments({
                  console: [{ type: 'error', text: `sent ${token}` }],
                }),
              },
            ],
          },
        ],
        options,
      ),
    );
    expect(JSON.stringify(reduction.report)).not.toContain(token);
    expect(JSON.stringify(reduction.report)).toContain('the service answered <jwt> to the request');
    for (const content of Object.values(reduction.files)) expect(content).not.toContain(token);
    expect(Object.values(reduction.files).join('')).toContain('sent <jwt>');
  });

  it('checks what the scrub left: a secret or a personal path still in the text stops the fixture', () => {
    expect(() => assertClean('x.json', `sent ${SECRETS['anthropic-api-key']}`)).toThrow(
      /x\.json: still matches the secret pattern "anthropic-api-key" after the scrub/,
    );
    expect(() => assertClean('x.json', 'at /Users/someone/work/a.ts')).toThrow(
      /still holds a personal path \(\/Users\/someone\)/,
    );
    expect(() => assertClean('x.json', 'at C:\\Users\\someone\\a.ts')).toThrow(/personal path/);
    expect(() => assertClean('x.json', 'at /home/someone/a.ts')).toThrow(/personal path/);
    expect(() =>
      assertClean('x.json', 'at /work/playback-proof/tests/a.ts and 127.0.0.1:4750'),
    ).not.toThrow();
  });

  it('refuses something that is not a report', () => {
    expect(() => reduceReport({ hello: 'world' })).toThrow(FixtureError);
  });
});

describe('PB-LAB-005 triage fixtures: the files and the command', () => {
  it('writes JSON the way the repository formats it, and refuses a directory that is not empty unless forced', async () => {
    const out = dir('written');
    const reduction = reduceReport(report([await failedTest()], options));
    const written = await writeFixture(reduction, out);
    expect(written[0]).toBe('playwright.json');
    for (const name of written) {
      const content = readFileSync(join(out, name), 'utf8');
      const config = (await resolveConfig(join(out, name))) ?? {};
      expect(content).toBe(await format(content, { ...config, parser: 'json' }));
    }
    await expect(writeFixture(reduction, out)).rejects.toThrow(/is not empty/);
    writeFileSync(join(out, 'stale.json'), '{}');
    await writeFixture(reduction, out, { force: true });
    expect(existsSync(join(out, 'stale.json'))).toBe(false);
  });

  it('is a command: prints what it kept and what it cut, exits 1 when a fixture is refused and 2 on a bad call', async () => {
    const from = join(dir('command'), 'playwright.json');
    mkdirSync(dirname(from), { recursive: true });
    const log = Array.from({ length: 200 }, (_, index) => requestEntry(index + 1));
    writeFileSync(from, JSON.stringify(report([await failedTest({}, log)], options)));
    const out = join(dirname(from), 'out');
    const call = async (...argv: string[]) => {
      const io = { out: '', err: '' };
      const code = await main(argv, {
        stdout: (text) => (io.out += text),
        stderr: (text) => (io.err += text),
      });
      return { code, ...io };
    };

    const done = await call('--from', from, '--out', out, '--max-attachment-bytes', '4000');
    expect(done.code).toBe(0);
    expect(done.out).toMatch(
      /1 failed, 0 flaky, 0 skipped kept \(0 passed left out\), 6 attachments, 7 files/,
    );
    expect(done.out).toMatch(/request-log\.json shortened from 200 to \d+ entries/);
    expect(collect(out).failures).toHaveLength(1);

    expect((await call('--from', from)).code).toBe(2);
    const again = await call('--from', from, '--out', out);
    expect([again.code, again.err]).toStrictEqual([1, expect.stringContaining('is not empty')]);
    expect((await call('--from', from, '--out', out, '--max-attachment-bytes', 'lots')).code).toBe(2);
    expect((await call('--nonsense')).code).toBe(2);
    expect((await call('--help')).out).toContain('usage: tsx tools/triage-fixture.ts');
    const missing = await call(
      '--from',
      join(dirname(from), 'nowhere.json'),
      '--out',
      join(dirname(from), 'o2'),
    );
    expect(missing.code).toBe(2);
  });
});
