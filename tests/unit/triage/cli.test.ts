import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMock } from '../../../tools/triage-mock.ts';
import type { MockServer } from '../../../tools/triage-mock.ts';
import { parseArgs, resolveFrom, run, USAGE } from '../../../triage/cli.ts';
import type { CliOptions, Io } from '../../../triage/cli.ts';
import type { TriageReport } from '../../../triage/types.ts';
import { makeScratch } from '../support/scratch.ts';
import { FAKE_API_KEY } from './secrets.ts';
import {
  diagnosticAttachments,
  event,
  metrics,
  report,
  requestEntry,
  sessionDetail,
  shakaError,
} from './support.ts';
import type { TestFixture } from './support.ts';

let scratch: string;
let counter = 0;
let mock: MockServer;

beforeAll(() => {
  scratch = makeScratch('triage-cli-');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  mock = await startMock();
});
afterEach(async () => {
  await mock.close();
});

/** A working directory of its own, so that `reports/triage` and `.cache/triage` of one test are not those of another. */
function workspace(): string {
  counter += 1;
  const dir = join(scratch, `ws-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function write(cwd: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), typeof value === 'string' ? value : JSON.stringify(value));
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  cwd: string;
}
async function triage(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  extra: Partial<Io> = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await run(args, {
    cwd,
    env,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    now: () => new Date('2026-11-04T06:00:00.000Z'),
    ...extra,
  });
  return { code, stdout, stderr, cwd };
}
const readJson = (cwd: string, path = 'reports/triage/triage-report.json'): TriageReport =>
  JSON.parse(readFileSync(join(cwd, path), 'utf8')) as TriageReport;

const refused = (project: string): TestFixture => ({
  title: 'PB-VOD-002 plays HLS',
  project,
  attempts: [
    { status: 'failed', message: 'Error: HLS media playlists requested (request log)' },
    { status: 'failed', message: 'Error: HLS media playlists requested (request log)' },
  ],
});

async function redBuild(cwd: string): Promise<void> {
  const ended = shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, 'HTTP error status 503');
  const attachments = await diagnosticAttachments({
    events: [event(0, 'load-requested'), event(1, 'error', ended)],
    metrics: metrics({ state: 'error', errors: [ended] }),
    detail: sessionDetail([{ id: 'f1', type: 'status', status: 503 }]),
    log: [requestEntry(1), requestEntry(2, { status: 503, faults: ['f1'] })],
  });
  const message = 'Error: player state (metrics.state) after every rung was refused';
  for (const project of ['chromium', 'firefox', 'webkit']) {
    write(
      cwd,
      `artifacts/reports-${project}/playwright.json`,
      report([
        refused(project),
        {
          title: 'PB-REC-002 recovers',
          project,
          attempts: [
            { status: 'failed', message, attachments },
            { status: 'failed', message, attachments },
          ],
        },
        { title: 'PB-VOD-001 starts', project, attempts: [{ status: 'passed' }] },
      ]),
    );
  }
}

describe('PB-LAB-005 triage CLI: reading a run and printing its clusters', () => {
  it('prints "no failures to triage" for a green run, and still writes the report files', async () => {
    const cwd = workspace();
    write(
      cwd,
      'reports/playwright.json',
      report([{ title: 'PB-VOD-001 starts', attempts: [{ status: 'passed' }] }]),
    );
    const out = await triage(cwd, []);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('no failures to triage');
    expect(out.stdout).toContain('read 1 report: 1 test');
    expect(out.stdout).toContain(
      'wrote reports/triage/triage-report.md and reports/triage/triage-report.json',
    );
    expect(readJson(cwd)).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-11-04T06:00:00.000Z',
      totals: { clusters: 0 },
    });
    expect(readFileSync(join(cwd, 'reports/triage/triage-report.md'), 'utf8')).toContain(
      '**no failures to triage.**',
    );
  });

  it('clusters the failures of the legs of a downloaded run: rank, size, engines, tests, category, rule, signature, error, first check', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const out = await triage(cwd, ['--from', 'artifacts']);
    expect(out.code).toBe(0);
    const text = out.stdout;
    expect(text).toContain(
      'failure triage: 6 failed in 3 reports became 2 clusters (clustering is deterministic: no model is involved in it)',
    );
    // Two clusters of 3 failures in 3 engines: the tie is broken by the signature (code units), so "HLS" comes before "player".
    expect(text).toMatch(/#1 {2}3 failures in chromium, firefox, webkit {2}· {2}PB-VOD-002/);
    expect(text).toContain('category  unknown  (rule no-rule-matched)  ·  class Needs a person');
    expect(text).toMatch(/#2 {2}3 failures in chromium, firefox, webkit {2}· {2}PB-REC-002/);
    expect(text).toContain(
      'category  network-fault-not-recovered  (rule fault-fired-player-failed)  ·  class Functional regression',
    );
    expect(text).toContain(
      'signature Error: player state (metrics.state) after every rung was refused [thrown] {shaka 1001}',
    );
    expect(text).toContain('evidence  fault f1 (status 503) fired on 1 request');
    expect(text).toContain('first     In request-log.json, the first request the fault hit');
    const written = readJson(cwd);
    expect(written.clusters.map((c) => [c.rank, c.size, c.category])).toStrictEqual([
      [1, 3, 'unknown'],
      [2, 3, 'network-fault-not-recovered'],
    ]);
    expect(written.sources.map((s) => s.path)).toStrictEqual([
      join('reports-chromium', 'playwright.json'),
      join('reports-firefox', 'playwright.json'),
      join('reports-webkit', 'playwright.json'),
    ]);
  });

  it('prints the JSON instead of the text with --json, and writes to --out', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const out = await triage(cwd, ['--from', 'artifacts', '--json', '--out', 'somewhere/else']);
    expect(JSON.parse(out.stdout)).toMatchObject({ schemaVersion: 1, totals: { failures: 6, clusters: 2 } });
    expect(readJson(cwd, 'somewhere/else/triage-report.json').totals.clusters).toBe(2);
  });

  it('exits 0 when there is nothing to read, and says what; 2 only when an option is wrong', async () => {
    const cwd = workspace();
    const missing = await triage(cwd, ['--from', 'nowhere']);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain('no failures to triage');
    expect(missing.stdout).toContain('problem: nowhere: does not exist');
    const bad = await triage(cwd, ['--nonsense']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('triage: unknown option --nonsense');
    expect(bad.stderr).toContain(USAGE);
    expect((await triage(cwd, ['--max-clusters', '0'])).code).toBe(2);
    expect((await triage(cwd, ['--from'])).code).toBe(2);
    expect((await triage(cwd, ['--help'])).stdout).toContain('--from-ci');
    expect(USAGE).toContain('exit code: 0 whatever it finds and whatever it cannot read');
  });
});

describe('PB-LAB-005 triage CLI: --from-ci is a stage that explains, and never fails the build', () => {
  it('reads the artifacts of the run, says it is not a gate, and exits 0 on a red build', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const out = await triage(cwd, ['--from-ci']);
    expect(out.code).toBe(0);
    expect(out.stdout.split('\n')[0]).toBe(
      'gate:triage: triage is not a gate: it explains a red build and never decides one (exit 0 whatever it finds)',
    );
    expect(out.stdout).toContain('#1  3 failures');
  });

  it('prefers the directory the pipeline names, then ./artifacts, then ./reports', async () => {
    const io = (cwd: string, env: NodeJS.ProcessEnv = {}) => ({ cwd, env });
    const options = (from: string | null): CliOptions => ({
      ...(parseArgs(['--from-ci']) as { options: CliOptions }).options,
      from,
    });
    const cwd = workspace();
    mkdirSync(join(cwd, 'reports'));
    expect(resolveFrom(options(null), io(cwd)).shown).toBe('reports');
    mkdirSync(join(cwd, 'artifacts'));
    expect(resolveFrom(options(null), io(cwd)).shown).toBe('artifacts');
    mkdirSync(join(cwd, 'downloaded'));
    expect(resolveFrom(options(null), io(cwd, { PB_TRIAGE_FROM: 'downloaded' })).shown).toBe('downloaded');
    expect(resolveFrom(options(null), io(cwd, { PB_TRIAGE_FROM: 'missing' })).shown).toBe('artifacts');
    expect(resolveFrom(options('explicit'), io(cwd, { PB_TRIAGE_FROM: 'downloaded' })).shown).toBe(
      'explicit',
    );
    expect(resolveFrom({ ...options(null), fromCi: false }, io(cwd)).shown).toBe('reports');
    expect(resolveFrom(options(null), io(workspace())).shown).toBe('reports');
  });

  it('exits 0 with nothing to read and with an error of its own, and says so; a bad command line is the only 2, in CI too', async () => {
    const cwd = workspace();
    const nothing = await triage(cwd, ['--from-ci']);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain('no failures to triage');
    expect(nothing.stdout).toContain('problem: reports: does not exist');

    // A report that is cut off (a job that was killed while it wrote) is named, and is not a reason to fail.
    write(cwd, 'reports/chromium/playwright.json', '{"config": {"rootDir": "/work/tests"}, "suites": [');
    const cut = await triage(cwd, ['--from-ci']);
    expect(cut.code).toBe(0);
    expect(cut.stdout).toContain('no failures to triage');
    expect(cut.stdout).toMatch(/problem: chromium\/playwright\.json: could not be read/);

    const bad = await triage(cwd, ['--from-ci', '--nonsense']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown option --nonsense');

    const clockBroke = {
      now: () => {
        throw new Error('the clock broke');
      },
    };
    for (const argv of [['--from-ci'], []]) {
      const broken = await triage(cwd, argv, {}, clockBroke);
      expect(broken.code, argv.join(' ')).toBe(0);
      expect(broken.stderr).toBe(
        'triage could not run: the clock broke (triage is not a gate: it explains a red build and never decides one: nothing is failed by it)\n',
      );
    }
  });

  it('appends its summary to the job summary of GitHub Actions when there is one', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const file = join(cwd, 'step-summary.md');
    writeFileSync(file, '## an earlier step\n');
    await triage(cwd, ['--from-ci'], { GITHUB_STEP_SUMMARY: file });
    const summary = readFileSync(file, 'utf8');
    expect(summary.startsWith('## an earlier step\n')).toBe(true);
    expect(summary).toContain('### Failure triage');
    expect(summary).toContain(
      '| 2 | 3 | chromium, firefox, webkit | `network-fault-not-recovered` · `fault-fired-player-failed` | Functional regression |',
    );
    expect(summary).toContain('triage is not a gate');
    // A summary file that cannot be written is said on stderr and does not change the exit code.
    const blocked = await triage(cwd, ['--from-ci'], {
      GITHUB_STEP_SUMMARY: join(cwd, 'no', 'such', 'dir', 'summary.md'),
    });
    expect(blocked.code).toBe(0);
    expect(blocked.stderr).toContain('could not append to the job summary');
  });
});

describe('PB-LAB-005 triage CLI: --summarize', () => {
  it('says once that there is no key, sends nothing, and still prints the clusters', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const out = await triage(cwd, ['--from', 'artifacts', '--summarize'], {
      ANTHROPIC_BASE_URL: mock.origin,
    });
    expect(out.code).toBe(0);
    expect(mock.requests).toHaveLength(0);
    expect(
      out.stdout.split('\n').filter((line) => line === 'summaries skipped: ANTHROPIC_API_KEY is not set'),
    ).toHaveLength(1);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('#1  3 failures');
    expect(readJson(cwd)).toMatchObject({
      summaries: [],
      summaryNote: 'summaries skipped: ANTHROPIC_API_KEY is not set',
      summaryRun: null,
    });
  });

  it('with a key asks the endpoint of ANTHROPIC_BASE_URL, labels the drafts as not from the live service, and keeps the key out of everything', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const env = { ANTHROPIC_API_KEY: FAKE_API_KEY, ANTHROPIC_BASE_URL: mock.origin };
    const out = await triage(cwd, ['--from', 'artifacts', '--summarize'], env, {
      summarizer: { sleep: () => Promise.resolve() },
    });
    expect(out.code).toBe(0);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.map((r) => r.problems)).toStrictEqual([[], []]);
    expect(out.stdout).toContain(
      `draft     [model draft (claude-haiku-5-5, endpoint ${mock.origin}, NOT the live service): a suggestion for a person, never a verdict]`,
    );
    expect(out.stdout).toContain('[MOCK] no model wrote this');

    const written = readJson(cwd);
    expect(written.summaryRun).toStrictEqual({
      model: 'claude-haiku-5-5',
      endpoint: mock.origin,
      requests: 2,
      cacheHits: 0,
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    });
    expect(written.summaries.map((s) => s.status)).toStrictEqual(['summarized', 'summarized']);
    const markdown = readFileSync(join(cwd, 'reports/triage/triage-report.md'), 'utf8');
    expect(markdown).toContain('NOT the live service');
    expect(markdown).toContain('(**not the live service**: a local test double)');
    for (const text of [out.stdout, out.stderr, markdown, JSON.stringify(written)])
      expect(text).not.toContain(FAKE_API_KEY);
  });

  it('costs nothing the second time: the drafts come from .cache/triage, and the report says so', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const env = { ANTHROPIC_API_KEY: FAKE_API_KEY, ANTHROPIC_BASE_URL: mock.origin };
    await triage(cwd, ['--from', 'artifacts', '--summarize'], env);
    expect(mock.requests).toHaveLength(2);
    const again = await triage(cwd, ['--from', 'artifacts', '--summarize'], env);
    expect(mock.requests).toHaveLength(2);
    expect(readJson(cwd).summaryRun).toMatchObject({ requests: 0, cacheHits: 2 });
    expect(again.stdout).toContain('from the cache');
    await triage(cwd, ['--from', 'artifacts', '--summarize', '--refresh'], env);
    expect(mock.requests).toHaveLength(4);
  });

  it('summarizes at most --max-clusters clusters, and notes the rest', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    const env = { ANTHROPIC_API_KEY: FAKE_API_KEY, ANTHROPIC_BASE_URL: mock.origin };
    const out = await triage(cwd, ['--from', 'artifacts', '--summarize', '--max-clusters', '1'], env);
    expect(mock.requests).toHaveLength(1);
    expect(out.stdout).toContain('summaries: 1 not summarized');
    expect(out.stdout).toContain('draft     (none: not summarized: the run is capped at 1 cluster)');
    expect((await triage(cwd, ['--max-clusters', '0'])).stderr).toContain(
      '--max-clusters needs a whole number of at least 1',
    );
  });

  it('records the errors of the service in the report and still exits 0 with the clusters intact', async () => {
    const cwd = workspace();
    await redBuild(cwd);
    mock.fallback = {
      kind: 'error',
      status: 401,
      type: 'authentication_error',
      message: 'invalid x-api-key',
    };
    const env = { ANTHROPIC_API_KEY: FAKE_API_KEY, ANTHROPIC_BASE_URL: mock.origin };
    const out = await triage(cwd, ['--from', 'artifacts', '--summarize'], env);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('draft     (none: HTTP 401 authentication_error: invalid x-api-key');
    expect(readJson(cwd).clusters).toHaveLength(2);
    expect(mock.requests).toHaveLength(1);
  });
});

describe('PB-LAB-005 triage CLI: --redact for a report that is published', () => {
  it('takes home directories, hosts and secrets out of the files and of the output', async () => {
    const cwd = workspace();
    const message = `Error: could not read /Users/hannia/repos/playback-proof/.cache/x.json from http://127.0.0.1:4731/player/?token=abc for me@example.com`;
    write(
      cwd,
      'reports/playwright.json',
      report([{ title: 'PB-VOD-001 starts', attempts: [{ status: 'failed', message }] }]),
    );
    const plain = await triage(cwd, ['--out', 'plain']);
    expect(plain.stdout).toContain('/Users/hannia');
    const redacted = await triage(cwd, ['--redact', '--out', 'redacted']);
    for (const text of [
      redacted.stdout,
      readFileSync(join(cwd, 'redacted/triage-report.md'), 'utf8'),
      readFileSync(join(cwd, 'redacted/triage-report.json'), 'utf8'),
    ]) {
      expect(text).not.toContain('hannia');
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('example.com');
      expect(text).toContain('<home>/repos/playback-proof/.cache/x.json');
    }
  });
});

