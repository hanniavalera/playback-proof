import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostInfo } from './host-info.ts';
import { PROBE_STAGES, classifyReliability } from './results.ts';
import type { CaseResult, EngineResult, ProbedEngine } from './results.ts';

// The committed result file of one environment (docs/results/codec-matrix/<envId>.json): written by the tool, read by the
// renderer. The reader validates everything it renders, including that the derived fields (passes, reliability) agree
// with the raw attempts, so a hand-edited cell cannot pass for a measurement.

export const RESULT_SCHEMA_VERSION = 1;

export interface ResultOptions {
  attempts: number;
  freshProcess: boolean;
  timeoutMs: number;
  thresholdSec: number;
  minFrames: number;
}

export interface ResultFile {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  /** `detectEnvId()`: `local-darwin-arm64`, `docker-linux-arm64`, `gha-linux-x64`... */
  envId: string;
  /** ISO 8601, UTC: when the run finished. */
  generatedAt: string;
  /** `docker:pw` when the run was started through tools/docker/pw.sh. */
  invokedVia: 'direct' | 'docker:pw';
  /** The arguments given to the tool, so the document can show the exact command. */
  args: string[];
  /** The container's CPU limit (docker:pw only). */
  dockerCpus?: number;
  host: HostInfo;
  media: {
    /** The ffmpeg that generated the probe media. */
    ffmpeg: string;
    specHash: string;
    files: Record<string, { sha256: string; bytes: number }>;
  };
  options: ResultOptions;
  /** Per Playwright engine name. */
  engines: Record<string, EngineResult>;
}

export class ResultFileError extends Error {
  override name = 'ResultFileError';
}

type Json = Record<string, unknown>;

function bad(source: string, path: string, message: string): never {
  throw new ResultFileError(`${source}: ${path}: ${message}`);
}

function asObject(value: unknown, source: string, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    bad(source, path, 'expected an object');
  return value as Json;
}

function asString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string') bad(source, path, 'expected a string');
  return value;
}

function asBoolean(value: unknown, source: string, path: string): boolean {
  if (typeof value !== 'boolean') bad(source, path, 'expected a boolean');
  return value;
}

function asInteger(value: unknown, source: string, path: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
    bad(source, path, `expected an integer >= ${min}`);
  return value;
}

function checkCase(value: unknown, source: string, path: string, withClaim: boolean): CaseResult {
  const result = asObject(value, source, path);
  const attempts = asInteger(result.attempts, source, `${path}.attempts`, 1);
  const passes = asInteger(result.passes, source, `${path}.passes`);
  if (passes > attempts) bad(source, `${path}.passes`, `${passes} passes out of ${attempts} attempts`);
  const reliability = classifyReliability(passes, attempts);
  if (result.reliability !== reliability) {
    bad(
      source,
      `${path}.reliability`,
      `says ${String(result.reliability)} but ${passes}/${attempts} is ${reliability}`,
    );
  }
  if (!Array.isArray(result.runs) || result.runs.length !== attempts) {
    bad(source, `${path}.runs`, `expected ${attempts} runs, one per attempt`);
  }
  let okRuns = 0;
  result.runs.forEach((run: unknown, index: number) => {
    const where = `${path}.runs[${index}]`;
    const entry = asObject(run, source, where);
    if (asBoolean(entry.ok, source, `${where}.ok`)) okRuns += 1;
    else {
      const stage = asString(entry.stage, source, `${where}.stage`);
      if (!(PROBE_STAGES as readonly string[]).includes(stage))
        bad(source, `${where}.stage`, `unknown stage "${stage}"`);
      asString(entry.error, source, `${where}.error`);
    }
  });
  if (okRuns !== passes)
    bad(source, `${path}.passes`, `says ${passes} but the runs contain ${okRuns} passes`);
  if (withClaim) asBoolean(result.typeSupportedClaim, source, `${path}.typeSupportedClaim`);
  if (passes < attempts) {
    const failure = asObject(result.failure, source, `${path}.failure`);
    asString(failure.error, source, `${path}.failure.error`);
    asInteger(failure.count, source, `${path}.failure.count`, 1);
    if (
      !(PROBE_STAGES as readonly string[]).includes(asString(failure.stage, source, `${path}.failure.stage`))
    ) {
      bad(source, `${path}.failure.stage`, 'unknown stage');
    }
  } else if (result.failure !== undefined) {
    bad(source, `${path}.failure`, 'present although every attempt passed');
  }
  return result as unknown as CaseResult;
}

