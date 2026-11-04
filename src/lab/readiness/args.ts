import { parseArgs } from 'node:util';
import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { Protocol } from '../../shared/streams.ts';
import { CANDIDATES, candidateById, customCandidate } from './candidates.ts';
import type { Candidate } from './candidates.ts';
import type { Engine } from './soak-evaluators.ts';
import type { CheckId } from './verdict.ts';

// The command lines of `npm run readiness` (live/readiness.ts) and `npm run soak` (live/soak.ts), parsed here so that they are unit-tested
// without a browser. A bad option is a usage error with the reason, never a silent default.

/** The first port of the live range of docs/CONTRACTS.md section 8 that this phase was given (4740 to 4749). */
export const DEFAULT_READINESS_PORT = 4740;

export const ENGINES: readonly Engine[] = ['chromium', 'firefox', 'webkit'];

export class ReadinessUsageError extends Error {
  override name = 'ReadinessUsageError';
}

/** The checks a readiness run can make; PB-RDY-005 is the soak (`npm run soak`). */
export const READINESS_CHECKS: readonly CheckId[] = ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'];

/** What a check takes unless it is told otherwise: every number here is the check's own, the limits come from `LIVE_LIMITS`. */
export const DEFAULT_STALL_RUNS = 3;
export const DEFAULT_WINDOW_SEC = 60;
export const DEFAULT_REFRESHES = 20;

const list = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

function positiveInteger(value: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max)
    throw new ReadinessUsageError(
      `${flag} must be a positive integer${max < 1e9 ? ` up to ${max}` : ''}, got "${value}"`,
    );
  return Number(value);
}

function positiveNumber(value: string, flag: string): number {
  const number = Number(value);
  if (value.trim() === '' || !Number.isFinite(number) || number <= 0)
    throw new ReadinessUsageError(`${flag} must be a number above 0, got "${value}"`);
  return number;
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 65_535)
    throw new ReadinessUsageError(`the port must be an integer from 1 to 65535, got "${value}"`);
  return Number(value);
}

function parseEngines(value: string): Engine[] {
  const named = list(value);
  if (named.length === 0) throw new ReadinessUsageError('--engine is empty');
  const engines: Engine[] = [];
  for (const name of named) {
    if (name === 'all') engines.push(...ENGINES);
    else if ((ENGINES as readonly string[]).includes(name)) engines.push(name as Engine);
    else throw new ReadinessUsageError(`unknown engine "${name}" (expected ${ENGINES.join(', ')} or all)`);
  }
  return [...new Set(engines)];
}

function parseProtocol(value: string): Protocol {
  if (value !== 'dash' && value !== 'hls')
    throw new ReadinessUsageError(`--protocol must be dash or hls, got "${value}"`);
  return value;
}

function parseCandidate(value: string, json: string | undefined): Candidate[] {
  const candidates: Candidate[] = [];
  for (const name of list(value)) {
    const found = candidateById(name);
    if (!found)
      throw new ReadinessUsageError(
        `unknown candidate "${name}" (known: ${CANDIDATES.map((c) => c.id).join(', ')}; --config-json takes any other)`,
      );
    candidates.push(found);
  }
  if (json !== undefined) {
    try {
      candidates.push(customCandidate(json));
    } catch (error) {
      throw new ReadinessUsageError(`--config-json: ${(error as Error).message}`);
    }
  }
  return candidates;
}

function parseChecks(value: string): CheckId[] {
  const checks: CheckId[] = [];
  for (const name of list(value)) {
    if (name === 'all') {
      checks.push(...READINESS_CHECKS);
      continue;
    }
    const id = /^\d+$/.test(name) ? `PB-RDY-${name.padStart(3, '0')}` : name;
    const found = READINESS_CHECKS.find((check) => check === id);
    if (!found)
      throw new ReadinessUsageError(
        `unknown check "${name}" (expected ${READINESS_CHECKS.join(', ')}, their numbers 1 to 4, or all; PB-RDY-005 is \`npm run soak\`)`,
      );
    checks.push(found);
  }
  if (checks.length === 0) throw new ReadinessUsageError('--checks is empty');
  return READINESS_CHECKS.filter((check) => checks.includes(check));
}

// ---------------------------------------------------------------------------------------------------------------------
// npm run readiness

