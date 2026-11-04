import { parseArgs } from 'node:util';
import { PERF_LIMITS } from '../../shared/criteria.ts';
import type { FaultRule } from '../../shared/faults.ts';
import { SCENARIOS } from './scenarios.ts';
import { DEFAULT_CONTROL_REF, refProblem } from './paired.ts';
import { PERF_PROFILES, isPerfProfile } from './types.ts';
import type { PerfProfile } from './types.ts';

// The command line of perf/run.ts (`npm run perf`, `npm run perf:baseline`) and perf/gate.ts (`npm run perf:gate`), parsed here so that it is
// unit-tested without a browser.

/** The first port of the performance range of docs/CONTRACTS.md (4700 to 4729) that the Jenkins agent's compose project does not use. */
export const DEFAULT_PERF_PORT = 4710;

/** The profiles run when none is named: the first performance job of TEST_STRATEGY.md section 6.3 (Chromium and its throttled twin). */
export const DEFAULT_PROFILES: readonly PerfProfile[] = ['chromium', 'chromium-cpu4x'];

export interface PerfOptions {
  mode: 'gate' | 'run';
  profiles: PerfProfile[];
  /** Catalog ids to run; null: every scenario of each profile. */
  scenarios: string[] | null;
  /** Measured runs per batch (the warm-up not counted). */
  runs: number;
  warmupRuns: 0 | 1;
  port: number;
  /** Where the baselines are; null: perf/baselines of the checkout. */
  baselineDir: string | null;
  /** Where the reports are written; null: reports/perf of the checkout. */
  reportsDir: string | null;
  /** A run that has not finished by then fails its batch. */
  runTimeoutMs: number;
  /** Fault rules added to every session: the way to inject a regression on purpose (the sensitivity check). Empty in every normal run. */
  injectFaults: FaultRule[];
  /** A CPU throttle rate that replaces the profile's own (Chromium profiles only): "the page does more main-thread work", injected on purpose. */
  injectCpuThrottle: number | null;
  /** Which batches get the injection: every one, or only the FIRST batch of each scenario (a one-off disturbance that the fresh batch must not see). */
  injectOn: 'all' | 'first';
  /** gate: a missing baseline is not a failure (for local use): the numbers are reported and nothing is judged. */
  allowMissingBaseline: boolean;
  /** gate: judge against a CONTROL (the base build) measured on THIS machine minutes before, not against the committed baselines (ADR-179). */
  paired: boolean;
  /** paired: the control build as a git ref or commit; null: `origin/main`, or the checkout named by `controlDir`. */
  controlRef: string | null;
  /** paired: an existing checkout of the control, used instead of a detached worktree created for the run. */
  controlDir: string | null;
  /** run: record the baseline of each profile (`npm run perf:baseline`). */
  writeBaseline: boolean;
  help: boolean;
}

export class PerfUsageError extends Error {
  override name = 'PerfUsageError';
}

export const PERF_USAGE = `npm run perf -- [options]            measure the scenarios of the profiles and print their statistics
npm run perf:baseline -- [options]   the same, then record the baseline of each profile (perf/baselines/<env>/<profile>.json)
npm run perf:gate -- [options]       measure, compare with the baseline of this environment, re-measure a failure, decide

Exit codes: 0 pass; 1 a regression that reproduced (the gate only); 2 the measurement could not be trusted: no baseline, a changed
stream, a browser that did not start, a run that failed. An environment failure is not a regression.

  --profile a,b      ${PERF_PROFILES.join(', ')} or all (default ${DEFAULT_PROFILES.join(',')})
                     Firefox does not start on the macOS host: npm run docker:pw -- --cpus 3 npm run perf:gate -- --profile firefox
  --scenario a,b     catalog ids to run (${SCENARIOS.map((s) => s.id).join(', ')}); default: every scenario of the profile
  --runs N           measured runs per batch (default ${PERF_LIMITS.runs})
  --warmup 0|1       a first run per batch that is recorded and left out of the statistics (default ${PERF_LIMITS.warmupRuns})
  --port N           port of the service the harness starts as a child process (default PB_PORT, else ${DEFAULT_PERF_PORT})
  --baseline-dir D   baselines (default perf/baselines)
  --reports-dir D    reports (default reports/perf)
  --timeout-ms MS    a run that takes longer fails its batch (default 120000)
  --inject-faults J  JSON array of fault rules added to every session: a regression injected ON PURPOSE to check that the gate sees it.
                     Never with --write-baseline.
  --inject-cpu-throttle R   replace the CPU slowdown of a Chromium profile by R (>= 1): "the page does R/4 times the main-thread work".
                     Never with --write-baseline.
  --inject-on all|first     which batches get the injection (default all). first: only the first batch of each scenario, so that the
                     fresh batch of the gate is clean: a one-off disturbance that must not reproduce.
  --allow-missing-baseline   (gate) report the numbers and judge nothing when this environment has no baseline
  --paired           (gate) judge against a CONTROL measured on THIS machine minutes before, not against the committed baselines: on a
                     shared runner the machine is part of the measurement. The control is measured by its own harness, then the head is
                     gated against it with the same rules, thresholds and confirm-on-regression. A control that cannot be measured is exit 2.
  --control-ref R    (paired) the control build: a git ref or commit (default ${DEFAULT_CONTROL_REF}). The head's own commit makes it an A/A by construction.
  --control-dir D    (paired) an existing checkout of the control, used instead of a detached worktree created (and removed) for the run
  --write-baseline   (perf) record the baseline of every profile that was measured; refused with --scenario or --inject-faults
  --help
`;

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new PerfUsageError(`${flag} must be a positive integer, got "${value}"`);
  return Number(value);
}

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

