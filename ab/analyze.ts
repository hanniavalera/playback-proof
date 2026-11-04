import { mean, percentile, summarize } from '../src/lab/measure/stats.ts';
import { decide, failureGuard } from './decision.ts';
import type { Decision, MetricEvidence } from './decision.ts';
import { METRICS, METRIC_IDS, metricValue } from './metrics.ts';
import type { MetricId, MetricUnit } from './metrics.ts';
import { parsePreregistration, sha256Hex } from './prereg.ts';
import type { ExperimentKind, MetricPlan, Preregistration } from './prereg.ts';
import { ResultFileError } from './results.ts';
import type { ConditionResult, RawResult } from './results.ts';
import { bootstrapHodgesLehmann } from './stats/hodges-lehmann.ts';
import { cliffsDelta } from './stats/cliffs-delta.ts';
import type { CliffsDelta } from './stats/cliffs-delta.ts';
import { fisherExact } from './stats/fisher.ts';
import { holmAdjust } from './stats/holm.ts';
import { mannWhitneyU } from './stats/mann-whitney.ts';
import { newcombeDifference } from './stats/proportions.ts';
import { seedFrom } from './stats/random.ts';
import type { ArmId, SessionRecord } from './types.ts';

// The full pipeline of one comparison: the sessions of a condition in, every table of the report and the verdict out. It is a pure function
// of the sessions and the plan (the bootstrap is seeded), so the report can be regenerated from the raw results, the A/A calibration can
// run it on thousands of random splits, and the power analysis can run it on simulated experiments: all three exercise THE code that
// produces a verdict, not a copy of it.

export const ECDF_PROBABILITIES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** A start-rung stratum needs at least this many sessions in EACH arm to be compared at all (exploratory). */
export const MIN_STRATUM_PER_ARM = 5;

/** The parts of a pre-registration the analysis reads. */
export interface AnalysisPlan {
  kind: ExperimentKind;
  alpha: number;
  confidenceLevel: number;
  bootstrapResamples: number;
  seed: number;
  metrics: readonly MetricPlan[];
  maxFailedShare: number;
}

export function planOf(prereg: Preregistration): AnalysisPlan {
  return {
    kind: prereg.kind,
    alpha: prereg.alpha,
    confidenceLevel: 1 - prereg.alpha,
    bootstrapResamples: prereg.bootstrapResamples,
    seed: prereg.seed,
    metrics: prereg.metrics,
    maxFailedShare: prereg.exclusionRule.maxFailedShare,
  };
}

