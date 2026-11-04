import type { ShakaConfigPatch } from '../../player/configs.ts';
import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import type { HostInfo } from '../probe/host-info.ts';
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

export interface ReadinessReport {
  schemaVersion: 1;
  kind: 'readiness';
  envId: string;
  engine: Engine;
  generatedAt: string;
  durationMs: number;
  commit: { hash: string | null; dirty: boolean | null };
  host: HostInfo;
  browser: BrowserInfo;
  stream: StreamRecord;
  options: { checks: CheckId[]; joins: number; stallRuns: number; windowSec: number; refreshes: number };
  /** The policy the evaluations were judged against, as it was: a revision of `criteria.ts` does not rewrite history. */
  limits: Record<string, number>;
  configurations: ConfigurationResult[];
}

export const readinessFileName = (envId: string, engine: Engine): string => `${envId}-${engine}.json`;

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

export const soakFileName = (envId: string, engine: Engine, minutes: number): string =>
  `${envId}-${engine}-${Number(minutes.toFixed(2))}m.json`;

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
