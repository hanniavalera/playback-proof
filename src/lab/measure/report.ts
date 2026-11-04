import { PERF_LIMITS } from '../../shared/criteria.ts';
import type { HostInfo } from '../probe/host-info.ts';
import { startRungOf } from './baseline.ts';
import type { Baseline, BaselineBrowser } from './baseline.ts';
import { formatAmount } from './decide.ts';
import type { ExitCode, FinalMetric, MetricComparison, Problem, ScenarioOutcome } from './decide.ts';
import type { GateResult, MeasuredBatch, ScenarioResult } from './gate.ts';
import { describeRule, rulesFrom, tailStatistic } from './rules.ts';
import type { MetricRule, PerfLimits, RuleKey } from './rules.ts';
import { summarize } from './stats.ts';
import type { Summary } from './stats.ts';
import type {
  BatchMeasurement,
  MetricSpec,
  MetricUnit,
  PerfProfile,
  RunRecord,
  ScenarioSpec,
} from './types.ts';

// What the gate and `npm run perf` tell a person: a table in the terminal, a Markdown summary for the job page and the pull request, and a
// JSON report with every run for whoever has to find out why. Pure functions of the results: nothing here measures or reads the disk.

// ----------------------------------------------------------------------------------------------------------------- text tables

/** A table with columns padded to their widest cell. */
export function textTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

const percent = (share: number): string => `${share >= 0 ? '+' : ''}${(share * 100).toFixed(1)} %`;

/** `148 ms / 155.5 ms`: the median and the tail of a summary. */
const pair = (a: number, b: number, unit: MetricUnit): string =>
  `${formatAmount(a, unit)} / ${formatAmount(b, unit)}`;

/** The change of the median: a share of the baseline, or the amount when the baseline is zero. */
function changeOf(comparison: MetricComparison): string {
  const { median } = comparison;
  if (median.changeShare !== null) return percent(median.changeShare);
  return `${median.change >= 0 ? '+' : ''}${formatAmount(median.change, comparison.unit)}`;
}

const VERDICT_TEXT = {
  pass: 'pass',
  regression: 'REGRESSION',
  'not-reproduced': 'not reproduced',
  tracked: 'tracked',
} as const;

const ruleText = (comparison: MetricComparison): string =>
  comparison.rule === null
    ? '-'
    : describeRule(comparison.rule, (amount) => formatAmount(amount, comparison.unit));

/** The tail a metric is judged on: the p10 where lower is worse, the p90 otherwise (and for a metric nobody judges). */
const tailOf = (metric: MetricSpec, summary: Summary): { name: 'p10' | 'p90'; value: number } => {
  const name = metric.rule === null ? 'p90' : tailStatistic(rulesFrom()[metric.rule]);
  return { name, value: name === 'p10' ? summary.p10 : summary.p90 };
};

// -------------------------------------------------------------------------------------------------------------------- summaries

export interface MetricSummary {
  metric: MetricSpec;
  summary: Summary | null;
}

/** The statistics of every metric of a batch, warm-up excluded. */
export function summarizeBatch(spec: ScenarioSpec, batch: BatchMeasurement): MetricSummary[] {
  return spec.metrics.map((metric) => {
    const values = batch.runs
      .map((run) => run.values[metric.id] ?? null)
      .filter((v): v is number => v !== null);
    return { metric, summary: values.length > 0 ? summarize(values) : null };
  });
}

function startRungText(batch: BatchMeasurement): string {
  const start = startRungOf(batch.runs);
  if (!start.unanimous) {
    return `mixed (${[...new Set(start.heights)].map((height) => (height === null ? '?' : `${height}p`)).join(', ')})`;
  }
  return start.height === null ? 'unknown' : `${start.height}p`;
}

