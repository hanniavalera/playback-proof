import { describe, expect, it } from 'vitest';
import { runGate } from '../../../src/lab/measure/gate.ts';
import type { Attempt, GateResult } from '../../../src/lab/measure/gate.ts';
import {
  buildGateReport,
  busyWarning,
  renderBatchSummary,
  renderGateMarkdown,
  renderGateText,
  serializeReport,
  summarizeBatch,
  textTable,
} from '../../../src/lab/measure/report.ts';
import type { BaselineMachine, PerfHost } from '../../../src/lab/measure/baseline.ts';
import { CPU_MODEL_DIFFERS_NOTE } from '../../../src/lab/measure/machine.ts';
import { buildPaired } from '../../../src/lab/measure/paired.ts';
import type { PairedReport } from '../../../src/lab/measure/paired.ts';
import type { GateReport } from '../../../src/lab/measure/report.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import type { BatchMeasurement, ScenarioSpec } from '../../../src/lab/measure/types.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';
import { HOST, REBUFFERING, STARTUP, baselineOf, rebufferBatch, startupBatch } from './fixtures.ts';

const LIMITS: PerfLimits = { ...PERF_LIMITS, startupMedianRel: 0.2, startupTailRel: 0.5, startupFloorMs: 10 };
const QUIET = [90, 92, 95, 98, 100, 100, 102, 105, 110, 110];
const constant = (value: number, n = 10): number[] => Array.from({ length: n }, () => value);
const BASELINE = baselineOf([
  { spec: STARTUP, batch: startupBatch(QUIET) },
  { spec: REBUFFERING, batch: rebufferBatch(constant(0)) },
]);

async function gated(
  script: Record<string, Partial<Record<Attempt, BatchMeasurement>>>,
  baseline: typeof BASELINE | null = BASELINE,
  specs: readonly ScenarioSpec[] = [STARTUP, REBUFFERING],
): Promise<GateResult> {
  return runGate({
    specs,
    baseline,
    limits: LIMITS,
    measure: async (spec, attempt) => {
      const batch = script[spec.id]?.[attempt];
      if (!batch) throw new Error(`no ${attempt} batch scripted for ${spec.id}`);
      return batch;
    },
  });
}

const report = (
  result: GateResult,
  extra: {
    setupProblems?: { scenario: string; message: string }[];
    baseline?: boolean;
    machine?: BaselineMachine;
    /** This machine's host facts, when they are not the fixture's (which names no CPU model). */
    host?: PerfHost;
    /** The baseline compared with, when it is not the fixture's (which was recorded without a CPU model). */
    against?: typeof BASELINE;
    /** The paired gate's facts: the baseline is then a control measured on this machine minutes ago. */
    paired?: PairedReport;
  } = {},
) =>
  buildGateReport({
    envId: 'local-darwin-arm64',
    profile: 'chromium',
    generatedAt: '2026-11-04T10:00:00.000Z',
    result,
    baseline:
      extra.baseline === false
        ? null
        : { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline: extra.against ?? BASELINE },
    host: extra.host ?? HOST,
    ...(extra.paired ? { paired: extra.paired } : {}),
    ...(extra.machine ? { machine: extra.machine } : {}),
    browser: { name: 'chromium', version: '156.0.0.0', userAgent: 'UA', cpuThrottleRate: null },
    ffmpeg: '9.0',
    warnings: [],
    limits: LIMITS,
    ...(extra.setupProblems ? { setupProblems: extra.setupProblems } : {}),
  });

describe('PB-PERF report: text tables', () => {
  it('pads every column to its widest cell and underlines the header', () => {
    expect(
      textTable(
        ['metric', 'n'],
        [
          ['startupMs', '10'],
          ['x', '3'],
        ],
      ),
    ).toBe(['metric     n', '---------  --', 'startupMs  10', 'x          3'].join('\n'));
  });
});