export interface ArmSummary {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

export interface ArmCounts {
  events: number;
  total: number;
  share: number;
}

export interface EffectEstimate {
  kind: 'hodges-lehmann' | 'share-difference';
  /** B minus A, in the unit of the metric. */
  estimate: number;
  low: number;
  high: number;
  level: number;
  method: string;
}

export interface MetricComparison {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  kind: 'continuous' | 'binary';
  role: 'primary' | 'secondary';
  direction: 'lower-is-better' | 'higher-is-better';
  /** The pre-registered practical threshold (null for a secondary metric without one). */
  threshold: number | null;
  nA: number;
  nB: number;
  /** Continuous metrics: the summary of each arm. */
  summaryA: ArmSummary | null;
  summaryB: ArmSummary | null;
  /** Binary metrics: the counts of each arm. */
  countsA: ArmCounts | null;
  countsB: ArmCounts | null;
  /** null when an arm has fewer than two analysed sessions. */
  effect: EffectEstimate | null;
  cliffs: CliffsDelta | null;
  test: { name: 'mann-whitney' | 'fisher'; method: string; p: number } | null;
  /** The Holm-adjusted p-value over the primary family (null for a secondary metric: it is not adjusted). */
  pAdjusted: number | null;
  /** Primary: adjusted p < alpha. Secondary: the RAW p < alpha, which is a description and not a finding. */
  significant: boolean;
  /** Quantiles of each arm at ECDF_PROBABILITIES (continuous metrics). */
  ecdf: { probabilities: readonly number[]; a: number[]; b: number[] } | null;
  warnings: string[];
}

export interface FailureSummary {
  attemptedA: number;
  attemptedB: number;
  failedA: number;
  failedB: number;
  /** Fisher's exact p-value of the failure counts between the arms (1 when nothing failed). */
  fisherP: number;
  guardTripped: boolean;
  guardWhy: string | null;
  sessions: Array<{ index: number; block: number; arm: ArmId; kind: string; message: string }>;
}

export interface StartRungComposition {
  A: Record<string, number>;
  B: Record<string, number>;
  /** Start rungs (heights) that sessions of both arms started on. */
  shared: string[];
  /** The arms never started on the same rung. */
  disjoint: boolean;
  /** The arms did not start on the same rungs in the same proportions (within 10 percentage points of each rung). */
  differs: boolean;
  note: string;
}

export interface ExploratoryRow {
  label: string;
  unit: MetricUnit;
  kind: 'continuous' | 'binary';
  nA: number;
  nB: number;
  effect: number | null;
  low: number | null;
  high: number | null;
  p: number | null;
  note: string;
}

export interface ExploratoryBlock {
  title: string;
  note: string;
  rows: ExploratoryRow[];
}

export interface ConditionAnalysis {
  warmup: { A: number; B: number };
  attempted: { A: number; B: number };
  analysed: { A: number; B: number };
  metrics: MetricComparison[];
  /** The Holm family: the primary metrics, in plan order. */
  family: MetricId[];
  failures: FailureSummary;
  startRungs: StartRungComposition;
  /** Sessions with a recoverable (severity 1) Shaka error, by arm. */
  recoverableErrors: { A: number; B: number };
  /** null for an exploratory comparison and for a pipeline check: they decide nothing. */
  decision: Decision | null;
  decisionNote: string | null;
  exploratory: ExploratoryBlock[];
}

export interface AnalyzeOptions {
  /** The exploratory blocks (not pre-registered): off in the calibration and the power simulations, which only need the verdict. */
  exploratory?: boolean;
}

function summarizeArm(values: readonly number[]): ArmSummary | null {
  if (values.length === 0) return null;
  const summary = summarize(values);
  return {
    n: summary.n,
    mean: mean(values),
    median: summary.median,
    p10: summary.p10,
    p90: summary.p90,
    min: summary.min,
    max: summary.max,
  };
}

function countsOf(values: readonly number[]): ArmCounts {
  const events = values.filter((value) => value >= 1).length;
  return { events, total: values.length, share: values.length === 0 ? 0 : events / values.length };
}

function valuesOf(sessions: readonly SessionRecord[], arm: ArmId, id: MetricId): number[] {
  const out: number[] = [];
  for (const session of sessions) {
    if (session.arm !== arm) continue;
    const value = metricValue(session, id);
    if (value !== null) out.push(value);
  }
  return out;
}

type Comparison = Omit<MetricComparison, 'role' | 'threshold' | 'pAdjusted' | 'significant' | 'direction'>;

/** One metric, two arms: the test, the effect with its interval, the effect size and the tables. */
function compare(plan: AnalysisPlan, id: MetricId, a: readonly number[], b: readonly number[]): Comparison {
  const definition = METRICS[id];
  const base = {
    id,
    label: definition.label,
    unit: definition.unit,
    kind: definition.kind,
    nA: a.length,
    nB: b.length,
    warnings: [] as string[],
  };
  const level = plan.confidenceLevel;
  if (definition.kind === 'binary') {
    const countsA = countsOf(a);
    const countsB = countsOf(b);
    if (a.length < 2 || b.length < 2)
      return {
        ...base,
        summaryA: null,
        summaryB: null,
        countsA,
        countsB,
        effect: null,
        cliffs: null,
        test: null,
        ecdf: null,
      };
    const difference = newcombeDifference(countsA, countsB, level);
    return {
      ...base,
      summaryA: null,
      summaryB: null,
      countsA,
      countsB,
      effect: {
        kind: 'share-difference',
        estimate: difference.difference,
        low: difference.lower,
        high: difference.upper,
        level,
        method: "difference of the shares, Newcombe's hybrid score interval",
      },
      cliffs: null,
      test: {
        name: 'fisher',
        method: 'exact (hypergeometric, two-sided)',
        p: fisherExact(countsA, countsB).p,
      },
      ecdf: null,
    };
  }
  const summaryA = summarizeArm(a);
  const summaryB = summarizeArm(b);
  if (a.length < 2 || b.length < 2)
    return {
      ...base,
      summaryA,
      summaryB,
      countsA: null,
      countsB: null,
      effect: null,
      cliffs: null,
      test: null,
      ecdf: null,
    };
  const mw = mannWhitneyU(a, b);
  const shift = bootstrapHodgesLehmann(a, b, {
    seed: seedFrom(plan.seed, 'bootstrap', id),
    resamples: plan.bootstrapResamples,
    level,
  });
  const warnings: string[] = [];
  if (shift.lower === shift.upper && (shift.estimate !== 0 || mw.u1 !== (a.length * b.length) / 2)) {
    warnings.push(
      "the interval of the shift collapsed to one value: more than half of the pairs of sessions tie at the same difference (typical of a count that is zero in most sessions), so the Hodges-Lehmann shift cannot see a change in the minority of sessions that have a value; read Cliff's delta and the share of sessions with one",
    );
  }
  return {
    ...base,
    warnings,
    summaryA,
    summaryB,
    countsA: null,
    countsB: null,
    effect: {
      kind: 'hodges-lehmann',
      estimate: shift.estimate,
      low: shift.lower,
      high: shift.upper,
      level,
      method: `Hodges-Lehmann shift, seeded percentile bootstrap interval (${shift.resamples} resamples)`,
    },
    cliffs: cliffsDelta(a, b),
    test: {
      name: 'mann-whitney',
      method:
        mw.method === 'exact'
          ? 'exact permutation distribution'
          : 'normal approximation with continuity and tie corrections',
      p: mw.p,
    },
    ecdf: {
      probabilities: ECDF_PROBABILITIES,
      a: ECDF_PROBABILITIES.map((q) => percentile(a, q)),
      b: ECDF_PROBABILITIES.map((q) => percentile(b, q)),
    },
  };
}

const startHeightKey = (session: SessionRecord): string =>
  session.startRungHeight === null ? 'unknown' : String(session.startRungHeight);

function startRungComposition(analysed: readonly SessionRecord[]): StartRungComposition {
  const count = (arm: ArmId): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const session of analysed)
      if (session.arm === arm) out[startHeightKey(session)] = (out[startHeightKey(session)] ?? 0) + 1;
    return out;
  };
  const A = count('A');
  const B = count('B');
  const totalA = Object.values(A).reduce((sum, n) => sum + n, 0);
  const totalB = Object.values(B).reduce((sum, n) => sum + n, 0);
  const heights = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort((x, y) => Number(x) - Number(y));
  const shared = heights.filter((height) => (A[height] ?? 0) > 0 && (B[height] ?? 0) > 0);
  const differs = heights.some(
    (height) =>
      Math.abs((A[height] ?? 0) / Math.max(1, totalA) - (B[height] ?? 0) / Math.max(1, totalB)) > 0.1,
  );
  const disjoint = totalA > 0 && totalB > 0 && shared.length === 0;
  const show = (counts: Record<string, number>): string =>
    Object.entries(counts)
      .sort(([x], [y]) => Number(x) - Number(y))
      .map(([height, n]) => `${height}p: ${n}`)
      .join(', ') || 'none';
  let note: string;
  if (disjoint) {
    note =
      `The arms never started on the same rung (A: ${show(A)}; B: ${show(B)}). Any difference in startup, and in the first seconds of playback, includes whatever the first rung does: ` +
      'the first rung is set by the configuration (ADR-064), and the two configurations are compared as shipped, so this experiment cannot say how much of a difference is the first rung and how much is the rest of the configuration. ' +
      'A rung-matched comparison is not possible with these data.';
  } else if (differs) {
    note = `The arms started on different rungs in different proportions (A: ${show(A)}; B: ${show(B)}): part of any early difference is the first rung. A comparison within the rungs both arms started on is in the exploratory section.`;
  } else {
    note = `Both arms started on the same rungs in about the same proportions (A: ${show(A)}; B: ${show(B)}).`;
  }
  return { A, B, shared, disjoint, differs, note };
}

