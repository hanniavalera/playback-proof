import { PERF_LIMITS } from '../../shared/criteria.ts';

// The rule a gated metric is judged by, built from the numbers of `PERF_POLICY` (src/shared/criteria.ts): the thresholds are data, the
// code that applies them (decide.ts) knows nothing about any particular number. A metric that has no rule is only tracked.

/** `PERF_LIMITS`, or a variation of it (the unit tests pass their own). */
export type PerfLimits = { readonly [K in keyof typeof PERF_LIMITS]: number };

/**
 * Judged against a share of the baseline value and an absolute floor.
 *
 * `worse` says which direction hurts. The statistic that stands for "the tail" follows from it: the p90 where higher is worse (startup),
 * the p10 where lower is worse (frame rate), because the median says how the typical run is doing and the tail how the bad ones are.
 * A statistic fails when it is worse than the baseline's by MORE than `max(share x |baseline value|, floor)`; the floor is one number
 * for both statistics, so a few milliseconds on a small metric can never fail a build. Exactly at the limit passes.
 */
export interface RelativeRule {
  kind: 'relative';
  worse: 'higher' | 'lower';
  medianShare: number;
  tailShare: number;
  floor: number;
}

/**
 * Judged against an absolute amount, for metrics whose baseline is usually zero (a share of zero is zero, so every run would fail):
 * a statistic fails when it is above the baseline's by MORE than the budget. Only "higher is worse" exists: counts, durations, ratios.
 */
export interface BudgetRule {
  kind: 'budget';
  worse: 'higher';
  medianBudget: number;
  tailBudget: number;
}

export type MetricRule = RelativeRule | BudgetRule;

export const RULE_KEYS = [
  'startup',
  'lowEndStartup',
  'fps',
  'frameDropped',
  'lowEndDropped',
  'rebufferCount',
  'rebufferMs',
  'rebufferRatio',
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

const relative = (
  worse: RelativeRule['worse'],
  medianShare: number,
  tailShare: number,
  floor: number,
): RelativeRule => ({ kind: 'relative', worse, medianShare, tailShare, floor });

const budget = (medianBudget: number, tailBudget: number): BudgetRule => ({
  kind: 'budget',
  worse: 'higher',
  medianBudget,
  tailBudget,
});

/** Every rule of the gate, with the numbers of `limits` (default: the committed policy). */
export function rulesFrom(limits: PerfLimits = PERF_LIMITS): Readonly<Record<RuleKey, MetricRule>> {
  return {
    startup: relative('higher', limits.startupMedianRel, limits.startupTailRel, limits.startupFloorMs),
    lowEndStartup: relative(
      'higher',
      limits.lowEndStartupMedianRel,
      limits.lowEndStartupTailRel,
      limits.lowEndStartupFloorMs,
    ),
    fps: relative('lower', limits.fpsMedianRel, limits.fpsTailRel, limits.fpsFloor),
    frameDropped: budget(limits.frameDroppedMedianBudget, limits.frameDroppedTailBudget),
    lowEndDropped: budget(limits.lowEndDroppedMedianBudget, limits.lowEndDroppedTailBudget),
    rebufferCount: budget(limits.rebufferCountMedianBudget, limits.rebufferCountTailBudget),
    rebufferMs: budget(limits.rebufferMsMedianBudget, limits.rebufferMsTailBudget),
    rebufferRatio: budget(limits.rebufferRatioMedianBudget, limits.rebufferRatioTailBudget),
  };
}

/** The tail statistic a rule judges next to the median. */
export function tailStatistic(rule: MetricRule): 'p90' | 'p10' {
  return rule.worse === 'lower' ? 'p10' : 'p90';
}

/** The rule in words, for the table of the report: `median +25 %, p90 +50 %, and more than 25 ms`. `format` writes an amount in the metric's unit. */
export function describeRule(rule: MetricRule, format: (amount: number) => string): string {
  const percent = (share: number): string => `${Number((share * 100).toPrecision(6))} %`;
  const sign = rule.worse === 'lower' ? '-' : '+';
  const tail = tailStatistic(rule);
  if (rule.kind === 'relative') {
    return `median ${sign}${percent(rule.medianShare)}, ${tail} ${sign}${percent(rule.tailShare)}, and more than ${format(rule.floor)}`;
  }
  return `median ${sign}${format(rule.medianBudget)}, ${tail} ${sign}${format(rule.tailBudget)}`;
}
