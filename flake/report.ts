// The flake report (`npm run flake:report`): what the history says, per test and per engine job, as markdown for a person (stdout, and the
// job summary of GitHub Actions when there is one) and as JSON for a tool. The same numbers the gate judges, with nothing hidden: every
// test with its runs, flaky and failed outcomes, rate, verdict and the last failure's signature; every engine job with its suite rate and
// its budget; the quarantine list; what was skipped and why.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FLAKE_LIMITS } from '../src/shared/criteria.ts';
import { detectEnvId } from '../src/shared/env.ts';
import {
  appendStepSummary,
  EnvironmentProblem,
  findRunFiles,
  parseCliArgs,
  readRunFiles,
  storeFromArgs,
} from './cli.ts';
import { HistoryError, mergeHistories } from './history.ts';
import { expiredEntries, findQuarantine, loadList, utcDay } from './quarantine.ts';
import type { CatalogFacts, QuarantineEntry, ReadResult } from './quarantine.ts';
import { assessQuarantine } from './quarantine.ts';
import type { FlakeRun, Tier } from './run.ts';
import { flakeStats, percent } from './stats.ts';
import type { FlakeLimits, SuiteStats, TestStats, Verdict } from './stats.ts';
import { StoreError } from './store.ts';
import type { FlakeStore } from './store.ts';

export interface ReportTest extends TestStats {
  title: string;
  /** The entry that quarantines the test today, or null. */
  quarantine: QuarantineEntry | null;
}

export interface ReportQuarantine {
  entry: QuarantineEntry;
  /** `active`: in force today. `expired`: past its expiry, so the test is on the gate again. `not-valid`: it has a problem and quarantines nothing. */
  state: 'active' | 'expired' | 'not-valid';
  tier: Tier | null;
}

export interface ReportSkip {
  id: string;
  project: string;
  /** null: skipped without a reason, which is a bug (docs/CONTRACTS.md section 7.3). */
  reason: string | null;
  /** The date of the run in which it was last skipped. */
  date: string;
  /** In how many of the runs of the history that list this test it was skipped, and how many list it: an invalid run is counted here. */
  times: number;
  of: number;
}

export interface FlakeReport {
  generatedAt: string;
  envId: string;
  today: string;
  history: { runs: number; from: string | null; to: string | null };
  limits: FlakeLimits;
  suites: SuiteStats[];
  tests: ReportTest[];
  quarantine: ReportQuarantine[];
  quarantineProblems: string[];
  skips: ReportSkip[];
  notes: string[];
}

export interface ReportInput {
  /** Every run of the environment: the history, and the runs of this build when they are not in it yet. */
  runs: readonly FlakeRun[];
  envId: string;
  today: string;
  generatedAt: string;
  quarantine: ReadResult;
  catalog: CatalogFacts;
  limits?: FlakeLimits;
}

const RANK: Record<Verdict, number> = { 'over-trigger': 0, watch: 1, 'not-enough-data': 2, ok: 3 };

