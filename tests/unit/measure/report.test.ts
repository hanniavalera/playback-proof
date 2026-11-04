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
import type { BaselineMachine } from '../../../src/lab/measure/baseline.ts';
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
        : { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline: BASELINE },
    host: HOST,
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
