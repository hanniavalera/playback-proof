import { describe, expect, it } from 'vitest';
import {
  EXIT_PASS,
  EXIT_PROBLEM,
  EXIT_REGRESSION,
  compareEnvironment,
  compareMetric,
  exceeds,
  exitCodeOf,
  gatingStatus,
  judgeBatch,
  needsRemeasure,
  settle,
} from '../../../src/lab/measure/decide.ts';
import type { BatchJudgement, ScenarioOutcome } from '../../../src/lab/measure/decide.ts';
import { rulesFrom } from '../../../src/lab/measure/rules.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import { summarize } from '../../../src/lab/measure/stats.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';
import {
  FRAME_RATE,
  HASH,
  REBUFFERING,
  STARTUP,
  baselineOf,
  frameBatch,
  rebufferBatch,
  run,
  startupBatch,
} from './fixtures.ts';

// Round numbers, so that every threshold below can be checked by hand: the median of a startup may be worse by 20 % of the baseline or 10 ms,
// whichever is more; the p90 by 50 % or 10 ms. The committed policy has other numbers (and the tests of rules.ts pin how they are read).
const LIMITS: PerfLimits = { ...PERF_LIMITS, startupMedianRel: 0.2, startupTailRel: 0.5, startupFloorMs: 10 };

// median 100, p90 110, coefficient of variation about 7 %: a quiet baseline.
const QUIET = [90, 92, 95, 98, 100, 100, 102, 105, 110, 110];
const constant = (value: number, n = 10): number[] => Array.from({ length: n }, () => value);

const baselineStartup = (values: readonly number[] = QUIET, startRung: number | null = 720) =>
  baselineOf([{ spec: STARTUP, batch: startupBatch(values, startRung) }]).scenarios['PB-PERF-001']!;

function judgeStartup(
  current: readonly number[],
  baseline = baselineStartup(),
  startRung: number | null = 720,
) {
  return judgeBatch(STARTUP, baseline, startupBatch(current, startRung), LIMITS);
}

function startupMetric(judgement: BatchJudgement) {
  const found = judgement.comparisons.find((c) => c.metric === 'startupMs');
  if (!found) throw new Error('no startupMs comparison');
  return found;
}

describe('PB-PERF gate: the limit is strict, and tolerant only of floating-point noise', () => {
  it('fails strictly more than the limit and passes exactly at it', () => {
    expect(exceeds(20, 20)).toBe(false);
    expect(exceeds(20.001, 20)).toBe(true);
    expect(exceeds(19.999, 20)).toBe(false);
    expect(exceeds(-5, 20)).toBe(false);
  });

  it('does not fail on the last bits of a product (0.1 + 0.2 is the limit and 0.30000000000000004 is not more than it)', () => {
    expect(exceeds(0.3000000000000007, 0.1 + 0.2)).toBe(false);
    expect(exceeds(0.31, 0.1 + 0.2)).toBe(true);
  });
});

