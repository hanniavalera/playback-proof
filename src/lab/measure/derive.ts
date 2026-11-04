import { PERF_LIMITS } from '../../shared/criteria.ts';
import type { Baseline } from './baseline.ts';
import { rulesFrom, tailStatistic } from './rules.ts';
import type { PerfLimits, RuleKey } from './rules.ts';
import { SCENARIOS } from './scenarios.ts';
import { maximum, mean, median, minimum, p10, p90, robustCv, mad, stdDev } from './stats.ts';
import type { MetricUnit, PerfProfile } from './types.ts';

// Thresholds from measured variation (ADR-131). A baseline holds the raw values of N runs of every metric; from them this file estimates
// how far two independent batches of the same metric are apart by noise alone, and what the thresholds of the policy have to be to sit
// above that. Nothing here measures: it reads baselines, so the derivation can be repeated by anyone who has the files.
//
// The argument, in four steps.
//  1. The gate compares the median (and the tail) of a CURRENT batch with the median (and tail) of the BASELINE batch. Both are
//     estimates from N runs, so with no change at all their difference is not zero: it has the standard deviation sqrt(2) x SE, where SE
//     is the standard error of one batch statistic.
//  2. SE is estimated twice and the larger is used. Parametric: the standard deviation of the baseline runs times the standard error of
//     that statistic for normally distributed data of the same N (calibrated here by a seeded simulation, so it is exact for N = 10 and
//     not the asymptotic formula, which is wrong for a p90 of ten runs). Bootstrap: resample the N baseline runs with replacement,
//     compute the statistic each time, and take the standard deviation of the results; it sees the skew and the outliers of the real
//     runs, but with N = 10 it can only see what happened in those ten.
//  3. The threshold must cover z standard deviations of the difference (z = 3): `noise = z x sqrt(2) x SE`, in the unit of the metric and
//     as a share of the baseline statistic.
//  4. The policy numbers are the smallest round values that cover the noise of every pair (profile, scenario, metric) that the policy
//     gates, and the A/A check (src/lab/measure/aa.ts) then measures whether they were enough.

/** The standard deviations of the difference of two batch statistics that a threshold has to cover. */
export const DERIVE_Z = 3;

const BOOTSTRAP_RESAMPLES = 4000;
const SIMULATED_BATCHES = 20_000;
/** Fixed, so that the derivation of a set of baselines gives the same numbers every time. */
const SEED = 20_260_717;

export type StatisticName = 'median' | 'tail';

/** mulberry32: a small seeded generator, so that the simulation and the bootstrap are reproducible. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function standardNormal(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const sd = (values: readonly number[]): number => stdDev(values) ?? 0;

type Statistic = (values: readonly number[]) => number;

function statisticOf(tail: 'p90' | 'p10', which: StatisticName): Statistic {
  if (which === 'median') return median;
  return tail === 'p10' ? p10 : p90;
}

const factorCache = new Map<string, number>();

/**
 * The standard error of a statistic of n runs in units of the standard deviation of one run, for normally distributed runs: how much the
 * median, the p90 or the p10 of a batch of n moves from batch to batch. A seeded simulation of 20 000 batches, so it holds for the
 * percentile definition of the lab (type 7) and for small n.
 */
export function normalStandardError(n: number, tail: 'p90' | 'p10', which: StatisticName): number {
  const key = `${n}/${which === 'median' ? 'median' : tail}`;
  const cached = factorCache.get(key);
  if (cached !== undefined) return cached;
  const random = generator(SEED + n);
  const statistic = statisticOf(tail, which);
  const results: number[] = [];
  for (let batch = 0; batch < SIMULATED_BATCHES; batch += 1) {
    results.push(statistic(Array.from({ length: n }, () => standardNormal(random))));
  }
  const factor = sd(results);
  factorCache.set(key, factor);
  return factor;
}

/** The standard deviation of a statistic over resamples (with replacement) of the values: what the runs themselves say about its spread. */
export function bootstrapStandardError(
  values: readonly number[],
  statistic: Statistic,
  resamples = BOOTSTRAP_RESAMPLES,
  seed = SEED,
): number {
  if (values.length < 2) return 0;
  const random = generator(seed);
  const results: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    results.push(statistic(values.map(() => values[Math.floor(random() * values.length)] as number)));
  }
  return sd(results);
}

