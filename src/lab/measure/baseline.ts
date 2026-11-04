import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProfileName } from '../../shared/profiles.ts';
import { PROFILE_NAMES } from '../../shared/profiles.ts';
import { STREAM_IDS } from '../../shared/streams.ts';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import type { HostInfo } from '../probe/host-info.ts';
import { summarize } from './stats.ts';
import type { Summary } from './stats.ts';
import { isPerfProfile } from './types.ts';
import type {
  BatchMeasurement,
  PerfEngine,
  PerfProfile,
  RunRecord,
  RungChange,
  ScenarioSpec,
} from './types.ts';

// The baseline file: what a build is compared with. One file per environment and profile (`perf/baselines/<envId>/<profile>.json`),
// committed, written by `npm run perf:baseline` and read by the gate. The loader validates everything it uses, including that the
// summaries follow from the raw per-run values, so a hand-edited number cannot pass for a measurement, and it refuses a baseline that
// was recorded in another environment (ADR-004: baselines are never compared across environments).

export const BASELINE_SCHEMA_VERSION = 1;

export interface BaselineMetric {
  /** The statistics of the non-null values; null when no run produced the metric. */
  summary: Summary | null;
  /** One value per measured run, in run order, null where a run did not produce it. The same order as `ScenarioBaseline.runs`. */
  values: (number | null)[];
}

export interface ScenarioBaseline {
  title: string;
  stream: StreamId;
  protocol: Protocol;
  faultProfile: ProfileName;
  pinnedHeight: number | null;
  /** The rung every run of the batch started on, or null when none was recorded. A batch whose runs disagree is not a baseline. */
  startRungHeight: number | null;
  /** The load average (1 minute) of the machine before and after the batch. */
  loadAverage: { before: number; after: number };
  /** The warm-up run: recorded, not part of any statistic. */
  warmup: RunRecord | null;
  /** The measured runs, in order, with their rung histories. */
  runs: RunRecord[];
  metrics: Record<string, BaselineMetric>;
}

export interface BaselineBrowser {
  name: PerfEngine;
  version: string;
  userAgent: string | null;
  /** The CPU slowdown of the profile, or null at full speed. */
  cpuThrottleRate: number | null;
}

export interface Baseline {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  kind: 'perf-baseline';
  /** `detectEnvId()` of the machine class it was recorded on. */
  envId: string;
  profile: PerfProfile;
  /** ISO 8601, UTC. */
  generatedAt: string;
  /** Measured runs per scenario (the warm-up not counted). */
  runsPerScenario: number;
  warmupRuns: number;
  host: HostInfo;
  browser: BaselineBrowser;
  /** The ffmpeg that generated the streams, as the service reports it. */
  ffmpeg: string;
  /** The content hash of every stream a scenario played: a different hash means different media, so a different baseline. */
  streams: Partial<Record<StreamId, string>>;
  /** Per catalog id. */
  scenarios: Record<string, ScenarioBaseline>;
}

export type BaselineProblem =
  | 'missing'
  | 'unreadable'
  | 'invalid'
  | 'wrong-version'
  | 'wrong-environment'
  | 'wrong-profile'
  | 'incomplete';

