import { createHash } from 'node:crypto';
import type { ShakaConfigPatch } from '../../player/configs.ts';
import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import type { HostInfo } from '../probe/host-info.ts';
import { defaultInjections } from './args.ts';
import type { CheckResult, PlayerEvidence } from './checks.ts';
import type {
  Engine,
  FaultWindow,
  HeapSample,
  SoakEpisode,
  SoakError,
  SoakKind,
  SoakSample,
} from './soak-evaluators.ts';
import { aggregate } from './verdict.ts';
import type { CheckId, Evaluation, Verdict } from './verdict.ts';

// The result files of the readiness checks and of the soak: what is committed under docs/results/readiness and docs/results/soak, and what
// `npm run readiness -- --from-results` reads back. A number in a document without the environment, the date and the commit it was
// measured on is not evidence, so every file carries them; and a file that does not validate is an error, never "no result".

export interface ConfigurationResult {
  /** `A` (the defaults) or the id of a candidate. */
  id: string;
  label: string;
  /** What `qa.configure()` was given on top of A; null for A itself. */
  patch: ShakaConfigPatch | null;
  hypothesis: string | null;
  verdict: Verdict;
  checks: CheckResult[];
}

export interface BrowserInfo {
  name: string;
  version: string;
  userAgent: string | null;
}

export interface StreamRecord {
  id: StreamId;
  protocol: Protocol;
  contentHash: string | null;
}

/** The machine's load average (the last 1, 5 and 15 minutes) and its CPU count at a moment: a measurement is read with how busy the machine was. */
export interface LoadReading {
  at: string;
  load1: number;
  load5: number;
  load15: number;
  cpus: number;
}

/** The load before the run started and after it ended. Optional in the file: the older files have none. */
export interface MachineLoad {
  before: LoadReading;
  after: LoadReading;
}

/**
 * A machine is busy when its 1-minute load average is above its CPU count: more work is runnable than there are processors to run it,
 * so a latency, a stall or a start that is measured then is partly the machine's. A fresh macOS runner of GitHub started its jobs at 60 to
 * 80 on 3 CPUs (docs/READINESS.md); a quiet Linux one at 0.3 to 2.4 on 4.
 */
export const BUSY_LOAD_PER_CPU = 1;
export const loadPerCpu = (reading: LoadReading): number => reading.load1 / Math.max(1, reading.cpus);
export const isBusy = (reading: LoadReading): boolean => loadPerCpu(reading) > BUSY_LOAD_PER_CPU;

export interface ReadinessReport {
  schemaVersion: 1;
  kind: 'readiness';
  envId: string;
  engine: Engine;
  generatedAt: string;
  durationMs: number;
  commit: { hash: string | null; dirty: boolean | null };
  host: HostInfo;
  load?: MachineLoad;
  browser: BrowserInfo;
  stream: StreamRecord;
  options: { checks: CheckId[]; joins: number; stallRuns: number; windowSec: number; refreshes: number };
  /** The policy the evaluations were judged against, as it was: a revision of `criteria.ts` does not rewrite history. */
  limits: Record<string, number>;
  configurations: ConfigurationResult[];
}

export const readinessFileName = (envId: string, engine: Engine, protocol: Protocol = 'dash'): string =>
  `${envId}-${engine}${protocolPart(protocol)}.json`;

// What distinguishes one result file from another is in its name, because two runs that differ in it must be able to be committed side
// by side: the environment, the engine, the protocol of the stream (DASH is the default and is not named), for a soak its length, and for
// a soak of a candidate the candidate. A readiness file holds the configurations of ONE run (A and the candidates named on its command
// line), so the candidates are not in its name; two runs of one environment, engine and protocol replace each other. What a file IS is
// read from its content, never from its name (`loadResults`); the name only says where a writer puts it (ADR-159a, readiness-evidence.md).

const protocolPart = (protocol: Protocol): string => (protocol === 'dash' ? '' : `-${protocol}`);

/** The same JSON text for the same value whatever the order of its keys: what a digest of a patch must be made of. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What names a configuration: `A` for the defaults, the id for a candidate, and for `custom` (any patch of `--config-json`) the id with a
 * short digest of the patch, so that two different patches never share a name.
 */
