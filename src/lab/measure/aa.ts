import type { StatName } from './decide.ts';
import type { GateReport } from './report.ts';
import { stdDev } from './stats.ts';
import type { MetricUnit } from './types.ts';

// The A/A check (ADR-123): the gate run against its OWN baseline, repeatedly, on the same build. Nothing changed, so
// every alarm is a false alarm; what the check measures is how often the gate cries wolf and how close the honest noise gets to the
// thresholds. The passes ran on one machine when one job made them; the passes of several jobs ran on several machines, which the summary
// says (the CPU model of every pass), because on a runner class such as `gha-linux-x64` the machine is part of what is measured. Two
// numbers matter. A FALSE POSITIVE is a pass that ended in exit code 1 (a regression that reproduced): that is what
// fails a merge. A FIRST-BATCH ALARM is a gated metric that failed in the first batch only: it cost a fresh batch and was then not
// reproduced, so it did not fail the build, but it says the threshold is close to the noise. This file reads the reports the gate wrote
// and summarizes them; it measures nothing.

export interface AaMetric {
  scenario: string;
  metric: string;
  unit: MetricUnit;
  /** Judged by a rule in every pass in which it was measured (false: tracked only, because it has no rule or its baseline is too noisy). */
  gated: boolean;
  tailStatistic: StatName;
  /** The baseline statistic the gate compared with, and its coefficient of variation. */
  baseline: { median: number; tail: number; cv: number | null; runs: number };
  /** What the metric was allowed to be worse than the baseline by (null: not gated). The same in every pass: it depends on the baseline only. */
  allowed: { median: number | null; tail: number | null };
  /** The passes in which the metric was measured. */
  passes: number;
  /** The median and the tail of the first batch of each pass, in pass order. */
  medians: number[];
  tails: number[];
  /** The most the first batches were worse than the baseline, in the unit of the metric (negative: better in every pass). */
  worst: { median: number; tail: number };
  /** For each pass in which the metric was measured, how much worse than ITS baseline the first batch was, and what it was allowed. They differ from pass to pass only when each pass had a baseline of its own (a paired check: ADR-179). */
  perPass: {
    worse: { median: number; tail: number };
    allowed: { median: number | null; tail: number | null };
  }[];
  /** Passes whose first batch failed this metric. */
  firstBatchAlarms: number;
  /** Of those, the passes in which the fresh batch failed it too: false positives. */
  reproduced: number;
  /** The spread of the median from batch to batch: the standard deviation of `medians`, and its share of the baseline median. */
  betweenBatch: { sd: number | null; relativeSd: number | null };
}

export interface AaStartup {
  /** The scenario that measured it: the first of the report that has a `startupMs` (PB-PERF-001 on the full-speed profiles, PB-PERF-004 under the throttle). */
  scenario: string;
  /** The median of the baseline and of the first batch of this pass, in ms. */
  baselineMedian: number;
  median: number;
  /** (median - baseline median) / baseline median: positive is slower. Null when the baseline median is zero. */
  deviation: number | null;
}

export interface AaPass {
  file: string;
  generatedAt: string;
  exitCode: 0 | 1 | 2;
  /** The scenarios of this pass whose first batch failed a gated metric, so that a fresh batch was measured. */
  alarmedScenarios: string[];
  /** The 1-minute load average when the first batch started and when the last one ended. */
  load: { before: number; after: number } | null;
  problems: string[];
  /** The CPU model of the machine this pass ran on; null in a report written before the model was recorded, or on a machine that does not name its CPU. */
  cpuModel: string | null;
  /** The startup of the pass against the baseline's; null when the pass measured none (it ended before a batch, or the scenario was left out). */
  startup: AaStartup | null;
}