describe('PB-PERF report: what `npm run perf` prints for a batch', () => {
  it('shows the statistics of every metric, the start rung and the load, and says which metrics gate', () => {
    const text = renderBatchSummary(STARTUP, startupBatch(QUIET));
    expect(text.split('\n')[0]).toBe(
      'PB-PERF-001 startup (chromium): 10 runs after a warm-up, stream vod-cmaf, clean, start rung 720p, load average 1.5 -> 1.7',
    );
    expect(text).toMatch(/metric\s+n\s+median\s+p10\s+p90\s+min \.\. max\s+cv\s+role/);
    expect(text).toMatch(
      /startupMs\s+10\s+100 ms\s+91\.8 ms\s+110 ms\s+90 ms \.\. 110 ms\s+6\.8 %\s+gates \(startup\)/,
    );
    expect(text).toMatch(/manifestMs\s+10\s+10 ms.*\s+tracked/);
  });

  it('names a window that is pinned, and a start rung that was not the same in every run', () => {
    const batch = startupBatch(QUIET);
    batch.runs[0] = { ...batch.runs[0]!, startRungHeight: 360 };
    expect(renderBatchSummary({ ...STARTUP, pinnedHeight: 720 }, batch).split('\n')[0]).toContain(
      'start rung mixed (360p, 720p), window pinned at 720p',
    );
  });

  it('summarizes without the warm-up and leaves a metric nobody produced empty', () => {
    const batch = startupBatch([100, 200]);
    batch.runs = batch.runs.map((run) => ({
      ...run,
      values: { startupMs: run.values.startupMs ?? null, manifestMs: null },
    }));
    const [startup, manifest] = summarizeBatch(STARTUP, batch);
    expect(startup!.summary).toMatchObject({ n: 2, median: 150 });
    expect(manifest!.summary).toBeNull();
    expect(renderBatchSummary(STARTUP, batch)).toMatch(/manifestMs\s+0\s+-/);
  });
});

describe('PB-PERF report: the machine was busy', () => {
  it('says nothing about a quiet machine', () => {
    expect(busyWarning([startupBatch(QUIET)], 12)).toBeNull();
  });

  it('warns when the load average of either end of any batch is above half of the CPUs, and names the worst', () => {
    const busy = { ...startupBatch(QUIET), loadAverage: { before: 2, after: 7.34 } };
    expect(busyWarning([startupBatch(QUIET), busy], 12)).toBe(
      'the machine was busy while this was measured (load average 7.3 on 12 CPUs, more than 50 % of them): the numbers are suspect, and a baseline should be recorded on a quiet machine',
    );
    expect(busyWarning([{ ...busy, loadAverage: { before: 6, after: 6 } }], 12)).toBeNull();
  });
});