export function buildReport(input: ReportInput): FlakeReport {
  const limits = input.limits ?? FLAKE_LIMITS;
  const runs = mergeHistories([input.runs.filter((run) => run.envId === input.envId)]);
  const assessed = assessQuarantine(input.quarantine, { catalog: input.catalog, today: input.today });
  const quarantinedNow = (id: string, project: string): boolean =>
    findQuarantine(assessed.effective, id, project, input.today) !== null;
  const stats = flakeStats(runs, { limits, quarantined: quarantinedNow });

  const titles = new Map<string, string>();
  for (const run of runs)
    for (const test of run.tests) titles.set(`${test.project}\u0000${test.id}`, test.title);
  const tests: ReportTest[] = stats.tests
    .map((t) => ({
      ...t,
      title: titles.get(`${t.project}\u0000${t.id}`) ?? t.id,
      quarantine: findQuarantine(assessed.effective, t.id, t.project, input.today),
    }))
    .sort(
      (a, b) =>
        RANK[a.verdict] - RANK[b.verdict] ||
        b.flakeRate - a.flakeRate ||
        a.id.localeCompare(b.id) ||
        a.project.localeCompare(b.project),
    );

  const effective = new Set(assessed.effective);
  const expired = new Set(
    expiredEntries(input.quarantine.entries, input.today, input.catalog).map((e) => e.entry),
  );
  // An entry that is valid has started (a start in the future is a problem), so it is in force until it expires.
  const quarantine: ReportQuarantine[] = input.quarantine.entries.map((entry) => ({
    entry,
    state: !effective.has(entry) ? 'not-valid' : expired.has(entry) ? 'expired' : 'active',
    tier: input.catalog.get(entry.id)?.tier ?? null,
  }));

  const latestSkip = new Map<string, ReportSkip>();
  const seen = new Map<string, { times: number; of: number }>();
  for (const run of runs) {
    for (const test of run.tests) {
      const key = `${test.project}\u0000${test.id}`;
      const counts = seen.get(key) ?? { times: 0, of: 0 };
      counts.of += 1;
      seen.set(key, counts);
      if (test.outcome !== 'skipped') continue;
      counts.times += 1;
      latestSkip.set(key, {
        id: test.id,
        project: test.project,
        reason: test.skipReason ?? null,
        date: run.date,
        times: 0,
        of: 0,
      });
    }
  }
  for (const [key, skip] of latestSkip) {
    const counts = seen.get(key);
    skip.times = counts?.times ?? 0;
    skip.of = counts?.of ?? 0;
  }

  const notes: string[] = [];
  const unobserved = stats.tests.reduce((sum, t) => sum + t.unobserved, 0);
  if (unobserved > 0) {
    notes.push(
      `${unobserved} executions had no retry in their configuration: a flake cannot show in them, so they are in no rate (docs/FLAKE.md, "What is excluded").`,
    );
  }
  const silent = [...latestSkip.values()].filter((s) => s.reason === null);
  if (silent.length > 0) {
    notes.push(
      `${silent.length} skipped tests carry no reason: a skip without evidence is a bug (docs/CONTRACTS.md section 7.3).`,
    );
  }
  if (runs.length === 0)
    notes.push(
      'The history of this environment is empty: nothing has been recorded yet (tools/flake-collect.ts, or flake:gate --record).',
    );
  const young = stats.suites.filter((s) => s.verdict === 'not-enough-data');
  if (young.length > 0) {
    notes.push(
      `${young.map((s) => `${s.project} (${s.builds} builds)`).join(', ')}: fewer than ${limits.minRunsToJudge} builds, so the suite rate is shown and not judged.`,
    );
  }

  return {
    generatedAt: input.generatedAt,
    envId: input.envId,
    today: input.today,
    history: { runs: runs.length, from: runs[0]?.date ?? null, to: runs.at(-1)?.date ?? null },
    limits,
    suites: stats.suites,
    tests,
    quarantine,
    quarantineProblems: assessed.problems,
    skips: [...latestSkip.values()].sort(
      (a, b) => a.id.localeCompare(b.id) || a.project.localeCompare(b.project),
    ),
    notes,
  };
}

/** A table cell: no pipes or line breaks, and not longer than a person reads. */
export function cell(text: string | number | null | undefined, max = 90): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const row = (cells: readonly (string | number | null | undefined)[]): string =>
  `| ${cells.map((c) => cell(c)).join(' | ')} |`;