export interface AaSummary {
  schemaVersion: 1;
  kind: 'perf-aa';
  envId: string;
  profile: string;
  passes: number;
  scenarios: string[];
  baseline: {
    file: string;
    generatedAt: string;
    commit: string | null;
    browserVersion: string;
    runsPerScenario: number;
    /** The CPU model the baseline was recorded on; null when it does not say. */
    cpuModel: string | null;
  };
  /**
   * Present when the passes were PAIRED gates (ADR-179): each pass measured its own control, on the machine it ran on, minutes before the
   * head, so `baseline` above is the control of the first pass that had one. Null for passes against one committed baseline.
   */
  paired: {
    controlRef: string | null;
    controlCommit: string | null;
    headCommit: string | null;
    aa: boolean;
  } | null;
  /** Number of passes that ended in each exit code. */
  exitCodes: { '0': number; '1': number; '2': number };
  /** Passes that ended in exit code 1: the regression "reproduced" although nothing changed. Expected 0. */
  falsePositives: number;
  /** Scenario-passes whose first batch failed a gated metric (each cost a fresh batch). */
  firstBatchAlarms: number;
  /** Of those, the ones that did not reproduce. */
  notReproduced: number;
  /** The facts of the FIRST pass. Passes from several jobs may be on other machines: `machines` lists the CPU models they ran on. */
  host: {
    cpus: number;
    memoryGiB: number;
    node: string;
    playwright: string;
    invokedVia: string | null;
    dockerCpus: number | null;
  };
  /** What the passes ran on. A runner class such as `gha-linux-x64` is a pool of different CPUs, and the passes of one A/A may come from several jobs. */
  machines: {
    /** The distinct CPU models of the passes that recorded one, with how many passes ran on each: most passes first, ties by name. */
    cpuModels: { model: string; passes: number }[];
    /** Passes that did not record a CPU model. */
    passesWithoutCpuModel: number;
  };
  runs: AaPass[];
  metrics: AaMetric[];
}

/**
 * What a set of A/A reports must have in common: one environment, one profile and one baseline, or, for the PAIRED gate (ADR-179), one
 * control commit and one head commit: each pass of a paired check measured a control of its own, so there is no single baseline to
 * share. The machine is NOT one of them: reports of several jobs (several VMs, several CPU models) are accepted, and the summary says
 * which models the passes ran on. Paired and unpaired reports are not mixed. Throws, naming the first difference.
 */
function assertSameCondition(reports: readonly GateReport[]): void {
  const first = reports[0] as GateReport;
  const paired = first.paired !== undefined;
  reports.forEach((report, index) => {
    if (report.kind !== 'perf-gate-report') throw new Error(`report ${index + 1} is not a perf gate report`);
    if ((report.paired !== undefined) !== paired)
      throw new Error(
        `report ${index + 1} is ${report.paired !== undefined ? 'paired' : 'not paired'} and the first is ${paired ? 'paired' : 'not paired'}: an A/A check is either one baseline measured again and again or the paired gate measured again and again`,
      );
    for (const [what, a, b] of [
      ['environment', first.envId, report.envId],
      ['profile', first.profile, report.profile],
      ...(paired
        ? ([
            ['control commit', first.paired?.controlCommit, report.paired?.controlCommit],
            ['head commit', first.paired?.headCommit, report.paired?.headCommit],
          ] as const)
        : ([['baseline', first.baseline?.generatedAt, report.baseline?.generatedAt]] as const)),
    ] as const) {
      if (a !== b)
        throw new Error(
          `report ${index + 1} differs from the first in its ${what} (${String(b)} against ${String(a)}): an A/A check is ${paired ? 'one control and one head measured again and again' : 'one baseline measured again and again'}`,
        );
    }
    // A paired pass whose control could not be measured ended in exit code 2 and is counted as such: it has no baseline and is no misuse.
    if (report.baseline === null && !(paired && report.exitCode === 2))
      throw new Error(`report ${index + 1} has no baseline: there is nothing to run an A/A check against`);
    if (report.warnings.some((warning) => /ON PURPOSE/.test(warning)))
      throw new Error(
        `report ${index + 1} was run with an injection on purpose: it is a sensitivity check, not an A/A`,
      );
  });
}

