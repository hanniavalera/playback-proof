import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONReport } from '@playwright/test/reporter';
import { afterAll, describe, expect, it } from 'vitest';
import { main, renderSummary, summarize } from '../../../tools/ci-summary.ts';
import type { RenderOptions, SummaryIo } from '../../../tools/ci-summary.ts';
import { makeScratch } from '../support/scratch.ts';

// tools/ci-summary.ts turns the Playwright JSON report of a browser job into the Markdown of the job's summary page. The reports
// below have the shape of a real one (a run of PB-VOD-001 with a 1.5 s timeout in Chromium, with its retry), cut down to what the tool reads.

const scratch = makeScratch('unit-ci-summary-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Annotation = { type: string; description?: string };
interface Attempt {
  status: string;
  error?: string;
  attachments?: string[];
  annotations?: Annotation[];
}
interface TestSpec {
  title: string;
  project?: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  attempts: Attempt[];
  annotations?: Annotation[];
}

function reportOf(
  tests: TestSpec[],
  extra: { errors?: string[]; durationMs?: number; nested?: boolean } = {},
): JSONReport {
  const specs = tests.map((t) => ({
    title: t.title,
    ok: t.status === 'expected',
    tags: ['merge'],
    id: t.title,
    file: 'e2e/vod-start.spec.ts',
    line: 1,
    column: 1,
    tests: [
      {
        timeout: 45_000,
        annotations: t.annotations ?? [],
        expectedStatus: 'passed',
        projectId: t.project ?? 'chromium',
        projectName: t.project ?? 'chromium',
        status: t.status,
        results: t.attempts.map((a, retry) => ({
          workerIndex: 0,
          parallelIndex: 0,
          status: a.status,
          duration: 1000,
          retry,
          startTime: '2026-11-04T04:36:26.781Z',
          errors: [],
          stdout: [],
          stderr: [],
          annotations: a.annotations ?? [],
          attachments: (a.attachments ?? []).map((name) => ({ name, contentType: 'application/json' })),
          ...(a.error === undefined ? {} : { error: { message: a.error } }),
        })),
      },
    ],
  }));
  const file = { title: 'e2e/vod-start.spec.ts', file: 'e2e/vod-start.spec.ts', line: 0, column: 0 };
  const suites = extra.nested ? [{ ...file, specs: [], suites: [{ ...file, specs }] }] : [{ ...file, specs }];
  // The config of a real report is the whole Playwright configuration: the summary does not read it.
  return {
    config: {},
    suites,
    errors: (extra.errors ?? []).map((message) => ({ message })),
    stats: {
      startTime: '2026-11-04T04:36:26.781Z',
      duration: extra.durationMs ?? 8_500,
      expected: 0,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
  } as unknown as JSONReport;
}

const render = (report: JSONReport, options: Partial<RenderOptions> = {}): string =>
  renderSummary(summarize(report), { title: 'merge-gate (chromium)', ...options });

const passing = (title: string, annotations: Annotation[] = []): TestSpec => ({
  title,
  status: 'expected',
  attempts: [{ status: 'passed' }],
  annotations,
});

describe('a green run', () => {
  const report = reportOf(
    [
      passing('PB-ENV-001 the engine plays', [
        {
          type: 'environment',
          description:
            'gha-linux-x64: chromium 156.0.8078.4; evidence: docs/results/codec-matrix/gha-linux-x64.json',
        },
      ]),
      passing('PB-VOD-001 DASH VOD starts'),
      passing('PB-VOD-002 HLS VOD starts'),
    ],
    { durationMs: 8_506 },
  );

  it('is one line of counts, the project and the environment the run said it was in, and no tables', () => {
    const markdown = render(report);
    expect(markdown).toContain('### merge-gate (chromium)');
    expect(markdown).toContain('0 failed, 0 flaky, 3 passed, 0 skipped in 8.5 s, project `chromium`.');
    expect(markdown).toContain(
      'Environment: `gha-linux-x64: chromium 156.0.8078.4; evidence: docs/results/codec-matrix/gha-linux-x64.json`',
    );
    expect(markdown).not.toContain('####');
    expect(markdown).not.toContain('**');
  });

  it('finds the tests of nested suites (test.describe) too', () => {
    expect(summarize(reportOf([passing('PB-VOD-001 DASH VOD starts')], { nested: true })).passed).toBe(1);
  });
});

describe('a failed test', () => {
  const failing: TestSpec = {
    title: 'PB-VOD-001 DASH VOD starts',
    status: 'unexpected',
    attempts: [
      {
        status: 'timedOut',
        error:
          '\u001b[31mTest timeout of 1500ms exceeded.\u001b[39m\n\n    Error: Test timeout of 1500ms exceeded.\n\n      19 | ): Promise<void> {',
        attachments: ['screenshot', 'qa-events.json', 'qa-metrics.json', 'trace'],
      },
      {
        status: 'timedOut',
        error: '\u001b[31mTest timeout of 1500ms exceeded.\u001b[39m',
        attachments: ['screenshot', 'qa-events.json', 'qa-metrics.json', 'request-log.json', 'trace'],
      },
    ],
  };

  it('is a row with its attempts, the first line of the last error without colour, and each attachment once', () => {
    const summary = summarize(reportOf([failing, passing('PB-VOD-002 HLS VOD starts')]));
    expect(summary.passed).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({
      title: 'PB-VOD-001 DASH VOD starts',
      attempts: 2,
      outcome: 'timedOut',
      error: 'Test timeout of 1500ms exceeded.',
      attachments: ['screenshot', 'qa-events.json', 'qa-metrics.json', 'trace', 'request-log.json'],
    });
  });

  it('is bold in the counts and listed under Failed, with the artifact that holds the evidence', () => {
    const markdown = render(reportOf([failing]), { artifact: 'reports-chromium' });
    expect(markdown).toContain('**1 failed**, 0 flaky, 0 passed, 0 skipped');
    expect(markdown).toContain('#### Failed (1)');
    expect(markdown).toContain(
      '| PB-VOD-001 DASH VOD starts | chromium | 2 | timedOut | Test timeout of 1500ms exceeded. | `screenshot` `qa-events.json` `qa-metrics.json` `trace` `request-log.json` |',
    );
    expect(markdown).toContain('Artifact `reports-chromium`');
  });

  it('keeps a message that would break the table or be taken for HTML in one cell', () => {
    const hostile: TestSpec = {
      title: 'PB-VOD-001 a | b',
      status: 'unexpected',
      attempts: [{ status: 'failed', error: 'expected <video> to have `paused` | got\nnothing' }],
    };
    const row =
      render(reportOf([hostile]))
        .split('\n')
        .find((line) => line.startsWith('| PB-VOD-001')) ?? '';
    expect(row).toContain('PB-VOD-001 a \\| b');
    expect(row).toContain("expected &lt;video&gt; to have 'paused' \\| got");
    expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
  });
});

describe('a flaky test', () => {
  it('is counted apart from the passes and listed with its two attempts', () => {
    const flaky: TestSpec = {
      title: 'PB-VOD-002 HLS VOD starts',
      status: 'flaky',
      attempts: [
        { status: 'failed', error: 'first frame did not come', attachments: ['qa-events.json'] },
        { status: 'passed' },
      ],
    };
    const markdown = render(reportOf([flaky, passing('PB-VOD-001 DASH VOD starts')]));
    expect(markdown).toContain('**1 flaky**');
    expect(markdown).toContain('0 failed');
    expect(markdown).toContain('1 passed');
    expect(markdown).toContain('#### Flaky (1)');
    expect(markdown).toContain('| PB-VOD-002 HLS VOD starts | chromium | 2 | passed |');
    expect(markdown).not.toContain('#### Failed');
  });
});

describe('a skipped test', () => {
  const skipped = (annotations: Annotation[]): TestSpec => ({
    title: 'PB-VOD-003 WebM VOD starts',
    project: 'firefox',
    status: 'skipped',
    attempts: [{ status: 'skipped' }],
    annotations,
  });

  it('shows the reason of the documented gap', () => {
    const markdown = render(
      reportOf([
        skipped([
          { type: 'skip', description: 'documented gap in local-darwin-arm64: firefox did not start' },
        ]),
      ]),
    );
    expect(markdown).toContain('#### Skipped (1)');
    expect(markdown).toContain(
      '| PB-VOD-003 WebM VOD starts | firefox | documented gap in local-darwin-arm64: firefox did not start |',
    );
  });

  it('says so when a skip has no reason, because a silent skip is a bug', () => {
    expect(render(reportOf([skipped([])]))).toContain(
      '| PB-VOD-003 WebM VOD starts | firefox | **no reason recorded** |',
    );
  });

  it('blames the run, not the test, when the run stopped before the test could start (the global timeout)', () => {
    const markdown = render(
      reportOf([skipped([])], { errors: ['Timed out waiting 660s for the test suite to run'] }),
    );
    expect(markdown).toContain('- Timed out waiting 660s for the test suite to run');
    expect(markdown).toContain(
      '| PB-VOD-003 WebM VOD starts | firefox | did not run: the run stopped (see the errors above) |',
    );
    expect(markdown).not.toContain('no reason recorded');
  });
});

describe('what the run says about itself', () => {
  it('names the experimental engine and an evidence drift', () => {
    const markdown = render(
      reportOf([
        passing('PB-ENV-001 the engine plays', [
          {
            type: 'experimental-engine',
            description: 'Linux WebKit runs the specs although the probe is intermittent.',
          },
          { type: 'evidence-drift', description: 'the matrix was probed on webkit 27.1, this is 27.2' },
        ]),
      ]),
    );
    expect(markdown).toContain(
      'Experimental engine: Linux WebKit runs the specs although the probe is intermittent.',
    );
    expect(markdown).toContain('Evidence drift: the matrix was probed on webkit 27.1, this is 27.2');
  });

  it('shows an error outside any test (a global setup that threw) and does not claim that no test ran silently', () => {
    const markdown = render(
      reportOf([], {
        errors: [
          'the test data service at http://127.0.0.1:4600 cannot serve the specs: run `npm run generate:streams`\n    at globalSetup',
        ],
      }),
    );
    expect(markdown).toContain('**Errors outside any test**');
    expect(markdown).toContain(
      "- the test data service at http://127.0.0.1:4600 cannot serve the specs: run 'npm run generate:streams'",
    );
    expect(markdown).not.toContain('No test ran');
  });

  it('says that no test ran when the report has none and no error', () => {
    expect(render(reportOf([]))).toContain('No test ran: the report has no tests.');
  });
});

describe('the command', () => {
  function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: SummaryIo = { out: (text) => void out.push(text), err: (line) => void err.push(line) };
    return { status: main(argv, env, io), out: out.join(''), err };
  }

  const failingReport = reportOf([
    {
      title: 'PB-VOD-001 DASH VOD starts',
      status: 'unexpected',
      attempts: [{ status: 'failed', error: 'no first frame' }],
    },
  ]);

  it('prints the summary when there is no summary page, and exits 0 although the report is red', () => {
    const path = join(scratch, 'red.json');
    writeFileSync(path, JSON.stringify(failingReport));
    const result = run(['--report', path, '--title', 'merge-gate (firefox)']);
    expect(result.status).toBe(0);
    expect(result.out).toContain('### merge-gate (firefox)');
    expect(result.out).toContain('**1 failed**');
  });

  it('appends to the summary page when the runner gives one, and keeps what an earlier step wrote', () => {
    const report = join(scratch, 'red-2.json');
    const page = join(scratch, 'step-summary.md');
    writeFileSync(report, JSON.stringify(failingReport));
    writeFileSync(page, 'an earlier step\n');
    const result = run(['--report', report], { GITHUB_STEP_SUMMARY: page });
    expect(result.status).toBe(0);
    expect(result.out).toBe(`summary written to ${page}\n`);
    const text = readFileSync(page, 'utf8');
    expect(text.startsWith('an earlier step\n')).toBe(true);
    expect(text).toContain('#### Failed (1)');
  });

  it('says that the job stopped before a report existed, and that an unreadable report cannot be read, instead of failing the step', () => {
    const missing = run([
      '--report',
      join(scratch, 'nope', 'playwright.json'),
      '--title',
      'merge-gate (webkit-macos)',
    ]);
    expect(missing.status).toBe(0);
    expect(missing.out).toContain('### merge-gate (webkit-macos)');
    expect(missing.out).toContain('the job stopped before Playwright wrote one');

    mkdirSync(join(scratch, 'torn'), { recursive: true });
    const torn = join(scratch, 'torn', 'playwright.json');
    writeFileSync(torn, '{"suites": [');
    const unreadable = run(['--report', torn]);
    expect(unreadable.status).toBe(0);
    expect(unreadable.out).toContain('cannot be read');
  });

  it('refuses a flag it does not know, with the usage', () => {
    const result = run(['--reprot', 'x']);
    expect(result.status).toBe(2);
    expect(result.err.join('\n')).toContain('usage: tsx tools/ci-summary.ts');
    expect(result.out).toBe('');
  });
});