/** What a batch was: how many runs, which stream and condition, the rung it started on, how busy the machine was. */
function batchFacts(spec: ScenarioSpec, batch: BatchMeasurement): string {
  const pinned = spec.pinnedHeight === null ? '' : `, window pinned at ${spec.pinnedHeight}p`;
  const load = `${batch.loadAverage.before.toFixed(1)} -> ${batch.loadAverage.after.toFixed(1)}`;
  return `${batch.runs.length} runs${batch.warmup ? ' after a warm-up' : ''}, stream ${batch.stream}, ${spec.faultProfile}, start rung ${startRungText(batch)}${pinned}, load average ${load}`;
}

const batchHeading = (spec: ScenarioSpec, batch: BatchMeasurement): string =>
  `${spec.id} ${spec.name} (${batch.profile}): ${batchFacts(spec, batch)}`;

/** What `npm run perf` prints for one batch: the statistics of every metric, and which of them gate. */
export function renderBatchSummary(spec: ScenarioSpec, batch: BatchMeasurement): string {
  const rows = summarizeBatch(spec, batch).map(({ metric, summary }) => {
    const role = metric.rule === null ? 'tracked' : `gates (${metric.rule})`;
    if (!summary) return [metric.id, '0', '-', '-', '-', '-', '-', role];
    const f = (value: number): string => formatAmount(value, metric.unit);
    return [
      metric.id,
      String(summary.n),
      f(summary.median),
      f(summary.p10),
      f(summary.p90),
      `${f(summary.min)} .. ${f(summary.max)}`,
      summary.cv === null ? '-' : `${(summary.cv * 100).toFixed(1)} %`,
      role,
    ];
  });
  return `${batchHeading(spec, batch)}\n${textTable(['metric', 'n', 'median', 'p10', 'p90', 'min .. max', 'cv', 'role'], rows)}`;
}

// -------------------------------------------------------------------------------------------------------------------- the report

export interface BatchReport {
  startedAt: string;
  finishedAt: string;
  loadAverage: { before: number; after: number };
  startRungHeight: number | null;
  warmup: RunRecord | null;
  runs: RunRecord[];
  summaries: Record<string, Summary | null>;
  comparisons: MetricComparison[];
  problems: Problem[];
}

export interface ScenarioReport {
  id: string;
  name: string;
  title: string;
  status: ScenarioOutcome['status'];
  remeasured: boolean;
  stream: string | null;
  metrics: FinalMetric[];
  problems: Problem[];
  first: BatchReport | null;
  remeasure: BatchReport | null;
}

export interface GateReport {
  schemaVersion: 1;
  kind: 'perf-gate-report';
  envId: string;
  profile: PerfProfile;
  generatedAt: string;
  verdict: 'pass' | 'regression' | 'problem';
  exitCode: ExitCode;
  baseline: {
    file: string;
    generatedAt: string;
    commit: string | null;
    browserVersion: string;
    runsPerScenario: number;
  } | null;
  current: { host: HostInfo; browser: BaselineBrowser | null; ffmpeg: string | null };
  policy: { limits: PerfLimits; rules: Record<RuleKey, MetricRule> };
  /** What differs from the machine of the baseline besides the code: a reader's hint, never a failure. */
  warnings: string[];
  problems: Problem[];
  scenarios: ScenarioReport[];
}

function batchReport(spec: ScenarioSpec, measured: MeasuredBatch | null): BatchReport | null {
  if (!measured) return null;
  const { batch, judgement } = measured;
  return {
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    loadAverage: batch.loadAverage,
    startRungHeight: startRungOf(batch.runs).height,
    warmup: batch.warmup,
    runs: batch.runs,
    summaries: Object.fromEntries(
      summarizeBatch(spec, batch).map(({ metric, summary }) => [metric.id, summary]),
    ),
    comparisons: judgement?.comparisons ?? [],
    problems: judgement?.problems ?? [],
  };
}