/** The startup of a pass: `startupMs` of the first scenario of the report that measured it, the median of its first batch against the baseline's. */
function startupOf(report: GateReport): AaStartup | null {
  for (const scenario of report.scenarios) {
    const startup = scenario.metrics.find((metric) => metric.metric === 'startupMs');
    if (!startup) continue;
    const { median } = startup.first;
    return {
      scenario: scenario.id,
      baselineMedian: median.baseline,
      median: median.current,
      deviation: median.changeShare,
    };
  }
  return null;
}

/**
 * Summarizes the gate reports of an A/A check. The reports are taken in the order they were measured (`generatedAt`, whatever order they
 * are given in: a shell glob sorts `pass-10` before `pass-2`), so that the per-pass lists read as a time series.
 */
export function summarizeAa(given: readonly { file: string; report: GateReport }[]): AaSummary {
  if (given.length === 0) throw new Error('an A/A summary needs at least one gate report');
  const reports = [...given].sort((a, b) => a.report.generatedAt.localeCompare(b.report.generatedAt));
  assertSameCondition(reports.map(({ report }) => report));
  const first = (reports[0] as { report: GateReport }).report;

  const metrics = new Map<string, AaMetric>();
  const scenarios = new Set<string>();
  const runs: AaPass[] = [];
  const exitCodes = { '0': 0, '1': 0, '2': 0 };
  let firstBatchAlarms = 0;
  let notReproduced = 0;

  for (const { file, report } of reports) {
    exitCodes[String(report.exitCode) as '0' | '1' | '2'] += 1;
    const alarmed: string[] = [];
    for (const scenario of report.scenarios) {
      scenarios.add(scenario.id);
      const failedFirst = scenario.metrics.filter((metric) => metric.first.verdict === 'fail');
      if (failedFirst.length > 0) {
        alarmed.push(scenario.id);
        firstBatchAlarms += 1;
        if (!failedFirst.some((metric) => metric.verdict === 'regression')) notReproduced += 1;
      }
      for (const final of scenario.metrics) {
        const comparison = final.first;
        const key = `${scenario.id}/${comparison.metric}`;
        let entry = metrics.get(key);
        if (!entry) {
          entry = {
            scenario: scenario.id,
            metric: comparison.metric,
            unit: comparison.unit,
            gated: true,
            tailStatistic: comparison.tail.statistic,
            baseline: {
              median: comparison.median.baseline,
              tail: comparison.tail.baseline,
              cv: comparison.baselineCv,
              runs: comparison.baselineRuns,
            },
            allowed: { median: comparison.median.allowed, tail: comparison.tail.allowed },
            passes: 0,
            medians: [],
            tails: [],
            worst: { median: -Infinity, tail: -Infinity },
            perPass: [],
            firstBatchAlarms: 0,
            reproduced: 0,
            betweenBatch: { sd: null, relativeSd: null },
          };
          metrics.set(key, entry);
        }
        entry.passes += 1;
        if (final.first.verdict === 'tracked') entry.gated = false;
        entry.medians.push(comparison.median.current);
        entry.tails.push(comparison.tail.current);
        entry.worst.median = Math.max(entry.worst.median, comparison.median.worseBy);
        entry.worst.tail = Math.max(entry.worst.tail, comparison.tail.worseBy);
        entry.perPass.push({
          worse: { median: comparison.median.worseBy, tail: comparison.tail.worseBy },
          allowed: { median: comparison.median.allowed, tail: comparison.tail.allowed },
        });
        if (final.first.verdict === 'fail') entry.firstBatchAlarms += 1;
        if (final.verdict === 'regression') entry.reproduced += 1;
      }
    }
    const batches = report.scenarios.flatMap((scenario) => [scenario.first, scenario.remeasure]);
    const ordered = batches.filter((batch): batch is NonNullable<typeof batch> => batch !== null);
    runs.push({
      file,
      generatedAt: report.generatedAt,
      exitCode: report.exitCode,
      alarmedScenarios: alarmed,
      load: report.current.machine
        ? { before: report.current.machine.loadBeforeProfile, after: report.current.machine.loadAfterProfile }
        : ordered.length > 0
          ? {
              before: (ordered[0] as { loadAverage: { before: number } }).loadAverage.before,
              after: (ordered[ordered.length - 1] as { loadAverage: { after: number } }).loadAverage.after,
            }
          : null,
      problems: report.problems.map((problem) => problem.message),
      cpuModel: report.current.host.cpuModel ?? null,
      startup: startupOf(report),
    });
  }

  for (const entry of metrics.values()) {
    const sd = entry.medians.length >= 2 ? stdDev(entry.medians) : null;
    entry.betweenBatch = {
      sd,
      relativeSd: sd === null || entry.baseline.median === 0 ? null : sd / Math.abs(entry.baseline.median),
    };
  }

  const ordered = [...metrics.values()];
  const machine = first.current.machine;
  const passesOn = new Map<string, number>();
  for (const run of runs)
    if (run.cpuModel !== null) passesOn.set(run.cpuModel, (passesOn.get(run.cpuModel) ?? 0) + 1);
  // The baseline of the first pass that had one: every pass has it unpaired; a paired pass whose control failed has none.
  const withBaseline = reports.find(({ report }) => report.baseline !== null)?.report;
  const baseline = withBaseline?.baseline;
  if (!withBaseline || !baseline)
    throw new Error(
      'no pass has a baseline (the control of every paired pass failed): there is nothing to summarize',
    );
  return {
    schemaVersion: 1,
    kind: 'perf-aa',
    envId: first.envId,
    profile: first.profile,
    passes: reports.length,
    scenarios: [...scenarios].sort(),
    baseline: {
      file: baseline.file,
      generatedAt: baseline.generatedAt,
      commit: baseline.commit,
      browserVersion: baseline.browserVersion,
      runsPerScenario: baseline.runsPerScenario,
      cpuModel: withBaseline.cpuModels?.baseline ?? null,
    },
    paired: first.paired
      ? {
          controlRef: first.paired.controlRef,
          controlCommit: first.paired.controlCommit,
          headCommit: first.paired.headCommit,
          aa: first.paired.aa,
        }
      : null,
    exitCodes,
    falsePositives: exitCodes['1'],
    firstBatchAlarms,
    notReproduced,
    host: {
      cpus: first.current.host.cpus,
      memoryGiB: first.current.host.memoryGiB,
      node: first.current.host.node,
      playwright: first.current.host.playwright,
      invokedVia: machine?.invokedVia ?? null,
      dockerCpus: machine?.dockerCpus ?? null,
    },
    machines: {
      cpuModels: [...passesOn]
        .map(([model, passes]) => ({ model, passes }))
        .sort((a, b) => b.passes - a.passes || a.model.localeCompare(b.model)),
      passesWithoutCpuModel: runs.filter((run) => run.cpuModel === null).length,
    },
    runs,
    metrics: ordered,
  };
}