export function configurationKey(configuration: { id: string; patch: unknown } | null | undefined): string {
  if (!configuration || configuration.id === 'A') return 'A';
  const slug = configuration.id.replace(/[^A-Za-z0-9.]+/g, '-').toLowerCase();
  if (configuration.id !== 'custom') return slug;
  const digest = createHash('sha256')
    .update(canonicalJson(configuration.patch ?? null))
    .digest('hex');
  return `${slug}-${digest.slice(0, 8)}`;
}

/** How a configuration is named in a file name: nothing for A, which keeps the name it always had. */
export const configurationPart = (
  configuration: { id: string; patch: unknown } | null | undefined,
): string => {
  const key = configurationKey(configuration);
  return key === 'A' ? '' : `-${key}`;
};

/** The identity of a result: the parts of a file name that say what the run was, so that two files that claim the same one can be told. */
export const readinessIdentity = (report: ReadinessReport): string =>
  `${report.envId}|${report.engine}|${report.stream?.protocol ?? 'dash'}`;
export const soakIdentity = (report: SoakReport): string =>
  `${report.envId}|${report.engine}|${report.stream?.protocol ?? 'dash'}|${Number(report.options.minutes.toFixed(2))}m${injectionPart(report.options)}|${configurationKey(report.configuration)}`;

/** The name a readiness file gets from what it holds. */
export const readinessFileNameOf = (report: ReadinessReport): string =>
  readinessFileName(report.envId, report.engine, report.stream?.protocol ?? 'dash');

export function limitsSnapshot(
  limits: Readonly<Record<string, number>> = LIVE_LIMITS,
): Record<string, number> {
  return { ...limits };
}

// ---------------------------------------------------------------------------------------------------------------------
// The soak

export interface HarnessSample {
  atMs: number;
  /** Heap of the harness's own process after a forced collection, MB. */
  heapUsedMb: number;
  rssMb: number;
  /** Resident memory of the test data service, MB; null when it could not be read. */
  serviceRssMb: number | null;
}

export interface RequestDigest {
  total: number;
  /** Answers with a status of 400 or more, or responses the origin cut: how many, of which `refused` keeps the first ones. */
  refusedCount: number;
  byKind: Record<string, number>;
  refused: Array<{ kind: string; status: number; atMs: number; rep?: string; number?: number }>;
  /** Segments asked for more than once (rep and number), with how many times. */
  repeated: Array<{ rep: string; number: number; times: number }>;
}

export interface SoakReport {
  schemaVersion: 1;
  kind: 'soak';
  envId: string;
  engine: Engine;
  generatedAt: string;
  durationMs: number;
  commit: { hash: string | null; dirty: boolean | null };
  host: HostInfo;
  load?: MachineLoad;
  browser: BrowserInfo;
  stream: StreamRecord;
  configuration: { id: string; label: string; patch: ShakaConfigPatch | null };
  player: PlayerEvidence | null;
  options: {
    minutes: number;
    warmupSec: number;
    sampleSec: number;
    heapEverySec: number;
    stallAtMinutes: number | null;
    staleAtMinutes: number | null;
  };
  limits: Record<string, number>;
  /** `release`, `ci` or `short`: which policy soak this run is. */
  length: SoakKind;
  verdict: Verdict;
  evaluations: Evaluation[];
  /** Epoch milliseconds of the first frame and of the end of the observation. */
  firstFrameMs: number;
  endMs: number;
  faults: FaultWindow[];
  /** The series, decimated to what is sensible to commit (peaks kept); `sampleCount` is how many were taken. */
  series: {
    sampleCount: number;
    samples: SoakSample[];
    heap: HeapSample[] | null;
    harness: HarnessSample[];
  };
  episodes: SoakEpisode[];
  errors: SoakError[];
  /** Console errors and uncaught page errors, which the hook's `errors` does not see, as the page said them (the first ones). */
  consoleProblems: string[];
  requests: RequestDigest;
  /** What the harness itself did to the machine: its memory at the first and last reading. */
  harness: {
    firstHeapMb: number | null;
    lastHeapMb: number | null;
    firstServiceRssMb: number | null;
    lastServiceRssMb: number | null;
  };
}