export interface PairVariation {
  envId: string;
  profile: PerfProfile;
  scenario: string;
  metric: string;
  unit: MetricUnit;
  rule: RuleKey | null;
  ruleKind: 'relative' | 'budget' | null;
  tail: 'p90' | 'p10';
  n: number;
  /** The raw baseline runs that produced a value. */
  values: number[];
  median: number;
  tailValue: number;
  min: number;
  max: number;
  sd: number | null;
  cv: number | null;
  /** MAD x 1.4826 / median: the same spread with outliers discounted. */
  robustCv: number | null;
  /** Standard error of the batch statistic: the larger of the parametric and the bootstrap estimate. */
  se: Record<StatisticName, number>;
  seParametric: Record<StatisticName, number>;
  seBootstrap: Record<StatisticName, number>;
  /** z x sqrt(2) x se: how far two independent batches may be apart by noise alone, in the unit of the metric. */
  noise: Record<StatisticName, number>;
  /** The same as a share of the baseline statistic; null when that is zero. */
  noiseShare: Record<StatisticName, number | null>;
  /** Judged by a relative rule at the stability limit: a relative rule, N of at least 2, a baseline CV at or below the limit. */
  gated: boolean;
}

export interface DeriveOptions {
  z?: number;
  maxBaselineCv?: number;
  resamples?: number;
}

/** The variation of every metric of every scenario of the baselines. Metrics without a value in the baseline are skipped. */
export function measureVariation(
  baselines: readonly Baseline[],
  options: DeriveOptions = {},
): PairVariation[] {
  const z = options.z ?? DERIVE_Z;
  const maxCv = options.maxBaselineCv ?? PERF_LIMITS.maxBaselineCv;
  const rules = rulesFrom();
  const pairs: PairVariation[] = [];
  for (const baseline of baselines) {
    for (const [scenarioId, scenario] of Object.entries(baseline.scenarios)) {
      const spec = SCENARIOS.find((candidate) => candidate.id === scenarioId);
      if (!spec) continue;
      for (const metricSpec of spec.metrics) {
        const recorded = scenario.metrics[metricSpec.id];
        const values = (recorded?.values ?? []).filter((value): value is number => value !== null);
        if (values.length === 0) continue;
        const rule = metricSpec.rule === null ? null : rules[metricSpec.rule];
        const tail = rule ? tailStatistic(rule) : 'p90';
        const med = median(values);
        const tailValue = tail === 'p10' ? p10(values) : p90(values);
        const spread = values.length >= 2 ? sd(values) : null;
        const average = mean(values);
        const coefficient = spread === null || average === 0 ? null : spread / Math.abs(average);
        const seParametric = {
          median: spread === null ? 0 : normalStandardError(values.length, tail, 'median') * spread,
          tail: spread === null ? 0 : normalStandardError(values.length, tail, 'tail') * spread,
        };
        const seBootstrap = {
          median: bootstrapStandardError(values, median, options.resamples),
          tail: bootstrapStandardError(values, tail === 'p10' ? p10 : p90, options.resamples),
        };
        const se = {
          median: Math.max(seParametric.median, seBootstrap.median),
          tail: Math.max(seParametric.tail, seBootstrap.tail),
        };
        const noise = {
          median: z * Math.SQRT2 * se.median,
          tail: z * Math.SQRT2 * se.tail,
        };
        pairs.push({
          envId: baseline.envId,
          profile: baseline.profile,
          scenario: scenarioId,
          metric: metricSpec.id,
          unit: metricSpec.unit,
          rule: metricSpec.rule,
          ruleKind: rule?.kind ?? null,
          tail,
          n: values.length,
          values,
          median: med,
          tailValue,
          min: minimum(values),
          max: maximum(values),
          sd: spread,
          cv: coefficient,
          robustCv: robustCv({ n: values.length, median: med, mad: mad(values) }),
          se,
          seParametric,
          seBootstrap,
          noise,
          noiseShare: {
            median: med === 0 ? null : noise.median / Math.abs(med),
            tail: tailValue === 0 ? null : noise.tail / Math.abs(tailValue),
          },
          gated:
            rule?.kind === 'relative' && values.length >= 2 && (coefficient === null || coefficient <= maxCv),
        });
      }
    }
  }
  return pairs;
}

