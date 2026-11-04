import { describe, expect, it } from 'vitest';
import { allowanceUsed, renderAaMarkdown, summarizeAa } from '../../../src/lab/measure/aa.ts';
import type { BaselineMachine, PerfHost } from '../../../src/lab/measure/baseline.ts';
import { runGate } from '../../../src/lab/measure/gate.ts';
import type { Attempt } from '../../../src/lab/measure/gate.ts';
import { buildPaired } from '../../../src/lab/measure/paired.ts';
import type { PairedReport } from '../../../src/lab/measure/paired.ts';
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
    /** The machine the pass ran on, when it is not the fixture's (which names no CPU model). */
    host?: PerfHost;
    /** The baseline the pass was compared with, when it is not the fixture's (which was recorded without a CPU model). */
    against?: typeof BASELINE;
    /** The paired gate's facts: the baseline is then the control this pass measured on its own machine. */
    paired?: PairedReport;
  } = {},
): Promise<GateReport> {
  const script: Record<string, Script> = {
    'PB-PERF-001': startup,
    'PB-PERF-003': { first: rebufferBatch(constant(0)) },
  };
  const result = await runGate({
    specs: [STARTUP, REBUFFERING],
    baseline: options.against ?? BASELINE,
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
        : { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline: options.against ?? BASELINE },
    host: options.host ?? HOST,
    ...(options.paired ? { paired: options.paired } : {}),
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

  it('takes the passes in the order they were measured, whatever order the files are given in (a glob sorts pass-10 before pass-2)', async () => {
    const early = await pass({ first: startupBatch(QUIET) });
    const middle = await pass({ first: startupBatch(shifted(5)) });
    const late = await pass({ first: startupBatch(shifted(-3)) });
    early.generatedAt = '2026-11-04T10:00:00.000Z';
    middle.generatedAt = '2026-11-04T10:05:00.000Z';
    late.generatedAt = '2026-11-04T10:10:00.000Z';
    const summary = summarizeAa([
      { file: 'aa/pass-10.json', report: late },
      { file: 'aa/pass-1.json', report: early },
      { file: 'aa/pass-2.json', report: middle },
    ]);
    expect(summary.runs.map((run) => run.file)).toStrictEqual([
      'aa/pass-1.json',
      'aa/pass-2.json',
      'aa/pass-10.json',
    ]);
    expect(startupOf(summary).medians).toStrictEqual([100, 105, 97]);
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

  it('counts the passes that could not be trusted and prints only the first line of their problems (the rest is in the JSON)', async () => {
    const failed = await pass({ first: startupBatch(QUIET) });
    failed.exitCode = 2;
    failed.verdict = 'problem';
    const message =
      "PB-PERF-002 on firefox, run 1 of 10: qa.waitFor('firstframe') timed out\n14 events so far:\n  #0 load-requested";
    failed.problems = [{ scenario: 'PB-PERF-002', message }];
    const summary = summarizeAa(named([await pass({ first: startupBatch(QUIET) }), failed]));
    expect(summary.exitCodes).toStrictEqual({ '0': 1, '1': 0, '2': 1 });
    expect(summary.runs[1]!.problems).toStrictEqual([message]);

    const markdown = renderAaMarkdown(summary);
    expect(markdown).toContain('**Passes that could not be trusted (exit code 2): 1 of 2.**');
    expect(markdown).toContain(
      "> Problem in aa/2.json: PB-PERF-002 on firefox, run 1 of 10: qa.waitFor('firstframe') timed out",
    );
    expect(markdown).not.toContain('14 events so far');
    expect(markdown).not.toContain('load-requested');
  });

  it('says nothing about untrusted passes when there were none', async () => {
    const markdown = renderAaMarkdown(summarizeAa(named([await pass({ first: startupBatch(QUIET) })])));
    expect(markdown).not.toContain('could not be trusted');
    expect(markdown).not.toContain('> Problem');
  });
});

describe('PB-PERF A/A: the machines the passes ran on (the passes of several jobs)', () => {
  const XEON_8370 = 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz';
  const XEON_8573 = 'Intel(R) Xeon(R) Platinum 8573C';
  const EPYC = 'AMD EPYC 9V74 80-Core Processor';
  const on = (cpuModel: string): PerfHost => ({ ...HOST, cpuModel });
  const recordedOn = (cpuModel: string): typeof BASELINE =>
    baselineOf(
      [
        { spec: STARTUP, batch: startupBatch(QUIET) },
        { spec: REBUFFERING, batch: rebufferBatch(constant(0)) },
      ],
      { host: on(cpuModel) },
    );
  /** The pass as measured at minute `minute` of the hour: jobs finish in an order of their own, and the summary reads them by time. */
  const at = (report: GateReport, minute: number): GateReport => {
    report.generatedAt = `2026-11-04T10:${String(minute).padStart(2, '0')}:00.000Z`;
    return report;
  };

  async function severalJobs(): Promise<GateReport[]> {
    const against = recordedOn(XEON_8370);
    return [
      at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 3),
      at(await pass({ first: startupBatch(shifted(5)) }, { host: on(XEON_8370), against }), 4),
      at(await pass({ first: startupBatch(shifted(-3)) }, { host: on(EPYC), against }), 2),
      at(await pass({ first: startupBatch(shifted(8)) }, { host: on(XEON_8573), against }), 1),
      at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 5),
    ];
  }

  it('accepts the passes of several jobs, lists the CPU model of every pass and counts the distinct models', async () => {
    const summary = summarizeAa(named(await severalJobs()));
    expect(summary.passes).toBe(5);
    expect(summary.runs.map((run) => run.cpuModel)).toStrictEqual([XEON_8573, EPYC, EPYC, XEON_8370, EPYC]);
    expect(summary.baseline.cpuModel).toBe(XEON_8370);
    // Most passes first; models with as many passes as another by name.
    expect(summary.machines).toStrictEqual({
      cpuModels: [
        { model: EPYC, passes: 3 },
        { model: XEON_8370, passes: 1 },
        { model: XEON_8573, passes: 1 },
      ],
      passesWithoutCpuModel: 0,
    });
  });

  it('says in the Markdown that the passes ran on several CPU models, and what that does to the spread', async () => {
    const markdown = renderAaMarkdown(summarizeAa(named(await severalJobs())));
    expect(markdown).toContain(
      `- CPU models: the baseline was recorded on ${XEON_8370}. The passes ran on 3 distinct CPU models: ${EPYC} (3 passes), ${XEON_8370} (1 pass), ${XEON_8573} (1 pass). The passes did not all run on the same machine, so the spread between them includes the difference between machines.`,
    );
  });

  it('prints one row per pass, in the order measured: verdict, CPU model, startup median against the baseline median, deviation', async () => {
    const against = recordedOn(EPYC);
    const failed = at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 6);
    failed.exitCode = 2;
    failed.verdict = 'problem';
    failed.scenarios = [];
    const reports = [
      failed,
      at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 1),
      at(await pass({ first: startupBatch(shifted(5)) }, { host: on(XEON_8370), against }), 2),
      at(await pass({ first: startupBatch(shifted(-3)) }, { host: on('Fake | CPU'), against }), 3),
      at(
        await pass(
          { first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) },
          { host: on(EPYC), against },
        ),
        4,
      ),
      at(
        await pass(
          { first: startupBatch(constant(300)), remeasure: startupBatch(constant(280)) },
          { host: on(XEON_8573), against },
        ),
        5,
      ),
    ];
    const summary = summarizeAa(named(reports));
    expect(summary.runs.map((run) => run.startup)).toStrictEqual([
      { scenario: 'PB-PERF-001', baselineMedian: 100, median: 100, deviation: 0 },
      { scenario: 'PB-PERF-001', baselineMedian: 100, median: 105, deviation: 0.05 },
      { scenario: 'PB-PERF-001', baselineMedian: 100, median: 97, deviation: -0.03 },
      { scenario: 'PB-PERF-001', baselineMedian: 100, median: 300, deviation: 2 },
      { scenario: 'PB-PERF-001', baselineMedian: 100, median: 300, deviation: 2 },
      null,
    ]);

    const markdown = renderAaMarkdown(summary);
    const table = markdown.split('\n').filter((line) => /^\| \d+ \|/.test(line));
    expect(markdown).toContain(
      'Every pass, in the order it was measured (startup is PB-PERF-001 startupMs: the median of the first batch of the pass against the median of the baseline):',
    );
    expect(markdown).toContain(
      '| pass | verdict | CPU model | startup median vs baseline median | deviation |',
    );
    expect(table).toStrictEqual([
      `| 1 | pass | ${EPYC} | 100 ms vs 100 ms | +0.0 % |`,
      `| 2 | pass | ${XEON_8370} | 105 ms vs 100 ms | +5.0 % |`,
      '| 3 | pass | Fake \\| CPU | 97 ms vs 100 ms | -3.0 % |',
      `| 4 | pass (first batch alarmed in PB-PERF-001, not reproduced) | ${EPYC} | 300 ms vs 100 ms | +200.0 % |`,
      `| 5 | REGRESSION (false positive) | ${XEON_8573} | 300 ms vs 100 ms | +200.0 % |`,
      `| 6 | problem (exit code 2) | ${EPYC} | - | - |`,
    ]);
  });

  it('says so when no pass measured startup, and keeps a row for each pass', async () => {
    const failed = await pass({ first: startupBatch(QUIET) }, { host: on(EPYC) });
    failed.exitCode = 2;
    failed.verdict = 'problem';
    failed.scenarios = [];
    const markdown = renderAaMarkdown(summarizeAa(named([failed])));
    expect(markdown).toContain('Every pass, in the order it was measured (no pass measured startup):');
    expect(markdown).toContain(`| 1 | problem (exit code 2) | ${EPYC} | - | - |`);
  });

  it('says "1 CPU model" and does not claim a difference between machines when every pass reported the same one', async () => {
    const against = recordedOn(XEON_8370);
    const summary = summarizeAa(
      named([
        at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 1),
        at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC), against }), 2),
      ]),
    );
    expect(summary.machines.cpuModels).toStrictEqual([{ model: EPYC, passes: 2 }]);
    const markdown = renderAaMarkdown(summary);
    expect(markdown).toContain(
      `- CPU models: the baseline was recorded on ${XEON_8370}. The passes ran on 1 CPU model: ${EPYC} (2 passes).`,
    );
    expect(markdown).not.toContain('did not all run on the same machine');
  });

  it('counts the passes that did not record a CPU model (reports written before it was), and says so', async () => {
    const legacy = await pass({ first: startupBatch(QUIET) });
    delete legacy.cpuModels;
    const mixed = summarizeAa(
      named([at(legacy, 1), at(await pass({ first: startupBatch(QUIET) }, { host: on(EPYC) }), 2)]),
    );
    expect(mixed.runs.map((run) => run.cpuModel)).toStrictEqual([null, EPYC]);
    expect(mixed.machines).toStrictEqual({
      cpuModels: [{ model: EPYC, passes: 1 }],
      passesWithoutCpuModel: 1,
    });
    expect(mixed.baseline.cpuModel).toBeNull();
    expect(renderAaMarkdown(mixed)).toContain(
      `- CPU models: the baseline was recorded on not recorded. The passes ran on 1 CPU model: ${EPYC} (1 pass). 1 pass did not record theirs.`,
    );

    const none = summarizeAa(
      named([await pass({ first: startupBatch(QUIET) }), await pass({ first: startupBatch(QUIET) })]),
    );
    expect(none.machines).toStrictEqual({ cpuModels: [], passesWithoutCpuModel: 2 });
    expect(renderAaMarkdown(none)).toContain(
      '- CPU models: the passes did not record theirs (the baseline was recorded on: not recorded).',
    );
    expect(renderAaMarkdown(none)).toContain('| 1 | pass | not recorded | 100 ms vs 100 ms | +0.0 % |');
  });

  it('survives JSON unchanged, with the machines in it', async () => {
    const summary = summarizeAa(named(await severalJobs()));
    expect(JSON.parse(JSON.stringify(summary))).toStrictEqual(summary);
  });
});

