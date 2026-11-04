import { formatDifference, formatValue } from './metrics.ts';
import type { MetricId, MetricUnit } from './metrics.ts';

// THE DECISION RULE, applied literally (TEST_STRATEGY.md section 12, rule id `pb-ab-v1`; ADR-146 in docs/decisions/ab.md).
//
// The inputs per primary metric are what the analysis found: the effect of B against A (B - A, in the unit of the metric: a Hodges-Lehmann
// shift, or a difference of shares), its 95 % interval [low, high], the Holm-adjusted p-value of the primary family, and the practical
// threshold d that was pre-registered. Put every metric on one scale where POSITIVE MEANS B IS WORSE (for a lower-is-better metric that is
// the effect itself; for a higher-is-better one its negation, with the interval turned round), and write
//     worst = the worse end of the interval        best = the better end        point = the effect.
// Then, for each metric, four readings, each one a statement the policy makes:
//     better      p-adjusted < alpha  AND  worst < -d                 the whole interval is beyond the threshold in B's favour
//     harmful     point > d  AND  best > 0                           B is worse beyond the threshold and the interval excludes zero
//     harmless    worst < d                                          the worse end of the interval is inside the threshold
//     equivalent  best > -d  AND  worst < d                          the whole interval is inside the threshold, on both sides
// and the rule:
//     1. If any primary metric is harmful                                          -> DO NOT SHIP B   (harm wins over any benefit elsewhere)
//     2. Else, if at least one is better and every one is harmless                  -> SHIP B          (and no failure guard is tripped)
//     3. Else, if every one is equivalent                                          -> NO DIFFERENCE   (nothing that matters, and the data can say so)
//     4. Anything else                                                             -> INCONCLUSIVE    (keep A; the report says how many sessions a decision would need)
// All comparisons are strict, so a bound exactly on a threshold is not enough: "beyond" means beyond. The burden of proof is deliberately
// asymmetric: shipping B needs the interval entirely beyond the threshold AND significance AND no possible harm; refusing B needs only a
// point estimate beyond the threshold and an interval that excludes zero.
//
// FAILED SESSIONS. A session that failed is not in the comparison (it has no metrics), so a comparison of the survivors can only be trusted
// if few failed and the arms failed alike. The failure guard trips when either arm's failed share exceeds the pre-registered maximum, or
// when Fisher's test finds the arms' failure counts different (p < alpha). A tripped guard forbids rules 2 and 3 (a verdict of safety on
// survivors only) and leaves rule 1 alone: a harm found among the survivors is still a harm.

export type Outcome = 'ship-b' | 'do-not-ship-b' | 'no-difference' | 'inconclusive';
export type Direction = 'lower-is-better' | 'higher-is-better';

export interface MetricEvidence {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  direction: Direction;
  /** The pre-registered practical threshold, in the unit of the metric, > 0. */
  threshold: number;
  /** B minus A: the Hodges-Lehmann shift, or the difference of the shares. */
  effect: number;
  ciLow: number;
  ciHigh: number;
  /** The Holm-adjusted p-value over the primary family. */
  pAdjusted: number;
  /** Sessions analysed in each arm for this metric. */
  nA: number;
  nB: number;
  /** The coverage of the interval, for the sentences. */
  level: number;
}

export interface FailureEvidence {
  attemptedA: number;
  attemptedB: number;
  failedA: number;
  failedB: number;
  /** Fisher's exact p-value of the failure counts between the arms. */
  fisherP: number;
  /** The pre-registered largest share of failed sessions an arm may have. */
  maxShare: number;
}

export interface DecisionInput {
  alpha: number;
  metrics: readonly MetricEvidence[];
  failures: FailureEvidence;
}

export interface MetricReading {
  id: MetricId;
  label: string;
  /** The effect and the interval on the "positive is worse" scale. */
  point: number;
  best: number;
  worst: number;
  threshold: number;
  better: boolean;
  harmful: boolean;
  harmless: boolean;
  equivalent: boolean;
  /** Fewer than two analysed sessions in an arm: nothing can be said of this metric. */
  available: boolean;
  /** One sentence: the numbers behind the four readings. */
  sentence: string;
}

export interface SessionsNeeded {
  id: MetricId;
  /** The reading this metric is closest to: `better` (point beyond -d), `harmful` (point beyond +d) or `equivalent` (inside the band). */
  needs: 'better' | 'equivalent' | 'harmful';
  resolved: boolean;
  /** Sessions per arm it would take, null when the estimate sits on the edge and no number gets it across. */
  perArm: number | null;
}

export interface MoreSessions {
  /** Sessions per arm that the metric that needs most would need; null when none is unresolved or no number of sessions resolves one. */
  perArm: number | null;
  /** What it was extrapolated from, in words. */
  basis: string;
  perMetric: SessionsNeeded[];
}

export interface Decision {
  outcome: Outcome;
  /** `Ship B`, `Do not ship B`, `No difference that matters`, `Inconclusive`: what the report prints as the verdict. */
  headline: string;
  /** One sentence: why. */
  reason: string;
  readings: MetricReading[];
  failureGuardTripped: boolean;
  /** The rule applied step by step, one line per step. */
  steps: string[];
  /** Present when the outcome is inconclusive. */
  moreSessions: MoreSessions | null;
}