export function renderMarkdown(report: FlakeReport): string {
  const { limits } = report;
  const out: string[] = [];
  out.push(`# Flake report: ${report.envId}`, '');
  out.push(
    report.history.runs === 0
      ? `Generated ${report.generatedAt}. The history of this environment is empty.`
      : `Generated ${report.generatedAt}, as of ${report.today}. History: ${report.history.runs} runs, from ${report.history.from} to ${report.history.to}. Window: the last ${limits.windowRuns} executions of a test, the last ${limits.windowRuns} builds of an engine job. A test is judged from ${limits.minRunsToJudge} executions; the trigger is ${percent(limits.quarantineTriggerRate)}, the suite budget ${percent(limits.suiteBudgetRate)}.`,
    '',
  );

  out.push(
    '## Engine jobs: the suite flake rate',
    '',
    `Merge-tier tests only; quarantined tests are left out of the rate and listed in the last column.`,
    '',
  );
  if (report.suites.length === 0) out.push('No merge-tier execution in the history.');
  else {
    out.push(
      row([
        'Engine job',
        'Builds',
        'Executions',
        'Flaky',
        'Failed',
        'Flake rate',
        'Budget',
        'Verdict',
        'Quarantined (left out)',
        'Worst tests',
      ]),
    );
    out.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---']));
    for (const s of report.suites) {
      out.push(
        row([
          s.project + (s.experimental ? ' (experimental)' : ''),
          s.builds,
          s.executions,
          s.flaky,
          s.failed,
          percent(s.flakeRate),
          percent(s.budget),
          s.verdict,
          `${s.quarantinedExecutions} (${s.quarantinedFlaky} flaky)`,
          s.contributors
            .slice(0, 3)
            .map((c) => `${c.id} ${c.flaky}`)
            .join(', ') || '-',
        ]),
      );
    }
  }

  out.push('', `## Tests: the last ${limits.windowRuns} executions of each`, '');
  if (report.tests.length === 0) out.push('No test has been executed in the history.');
  else {
    out.push(
      row([
        'Test',
        'Engine',
        'Tier',
        'Runs',
        'Flaky',
        'Failed',
        'Flake rate',
        'Failure rate',
        'Verdict',
        'Quarantine',
        'Last failure',
      ]),
    );
    out.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---']));
    for (const t of report.tests) {
      out.push(
        row([
          t.id,
          t.project + (t.experimental ? ' (experimental)' : ''),
          t.tier ?? '-',
          t.executions,
          t.flaky,
          t.failed,
          percent(t.flakeRate),
          percent(t.failureRate),
          t.verdict,
          t.quarantine ? `until ${t.quarantine.expires} (${t.quarantine.owner})` : '-',
          t.lastFailure
            ? `${t.lastFailure.outcome}, ${t.lastFailure.date.slice(0, 10)}: ${t.lastFailure.signature ?? 'no message recorded'}`
            : '-',
        ]),
      );
    }
  }

  out.push('', '## Quarantine', '');
  if (report.quarantine.length === 0 && report.quarantineProblems.length === 0) {
    out.push('Nothing is quarantined: flake/quarantine.json is empty.');
  } else {
    if (report.quarantine.length > 0) {
      out.push(row(['Test', 'Engine', 'Tier', 'Owner', 'Since', 'Expires', 'State', 'Reason', 'Evidence']));
      out.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
      for (const q of report.quarantine) {
        out.push(
          row([
            q.entry.id,
            q.entry.project ?? 'all',
            q.tier ?? '-',
            q.entry.owner,
            q.entry.since,
            q.entry.expires,
            q.state,
            q.entry.reason,
            q.entry.evidence,
          ]),
        );
      }
    }
    for (const problem of report.quarantineProblems) out.push('', `- Problem: ${problem}`);
  }

  out.push('', '## Skipped', '');
  if (report.skips.length === 0) out.push('No test was skipped in the history.');
  else {
    out.push(
      row(['Test', 'Engine', 'Reason (the evidence a documented gap carries)', 'Last seen', 'Skipped']),
    );
    out.push(row(['---', '---', '---', '---', '---']));
    for (const s of report.skips)
      out.push(
        row([
          s.id,
          s.project,
          s.reason ?? 'NO REASON RECORDED',
          s.date.slice(0, 10),
          `${s.times} of ${s.of} runs`,
        ]),
      );
  }

  if (report.notes.length > 0) out.push('', '## Notes', '', ...report.notes.map((n) => `- ${n}`));
  out.push(
    '',
    '## What this does not say',
    '',
    `- A rate is a count over a window, not a probability: ${limits.windowRuns} executions cannot tell a test that flakes 1% of the time from one that never does (docs/FLAKE.md).`,
    '- It sees only what a retry hides. A test that fails every time, or fails twice in a row by bad luck, is a failure, not a flake, and the browser job already failed on it.',
    '- Every number is from the environment named above; none is comparable with another environment.',
  );
  return `${out.join('\n')}\n`;
}

