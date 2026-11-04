import { describe, expect, it } from 'vitest';
import { runGate } from '../../../src/lab/measure/gate.ts';
import type { Attempt, GateRequest } from '../../../src/lab/measure/gate.ts';
import { HarnessError } from '../../../src/lab/measure/runner.ts';
import type { PerfLimits } from '../../../src/lab/measure/rules.ts';
import type { BatchMeasurement, ScenarioSpec } from '../../../src/lab/measure/types.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';
import { REBUFFERING, STARTUP, baselineOf, rebufferBatch, startupBatch } from './fixtures.ts';

// Round numbers as in decide.test.ts: the median of a startup may be worse by 20 % or 10 ms, the p90 by 50 % or 10 ms.
const LIMITS: PerfLimits = { ...PERF_LIMITS, startupMedianRel: 0.2, startupTailRel: 0.5, startupFloorMs: 10 };

const QUIET = [90, 92, 95, 98, 100, 100, 102, 105, 110, 110];
const constant = (value: number, n = 10): number[] => Array.from({ length: n }, () => value);

const BASELINE = baselineOf([
  { spec: STARTUP, batch: startupBatch(QUIET) },
  { spec: REBUFFERING, batch: rebufferBatch(constant(0)) },
]);

type Script = Partial<Record<string, Partial<Record<Attempt, BatchMeasurement | Error>>>>;