describe('PB-PERF gate: a relative rule (startup) on the median and the p90', () => {
  it('passes a batch that is the baseline', () => {
    const verdict = startupMetric(judgeStartup(QUIET));
    expect(verdict.verdict).toBe('pass');
    expect(verdict.median).toMatchObject({
      baseline: 100,
      current: 100,
      worseBy: 0,
      allowed: 20,
      exceeded: false,
    });
    expect(verdict.tail).toMatchObject({ statistic: 'p90', baseline: 110, current: 110, allowed: 55 });
    expect(verdict.reason).toMatch(/within the limits/);
  });

  it('passes a median exactly at the limit (20 % of 100) and fails one just over it', () => {
    expect(startupMetric(judgeStartup(constant(120))).verdict).toBe('pass');
    const over = startupMetric(judgeStartup(constant(120.5)));
    expect(over.verdict).toBe('fail');
    expect(over.median.exceeded).toBe(true);
    expect(over.tail.exceeded).toBe(false);
    expect(over.reason).toBe(
      'median 100 ms -> 120.5 ms (+20.5 %): worse by 20.5 ms, more than the 20 ms allowed',
    );
  });

  it('never fails a run that got faster, however much', () => {
    const faster = startupMetric(judgeStartup(constant(10)));
    expect(faster.verdict).toBe('pass');
    expect(faster.median.worseBy).toBe(-90);
  });

  it('is protected by the floor: a 40 ms metric is allowed 10 ms whatever 20 % of it is', () => {
    const baseline = baselineStartup(constant(40));
    // 20 % of 40 is 8 ms; the floor of 10 ms is what stops a 9 ms change from failing the build.
    const nine = startupMetric(judgeStartup(constant(49), baseline));
    expect(nine.median).toMatchObject({ allowed: 10, worseBy: 9, exceeded: false });
    expect(nine.verdict).toBe('pass');
    expect(startupMetric(judgeStartup(constant(50), baseline)).verdict).toBe('pass');
    expect(startupMetric(judgeStartup(constant(50.5), baseline)).verdict).toBe('fail');
  });

  it('protects the p90 with the same floor: a 10 ms tail may move 9 ms although 50 % of it is 5 ms', () => {
    const baseline = baselineStartup(constant(10));
    const verdict = startupMetric(judgeStartup([...constant(10, 8), 19, 19], baseline));
    expect(verdict.tail).toMatchObject({
      baseline: 10,
      current: 19,
      worseBy: 9,
      allowed: 10,
      exceeded: false,
    });
    expect(verdict.verdict).toBe('pass');
    expect(startupMetric(judgeStartup([...constant(10, 8), 21, 21], baseline)).verdict).toBe('fail');
  });

  it('lets the share take over from the floor once the share is larger', () => {
    // 20 % of 1000 is 200, far above the 10 ms floor.
    const baseline = baselineStartup(constant(1000));
    expect(startupMetric(judgeStartup(constant(1150), baseline)).median.allowed).toBe(200);
    expect(startupMetric(judgeStartup(constant(1150), baseline)).verdict).toBe('pass');
    expect(startupMetric(judgeStartup(constant(1201), baseline)).verdict).toBe('fail');
  });

  it('fails on the p90 alone when the tail got worse and the median did not', () => {
    // Eight typical runs and two bad ones: the median is the baseline's, the p90 is 200 against 110 (worse by 90, 55 allowed).
    const verdict = startupMetric(judgeStartup([...constant(100, 8), 200, 200]));
    expect(verdict.median.exceeded).toBe(false);
    expect(verdict.tail.exceeded).toBe(true);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toBe(
      'p90 110 ms -> 200 ms (+81.8 %): worse by 90 ms, more than the 55 ms allowed',
    );
  });

  it('gives the p90 the wider threshold: +50 ms on a 110 ms p90 passes where the same share on the median would not', () => {
    const verdict = startupMetric(judgeStartup([...constant(100, 8), 160, 160]));
    expect(verdict.tail).toMatchObject({ current: 160, worseBy: 50, allowed: 55, exceeded: false });
    expect(verdict.verdict).toBe('pass');
  });

  it('reports both statistics when both failed', () => {
    const verdict = startupMetric(judgeStartup(constant(300)));
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toMatch(/^median 100 ms -> 300 ms.*; p90 110 ms -> 300 ms/);
  });

  it('judges a zero baseline by the floor alone, since a share of zero is zero', () => {
    const baseline = baselineStartup(constant(0));
    expect(startupMetric(judgeStartup(constant(10), baseline)).verdict).toBe('pass');
    const over = startupMetric(judgeStartup(constant(11), baseline));
    expect(over.verdict).toBe('fail');
    expect(over.median.changeShare).toBeNull();
    expect(over.reason).toMatch(/^median 0 ms -> 11 ms: worse by 11 ms, more than the 10 ms allowed/);
  });

  it('does not gate on a baseline too noisy to tell a regression from noise, and says what it would have done', () => {
    const noisy = baselineStartup([50, 150, 60, 140, 100, 100, 55, 145, 100, 100]);
    const verdict = startupMetric(judgeStartup(constant(500), noisy));
    expect(verdict.verdict).toBe('tracked');
    expect(verdict.reason).toMatch(
      /coefficient of variation is \d+\.\d %, above the stability limit of 15\.0 %.*\(it would have failed\)/,
    );
    expect(judgeStartup(constant(500), noisy).failed).toBe(false);
    // The same number against a quiet baseline fails: the noise of the baseline is the only difference.
    expect(startupMetric(judgeStartup(constant(500))).verdict).toBe('fail');
  });

  it('does not gate on a baseline of one run: there is no noise estimate to rest a threshold on', () => {
    const single = baselineStartup([100]);
    const verdict = startupMetric(judgeStartup(constant(500), single));
    expect(verdict.verdict).toBe('tracked');
    expect(verdict.reason).toMatch(/one run/);
  });

  it('shows a tracked metric (no rule) without ever failing it', () => {
    const judgement = judgeStartup(constant(500));
    const manifest = judgement.comparisons.find((c) => c.metric === 'manifestMs')!;
    expect(manifest.verdict).toBe('tracked');
    expect(manifest.rule).toBeNull();
    expect(manifest.median.allowed).toBeNull();
    expect(manifest.median.exceeded).toBe(false);
    expect(manifest.median.change).toBe(50 - 10);
  });

  it('reads the thresholds from the policy it is given', () => {
    const strict: PerfLimits = { ...LIMITS, startupMedianRel: 0.1 };
    const verdict = judgeBatch(STARTUP, baselineStartup(), startupBatch(constant(115)), strict);
    expect(startupMetric(verdict).verdict).toBe('fail');
    expect(startupMetric(judgeStartup(constant(115))).verdict).toBe('pass');
  });
});