function failureSummary(plan: AnalysisPlan, measured: readonly SessionRecord[]): FailureSummary {
  const failed = measured.filter((session) => session.status === 'failed');
  const attempted = (arm: ArmId): number => measured.filter((session) => session.arm === arm).length;
  const failedIn = (arm: ArmId): number => failed.filter((session) => session.arm === arm).length;
  const attemptedA = attempted('A');
  const attemptedB = attempted('B');
  const failedA = failedIn('A');
  const failedB = failedIn('B');
  const fisherP =
    attemptedA === 0 || attemptedB === 0
      ? 1
      : fisherExact({ events: failedA, total: attemptedA }, { events: failedB, total: attemptedB }).p;
  const guard = failureGuard(
    { attemptedA, attemptedB, failedA, failedB, fisherP, maxShare: plan.maxFailedShare },
    plan.alpha,
  );
  return {
    attemptedA,
    attemptedB,
    failedA,
    failedB,
    fisherP,
    guardTripped: guard.tripped,
    guardWhy: guard.why,
    sessions: failed.map((session) => ({
      index: session.index,
      block: session.block,
      arm: session.arm,
      kind: session.failure?.kind ?? 'unknown',
      message: session.failure?.message ?? '',
    })),
  };
}

/** A recoverable Shaka error is `code name/1` in the session's error digest: the session still played, and its metrics count. */
function hasRecoverableError(session: SessionRecord): boolean {
  return session.errors.some((error) => /\/1$/.test(error));
}

