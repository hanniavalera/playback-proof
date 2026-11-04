import { describe, expect, it } from 'vitest';
import { cluster } from '../../../triage/cluster.ts';
import {
  buildReport,
  messageHead,
  NO_FAILURES,
  renderJson,
  renderMarkdown,
  renderStepSummary,
  renderText,
} from '../../../triage/report.ts';
import { DEFAULT_BASE_URL } from '../../../triage/summarize.ts';
import type { Collection, Failure, SummaryRecord } from '../../../triage/types.ts';
import { diagnosticsOf, event, failure, requestEntry, sessionDetail, shakaError } from './support.ts';

const source = (path = 'reports/playwright.json') => ({
  path,
  tests: 10,
  passed: 6,
  failed: 2,
  flaky: 1,
  skipped: 1,
  notRun: 0,
  interrupted: 0,
  runErrors: 0,
  startTime: null,
  durationMs: null,
});

function collection(failures: Failure[], overrides: Partial<Collection> = {}): Collection {
  return { failures, skipped: [], sources: [source()], problems: [], ...overrides };
}
const NOW = new Date('2026-11-04T06:00:00.000Z');
const report = (
  failures: Failure[],
  overrides: Partial<Collection> = {},
  extra: Parameters<typeof buildReport>[2] = { from: 'reports', now: NOW },
) => buildReport(collection(failures, overrides), cluster(failures), extra);

const wait = "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).";

describe('PB-LAB-005 triage report: the numbers', () => {
  it('counts failed and timed out apart from flaky, and the clusters', () => {
    const r = report([
      failure({ outcome: 'failed', message: wait }),
      failure({ outcome: 'timedOut', project: 'webkit', message: wait }),
      failure({ outcome: 'flaky', id: 'PB-VOD-004', message: 'Error: other' }),
    ]);
    expect(r.totals).toStrictEqual({
      failures: 2,
      flaky: 1,
      clusters: 2,
      rootCauses: 2,
      skipped: 0,
      notRun: 0,
      interrupted: 0,
    });
    expect(r.schemaVersion).toBe(1);
    expect(r.generatedAt).toBe('2026-11-04T06:00:00.000Z');
    expect(JSON.parse(renderJson(r))).toMatchObject({ totals: { clusters: 2 } });
  });

  it('prefers the note it is given to the one of the summarizer, and has no summary run when none was asked', () => {
    const r = report(
      [failure({ message: wait })],
      {},
      { from: 'reports', now: NOW, summaryNote: 'summaries skipped: ANTHROPIC_API_KEY is not set' },
    );
    expect(r.summaryNote).toBe('summaries skipped: ANTHROPIC_API_KEY is not set');
    expect(r.summaryRun).toBeNull();
    expect(r.summaries).toStrictEqual([]);
  });
});

