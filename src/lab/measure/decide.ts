import { PERF_LIMITS } from '../../shared/criteria.ts';
import type { Baseline, BaselineMetric, ScenarioBaseline } from './baseline.ts';
import { startRungOf } from './baseline.ts';
import { describeRule, rulesFrom, tailStatistic } from './rules.ts';
import type { MetricRule, PerfLimits } from './rules.ts';
import { summarize } from './stats.ts';
import type { Summary } from './stats.ts';
import type { BatchMeasurement, MetricSpec, MetricUnit, ScenarioSpec } from './types.ts';

// The decision logic of the gate, as pure functions of a baseline, a batch of runs and the policy: no browser, no clock, no disk. It is
// where "a regression must reproduce" (ADR-004, ADR-125) is written down, so it is the part with the most tests, and the part the
// mutation checks of the report target (flip a comparison, drop the floor).
//
// Vocabulary. A BATCH is the warm-up plus N measured runs of one scenario in one browser process. A batch is JUDGED against the baseline
// metric by metric (`judgeBatch`). A scenario whose first batch failed is measured again in a fresh batch and the two are SETTLED
// (`settle`): a metric is a regression only if both batches failed it. The exit code (`exitCodeOf`) separates what is wrong with the code
// (1) from what is wrong with the measurement (2).

export type StatName = 'median' | 'p90' | 'p10';

export interface StatComparison {
  statistic: StatName;
  baseline: number;
  current: number;
  /** current - baseline, signed, in the unit of the metric. */
  change: number;
  /** change / |baseline|; null when the baseline is zero and a share has no meaning. */
  changeShare: number | null;
  /** How much worse than the baseline: positive is worse, negative is better (the sign follows the direction that hurts). */
  worseBy: number;
  /** The most it may be worse by and still pass (the share of the baseline value or the floor, whichever is larger; or the budget). Null when the metric is not gated. */
  allowed: number | null;
  /** Strictly more than `allowed`: exactly at the limit passes. Always false when nothing is allowed to be judged. */
  exceeded: boolean;
}

export type Verdict = 'pass' | 'fail' | 'tracked';

export interface MetricComparison {
  metric: string;
  label: string;
  unit: MetricUnit;
  /** The rule that was applied; null when the metric is not gated at all. */
  rule: MetricRule | null;
  /** `tracked`: reported but never fails: the metric has no rule, or its baseline cannot support one (`reason` says which). */
  verdict: Verdict;
  /** One sentence for the table and the log: what failed by how much, or why it is only tracked. */
  reason: string;
  baselineRuns: number;
  currentRuns: number;
  baselineCv: number | null;
  median: StatComparison;
  tail: StatComparison;
}

/** Why a measurement cannot be judged at all. Never a regression: it is the environment or the harness. */
export interface Problem {
  scenario: string;
  metric?: string;
  message: string;
}

export interface BatchJudgement {
  scenario: string;
  comparisons: MetricComparison[];
  problems: Problem[];
  /** At least one gated metric failed. */
  failed: boolean;
}

/** Within this relative distance of a limit two numbers are the same (a limit computed as 0.1 + 0.2 must still be "exactly at"). */
const SAME = 1e-9;

/** Strictly more than the limit, tolerant of the last bits of a floating-point product. */
export function exceeds(worseBy: number, allowed: number): boolean {
  return worseBy - allowed > SAME * Math.max(1, Math.abs(allowed));
}

function compareStatistic(
  statistic: StatName,
  baseline: number,
  current: number,
  worse: 'higher' | 'lower',
  allowed: number | null,
): StatComparison {
  const change = current - baseline;
  const worseBy = worse === 'higher' ? change : -change;
  return {
    statistic,
    baseline,
    current,
    change,
    changeShare: baseline === 0 ? null : change / Math.abs(baseline),
    worseBy,
    allowed,
    exceeded: allowed !== null && exceeds(worseBy, allowed),
  };
}

const percent = (share: number): string => `${(share * 100).toFixed(1)} %`;

/** A number with the unit of its metric: `148 ms`, `29.4 fps`, `0.012`. */
export function formatAmount(value: number, unit: MetricUnit): string {
  const text = String(Number(value.toPrecision(4)));
  return unit === 'ms' || unit === 'fps' ? `${text} ${unit}` : text;
}

export interface CompareOptions {
  limits?: PerfLimits;
}

/**
 * One metric of a batch against the same metric of the baseline. `rule` null means "not gated": the comparison is still computed (a
 * reader wants to see the change) but its verdict is `tracked`.
 */
