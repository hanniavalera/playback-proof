import { describe, expect, it } from 'vitest';
import type { Baseline } from '../../../src/lab/measure/baseline.ts';
import {
  DERIVE_Z,
  SAFETY,
  bootstrapStandardError,
  coverage,
  deriveFrom,
  measureVariation,
  needs,
  normalStandardError,
  observeBudgets,
  renderDerivationMarkdown,
  roundUpNice,
  roundUpTo,
} from '../../../src/lab/measure/derive.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import { mean } from '../../../src/lab/measure/stats.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';
import {
  FRAME_RATE,
  REBUFFERING,
  STARTUP,
  baselineOf,
  frameBatch,
  rebufferBatch,
  startupBatch,
} from './fixtures.ts';

// The derivation of the thresholds, tested on baselines built from synthetic runs whose spread can be checked by hand, and on the
// simulation and the bootstrap against values that are known in closed form.

const STEADY = [140, 150, 130, 160, 145, 155, 135, 150, 148, 152];
const NOISY = [50, 150, 60, 140, 100, 100, 55, 145, 100, 100];
const profileOf = (
  profile: 'chromium' | 'webkit',
  startups: readonly number[],
  envId = 'local-darwin-arm64',
): Baseline =>
  baselineOf(
    [
      { spec: STARTUP, batch: startupBatch(startups) },
      { spec: REBUFFERING, batch: rebufferBatch([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
      { spec: FRAME_RATE, batch: frameBatch(Array.from({ length: 10 }, () => 30)) },
    ],
    { profile, envId },
  );

const startupOf = (pairs: ReturnType<typeof measureVariation>, profile: string) =>
  pairs.find((p) => p.profile === profile && p.scenario === 'PB-PERF-001' && p.metric === 'startupMs')!;

describe('PB-PERF derivation: the standard error of a batch statistic', () => {
  it('knows the spread of the median and the p90 of ten normally distributed runs', () => {
    // The asymptotic formulas (1.2533 / sqrt(10) = 0.396 for the median, 0.54 for a p90) do not hold for ten runs, which is why the
    // factors are simulated: the median of an even count is the mean of the two middle runs (0.374 sigma), and the type-7 p90 of ten
    // runs is 0.9 x the 9th + 0.1 x the 10th (0.458 sigma). Tested as ranges that a simulation of 20 000 batches cannot leave.
    const median = normalStandardError(10, 'p90', 'median');
    const p90 = normalStandardError(10, 'p90', 'tail');
    const p10 = normalStandardError(10, 'p10', 'tail');
    expect(median).toBeGreaterThan(0.35);
    expect(median).toBeLessThan(0.4);
    expect(p90).toBeGreaterThan(0.43);
    expect(p90).toBeLessThan(0.49);
    expect(p90).toBeGreaterThan(median);
    expect(Math.abs(p10 - p90)).toBeLessThan(0.03);
  });

  it('shrinks with more runs, and is the same every time it is asked', () => {
    expect(normalStandardError(40, 'p90', 'median')).toBeLessThan(normalStandardError(10, 'p90', 'median'));
    expect(normalStandardError(10, 'p90', 'median')).toBe(normalStandardError(10, 'p90', 'median'));
  });

  it('bootstraps the standard error of the mean of 1..10 to the standard error of the mean (within a few percent)', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // sqrt((n - 1) / n) x s / sqrt(n) = 0.9487 x 3.0277 / 3.1623 = 0.908
    expect(bootstrapStandardError(values, mean, 4000)).toBeCloseTo(0.908, 1);
  });

  it('is zero for runs that never differ, and for a single run', () => {
    expect(bootstrapStandardError([30, 30, 30, 30], mean)).toBe(0);
    expect(bootstrapStandardError([30], mean)).toBe(0);
  });

  it('gives the same bootstrap for the same seed', () => {
    const values = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(bootstrapStandardError(values, mean, 500, 7)).toBe(bootstrapStandardError(values, mean, 500, 7));
    expect(bootstrapStandardError(values, mean, 500, 7)).not.toBe(
      bootstrapStandardError(values, mean, 500, 8),
    );
  });
});

describe('PB-PERF derivation: the variation of the metrics of a baseline', () => {
  const pairs = measureVariation([profileOf('chromium', STEADY), profileOf('webkit', NOISY)]);

  it('describes each metric of each profile: the statistics, the spread and the noise two batches may differ by', () => {
    const startup = startupOf(pairs, 'chromium');
    expect(startup).toMatchObject({
      envId: 'local-darwin-arm64',
      unit: 'ms',
      rule: 'startup',
      ruleKind: 'relative',
      tail: 'p90',
      n: 10,
      median: 149,
      min: 130,
      max: 160,
    });
    expect(startup.cv).toBeCloseTo(0.0627, 3);
    // noise = z x sqrt(2) x SE, with SE the larger of the two estimates
    expect(startup.se.median).toBe(Math.max(startup.seParametric.median, startup.seBootstrap.median));
    expect(startup.noise.median).toBeCloseTo(DERIVE_Z * Math.SQRT2 * startup.se.median, 10);
    expect(startup.noiseShare.median).toBeCloseTo(startup.noise.median / 149, 10);
    expect(startup.noise.tail).toBeGreaterThan(startup.noise.median);
    // The discarded warm-up (the fixture's is 999 ms) and how many times the median it was.
    expect(startup.warmup).toBe(999);
    expect(startup.warmupRatio).toBeCloseTo(999 / 149, 10);
  });

  it('gates a pair whose baseline is stable, and tracks one whose baseline is noisier than the limit', () => {
    expect(startupOf(pairs, 'chromium').gated).toBe(true);
    expect(startupOf(pairs, 'webkit').cv).toBeGreaterThan(PERF_LIMITS.maxBaselineCv);
    expect(startupOf(pairs, 'webkit').gated).toBe(false);
    const stricter = measureVariation([profileOf('chromium', STEADY)], { maxBaselineCv: 0.03 });
    expect(startupOf(stricter, 'chromium').gated).toBe(false);
  });

  it('has no noise for runs that never differ (the frame rate of a steady clip), and no share of a zero baseline', () => {
    const fps = pairs.find((p) => p.profile === 'chromium' && p.metric === 'fps')!;
    expect(fps.noise).toStrictEqual({ median: 0, tail: 0 });
    const rebuffers = pairs.find((p) => p.profile === 'chromium' && p.metric === 'rebufferCount')!;
    expect(rebuffers).toMatchObject({ ruleKind: 'budget', gated: false, median: 0 });
    expect(rebuffers.noiseShare).toStrictEqual({ median: null, tail: null });
  });

  it('uses the lower tail where lower is worse', () => {
    expect(pairs.find((p) => p.metric === 'fps')!.tail).toBe('p10');
  });

  it('skips metrics the baseline has no value for, and is reproducible', () => {
    expect(pairs.some((p) => p.metric === 'loadedMs')).toBe(false);
    expect(measureVariation([profileOf('chromium', STEADY)])).toStrictEqual(
      measureVariation([profileOf('chromium', STEADY)]),
    );
  });
});

describe('PB-PERF derivation: rounding to the numbers a policy can state', () => {
  it.each([
    [0.0, 0.05, 0],
    [0.01, 0.05, 0.05],
    [0.05, 0.05, 0.05],
    [0.0501, 0.05, 0.1],
    [0.1999, 0.05, 0.2],
    [0.2, 0.05, 0.2],
  ])('rounds %s up to a multiple of %s: %s', (value, step, expected) => {
    expect(roundUpTo(value, step)).toBeCloseTo(expected, 10);
  });

  it.each([
    [0, 0],
    [0.4, 0.5],
    [1, 1],
    [1.01, 2],
    [2.5, 5],
    [5.1, 10],
    [11, 20],
    [26, 50],
    [51, 100],
    [100, 100],
  ])('rounds %s up to the round number %s', (value, expected) => {
    expect(roundUpNice(value)).toBeCloseTo(expected, 10);
  });
});

describe('PB-PERF derivation: what each rule needs, and whether the policy has it', () => {
  const baselines = [profileOf('chromium', STEADY), profileOf('webkit', NOISY)];
  const pairs = measureVariation(baselines);

  it('asks, for each relative rule, for the largest noise of the pairs that gate and counts the ones it leaves out', () => {
    const startup = needs(pairs).find((need) => need.rule === 'startup')!;
    const chromium = startupOf(pairs, 'chromium');
    expect(startup).toMatchObject({ gatedPairs: 1, trackedPairs: 1 });
    expect(startup.share.median).toBeCloseTo(chromium.noiseShare.median!, 10);
    expect(startup.absolute.tail).toBeCloseTo(chromium.noise.tail, 10);
    // Round up: the suggestion covers SAFETY x the need.
    expect(startup.suggested.medianShare).toBeGreaterThanOrEqual(SAFETY * startup.share.median);
    expect(startup.suggested.tailShare).toBeGreaterThanOrEqual(SAFETY * startup.share.tail);
    expect(startup.suggested.medianShare).toBeLessThan(SAFETY * startup.share.median + 0.05);
    // The floor is SAFETY x the noise of the quietest gated pair, rounded up to a round number.
    expect(startup.quietest).toBeCloseTo(Math.max(chromium.noise.median, chromium.noise.tail), 10);
    expect(startup.suggested.floor).toBe(roundUpNice(SAFETY * startup.quietest));
    expect(startup.suggested.floor).toBeGreaterThanOrEqual(SAFETY * startup.quietest);
    expect(startup.suggested.medianShare * 100).toBeCloseTo(
      Math.round(startup.suggested.medianShare * 100),
      6,
    );
  });

  it('takes the shares from the noisiest pair and the floor from the quietest one', () => {
    // The same relative spread at three times the size: the shares agree, the absolute noise is three times larger.
    const two = measureVariation([
      profileOf('chromium', STEADY),
      profileOf(
        'webkit',
        STEADY.map((value) => value * 3),
      ),
    ]);
    const startup = needs(two).find((need) => need.rule === 'startup')!;
    const small = startupOf(two, 'chromium');
    const large = startupOf(two, 'webkit');
    expect(startup.gatedPairs).toBe(2);
    expect(large.noise.tail / small.noise.tail).toBeCloseTo(3, 6);
    expect(startup.absolute.tail).toBeCloseTo(large.noise.tail, 10);
    expect(startup.quietest).toBeCloseTo(Math.max(small.noise.median, small.noise.tail), 10);
    expect(startup.share.median).toBeCloseTo(small.noiseShare.median!, 6);
  });

  it('suggests nothing for a budget rule: a share of zero cannot be derived from variation', () => {
    expect(
      needs(pairs)
        .map((need) => need.rule)
        .sort(),
    ).toStrictEqual(['fps', 'startup']);
  });

  it('measures the margin of the policy above the noise, per pair, and says when there is no noise to compare with', () => {
    const limits: PerfLimits = {
      ...PERF_LIMITS,
      startupMedianRel: 0.2,
      startupTailRel: 0.4,
      startupFloorMs: 1,
    };
    const rows = coverage(pairs, limits);
    const startup = rows.find((c) => c.profile === 'chromium' && c.metric === 'startupMs')!;
    expect(startup.allowed.median).toBeCloseTo(0.2 * 149, 10);
    expect(startup.margin.median).toBeCloseTo(startup.allowed.median / startup.noise.median, 10);
    expect(rows.find((c) => c.profile === 'chromium' && c.metric === 'fps')!.margin).toStrictEqual({
      median: null,
      tail: null,
    });
    expect(rows.some((c) => c.metric === 'rebufferCount')).toBe(false);
    // A tighter policy leaves less room.
    const tighter = coverage(pairs, { ...limits, startupMedianRel: 0.02 }).find(
      (c) => c.profile === 'chromium' && c.metric === 'startupMs',
    )!;
    expect(tighter.margin.median!).toBeLessThan(startup.margin.median!);
  });

  it('shows what the baselines hold for the metrics judged by a budget', () => {
    const withRebuffer = [
      baselineOf([{ spec: REBUFFERING, batch: rebufferBatch([0, 0, 0, 0, 0, 0, 0, 1, 0, 2]) }], {
        profile: 'chromium',
      }),
      baselineOf([{ spec: REBUFFERING, batch: rebufferBatch(Array.from({ length: 10 }, () => 0)) }], {
        profile: 'webkit',
      }),
    ];
    const count = observeBudgets(measureVariation(withRebuffer)).find((b) => b.metric === 'rebufferCount')!;
    expect(count).toMatchObject({ rule: 'rebufferCount', runs: 20, nonZero: 2, max: 2, largestMedian: 0 });
    expect(count.largestTail).toBeCloseTo(1.1, 10);
    expect(count.profiles.map((p) => p.profile)).toStrictEqual(['chromium', 'webkit']);
  });
});

describe('PB-PERF derivation: the document', () => {
  const files = [
    { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline: profileOf('chromium', STEADY) },
    { file: 'perf/baselines/local-darwin-arm64/webkit.json', baseline: profileOf('webkit', NOISY) },
  ];

  it('is the same document for the same baselines, and plain JSON', () => {
    const a = deriveFrom(files, '2026-11-04T12:00:00.000Z');
    const b = deriveFrom(files, '2026-11-04T12:00:00.000Z');
    expect(a).toStrictEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toStrictEqual(a);
    expect(a).toMatchObject({
      kind: 'perf-threshold-derivation',
      method: { z: 3, simulatedBatches: 20_000, maxBaselineCv: PERF_LIMITS.maxBaselineCv },
    });
    expect(a.baselines.map((x) => x.profile)).toStrictEqual(['chromium', 'webkit']);
  });

  it('renders every section, and says which metric is only tracked', () => {
    const markdown = renderDerivationMarkdown(deriveFrom(files, '2026-11-04T12:00:00.000Z'));
    for (const heading of [
      '## Threshold derivation',
      '### Baselines',
      '### Relative metrics: variation of the baseline runs',
      '### What each relative rule needs',
      '### Metrics judged by an absolute budget: what the baselines show',
      '### The committed policy against the noise',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toMatch(
      /\| local-darwin-arm64 \| webkit \| PB-PERF-001 startupMs \|[^\n]*no: tracked \|/,
    );
    expect(markdown).toMatch(/\| local-darwin-arm64 \| chromium \| PB-PERF-001 startupMs \|[^\n]*\| yes \|/);
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