describe('PB-LAB-005 triage report: root causes behind several clusters', () => {
  // An origin that answered 503 to every segment: the start specs wait for the first frame, the recovery spec says its fault was never felt.
  const origin = (message: string, id: string, project: string) =>
    failure({
      id,
      project,
      message,
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested'), event(1, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 2))],
        detail: sessionDetail([]),
        log: [requestEntry(1), requestEntry(2, { status: 503 }), requestEntry(3, { status: 503 })],
        attached: ['qa-events.json', 'request-log.json'],
      }),
    });
  const failures = [
    origin(
      "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      'PB-VOD-001',
      'chromium',
    ),
    origin(
      "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      'PB-VOD-001',
      'webkit',
    ),
    origin(
      'Error: the fault rule f1 {"type":"status"} named 0 of the 1 request it was waited for within 15000 ms: the player never asked for what the rule matches',
      'PB-REC-001',
      'chromium',
    ),
    failure({
      id: 'PB-VOD-009',
      message: "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).",
    }),
  ];
  const shared = report(failures);

  it('counts them in the headline and the totals, and lists them in the report data', () => {
    expect(shared.totals).toMatchObject({ failures: 4, clusters: 3, rootCauses: 2 });
    expect(shared.rootCauses.map((c) => [c.size, c.clusterRanks, c.cause])).toStrictEqual([
      [3, [1, 3], 'the origin answered 503 on segment to requests no fault rule named'],
      [1, [2], null],
    ]);
    expect(shared.clusters.map((c) => c.rootCause)).toStrictEqual([
      shared.rootCauses[0]?.key,
      shared.rootCauses[1]?.key,
      shared.rootCauses[0]?.key,
    ]);
    expect(JSON.parse(renderJson(shared))).toMatchObject({ totals: { clusters: 3, rootCauses: 2 } });
    expect(renderMarkdown(shared)).toContain('**4 failed in 1 report became 3 clusters of 2 root causes.**');
    expect(renderStepSummary(shared)).toContain(
      '**4 failed in 1 report became 3 clusters of 2 root causes.**',
    );
  });

  it('says in the console which clusters are one cause, and on each of them which others share it', () => {
    const text = renderText(shared);
    expect(text).toContain(
      'root cause: the origin answered 503 on segment to requests no fault rule named (3 failures in the clusters #1, #3: one cause, worded differently by each test)',
    );
    expect(text).toMatch(/#1 {2}2 failures[^\n]*\n[^\n]*category[^\n]*\n {4}root cause shared with #3\n/);
    expect(text).toMatch(/#3 {2}1 failure[^\n]*\n[^\n]*category[^\n]*\n {4}root cause shared with #1\n/);
    // The cluster that is its own root cause says nothing about one.
    expect(text.split('#2 ')[1]?.split('#3 ')[0]).not.toContain('root cause shared');
  });

  it('has a table of the shared root causes in the markdown, and a line in each cluster that shares one', () => {
    const markdown = renderMarkdown(shared);
    expect(markdown).toContain('## Root causes shared by several clusters');
    expect(markdown).toContain(
      '| 1 | 3 | #1, #3 | chromium, webkit | PB-REC-001, PB-VOD-001 | `origin-error` · `origin-failed-without-fault` | the origin answered 503 on segment to requests no fault rule named |',
    );
    expect(markdown).toContain(
      '- **Root cause** shared with the clusters #3: the origin answered 503 on segment to requests no fault rule named',
    );
    expect(markdown).toContain(
      '- **Root cause** shared with the clusters #1: the origin answered 503 on segment to requests no fault rule named',
    );
    expect(markdown.match(/\*\*Root cause\*\*/g)).toHaveLength(2);
  });

  it('says nothing about root causes when every cluster is its own', () => {
    const alone = report([failure({ message: wait })]);
    expect(renderMarkdown(alone)).not.toContain('Root cause');
    expect(renderText(alone)).not.toContain('root cause');
    expect(renderMarkdown(alone)).toContain('became 1 cluster.**');
  });
});