export function compareMetric(
  spec: MetricSpec,
  rule: MetricRule | null,
  baseline: Summary,
  current: Summary,
  limits: PerfLimits = PERF_LIMITS,
): MetricComparison {
  const worse = rule?.worse ?? 'higher';
  const tail = rule ? tailStatistic(rule) : 'p90';
  const tailOf = (s: Summary): number => (tail === 'p10' ? s.p10 : s.p90);

  let medianAllowed: number | null = null;
  let tailAllowed: number | null = null;
  if (rule?.kind === 'relative') {
    medianAllowed = Math.max(rule.medianShare * Math.abs(baseline.median), rule.floor);
    tailAllowed = Math.max(rule.tailShare * Math.abs(tailOf(baseline)), rule.floor);
  } else if (rule?.kind === 'budget') {
    medianAllowed = rule.medianBudget;
    tailAllowed = rule.tailBudget;
  }
  const median = compareStatistic('median', baseline.median, current.median, worse, medianAllowed);
  const tailComparison = compareStatistic(tail, tailOf(baseline), tailOf(current), worse, tailAllowed);

  const base = {
    metric: spec.id,
    label: spec.label,
    unit: spec.unit,
    rule,
    baselineRuns: baseline.n,
    currentRuns: current.n,
    baselineCv: baseline.cv,
    median,
    tail: tailComparison,
  };
  const verdict = (v: Verdict, reason: string): MetricComparison => ({ ...base, verdict: v, reason });

  if (rule === null) return verdict('tracked', 'tracked, not gated: this metric has no rule');

  // TEST_STRATEGY.md section 7.1: a metric gates only once its baseline is stable enough to tell a regression from noise.
  if (rule.kind === 'relative') {
    if (baseline.n < 2) {
      return verdict(
        'tracked',
        'tracked, not gated: the baseline is one run, which says nothing about run-to-run noise',
      );
    }
    if (baseline.cv !== null && baseline.cv > limits.maxBaselineCv) {
      const would = median.exceeded || tailComparison.exceeded ? ' (it would have failed)' : '';
      return verdict(
        'tracked',
        `tracked, not gated: the baseline's coefficient of variation is ${percent(baseline.cv)}, above the stability limit of ${percent(limits.maxBaselineCv)}${would}`,
      );
    }
  }

  const failures: string[] = [];
  for (const stat of [median, tailComparison]) {
    if (!stat.exceeded || stat.allowed === null) continue;
    const share =
      stat.changeShare === null ? '' : ` (${stat.change >= 0 ? '+' : ''}${percent(stat.changeShare)})`;
    failures.push(
      `${stat.statistic} ${formatAmount(stat.baseline, spec.unit)} -> ${formatAmount(stat.current, spec.unit)}${share}: worse by ${formatAmount(stat.worseBy, spec.unit)}, more than the ${formatAmount(stat.allowed, spec.unit)} allowed`,
    );
  }
  if (failures.length > 0) return verdict('fail', failures.join('; '));
  return verdict(
    'pass',
    `within the limits (${describeRule(rule, (amount) => formatAmount(amount, spec.unit))})`,
  );
}

/** The start rung a batch began on, as text. */
const rungText = (height: number | null): string => (height === null ? 'an unknown rung' : `${height}p`);

/**
 * A batch against the baseline of its scenario. Collects the problems that make the comparison meaningless (a different stream, a
 * different start rung where it matters, a metric that was not produced) instead of judging numbers that cannot be compared.
 */
export function judgeBatch(
  spec: ScenarioSpec,
  baseline: ScenarioBaseline,
  batch: BatchMeasurement,
  limits: PerfLimits = PERF_LIMITS,
): BatchJudgement {
  const problems: Problem[] = [];
  const problem = (message: string, metric?: string): void => {
    problems.push({ scenario: spec.id, ...(metric === undefined ? {} : { metric }), message });
  };
  const rules = rulesFrom(limits);

  if (batch.runs.length === 0) problem('the batch has no measured run');

  for (const [what, was, now] of [
    ['stream', baseline.stream, batch.stream],
    ['protocol', baseline.protocol, batch.protocol],
    ['fault profile', baseline.faultProfile, batch.faultProfile],
    ['pinned rung', baseline.pinnedHeight, batch.pinnedHeight],
  ] as const) {
    if (was !== now)
      problem(
        `the baseline measured ${what} ${String(was)} and this batch ${String(now)}: the numbers are not comparable, record the baseline again`,
      );
  }

  if (spec.startRungMatters && batch.runs.length > 0) {
    const start = startRungOf(batch.runs);
    if (!start.unanimous) {
      const seen = [...new Set(start.heights)].map(rungText).join(' and ');
      problem(
        `the runs of this batch did not start on the same rung (${seen}): one startup distribution cannot mix rungs`,
      );
    } else if (start.height !== baseline.startRungHeight) {
      problem(
        `the player started on ${rungText(start.height)} here and on ${rungText(baseline.startRungHeight)} in the baseline: ${spec.name} depends on the first rung, so the two are not comparable (the first rung follows the browser's reported downlink: see ADR-064 in docs/decisions/player.md)`,
      );
    }
  }

  const comparisons: MetricComparison[] = [];
  for (const metric of spec.metrics) {
    const rule = metric.rule === null ? null : rules[metric.rule];
    const was: BaselineMetric | undefined = baseline.metrics[metric.id];
    const values = batch.runs.map((run) => run.values[metric.id] ?? null);
    const present = values.filter((value): value is number => value !== null);

    if (rule !== null) {
      const missing = values.flatMap((value, index) => (value === null ? [index + 1] : []));
      if (missing.length > 0) {
        problem(`${metric.id} was not produced by run ${missing.join(', ')}, and it gates`, metric.id);
        continue;
      }
      if (!was?.summary) {
        problem(
          `the baseline has no value for ${metric.id}, and it gates: record the baseline again`,
          metric.id,
        );
        continue;
      }
    }
    if (!was?.summary || present.length === 0) continue; // a tracked metric nobody produced: nothing to show

    comparisons.push(compareMetric(metric, rule, was.summary, summarize(present), limits));
  }

  return { scenario: spec.id, comparisons, problems, failed: comparisons.some((c) => c.verdict === 'fail') };
}

