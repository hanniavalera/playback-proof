import { describe, expect, it } from 'vitest';
import { allowanceUsed, renderAaMarkdown, summarizeAa } from '../../../src/lab/measure/aa.ts';
import type { BaselineMachine } from '../../../src/lab/measure/baseline.ts';
import { runGate } from '../../../src/lab/measure/gate.ts';
import type { Attempt } from '../../../src/lab/measure/gate.ts';
import { buildGateReport } from '../../../src/lab/measure/report.ts';
import type { GateReport } from '../../../src/lab/measure/report.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import type { BatchMeasurement } from '../../../src/lab/measure/types.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';
import { HOST, REBUFFERING, STARTUP, baselineOf, rebufferBatch, startupBatch } from './fixtures.ts';

// The A/A summary reads the reports of the gate. The reports here come from the real gate loop and the real report builder over
// synthetic batches, so that a change of either shows up as a failure and not as a test that still passes on an old shape.

const LIMITS: PerfLimits = { ...PERF_LIMITS, startupMedianRel: 0.2, startupTailRel: 0.5, startupFloorMs: 10 };
const QUIET = [90, 92, 95, 98, 100, 100, 102, 105, 110, 110];
const constant = (value: number, n = 10): number[] => Array.from({ length: n }, () => value);
const shifted = (by: number): number[] => QUIET.map((value) => value + by);
const BASELINE = baselineOf([
  { spec: STARTUP, batch: startupBatch(QUIET) },
  { spec: REBUFFERING, batch: rebufferBatch(constant(0)) },
]);

type Script = Partial<Record<Attempt, BatchMeasurement>>;

async function pass(
  startup: Script,
  options: {
    machine?: BaselineMachine;
    warnings?: string[];
    baseline?: boolean;
    profile?: 'chromium' | 'webkit';
  } = {},
): Promise<GateReport> {
  const script: Record<string, Script> = {
    'PB-PERF-001': startup,
    'PB-PERF-003': { first: rebufferBatch(constant(0)) },
  };
  const result = await runGate({
    specs: [STARTUP, REBUFFERING],
    baseline: BASELINE,
    limits: LIMITS,
    measure: async (spec, attempt) => {
      const batch = script[spec.id]?.[attempt];
      if (!batch) throw new Error(`no ${attempt} batch scripted for ${spec.id}`);
      return batch;
    },
  });
  return buildGateReport({
    envId: 'local-darwin-arm64',
    profile: options.profile ?? 'chromium',
    generatedAt: '2026-11-04T10:00:00.000Z',
    result,
    baseline:
      options.baseline === false
        ? null
        : { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline: BASELINE },
    host: HOST,
    ...(options.machine ? { machine: options.machine } : {}),
    browser: { name: 'chromium', version: '156.0.0.0', userAgent: 'UA', cpuThrottleRate: null },
    ffmpeg: '9.0',
    warnings: options.warnings ?? [],
    limits: LIMITS,
  });
}

const named = (reports: GateReport[]) =>
  reports.map((report, index) => ({ file: `aa/${index + 1}.json`, report }));
const startupOf = (summary: ReturnType<typeof summarizeAa>) =>
  summary.metrics.find((m) => m.scenario === 'PB-PERF-001' && m.metric === 'startupMs')!;

describe('PB-PERF A/A: counting what the gate got wrong on an unchanged build', () => {
  it('counts no false positive, and no alarm, when every pass is within the thresholds', async () => {
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }),
        await pass({ first: startupBatch(shifted(5)) }),
        await pass({ first: startupBatch(shifted(-3)) }),
      ]),
    );
    expect(summary).toMatchObject({
      kind: 'perf-aa',
      envId: 'local-darwin-arm64',
      profile: 'chromium',
      passes: 3,
      scenarios: ['PB-PERF-001', 'PB-PERF-003'],
      exitCodes: { '0': 3, '1': 0, '2': 0 },
      falsePositives: 0,
      firstBatchAlarms: 0,
      notReproduced: 0,
    });
    expect(summary.baseline).toMatchObject({
      commit: 'abc1234',
      browserVersion: '156.0.0.0',
      runsPerScenario: 10,
    });
  });

  it('keeps, per metric, what it was allowed, how far the worst pass went and how the batches spread', async () => {
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }),
        await pass({ first: startupBatch(shifted(5)) }),
        await pass({ first: startupBatch(shifted(-3)) }),
      ]),
    );
    const startup = startupOf(summary);
    expect(startup).toMatchObject({
      gated: true,
      tailStatistic: 'p90',
      passes: 3,
      baseline: { median: 100, tail: 110, runs: 10 },
      // 20 % of 100 = 20 against the 10 ms floor; 50 % of 110 = 55.
      allowed: { median: 20, tail: 55 },
      medians: [100, 105, 97],
      worst: { median: 5, tail: 5 },
      firstBatchAlarms: 0,
      reproduced: 0,
    });
    expect(allowanceUsed(startup.worst.median, startup.allowed.median)).toBeCloseTo(0.25, 10);
    // The sample standard deviation of 100, 105 and 97.
    expect(startup.betweenBatch.sd).toBeCloseTo(4.0415, 3);
    expect(startup.betweenBatch.relativeSd).toBeCloseTo(0.040415, 5);
  });

  it('reports a first-batch alarm that did not reproduce as an alarm, not as a false positive', async () => {
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }),
        await pass({ first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) }),
      ]),
    );
    expect(summary).toMatchObject({
      exitCodes: { '0': 2, '1': 0, '2': 0 },
      falsePositives: 0,
      firstBatchAlarms: 1,
      notReproduced: 1,
    });
    expect(startupOf(summary)).toMatchObject({ firstBatchAlarms: 1, reproduced: 0 });
    expect(summary.runs.map((run) => run.alarmedScenarios)).toStrictEqual([[], ['PB-PERF-001']]);
  });

  it('counts a regression that reproduced as a false positive', async () => {
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }),
        await pass({ first: startupBatch(constant(300)), remeasure: startupBatch(constant(280)) }),
      ]),
    );
    expect(summary).toMatchObject({
      exitCodes: { '0': 1, '1': 1, '2': 0 },
      falsePositives: 1,
      firstBatchAlarms: 1,
      notReproduced: 0,
    });
    expect(startupOf(summary)).toMatchObject({ firstBatchAlarms: 1, reproduced: 1 });
    expect(startupOf(summary).worst.median).toBe(200);
  });

  it('takes the load of a pass from the machine facts when the gate recorded them, else from its batches', async () => {
    const machine: BaselineMachine = {
      invokedVia: 'docker:pw',
      dockerCpus: 4,
      quiet: null,
      loadBeforeProfile: 0.7,
      loadAfterProfile: 2.2,
    };
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }, { machine }),
        await pass({ first: startupBatch(QUIET) }),
      ]),
    );
    expect(summary.runs[0]!.load).toStrictEqual({ before: 0.7, after: 2.2 });
    // Without machine facts: the first batch started at 1.5 and the last one (PB-PERF-003) ended at 1.
    expect(summary.runs[1]!.load).toStrictEqual({ before: 1.5, after: 1 });
    expect(summary.host).toMatchObject({ cpus: 12, invokedVia: 'docker:pw', dockerCpus: 4 });
  });

  it('survives JSON unchanged: no infinity and no NaN where a number was meant', async () => {
    const summary = summarizeAa(
      named([
        await pass({ first: startupBatch(QUIET) }),
        await pass({ first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) }),
      ]),
    );
    expect(JSON.parse(JSON.stringify(summary))).toStrictEqual(summary);
  });
});