export interface ReadinessOptions {
  engines: Engine[];
  /** Configurations to evaluate besides A, which is always evaluated first. */
  candidates: Candidate[];
  protocol: Protocol;
  checks: CheckId[];
  /** Fresh joins sampled by PB-RDY-001. */
  joins: number;
  /** Repetitions of the injected outage in PB-RDY-003: the worst is judged. */
  stallRuns: number;
  /** Seconds of media time over which PB-RDY-002 reads latency. */
  windowSec: number;
  /** Manifest refreshes that PB-RDY-004 watches. */
  refreshes: number;
  port: number;
  /** Where the result files go; null: docs/results/readiness of the checkout. */
  outDir: string | null;
  write: boolean;
  /** Render the checklist from the committed result files; start no browser and no service. */
  fromResults: boolean;
  resultsDir: string | null;
  help: boolean;
}

export const READINESS_USAGE = `npm run readiness -- [options]      run the live-event readiness checks (PB-RDY-001 to PB-RDY-004), print the go/no-go checklist and
                                     write docs/results/readiness/<env>-<engine>.json

Exit codes: 0 every configuration judged is GO; 1 at least one is NO-GO; 2 the run could not judge (a check is INCONCLUSIVE, a browser
did not start, a usage error). A NO-GO is a result about the build; exit 2 is a result about the run.

  --engine a,b       ${ENGINES.join(', ')} or all (default chromium). Firefox does not start on the macOS host:
                     npm run docker:pw -- --cpus 3 npm run readiness -- --engine firefox
  --candidate a,b    evaluate these configurations besides A, the defaults, which is always evaluated first (${CANDIDATES.map((c) => c.id).join(', ')})
  --config-json J    a Shaka configuration patch to evaluate as a candidate called "custom"
  --protocol dash|hls   the live stream's packaging (default dash)
  --checks a,b       PB-RDY-001 to PB-RDY-004, or 1 to 4, or all (default all)
  --joins N          fresh joins of PB-RDY-001 (default ${LIVE_LIMITS.startSamples}: the criterion's own)
  --stall-runs N     injected outages of PB-RDY-003, the worst is judged (default ${DEFAULT_STALL_RUNS})
  --window-sec N     seconds of media over which PB-RDY-002 reads latency (default ${DEFAULT_WINDOW_SEC})
  --refreshes N      manifest refreshes that PB-RDY-004 watches (default ${DEFAULT_REFRESHES})
  --port N           port of the service the run starts as a child process (default PB_PORT, else ${DEFAULT_READINESS_PORT})
  --out-dir D        where the result files go (default docs/results/readiness)
  --no-write         print only; write no file
  --from-results     print the checklist from the committed result files (readiness and soak) of --results-dir, run nothing
  --results-dir D    the results root of --from-results (default docs/results)
  --help
`;