describe('PB-PERF report: the gate table', () => {
  it('shows a pass with the numbers of both sides, the change and the threshold', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const text = renderGateText(report(result), result.scenarios);
    expect(text).toContain(
      'performance gate: chromium in local-darwin-arm64, baseline of 2026-11-04 (commit abc1234, 10 runs per scenario)',
    );
    expect(text).toMatch(
      /startupMs\s+100 ms \/ 110 ms\s+100 ms \/ 110 ms\s+\+0\.0 %\s+median \+20 %, p90 \+50 %, and more than 10 ms\s+pass/,
    );
    expect(text).toMatch(/rebufferCount\s+0 \/ 0\s+0 \/ 0\s+\+0\s+median \+0, p90 \+1\s+pass/);
    expect(text).toContain('verdict: PASS (exit code 0)');
  });

  it('says REGRESSION, with the reason of both batches, when a failure reproduced', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(constant(280)) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const text = renderGateText(report(result), result.scenarios);
    expect(text).toMatch(/startupMs\s+100 ms \/ 110 ms\s+300 ms \/ 300 ms\s+\+200\.0 %\s+.*\s+REGRESSION/);
    expect(text).toContain(
      'startupMs: median 100 ms -> 300 ms (+200.0 %): worse by 200 ms, more than the 20 ms allowed',
    );
    expect(text).toContain('fresh batch (a new browser, new runs)');
    expect(text).toContain('startupMs: REGRESSION: median 100 ms -> 280 ms (+180.0 %)');
    expect(text).toContain('verdict: REGRESSION (exit code 1)');
  });

  it('says that a regression did not reproduce, and still passes', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const text = renderGateText(report(result), result.scenarios);
    expect(text).toMatch(/startupMs\s+.*\s+not reproduced/);
    expect(text).toContain(
      'startupMs: not reproduced: the fresh batch passed, within the limits (median +20 %, p90 +50 %, and more than 10 ms); the first measurement is discarded and the build passes',
    );
    expect(text).toContain('verdict: PASS (exit code 0)');
  });

  it('prints a problem as a problem, with the exit code of the harness', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(100), 360) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const text = renderGateText(report(result), result.scenarios);
    expect(text).toMatch(/PROBLEM: the player started on 360p here and on 720p in the baseline/);
    expect(text).toContain('verdict: PROBLEM (exit code 2)');
  });

  it('without a baseline, reports the numbers and says nothing is judged', async () => {
    const result = await gated({ 'PB-PERF-001': { first: startupBatch(QUIET) } }, null, [STARTUP]);
    const text = renderGateText(report(result, { baseline: false }), result.scenarios);
    expect(text).toContain('NO BASELINE');
    expect(text).toContain('no baseline: these numbers are reported, nothing is judged');
    expect(text).toMatch(/startupMs\s+100 ms\s+p90\s+110 ms/);
  });

  it('shows a metric that a noisy baseline stopped from gating, with the reason', async () => {
    const noisy = baselineOf([
      { spec: STARTUP, batch: startupBatch([50, 150, 60, 140, 100, 100, 55, 145, 100, 100]) },
    ]);
    const result = await gated({ 'PB-PERF-001': { first: startupBatch(constant(500)) } }, noisy, [STARTUP]);
    const text = renderGateText(report(result), result.scenarios);
    expect(text).toMatch(/startupMs\s+.*\s+tracked/);
    expect(text).toMatch(/startupMs: tracked, not gated: the baseline's coefficient of variation is 36\.9 %/);
  });
});

describe('PB-PERF report: the Markdown summary and the JSON report', () => {
  it('writes a table per scenario and explains a regression with both batches', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(constant(280)) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const markdown = renderGateMarkdown(report(result));
    expect(markdown).toContain('## Performance gate: chromium in `local-darwin-arm64`: REGRESSION');
    expect(markdown).toContain('### PB-PERF-001 startup: regression (re-measured)');
    expect(markdown).toContain(
      '| metric | baseline median / tail | current median / tail | change | threshold | verdict |',
    );
    expect(markdown).toContain('| startupMs | 100 ms / 110 ms | 300 ms / 300 ms | +200.0 % |');
    expect(markdown).toMatch(
      /- `startupMs`: median 100 ms -> 300 ms[^\n]*\n {2}- fresh batch: median 100 ms -> 280 ms/,
    );
    expect(markdown).toContain('### PB-PERF-003 rebuffering: pass');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('says in the Markdown too that a failure that did not reproduce was discarded', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const markdown = renderGateMarkdown(report(result));
    expect(markdown).toContain('## Performance gate: chromium in `local-darwin-arm64`: PASS');
    expect(markdown).toContain('### PB-PERF-001 startup: pass (re-measured)');
    expect(markdown).toMatch(
      /- `startupMs`: median 100 ms -> 300 ms[^\n]*\n {2}- fresh batch passed, within the limits[^\n]*: not reproduced, so the first measurement is discarded and the build passes/,
    );
  });

  it('quotes a problem, a setup problem and a warning', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(constant(100), 360) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const built = report(result, {
      setupProblems: [{ scenario: '*', message: 'the content of stream vod-cmaf changed' }],
    });
    built.warnings.push('the browser is 157.0.0.0; the baseline was recorded on 156.0.0.0');
    const markdown = renderGateMarkdown(built);
    expect(markdown).toContain('> **Problem:** the player started on 360p here');
    expect(markdown).toContain('> **Problem:** the content of stream vod-cmaf changed');
    expect(markdown).toContain('> Warning: the browser is 157.0.0.0');
  });

  it('keeps every run, the policy that judged them and the exit code in the JSON, and reads back as written', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const built = report(result);
    const parsed = JSON.parse(serializeReport(built)) as typeof built;
    expect(parsed).toStrictEqual(built);
    expect(parsed).toMatchObject({ kind: 'perf-gate-report', verdict: 'pass', exitCode: 0 });
    expect(parsed.scenarios[0]!.first!.runs).toHaveLength(10);
    expect(parsed.scenarios[0]!.first!.warmup).not.toBeNull();
    expect(parsed.policy.limits.startupMedianRel).toBe(0.2);
    expect(parsed.policy.rules.startup).toMatchObject({ kind: 'relative', medianShare: 0.2 });
    expect(parsed.scenarios[0]!.first!.summaries.startupMs).toMatchObject({ n: 10, median: 100 });
  });

  it('keeps how the profile was started and the load around it in the JSON, null when it is not known', async () => {
    const result = await gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    const machine: BaselineMachine = {
      invokedVia: 'docker:pw',
      dockerCpus: 4,
      quiet: { maxLoad: 3, hostLoad: 1.1, waitedMs: 0 },
      loadBeforeProfile: 1.1,
      loadAfterProfile: 1.9,
    };
    expect(report(result, { machine }).current.machine).toStrictEqual(machine);
    expect(report(result).current.machine).toBeNull();
  });

  it('turns a setup problem into exit code 2 unless a regression reproduced', async () => {
    const passing = await gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    expect(report(passing, { setupProblems: [{ scenario: '*', message: 'x' }] })).toMatchObject({
      exitCode: 2,
      verdict: 'problem',
    });
    const failing = await gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(constant(300)) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    expect(report(failing, { setupProblems: [{ scenario: '*', message: 'x' }] })).toMatchObject({
      exitCode: 1,
      verdict: 'regression',
    });
  });
});

