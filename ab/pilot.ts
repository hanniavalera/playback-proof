import { formatThreshold, formatValue, isMetricId, METRICS, metricValue } from './metrics.ts';
import type { MetricId } from './metrics.ts';
import { minimumDetectableEffect, powerCurve, sessionsForPower, verdictRates } from './power.ts';
import type { MdeEstimate, PowerEstimate, VerdictRates } from './power.ts';
import { parsePreregistration } from './prereg.ts';
import type { MetricPlan } from './prereg.ts';
import { poolSessions } from './aa.ts';
import type { RawResult } from './results.ts';
import { percentile } from '../src/lab/measure/stats.ts';

// POWER AND MINIMUM DETECTABLE EFFECT OF A DESIGN, from the sessions of an A/A pilot: what an experiment of N sessions per arm can tell from
// noise, metric by metric, before any A/B session is run. The numbers go into the pre-registration (the practical threshold is never below
// the minimum detectable effect) and decide whether N has to be raised. See ab/power.ts for the definitions.

export interface PilotOptions {
  /** The condition whose sessions are the pilot (default: the first of the file). */
  condition?: string;
  /** Metrics to analyse (default: the primary metrics of the plan). */
  metrics?: readonly string[];
  /** The design to evaluate (default: the plan's sessions per arm). */
  sessionsPerArm?: number;
  /** Simulated experiments per estimate for the minimum and the power curve (default 1000). */
  simulations?: number;
  seed?: number;
  /** Take only the sessions of configuration A (a file of an experiment holds both). */
  onlyA?: boolean;
}

export interface PilotMetric {
  id: MetricId;
  label: string;
  unit: string;
  pilotSessions: number;
  pilotMedian: number | null;
  pilotP90: number | null;
  /** For a share: the share of pilot sessions with the property. */
  pilotShare: number | null;
  mde: MdeEstimate;
  /** The practical threshold of the plan, if the metric has one. */
  threshold: number | null;
  /** Power at no shift, at the threshold and at twice the threshold (when there is one). */
  curve: PowerEstimate[];
  /** Sessions per arm at which a shift equal to the threshold is detected with 80 % power (null: more than 1000, or no threshold). */
  sessionsForThreshold: number | null;
  /** What the decision rule says at a true shift of 0, of -threshold (B better) and of +threshold (B worse): needs a threshold. */
  verdicts: { none: VerdictRates; better: VerdictRates; worse: VerdictRates } | null;
}

export interface PilotAnalysis {
  experiment: string;
  condition: string;
  sessionsPerArm: number;
  simulations: number;
  seed: number;
  pilotSessions: number;
  metrics: PilotMetric[];
}