export const REPORT_USAGE = `Usage: tsx flake/report.ts [options]

Writes a markdown report of the flake history to stdout (and to $GITHUB_STEP_SUMMARY when it is set) and, alongside, reports/flake/report.md
and reports/flake/report.json. Exit 0, or 2 when the history cannot be read.

  --env <id>           the environment (default: detectEnvId(); PB_ENV_ID overrides it)
  --runs <path>        also include run files not recorded yet (default: reports/flake when it exists)
  --store file|git, --history-dir, --git-remote, --git-branch, --git-repo, --git-identity   where the history lives (as flake/gate.ts)
  --quarantine <file>, --strategy <file>, --today <YYYY-MM-DD>
  --md <file>, --json <file>   where to write the two files`;

export interface ReportIo {
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  root: string;
  now: () => Date;
  store?: FlakeStore;
}

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export function defaultReportIo(): ReportIo {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    env: process.env,
    cwd: process.cwd(),
    root: ROOT,
    now: () => new Date(),
  };
}

export async function reportCommand(
  argv: readonly string[],
  io: ReportIo = defaultReportIo(),
): Promise<number> {
  try {
    const args = parseCliArgs(argv, io.env);
    if (args.help) {
      io.log(REPORT_USAGE);
      return 0;
    }
    const files = findRunFiles(
      args.runs.length > 0 ? args.runs : ['reports/flake'],
      io.cwd,
      args.runs.length > 0,
    );
    const current = readRunFiles(files);
    const envId = args.env ?? current[0]?.envId ?? detectEnvId(io.env);
    const store = io.store ?? storeFromArgs(args, io.cwd);
    let history: FlakeRun[];
    try {
      history = await store.load(envId);
    } catch (error) {
      if (error instanceof HistoryError || error instanceof StoreError) {
        throw new EnvironmentProblem(`cannot read the history (${store.description}): ${error.message}`);
      }
      throw error;
    }
    const today = args.today ?? utcDay(io.now());
    let list;
    try {
      list = loadList({
        quarantineFile: resolve(io.cwd, args.quarantine ?? resolve(io.root, 'flake/quarantine.json')),
        strategyFile: resolve(io.cwd, args.strategy ?? resolve(io.root, 'TEST_STRATEGY.md')),
        today,
      });
    } catch (error) {
      throw new EnvironmentProblem(
        `cannot read the catalog of the strategy document: ${(error as Error).message}`,
      );
    }
    const report = buildReport({
      runs: [...history, ...current],
      envId,
      today,
      generatedAt: io.now().toISOString(),
      quarantine: list.read,
      catalog: list.catalog,
    });
    const markdown = renderMarkdown(report);
    io.log(markdown);
    const mdFile = resolve(io.cwd, args.md ?? 'reports/flake/report.md');
    const jsonFile = resolve(io.cwd, args.json ?? 'reports/flake/report.json');
    mkdirSync(dirname(mdFile), { recursive: true });
    mkdirSync(dirname(jsonFile), { recursive: true });
    writeFileSync(mdFile, markdown);
    writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
    appendStepSummary(io.env, markdown);
    return 0;
  } catch (error) {
    if (error instanceof EnvironmentProblem || error instanceof HistoryError || error instanceof StoreError) {
      io.error(`flake report: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  reportCommand(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`flake report: ${(error as Error).stack ?? String(error)}`);
      process.exit(2);
    },
  );
}