/** A baseline that cannot be used, and why. The gate turns every one of them into "an environment problem", never into a regression. */
export class BaselineError extends Error {
  override name = 'BaselineError';
  readonly problem: BaselineProblem;
  constructor(problem: BaselineProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

/** The command that records the baseline of a profile in an environment, written for where the reader is. */
export function recordCommand(envId: string, profile: PerfProfile): string {
  const inner = `npm run perf:baseline -- --profile ${profile}`;
  return envId.startsWith('docker-') ? `npm run docker:pw -- --cpus 3 ${inner}` : inner;
}

export function baselinePath(dir: string, envId: string, profile: PerfProfile): string {
  return join(dir, envId, `${profile}.json`);
}

// ------------------------------------------------------------------------------------------------------------------- building

export interface BaselineInput {
  envId: string;
  profile: PerfProfile;
  generatedAt: string;
  host: HostInfo;
  browser: BaselineBrowser;
  ffmpeg: string;
  streams: Partial<Record<StreamId, string>>;
  warmupRuns: number;
  /** The scenarios of the profile, with a batch for each. */
  scenarios: ReadonlyArray<{ spec: ScenarioSpec; batch: BatchMeasurement }>;
}

/** The rung the runs started on, and whether they all started on the same one. */
export function startRungOf(runs: readonly RunRecord[]): {
  height: number | null;
  unanimous: boolean;
  heights: (number | null)[];
} {
  const heights = runs.map((run) => run.startRungHeight);
  const distinct = [...new Set(heights)];
  return {
    height: distinct.length === 1 ? (distinct[0] ?? null) : null,
    unanimous: distinct.length <= 1,
    heights,
  };
}

function metricsOf(spec: ScenarioSpec, runs: readonly RunRecord[]): Record<string, BaselineMetric> {
  const metrics: Record<string, BaselineMetric> = {};
  for (const metric of spec.metrics) {
    const values = runs.map((run) => run.values[metric.id] ?? null);
    const present = values.filter((value): value is number => value !== null);
    metrics[metric.id] = { summary: present.length > 0 ? summarize(present) : null, values };
  }
  return metrics;
}

/**
 * The baseline of a profile from its measured batches. Throws a BaselineError (`incomplete`) when the batches cannot be a baseline: a
 * gated metric that a run did not produce, or, where the start rung decides what is measured, runs that did not all start on the same rung.
 */
export function buildBaseline(input: BaselineInput): Baseline {
  const problems: string[] = [];
  const scenarios: Record<string, ScenarioBaseline> = {};
  for (const { spec, batch } of input.scenarios) {
    if (batch.runs.length === 0) problems.push(`${spec.id}: the batch has no measured run`);
    if ((batch.injectedFaults?.length ?? 0) > 0)
      problems.push(
        `${spec.id}: faults were injected on purpose in this batch, so it is not the condition a baseline records`,
      );
    for (const metric of spec.metrics) {
      if (metric.rule === null) continue;
      batch.runs.forEach((run, index) => {
        if ((run.values[metric.id] ?? null) === null)
          problems.push(`${spec.id}: run ${index + 1} did not produce ${metric.id}, which gates`);
      });
    }
    const start = startRungOf(batch.runs);
    if (spec.startRungMatters && !start.unanimous) {
      const seen = [...new Set(start.heights)].map((height) => (height === null ? 'none' : `${height}p`));
      problems.push(
        `${spec.id}: the runs did not start on the same rung (${seen.join(', ')}): a startup distribution that mixes rungs is not one population, so it cannot be a baseline`,
      );
    }
    scenarios[spec.id] = {
      title: spec.title,
      stream: batch.stream,
      protocol: batch.protocol,
      faultProfile: batch.faultProfile,
      pinnedHeight: batch.pinnedHeight,
      startRungHeight: start.height,
      loadAverage: batch.loadAverage,
      warmup: batch.warmup,
      runs: batch.runs,
      metrics: metricsOf(spec, batch.runs),
    };
  }
  if (problems.length > 0)
    throw new BaselineError(
      'incomplete',
      `the measurements cannot be a baseline:\n  - ${problems.join('\n  - ')}`,
    );
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: 'perf-baseline',
    envId: input.envId,
    profile: input.profile,
    generatedAt: input.generatedAt,
    runsPerScenario: Math.max(0, ...input.scenarios.map(({ batch }) => batch.runs.length)),
    warmupRuns: input.warmupRuns,
    host: input.host,
    browser: input.browser,
    ffmpeg: input.ffmpeg,
    streams: input.streams,
    scenarios,
  };
}

export function serializeBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function writeBaseline(dir: string, baseline: Baseline): string {
  const path = baselinePath(dir, baseline.envId, baseline.profile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeBaseline(baseline));
  return path;
}

// ------------------------------------------------------------------------------------------------------------------- reading

type Json = Record<string, unknown>;

class Reader {
  constructor(private readonly source: string) {}