const HEADLINES: Record<Outcome, string> = {
  'ship-b': 'Ship B',
  'do-not-ship-b': 'Do not ship B',
  'no-difference': 'No difference that matters (keep A)',
  inconclusive: 'Inconclusive: cannot tell (keep A)',
};

const percent = (share: number): string => `${Math.round(share * 1000) / 10} %`;

function interval(metric: MetricEvidence): string {
  return `${percent(metric.level)} interval ${formatDifference(metric.unit, metric.ciLow)} to ${formatDifference(metric.unit, metric.ciHigh)}`;
}

/** One metric's four readings (see the top of the file). */
export function readMetric(metric: MetricEvidence, alpha: number): MetricReading {
  const sign = metric.direction === 'lower-is-better' ? 1 : -1;
  const worst = sign > 0 ? metric.ciHigh : -metric.ciLow;
  const best = sign > 0 ? metric.ciLow : -metric.ciHigh;
  const point = sign * metric.effect;
  const d = metric.threshold;
  const available = metric.nA >= 2 && metric.nB >= 2;
  const better = available && metric.pAdjusted < alpha && worst < -d;
  const harmful = available && point > d && best > 0;
  const harmless = available && worst < d;
  const equivalent = available && best > -d && worst < d;

  let status: string;
  if (!available) status = 'fewer than two analysed sessions in an arm: no comparison';
  else if (harmful) status = 'harmful: worse than the threshold, and the interval excludes zero';
  else if (better)
    status =
      "better: the whole interval is beyond the threshold in B's favour and the adjusted p is below alpha";
  else if (equivalent) status = 'equivalent: the whole interval is inside the threshold';
  else if (harmless)
    status =
      "harmless, but neither shown better (the interval is not beyond the threshold in B's favour, or the adjusted p is not below alpha) nor equivalent";
  else status = 'harm cannot be ruled out: the worse end of the interval is beyond the threshold';
  const sentence =
    `${metric.label}: B minus A is ${formatDifference(metric.unit, metric.effect)} (${interval(metric)}), ` +
    `threshold ${formatValue(metric.unit, d)}, adjusted p = ${metric.pAdjusted.toPrecision(2)}: ${status}`;
  return {
    id: metric.id,
    label: metric.label,
    point,
    best,
    worst,
    threshold: d,
    better,
    harmful,
    harmless,
    equivalent,
    available,
    sentence,
  };
}

/** Whether the failed sessions are too many, or too unevenly spread over the arms, for a verdict of safety on the survivors. */
export function failureGuard(
  failures: FailureEvidence,
  alpha: number,
): { tripped: boolean; why: string | null } {
  const shareA = failures.attemptedA === 0 ? 0 : failures.failedA / failures.attemptedA;
  const shareB = failures.attemptedB === 0 ? 0 : failures.failedB / failures.attemptedB;
  if (shareA > failures.maxShare || shareB > failures.maxShare) {
    return {
      tripped: true,
      why: `${failures.failedA} of ${failures.attemptedA} sessions of A and ${failures.failedB} of ${failures.attemptedB} of B failed, above the pre-registered maximum of ${percent(failures.maxShare)} of an arm`,
    };
  }
  if (failures.fisherP < alpha) {
    return {
      tripped: true,
      why: `the arms failed differently (${failures.failedA} of ${failures.attemptedA} against ${failures.failedB} of ${failures.attemptedB}, Fisher p = ${failures.fisherP.toPrecision(2)}), so the survivors are not comparable`,
    };
  }
  return { tripped: false, why: null };
}

/**
 * An extrapolation, not a guarantee: how many sessions per arm a metric needs for the reading it is closest to, if the true effect is the
 * one estimated and the interval narrows with the square root of the sessions. `better` needs the worse end below -d, `equivalent` needs the
 * interval inside the band, `harmful` needs the better end above 0. null when the estimate sits exactly on the edge: no sample size gets it
 * across.
 */
export function sessionsNeeded(metric: MetricEvidence, reading: MetricReading): SessionsNeeded {
  const n = Math.min(metric.nA, metric.nB);
  const half = (reading.worst - reading.best) / 2;
  const d = reading.threshold;
  const needs = reading.point < -d ? 'better' : reading.point > d ? 'harmful' : 'equivalent';
  const resolved =
    needs === 'better' ? reading.better : needs === 'harmful' ? reading.harmful : reading.equivalent;
  if (resolved) return { id: metric.id, needs, resolved, perArm: n };
  const room =
    needs === 'better'
      ? -d - reading.point
      : needs === 'harmful'
        ? reading.point
        : d - Math.abs(reading.point);
  if (!(room > 0) || !(half > 0)) return { id: metric.id, needs, resolved, perArm: null };
  return { id: metric.id, needs, resolved, perArm: Math.ceil(n * (half / room) ** 2) };
}

