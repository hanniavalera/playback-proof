import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { HostInfo } from '../probe/host-info.ts';
import { runReadinessChecks } from './checks.ts';
import type { ReadinessRunOptions } from './checks.ts';
import type { Candidate } from './candidates.ts';
import {
  parseReadinessReport,
  parseSoakReport,
  limitsSnapshot,
  readinessFileName,
  ResultFileError,
} from './report.ts';
import type {
  BrowserInfo,
  ConfigurationResult,
  ReadinessReport,
  SoakReport,
  StreamRecord,
} from './report.ts';
import type { Engine } from './soak-evaluators.ts';
import { worstOf } from './verdict.ts';
import type { Limits } from './verdict.ts';
import type { ReadinessWorld } from './world.ts';

// What `npm run readiness` does with a world: the checks for A, the build as it ships, and for every candidate, then the report of the
// engine. And the other direction: reading the committed result files back for the checklist. Pure of browsers, so it is run in the unit
// tests with the scripted world.

export const SHIPPED = {
  id: 'A',
  label: 'the library defaults (what ships)',
} as const;

/** A is always evaluated first, whatever the candidates: the sheet is about the build, and a candidate is judged against it. */
export async function evaluateConfigurations(
  world: ReadinessWorld,
  candidates: readonly Candidate[],
  options: Omit<ReadinessRunOptions, 'patch'>,
): Promise<ConfigurationResult[]> {
  const plan = [
    {
      id: SHIPPED.id as string,
      label: SHIPPED.label as string,
      patch: null,
      hypothesis: null as string | null,
    },
    ...candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      patch: candidate.patch,
      hypothesis: candidate.hypothesis as string | null,
    })),
  ];
  const results: ConfigurationResult[] = [];
  for (const configuration of plan) {
    options.log?.(`configuration ${configuration.id}: ${configuration.label}`);
    const checks = await runReadinessChecks(world, { ...options, patch: configuration.patch });
    results.push({ ...configuration, verdict: worstOf(checks.map((check) => check.verdict)), checks });
  }
  return results;
}

export interface ReadinessMeta {
  envId: string;
  engine: Engine;
  generatedAt: string;
  durationMs: number;
  commit: { hash: string | null; dirty: boolean | null };
  host: HostInfo;
  browser: BrowserInfo;
  stream: StreamRecord;
  options: ReadinessReport['options'];
  limits?: Limits;
}

export function buildReadinessReport(
  meta: ReadinessMeta,
  configurations: ConfigurationResult[],
): ReadinessReport {
  return {
    schemaVersion: 1,
    kind: 'readiness',
    envId: meta.envId,
    engine: meta.engine,
    generatedAt: meta.generatedAt,
    durationMs: meta.durationMs,
    commit: meta.commit,
    host: meta.host,
    browser: meta.browser,
    stream: meta.stream,
    options: meta.options,
    limits: limitsSnapshot(meta.limits ?? LIVE_LIMITS),
    configurations,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files

/** `docs/results/readiness` and `docs/results/soak` under a results root. */
export const readinessDir = (root: string): string => join(root, 'readiness');
export const soakDir = (root: string): string => join(root, 'soak');

/** Writes a result as indented JSON with a trailing newline, creating the directory; returns the path. */
export function writeResult(dir: string, file: string, report: ReadinessReport | SoakReport): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export const writeReadinessReport = (root: string, report: ReadinessReport): string =>
  writeResult(readinessDir(root), readinessFileName(report.envId, report.engine), report);

export interface LoadedResults {
  readiness: ReadinessReport[];
  soaks: SoakReport[];
}

/**
 * Every committed result under `root`, read strictly: a file that does not validate throws `ResultFileError` with the list of what is
 * wrong with it. A broken record must never read as "no result": the checklist would then say "not run" about something that was.
 */
export function loadResults(root: string): LoadedResults {
  const read = <T>(dir: string, parse: (text: string, file: string) => T): T[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map((name) => parse(readFileSync(join(dir, name), 'utf8'), name))
      : [];
  return {
    readiness: read(readinessDir(root), parseReadinessReport),
    soaks: read(soakDir(root), parseSoakReport),
  };
}

export { ResultFileError };