  bad(path: string, message: string): never {
    throw new BaselineError('invalid', `${this.source}: ${path}: ${message}`);
  }

  object(value: unknown, path: string): Json {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      this.bad(path, 'expected an object');
    return value as Json;
  }

  array(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) this.bad(path, 'expected an array');
    return value as unknown[];
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string' || value === '') this.bad(path, 'expected a non-empty string');
    return value as string;
  }

  nullableString(value: unknown, path: string): string | null {
    return value === null ? null : this.string(value, path);
  }

  number(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) this.bad(path, 'expected a finite number');
    return value as number;
  }

  nullableNumber(value: unknown, path: string): number | null {
    return value === null ? null : this.number(value, path);
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
      this.bad(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
    return value as T;
  }
}

function readRun(r: Reader, value: unknown, path: string): RunRecord {
  const run = r.object(value, path);
  const values: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(r.object(run.values, `${path}.values`)))
    values[key] = r.nullableNumber(raw, `${path}.values.${key}`);
  const rungs = r.array(run.rungs, `${path}.rungs`).map((raw, index): RungChange => {
    const at = `${path}.rungs[${index}]`;
    const change = r.object(raw, at);
    return {
      t: r.number(change.t, `${at}.t`),
      from: r.nullableNumber(change.from, `${at}.from`),
      to: r.number(change.to, `${at}.to`),
      height: r.nullableNumber(change.height, `${at}.height`),
      reason: r.oneOf(change.reason, ['start', 'abr', 'manual'], `${at}.reason`),
    };
  });
  const durationMs = r.number(run.durationMs, `${path}.durationMs`);
  if (durationMs < 0) r.bad(`${path}.durationMs`, 'a duration cannot be negative');
  return {
    values,
    startRungHeight: r.nullableNumber(run.startRungHeight, `${path}.startRungHeight`),
    rungs,
    durationMs,
    errors: r.array(run.errors, `${path}.errors`).map((e, i) => r.string(e, `${path}.errors[${i}]`)),
  };
}

function readSummary(r: Reader, value: unknown, path: string): Summary {
  const s = r.object(value, path);
  return {
    n: r.number(s.n, `${path}.n`),
    median: r.number(s.median, `${path}.median`),
    p10: r.number(s.p10, `${path}.p10`),
    p90: r.number(s.p90, `${path}.p90`),
    min: r.number(s.min, `${path}.min`),
    max: r.number(s.max, `${path}.max`),
    mad: r.number(s.mad, `${path}.mad`),
    cv: r.nullableNumber(s.cv, `${path}.cv`),
  };
}

const CLOSE = 1e-9;
const sameNumber = (a: number, b: number): boolean =>
  Math.abs(a - b) <= CLOSE * Math.max(1, Math.abs(a), Math.abs(b));