/** Applies the rule. The `steps` it returns are the text at the top of the file with this experiment's numbers. */
export function decide(input: DecisionInput): Decision {
  const { metrics, alpha, failures } = input;
  const readings = metrics.map((metric) => readMetric(metric, alpha));
  const guard = failureGuard(failures, alpha);
  const names = (list: readonly MetricReading[]): string =>
    list.length === 0 ? 'none' : list.map((r) => r.id).join(', ');
  const evidenceOf = (reading: MetricReading): MetricEvidence =>
    metrics.find((m) => m.id === reading.id) as MetricEvidence;
  const range = (m: MetricEvidence): string =>
    `${formatDifference(m.unit, m.ciLow)} to ${formatDifference(m.unit, m.ciHigh)}`;

  const unavailable = readings.filter((r) => !r.available);
  const harmful = readings.filter((r) => r.harmful);
  const better = readings.filter((r) => r.better);
  const notHarmless = readings.filter((r) => !r.harmless);
  const equivalent = readings.filter((r) => r.equivalent);

  const steps = [
    `1. Harm (worse than the threshold with an interval that excludes zero): ${names(harmful)}.`,
    `2. Benefit (adjusted p < ${alpha} and the whole interval beyond the threshold in B's favour): ${names(better)}; worse end of the interval not inside the threshold: ${names(notHarmless)}.`,
    `3. Equivalence (the whole interval inside the threshold): ${equivalent.length} of ${readings.length} (${names(equivalent)}).`,
    `4. Failed sessions: ${guard.tripped ? `guard tripped, ${guard.why}` : `${failures.failedA + failures.failedB} of ${failures.attemptedA + failures.attemptedB} failed, guard not tripped`}.`,
  ];

  let outcome: Outcome;
  let reason: string;
  const first = (list: readonly MetricReading[]): MetricEvidence => evidenceOf(list[0] as MetricReading);
  if (unavailable.length > 0) {
    outcome = 'inconclusive';
    reason = `Inconclusive: ${names(unavailable)} has fewer than two analysed sessions in an arm, so the comparison cannot be made.`;
  } else if (harmful.length > 0) {
    outcome = 'do-not-ship-b';
    const m = first(harmful);
    const also = better.length > 0 ? `, although B is better on ${names(better)}` : '';
    reason = `Do not ship B: ${m.label} is ${formatDifference(m.unit, m.effect)} for B against A (${interval(m)}), worse than the ${formatValue(m.unit, m.threshold)} threshold, and the interval excludes zero${also}.`;
  } else if (better.length > 0 && notHarmless.length === 0 && !guard.tripped) {
    outcome = 'ship-b';
    const m = first(better);
    reason = `Ship B: ${m.label} is ${formatDifference(m.unit, m.effect)} for B against A (${interval(m)}), entirely beyond the ${formatValue(m.unit, m.threshold)} threshold in B's favour with an adjusted p of ${m.pAdjusted.toPrecision(2)}, and no primary metric can be worse than its threshold.`;
  } else if (equivalent.length === readings.length && !guard.tripped) {
    outcome = 'no-difference';
    reason = `No difference that matters: every primary interval lies inside its threshold (${equivalent
      .map(evidenceOf)
      .map((m) => `${m.label} ${range(m)} within ±${formatValue(m.unit, m.threshold)}`)
      .join('; ')}).`;
  } else {
    outcome = 'inconclusive';
    if (guard.tripped) {
      reason = `Inconclusive: ${guard.why}, so no verdict of safety or of equivalence can rest on the sessions that finished.`;
    } else if (better.length > 0) {
      const m = first(notHarmless);
      reason = `Inconclusive: B is better on ${names(better)}, but the interval of ${m.label} (${range(m)}) does not rule out a harm beyond its ${formatValue(m.unit, m.threshold)} threshold.`;
    } else {
      const open = readings.filter((r) => !r.equivalent);
      const m = first(open);
      const reading = open[0] as MetricReading;
      reason =
        reading.worst < -reading.threshold && m.pAdjusted >= alpha
          ? `Inconclusive: the interval of ${m.label} (${range(m)}) is beyond the threshold in B's favour, but the adjusted p of ${m.pAdjusted.toPrecision(2)} is not below ${alpha}.`
          : `Inconclusive: the interval of ${m.label} (${range(m)}) reaches the threshold of ±${formatValue(m.unit, m.threshold)}: it cannot rule out a difference that matters, and does not show one.`;
    }
  }

  let moreSessions: MoreSessions | null = null;
  if (outcome === 'inconclusive' && unavailable.length === 0) {
    const perMetric = metrics.map((metric, i) => sessionsNeeded(metric, readings[i] as MetricReading));
    const unresolved = perMetric.filter((entry) => !entry.resolved);
    const impossible = unresolved.some((entry) => entry.perArm === null);
    moreSessions = {
      perArm:
        unresolved.length === 0 || impossible
          ? null
          : Math.max(...unresolved.map((entry) => entry.perArm as number)),
      basis:
        'if the true effect is the one estimated and each interval narrows with the square root of the sessions per arm: a planning figure, not a guarantee',
      perMetric,
    };
  }
  return {
    outcome,
    headline: HEADLINES[outcome],
    reason,
    readings,
    failureGuardTripped: guard.tripped,
    steps,
    moreSessions,
  };
}