export function parseReadinessArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ReadinessOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        engine: { type: 'string' },
        candidate: { type: 'string' },
        'config-json': { type: 'string' },
        protocol: { type: 'string' },
        checks: { type: 'string' },
        joins: { type: 'string' },
        'stall-runs': { type: 'string' },
        'window-sec': { type: 'string' },
        refreshes: { type: 'string' },
        port: { type: 'string' },
        'out-dir': { type: 'string' },
        'no-write': { type: 'boolean' },
        'from-results': { type: 'boolean' },
        'results-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new ReadinessUsageError(error instanceof Error ? error.message : String(error));
  }
  return {
    engines: values.engine === undefined ? ['chromium'] : parseEngines(values.engine),
    candidates: parseCandidate(values.candidate ?? '', values['config-json']),
    protocol: values.protocol === undefined ? 'dash' : parseProtocol(values.protocol),
    checks: values.checks === undefined ? [...READINESS_CHECKS] : parseChecks(values.checks),
    joins:
      values.joins === undefined ? LIVE_LIMITS.startSamples : positiveInteger(values.joins, '--joins', 50),
    stallRuns:
      values['stall-runs'] === undefined
        ? DEFAULT_STALL_RUNS
        : positiveInteger(values['stall-runs'], '--stall-runs', 20),
    windowSec:
      values['window-sec'] === undefined
        ? DEFAULT_WINDOW_SEC
        : positiveInteger(values['window-sec'], '--window-sec', 3600),
    refreshes:
      values.refreshes === undefined
        ? DEFAULT_REFRESHES
        : positiveInteger(values.refreshes, '--refreshes', 500),
    port: parsePort(values.port ?? env.PB_PORT ?? String(DEFAULT_READINESS_PORT)),
    outDir: values['out-dir'] ?? null,
    write: !(values['no-write'] ?? false),
    fromResults: values['from-results'] ?? false,
    resultsDir: values['results-dir'] ?? null,
    help: values.help ?? false,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// npm run soak

export interface SoakOptions {
  /** Length of the observation, from the first frame, in minutes. */
  minutes: number;
  engine: Engine;
  protocol: Protocol;
  /** A configuration evaluated instead of A; null: A, the defaults. */
  candidate: Candidate | null;
  /** When the origin stops publishing for `LIVE_LIMITS.injectedStallMs`, in minutes from the first frame; null: no outage. */
  stallAtMinutes: number | null;
  /** When the manifest goes stale (the same length as the outage); null: never. */
  staleAtMinutes: number | null;
  /** Excluded from the drift, ratio and heap baselines, seconds. */
  warmupSec: number;
  /** Cadence of the in-page sampler, seconds. */
  sampleSec: number;
  /** Cadence of the forced-collection heap reading (Chromium) and of the harness's own memory, seconds. */
  heapEverySec: number;
  /** How often the harness takes the page's samples and the server's log, seconds. */
  drainSec: number;
  port: number;
  outDir: string | null;
  write: boolean;
  help: boolean;
}

export const DEFAULT_SAMPLE_SEC = 5;
export const DEFAULT_HEAP_EVERY_SEC = 30;
export const DEFAULT_DRAIN_SEC = 30;

export const SOAK_USAGE = `npm run soak -- --minutes N|ci|release [options]   a long live session, sampled, with an injected outage, judged against the PB-RDY-005 criteria

  --minutes N        how long to watch from the first frame: a number of minutes, ci (${LIVE_LIMITS.soakMinutesCi} min) or release (${LIVE_LIMITS.soakMinutesRelease} min)
  --engine E         ${ENGINES.join(', ')} (default chromium). Firefox: npm run docker:pw -- --cpus 3 npm run soak -- --engine firefox ...
  --protocol dash|hls   (default dash)
  --stall-at-minutes M   stop the origin for ${LIVE_LIMITS.injectedStallMs / 1000} s at minute M, to prove recovery mid-soak (default: the middle; a release soak: one third)
  --no-stall         inject no outage
  --stale-at-minutes M   serve a stale manifest for ${LIVE_LIMITS.injectedStallMs / 1000} s at minute M (default: none; a release soak: two thirds)
  --candidate C      soak this configuration instead of A (${CANDIDATES.map((c) => c.id).join(', ')})
  --config-json J    a Shaka configuration patch to soak, called "custom"
  --warmup-sec S     the warm-up left out of the baselines (default ${LIVE_LIMITS.warmupSec}: LIVE_LIMITS.warmupSec). For a harness check only: a soak with another warm-up says so
  --sample-sec S     cadence of the in-page sampler (default ${DEFAULT_SAMPLE_SEC})
  --heap-every-sec S cadence of the heap reading and of the harness's memory (default ${DEFAULT_HEAP_EVERY_SEC})
  --port N           port of the service the run starts as a child process (default PB_PORT, else ${DEFAULT_READINESS_PORT})
  --out-dir D        where the result file goes (default docs/results/soak)
  --no-write         print only; write no file
  --help

A soak shorter than the CI length is reported and is not a verdict (INCONCLUSIVE). Exit codes: 0 GO; 1 NO-GO; 2 INCONCLUSIVE or could not run.
`;

export function parseSoakMinutes(value: string): number {
  if (value === 'ci') return LIVE_LIMITS.soakMinutesCi;
  if (value === 'release') return LIVE_LIMITS.soakMinutesRelease;
  return positiveNumber(value, '--minutes');
}

/** Where the outages go when the command line does not say: a release soak puts the outage a third in and the stale manifest two thirds in (TEST_STRATEGY.md section 8), a shorter one the outage in the middle. */
export function defaultInjections(minutes: number): {
  stallAtMinutes: number;
  staleAtMinutes: number | null;
} {
  const round = (value: number): number => Math.round(value * 2) / 2;
  return minutes >= LIVE_LIMITS.soakMinutesRelease
    ? { stallAtMinutes: round(minutes / 3), staleAtMinutes: round((2 * minutes) / 3) }
    : { stallAtMinutes: round(minutes / 2), staleAtMinutes: null };
}

export function parseSoakArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SoakOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        minutes: { type: 'string' },
        engine: { type: 'string' },
        protocol: { type: 'string' },
        'stall-at-minutes': { type: 'string' },
        'no-stall': { type: 'boolean' },
        'stale-at-minutes': { type: 'string' },
        candidate: { type: 'string' },
        'config-json': { type: 'string' },
        'warmup-sec': { type: 'string' },
        'sample-sec': { type: 'string' },
        'heap-every-sec': { type: 'string' },
        port: { type: 'string' },
        'out-dir': { type: 'string' },
        'no-write': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new ReadinessUsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) return helpOptions();
  if (values.minutes === undefined)
    throw new ReadinessUsageError('--minutes is required: a number of minutes, ci or release');
  const minutes = parseSoakMinutes(values.minutes);

  const engines = values.engine === undefined ? (['chromium'] as Engine[]) : parseEngines(values.engine);
  if (engines.length !== 1)
    throw new ReadinessUsageError(
      '--engine takes one engine: a soak occupies the machine, run the engines one after another',
    );
  const candidates = parseCandidate(values.candidate ?? '', values['config-json']);
  if (candidates.length > 1)
    throw new ReadinessUsageError(
      'a soak takes one configuration: --candidate and --config-json together name two',
    );

  const defaults = defaultInjections(minutes);
  if (values['no-stall'] && values['stall-at-minutes'] !== undefined)
    throw new ReadinessUsageError('--no-stall and --stall-at-minutes contradict each other');
  const stallAtMinutes = values['no-stall']
    ? null
    : values['stall-at-minutes'] === undefined
      ? defaults.stallAtMinutes
      : positiveNumber(values['stall-at-minutes'], '--stall-at-minutes');
  // The two outages of a release soak are a pair of fixed points: a stall placed by hand leaves the stale manifest to be asked for too.
  const staleAtMinutes =
    values['stale-at-minutes'] !== undefined
      ? positiveNumber(values['stale-at-minutes'], '--stale-at-minutes')
      : values['no-stall'] || values['stall-at-minutes'] !== undefined
        ? null
        : defaults.staleAtMinutes;

  const warmupSec =
    values['warmup-sec'] === undefined
      ? LIVE_LIMITS.warmupSec
      : positiveNumber(values['warmup-sec'], '--warmup-sec');
  const sampleSec =
    values['sample-sec'] === undefined
      ? DEFAULT_SAMPLE_SEC
      : positiveNumber(values['sample-sec'], '--sample-sec');
  const heapEverySec =
    values['heap-every-sec'] === undefined
      ? DEFAULT_HEAP_EVERY_SEC
      : positiveNumber(values['heap-every-sec'], '--heap-every-sec');

  const injected: Array<[string, number | null]> = [
    ['--stall-at-minutes', stallAtMinutes],
    ['--stale-at-minutes', staleAtMinutes],
  ];
  const injectedSec = LIVE_LIMITS.injectedStallMs / 1000;
  const tailSec = injectedSec + LIVE_LIMITS.stallRecoveryMaxMs / 1000;
  for (const [flag, at] of injected) {
    if (at === null) continue;
    if (at * 60 < warmupSec)
      throw new ReadinessUsageError(
        `${flag} ${at}: the fault would start inside the ${warmupSec} s warm-up, whose baselines it would disturb`,
      );
    if (at * 60 + tailSec > minutes * 60)
      throw new ReadinessUsageError(
        `${flag} ${at}: the fault and the ${tailSec} s the player is given to recover do not fit in a ${minutes} min soak`,
      );
  }
  if (stallAtMinutes !== null && staleAtMinutes !== null) {
    const apart = Math.abs(stallAtMinutes - staleAtMinutes) * 60;
    // The two outages must not overlap, and the second must not begin while the player is still getting over the first.
    if (apart < tailSec + LIVE_LIMITS.latencyRestoreMaxMs / 1000)
      throw new ReadinessUsageError(
        `the outage at ${stallAtMinutes} min and the stale manifest at ${staleAtMinutes} min are ${apart} s apart: at least ${tailSec + LIVE_LIMITS.latencyRestoreMaxMs / 1000} s are needed for the player to recover and settle between them`,
      );
  }

  return {
    minutes,
    engine: engines[0] as Engine,
    protocol: values.protocol === undefined ? 'dash' : parseProtocol(values.protocol),
    candidate: candidates[0] ?? null,
    stallAtMinutes,
    staleAtMinutes,
    warmupSec,
    sampleSec,
    heapEverySec,
    drainSec: DEFAULT_DRAIN_SEC,
    port: parsePort(values.port ?? env.PB_PORT ?? String(DEFAULT_READINESS_PORT)),
    outDir: values['out-dir'] ?? null,
    write: !(values['no-write'] ?? false),
    help: false,
  };
}

function helpOptions(): SoakOptions {
  return {
    minutes: LIVE_LIMITS.soakMinutesCi,
    engine: 'chromium',
    protocol: 'dash',
    candidate: null,
    stallAtMinutes: null,
    staleAtMinutes: null,
    warmupSec: LIVE_LIMITS.warmupSec,
    sampleSec: DEFAULT_SAMPLE_SEC,
    heapEverySec: DEFAULT_HEAP_EVERY_SEC,
    drainSec: DEFAULT_DRAIN_SEC,
    port: DEFAULT_READINESS_PORT,
    outDir: null,
    write: false,
    help: true,
  };
}