/**
 * The share of its allowance that the worst pass used: 1 is exactly at the limit, above 1 an alarm. A pass that was not worse than the
 * baseline used none of it. Null when nothing was allowed to be measured against; Infinity when the allowance is zero and was exceeded.
 */
export function allowanceUsed(worst: number, allowed: number | null): number | null {
  if (allowed === null || !Number.isFinite(worst)) return null;
  if (worst <= 0) return 0;
  return allowed === 0 ? Infinity : worst / allowed;
}

// ------------------------------------------------------------------------------------------------------------------- Markdown

const num = (value: number | null, unit: MetricUnit): string => {
  if (value === null) return '-';
  const text = String(Number(value.toPrecision(4)));
  return unit === 'ms' || unit === 'fps' ? `${text} ${unit}` : text;
};

const share = (value: number | null): string =>
  value === null ? '-' : value === Infinity ? 'over' : `${(value * 100).toFixed(0)} %`;

/** The first line of a message: a problem of the harness carries the player's whole event log, which belongs in the JSON and not in a table. */
const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0] ?? '';

const signedShare = (value: number | null): string =>
  value === null ? '-' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} %`;

/** What the passes ran on, in a sentence: the baseline's CPU model, and every model the passes ran on with its number of passes. */
function machinesBullet(summary: AaSummary): string {
  const { cpuModels, passesWithoutCpuModel } = summary.machines;
  const baseline = summary.baseline.cpuModel ?? 'not recorded';
  if (cpuModels.length === 0)
    return `- CPU models: the passes did not record theirs (the baseline was recorded on: ${baseline}).`;
  const plural = (n: number): string => `${n} ${n === 1 ? 'pass' : 'passes'}`;
  const list = cpuModels.map(({ model, passes }) => `${model} (${plural(passes)})`).join(', ');
  const count = cpuModels.length === 1 ? '1 CPU model' : `${cpuModels.length} distinct CPU models`;
  return [
    `- CPU models: the baseline was recorded on ${baseline}. The passes ran on ${count}: ${list}.`,
    passesWithoutCpuModel > 0 ? ` ${plural(passesWithoutCpuModel)} did not record theirs.` : '',
    cpuModels.length > 1
      ? ' The passes did not all run on the same machine, so the spread between them includes the difference between machines.'
      : '',
  ].join('');
}

/** The verdict of a pass, in words: an alarm that did not reproduce is still a pass, and says that it cost a fresh batch. */
function passVerdict(run: AaPass): string {
  if (run.exitCode === 1) return 'REGRESSION (false positive)';
  if (run.exitCode === 2) return 'problem (exit code 2)';
  return run.alarmedScenarios.length > 0
    ? `pass (first batch alarmed in ${run.alarmedScenarios.join(', ')}, not reproduced)`
    : 'pass';
}

/** One row per pass, in the order measured: its verdict, the CPU model it ran on and its startup against the baseline's. */
function passTable(summary: AaSummary): string[] {
  const scenario = summary.runs.find((run) => run.startup !== null)?.startup?.scenario;
  const cell = (text: string): string => text.replace(/\|/g, '\\|');
  return [
    scenario === undefined
      ? 'Every pass, in the order it was measured (no pass measured startup):'
      : `Every pass, in the order it was measured (startup is ${scenario} startupMs: the median of the first batch of the pass against the median of the baseline):`,
    '',
    '| pass | verdict | CPU model | startup median vs baseline median | deviation |',
    '| --- | --- | --- | --- | --- |',
    ...summary.runs.map(
      (run, index) =>
        `| ${index + 1} | ${cell(passVerdict(run))} | ${cell(run.cpuModel ?? 'not recorded')} | ${run.startup === null ? '-' : `${num(run.startup.median, 'ms')} vs ${num(run.startup.baselineMedian, 'ms')}`} | ${signedShare(run.startup?.deviation ?? null)} |`,
    ),
  ];
}

/**
 * The most of its allowance a metric used in any pass, each pass against its own baseline (the control it measured, when paired): with one
 * baseline for every pass it is the worst pass against that baseline.
 */
function worstShare(metric: AaMetric, which: 'median' | 'tail'): number | null {
  let best: number | null = null;
  for (const pass of metric.perPass) {
    const used = allowanceUsed(pass.worse[which], pass.allowed[which]);
    if (used !== null && (best === null || used > best)) best = used;
  }
  return best;
}

/** What the passes were, in a sentence: the committed baseline measured again and again, or the paired gate. */
function introOf(summary: AaSummary): string {
  const scenarios = `Scenarios: ${summary.scenarios.join(', ')}.`;
  const paired = summary.paired;
  if (paired === null)
    return `The gate was run **${summary.passes} times** against its own baseline (recorded ${summary.baseline.generatedAt.slice(0, 10)} at commit \`${summary.baseline.commit ?? 'unknown'}\`, browser ${summary.baseline.browserVersion}) on the same build, with nothing changed. ${scenarios}`;
  const sha = (commit: string | null): string => (commit === null ? 'unknown' : commit.slice(0, 12));
  return `The **paired** gate was run **${summary.passes} times**: each pass measured its control (commit \`${sha(paired.controlCommit)}\`) with the control's own harness on the machine it ran on, minutes before the head (commit \`${sha(paired.headCommit)}\`), and judged the head against it${paired.aa ? ' (an A/A by construction: the control is the head)' : ''}, with nothing changed. The committed baselines were not used. ${scenarios}`;
}