function readScenario(r: Reader, value: unknown, path: string): ScenarioBaseline {
  const s = r.object(value, path);
  const runs = r.array(s.runs, `${path}.runs`).map((raw, i) => readRun(r, raw, `${path}.runs[${i}]`));
  if (runs.length === 0) r.bad(`${path}.runs`, 'a baseline needs at least one measured run');
  const metrics: Record<string, BaselineMetric> = {};
  for (const [id, raw] of Object.entries(r.object(s.metrics, `${path}.metrics`))) {
    const at = `${path}.metrics.${id}`;
    const m = r.object(raw, at);
    const values = r.array(m.values, `${at}.values`).map((v, i) => r.nullableNumber(v, `${at}.values[${i}]`));
    if (values.length !== runs.length)
      r.bad(
        `${at}.values`,
        `${values.length} values for ${runs.length} runs: the raw values must be one per run`,
      );
    values.forEach((v, i) => {
      if (v !== (runs[i]?.values[id] ?? null))
        r.bad(
          `${at}.values[${i}]`,
          `is ${String(v)} but run ${i + 1} says ${String(runs[i]?.values[id] ?? null)}`,
        );
    });
    const present = values.filter((v): v is number => v !== null);
    const summary = m.summary === null ? null : readSummary(r, m.summary, `${at}.summary`);
    if (summary === null && present.length > 0)
      r.bad(`${at}.summary`, 'is null although runs produced values');
    if (summary !== null) {
      if (present.length === 0) r.bad(`${at}.summary`, 'is not null although no run produced a value');
      // Recomputed, not trusted: the summary must follow from the raw values it sits next to.
      const expected = summarize(present);
      for (const key of ['n', 'median', 'p10', 'p90', 'min', 'max', 'mad'] as const) {
        if (!sameNumber(summary[key], expected[key]))
          r.bad(
            `${at}.summary.${key}`,
            `is ${summary[key]} but the raw values give ${expected[key]}: was the file edited by hand?`,
          );
      }
      if (
        (summary.cv === null) !== (expected.cv === null) ||
        (summary.cv !== null && expected.cv !== null && !sameNumber(summary.cv, expected.cv))
      )
        r.bad(
          `${at}.summary.cv`,
          `is ${String(summary.cv)} but the raw values give ${String(expected.cv)}: was the file edited by hand?`,
        );
    }
    metrics[id] = { summary, values };
  }
  const startRungHeight = r.nullableNumber(s.startRungHeight, `${path}.startRungHeight`);
  const start = startRungOf(runs);
  if (start.unanimous && start.height !== startRungHeight)
    r.bad(
      `${path}.startRungHeight`,
      `is ${String(startRungHeight)} but every run started on ${String(start.height)}`,
    );
  const load = r.object(s.loadAverage, `${path}.loadAverage`);
  return {
    title: r.string(s.title, `${path}.title`),
    stream: r.oneOf(s.stream, STREAM_IDS, `${path}.stream`),
    protocol: r.oneOf(s.protocol, ['dash', 'hls'], `${path}.protocol`),
    faultProfile: r.oneOf(s.faultProfile, PROFILE_NAMES, `${path}.faultProfile`),
    pinnedHeight: r.nullableNumber(s.pinnedHeight, `${path}.pinnedHeight`),
    startRungHeight,
    loadAverage: {
      before: r.number(load.before, `${path}.loadAverage.before`),
      after: r.number(load.after, `${path}.loadAverage.after`),
    },
    warmup: s.warmup === null ? null : readRun(r, s.warmup, `${path}.warmup`),
    runs,
    metrics,
  };
}

function readHost(r: Reader, value: unknown, path: string): HostInfo {
  const host = r.object(value, path);
  const os = r.object(host.os, `${path}.os`);
  const git = r.object(host.git, `${path}.git`);
  return {
    os: {
      platform: r.string(os.platform, `${path}.os.platform`),
      arch: r.string(os.arch, `${path}.os.arch`),
      release: r.string(os.release, `${path}.os.release`),
      name: r.string(os.name, `${path}.os.name`),
    },
    cpus: r.number(host.cpus, `${path}.cpus`),
    memoryGiB: r.number(host.memoryGiB, `${path}.memoryGiB`),
    node: r.string(host.node, `${path}.node`),
    playwright: r.string(host.playwright, `${path}.playwright`),
    git: {
      commit: r.nullableString(git.commit, `${path}.git.commit`),
      dirty:
        git.dirty === null
          ? null
          : typeof git.dirty === 'boolean'
            ? git.dirty
            : r.bad(`${path}.git.dirty`, 'expected a boolean or null'),
    },
  };
}

