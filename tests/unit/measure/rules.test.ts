import { describe, expect, it } from 'vitest';
import { RULE_KEYS, describeRule, rulesFrom, tailStatistic } from '../../../src/lab/measure/rules.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import { GATE_LIMITS, PERF_LIMITS, PERF_POLICY } from '../../../src/shared/criteria.ts';

const GLOBAL_KEYS = ['runs', 'warmupRuns', 'maxBaselineCv'] as const;

describe('PB-PERF thresholds: the policy numbers drive the rules', () => {
  const rules = rulesFrom();

  it('has one rule per scenario metric that gates', () => {
    expect(Object.keys(rules).sort()).toStrictEqual([...RULE_KEYS].sort());
  });

  it('reads every threshold of the policy into exactly one rule, so no number is dead and none is shared', () => {
    const thresholds = Object.keys(PERF_POLICY).filter(
      (key) => !(GLOBAL_KEYS as readonly string[]).includes(key),
    );
    expect(thresholds.length).toBeGreaterThan(0);
    for (const key of thresholds) {
      const changed: PerfLimits = {
        ...PERF_LIMITS,
        [key]: (PERF_LIMITS as Record<string, number>)[key]! + 7,
      };
      const moved = rulesFrom(changed);
      const differing = RULE_KEYS.filter(
        (rule) => JSON.stringify(moved[rule]) !== JSON.stringify(rules[rule]),
      );
      expect(differing, `changing ${key}`).toHaveLength(1);
    }
  });

  it('never makes the tail tighter than the median, and the tail threshold is the wider one in absolute terms (it is a share of the larger p90)', () => {
    for (const key of RULE_KEYS) {
      const rule = rules[key];
      // Measured noise (docs/results/perf/threshold-derivation.md) asked for the same share on the p90 as on the median, not a wider one:
      // the p90 of a skewed baseline is itself larger, so the same share already allows more.
      if (rule.kind === 'relative') expect(rule.tailShare, key).toBeGreaterThanOrEqual(rule.medianShare);
      else expect(rule.tailBudget, key).toBeGreaterThanOrEqual(rule.medianBudget);
    }
  });

  it('judges the frame rate on its low tail and everything else on the high tail', () => {
    expect(rules.fps).toMatchObject({ kind: 'relative', worse: 'lower' });
    expect(tailStatistic(rules.fps)).toBe('p10');
    expect(tailStatistic(rules.startup)).toBe('p90');
    expect(tailStatistic(rules.rebufferCount)).toBe('p90');
  });

  it('uses budgets for the metrics whose baseline is usually zero (ADR-004) and shares for the rest', () => {
    for (const key of [
      'frameDropped',
      'lowEndDropped',
      'rebufferCount',
      'rebufferMs',
      'rebufferRatio',
    ] as const) {
      expect(rules[key].kind, key).toBe('budget');
    }
    for (const key of ['startup', 'lowEndStartup', 'fps'] as const)
      expect(rules[key].kind, key).toBe('relative');
  });

  it('shares the run count with the gate budgets and keeps the warm-up smaller than a batch', () => {
    expect(PERF_LIMITS.runs).toBe(GATE_LIMITS.perfRunsPerScenario);
    expect(PERF_LIMITS.warmupRuns).toBeGreaterThanOrEqual(1);
    expect(PERF_LIMITS.warmupRuns).toBeLessThan(PERF_LIMITS.runs);
  });

  it('keeps every share and the stability limit a proper fraction', () => {
    for (const key of RULE_KEYS) {
      const rule = rules[key];
      if (rule.kind !== 'relative') continue;
      expect(rule.medianShare, key).toBeGreaterThan(0);
      expect(rule.tailShare, key).toBeLessThan(1);
    }
    expect(PERF_LIMITS.maxBaselineCv).toBeGreaterThan(0);
    expect(PERF_LIMITS.maxBaselineCv).toBeLessThan(1);
  });

  it('says what it does in words', () => {
    const ms = (value: number): string => `${value} ms`;
    expect(
      describeRule({ kind: 'relative', worse: 'higher', medianShare: 0.25, tailShare: 0.5, floor: 25 }, ms),
    ).toBe('median +25 %, p90 +50 %, and more than 25 ms');
    expect(
      describeRule(
        { kind: 'relative', worse: 'lower', medianShare: 0.05, tailShare: 0.1, floor: 1 },
        (v) => `${v} fps`,
      ),
    ).toBe('median -5 %, p10 -10 %, and more than 1 fps');
    expect(describeRule({ kind: 'budget', worse: 'higher', medianBudget: 250, tailBudget: 1000 }, ms)).toBe(
      'median +250 ms, p90 +1000 ms',
    );
  });
});