describe('PB-PERF gate: a budget rule (rebuffering) judges the increase over a baseline that is usually zero', () => {
  const zero = baselineOf([{ spec: REBUFFERING, batch: rebufferBatch(constant(0)) }]).scenarios[
    'PB-PERF-003'
  ]!;
  const judge = (counts: readonly number[], baseline = zero) =>
    judgeBatch(REBUFFERING, baseline, rebufferBatch(counts), LIMITS);
  const of = (judgement: BatchJudgement, metric: string) =>
    judgement.comparisons.find((c) => c.metric === metric)!;

  it('passes a batch that rebuffers as little as the baseline', () => {
    const judgement = judge(constant(0));
    expect(judgement.failed).toBe(false);
    expect(judgement.comparisons.map((c) => c.verdict)).toStrictEqual(['pass', 'pass', 'pass']);
  });

  it('fails when the median count rises at all (the budget of the median is zero), and says so in counts', () => {
    const judgement = judge([1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(of(judgement, 'rebufferCount')).toMatchObject({
      verdict: 'fail',
      median: { baseline: 0, current: 1, allowed: 0, exceeded: true },
      tail: { exceeded: false },
    });
    expect(of(judgement, 'rebufferCount').reason).toBe('median 0 -> 1: worse by 1, more than the 0 allowed');
    expect(judgement.failed).toBe(true);
  });

  it('allows the tail one more rebuffer than the baseline and fails at two', () => {
    expect(of(judge([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]), 'rebufferCount').verdict).toBe('pass');
    const two = of(judge([0, 0, 0, 0, 0, 0, 0, 0, 2, 2]), 'rebufferCount');
    expect(two.verdict).toBe('fail');
    expect(two.median.exceeded).toBe(false);
    expect(two.tail).toMatchObject({ statistic: 'p90', current: 2, allowed: 1, exceeded: true });
  });

  it('is relative to the baseline, not a level: a baseline that already rebuffers once may rebuffer as often', () => {
    const once = baselineOf([{ spec: REBUFFERING, batch: rebufferBatch(constant(1)) }]).scenarios[
      'PB-PERF-003'
    ]!;
    expect(judge(constant(1), once).failed).toBe(false);
    expect(judge(constant(2), once).failed).toBe(true);
  });

  it('judges the duration and the ratio by their own budgets', () => {
    // 400 ms per rebuffer: ten runs of two rebuffers are 800 ms (budget 250) and a ratio of 0.04 (budget 0.01).
    const judgement = judge(constant(2));
    expect(of(judgement, 'rebufferMs')).toMatchObject({
      verdict: 'fail',
      median: { current: 800, allowed: 250 },
    });
    expect(of(judgement, 'rebufferRatio')).toMatchObject({ verdict: 'fail', median: { allowed: 0.01 } });
    // One rebuffer costs 400 ms: over the 250 ms duration budget as well.
    expect(of(judge(constant(1)), 'rebufferMs').verdict).toBe('fail');
  });
});

describe('PB-PERF gate: the frame rate has a one-sided lower bound, judged on the low tail', () => {
  const baseline = baselineOf([{ spec: FRAME_RATE, batch: frameBatch(constant(30)) }]).scenarios[
    'PB-PERF-002'
  ]!;
  const judge = (fps: readonly number[], dropped: readonly number[] = []) =>
    judgeBatch(FRAME_RATE, baseline, frameBatch(fps, dropped), LIMITS);
  const fps = (judgement: BatchJudgement) => judgement.comparisons.find((c) => c.metric === 'fps')!;

  it('passes a median exactly at the limit (5 % of 30 is 1.5 fps) and fails one just under it', () => {
    expect(fps(judge(constant(28.5))).verdict).toBe('pass');
    const under = fps(judge(constant(28.4)));
    expect(under.verdict).toBe('fail');
    expect(under.median).toMatchObject({ worseBy: expect.closeTo(1.6, 9), allowed: 1.5, exceeded: true });
    expect(under.reason).toMatch(
      /^median 30 fps -> 28.4 fps \(-5.3 %\): worse by 1.6 fps, more than the 1.5 fps allowed/,
    );
  });

  it('never fails a higher frame rate', () => {
    const higher = fps(judge(constant(60)));
    expect(higher.verdict).toBe('pass');
    expect(higher.median.worseBy).toBe(-30);
  });

  it('judges the p10, not the p90: a few slow runs fail the tail while the median holds', () => {
    // Eight healthy runs and two at 25 fps: the median is 30, the p10 is 25 (30 - 3 allowed, so 5 is too much).
    const verdict = fps(judge([...constant(30, 8), 25, 25]));
    expect(verdict.median.exceeded).toBe(false);
    expect(verdict.tail).toMatchObject({
      statistic: 'p10',
      baseline: 30,
      current: 25,
      allowed: 3,
      exceeded: true,
    });
    expect(verdict.verdict).toBe('fail');
    // And the best runs do not matter: two runs at 60 fps move the p90, not the p10.
    expect(fps(judge([60, 60, ...constant(30, 8)])).verdict).toBe('pass');
  });

  it('judges the dropped-frame ratio by its absolute budget (a baseline of zero)', () => {
    const dropped = (ratios: readonly number[]) =>
      judge(constant(30, ratios.length), ratios).comparisons.find((c) => c.metric === 'droppedRatio')!;
    expect(dropped(constant(0.01)).verdict).toBe('pass'); // exactly the 1 % median budget
    expect(dropped(constant(0.011)).verdict).toBe('fail');
    expect(dropped(constant(0.011)).reason).toMatch(
      /^median 0 -> 0.011: worse by 0.011, more than the 0.01 allowed/,
    );
  });
});

describe('PB-PERF gate: when the numbers cannot be compared there is a problem, not a verdict', () => {
  it('reports a different start rung where startup depends on it', () => {
    const judgement = judgeStartup(constant(100), baselineStartup(QUIET, 720), 360);
    expect(judgement.problems).toHaveLength(1);
    expect(judgement.problems[0]!.message).toMatch(
      /the player started on 360p here and on 720p in the baseline: startup depends on the first rung/,
    );
    expect(judgement.failed).toBe(false);
  });

  it('reports runs that did not all start on the same rung', () => {
    const batch = startupBatch(constant(100));
    batch.runs[4] = run({ startupMs: 100, manifestMs: 10 }, 360);
    const judgement = judgeBatch(STARTUP, baselineStartup(), batch, LIMITS);
    expect(judgement.problems.map((p) => p.message).join('\n')).toMatch(
      /did not start on the same rung \(720p and 360p\)/,
    );
  });

  it('does not care about the start rung where the window is pinned', () => {
    const baseline = baselineOf([{ spec: FRAME_RATE, batch: frameBatch(constant(30)) }]).scenarios[
      'PB-PERF-002'
    ]!;
    const batch = frameBatch(constant(30));
    batch.runs[0] = run({ fps: 30, droppedRatio: 0 }, 360);
    expect(judgeBatch(FRAME_RATE, baseline, batch, LIMITS).problems).toStrictEqual([]);
  });

  it('reports a different stream, protocol, condition or pin from the baseline', () => {
    const batch = startupBatch(QUIET);
    batch.stream = 'vod-webm';
    batch.faultProfile = 'high-latency';
    const messages = judgeBatch(STARTUP, baselineStartup(), batch, LIMITS).problems.map((p) => p.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/measured stream vod-cmaf and this batch vod-webm/);
    expect(messages[1]).toMatch(/measured fault profile clean and this batch high-latency/);
  });

  it('reports a gated metric that a run did not produce, naming the run', () => {
    const batch = startupBatch(QUIET);
    batch.runs[6] = run({ startupMs: null, manifestMs: 10 });
    batch.runs[8] = run({ startupMs: null, manifestMs: 10 });
    const judgement = judgeBatch(STARTUP, baselineStartup(), batch, LIMITS);
    expect(judgement.problems).toStrictEqual([
      {
        scenario: 'PB-PERF-001',
        metric: 'startupMs',
        message: 'startupMs was not produced by run 7, 9, and it gates',
      },
    ]);
    expect(judgement.comparisons.map((c) => c.metric)).toStrictEqual(['manifestMs']);
  });

  it('reports a gated metric that the baseline does not have', () => {
    const baseline = baselineStartup();
    delete baseline.metrics.startupMs;
    const judgement = judgeBatch(STARTUP, baseline, startupBatch(QUIET), LIMITS);
    expect(judgement.problems[0]!.message).toMatch(
      /the baseline has no value for startupMs, and it gates: record the baseline again/,
    );
  });

  it('ignores a tracked metric that nobody produced', () => {
    const batch = startupBatch(QUIET);
    batch.runs = batch.runs.map((r) => run({ startupMs: r.values.startupMs ?? 0, manifestMs: null }));
    const judgement = judgeBatch(STARTUP, baselineStartup(), batch, LIMITS);
    expect(judgement.problems).toStrictEqual([]);
    expect(judgement.comparisons.map((c) => c.metric)).toStrictEqual(['startupMs']);
  });

  it('reports a batch with no run at all', () => {
    expect(judgeBatch(STARTUP, baselineStartup(), startupBatch([]), LIMITS).problems[0]!.message).toBe(
      'the batch has no measured run',
    );
  });
});

describe('PB-PERF gate: a regression must reproduce', () => {
  const bad = (): BatchJudgement => judgeStartup(constant(300));
  const good = (): BatchJudgement => judgeStartup(QUIET);
  const worseAgain = (): BatchJudgement => judgeStartup(constant(260));

  it('settles a first batch that passed without a second one', () => {
    const outcome = settle(good(), null);
    expect(outcome).toMatchObject({ status: 'pass', remeasured: false, problems: [] });
    expect(outcome.metrics.map((m) => [m.metric, m.verdict])).toStrictEqual([
      ['startupMs', 'pass'],
      ['manifestMs', 'tracked'],
    ]);
    expect(needsRemeasure(good())).toBe(false);
  });

  it('asks for a fresh batch when a gated metric failed', () => {
    expect(needsRemeasure(bad())).toBe(true);
  });

  it('calls it a regression only when the fresh batch fails the same metric too', () => {
    const outcome = settle(bad(), worseAgain());
    expect(outcome.status).toBe('regression');
    expect(outcome.remeasured).toBe(true);
    const startup = outcome.metrics.find((m) => m.metric === 'startupMs')!;
    expect(startup.verdict).toBe('regression');
    expect(startup.first.median.current).toBe(300);
    expect(startup.remeasure?.median.current).toBe(260);
  });

  it('does not fail the build when the fresh batch is back to normal: not reproduced', () => {
    const outcome = settle(bad(), good());
    expect(outcome.status).toBe('pass');
    expect(outcome.metrics.find((m) => m.metric === 'startupMs')).toMatchObject({
      verdict: 'not-reproduced',
    });
    expect(outcome.remeasured).toBe(true);
  });

  it('does not let a failure of another metric confirm the first: it has to be the same metric', () => {
    const baseline = baselineOf([{ spec: REBUFFERING, batch: rebufferBatch(constant(0)) }]).scenarios[
      'PB-PERF-003'
    ]!;
    // The first batch fails the rebuffer count in its tail (two rebuffers in two runs); the duration and the ratio of those runs stay within budget.
    const first = judgeBatch(REBUFFERING, baseline, rebufferBatch([0, 0, 0, 0, 0, 0, 0, 0, 2, 2]), LIMITS);
    expect(first.comparisons.map((c) => [c.metric, c.verdict])).toStrictEqual([
      ['rebufferCount', 'fail'],
      ['rebufferMs', 'pass'],
      ['rebufferRatio', 'pass'],
    ]);
    // The fresh batch has no rebuffer, but every run stalled for 300 ms: the duration fails, the count it was asked about does not.
    const fresh = judgeBatch(
      REBUFFERING,
      baseline,
      {
        ...rebufferBatch([]),
        runs: constant(0).map(() => run({ rebufferCount: 0, rebufferMs: 300, rebufferRatio: 0 })),
      },
      LIMITS,
    );
    expect(fresh.comparisons.map((c) => [c.metric, c.verdict])).toStrictEqual([
      ['rebufferCount', 'pass'],
      ['rebufferMs', 'fail'],
      ['rebufferRatio', 'pass'],
    ]);
    const settled = settle(first, fresh);
    expect(settled.status).toBe('pass');
    expect(settled.metrics.map((m) => [m.metric, m.verdict])).toStrictEqual([
      ['rebufferCount', 'not-reproduced'],
      ['rebufferMs', 'pass'],
      ['rebufferRatio', 'pass'],
    ]);
  });

  it('judges the fresh batch on its own, not pooled with the first', () => {
    // Pooled, the twenty runs would have a median of 205 ms and fail; judged alone the fresh batch is the baseline again.
    const pooled = summarize([...constant(300), ...QUIET]);
    expect(pooled.median).toBe(205);
    expect(settle(bad(), good()).status).toBe('pass');
  });

  it('keeps tracked metrics out of the decision, and a noisy baseline cannot cause a re-measure', () => {
    const noisy = baselineStartup([50, 150, 60, 140, 100, 100, 55, 145, 100, 100]);
    const judgement = judgeStartup(constant(500), noisy);
    expect(needsRemeasure(judgement)).toBe(false);
    expect(settle(judgement, null).metrics.map((m) => m.verdict)).toStrictEqual(['tracked', 'tracked']);
  });

  it('cannot settle a failure without the fresh batch (a harness bug, not a verdict)', () => {
    expect(() => settle(bad(), null)).toThrow(/the first batch failed, so a fresh batch is needed/);
  });

  it('does not re-measure what could not be judged, and reports the problem of the first or the second batch', () => {
    const unjudgeable = judgeStartup(constant(100), baselineStartup(QUIET, 720), 360);
    expect(needsRemeasure(unjudgeable)).toBe(false);
    expect(settle(unjudgeable, null)).toMatchObject({ status: 'problem', remeasured: false });
    const outcome = settle(bad(), unjudgeable);
    expect(outcome.status).toBe('problem');
    expect(outcome.remeasured).toBe(true);
    expect(outcome.problems[0]!.message).toMatch(/started on 360p here/);
  });
});

describe('PB-PERF gate: exit codes', () => {
  const outcome = (status: ScenarioOutcome['status']): ScenarioOutcome => ({
    scenario: 'PB-PERF-001',
    status,
    metrics: [],
    problems: status === 'problem' ? [{ scenario: 'PB-PERF-001', message: 'x' }] : [],
    remeasured: false,
  });
  const environmentProblem = { scenario: '*', message: 'no baseline' };

  it('uses 0 for a pass, 1 for a reproduced regression and 2 for a problem of the measurement', () => {
    expect([EXIT_PASS, EXIT_REGRESSION, EXIT_PROBLEM]).toStrictEqual([0, 1, 2]);
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf([outcome('pass'), outcome('pass')])).toBe(0);
    expect(exitCodeOf([outcome('pass'), outcome('regression')])).toBe(1);
    expect(exitCodeOf([outcome('pass'), outcome('problem')])).toBe(2);
    expect(exitCodeOf([outcome('pass')], [environmentProblem])).toBe(2);
    expect(exitCodeOf([], [environmentProblem])).toBe(2);
  });

  it('lets a reproduced regression win over a problem elsewhere: it is a finding whatever else went wrong', () => {
    expect(exitCodeOf([outcome('regression'), outcome('problem')])).toBe(1);
    expect(exitCodeOf([outcome('regression')], [environmentProblem])).toBe(1);
  });

  it('does not count a regression that did not reproduce as a failure', () => {
    const notReproduced = settle(judgeStartup(constant(300)), judgeStartup(QUIET));
    expect(exitCodeOf([notReproduced])).toBe(0);
  });
});

describe('PB-PERF gate: the environment', () => {
  const baseline = baselineOf([{ spec: STARTUP, batch: startupBatch(QUIET) }]);
  const same = {
    streams: { 'vod-cmaf': HASH },
    ffmpeg: '9.0',
    browserVersion: '156.0.0.0',
    playwright: '1.64.1',
    cpus: 12,
  };

  it('finds nothing to say about the machine the baseline came from', () => {
    expect(compareEnvironment(baseline, same)).toStrictEqual({ problems: [], warnings: [] });
  });

  it('refuses to compare against different media: a changed stream hash is a problem, never a regression', () => {
    const { problems } = compareEnvironment(baseline, {
      ...same,
      ffmpeg: '9.1',
      streams: { 'vod-cmaf': 'b'.repeat(64) },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toMatch(
      /content of stream vod-cmaf changed since the baseline was recorded \(aaaaaaaaaaaa -> bbbbbbbbbbbb; ffmpeg 9\.0 -> 9\.1\)/,
    );
    expect(exitCodeOf([], problems)).toBe(EXIT_PROBLEM);
  });

  it('only warns about a new browser, Playwright or CPU count: they may be the reason a number moved', () => {
    const result = compareEnvironment(baseline, {
      ...same,
      browserVersion: '157.0.0.0',
      playwright: '1.65.0',
      cpus: 4,
    });
    expect(result.problems).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      'the browser is 157.0.0.0; the baseline was recorded on 156.0.0.0',
      'Playwright is 1.65.0; the baseline was recorded with 1.64.1',
      'this machine has 4 CPUs; the baseline was recorded on 12',
    ]);
  });

  it('ignores a stream the baseline never played', () => {
    expect(
      compareEnvironment(baseline, { ...same, streams: { 'vod-webm': 'c'.repeat(64) } }).problems,
    ).toStrictEqual([]);
  });

  it('can check the streams before any browser has started: an unknown browser version is not a difference', () => {
    expect(compareEnvironment(baseline, { ...same, browserVersion: null })).toStrictEqual({
      problems: [],
      warnings: [],
    });
  });
});

describe('PB-PERF gate: which metrics of a baseline gate', () => {
  it('says which gate and why the others do not', () => {
    const quiet = baselineOf([{ spec: STARTUP, batch: startupBatch(QUIET) }]);
    expect(gatingStatus([STARTUP], quiet, LIMITS)).toStrictEqual([
      { scenario: 'PB-PERF-001', metric: 'startupMs', gates: true, reason: null },
      {
        scenario: 'PB-PERF-001',
        metric: 'manifestMs',
        gates: false,
        reason: 'no rule: tracked and reported only',
      },
    ]);
    const noisy = baselineOf([
      { spec: STARTUP, batch: startupBatch([50, 150, 60, 140, 100, 100, 55, 145, 100, 100]) },
    ]);
    expect(gatingStatus([STARTUP], noisy, LIMITS)[0]).toMatchObject({ gates: false });
    expect(gatingStatus([STARTUP], noisy, LIMITS)[0]!.reason).toMatch(/above the stability limit of 15\.0 %/);
    const single = baselineOf([{ spec: STARTUP, batch: startupBatch([100]) }]);
    expect(gatingStatus([STARTUP], single, LIMITS)[0]).toMatchObject({
      gates: false,
      reason: 'the baseline is one run',
    });
  });

  it('gates a budget metric whatever its baseline looks like', () => {
    const baseline = baselineOf([
      { spec: REBUFFERING, batch: rebufferBatch([0, 5, 0, 7, 0, 9, 0, 11, 0, 13]) },
    ]);
    expect(gatingStatus([REBUFFERING], baseline, LIMITS).every((s) => s.gates)).toBe(true);
  });
});

describe('PB-PERF gate: compareMetric directly', () => {
  it('judges a pair of summaries without a batch', () => {
    const rule = rulesFrom(LIMITS).startup;
    const spec = STARTUP.metrics[0]!;
    const verdict = compareMetric(spec, rule, summarize(QUIET), summarize(constant(125)), LIMITS);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.baselineRuns).toBe(10);
    expect(verdict.currentRuns).toBe(10);
    expect(verdict.baselineCv).toBeCloseTo(summarize(QUIET).cv!, 12);
  });
});