export interface ReportInput {
  envId: string;
  profile: PerfProfile;
  generatedAt: string;
  result: GateResult;
  baseline: { file: string; baseline: Baseline } | null;
  host: HostInfo;
  browser: BaselineBrowser | null;
  ffmpeg: string | null;
  warnings: string[];
  /** Problems found before any batch was measured (a changed stream, a missing baseline): they end the gate with exit code 2. */
  setupProblems?: Problem[];
  limits?: PerfLimits;
}

export function buildGateReport(input: ReportInput): GateReport {
  const limits = input.limits ?? PERF_LIMITS;
  const setupProblems = input.setupProblems ?? [];
  const exitCode: ExitCode =
    input.result.exitCode === 1 ? 1 : input.result.exitCode === 2 || setupProblems.length > 0 ? 2 : 0;
  return {
    schemaVersion: 1,
    kind: 'perf-gate-report',
    envId: input.envId,
    profile: input.profile,
    generatedAt: input.generatedAt,
    verdict: exitCode === 0 ? 'pass' : exitCode === 1 ? 'regression' : 'problem',
    exitCode,
    baseline: input.baseline
      ? {
          file: input.baseline.file,
          generatedAt: input.baseline.baseline.generatedAt,
          commit: input.baseline.baseline.host.git.commit,
          browserVersion: input.baseline.baseline.browser.version,
          runsPerScenario: input.baseline.baseline.runsPerScenario,
        }
      : null,
    current: { host: input.host, browser: input.browser, ffmpeg: input.ffmpeg },
    policy: { limits, rules: rulesFrom(limits) },
    warnings: input.warnings,
    problems: [...setupProblems, ...input.result.problems],
    scenarios: input.result.scenarios.map((result) => ({
      id: result.spec.id,
      name: result.spec.name,
      title: result.spec.title,
      status: result.outcome.status,
      remeasured: result.outcome.remeasured,
      stream: result.first?.batch.stream ?? null,
      metrics: result.outcome.metrics,
      problems: result.outcome.problems,
      first: batchReport(result.spec, result.first),
      remeasure: batchReport(result.spec, result.remeasure),
    })),
  };
}

