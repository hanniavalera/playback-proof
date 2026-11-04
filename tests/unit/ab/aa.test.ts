import { describe, expect, it } from 'vitest';
import { analyzeCondition } from '../../../ab/analyze.ts';
import type { AnalysisPlan } from '../../../ab/analyze.ts';
import { calibrate, evaluateAa, poolFromResult, poolSessions, renderCalibration } from '../../../ab/aa.ts';
import type { MetricPlan } from '../../../ab/prereg.ts';
import { gaussian, generator } from './helpers.ts';
import { aaPrereg } from './fixtures.ts';
import {
  aaPool,
  buildRaw,
  interleaved,
  makeSession,
  plan,
  shareMetric,
  startupMetric,
  startupOnly,
} from './synthetic.ts';

// The A/A calibration on synthetic pools of ONE configuration, where every significant split is a false positive: the healthy pipeline
// stays at or under alpha, and the harness is shown to be able to fail (a deliberately wrong pipeline, and the one that forgets Holm).

const ratioMetric = (): MetricPlan => ({
  id: 'rebufferRatio',
  role: 'primary',
  direction: 'lower-is-better',
  practicalThreshold: 0.02,
  thresholdBasis: 'Two points of rebuffer ratio.',
});

const family = (): AnalysisPlan =>
  plan([startupMetric({ practicalThreshold: 300 }), shareMetric(), ratioMetric()], {
    bootstrapResamples: 100,
  });

describe('PB-AB A/A calibration on a synthetic pool', () => {
  const pool = aaPool(generator(2026), 60);
  const result = calibrate(family(), pool, { splits: 1000, seed: 5 });

  it('splits 60 identical sessions 1000 times and finds a difference no more often than alpha (within its binomial interval)', () => {
    expect(result.poolSessions).toBe(60);
    expect(result.sessionsPerArm).toBe(30);
    expect(result.splits).toBe(1000);
    expect(result.rate).toBe(result.falsePositives / 1000);
    expect(result.rate).toBeLessThan(0.07);
    expect(result.interval.lower).toBeLessThanOrEqual(result.rate);
    expect(result.interval.upper).toBeGreaterThanOrEqual(result.rate);
    expect(result.interval.level).toBe(0.95);
    expect(result.pass).toBe(true);
    expect(result.reason).toContain('not above the significance level of 5 %');
  });

  it('keeps every primary metric at or under its level at each level (a valid test is never over its own alpha, up to noise)', () => {
    expect(result.perMetric.map((metric) => metric.id)).toStrictEqual([
      'startupMs',
      'rebufferShare',
      'rebufferRatio',
    ]);
    for (const metric of result.perMetric) {
      for (const { level, rate } of metric.rejectionRates)
        expect(rate, `${metric.id} at ${level}`).toBeLessThan(level * 1.45 + 0.01);
    }
  });

  it('counts the verdict of every split: nothing is lost, and calling A or B better is rare between identical sessions', () => {
    const total = Object.values(result.verdicts).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(1000);
    expect(result.verdicts['b-better'] + result.verdicts['a-better']).toBeLessThanOrEqual(10);
  });

  it('is reproducible from its seed', () => {
    const again = calibrate(family(), pool, { splits: 100, seed: 5 });
    expect(calibrate(family(), pool, { splits: 100, seed: 5 })).toStrictEqual(again);
    expect(calibrate(family(), pool, { splits: 100, seed: 6 })).not.toStrictEqual(again);
  });

  it('leaves out the odd session of an odd pool, and ignores warm-up and failed sessions', () => {
    const odd = [...pool, makeSession(99, 'A', { startupMs: 1000, rebufferCount: 0 }, { config: 'A' })];
    expect(calibrate(family(), odd, { splits: 100, seed: 1 }).sessionsPerArm).toBe(30);
    const noisy = [
      ...pool,
      makeSession(100, 'A', { startupMs: 9e9 }, { config: 'A', warmup: true }),
      makeSession(101, 'B', {}, { config: 'A', status: 'failed' }),
    ];
    expect(poolSessions(noisy)).toHaveLength(60);
    expect(calibrate(family(), noisy, { splits: 100, seed: 1 }).poolSessions).toBe(60);
  });

  it('writes itself as a Markdown section with the verdict, the counts and the interval', () => {
    const text = renderCalibration(result);
    expect(text).toContain('## A/A calibration (PB-AB-001)');
    expect(text).toContain('**PASS:');
    expect(text).toContain(`${result.falsePositives} of 1000`);
    expect(text).toContain('| rebufferShare |');
    expect(text).toContain('a drift of the machine over time is invisible here');
  });
});