function rowOf(
  label: string,
  id: MetricId,
  plan: AnalysisPlan,
  a: readonly number[],
  b: readonly number[],
  note: string,
): ExploratoryRow {
  const comparison = compare(plan, id, a, b);
  return {
    label,
    unit: comparison.unit,
    kind: comparison.kind,
    nA: comparison.nA,
    nB: comparison.nB,
    effect: comparison.effect?.estimate ?? null,
    low: comparison.effect?.low ?? null,
    high: comparison.effect?.high ?? null,
    p: comparison.test?.p ?? null,
    note,
  };
}

function exploratoryBlocks(
  plan: AnalysisPlan,
  analysed: readonly SessionRecord[],
  composition: StartRungComposition,
): ExploratoryBlock[] {
  const blocks: ExploratoryBlock[] = [];
  const planned = new Set(plan.metrics.map((metric) => metric.id));
  const others = METRIC_IDS.filter((id) => !planned.has(id));
  const otherRows = others
    .filter((id) => valuesOf(analysed, 'A', id).length > 0 && valuesOf(analysed, 'B', id).length > 0)
    .map((id) =>
      rowOf(
        METRICS[id].label,
        id,
        plan,
        valuesOf(analysed, 'A', id),
        valuesOf(analysed, 'B', id),
        'not pre-registered',
      ),
    );
  if (otherRows.length > 0) {
    blocks.push({
      title: 'Metrics that were not pre-registered',
      note: 'Recorded in every session and compared here with the same tests, but with raw p-values, no adjustment and no threshold: they describe, they decide nothing, and one in twenty of them will look significant by chance.',
      rows: otherRows,
    });
  }
  const strata = [...new Set([...Object.keys(composition.A), ...Object.keys(composition.B)])].sort(
    (x, y) => Number(x) - Number(y),
  );
  const rows: ExploratoryRow[] = [];
  for (const height of strata) {
    const inStratum = analysed.filter((session) => startHeightKey(session) === height);
    const a = valuesOf(inStratum, 'A', 'startupMs');
    const b = valuesOf(inStratum, 'B', 'startupMs');
    if (a.length >= MIN_STRATUM_PER_ARM && b.length >= MIN_STRATUM_PER_ARM) {
      rows.push(
        rowOf(
          `Startup time of the sessions that started on ${height}p`,
          'startupMs',
          plan,
          a,
          b,
          'exploratory: a stratum, not randomised',
        ),
      );
    }
  }
  blocks.push({
    title: 'Startup within the rung the sessions started on (rung-matched)',
    note:
      rows.length > 0
        ? `Only the rungs that at least ${MIN_STRATUM_PER_ARM} sessions of each arm started on can be compared. Which rung a session starts on is decided by the configuration, not by chance, so this is not a randomised comparison.`
        : `No start rung was reached by at least ${MIN_STRATUM_PER_ARM} sessions of both arms: a rung-matched comparison is not possible with these data.`,
    rows,
  });
  return blocks;
}

/**
 * The full pipeline for the sessions of ONE condition. Warm-up sessions are ignored; a failed session is counted and listed but has no
 * metrics; the primary metrics form the Holm family; the decision rule is applied when the kind of experiment decides.
 */