describe('PB-LAB-005 triage CLI: the options', () => {
  it('parses them, with their defaults, and refuses what it does not know', () => {
    expect(parseArgs([])).toStrictEqual({
      options: {
        from: null,
        fromCi: false,
        summarize: false,
        refresh: false,
        maxClusters: 10,
        out: 'reports/triage',
        json: false,
        redact: false,
        help: false,
      },
    });
    expect(
      parseArgs([
        '--from',
        'a',
        '--out',
        'b',
        '--summarize',
        '--json',
        '--from-ci',
        '--refresh',
        '--redact',
        '--max-clusters',
        '3',
      ]),
    ).toStrictEqual({
      options: {
        from: 'a',
        fromCi: true,
        summarize: true,
        refresh: true,
        maxClusters: 3,
        out: 'b',
        json: true,
        redact: true,
        help: false,
      },
    });
    expect(parseArgs(['--from'])).toStrictEqual({ error: '--from needs a directory' });
    expect(parseArgs(['--out', '--json'])).toStrictEqual({ error: '--out needs a directory' });
    expect(parseArgs(['--max-clusters', 'many'])).toStrictEqual({
      error: '--max-clusters needs a whole number of at least 1',
    });
    expect(parseArgs(['-h'])).toMatchObject({ options: { help: true } });
  });
});