function parseThrottle(text: string): number {
  const rate = Number(text);
  if (text.trim() === '' || !Number.isFinite(rate) || rate < 1)
    throw new PerfUsageError(`--inject-cpu-throttle must be a number >= 1, got "${text}"`);
  return rate;
}

const FAULT_TYPES = ['throttle', 'latency', 'status', 'stall', 'abort', 'live-stall', 'manifest-stale'];

function parseFaults(text: string): FaultRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PerfUsageError(`--inject-faults is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new PerfUsageError('--inject-faults must be a non-empty JSON array of fault rules');
  for (const [index, rule] of parsed.entries()) {
    const type = (rule as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !FAULT_TYPES.includes(type))
      throw new PerfUsageError(`--inject-faults[${index}]: "type" must be one of ${FAULT_TYPES.join(', ')}`);
  }
  return parsed as FaultRule[];
}

/**
 * What a batch is given on purpose (the sensitivity check): the fault rules and the replaced CPU throttle, in every batch or, with
 * `--inject-on first`, only in the first batch of a scenario, so that the fresh batch that confirms a failure is clean (a one-off
 * disturbance that must not reproduce). Nothing is injected in a normal run: the result is empty.
 */
export function injectionFor(
  options: Pick<PerfOptions, 'injectFaults' | 'injectCpuThrottle' | 'injectOn'>,
  attempt: 'first' | 'remeasure',
): { extraFaults?: FaultRule[]; cpuThrottleRate?: number } {
  if (options.injectOn === 'first' && attempt !== 'first') return {};
  return {
    ...(options.injectFaults.length > 0 ? { extraFaults: options.injectFaults } : {}),
    ...(options.injectCpuThrottle !== null ? { cpuThrottleRate: options.injectCpuThrottle } : {}),
  };
}

export function parsePerfArgs(
  mode: PerfOptions['mode'],
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PerfOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        profile: { type: 'string' },
        scenario: { type: 'string' },
        runs: { type: 'string' },
        warmup: { type: 'string' },
        port: { type: 'string' },
        'baseline-dir': { type: 'string' },
        'reports-dir': { type: 'string' },
        'timeout-ms': { type: 'string' },
        'inject-faults': { type: 'string' },
        'inject-cpu-throttle': { type: 'string' },
        'inject-on': { type: 'string' },
        'allow-missing-baseline': { type: 'boolean' },
        'write-baseline': { type: 'boolean' },
        paired: { type: 'boolean' },
        'control-ref': { type: 'string' },
        'control-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new PerfUsageError(error instanceof Error ? error.message : String(error));
  }

  let profiles: PerfProfile[] = [...DEFAULT_PROFILES];
  if (values.profile !== undefined) {
    const named = list(values.profile);
    if (named.length === 0) throw new PerfUsageError('--profile is empty');
    profiles = [];
    for (const name of named) {
      if (name === 'all') profiles.push(...PERF_PROFILES);
      else if (isPerfProfile(name)) profiles.push(name);
      else
        throw new PerfUsageError(`unknown profile "${name}" (expected ${PERF_PROFILES.join(', ')} or all)`);
    }
    profiles = [...new Set(profiles)];
  }

  let scenarios: string[] | null = null;
  if (values.scenario !== undefined) {
    scenarios = [...new Set(list(values.scenario))];
    if (scenarios.length === 0) throw new PerfUsageError('--scenario is empty');
    for (const id of scenarios) {
      if (!SCENARIOS.some((scenario) => scenario.id === id))
        throw new PerfUsageError(
          `unknown scenario "${id}" (expected ${SCENARIOS.map((s) => s.id).join(', ')})`,
        );
    }
  }

  const warmup = values.warmup ?? String(PERF_LIMITS.warmupRuns);
  if (warmup !== '0' && warmup !== '1') throw new PerfUsageError(`--warmup must be 0 or 1, got "${warmup}"`);

  const portText = values.port ?? env.PB_PORT ?? String(DEFAULT_PERF_PORT);
  if (!/^[1-9][0-9]*$/.test(portText) || Number(portText) > 65_535)
    throw new PerfUsageError(`the port must be an integer from 1 to 65535, got "${portText}"`);

  const injectOn = values['inject-on'] ?? 'all';
  if (injectOn !== 'all' && injectOn !== 'first')
    throw new PerfUsageError(`--inject-on must be all or first, got "${injectOn}"`);

  const options: PerfOptions = {
    mode,
    profiles,
    scenarios,
    runs: values.runs === undefined ? PERF_LIMITS.runs : positiveInteger(values.runs, '--runs'),
    warmupRuns: warmup === '1' ? 1 : 0,
    port: Number(portText),
    baselineDir: values['baseline-dir'] ?? null,
    reportsDir: values['reports-dir'] ?? null,
    runTimeoutMs:
      values['timeout-ms'] === undefined ? 120_000 : positiveInteger(values['timeout-ms'], '--timeout-ms'),
    injectFaults: values['inject-faults'] === undefined ? [] : parseFaults(values['inject-faults']),
    injectCpuThrottle:
      values['inject-cpu-throttle'] === undefined ? null : parseThrottle(values['inject-cpu-throttle']),
    injectOn: injectOn === 'first' ? 'first' : 'all',
    allowMissingBaseline: values['allow-missing-baseline'] ?? false,
    paired: values.paired ?? false,
    controlRef: values['control-ref'] ?? null,
    controlDir: values['control-dir'] ?? null,
    writeBaseline: values['write-baseline'] ?? false,
    help: values.help ?? false,
  };

  if (mode === 'run' && options.paired)
    throw new PerfUsageError('--paired belongs to the gate: a measurement has no control to pair with');
  if (!options.paired && (options.controlRef !== null || options.controlDir !== null))
    throw new PerfUsageError('--control-ref and --control-dir belong to --paired');
  if (options.paired) {
    if (options.controlRef !== null) {
      const problem = refProblem(options.controlRef);
      if (problem !== null) throw new PerfUsageError(`--control-ref ${problem}`);
    }
    if (options.controlDir !== null && options.controlDir.trim() === '')
      throw new PerfUsageError('--control-dir is empty');
    if (options.baselineDir !== null)
      throw new PerfUsageError(
        '--paired measures its own baseline: --baseline-dir (the committed baselines) is not used',
      );
    if (options.allowMissingBaseline)
      throw new PerfUsageError(
        '--allow-missing-baseline does not apply to --paired: the gate always has a control to judge against',
      );
    if (options.scenarios !== null)
      throw new PerfUsageError(
        '--paired records the whole profile of the control, and judges the whole profile: it cannot be combined with --scenario',
      );
  }
  if (mode === 'run' && options.allowMissingBaseline)
    throw new PerfUsageError(
      '--allow-missing-baseline belongs to the gate: a measurement has no baseline to miss',
    );
  if (mode === 'gate' && options.writeBaseline)
    throw new PerfUsageError(
      '--write-baseline belongs to npm run perf:baseline: the gate never writes a baseline',
    );
  if (options.writeBaseline && options.scenarios !== null)
    throw new PerfUsageError(
      '--write-baseline records the whole profile: it cannot be combined with --scenario',
    );
  if (options.writeBaseline && options.injectFaults.length > 0)
    throw new PerfUsageError(
      '--write-baseline cannot be combined with --inject-faults: a baseline is the condition without the fault',
    );
  if (options.writeBaseline && options.injectCpuThrottle !== null)
    throw new PerfUsageError(
      '--write-baseline cannot be combined with --inject-cpu-throttle: a baseline is the condition without the injection',
    );
  if (
    values['inject-on'] !== undefined &&
    options.injectFaults.length === 0 &&
    options.injectCpuThrottle === null
  )
    throw new PerfUsageError(
      '--inject-on says where to inject: it needs --inject-faults or --inject-cpu-throttle',
    );
  if (options.injectCpuThrottle !== null) {
    const cannot = options.profiles.filter((profile) => profile === 'firefox' || profile === 'webkit');
    if (cannot.length > 0)
      throw new PerfUsageError(
        `--inject-cpu-throttle is a Chromium DevTools command: ${cannot.join(' and ')} cannot be given one`,
      );
  }
  return options;
}