export function analyzeCondition(
  plan: AnalysisPlan,
  sessions: readonly SessionRecord[],
  options: AnalyzeOptions = {},
): ConditionAnalysis {
  const measured = sessions.filter((session) => !session.warmup);
  const analysed = measured.filter((session) => session.status === 'ok');
  const inArm = (list: readonly SessionRecord[], arm: ArmId): number =>
    list.filter((session) => session.arm === arm).length;

  const comparisons: MetricComparison[] = plan.metrics.map((metric) => {
    const result = compare(
      plan,
      metric.id,
      valuesOf(analysed, 'A', metric.id),
      valuesOf(analysed, 'B', metric.id),
    );
    return {
      ...result,
      role: metric.role,
      direction: metric.direction,
      threshold: metric.practicalThreshold ?? null,
      pAdjusted: null,
      significant: false,
    };
  });
  const primary = comparisons.filter((comparison) => comparison.role === 'primary');
  const adjusted = holmAdjust(primary.map((comparison) => comparison.test?.p ?? 1));
  primary.forEach((comparison, index) => {
    comparison.pAdjusted = adjusted[index] as number;
    comparison.significant = (adjusted[index] as number) < plan.alpha;
  });
  for (const comparison of comparisons) {
    if (comparison.role === 'secondary')
      comparison.significant = comparison.test !== null && comparison.test.p < plan.alpha;
  }

  const failures = failureSummary(plan, measured);
  const decides = plan.kind === 'experiment' || plan.kind === 'aa';
  let decision: Decision | null = null;
  let decisionNote: string | null = null;
  if (decides) {
    const evidence: MetricEvidence[] = primary.map((comparison) => {
      if (comparison.threshold === null)
        throw new Error(
          `the primary metric ${comparison.id} has no practical threshold: the decision rule cannot be applied`,
        );
      return {
        id: comparison.id,
        label: comparison.label,
        unit: comparison.unit,
        direction: comparison.direction,
        threshold: comparison.threshold,
        effect: comparison.effect?.estimate ?? 0,
        ciLow: comparison.effect?.low ?? 0,
        ciHigh: comparison.effect?.high ?? 0,
        pAdjusted: comparison.pAdjusted ?? 1,
        nA: comparison.nA,
        nB: comparison.nB,
        level: plan.confidenceLevel,
      };
    });
    decision = decide({
      alpha: plan.alpha,
      metrics: evidence,
      failures: {
        attemptedA: failures.attemptedA,
        attemptedB: failures.attemptedB,
        failedA: failures.failedA,
        failedB: failures.failedB,
        fisherP: failures.fisherP,
        maxShare: plan.maxFailedShare,
      },
    });
  } else if (plan.kind === 'exploratory') {
    decisionNote =
      'This is an exploratory comparison: it estimates and decides nothing. The effects, intervals and p-values below describe these sessions; no ship decision follows from them.';
  } else {
    decisionNote =
      'This is a pipeline check: a few sessions that show the harness runs end to end. Its statistics are printed to show the report works; they decide nothing.';
  }

  const startRungs = startRungComposition(analysed);
  return {
    warmup: {
      A: inArm(
        sessions.filter((s) => s.warmup),
        'A',
      ),
      B: inArm(
        sessions.filter((s) => s.warmup),
        'B',
      ),
    },
    attempted: { A: inArm(measured, 'A'), B: inArm(measured, 'B') },
    analysed: { A: inArm(analysed, 'A'), B: inArm(analysed, 'B') },
    metrics: comparisons,
    family: primary.map((comparison) => comparison.id),
    failures,
    startRungs,
    recoverableErrors: {
      A: analysed.filter((session) => session.arm === 'A' && hasRecoverableError(session)).length,
      B: analysed.filter((session) => session.arm === 'B' && hasRecoverableError(session)).length,
    },
    decision,
    decisionNote,
    exploratory: options.exploratory === false ? [] : exploratoryBlocks(plan, analysed, startRungs),
  };
}

export interface ResultAnalysis {
  prereg: Preregistration;
  /** Problems with the plan that do not stop a report (a condition with a stretch the estimator cannot hear). */
  warnings: string[];
  conditions: Array<{ result: ConditionResult; analysis: ConditionAnalysis }>;
}

/**
 * Analyses a raw results file: re-validates the plan embedded in it and checks that its hash is the recorded one (a results file whose plan
 * was edited afterwards is refused), then runs the pipeline on every condition.
 */
export function analyzeResult(raw: RawResult, options: AnalyzeOptions = {}): ResultAnalysis {
  const { preregistration } = raw;
  if (sha256Hex(preregistration.text) !== preregistration.sha256) {
    throw new ResultFileError(
      `the pre-registration text embedded in the results does not hash to the recorded sha256 (${preregistration.sha256}): the plan was changed after the run`,
    );
  }
  const loaded = parsePreregistration(preregistration.path, preregistration.text);
  const plan = planOf(loaded.prereg);
  return {
    prereg: loaded.prereg,
    warnings: loaded.warnings,
    conditions: raw.conditions.map((result) => ({
      result,
      analysis: analyzeCondition(plan, result.sessions, options),
    })),
  };
}