export type FinalVerdict = 'pass' | 'regression' | 'not-reproduced' | 'tracked';

export interface FinalMetric {
  metric: string;
  verdict: FinalVerdict;
  first: MetricComparison;
  /** The same metric in the fresh batch, when the first one failed it. */
  remeasure: MetricComparison | null;
}

export interface ScenarioOutcome {
  scenario: string;
  status: 'pass' | 'regression' | 'problem';
  metrics: FinalMetric[];
  problems: Problem[];
  /** Whether a fresh batch was measured to confirm a first failure. */
  remeasured: boolean;
}

/** Whether the first batch of a scenario calls for a fresh one: it could be judged and a gated metric failed. */
export function needsRemeasure(first: BatchJudgement): boolean {
  return first.problems.length === 0 && first.failed;
}

/**
 * Settles a scenario from its first batch and, when that failed, the fresh batch measured to confirm it. A metric that failed twice is a
 * REGRESSION; one that failed once and passed the second time is NOT REPRODUCED (the build passes, the report says so). The second batch
 * is judged on its own, not pooled with the first: "does it fail again on fresh runs in a fresh browser" is the question.
 */
export function settle(first: BatchJudgement, remeasure: BatchJudgement | null): ScenarioOutcome {
  if (first.problems.length > 0) {
    return {
      scenario: first.scenario,
      status: 'problem',
      metrics: [],
      problems: first.problems,
      remeasured: false,
    };
  }
  if (!first.failed) {
    return {
      scenario: first.scenario,
      status: 'pass',
      metrics: first.comparisons.map((c) => ({
        metric: c.metric,
        verdict: c.verdict === 'tracked' ? 'tracked' : 'pass',
        first: c,
        remeasure: null,
      })),
      problems: [],
      remeasured: false,
    };
  }
  if (remeasure === null) {
    throw new Error(
      `settle(${first.scenario}): the first batch failed, so a fresh batch is needed to settle it`,
    );
  }
  if (remeasure.problems.length > 0) {
    return {
      scenario: first.scenario,
      status: 'problem',
      metrics: [],
      problems: remeasure.problems,
      remeasured: true,
    };
  }
  const metrics = first.comparisons.map((c): FinalMetric => {
    if (c.verdict === 'tracked') return { metric: c.metric, verdict: 'tracked', first: c, remeasure: null };
    if (c.verdict === 'pass') return { metric: c.metric, verdict: 'pass', first: c, remeasure: null };
    const again = remeasure.comparisons.find((r) => r.metric === c.metric) ?? null;
    return {
      metric: c.metric,
      verdict: again?.verdict === 'fail' ? 'regression' : 'not-reproduced',
      first: c,
      remeasure: again,
    };
  });
  return {
    scenario: first.scenario,
    status: metrics.some((m) => m.verdict === 'regression') ? 'regression' : 'pass',
    metrics,
    problems: [],
    remeasured: true,
  };
}

export type ExitCode = 0 | 1 | 2;

export const EXIT_PASS = 0;
export const EXIT_REGRESSION = 1;
export const EXIT_PROBLEM = 2;

/** The exit code of several independent verdicts (one per profile): a regression wins over a problem, a problem over a pass. */
export function combineExitCodes(codes: readonly ExitCode[]): ExitCode {
  if (codes.includes(EXIT_REGRESSION)) return EXIT_REGRESSION;
  if (codes.includes(EXIT_PROBLEM)) return EXIT_PROBLEM;
  return EXIT_PASS;
}