describe('PB-AB A/A calibration: it can fail', () => {
  const pool = aaPool(generator(77), 60);

  it('fails a pipeline that finds differences between identical sessions too often, and says that no verdict is published', () => {
    let calls = 0;
    const eager: typeof analyzeCondition = (p, sessions, options) => {
      const analysis = analyzeCondition(p, sessions, options);
      if (calls++ % 8 === 0) {
        const metric = analysis.metrics[0];
        if (metric) metric.significant = true;
      }
      return analysis;
    };
    const result = calibrate(family(), pool, { splits: 800, seed: 3, analyze: eager });
    expect(result.rate).toBeGreaterThan(0.12);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('finds differences between identical configurations too often');
    expect(result.reason).toContain('No A/B verdict is published');
    expect(renderCalibration(result)).toContain('**FAIL:');
  });

  it('fails a pipeline that forgets Holm: three primary metrics each tested at alpha raise the family-wise error above it', () => {
    const forgetful: typeof analyzeCondition = (p, sessions, options) => {
      const analysis = analyzeCondition(p, sessions, options);
      for (const metric of analysis.metrics) {
        if (metric.role === 'primary') metric.significant = (metric.test?.p ?? 1) < p.alpha;
      }
      return analysis;
    };
    const honest = calibrate(family(), pool, { splits: 1000, seed: 4 });
    const result = calibrate(family(), pool, { splits: 1000, seed: 4, analyze: forgetful });
    expect(result.rate).toBeGreaterThan(honest.rate);
    expect(result.rate).toBeGreaterThan(0.075);
    expect(result.pass).toBe(false);
    expect(honest.pass).toBe(true);
  });

  it('passes, and says it is conservative, a pipeline that almost never finds anything', () => {
    let calls = 0;
    const deaf: typeof analyzeCondition = (p, sessions, options) => {
      const analysis = analyzeCondition(p, sessions, options);
      for (const metric of analysis.metrics) metric.significant = calls++ % 1000 === 0;
      return analysis;
    };
    const result = calibrate(family(), pool, { splits: 400, seed: 2, analyze: deaf });
    expect(result.rate).toBeLessThan(0.02);
    expect(result.pass).toBe(true);
    expect(result.conservative).toBe(true);
    expect(result.reason).toContain('safe and conservative');
  });

  it('refuses a pool that is too small, one that holds configuration B, and too few splits', () => {
    expect(() => calibrate(family(), pool.slice(0, 10), { seed: 1 })).toThrow(/at least 20 usable sessions/);
    const mixed = [...pool.slice(0, 40), makeSession(200, 'B', { startupMs: 700 }, { config: 'B' })];
    expect(() => calibrate(family(), mixed, { seed: 1 })).toThrow(
      /one configuration, A: 1 of its sessions ran configuration B/,
    );
    expect(() => calibrate(family(), pool, { seed: 1, splits: 50 })).toThrow(
      /splits must be an integer >= 100/,
    );
  });
});

describe('PB-AB real interleaved A/A: what its verdict means', () => {
  const normal = (seed: number, n: number, sd: number): number[] =>
    gaussian(generator(seed), n, 1000, sd).map(Math.round);
  const analyse = (a: number[], b: number[], threshold: number) =>
    analyzeCondition(
      plan([startupMetric({ practicalThreshold: threshold })], { kind: 'aa' }),
      interleaved(startupOnly(a), startupOnly(b)),
    );

  it('reads "equivalent within the margin" when the intervals fit inside the thresholds: the ideal reading of an A/A', () => {
    const evaluation = evaluateAa(analyse(normal(1, 30, 40), normal(2, 30, 40), 150));
    expect(evaluation).toMatchObject({
      significant: false,
      verdict: 'equivalent',
      ideal: true,
      acceptable: true,
    });
    expect(evaluation.reason).toContain('The A/A verdict is "equivalent within the margin"');
    expect(evaluation.reason).toContain('found no meaningful difference between them');
  });

  it('is acceptable but not ideal when the design is too weak to say so: nothing significant, but intervals wider than the thresholds', () => {
    const evaluation = evaluateAa(analyse(normal(3, 30, 150), normal(4, 30, 150), 30));
    expect(evaluation).toMatchObject({
      significant: false,
      verdict: 'inconclusive',
      ideal: false,
      acceptable: true,
    });
    expect(evaluation.reason).toContain('the verdict is "inconclusive", not "equivalent"');
    expect(evaluation.reason).toContain('not finding a difference is not evidence that there is none');
    expect(evaluation.reason).not.toContain('no meaningful difference');
  });

  it('is not acceptable when two copies of A are declared different', () => {
    const evaluation = evaluateAa(
      analyse(
        normal(5, 30, 40),
        normal(6, 30, 40).map((x) => x + 400),
        150,
      ),
    );
    expect(evaluation.significant).toBe(true);
    expect(evaluation.acceptable).toBe(false);
    expect(evaluation.reason).toContain('declared a difference between two copies of configuration A');
    expect(evaluation.reason).toContain('repeat it as a new pre-registered A/A');
  });
});

describe('PB-AB A/A: the pool of a results file', () => {
  const text = `${JSON.stringify(aaPrereg(), null, 2)}\n`;
  const rules = [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }] as const;
  const sessions = interleaved(
    startupOnly(Array.from({ length: 30 }, (_, i) => 900 + i)),
    startupOnly(Array.from({ length: 30 }, (_, i) => 905 + i)),
    () => ({
      config: 'A' as const,
    }),
  );
  const raw = buildRaw({ text, conditionId: 'high-latency', rules: [...rules] }, sessions);

  it('takes every measured session of the condition and the plan of the embedded pre-registration', () => {
    const pool = poolFromResult(raw, 'high-latency');
    expect(pool.sessions).toHaveLength(60);
    expect(pool.plan).toMatchObject({ kind: 'aa', alpha: 0.05, seed: 20261104 });
  });

  it("can restrict an experiment's file to the sessions of configuration A, and refuses a condition it does not have", () => {
    const mixed = buildRaw(
      { text, conditionId: 'high-latency', rules: [...rules] },
      interleaved(startupOnly([900, 910, 920]), startupOnly([800, 810, 820]), (arm) => ({ config: arm })),
    );
    expect(
      poolFromResult(mixed, 'high-latency', { onlyA: true }).sessions.map((s) => s.config),
    ).toStrictEqual(['A', 'A', 'A']);
    expect(() => poolFromResult(raw, 'bandwidth-drop')).toThrow(
      /no condition "bandwidth-drop" \(they have high-latency\)/,
    );
  });
});