describe('PB-LAB-005 triage report: the markdown', () => {
  it('has the table, a section per cluster with its evidence, rule, class and first check, and the reports read', () => {
    const md = renderMarkdown(
      report(
        [
          failure({ id: 'PB-VOD-006', project: 'chromium', message: wait }),
          failure({ id: 'PB-VOD-006', project: 'webkit', message: wait }),
          failure({
            id: 'PB-ABR-002',
            message: 'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 800 ms',
          }),
        ],
        { problems: ['reports/broken.json: could not be read (Unexpected end of JSON input)'] },
      ),
    );
    expect(md).toContain('# Failure triage');
    expect(md).toContain('**3 failed in 1 report became 2 clusters.**');
    expect(md).toContain('triage is not a gate: it explains a red build and never decides one');
    expect(md).toContain(
      '| 1 | 2 | chromium, webkit | PB-VOD-006 | `timeout-waiting-for-event` · `hook-wait-timed-out` | Functional regression |',
    );
    expect(md).toContain('## #1 · 2 failures · timeout-waiting-for-event');
    expect(md).toContain('- **Rule** `hook-wait-timed-out`:');
    expect(md).toContain('- **Class** Functional regression (TEST_STRATEGY.md section 10)');
    expect(md).toContain('  - waited 15000 ms for the seeked event and it did not come');
    expect(md).toContain('- **First thing to check** The timeline in qa-events.json');
    expect(md).toContain('| Test | Engine | Outcome | Report |');
    expect(md).toContain('## #2 · 1 failure · metric-regression');
    expect(md).toContain('## What could not be read');
    expect(md).toContain('- reports/broken.json: could not be read');
    expect(md).toContain('## Reports read');
    expect(md).toContain('| reports/playwright.json | 10 | 6 | 2 | 1 | 1 | 0 | 0 | 0 |');
    expect(md).toContain('No model summaries: they are opt-in');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('puts a message in a fence that nothing in it can close, and escapes what would break a table or inject markup', () => {
    const message = 'Error: a | b <script>alert(1)</script>\n```\nnot a fence\n```\nline `with` ticks';
    const md = renderMarkdown(report([failure({ message })]));
    expect(md).toContain('| 1 | 1 | chromium | PB-VOD-001 |');
    expect(md).toContain('Error: a \\| b &lt;script&gt;alert(1)&lt;/script&gt;');
    const block = md.split('\n').filter((line) => line.startsWith('````'));
    expect(block).toHaveLength(2);
    expect(block[0]).toBe('````text');
  });

  it('cuts a long message and says how many lines it left out', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `  #${i} t=1 media=0.000 playing`);
    const head = messageHead(cluster([failure({ message: `Error: x\n${lines.join('\n')}` })])[0]!);
    expect(head.split('\n')).toHaveLength(16);
    expect(head.endsWith('... (26 more lines)')).toBe(true);
    const wide = messageHead(cluster([failure({ message: `Error: ${'y'.repeat(900)}` })])[0]!);
    expect(wide.length).toBeLessThan(310);
  });

  it('says when the representative is not what every failure of the cluster shows', () => {
    const detail = { attached: ['qa-events.json'] };
    const md = renderMarkdown(
      report([
        failure({
          project: 'chromium',
          message: wait,
          diagnostics: {
            ...detail,
            requestLog: {
              entries: 3,
              segments: 2,
              manifests: 1,
              inits: 0,
              other: 0,
              originFailures: 2,
              originFailuresWithoutFault: 2,
              clientAborted: 0,
              pending: 0,
              byStatus: { '503': 2 },
              failed: [
                {
                  seq: 2,
                  kind: 'segment',
                  rep: 'v360',
                  number: 2,
                  status: 503,
                  abortReason: null,
                  faults: [],
                },
              ],
            },
            shakaErrors: [
              {
                code: 1001,
                codeName: 'BAD_HTTP_STATUS',
                category: 1,
                severity: 1,
                message: 'm',
                source: 'shaka',
              },
            ],
          },
        }),
        failure({ project: 'webkit', message: wait }),
      ]),
    );
    expect(md).toContain(
      'the rule fired for 1 of 2 failures of the cluster; the others fired `hook-wait-timed-out`',
    );
  });

  it('lists the skipped tests by reason, and calls a skip with none a bug', () => {
    const md = renderMarkdown(
      report([], {
        skipped: [
          {
            id: 'PB-VOD-001',
            project: 'firefox',
            reason: 'documented gap in local-darwin-arm64: firefox does not start',
            source: 'a',
          },
          {
            id: 'PB-VOD-002',
            project: 'firefox',
            reason: 'documented gap in local-darwin-arm64: firefox does not start',
            source: 'a',
          },
          { id: 'PB-VOD-003', project: 'webkit', reason: null, source: 'a' },
        ],
      }),
    );
    expect(md).toContain('## Skipped tests (not failures)');
    expect(md).toContain(
      '| 2 | firefox | PB-VOD-001, PB-VOD-002 | documented gap in local-darwin-arm64: firefox does not start |',
    );
    expect(md).toContain('| 1 | webkit | PB-VOD-003 | **no reason: a silent skip is a bug** |');
    expect(md).toContain('**no failures to triage.**');
  });

  it('has an interrupted line when the run was stopped', () => {
    const r = report([failure({ message: wait })], { sources: [{ ...source(), interrupted: 3 }] });
    expect(renderMarkdown(r)).toContain(
      '3 tests were interrupted (the run was stopped before they finished) and are not clustered.',
    );
    expect(renderText(r)).toContain('interrupted: 3 tests, which the run stopped on, not clustered');
  });

  it('says that tests with no attempt did not run, and that they are neither failures nor skips', () => {
    const listing = report([], { sources: [{ ...source(), tests: 66, passed: 0, skipped: 0, notRun: 66 }] });
    expect(listing.totals).toMatchObject({ failures: 0, skipped: 0, notRun: 66 });
    const markdown = renderMarkdown(listing);
    expect(markdown).toContain('66 tests did not run: they have no attempt at all');
    expect(markdown).toContain('They are neither failures nor skips.');
    expect(markdown).toContain(
      '| Report | Tests | Passed | Failed | Flaky | Skipped | Not run | Interrupted |',
    );
    expect(markdown).toContain('| reports/playwright.json | 66 | 0 | 2 | 1 | 0 | 66 | 0 | 0 |');
    expect(markdown).not.toContain('silent skip');
    expect(renderText(listing)).toContain(
      'not run: 66 tests with no attempt (a listing, or a run stopped before them): neither failures nor skips',
    );
  });
});