// -------------------------------------------------------------------------------------------------------- what the policy needs

/** Rounds up to a multiple of `step` (the shares of the policy are multiples of 5 %). */
export function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step;
}

/** Rounds up to the next of 1, 2, 5 times a power of ten (the floors of the policy are round numbers). */
export function roundUpNice(value: number): number {
  if (value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const factor of [1, 2, 5, 10]) {
    if (factor * base >= value * (1 - 1e-9)) return Number((factor * base).toPrecision(12));
  }
  return 10 * base;
}

export interface RuleNeed {
  rule: RuleKey;
  /** The pairs that gate under this rule: the policy numbers must cover every one of them. */
  gatedPairs: number;
  /** Pairs of this rule left out because their baseline is noisier than the stability limit (tracked, not gated). */
  trackedPairs: number;
  /** The largest noise, over the gated pairs, as a share of the baseline statistic. */
  share: Record<StatisticName, number>;
  /** The largest noise in the unit of the metric: what a floor has to be to cover it where the share is too small. */
  absolute: Record<StatisticName, number>;
  /** The numbers to put in the policy: shares rounded up to 5 %, the floor to a round number. */
  suggested: { medianShare: number; tailShare: number; floor: number };
}

/** For each relative rule: what the gated pairs need, and a rounded suggestion. */
export function needs(pairs: readonly PairVariation[]): RuleNeed[] {
  const rules = new Map<RuleKey, PairVariation[]>();
  for (const pair of pairs) {
    if (pair.rule === null || pair.ruleKind !== 'relative') continue;
    rules.set(pair.rule, [...(rules.get(pair.rule) ?? []), pair]);
  }
  return [...rules.entries()].map(([rule, group]) => {
    const gated = group.filter((pair) => pair.gated);
    const largest = (pick: (pair: PairVariation) => number | null): number =>
      Math.max(0, ...gated.map((pair) => pick(pair) ?? 0));
    const share = {
      median: largest((pair) => pair.noiseShare.median),
      tail: largest((pair) => pair.noiseShare.tail),
    };
    const absolute = {
      median: largest((pair) => pair.noise.median),
      tail: largest((pair) => pair.noise.tail),
    };
    return {
      rule,
      gatedPairs: gated.length,
      trackedPairs: group.length - gated.length,
      share,
      absolute,
      suggested: {
        medianShare: roundUpTo(share.median, 0.05),
        tailShare: roundUpTo(share.tail, 0.05),
        floor: roundUpNice(Math.max(absolute.median, absolute.tail)),
      },
    };
  });
}

export interface Coverage {
  envId: string;
  profile: PerfProfile;
  scenario: string;
  metric: string;
  unit: MetricUnit;
  rule: RuleKey;
  gated: boolean;
  /** What the policy allows the statistic to be worse by, and the noise it has to sit above. */
  allowed: Record<StatisticName, number>;
  noise: Record<StatisticName, number>;
  /** allowed / noise: 1 is just enough, below 1 the policy is tighter than the noise (false alarms are to be expected). Null when there is no noise. */
  margin: Record<StatisticName, number | null>;
}

/** How much room the thresholds of `limits` leave above the noise of each relative pair. */
export function coverage(pairs: readonly PairVariation[], limits: PerfLimits = PERF_LIMITS): Coverage[] {
  const rules = rulesFrom(limits);
  const out: Coverage[] = [];
  for (const pair of pairs) {
    if (pair.rule === null) continue;
    const rule = rules[pair.rule];
    if (rule.kind !== 'relative') continue;
    const allowed = {
      median: Math.max(rule.medianShare * Math.abs(pair.median), rule.floor),
      tail: Math.max(rule.tailShare * Math.abs(pair.tailValue), rule.floor),
    };
    out.push({
      envId: pair.envId,
      profile: pair.profile,
      scenario: pair.scenario,
      metric: pair.metric,
      unit: pair.unit,
      rule: pair.rule,
      gated: pair.gated,
      allowed,
      noise: pair.noise,
      margin: {
        median: pair.noise.median === 0 ? null : allowed.median / pair.noise.median,
        tail: pair.noise.tail === 0 ? null : allowed.tail / pair.noise.tail,
      },
    });
  }
  return out;
}