/**
 * 0 passes, 1 a regression reproduced, 2 the measurement could not be trusted (no baseline, a changed stream, a browser that did not
 * start, a metric that was not produced). A regression that reproduced is a finding whatever else went wrong elsewhere, so it wins; any
 * other problem makes the verdict incomplete and the build fails without blaming the code.
 */
export function exitCodeOf(
  outcomes: readonly ScenarioOutcome[],
  problems: readonly Problem[] = [],
): ExitCode {
  if (outcomes.some((outcome) => outcome.status === 'regression')) return EXIT_REGRESSION;
  if (problems.length > 0 || outcomes.some((outcome) => outcome.status === 'problem')) return EXIT_PROBLEM;
  return EXIT_PASS;
}

// ------------------------------------------------------------------------------------------------------------- the environment

export interface CurrentEnvironment {
  /** Content hash of every stream a scenario played, as the running service reports it. */
  streams: Partial<Record<string, string>>;
  ffmpeg: string;
  /** The browser build, or null while it is not known yet (the streams are checked before any browser starts). */
  browserVersion: string | null;
  playwright: string;
  cpus: number;
}

/**
 * What changed between the machine that recorded the baseline and this run, besides the code. A different stream (its content hash)
 * makes every number incomparable: that is a problem. A different browser or Playwright version or CPU count may be the very reason a
 * number moved, so it is a warning for the reader and not a failure.
 */
export function compareEnvironment(
  baseline: Baseline,
  current: CurrentEnvironment,
): { problems: Problem[]; warnings: string[] } {
  const problems: Problem[] = [];
  const warnings: string[] = [];
  for (const [stream, hash] of Object.entries(current.streams)) {
    const recorded = baseline.streams[stream as keyof Baseline['streams']];
    if (recorded === undefined) continue;
    if (hash !== undefined && recorded !== hash) {
      problems.push({
        scenario: '*',
        message: `the content of stream ${stream} changed since the baseline was recorded (${recorded.slice(0, 12)} -> ${hash.slice(0, 12)}; ffmpeg ${baseline.ffmpeg} -> ${current.ffmpeg}): it is different media, so every baseline of this environment has to be recorded again, together`,
      });
    }
  }
  if (current.browserVersion !== null && baseline.browser.version !== current.browserVersion)
    warnings.push(
      `the browser is ${current.browserVersion}; the baseline was recorded on ${baseline.browser.version}`,
    );
  if (baseline.host.playwright !== current.playwright)
    warnings.push(
      `Playwright is ${current.playwright}; the baseline was recorded with ${baseline.host.playwright}`,
    );
  if (baseline.host.cpus !== current.cpus)
    warnings.push(
      `this machine has ${current.cpus} CPUs; the baseline was recorded on ${baseline.host.cpus}`,
    );
  return { problems, warnings };
}

export interface GatingStatus {
  scenario: string;
  metric: string;
  gates: boolean;
  /** Why not, when it does not gate. */
  reason: string | null;
}

/**
 * Which metrics of a baseline gate and which are only tracked, for `perf:baseline` to print and for the README to quote: a metric whose
 * baseline is too noisy (or a single run) is not a gate, and the reader should know before the gate silently skips it.
 */
export function gatingStatus(
  specs: readonly ScenarioSpec[],
  baseline: Baseline,
  limits: PerfLimits = PERF_LIMITS,
): GatingStatus[] {
  const rules = rulesFrom(limits);
  const statuses: GatingStatus[] = [];
  for (const spec of specs) {
    const scenario = baseline.scenarios[spec.id];
    for (const metric of spec.metrics) {
      const base = { scenario: spec.id, metric: metric.id };
      const summary = scenario?.metrics[metric.id]?.summary;
      if (metric.rule === null) {
        statuses.push({ ...base, gates: false, reason: 'no rule: tracked and reported only' });
        continue;
      }
      if (!summary) {
        statuses.push({ ...base, gates: false, reason: 'the baseline has no value for it' });
        continue;
      }
      const rule = rules[metric.rule];
      if (rule.kind === 'relative' && summary.n < 2) {
        statuses.push({ ...base, gates: false, reason: 'the baseline is one run' });
      } else if (rule.kind === 'relative' && summary.cv !== null && summary.cv > limits.maxBaselineCv) {
        statuses.push({
          ...base,
          gates: false,
          reason: `the baseline's coefficient of variation is ${percent(summary.cv)}, above the stability limit of ${percent(limits.maxBaselineCv)}`,
        });
      } else {
        statuses.push({ ...base, gates: true, reason: null });
      }
    }
  }
  return statuses;
}