/** Runs the power analysis for the sessions of one condition of a raw results file. */
export function analyzePilot(raw: RawResult, options: PilotOptions = {}): PilotAnalysis {
  const loaded = parsePreregistration(raw.preregistration.path, raw.preregistration.text);
  const plan = loaded.prereg;
  const conditionId = options.condition ?? raw.conditions[0]?.id;
  const condition = raw.conditions.find((candidate) => candidate.id === conditionId);
  if (!condition)
    throw new RangeError(
      `the results have no condition "${String(conditionId)}" (they have ${raw.conditions.map((c) => c.id).join(', ')})`,
    );
  let sessions = poolSessions(condition.sessions);
  if (options.onlyA) sessions = sessions.filter((session) => session.config === 'A');
  const stray = sessions.filter((session) => session.config !== 'A');
  if (stray.length > 0)
    throw new RangeError(
      `a pilot is made of configuration A: ${stray.length} sessions ran configuration ${stray[0]?.config}; ask for the sessions of A only`,
    );
  const sessionsPerArm = options.sessionsPerArm ?? plan.sessionsPerArm;
  const simulations = options.simulations ?? 1000;
  const seed = options.seed ?? plan.seed;
  const planned = new Map<MetricId, MetricPlan>(plan.metrics.map((metric) => [metric.id, metric]));
  const asked =
    options.metrics ?? plan.metrics.filter((metric) => metric.role === 'primary').map((metric) => metric.id);
  const unknown = asked.filter((id) => !isMetricId(id));
  if (unknown.length > 0)
    throw new RangeError(
      `unknown metric ${unknown.join(', ')} (the metrics are ${Object.keys(METRICS).join(', ')})`,
    );
  const wanted = asked as readonly MetricId[];

  const metrics = wanted.map((id): PilotMetric => {
    const definition = METRICS[id];
    const kind = definition.kind;
    const values = sessions
      .map((session) => metricValue(session, id))
      .filter((value): value is number => value !== null);
    if (values.length < 10)
      throw new RangeError(`${id}: the pilot has ${values.length} values, at least 10 are needed`);
    const design = { sessionsPerArm, simulations, seed };
    const mde = minimumDetectableEffect(values, kind, design);
    const metricPlan = planned.get(id);
    const threshold = metricPlan?.practicalThreshold ?? null;
    const shifts = threshold === null ? [0] : [0, threshold, 2 * threshold];
    const curve = powerCurve(values, kind, shifts, design);
    const sessionsForThreshold =
      threshold === null
        ? null
        : sessionsForPower(values, kind, threshold, { simulations: Math.min(simulations, 600), seed });
    const verdicts =
      metricPlan && threshold !== null
        ? (() => {
            const rates = (shift: number): VerdictRates =>
              verdictRates(values, { ...metricPlan, role: 'primary' }, shift, {
                ...design,
                simulations: Math.min(simulations, 300),
              });
            return { none: rates(0), better: rates(-threshold), worse: rates(threshold) };
          })()
        : null;
    return {
      id,
      label: definition.label,
      unit: definition.unit,
      pilotSessions: values.length,
      pilotMedian: kind === 'continuous' ? percentile(values, 0.5) : null,
      pilotP90: kind === 'continuous' ? percentile(values, 0.9) : null,
      pilotShare: kind === 'binary' ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      mde,
      threshold,
      curve,
      sessionsForThreshold,
      verdicts,
    };
  });
  return {
    experiment: plan.id,
    condition: condition.id,
    sessionsPerArm,
    simulations,
    seed,
    pilotSessions: sessions.length,
    metrics,
  };
}

const percent = (share: number): string => `${(share * 100).toFixed(0)} %`;

export function renderPilot(analysis: PilotAnalysis): string {
  const rows = analysis.metrics.map((metric) => {
    const unit = METRICS[metric.id].unit;
    const mde =
      metric.mde.mde === null ? 'none: not detectable at this N' : formatThreshold(unit, metric.mde.mde);
    const typical =
      metric.pilotShare !== null
        ? `share ${percent(metric.pilotShare)}`
        : `${formatValue(unit, metric.pilotMedian as number)} (p90 ${formatValue(unit, metric.pilotP90 as number)})`;
    return [
      metric.label,
      String(metric.pilotSessions),
      typical,
      mde,
      metric.threshold === null ? 'n/a' : formatThreshold(unit, metric.threshold),
      metric.sessionsForThreshold === null
        ? metric.threshold === null
          ? 'n/a'
          : 'more than 1000'
        : String(metric.sessionsForThreshold),
      metric.verdicts ? percent(metric.verdicts.none.equivalent) : 'n/a',
      metric.verdicts ? percent(metric.verdicts.better['b-better']) : 'n/a',
      metric.verdicts ? percent(metric.verdicts.worse['a-better']) : 'n/a',
    ];
  });
  const header = [
    'Metric',
    'Pilot sessions',
    'Pilot, A alone',
    `Minimum detectable effect (${analysis.sessionsPerArm} per arm, 80 % power)`,
    'Practical threshold',
    'Sessions per arm to detect the threshold',
    'Says "equivalent within the margin" when the arms are the same',
    'Calls B better when B is better by the threshold',
    'Calls A better when B is worse by the threshold',
  ];
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [
    `# Power of ${analysis.experiment} under ${analysis.condition}`,
    '',
    `${analysis.pilotSessions} sessions of configuration A, ${analysis.simulations} simulated experiments per estimate, seed ${analysis.seed}. A simulated experiment resamples the pilot into two arms of ${analysis.sessionsPerArm} and moves one by the shift; "detects" means the test of the harness finds a difference at alpha 0.05 (ab/power.ts).`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...rows.map(line),
    '',
    'The last three columns run the whole decision rule on simulated experiments (a few hundred, so a few points of Monte Carlo error): they say what this design can ever conclude. A threshold below the minimum detectable effect is a difference the design cannot find; a threshold barely above it can rarely be shown to be beyond, because the rule wants the whole interval past the threshold. The first of the three is the only column that can say there is no meaningful difference, and it needs the whole interval inside the margin.',
    '',
  ].join('\n');
}