export interface BudgetObservation {
  rule: RuleKey;
  metric: string;
  unit: MetricUnit;
  /** The runs of every baseline of this metric, pooled. */
  runs: number;
  /** Runs with a value above zero. */
  nonZero: number;
  max: number;
  /** The largest baseline p90 and median over the profiles. */
  largestTail: number;
  largestMedian: number;
  profiles: Array<{ envId: string; profile: PerfProfile; median: number; tail: number; max: number }>;
}

/** For the metrics judged by an absolute budget: what the baselines show, because a share of zero cannot be derived from variation. */
export function observeBudgets(pairs: readonly PairVariation[]): BudgetObservation[] {
  const groups = new Map<string, PairVariation[]>();
  for (const pair of pairs) {
    if (pair.rule === null || pair.ruleKind !== 'budget') continue;
    groups.set(`${pair.rule}/${pair.metric}`, [...(groups.get(`${pair.rule}/${pair.metric}`) ?? []), pair]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as PairVariation;
    const all = group.flatMap((pair) => pair.values);
    return {
      rule: first.rule as RuleKey,
      metric: first.metric,
      unit: first.unit,
      runs: all.length,
      nonZero: all.filter((value) => value > 0).length,
      max: Math.max(...all),
      largestTail: Math.max(...group.map((pair) => pair.tailValue)),
      largestMedian: Math.max(...group.map((pair) => pair.median)),
      profiles: group.map((pair) => ({
        envId: pair.envId,
        profile: pair.profile,
        median: pair.median,
        tail: pair.tailValue,
        max: pair.max,
      })),
    };
  });
}

// ------------------------------------------------------------------------------------------------------------------- Markdown

const fmt = (value: number | null, digits = 3): string =>
  value === null ? '-' : String(Number(value.toPrecision(digits)));