/** What a soak injected, as a name says it, when it is not what the policy names for its length (`defaultInjections`): `-nostall`, `-stall3m`, `-stale2m`, `-nostale`, `-warmup15s`. Nothing for the policy's own plan, so that the soaks of the policy keep their names. */
export function injectionPart(options: {
  minutes: number;
  stallAtMinutes?: number | null | undefined;
  staleAtMinutes?: number | null | undefined;
  warmupSec?: number | undefined;
}): string {
  const policy = defaultInjections(options.minutes);
  const at = (minute: number): string => `${Number(minute.toFixed(2))}m`;
  const parts: string[] = [];
  if (options.stallAtMinutes !== undefined && options.stallAtMinutes !== policy.stallAtMinutes)
    parts.push(options.stallAtMinutes === null ? 'nostall' : `stall${at(options.stallAtMinutes)}`);
  if (options.staleAtMinutes !== undefined && options.staleAtMinutes !== policy.staleAtMinutes)
    parts.push(options.staleAtMinutes === null ? 'nostale' : `stale${at(options.staleAtMinutes)}`);
  if (options.warmupSec !== undefined && options.warmupSec !== LIVE_LIMITS.warmupSec)
    parts.push(`warmup${options.warmupSec}s`);
  return parts.length === 0 ? '' : `-${parts.join('-')}`;
}

export const soakFileName = (
  envId: string,
  engine: Engine,
  minutes: number,
  what: {
    configuration?: { id: string; patch: unknown } | null;
    protocol?: Protocol;
    /** What the soak injected and how long it warmed up: named when it is not the policy's (`injectionPart`). */
    plan?: { stallAtMinutes?: number | null; staleAtMinutes?: number | null; warmupSec?: number };
  } = {},
): string =>
  `${envId}-${engine}-${Number(minutes.toFixed(2))}m${injectionPart({ minutes, ...what.plan })}${protocolPart(what.protocol ?? 'dash')}${configurationPart(what.configuration)}.json`;

/** The name a soak file gets from what it holds: A's is the name it always had, a candidate's carries the candidate, a plan that is not the policy's is named. */
export const soakFileNameOf = (report: SoakReport): string =>
  soakFileName(report.envId, report.engine, report.options.minutes, {
    configuration: report.configuration,
    protocol: report.stream?.protocol ?? 'dash',
    plan: report.options,
  });

/**
 * The lines of a soak that were advisory in the files measured up to commit `0d62c1d` and are criteria since ADR-159c: the latency level
 * after the faults. A file that is read back is judged by today's criteria: the numbers in it are never touched, and a line that was
 * evidence when the file was measured counts as what it is now.
 */
export const LATENCY_LEVEL_LINES: ReadonlySet<string> = new Set(['soak.latency-p95', 'soak.latency-max']);

/**
 * The verdict of a stored soak under today's criteria, and the lines that make it differ from the stored one (an advisory latency line that
 * was not a GO when the file was measured and decides now). For a file measured with the criteria of today it is the stored verdict.
 */
export function soakVerdictToday(report: SoakReport): { verdict: Verdict; changedBy: Evaluation[] } {
  const promoted = (evaluation: Evaluation): boolean =>
    LATENCY_LEVEL_LINES.has(evaluation.id) && evaluation.scope === 'advisory';
  const verdict = aggregate(
    report.evaluations.map((evaluation) =>
      promoted(evaluation) ? { ...evaluation, scope: 'criterion' as const } : evaluation,
    ),
  );
  const changedBy =
    verdict === report.verdict
      ? []
      : report.evaluations.filter(
          (evaluation) => promoted(evaluation) && evaluation.verdict !== 'GO' && evaluation.verdict !== 'N/A',
        );
  return { verdict, changedBy };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a file back

export class ResultFileError extends Error {
  override name = 'ResultFileError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const VERDICTS = new Set(['GO', 'NO-GO', 'INCONCLUSIVE', 'N/A']);
const ENGINE_NAMES = new Set(['chromium', 'firefox', 'webkit']);

function parseJson(text: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ResultFileError(`${file}: not JSON (${(error as Error).message})`, { cause: error });
  }
  if (!isRecord(raw)) throw new ResultFileError(`${file}: the document is not an object`);
  return raw;
}

function checkEvaluation(value: unknown, where: string, problems: string[]): void {
  if (!isRecord(value)) return void problems.push(`${where}: not an object`);
  if (typeof value.id !== 'string') problems.push(`${where}: no id`);
  if (typeof value.verdict !== 'string' || !VERDICTS.has(value.verdict))
    problems.push(`${where}: no verdict`);
  if (value.value !== null && typeof value.value !== 'number')
    problems.push(`${where}: value is neither a number nor null`);
  if (typeof value.limit !== 'number') problems.push(`${where}: no limit`);
  if (typeof value.sentence !== 'string') problems.push(`${where}: no sentence`);
}

function checkCommon(raw: Record<string, unknown>, kind: string, problems: string[]): void {
  if (raw.schemaVersion !== 1)
    problems.push(`schemaVersion is ${String(raw.schemaVersion)}, this reader knows 1`);
  if (raw.kind !== kind) problems.push(`kind is ${String(raw.kind)}, expected ${kind}`);
  if (typeof raw.envId !== 'string' || raw.envId === '') problems.push('no envId');
  if (typeof raw.engine !== 'string' || !ENGINE_NAMES.has(raw.engine))
    problems.push('engine is not chromium, firefox or webkit');
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt)))
    problems.push('no generatedAt date');
  if (!isRecord(raw.commit)) problems.push('no commit');
  if (!isRecord(raw.limits)) problems.push('no limits snapshot');
}

