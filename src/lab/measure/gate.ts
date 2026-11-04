import { PERF_LIMITS } from '../../shared/criteria.ts';
import type { Baseline } from './baseline.ts';
import { exitCodeOf, judgeBatch, needsRemeasure, settle } from './decide.ts';
import type { BatchJudgement, ExitCode, Problem, ScenarioOutcome } from './decide.ts';
import type { PerfLimits } from './rules.ts';
import { HarnessError } from './runner.ts';
import type { BatchMeasurement, ScenarioSpec } from './types.ts';

// The gate as a loop over the scenarios of a profile: measure a batch, judge it against the baseline, and, when it failed, measure a FRESH
// batch (a new browser process, new contexts, new sessions) and settle the two (ADR-125). What a batch is and how it is measured is
// injected (`measure`), so that this file is tested with synthetic batches and no browser.

export type Attempt = 'first' | 'remeasure';

export interface GateRequest<S extends ScenarioSpec = ScenarioSpec> {
  /** The scenarios of the profile, in catalog order. */
  specs: readonly S[];
  /** The baseline of this environment and profile; null when there is none and the caller allowed that (the numbers are only reported). */
  baseline: Baseline | null;
  /** Measures one batch of a scenario. A HarnessError is a problem of the harness; anything else is a bug and propagates. */
  measure: (spec: S, attempt: Attempt) => Promise<BatchMeasurement>;
  limits?: PerfLimits;
  onScenario?: (result: ScenarioResult) => void;
}

export interface MeasuredBatch {
  batch: BatchMeasurement;
  /** Null when there is no baseline to judge against. */
  judgement: BatchJudgement | null;
}

export interface ScenarioResult {
  spec: ScenarioSpec;
  first: MeasuredBatch | null;
  /** The fresh batch measured to confirm a first failure. */
  remeasure: MeasuredBatch | null;
  outcome: ScenarioOutcome;
}

export interface GateResult {
  scenarios: ScenarioResult[];
  /** Everything that made a scenario undecidable, in one list (also inside each outcome). */
  problems: Problem[];
  exitCode: ExitCode;
}

function problemOutcome(scenario: string, message: string, remeasured = false): ScenarioOutcome {
  return { scenario, status: 'problem', metrics: [], problems: [{ scenario, message }], remeasured };
}

export async function runGate<S extends ScenarioSpec>(request: GateRequest<S>): Promise<GateResult> {
  const limits = request.limits ?? PERF_LIMITS;
  const results: ScenarioResult[] = [];

  for (const spec of request.specs) {
    const result = await gateScenario(spec, request, limits);
    results.push(result);
    request.onScenario?.(result);
  }

  const problems = results.flatMap((result) => result.outcome.problems);
  return { scenarios: results, problems, exitCode: exitCodeOf(results.map((result) => result.outcome)) };
}

async function gateScenario<S extends ScenarioSpec>(
  spec: S,
  request: GateRequest<S>,
  limits: PerfLimits,
): Promise<ScenarioResult> {
  const { baseline } = request;
  const scenarioBaseline = baseline?.scenarios[spec.id];
  const fail = (
    message: string,
    first: MeasuredBatch | null = null,
    attemptedRemeasure = false,
  ): ScenarioResult => ({
    spec,
    first,
    remeasure: null,
    outcome: problemOutcome(spec.id, message, attemptedRemeasure),
  });

  if (baseline !== null && !scenarioBaseline) {
    return fail(`the baseline of ${baseline.profile} has no scenario ${spec.id}: record the baseline again`);
  }

  let firstBatch: BatchMeasurement;
  try {
    firstBatch = await request.measure(spec, 'first');
  } catch (error) {
    if (error instanceof HarnessError) return fail(error.message);
    throw error;
  }

  if (!scenarioBaseline) {
    // No baseline, and the caller said that is allowed: the numbers are reported, nothing is judged.
    return {
      spec,
      first: { batch: firstBatch, judgement: null },
      remeasure: null,
      outcome: { scenario: spec.id, status: 'pass', metrics: [], problems: [], remeasured: false },
    };
  }

  const firstJudgement = judgeBatch(spec, scenarioBaseline, firstBatch, limits);
  const first: MeasuredBatch = { batch: firstBatch, judgement: firstJudgement };
  if (!needsRemeasure(firstJudgement))
    return { spec, first, remeasure: null, outcome: settle(firstJudgement, null) };

  let freshBatch: BatchMeasurement;
  try {
    freshBatch = await request.measure(spec, 'remeasure');
  } catch (error) {
    if (error instanceof HarnessError)
      return fail(
        `the first batch failed and the fresh batch to confirm it could not be measured: ${error.message}`,
        first,
        true,
      );
    throw error;
  }
  const freshJudgement = judgeBatch(spec, scenarioBaseline, freshBatch, limits);
  const remeasure: MeasuredBatch = { batch: freshBatch, judgement: freshJudgement };
  return { spec, first, remeasure, outcome: settle(firstJudgement, freshJudgement) };
}