const pct = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(1)} %`);

export interface Derivation {
  schemaVersion: 1;
  kind: 'perf-threshold-derivation';
  generatedAt: string;
  method: { z: number; resamples: number; simulatedBatches: number; seed: number; maxBaselineCv: number };
  baselines: Array<{
    file: string;
    envId: string;
    profile: PerfProfile;
    generatedAt: string;
    commit: string | null;
  }>;
  pairs: Array<Omit<PairVariation, 'values'> & { values: number[] }>;
  needs: RuleNeed[];
  budgets: BudgetObservation[];
  /** The committed policy against the noise: only present when the derivation was run with the policy of the checkout. */
  coverage: Coverage[];
}

export function deriveFrom(
  files: ReadonlyArray<{ file: string; baseline: Baseline }>,
  generatedAt: string,
  options: DeriveOptions = {},
): Derivation {
  const pairs = measureVariation(
    files.map(({ baseline }) => baseline),
    options,
  );
  return {
    schemaVersion: 1,
    kind: 'perf-threshold-derivation',
    generatedAt,
    method: {
      z: options.z ?? DERIVE_Z,
      resamples: options.resamples ?? BOOTSTRAP_RESAMPLES,
      simulatedBatches: SIMULATED_BATCHES,
      seed: SEED,
      maxBaselineCv: options.maxBaselineCv ?? PERF_LIMITS.maxBaselineCv,
    },
    baselines: files.map(({ file, baseline }) => ({
      file,
      envId: baseline.envId,
      profile: baseline.profile,
      generatedAt: baseline.generatedAt,
      commit: baseline.host.git.commit,
    })),
    pairs,
    needs: needs(pairs),
    budgets: observeBudgets(pairs),
    coverage: coverage(pairs),
  };
}

export function renderDerivationMarkdown(derivation: Derivation): string {
  const { method } = derivation;
  const lines: string[] = [
    '## Threshold derivation',
    '',
    `Derived from ${derivation.baselines.length} baselines (N runs per metric, the warm-up excluded). Noise = ${method.z} x sqrt(2) x SE, where SE is the larger of a parametric and a bootstrap (${method.resamples} resamples, seed ${method.seed}) estimate of the standard error of the batch median or tail: how far two independent batches of the same code may be apart. A metric gates only while its baseline CV is at most ${pct(method.maxBaselineCv)}.`,
    '',
    '### Baselines',
    '',
    '| environment | profile | recorded | commit |',
    '| --- | --- | --- | --- |',
    ...derivation.baselines.map(
      (b) =>
        `| ${b.envId} | ${b.profile} | ${b.generatedAt.slice(0, 16).replace('T', ' ')} | \`${b.commit ?? 'unknown'}\` |`,
    ),
    '',
    '### Relative metrics: variation of the baseline runs',
    '',
    '| environment | profile | metric | n | median | tail | min..max | CV | robust CV | SE median (param / boot) | noise median | noise tail | gated |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const pair of derivation.pairs.filter((p) => p.ruleKind === 'relative')) {
    lines.push(
      `| ${pair.envId} | ${pair.profile} | ${pair.scenario} ${pair.metric} | ${pair.n} | ${fmt(pair.median)} ${pair.unit} | ${pair.tail} ${fmt(pair.tailValue)} | ${fmt(pair.min)}..${fmt(pair.max)} | ${pct(pair.cv)} | ${pct(pair.robustCv)} | ${fmt(pair.seParametric.median)} / ${fmt(pair.seBootstrap.median)} | ${fmt(pair.noise.median)} ${pair.unit} (${pct(pair.noiseShare.median)}) | ${fmt(pair.noise.tail)} ${pair.unit} (${pct(pair.noiseShare.tail)}) | ${pair.gated ? 'yes' : 'no: tracked'} |`,
    );
  }
  lines.push(
    '',
    '### What each relative rule needs',
    '',
    '| rule | gated pairs | tracked pairs | noise share: median / tail | noise: median / tail | suggested: median share, tail share, floor |',
    '| --- | --- | --- | --- | --- | --- |',
    ...derivation.needs.map(
      (need) =>
        `| ${need.rule} | ${need.gatedPairs} | ${need.trackedPairs} | ${pct(need.share.median)} / ${pct(need.share.tail)} | ${fmt(need.absolute.median)} / ${fmt(need.absolute.tail)} | ${pct(need.suggested.medianShare)}, ${pct(need.suggested.tailShare)}, ${fmt(need.suggested.floor)} |`,
    ),
    '',
    '### Metrics judged by an absolute budget: what the baselines show',
    '',
    '| rule | metric | runs | runs above zero | largest value | largest median | largest tail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...derivation.budgets.map(
      (b) =>
        `| ${b.rule} | ${b.metric} | ${b.runs} | ${b.nonZero} | ${fmt(b.max)} ${b.unit} | ${fmt(b.largestMedian)} | ${fmt(b.largestTail)} |`,
    ),
    '',
    '### The committed policy against the noise',
    '',
    'Margin = allowed / noise (1 is just enough). A margin below 1 on a gated pair means the policy is tighter than the noise of its baseline.',
    '',
    '| environment | profile | metric | allowed: median / tail | noise: median / tail | margin: median / tail | gated |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...derivation.coverage.map(
      (c) =>
        `| ${c.envId} | ${c.profile} | ${c.scenario} ${c.metric} | ${fmt(c.allowed.median)} / ${fmt(c.allowed.tail)} ${c.unit} | ${fmt(c.noise.median)} / ${fmt(c.noise.tail)} | ${c.margin.median === null ? '-' : `${fmt(c.margin.median, 2)}x`} / ${c.margin.tail === null ? '-' : `${fmt(c.margin.tail, 2)}x`} | ${c.gated ? 'yes' : 'no: tracked'} |`,
    ),
  );
  return `${lines.join('\n')}\n`;
}