export function serializeReport(report: GateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// --------------------------------------------------------------------------------------------------------------- the table

const GATE_COLUMNS = [
  'metric',
  'baseline median / tail',
  'current median / tail',
  'change',
  'threshold',
  'verdict',
] as const;

function gateRows(comparisons: readonly MetricComparison[], final: readonly FinalMetric[]): string[][] {
  return comparisons.map((comparison) => {
    const decided = final.find((metric) => metric.metric === comparison.metric);
    const verdict = decided
      ? VERDICT_TEXT[decided.verdict]
      : comparison.verdict === 'fail'
        ? 'FAIL'
        : comparison.verdict;
    return [
      comparison.metric,
      pair(comparison.median.baseline, comparison.tail.baseline, comparison.unit),
      pair(comparison.median.current, comparison.tail.current, comparison.unit),
      changeOf(comparison),
      ruleText(comparison),
      verdict,
    ];
  });
}

/** The metrics whose reason a reader needs: what regressed, what did not reproduce, and what a noisy baseline stopped from gating. */
const worthExplaining = (metric: FinalMetric): boolean =>
  metric.verdict === 'regression' ||
  metric.verdict === 'not-reproduced' ||
  (metric.verdict === 'tracked' && metric.first.rule !== null);

const indent = (text: string): string => text.replace(/^/gm, '  ');

function scenarioText(result: ScenarioResult): string {
  const { spec, first, remeasure, outcome } = result;
  const lines: string[] = [
    first ? batchHeading(spec, first.batch) : `${spec.id} ${spec.name}: no batch was measured`,
  ];
  if (first?.judgement) {
    lines.push(textTable([...GATE_COLUMNS], gateRows(first.judgement.comparisons, outcome.metrics)));
    for (const metric of outcome.metrics.filter(worthExplaining))
      lines.push(`  ${metric.metric}: ${metric.first.reason}`);
  } else if (first) {
    lines.push('  no baseline: these numbers are reported, nothing is judged');
    const rows = summarizeBatch(spec, first.batch).map(({ metric, summary }) => {
      if (!summary) return [metric.id, '-', '-', '-'];
      const tail = tailOf(metric, summary);
      return [
        metric.id,
        formatAmount(summary.median, metric.unit),
        tail.name,
        formatAmount(tail.value, metric.unit),
      ];
    });
    lines.push(textTable(['metric', 'median', 'tail', 'value'], rows));
  }
  if (remeasure?.judgement) {
    lines.push(`  fresh batch (a new browser, new runs): ${batchFacts(spec, remeasure.batch)}`);
    lines.push(indent(textTable([...GATE_COLUMNS], gateRows(remeasure.judgement.comparisons, []))));
    for (const metric of outcome.metrics) {
      if (metric.remeasure && metric.first.verdict === 'fail')
        lines.push(`  ${metric.metric}: ${VERDICT_TEXT[metric.verdict]}: ${metric.remeasure.reason}`);
    }
  }
  for (const problem of outcome.problems) lines.push(`  PROBLEM: ${problem.message}`);
  return lines.join('\n');
}

/** The report as the terminal shows it. */
export function renderGateText(report: GateReport, results: readonly ScenarioResult[]): string {
  const baseline = report.baseline
    ? `baseline of ${report.baseline.generatedAt.slice(0, 10)} (commit ${report.baseline.commit ?? 'unknown'}, ${report.baseline.runsPerScenario} runs per scenario)`
    : 'NO BASELINE';
  const parts = [
    `performance gate: ${report.profile} in ${report.envId}, ${baseline}`,
    ...results.map(scenarioText),
  ];
  for (const warning of report.warnings) parts.push(`warning: ${warning}`);
  for (const problem of report.problems.filter((p) => p.scenario === '*'))
    parts.push(`PROBLEM: ${problem.message}`);
  parts.push(`verdict: ${report.verdict.toUpperCase()} (exit code ${report.exitCode})`);
  return parts.join('\n\n');
}

/** The report as Markdown: for the job summary of the CI system and for the file next to the JSON. */
export function renderGateMarkdown(report: GateReport): string {
  const lines: string[] = [
    `## Performance gate: ${report.profile} in \`${report.envId}\`: ${report.verdict.toUpperCase()}`,
    '',
    report.baseline
      ? `Baseline recorded ${report.baseline.generatedAt.slice(0, 10)} at commit \`${report.baseline.commit ?? 'unknown'}\` (${report.baseline.runsPerScenario} runs per scenario, browser ${report.baseline.browserVersion}). A metric fails the build when it is worse than the baseline by more than its threshold in the first batch **and** again in a fresh batch.`
      : '**No baseline for this environment:** the numbers are reported and nothing is judged.',
    '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `### ${scenario.id} ${scenario.name}: ${scenario.status}${scenario.remeasured ? ' (re-measured)' : ''}`,
      '',
    );
    const comparisons = scenario.first?.comparisons ?? [];
    if (comparisons.length > 0) {
      lines.push(markdownTable([...GATE_COLUMNS], gateRows(comparisons, scenario.metrics)), '');
      for (const metric of scenario.metrics.filter(worthExplaining)) {
        lines.push(`- \`${metric.metric}\`: ${metric.first.reason}`);
        if (metric.remeasure && metric.first.verdict === 'fail')
          lines.push(`  - fresh batch: ${metric.remeasure.reason}`);
      }
      lines.push('');
    }
    for (const problem of scenario.problems) lines.push(`> **Problem:** ${problem.message}`, '');
  }
  for (const problem of report.problems.filter((p) => p.scenario === '*'))
    lines.push(`> **Problem:** ${problem.message}`, '');
  for (const warning of report.warnings) lines.push(`> Warning: ${warning}`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}