export function parseReadinessReport(text: string, file: string): ReadinessReport {
  const raw = parseJson(text, file);
  const problems: string[] = [];
  checkCommon(raw, 'readiness', problems);
  if (!Array.isArray(raw.configurations) || raw.configurations.length === 0) {
    problems.push('no configurations');
  } else {
    raw.configurations.forEach((configuration: unknown, c: number) => {
      const at = `configurations[${c}]`;
      if (!isRecord(configuration)) return void problems.push(`${at}: not an object`);
      if (typeof configuration.id !== 'string') problems.push(`${at}: no id`);
      if (typeof configuration.verdict !== 'string' || !VERDICTS.has(configuration.verdict))
        problems.push(`${at}: no verdict`);
      if (!Array.isArray(configuration.checks)) return void problems.push(`${at}: no checks`);
      configuration.checks.forEach((check: unknown, k: number) => {
        const where = `${at}.checks[${k}]`;
        if (!isRecord(check)) return void problems.push(`${where}: not an object`);
        if (typeof check.id !== 'string' || !/^PB-RDY-00[1-5]$/.test(check.id))
          problems.push(`${where}: no catalog id`);
        if (typeof check.verdict !== 'string' || !VERDICTS.has(check.verdict))
          problems.push(`${where}: no verdict`);
        if (!Array.isArray(check.evaluations)) return void problems.push(`${where}: no evaluations`);
        check.evaluations.forEach((evaluation: unknown, e: number) =>
          checkEvaluation(evaluation, `${where}.evaluations[${e}]`, problems),
        );
      });
    });
  }
  if (problems.length > 0)
    throw new ResultFileError(`${file} is not a readiness result:\n  - ${problems.join('\n  - ')}`);
  return raw as unknown as ReadinessReport;
}

export function parseSoakReport(text: string, file: string): SoakReport {
  const raw = parseJson(text, file);
  const problems: string[] = [];
  checkCommon(raw, 'soak', problems);
  if (typeof raw.verdict !== 'string' || !VERDICTS.has(raw.verdict)) problems.push('no verdict');
  if (typeof raw.length !== 'string' || !['release', 'ci', 'short'].includes(raw.length))
    problems.push('length is not release, ci or short');
  if (!isRecord(raw.options) || typeof raw.options.minutes !== 'number') problems.push('no options.minutes');
  if (!isRecord(raw.configuration) || typeof raw.configuration.id !== 'string')
    problems.push('no configuration.id: what was soaked');
  if (!Array.isArray(raw.evaluations)) problems.push('no evaluations');
  else
    raw.evaluations.forEach((evaluation: unknown, e: number) =>
      checkEvaluation(evaluation, `evaluations[${e}]`, problems),
    );
  if (!isRecord(raw.series) || !Array.isArray(raw.series.samples)) problems.push('no series.samples');
  if (problems.length > 0)
    throw new ResultFileError(`${file} is not a soak result:\n  - ${problems.join('\n  - ')}`);
  return raw as unknown as SoakReport;
}