describe('PB-PERF A/A: refusing reports that are not one baseline measured again and again', () => {
  it('needs at least one report', () => {
    expect(() => summarizeAa([])).toThrow(/at least one gate report/);
  });

  it('refuses reports of another profile, another environment or another baseline', async () => {
    const chromium = await pass({ first: startupBatch(QUIET) });
    const webkit = await pass({ first: startupBatch(QUIET) }, { profile: 'webkit' });
    expect(() => summarizeAa(named([chromium, webkit]))).toThrow(
      /report 2 differs from the first in its profile/,
    );
    const elsewhere = { ...chromium, envId: 'docker-linux-arm64' };
    expect(() => summarizeAa(named([chromium, elsewhere]))).toThrow(/its environment/);
    const rebaselined = {
      ...chromium,
      baseline: { ...chromium.baseline!, generatedAt: '2026-11-05T00:00:00.000Z' },
    };
    expect(() => summarizeAa(named([chromium, rebaselined]))).toThrow(/its baseline/);
  });

  it('refuses a report without a baseline, and one that was run with an injection on purpose', async () => {
    const none = await pass({ first: startupBatch(QUIET) }, { baseline: false });
    expect(() => summarizeAa(named([none]))).toThrow(/has no baseline/);
    const injected = await pass(
      { first: startupBatch(QUIET) },
      { warnings: ['FAULTS WERE INJECTED ON PURPOSE into every session ([])'] },
    );
    expect(() => summarizeAa(named([injected]))).toThrow(
      /injection on purpose: it is a sensitivity check, not an A\/A/,
    );
  });
});

describe('PB-PERF A/A: how much of the allowance was used', () => {
  it.each([
    [-5, 20, 0],
    [0, 20, 0],
    [10, 20, 0.5],
    [20, 20, 1],
    [30, 20, 1.5],
    [0, 0, 0],
    [1, 0, Infinity],
    [5, null, null],
    [Number.NEGATIVE_INFINITY, 20, null],
  ])('a worst pass of %s against an allowance of %s uses %s', (worst, allowed, used) => {
    expect(allowanceUsed(worst, allowed)).toBe(used);
  });
});

describe('PB-PERF A/A: the Markdown', () => {
  it('leads with the false-positive count, then one row per gated metric, and lists what is only tracked', async () => {
    const markdown = renderAaMarkdown(
      summarizeAa(
        named([
          await pass({ first: startupBatch(QUIET) }),
          await pass({ first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) }),
        ]),
      ),
    );
    expect(markdown).toContain('## A/A check: chromium in `local-darwin-arm64`');
    expect(markdown).toContain('The gate was run **2 times** against its own baseline');
    expect(markdown).toContain('**False positives (exit code 1): 0 of 2.**');
    expect(markdown).toContain(
      'First-batch alarms (a gated metric failed in the first batch and a fresh batch was measured): 1; of those 1 did not reproduce.',
    );
    expect(markdown).toMatch(
      /\| PB-PERF-001 \| startupMs \| 100 ms \/ 110 ms \| 6\.8 % \| 20 ms \/ 55 ms \| 200 ms \/ 190 ms \| 1000 % \/ 345 % \|/,
    );
    expect(markdown).toContain('| PB-PERF-003 | rebufferCount |');
    expect(markdown).toContain('Tracked, not gated: PB-PERF-001 manifestMs.');
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