describe('PB-PERF report: which machine the baseline came from and which one this is', () => {
  const XEON = 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz';
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
  const passing = () =>
    gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
  const regressing = () =>
    gated({
      'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(constant(300)) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
  const LINE = `baseline machine: ${XEON}; this machine: ${EPYC}`;

  it('prints one line with both models in the terminal, the Markdown and the JSON, and a note when they differ', async () => {
    const result = await passing();
    const built = report(result, { against: recordedOn(XEON), host: on(EPYC) });

    const text = renderGateText(built, result.scenarios).split('\n\n')[0]!.split('\n');
    expect(text).toStrictEqual([
      'performance gate: chromium in local-darwin-arm64, baseline of 2026-11-04 (commit abc1234, 10 runs per scenario)',
      LINE,
      `note: ${CPU_MODEL_DIFFERS_NOTE}`,
    ]);

    const markdown = renderGateMarkdown(built).split('\n');
    expect(markdown).toContain(LINE);
    expect(markdown).toContain(`> Note: ${CPU_MODEL_DIFFERS_NOTE}`);

    const parsed = JSON.parse(serializeReport(built)) as GateReport;
    expect(parsed.cpuModels).toStrictEqual({
      baseline: XEON,
      current: EPYC,
      differs: true,
      line: LINE,
      note: CPU_MODEL_DIFFERS_NOTE,
    });
    expect(parsed.current.host.cpuModel).toBe(EPYC);
  });

  it('prints the line without a note when the two are the same model', async () => {
    const result = await passing();
    const built = report(result, { against: recordedOn(EPYC), host: on(EPYC) });
    const line = `baseline machine: ${EPYC}; this machine: ${EPYC}`;
    const text = renderGateText(built, result.scenarios);
    expect(text).toContain(line);
    expect(text).not.toContain('the CPU model differs');
    expect(renderGateMarkdown(built)).toContain(line);
    expect(renderGateMarkdown(built)).not.toContain('the CPU model differs');
    expect(built.cpuModels).toMatchObject({ differs: false, note: null });
  });

  it('says "not recorded" for a baseline recorded before the model was, and makes no claim of a difference', async () => {
    const result = await passing();
    const built = report(result, { host: on(EPYC) });
    const line = `baseline machine: not recorded; this machine: ${EPYC}`;
    expect(renderGateText(built, result.scenarios)).toContain(line);
    expect(renderGateMarkdown(built)).toContain(line);
    expect(built.cpuModels).toStrictEqual({
      baseline: null,
      current: EPYC,
      differs: false,
      line,
      note: null,
    });
    expect(renderGateText(built, result.scenarios)).not.toContain('note:');
  });

  it('says "unknown" for a machine that does not name its CPU, and says there is no baseline when there is none', async () => {
    const result = await passing();
    const unnamed = report(result, { against: recordedOn(XEON) });
    expect(unnamed.cpuModels).toMatchObject({ current: null, differs: false });
    expect(renderGateText(unnamed, result.scenarios)).toContain(
      `baseline machine: ${XEON}; this machine: unknown`,
    );

    const none = report(result, { baseline: false, host: on(EPYC) });
    expect(renderGateText(none, result.scenarios)).toContain(
      `baseline machine: no baseline; this machine: ${EPYC}`,
    );
    expect(renderGateMarkdown(none)).toContain(`baseline machine: no baseline; this machine: ${EPYC}`);
  });

  it('changes no verdict, no exit code and no number: a different CPU model is something to read, not a reason', async () => {
    // Everything but the machine facts is identical, for a build that passes and for one that regresses.
    const strip = (built: GateReport): unknown => ({
      ...built,
      cpuModels: null,
      current: { ...built.current, host: HOST },
    });
    for (const [result, exitCode] of [
      [await passing(), 0],
      [await regressing(), 1],
    ] as const) {
      const alike = report(result, { against: recordedOn(EPYC), host: on(EPYC) });
      const differing = report(result, { against: recordedOn(XEON), host: on(EPYC) });
      expect(differing.cpuModels?.differs).toBe(true);
      expect(alike.cpuModels?.differs).toBe(false);
      expect(differing.exitCode).toBe(exitCode);
      expect(alike.exitCode).toBe(exitCode);
      expect(strip(differing)).toStrictEqual(strip(alike));
      expect(differing.warnings).toStrictEqual(alike.warnings);
    }
  });

  it('renders a report written before the model was recorded, without a line', async () => {
    const result = await passing();
    const old = report(result, { host: on(EPYC) });
    delete old.cpuModels;
    expect(renderGateText(old, result.scenarios)).not.toContain('baseline machine');
    expect(renderGateMarkdown(old)).not.toContain('baseline machine');
  });
});

describe('PB-PERF report: the paired gate', () => {
  const CONTROL = 'b'.repeat(40);
  const HEAD_SHA = 'a'.repeat(40);
  const EPYC = 'AMD EPYC 9V74 80-Core Processor';
  const XEON = 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz';
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
  const pairedOn = (control: string, head: string): PairedReport =>
    buildPaired(info, { recordedByControl: control, head, headMs: 380_000 });
  const LINE = `paired: the baseline was measured on this machine minutes ago from ${CONTROL.slice(0, 12)}; the committed baselines of this environment were not used`;
  const passing = () =>
    gated({
      'PB-PERF-001': { first: startupBatch(QUIET) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });

  it('opens the terminal report, the Markdown (so the job summary) and the JSON with the line that says what the baseline is', async () => {
    const result = await passing();
    const built = report(result, { paired: pairedOn(EPYC, EPYC), host: { ...HOST, cpuModel: EPYC } });
    expect(renderGateText(built, result.scenarios).split('\n')[0]).toBe(LINE);
    expect(renderGateMarkdown(built).split('\n').slice(0, 3)).toStrictEqual([
      LINE,
      '',
      '## Performance gate: chromium in `local-darwin-arm64`: PASS',
    ]);
    const parsed = JSON.parse(serializeReport(built)) as GateReport;
    expect(parsed.paired).toStrictEqual(built.paired);
    expect(parsed.paired).toMatchObject({
      controlRef: 'origin/main',
      controlCommit: CONTROL,
      headCommit: HEAD_SHA,
      checkout: 'created',
      aa: false,
      line: LINE,
      wallMs: { controlPrepare: 25_000, controlMeasure: 370_000, head: 380_000 },
      cpuModels: { control: EPYC, head: EPYC, same: true, warning: null },
    });
  });

  it('says that a control that is the head is an A/A by construction', async () => {
    const result = await passing();
    const paired = buildPaired(
      { ...info, aa: true, controlCommit: HEAD_SHA },
      { recordedByControl: EPYC, head: EPYC, headMs: 1 },
    );
    const built = report(result, { paired });
    expect(renderGateText(built, result.scenarios).split('\n')[0]).toContain(
      '(A/A by construction: the control is this very commit)',
    );
    expect(renderGateMarkdown(built).split('\n')[0]).toContain(
      '(A/A by construction: the control is this very commit)',
    );
    expect(built.paired?.aa).toBe(true);
  });

  it('prints the finding under the first line when the control and the head did not share a CPU model, and changes no verdict, exit code or number', async () => {
    for (const result of [
      await passing(),
      await gated({
        'PB-PERF-001': { first: startupBatch(constant(300)), remeasure: startupBatch(constant(300)) },
        'PB-PERF-003': { first: rebufferBatch(constant(0)) },
      }),
    ]) {
      const same = report(result, { paired: pairedOn(EPYC, EPYC), host: { ...HOST, cpuModel: EPYC } });
      const apart = report(result, { paired: pairedOn(XEON, EPYC), host: { ...HOST, cpuModel: EPYC } });
      expect(apart.paired?.cpuModels).toMatchObject({ same: false, control: XEON, head: EPYC });
      const warning = apart.paired!.cpuModels.warning!;
      expect(renderGateText(apart, result.scenarios).split('\n').slice(0, 2)).toStrictEqual([
        LINE,
        `WARNING: ${warning}`,
      ]);
      expect(renderGateMarkdown(apart).split('\n').slice(0, 4)).toStrictEqual([
        LINE,
        '',
        `> **WARNING:** ${warning}`,
        '',
      ]);
      expect(renderGateText(same, result.scenarios)).not.toContain('WARNING');
      expect(apart.exitCode).toBe(same.exitCode);
      expect(apart.verdict).toBe(same.verdict);
      expect({ ...apart, paired: null }).toStrictEqual({ ...same, paired: null });
    }
  });

  it('leaves an unpaired report as it was: no paired object, and the heading first', async () => {
    const result = await passing();
    const built = report(result);
    expect(built).not.toHaveProperty('paired');
    expect(renderGateMarkdown(built).split('\n')[0]).toBe(
      '## Performance gate: chromium in `local-darwin-arm64`: PASS',
    );
    expect(renderGateText(built, result.scenarios).split('\n')[0]).toMatch(/^performance gate: chromium/);
    expect(JSON.stringify(built)).not.toContain('"paired"');
  });

  it('reports a control that could not be measured as a problem of the gate (exit code 2), with no scenario and no committed baseline used', () => {
    const lost = buildPaired(
      { ...info, controlCommit: null, headCommit: HEAD_SHA, nodeModules: null },
      { recordedByControl: undefined, head: EPYC, headMs: 0 },
    );
    const built = report(
      { scenarios: [], problems: [], exitCode: 2 },
      {
        baseline: false,
        paired: lost,
        setupProblems: [
          { scenario: '*', message: 'measuring the control (chromium) failed (exit code 2)\nPROBLEM: x' },
        ],
      },
    );
    expect(built).toMatchObject({ exitCode: 2, verdict: 'problem', baseline: null, scenarios: [] });
    expect(renderGateMarkdown(built).split('\n')[0]).toBe(
      'paired: no control was measured on this machine; the committed baselines of this environment were not used',
    );
    expect(renderGateMarkdown(built)).toContain(
      '> **Problem:** measuring the control (chromium) failed (exit code 2)',
    );
    expect(built.paired?.cpuModels).toMatchObject({ control: EPYC, head: EPYC, warning: null });
  });
});