function checkCases(
  value: unknown,
  source: string,
  path: string,
  withClaim: boolean,
): Record<string, CaseResult> {
  const cases = asObject(value, source, path);
  for (const [id, result] of Object.entries(cases)) checkCase(result, source, `${path}["${id}"]`, withClaim);
  return cases as Record<string, CaseResult>;
}

function checkEngine(value: unknown, source: string, path: string): EngineResult {
  const engine = asObject(value, source, path);
  if ('launchFailed' in engine) {
    asString(engine.launchFailed, source, `${path}.launchFailed`);
    return { launchFailed: engine.launchFailed as string };
  }
  asString(engine.browserVersion, source, `${path}.browserVersion`);
  asString(engine.userAgent, source, `${path}.userAgent`);
  if (
    !['MediaSource', 'ManagedMediaSource', 'none'].includes(
      asString(engine.mediaSource, source, `${path}.mediaSource`),
    )
  ) {
    bad(source, `${path}.mediaSource`, 'unknown value');
  }
  for (const [type, answer] of Object.entries(asObject(engine.nativeHls, source, `${path}.nativeHls`))) {
    asString(answer, source, `${path}.nativeHls["${type}"]`);
  }
  asBoolean(engine.requestVideoFrameCallback, source, `${path}.requestVideoFrameCallback`);
  asBoolean(engine.getVideoPlaybackQuality, source, `${path}.getVideoPlaybackQuality`);
  for (const [type, claim] of Object.entries(
    asObject(engine.isTypeSupported, source, `${path}.isTypeSupported`),
  )) {
    if (claim !== null && typeof claim !== 'boolean')
      bad(source, `${path}.isTypeSupported["${type}"]`, 'expected true, false or null');
  }
  checkCases(engine.cases, source, `${path}.cases`, true);
  checkCases(engine.controls, source, `${path}.controls`, false);
  checkCases(engine.sensitivity ?? {}, source, `${path}.sensitivity`, true);
  return {
    ...(engine as unknown as ProbedEngine),
    sensitivity: (engine.sensitivity ?? {}) as ProbedEngine['sensitivity'],
  };
}

/** Parses and validates one committed result file. Throws a ResultFileError that names the file and the offending path. */
export function parseResultFile(text: string, source: string): ResultFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ResultFileError(
      `${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const file = asObject(raw, source, '$');
  if (file.schemaVersion !== RESULT_SCHEMA_VERSION) {
    bad(source, 'schemaVersion', `expected ${RESULT_SCHEMA_VERSION}, got ${String(file.schemaVersion)}`);
  }
  asString(file.envId, source, 'envId');
  const generatedAt = asString(file.generatedAt, source, 'generatedAt');
  if (Number.isNaN(Date.parse(generatedAt))) bad(source, 'generatedAt', 'not a date');
  if (!['direct', 'docker:pw'].includes(asString(file.invokedVia, source, 'invokedVia')))
    bad(source, 'invokedVia', 'unknown value');
  if (!Array.isArray(file.args) || file.args.some((arg) => typeof arg !== 'string'))
    bad(source, 'args', 'expected a list of strings');
  const host = asObject(file.host, source, 'host');
  const os = asObject(host.os, source, 'host.os');
  for (const key of ['platform', 'arch', 'release', 'name']) asString(os[key], source, `host.os.${key}`);
  asString(host.node, source, 'host.node');
  asString(host.playwright, source, 'host.playwright');
  const media = asObject(file.media, source, 'media');
  asString(media.ffmpeg, source, 'media.ffmpeg');
  asString(media.specHash, source, 'media.specHash');
  const options = asObject(file.options, source, 'options');
  asInteger(options.attempts, source, 'options.attempts', 1);
  asBoolean(options.freshProcess, source, 'options.freshProcess');
  const engines = asObject(file.engines, source, 'engines');
  const checked: Record<string, EngineResult> = {};
  for (const [name, engine] of Object.entries(engines))
    checked[name] = checkEngine(engine, source, `engines.${name}`);
  return { ...(file as unknown as ResultFile), engines: checked };
}

export function serializeResultFile(file: ResultFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Every `*.json` in the directory, validated, in file-name order. A broken file is an error, never skipped. */
export function readResultFiles(dir: string): ResultFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  return names.map((name) => {
    const file = parseResultFile(readFileSync(join(dir, name), 'utf8'), name);
    // One file per environment, named after it: the document links to ${envId}.json as its evidence.
    if (name !== `${file.envId}.json`) {
      throw new ResultFileError(
        `${name}: the file of environment "${file.envId}" must be named ${file.envId}.json`,
      );
    }
    return file;
  });
}