/** A `measure` that plays back scripted batches and records every call, so that what the gate measured, and when, can be read. */
function scripted(script: Script): { measure: GateRequest['measure']; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    measure: async (spec, attempt) => {
      calls.push(`${spec.id} ${attempt}`);
      const step = script[spec.id]?.[attempt];
      if (step === undefined) throw new Error(`the script has no ${attempt} batch for ${spec.id}`);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const gate = (
  specs: readonly ScenarioSpec[],
  script: Script,
  baseline: GateRequest['baseline'] = BASELINE,
) => {
  const { measure, calls } = scripted(script);
  return runGate({ specs, baseline, measure, limits: LIMITS }).then((result) => ({ result, calls }));
};

const GOOD = { first: startupBatch(QUIET) };
const SLOW = startupBatch(constant(300));

describe('PB-PERF gate loop: measure, judge, and confirm a failure with a fresh batch', () => {
  it('measures each scenario once when nothing fails, and exits 0', async () => {
    const { result, calls } = await gate([STARTUP, REBUFFERING], {
      'PB-PERF-001': GOOD,
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    expect(calls).toStrictEqual(['PB-PERF-001 first', 'PB-PERF-003 first']);
    expect(result.exitCode).toBe(0);
    expect(result.scenarios.map((s) => s.outcome.status)).toStrictEqual(['pass', 'pass']);
    expect(result.scenarios.every((s) => s.remeasure === null)).toBe(true);
    expect(result.problems).toStrictEqual([]);
  });

  it('measures a fresh batch only for the scenario that failed, and fails the build when the regression reproduces', async () => {
    const { result, calls } = await gate([STARTUP, REBUFFERING], {
      'PB-PERF-001': { first: SLOW, remeasure: startupBatch(constant(280)) },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    expect(calls).toStrictEqual(['PB-PERF-001 first', 'PB-PERF-001 remeasure', 'PB-PERF-003 first']);
    expect(result.exitCode).toBe(1);
    const startup = result.scenarios[0]!;
    expect(startup.outcome.status).toBe('regression');
    expect(startup.outcome.remeasured).toBe(true);
    expect(startup.first?.batch).toBe(SLOW);
    expect(startup.remeasure?.judgement?.failed).toBe(true);
    expect(result.scenarios[1]!.outcome.status).toBe('pass');
  });

  it('passes the build when the fresh batch is back to normal, and keeps both batches for the report', async () => {
    const { result } = await gate([STARTUP], {
      'PB-PERF-001': { first: SLOW, remeasure: startupBatch(QUIET) },
    });
    expect(result.exitCode).toBe(0);
    const startup = result.scenarios[0]!;
    expect(startup.outcome.status).toBe('pass');
    expect(startup.outcome.metrics.find((m) => m.metric === 'startupMs')?.verdict).toBe('not-reproduced');
    expect(startup.first?.judgement?.failed).toBe(true);
    expect(startup.remeasure?.judgement?.failed).toBe(false);
  });

  it('does not measure again what could not be judged: a different start rung is a problem, exit 2', async () => {
    const { result, calls } = await gate([STARTUP], {
      'PB-PERF-001': { first: startupBatch(constant(100), 360) },
    });
    expect(calls).toStrictEqual(['PB-PERF-001 first']);
    expect(result.exitCode).toBe(2);
    expect(result.problems[0]!.message).toMatch(/started on 360p here and on 720p in the baseline/);
  });

  it('keeps measuring the other scenarios after a harness problem, and reports every one', async () => {
    const { result, calls } = await gate([STARTUP, REBUFFERING], {
      'PB-PERF-001': { first: new HarnessError('launch', 'the browser of chromium did not start: boom') },
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    expect(calls).toStrictEqual(['PB-PERF-001 first', 'PB-PERF-003 first']);
    expect(result.exitCode).toBe(2);
    expect(result.scenarios.map((s) => s.outcome.status)).toStrictEqual(['problem', 'pass']);
    expect(result.problems).toStrictEqual([
      { scenario: 'PB-PERF-001', message: 'the browser of chromium did not start: boom' },
    ]);
  });

  it('reports a fresh batch that could not be measured as a problem, with the first batch kept', async () => {
    const { result } = await gate([STARTUP], {
      'PB-PERF-001': {
        first: SLOW,
        remeasure: new HarnessError('run', 'PB-PERF-001 on chromium, run 4 of 10: timed out'),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.problems[0]!.message).toMatch(
      /the first batch failed and the fresh batch to confirm it could not be measured: PB-PERF-001 on chromium, run 4 of 10: timed out/,
    );
    expect(result.scenarios[0]!.first?.judgement?.failed).toBe(true);
    expect(result.scenarios[0]!.outcome.remeasured).toBe(true);
  });

  it('lets a reproduced regression win over a harness problem in another scenario (exit 1)', async () => {
    const { result } = await gate([STARTUP, REBUFFERING], {
      'PB-PERF-001': { first: SLOW, remeasure: SLOW },
      'PB-PERF-003': { first: new HarnessError('run', 'x') },
    });
    expect(result.exitCode).toBe(1);
    expect(result.problems).toHaveLength(1);
  });

  it('does not swallow a bug of the harness: an error that is not a HarnessError propagates', async () => {
    await expect(
      gate([STARTUP], { 'PB-PERF-001': { first: new TypeError('undefined is not a function') } }),
    ).rejects.toThrow(TypeError);
  });

  it('reports a baseline that lacks a scenario, without measuring it', async () => {
    const partial = baselineOf([{ spec: STARTUP, batch: startupBatch(QUIET) }]);
    const { result, calls } = await gate([STARTUP, REBUFFERING], { 'PB-PERF-001': GOOD }, partial);
    expect(calls).toStrictEqual(['PB-PERF-001 first']);
    expect(result.exitCode).toBe(2);
    expect(result.problems[0]!.message).toMatch(
      /the baseline of chromium has no scenario PB-PERF-003: record the baseline again/,
    );
  });

  it('without a baseline (the caller allowed it) measures once and judges nothing', async () => {
    const { result, calls } = await gate([STARTUP], { 'PB-PERF-001': { first: SLOW } }, null);
    expect(calls).toStrictEqual(['PB-PERF-001 first']);
    expect(result.exitCode).toBe(0);
    expect(result.scenarios[0]!.first).toMatchObject({ judgement: null });
    expect(result.scenarios[0]!.outcome.metrics).toStrictEqual([]);
  });

  it('tells the caller about every scenario as it is settled', async () => {
    const seen: string[] = [];
    const { measure } = scripted({
      'PB-PERF-001': GOOD,
      'PB-PERF-003': { first: rebufferBatch(constant(0)) },
    });
    await runGate({
      specs: [STARTUP, REBUFFERING],
      baseline: BASELINE,
      measure,
      limits: LIMITS,
      onScenario: (r) => seen.push(r.spec.id),
    });
    expect(seen).toStrictEqual(['PB-PERF-001', 'PB-PERF-003']);
  });
});