describe('PB-LAB-005 triage report: a model draft is a draft, and a mock is never the service', () => {
  const draftOf = (
    failures: Failure[],
    status: SummaryRecord['status'],
    endpoint: string,
    text = 'Likely root cause: x\nFirst thing to check: y',
  ) => {
    const clusters = cluster(failures);
    const first = clusters[0]!;
    const r = buildReport(collection(failures), clusters, {
      from: 'reports',
      now: NOW,
      summaries: {
        records: [{ clusterKey: first.key, status, text, model: 'claude-haiku-5-5' }],
        note: null,
        endpoint,
        model: 'claude-haiku-5-5',
        requests: status === 'cached' ? 0 : 1,
        cacheHits: status === 'cached' ? 1 : 0,
        inputChars: 0,
      },
    });
    return { r, markdown: renderMarkdown(r), text: renderText(r) };
  };

  it('labels a draft of the live endpoint as a suggestion for a person, quoted, with the model and where it came from', () => {
    const { markdown, text } = draftOf([failure({ message: wait })], 'summarized', DEFAULT_BASE_URL);
    expect(markdown).toContain(
      '**model draft (claude-haiku-5-5, live service): a suggestion for a person, never a verdict**',
    );
    expect(markdown).toContain('> Likely root cause: x\n> First thing to check: y');
    expect(markdown).toContain(
      `Model summaries: claude-haiku-5-5 through ${DEFAULT_BASE_URL}; 1 request sent, 0 drafts from the cache.`,
    );
    expect(text).toContain(
      'draft     [model draft (claude-haiku-5-5, live service): a suggestion for a person, never a verdict]',
    );
  });

  it('reports the tokens the service said the drafts of this run used, and does not count a cached draft again', () => {
    const failures = [
      failure({ id: 'PB-VOD-006', message: wait }),
      failure({ id: 'PB-ABR-002', message: 'Error: other cause' }),
      failure({ id: 'PB-VOD-007', message: 'Error: a third cause' }),
    ];
    const clusters = cluster(failures);
    const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
    const r = buildReport(collection(failures), clusters, {
      from: 'reports',
      now: NOW,
      summaries: {
        records: [
          { clusterKey: clusters[0]!.key, status: 'summarized', text: 'a', usage: usage(1000, 300) },
          { clusterKey: clusters[1]!.key, status: 'summarized', text: 'b', usage: usage(200, 40) },
          { clusterKey: clusters[2]!.key, status: 'cached', text: 'c', usage: usage(5000, 900) },
        ],
        note: null,
        endpoint: DEFAULT_BASE_URL,
        model: 'claude-haiku-5-5',
        requests: 2,
        cacheHits: 1,
        inputChars: 0,
      },
    });
    expect(r.summaryRun?.usage).toStrictEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(renderMarkdown(r)).toContain(
      '2 requests sent, 1 draft from the cache. The service reported 1200 input and 340 output tokens for the drafts of this run.',
    );
    expect(
      draftOf([failure({ message: wait })], 'summarized', DEFAULT_BASE_URL).r.summaryRun?.usage,
    ).toBeNull();
  });

  it('says in capitals that a draft of another endpoint is not the live service, and a cached one that it is from the cache', () => {
    const mocked = draftOf([failure({ message: wait })], 'summarized', 'http://127.0.0.1:4751');
    expect(mocked.markdown).toContain('endpoint http://127.0.0.1:4751, NOT the live service');
    expect(mocked.markdown).toContain('(**not the live service**: a local test double)');
    const cached = draftOf([failure({ message: wait })], 'cached', DEFAULT_BASE_URL);
    expect(cached.markdown).toContain('from the cache');
    expect(cached.markdown).toContain('1 draft from the cache');
  });

  it('says why a cluster has no draft, and what the run could not do', () => {
    const clusters = cluster([failure({ message: wait })]);
    const r = buildReport(collection([failure({ message: wait })]), clusters, {
      from: 'reports',
      now: NOW,
      summaries: {
        records: [
          {
            clusterKey: clusters[0]!.key,
            status: 'failed',
            note: 'HTTP 429 rate_limit_error: slow down, after 3 retries',
          },
        ],
        note: 'summaries: 1 failed (the notes say why; the clusters above are unaffected)',
        endpoint: DEFAULT_BASE_URL,
        model: 'claude-haiku-5-5',
        requests: 4,
        cacheHits: 0,
        inputChars: 0,
      },
    });
    expect(renderMarkdown(r)).toContain(
      '_No model draft for this cluster: HTTP 429 rate_limit_error: slow down, after 3 retries_',
    );
    expect(renderMarkdown(r)).toContain(
      '_summaries: 1 failed (the notes say why; the clusters above are unaffected)_',
    );
    expect(renderText(r)).toContain(
      'draft     (none: HTTP 429 rate_limit_error: slow down, after 3 retries)',
    );
  });
});

