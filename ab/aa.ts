import { analyzeCondition, planOf } from './analyze.ts';
import type { AnalysisPlan, ConditionAnalysis } from './analyze.ts';
import type { Verdict } from './decision.ts';
import type { MetricId } from './metrics.ts';
import { parsePreregistration } from './prereg.ts';
import type { RawResult } from './results.ts';
import { clopperPearson } from './stats/binomial.ts';
import { mulberry32, seedFrom, shuffleInPlace } from './stats/random.ts';
import { AB_POLICY } from './policy.ts';
import type { ArmId, SessionRecord } from './types.ts';

// THE A/A CALIBRATION (PB-AB-001). A comparison harness is only worth what its false-positive rate is: two copies of the SAME configuration
// must be declared different about alpha of the time, and not much more. Two checks, both of them reported with every A/B verdict:
//
//   (a) CALIBRATION on a pool. Take the sessions of one configuration (A/A pilot: 60 sessions under one condition), split them at random
//       into two arms K = 2000 times, and run the full pipeline of ab/analyze.ts on each split. The share of splits declared significant
//       (any primary metric with a Holm-adjusted p-value below alpha: the family-wise error) must not be above alpha, and is reported with
//       its exact binomial interval. What it checks: the statistics, given the data. It cannot see drift in time (the random split mixes
//       the order of the sessions away): that is what (b) is for.
//   (b) THE REAL INTERLEAVED A/A. Run configuration A against itself through the runner, interleaved like any experiment (kind `aa` in the
//       pre-registration), and read the verdict. What it checks: the whole procedure, browser, service, interleaving and the rest. A single
//       run is significant 5 % of the time with a perfect harness, so a failure is a reason to look, and a repeat is a new pre-registration,
//       reported next to the first.
//
// If either is off, the harness is broken and no A/B verdict is published until it is fixed (TEST_STRATEGY.md section 12).

export interface CalibrationOptions {
  /** Random splits (default 2000). */
  splits?: number;
  seed: number;
  /** Called after every split with the number done (a progress line for a long run). */
  onProgress?: (done: number, total: number) => void;
  /** The pipeline under calibration: the real one by default. A unit test of the calibration itself puts a deliberately wrong one here. */
  analyze?: typeof analyzeCondition;
}

export interface MetricCalibration {
  id: MetricId;
  /** The share of splits in which the RAW p-value of this metric was below each level: under a true null each is at most the level. */
  rejectionRates: Array<{ level: number; rate: number }>;
}

export interface CalibrationResult {
  poolSessions: number;
  sessionsPerArm: number;
  splits: number;
  alpha: number;
  /** Splits in which at least one primary metric had a Holm-adjusted p-value below alpha. */
  falsePositives: number;
  rate: number;
  /** The exact 95 % binomial interval of `rate` (it describes the splits drawn, not the pool: the splits share their sessions). */
  interval: { lower: number; upper: number; level: number };
  perMetric: MetricCalibration[];
  /** How the decision rule came out over the splits: a verdict of `b-better` or `a-better` between identical sessions is a false alarm. */
  verdicts: Record<Verdict, number>;
  /** The rate is not above alpha (the lower end of its interval is at or below alpha). */
  pass: boolean;
  /** The rate is well below alpha: the harness is safe but conservative, and the experiment's power is what pays. */
  conservative: boolean;
  reason: string;
}

const LEVELS = [0.01, 0.05, 0.1, 0.25] as const;

/** The usable sessions of a pool: measured, finished, with no regard to the arm they were run in. */
export function poolSessions(sessions: readonly SessionRecord[]): SessionRecord[] {
  return sessions.filter((session) => !session.warmup && session.status === 'ok');
}

/**
 * Splits `pool` at random into two arms of equal size (an odd session is left out, a different one each time), K times, and applies the
 * full pipeline to each split. `plan.kind` is forced to `aa`: the rule is applied, so that the verdicts of the splits can be counted.
 */
