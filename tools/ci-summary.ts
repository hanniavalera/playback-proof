// `npx tsx tools/ci-summary.ts [--report reports/playwright.json] [--title <text>] [--artifact <name>]`
//
// Turns the Playwright JSON report of a browser job into a Markdown summary: the counts, then the tests that failed, the tests
// that passed only on a retry (a flake, ADR-022) and the tests that were skipped, each with the attachments of the run. CI appends
// it to the job's summary page ($GITHUB_STEP_SUMMARY); without that variable it prints it. It reports and never judges: the exit
// code is 0 whatever the report says (the job's own step carries the verdict), and a missing or unreadable report is said in the
// summary, not thrown, so that the step cannot hide the failure that caused it.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import type { JSONReport, JSONReportSuite, JSONReportTest } from '@playwright/test/reporter';

export const DEFAULT_REPORT = 'reports/playwright.json';

/** Longest error text kept in a table cell: the full text is in the report. */
const ERROR_CHARS = 240;

export interface TestRow {
  /** The spec title (it starts with the catalog id) and the project it ran in. */
  title: string;
  project: string;
  /** The last attempt's status as Playwright names it: `failed`, `timedOut`, `skipped`, `passed`... */
  outcome: string;
  attempts: number;
  /** The first line of the error of the last attempt, without colour codes. */
  error: string | null;
  /** The distinct attachment names of every attempt, in the order they first appear. */
  attachments: string[];
  annotations: { type: string; description?: string }[];
}

export interface Summary {
  passed: number;
  failed: TestRow[];
  flaky: TestRow[];
  skipped: TestRow[];
  durationMs: number;
  projects: string[];
  /** What the run said about its own environment: the `environment` annotations, distinct. */
  environments: string[];
  evidenceDrift: string[];
  /** The text of the `experimental-engine` annotation, when an engine of this run carries it. */
  experimental: string | null;
  /** Errors outside any test (a global setup that threw): nothing ran, and this is why. */
  runErrors: string[];
}

function* testsOf(suite: JSONReportSuite): Generator<{ title: string; test: JSONReportTest }> {
  for (const spec of suite.specs) for (const test of spec.tests) yield { title: spec.title, test };
  for (const child of suite.suites ?? []) yield* testsOf(child);
}

const oneLine = (text: string): string => stripVTControlCharacters(text).replace(/\s+/g, ' ').trim();

/** The first line that says something: Playwright puts the code frame and the stack after it. */
function firstLine(message: string | undefined): string | null {
  const line = stripVTControlCharacters(message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!line) return null;
  return line.length > ERROR_CHARS ? `${line.slice(0, ERROR_CHARS - 1)}…` : line;
}

export function summarize(report: JSONReport): Summary {
  const summary: Summary = {
    passed: 0,
    failed: [],
    flaky: [],
    skipped: [],
    durationMs: report.stats?.duration ?? 0,
    projects: [],
    environments: [],
    evidenceDrift: [],
    experimental: null,
    runErrors: (report.errors ?? []).map((e) => firstLine(e.message) ?? 'an error without a message'),
  };
  const add = (list: string[], text: string | undefined): void => {
    if (text && !list.includes(text)) list.push(text);
  };
  for (const suite of report.suites ?? []) {
    for (const { title, test } of testsOf(suite)) {
      const last = test.results[test.results.length - 1];
      const names: string[] = [];
      for (const result of test.results) for (const a of result.attachments) add(names, a.name);
      const annotations = [...test.annotations, ...(last?.annotations ?? [])];
      const row: TestRow = {
        title,
        project: test.projectName,
        outcome: last?.status ?? 'unknown',
        attempts: test.results.length,
        error: firstLine(last?.error?.message ?? last?.errors?.[0]?.message),
        attachments: names,
        annotations,
      };
      add(summary.projects, test.projectName);
      for (const a of annotations) {
        if (a.type === 'environment') add(summary.environments, a.description);
        if (a.type === 'evidence-drift') add(summary.evidenceDrift, a.description);
        if (a.type === 'experimental-engine' && summary.experimental === null)
          summary.experimental = a.description ?? '';
      }
      if (test.status === 'expected') summary.passed += 1;
      else if (test.status === 'unexpected') summary.failed.push(row);
      else if (test.status === 'flaky') summary.flaky.push(row);
      else summary.skipped.push(row);
    }
  }
  return summary;
}

/** Text for a table cell: one line, no pipe, no HTML (the summary page renders tags and swallows them). */
function cell(text: string): string {
  return oneLine(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'");
}

const names = (list: string[]): string =>
  list.length > 0 ? list.map((n) => `\`${cell(n)}\``).join(' ') : 'none';

function testTable(rows: TestRow[]): string[] {
  return [
    '| test | project | attempts | last attempt | error | attachments |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${cell(r.title)} | ${cell(r.project)} | ${r.attempts} | ${cell(r.outcome)} | ${r.error === null ? '' : cell(r.error)} | ${names(r.attachments)} |`,
    ),
  ];
}