describe('PB-LAB-005 triage report: the console and the job summary', () => {
  it('prints "no failures to triage" and what was read', () => {
    const text = renderText(report([]), { wrote: ['reports/triage/triage-report.md'] });
    expect(text).toBe(`${NO_FAILURES}\nread 1 report: 10 tests\nwrote reports/triage/triage-report.md\n`);
    expect(renderText(report([], { sources: [] }))).toBe(`${NO_FAILURES}\n`);
    expect(renderStepSummary(report([]))).toBe('### Failure triage\n\nno failures to triage.\n');
  });

  it('says on the first line of the CI stage that it is not a gate', () => {
    const text = renderText(report([failure({ message: wait })]), { fromCi: true });
    expect(text.split('\n')[0]).toBe(
      'gate:triage: triage is not a gate: it explains a red build and never decides one (exit 0 whatever it finds)',
    );
  });

  it('shows the first clusters in a job summary and counts the rest', () => {
    const failures = Array.from({ length: 15 }, (_, i) =>
      failure({
        id: `PB-VOD-0${String(i + 1).padStart(2, '0')}`,
        message: `Error: cause number ${'x'.repeat(i + 1)}`,
      }),
    );
    const summary = renderStepSummary(report(failures));
    expect(summary.split('\n').filter((line) => /^\| \d+ \|/.test(line))).toHaveLength(12);
    expect(summary).toContain('| … | | | | | 3 more clusters in `triage-report.md` |');
  });
});