export function calibrate(
  plan: AnalysisPlan,
  pool: readonly SessionRecord[],
  options: CalibrationOptions,
): CalibrationResult {
  const sessions = poolSessions(pool);
  if (sessions.length < 20)
    throw new RangeError(`a calibration needs a pool of at least 20 usable sessions, got ${sessions.length}`);
  const nonA = sessions.filter((session) => session.config !== 'A');
  if (nonA.length > 0)
    throw new RangeError(
      `a calibration pool is made of one configuration, A: ${nonA.length} of its sessions ran configuration ${nonA[0]?.config}`,
    );
  const splits = options.splits ?? AB_POLICY.calibrationSplits;
  if (!Number.isInteger(splits) || splits < 100)
    throw new RangeError(`splits must be an integer >= 100, got ${String(splits)}`);
  const perArm = Math.floor(sessions.length / 2);
  const decisionPlan: AnalysisPlan = { ...plan, kind: 'aa' };
  const primary = plan.metrics.filter((metric) => metric.role === 'primary').map((metric) => metric.id);
  const raw = new Map<MetricId, number[]>(primary.map((id) => [id, []]));
  const verdicts: Record<Verdict, number> = {
    'a-better': 0,
    'b-better': 0,
    equivalent: 0,
    inconclusive: 0,
  };
  let falsePositives = 0;

  for (let split = 0; split < splits; split++) {
    const random = mulberry32(seedFrom(options.seed, 'split', split));
    const order = shuffleInPlace([...sessions], random);
    const relabelled = order
      .slice(0, 2 * perArm)
      .map((session, i): SessionRecord => ({ ...session, arm: (i < perArm ? 'A' : 'B') as ArmId }));
    const analyze = options.analyze ?? analyzeCondition;
    const analysis = analyze(
      { ...decisionPlan, seed: seedFrom(options.seed, 'split-bootstrap', split) },
      relabelled,
      { exploratory: false },
    );
    if (analysis.metrics.some((metric) => metric.role === 'primary' && metric.significant))
      falsePositives += 1;
    for (const metric of analysis.metrics) {
      if (metric.role === 'primary') raw.get(metric.id)?.push(metric.test?.p ?? 1);
    }
    verdicts[(analysis.decision as { verdict: Verdict }).verdict] += 1;
    options.onProgress?.(split + 1, splits);
  }

  const rate = falsePositives / splits;
  const interval = clopperPearson(falsePositives, splits);
  const pass = interval.lower <= plan.alpha;
  const conservative = interval.upper < plan.alpha / 2;
  const share = `${(rate * 100).toFixed(2)} % (${falsePositives} of ${splits}; 95 % interval ${(interval.lower * 100).toFixed(2)} to ${(interval.upper * 100).toFixed(2)} %)`;
  return {
    poolSessions: sessions.length,
    sessionsPerArm: perArm,
    splits,
    alpha: plan.alpha,
    falsePositives,
    rate,
    interval: { lower: interval.lower, upper: interval.upper, level: interval.level },
    perMetric: primary.map((id) => ({
      id,
      rejectionRates: LEVELS.map((level) => ({
        level,
        rate: (raw.get(id) as number[]).filter((p) => p < level).length / splits,
      })),
    })),
    verdicts,
    pass,
    conservative,
    reason: pass
      ? `The harness declared ${share} of the splits of identical sessions significant: not above the significance level of ${plan.alpha * 100} %${conservative ? ', and well below it: it is safe and conservative, so it will under-detect rather than over-claim' : ''}.`
      : `The harness declared ${share} of the splits of identical sessions significant, above the significance level of ${plan.alpha * 100} %: it finds differences between identical configurations too often. No A/B verdict is published until the cause (noise, ordering or a statistics bug) is found and fixed.`,
  };
}

/**
 * The pool of an A/A results file: every measured, finished session of the condition (both arms ran configuration A). A file of an
 * experiment is refused unless the sessions of configuration A alone are asked for (`onlyA`): configuration B has no place in a pool.
 */
export function poolFromResult(
  raw: RawResult,
  conditionId: string,
  options: { onlyA?: boolean } = {},
): { plan: AnalysisPlan; sessions: SessionRecord[] } {
  const loaded = parsePreregistration(raw.preregistration.path, raw.preregistration.text);
  const condition = raw.conditions.find((candidate) => candidate.id === conditionId);
  if (!condition)
    throw new RangeError(
      `the results have no condition "${conditionId}" (they have ${raw.conditions.map((c) => c.id).join(', ')})`,
    );
  let sessions = poolSessions(condition.sessions);
  if (options.onlyA) sessions = sessions.filter((session) => session.config === 'A');
  return { plan: planOf(loaded.prereg), sessions };
}