/**
 * The `skip` annotation is the reason of a documented gap (docs/CONTRACTS.md 7.3); a skip without one is a bug, so it says so.
 * When the run itself stopped (the global timeout, a setup that threw), the tests that never started are reported as skipped
 * too, and "no reason recorded" would blame the wrong thing: the errors of the run are the reason.
 */
function skipTable(rows: TestRow[], runStopped: boolean): string[] {
  const missing = runStopped
    ? 'did not run: the run stopped (see the errors above)'
    : '**no reason recorded**';
  return [
    '| test | project | reason |',
    '| --- | --- | --- |',
    ...rows.map((r) => {
      const reason = r.annotations.find((a) => a.type === 'skip')?.description;
      return `| ${cell(r.title)} | ${cell(r.project)} | ${reason ? cell(reason) : missing} |`;
    }),
  ];
}

export interface RenderOptions {
  title: string;
  /** The artifact that holds this job's reports, named so that a reader knows where the evidence is. */
  artifact?: string;
}

export function renderSummary(summary: Summary, options: RenderOptions): string {
  const { passed, failed, flaky, skipped } = summary;
  const total = passed + failed.length + flaky.length + skipped.length;
  const seconds = `${(summary.durationMs / 1000).toFixed(1)} s`;
  const lines: string[] = [`### ${cell(options.title)}`, ''];
  if (total === 0 && summary.runErrors.length === 0) {
    lines.push('No test ran: the report has no tests.');
  } else {
    const emphasised = (count: number, word: string): string =>
      count > 0 ? `**${count} ${word}**` : `${count} ${word}`;
    const counts = [
      emphasised(failed.length, 'failed'),
      emphasised(flaky.length, 'flaky'),
      `${passed} passed`,
      `${skipped.length} skipped`,
    ];
    lines.push(
      `${counts.join(', ')} in ${seconds}${summary.projects.length > 0 ? `, project ${names(summary.projects)}` : ''}.`,
    );
  }
  if (summary.runErrors.length > 0) {
    lines.push(
      '',
      '**Errors outside any test** (nothing may have run):',
      ...summary.runErrors.map((e) => `- ${cell(e)}`),
    );
  }
  if (summary.environments.length > 0) {
    lines.push('', ...summary.environments.map((e) => `Environment: ${names([e])}`));
  }
  for (const drift of summary.evidenceDrift) lines.push('', `Evidence drift: ${cell(drift)}`);
  if (summary.experimental !== null) lines.push('', `Experimental engine: ${cell(summary.experimental)}`);
  if (failed.length > 0) lines.push('', `#### Failed (${failed.length})`, '', ...testTable(failed));
  if (flaky.length > 0) {
    lines.push('', `#### Flaky (${flaky.length}): passed only on a retry`, '', ...testTable(flaky));
  }
  if (skipped.length > 0) {
    lines.push(
      '',
      `#### Skipped (${skipped.length})`,
      '',
      ...skipTable(skipped, summary.runErrors.length > 0),
    );
  }
  if (options.artifact) {
    lines.push(
      '',
      `Artifact \`${cell(options.artifact)}\`: \`reports/playwright.json\` (the lab's diagnostics are attached to every failure inside it), \`reports/html\` and \`test-results/\` (traces and screenshots).`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface SummaryIo {
  /** What a person running the tool sees (the Markdown, when there is no summary page). */
  out: (text: string) => void;
  err: (line: string) => void;
}

/** Returns the exit code: 0 whatever the report says, 2 for a command line that is wrong. */
export function main(argv: string[], env: NodeJS.ProcessEnv, io: SummaryIo): number {
  let values: { report?: string; title?: string; artifact?: string };
  try {
    values = parseArgs({
      args: argv,
      options: { report: { type: 'string' }, title: { type: 'string' }, artifact: { type: 'string' } },
      allowPositionals: false,
    }).values;
  } catch (error) {
    io.err(`ci-summary: ${(error as Error).message}`);
    io.err(
      'usage: tsx tools/ci-summary.ts [--report reports/playwright.json] [--title <text>] [--artifact <name>]',
    );
    return 2;
  }
  const path = values.report ?? DEFAULT_REPORT;
  const options: RenderOptions = {
    title: values.title ?? 'Playwright',
    ...(values.artifact ? { artifact: values.artifact } : {}),
  };
  let markdown: string;
  if (!existsSync(path)) {
    markdown = `### ${cell(options.title)}\n\nNo report at \`${cell(path)}\`: the job stopped before Playwright wrote one.\n`;
  } else {
    try {
      markdown = renderSummary(summarize(JSON.parse(readFileSync(path, 'utf8')) as JSONReport), options);
    } catch (error) {
      markdown = `### ${cell(options.title)}\n\nThe report at \`${cell(path)}\` cannot be read: ${cell((error as Error).message)}\n`;
    }
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    io.out(`summary written to ${env.GITHUB_STEP_SUMMARY}\n`);
  } else {
    io.out(markdown);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2), process.env, {
    out: (text) => void process.stdout.write(text),
    err: (line) => void console.error(line),
  });
}