describe('PB-PERF A/A: the passes of the paired gate (each pass measured a control of its own)', () => {
  const CONTROL = 'b'.repeat(40);
  const HEAD_SHA = 'a'.repeat(40);
  const EPYC = 'AMD EPYC 9V74 80-Core Processor';
  const info = {
    controlRef: 'origin/main',
    controlCommit: CONTROL,
    headCommit: HEAD_SHA,
    checkout: 'created' as const,
    controlDir: null,
    aa: false,
    nodeModules: 'linked' as const,
    cpuModelAtControl: EPYC,
    wallMs: { controlPrepare: 25_000, controlMeasure: 370_000 },
  };
  const pairedWith = (overrides: Partial<typeof info> = {}): PairedReport =>
    buildPaired({ ...info, ...overrides }, { recordedByControl: EPYC, head: EPYC, headMs: 380_000 });
  /** The control a pass measured on its own machine: the startup data shifted by `by`, recorded at its own time. */
  const control = (by: number, minute: number): typeof BASELINE => ({
    ...baselineOf([
      { spec: STARTUP, batch: startupBatch(QUIET.map((value) => value + by)) },
      { spec: REBUFFERING, batch: rebufferBatch(constant(0)) },
    ]),
    generatedAt: `2026-11-04T09:${String(minute).padStart(2, '0')}:00.000Z`,
  });
  const at = (report: GateReport, minute: number): GateReport => {
    report.generatedAt = `2026-11-04T10:${String(minute).padStart(2, '0')}:00.000Z`;
    return report;
  };
  const shiftedBy = (by: number): number[] => QUIET.map((value) => value + by);

  async function threeControls(): Promise<GateReport[]> {
    return [
      // Control A: median 100, allowed 20 (20 %). The head is 10 worse: half of it.
      at(
        await pass(
          { first: startupBatch(shiftedBy(10)) },
          { against: control(0, 1), paired: pairedWith(), host: { ...HOST, cpuModel: EPYC } },
        ),
        1,
      ),
      // Control B, another machine: median 200, allowed 40. The head is 20 worse (half), then 30 worse (three quarters).
      at(
        await pass(
          { first: startupBatch(shiftedBy(120)) },
          { against: control(100, 2), paired: pairedWith(), host: { ...HOST, cpuModel: EPYC } },
        ),
        2,
      ),
      at(
        await pass(
          { first: startupBatch(shiftedBy(130)) },
          { against: control(100, 3), paired: pairedWith(), host: { ...HOST, cpuModel: EPYC } },
        ),
        3,
      ),
    ];
  }

  it('accepts passes whose controls are not the same baseline, and says that the gate was paired', async () => {
    const summary = summarizeAa(named(await threeControls()));
    expect(summary).toMatchObject({
      passes: 3,
      exitCodes: { '0': 3, '1': 0, '2': 0 },
      falsePositives: 0,
      paired: { controlRef: 'origin/main', controlCommit: CONTROL, headCommit: HEAD_SHA, aa: false },
    });
    const markdown = renderAaMarkdown(summary);
    expect(markdown).toContain(
      `The **paired** gate was run **3 times**: each pass measured its control (commit \`${CONTROL.slice(0, 12)}\`) with the control's own harness on the machine it ran on, minutes before the head (commit \`${HEAD_SHA.slice(0, 12)}\`), and judged the head against it, with nothing changed. The committed baselines were not used.`,
    );
    expect(markdown).toContain('each pass against its own control');
    expect(markdown).not.toContain('against its own baseline');
  });

  it('measures how much of the allowance a pass used against ITS control, and reports the worst of them', async () => {
    const summary = summarizeAa(named(await threeControls()));
    expect(startupOf(summary).perPass).toStrictEqual([
      { worse: { median: 10, tail: 10 }, allowed: { median: 20, tail: 55 } },
      { worse: { median: 20, tail: 20 }, allowed: { median: 40, tail: 105 } },
      { worse: { median: 30, tail: 30 }, allowed: { median: 40, tail: 105 } },
    ]);
    // Against the allowance of the first control the third pass would read 150 %; against its own control it used three quarters.
    expect(renderAaMarkdown(summary)).toMatch(/\| PB-PERF-001 \| startupMs \|[^\n]*\| 75 % \/ 29 % \|/);
  });

  it('says it is an A/A by construction when the control was the head', async () => {
    const reports = [
      at(
        await pass(
          { first: startupBatch(QUIET) },
          { against: control(0, 1), paired: pairedWith({ aa: true, controlCommit: HEAD_SHA }) },
        ),
        1,
      ),
      at(
        await pass(
          { first: startupBatch(QUIET) },
          { against: control(0, 2), paired: pairedWith({ aa: true, controlCommit: HEAD_SHA }) },
        ),
        2,
      ),
    ];
    const summary = summarizeAa(named(reports));
    expect(summary.paired).toMatchObject({ aa: true, controlCommit: HEAD_SHA });
    expect(renderAaMarkdown(summary)).toContain('(an A/A by construction: the control is the head)');
  });

  it('counts a pass whose control could not be measured as a pass that could not be trusted, and takes the baseline from another', async () => {
    const failed = at(await pass({ first: startupBatch(QUIET) }, { paired: pairedWith() }), 1);
    failed.exitCode = 2;
    failed.verdict = 'problem';
    failed.baseline = null;
    failed.scenarios = [];
    failed.problems = [
      { scenario: '*', message: 'measuring the control (chromium) failed (exit code 2)\nPROBLEM: x' },
    ];
    const good = at(
      await pass({ first: startupBatch(QUIET) }, { against: control(0, 2), paired: pairedWith() }),
      2,
    );
    const summary = summarizeAa(named([failed, good]));
    expect(summary.exitCodes).toStrictEqual({ '0': 1, '1': 0, '2': 1 });
    expect(summary.baseline.generatedAt).toBe('2026-11-04T09:02:00.000Z');
    expect(summary.runs[0]).toMatchObject({ exitCode: 2, startup: null });
    expect(renderAaMarkdown(summary)).toContain('| 1 | problem (exit code 2) |');
  });

  it('has nothing to summarize when the control of every pass failed', async () => {
    const failed = await pass({ first: startupBatch(QUIET) }, { paired: pairedWith() });
    failed.exitCode = 2;
    failed.baseline = null;
    failed.scenarios = [];
    expect(() => summarizeAa(named([failed]))).toThrow(
      /no pass has a baseline \(the control of every paired pass failed\)/,
    );
  });

  it('does not mix paired and unpaired passes, and does not mix controls or heads', async () => {
    const paired = await pass({ first: startupBatch(QUIET) }, { paired: pairedWith() });
    const unpaired = await pass({ first: startupBatch(QUIET) });
    expect(() => summarizeAa(named([paired, unpaired]))).toThrow(
      /report 2 is not paired and the first is paired/,
    );
    expect(() => summarizeAa(named([unpaired, paired]))).toThrow(
      /report 2 is paired and the first is not paired/,
    );
    const otherControl = await pass(
      { first: startupBatch(QUIET) },
      { paired: pairedWith({ controlCommit: 'c'.repeat(40) }) },
    );
    expect(() => summarizeAa(named([paired, otherControl]))).toThrow(
      /report 2 differs from the first in its control commit .*: an A\/A check is one control and one head measured again and again/,
    );
    const otherHead = await pass(
      { first: startupBatch(QUIET) },
      { paired: pairedWith({ headCommit: 'd'.repeat(40) }) },
    );
    expect(() => summarizeAa(named([paired, otherHead]))).toThrow(
      /differs from the first in its head commit/,
    );
  });

  it('survives JSON unchanged, per-pass allowances and paired facts included', async () => {
    const summary = summarizeAa(named(await threeControls()));
    expect(JSON.parse(JSON.stringify(summary))).toStrictEqual(summary);
  });
});