/** The A/A summary as Markdown: the verdict first, then, per gated metric, how much of its allowance the honest noise used. */
export function renderAaMarkdown(summary: AaSummary): string {
  const lines: string[] = [
    `## A/A check: ${summary.profile} in \`${summary.envId}\``,
    '',
    introOf(summary),
    '',
    `- **False positives (exit code 1): ${summary.falsePositives} of ${summary.passes}.**`,
    `- Exit codes: 0 x ${summary.exitCodes['0']}, 1 x ${summary.exitCodes['1']}, 2 x ${summary.exitCodes['2']}.`,
    ...(summary.exitCodes['2'] > 0
      ? [
          `- **Passes that could not be trusted (exit code 2): ${summary.exitCodes['2']} of ${summary.passes}.** They are not false positives: the measurement failed, and what is in the table comes from the other passes. The first line of each problem is listed below; the JSON keeps the whole message.`,
        ]
      : []),
    `- First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): ${summary.firstBatchAlarms}; of those ${summary.notReproduced} did not reproduce.`,
    machinesBullet(summary),
    '',
    `How much of its allowance each gated metric used in the worst pass (100 % is exactly at the limit, anything above is an alarm)${summary.paired ? ', each pass against its own control; the baseline, CV and allowed columns are those of the first pass that had a control' : ''}:`,
    '',
    '| scenario | metric | baseline median / tail | CV | allowed (median / tail) | worst pass: median / tail worse by | allowance used | between-batch SD of the median |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const m of summary.metrics.filter((metric) => metric.gated)) {
    lines.push(
      `| ${m.scenario} | ${m.metric} | ${num(m.baseline.median, m.unit)} / ${num(m.baseline.tail, m.unit)} | ${m.baseline.cv === null ? '-' : `${(m.baseline.cv * 100).toFixed(1)} %`} | ${num(m.allowed.median, m.unit)} / ${num(m.allowed.tail, m.unit)} | ${num(m.worst.median, m.unit)} / ${num(m.worst.tail, m.unit)} | ${share(worstShare(m, 'median'))} / ${share(worstShare(m, 'tail'))} | ${num(m.betweenBatch.sd, m.unit)}${m.betweenBatch.relativeSd === null ? '' : ` (${(m.betweenBatch.relativeSd * 100).toFixed(1)} %)`} |`,
    );
  }
  const tracked = summary.metrics.filter((metric) => !metric.gated);
  if (tracked.length > 0) {
    lines.push(
      '',
      `Tracked, not gated: ${tracked.map((metric) => `${metric.scenario} ${metric.metric}`).join(', ')}.`,
    );
  }
  lines.push('', ...passTable(summary));
  const problems = summary.runs.filter((run) => run.problems.length > 0);
  for (const run of problems)
    lines.push('', `> Problem in ${run.file}: ${run.problems.map(firstLine).join('; ')}`);
  return `${lines.join('\n')}\n`;
}