/** What a real interleaved A/A run says about the harness: significance after Holm, and the verdict of the rule. */
export interface AaEvaluation {
  /** Any primary metric with an adjusted p-value below alpha. */
  significant: boolean;
  verdict: Verdict | null;
  /** The best reading: the intervals lie inside the margins, so the two copies are equivalent (and only then is "no meaningful difference" said). */
  ideal: boolean;
  /** Nothing significant and neither "A better" nor "B better": what a healthy harness gives most of the time. */
  acceptable: boolean;
  reason: string;
}

export function evaluateAa(analysis: ConditionAnalysis): AaEvaluation {
  const significant = analysis.metrics.some((metric) => metric.role === 'primary' && metric.significant);
  const verdict = analysis.decision?.verdict ?? null;
  const ideal = !significant && verdict === 'equivalent';
  const acceptable = !significant && (verdict === 'equivalent' || verdict === 'inconclusive');
  let reason: string;
  if (ideal)
    reason =
      'The A/A verdict is "equivalent within the margin": the intervals of two copies of configuration A lie inside the practical thresholds, so this harness found no meaningful difference between them.';
  else if (acceptable)
    reason =
      'The A/A comparison found nothing significant and neither "A better" nor "B better", but its intervals are wider than the margins, so the verdict is "inconclusive", not "equivalent": not finding a difference is not evidence that there is none, and at this number of sessions the design cannot call two copies equivalent.';
  else
    reason = `The A/A comparison declared a difference between two copies of configuration A (${significant ? 'a primary metric is significant after Holm' : `verdict ${verdict ?? 'none'}`}). One run is significant ${AB_POLICY.alpha * 100} % of the time with a perfect harness: repeat it as a new pre-registered A/A and read the calibration; two in a row are a defect of the harness.`;
  return { significant, verdict, ideal, acceptable, reason };
}

/** The calibration as a Markdown section for the report of an A/A run, or on its own. */
export function renderCalibration(result: CalibrationResult): string {
  const lines = [
    '## A/A calibration (PB-AB-001): the false-positive rate of the harness',
    '',
    `A pool of ${result.poolSessions} sessions of configuration A was split at random into two arms of ${result.sessionsPerArm}, ${result.splits} times, and the full pipeline (tests, Holm over the primary family, bootstrap intervals, decision rule) was applied to each split. Every split compares two samples of the same configuration, so every significant one is a false positive.`,
    '',
    `**${result.pass ? 'PASS' : 'FAIL'}: ${result.reason}**`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| Splits declared significant (any primary metric, Holm-adjusted p < ${result.alpha}) | ${result.falsePositives} of ${result.splits} = ${(result.rate * 100).toFixed(2)} % |`,
    `| Exact binomial interval (${result.interval.level * 100} %) | ${(result.interval.lower * 100).toFixed(2)} % to ${(result.interval.upper * 100).toFixed(2)} % |`,
    `| Required | the lower end of the interval at or below ${result.alpha * 100} % |`,
    `| Verdicts over the splits | B better ${result.verdicts['b-better']}, A better ${result.verdicts['a-better']} (both are false alarms between identical sessions), equivalent within the margin ${result.verdicts.equivalent}, inconclusive ${result.verdicts.inconclusive} |`,
    '',
    'Share of splits in which the raw p-value of a primary metric was below a level (a valid test has each at most its level):',
    '',
    '| Metric | p < 0.01 | p < 0.05 | p < 0.10 | p < 0.25 |',
    '| --- | --- | --- | --- | --- |',
    ...result.perMetric.map(
      (metric) =>
        `| ${metric.id} | ${metric.rejectionRates.map((entry) => `${(entry.rate * 100).toFixed(1)} %`).join(' | ')} |`,
    ),
    '',
    'What this checks and what it does not: the statistics, given these sessions. The splits share their sessions, so the interval describes the splits drawn, not the pool; and a random split mixes away the order of the sessions, so a drift of the machine over time is invisible here. The real interleaved A/A run checks the procedure.',
  ];
  return `${lines.join('\n')}\n`;
}