/** Parses and validates a baseline file. Throws a BaselineError that names the file and the offending path. */
export function parseBaseline(text: string, source: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BaselineError('invalid', `${source}: not valid JSON (${(error as Error).message})`);
  }
  const r = new Reader(source);
  const file = r.object(raw, '$');
  if (file.schemaVersion !== BASELINE_SCHEMA_VERSION)
    throw new BaselineError(
      'wrong-version',
      `${source}: schemaVersion is ${JSON.stringify(file.schemaVersion)}, this harness reads ${BASELINE_SCHEMA_VERSION}: record the baseline again`,
    );
  if (file.kind !== 'perf-baseline')
    r.bad('$.kind', `expected "perf-baseline", got ${JSON.stringify(file.kind)}`);
  const profile = r.string(file.profile, '$.profile');
  if (!isPerfProfile(profile)) r.bad('$.profile', `unknown profile ${JSON.stringify(profile)}`);
  const browser = r.object(file.browser, '$.browser');
  const streams: Partial<Record<StreamId, string>> = {};
  for (const [id, hash] of Object.entries(r.object(file.streams, '$.streams'))) {
    const stream = r.oneOf(id, STREAM_IDS, `$.streams.${id}`);
    const text = r.string(hash, `$.streams.${id}`);
    if (!/^[0-9a-f]{64}$/.test(text)) r.bad(`$.streams.${id}`, 'expected a sha256 content hash');
    streams[stream] = text;
  }
  const scenarios: Record<string, ScenarioBaseline> = {};
  for (const [id, scenario] of Object.entries(r.object(file.scenarios, '$.scenarios')))
    scenarios[id] = readScenario(r, scenario, `$.scenarios.${id}`);
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: 'perf-baseline',
    envId: r.string(file.envId, '$.envId'),
    profile: profile as PerfProfile,
    generatedAt: r.string(file.generatedAt, '$.generatedAt'),
    runsPerScenario: r.number(file.runsPerScenario, '$.runsPerScenario'),
    warmupRuns: r.number(file.warmupRuns, '$.warmupRuns'),
    host: readHost(r, file.host, '$.host'),
    browser: {
      name: r.oneOf(browser.name, ['chromium', 'firefox', 'webkit'], '$.browser.name'),
      version: r.string(browser.version, '$.browser.version'),
      userAgent: r.nullableString(browser.userAgent, '$.browser.userAgent'),
      cpuThrottleRate: r.nullableNumber(browser.cpuThrottleRate, '$.browser.cpuThrottleRate'),
    },
    ffmpeg: r.string(file.ffmpeg, '$.ffmpeg'),
    streams,
    scenarios,
  };
}

/**
 * The baseline of `profile` in `envId`, from `dir` (`perf/baselines`). Refuses, with the exact command that fixes it where one exists:
 * a file that is missing, one that does not validate, one recorded for another environment or profile (a copied file).
 */
export function loadBaseline(options: { dir: string; envId: string; profile: PerfProfile }): Baseline {
  const { dir, envId, profile } = options;
  const path = baselinePath(dir, envId, profile);
  if (!existsSync(path))
    throw new BaselineError(
      'missing',
      `there is no performance baseline for ${profile} in ${envId} (${path}). Record one on a quiet machine with: ${recordCommand(envId, profile)}`,
    );
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new BaselineError('unreadable', `${path} cannot be read: ${(error as Error).message}`);
  }
  const baseline = parseBaseline(text, path);
  if (baseline.envId !== envId)
    throw new BaselineError(
      'wrong-environment',
      `${path} was recorded in ${baseline.envId} and this is ${envId}: baselines are never compared across environments (ADR-004). Record one here with: ${recordCommand(envId, profile)}`,
    );
  if (baseline.profile !== profile)
    throw new BaselineError(
      'wrong-profile',
      `${path} is the baseline of ${baseline.profile}, not of ${profile}: was the file copied?`,
    );
  return baseline;
}
