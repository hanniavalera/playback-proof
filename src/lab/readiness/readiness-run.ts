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
  readinessFileNameOf,
  readinessIdentity,
  ResultFileError,
  soakFileName,
  soakFileNameOf,
  soakIdentity,
} from './report.ts';
import type {
  BrowserInfo,
  ConfigurationResult,
  MachineLoad,
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
  load?: MachineLoad;
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
    ...(meta.load ? { load: meta.load } : {}),
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
  writeResult(readinessDir(root), readinessFileNameOf(report), report);

export interface LoadedResults {
  readiness: ReadinessReport[];
  soaks: SoakReport[];
  /** What the reader did that a person reading the checklist should know: a file named by another convention than its content, two files that hold the same run. */
  notes: string[];
}

interface Found<T> {
  name: string;
  report: T;
}

/**
 * Every committed result under `root`, read strictly: a file that does not validate throws `ResultFileError` with the list of what is
 * wrong with it. A broken record must never read as "no result": the checklist would then say "not run" about something that was.
 *
 * What a file is comes from its content, never from its name. A file whose name is not the one its content gets today is still read
 * as what it holds, and says so in `notes`: the soaks of a candidate that were written before the candidate was part of the name carry
 * A's name and would be overwritten by the next soak of A (ADR-159a). Two files that hold the same run (the same environment, engine,
 * protocol, length and configuration) are not merged: the newer one is used, and the note names both.
 */
export function loadResults(root: string): LoadedResults {
  const notes: string[] = [];
  const read = <T extends { generatedAt: string }>(
    dir: string,
    folder: string,
    parse: (text: string, file: string) => T,
    nameOf: (report: T) => string,
    identityOf: (report: T) => string,
    describe: (report: T) => string,
    oldName?: (report: T) => string,
  ): T[] => {
    const files: Array<Found<T>> = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map((name) => ({ name, report: parse(readFileSync(join(dir, name), 'utf8'), name) }))
      : [];
    for (const { name, report } of files) {
      const expected = nameOf(report);
      if (name === expected) continue;
      notes.push(
        oldName && name === oldName(report)
          ? `${folder}/${name}: holds ${describe(report)} under the name of the build as it ships (how soaks were named before the candidate was in the name): it is read as what it holds, and its name is ${expected}; rename it, or the next soak of A overwrites it`
          : `${folder}/${name}: holds ${describe(report)}, which is not the name that its content gets (${expected}): it is read from its content`,
      );
    }
    const byIdentity = new Map<string, Array<Found<T>>>();
    for (const file of files) {
      const key = identityOf(file.report);
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), file]);
    }
    const kept: T[] = [];
    for (const group of byIdentity.values()) {
      const newest = group.reduce((best, file) =>
        Date.parse(file.report.generatedAt) > Date.parse(best.report.generatedAt) ? file : best,
      );
      if (group.length > 1)
        notes.push(
          `${folder}: ${group.map((file) => file.name).join(' and ')} hold the same run (${describe(newest.report)}): the newer one, ${newest.name} (measured ${newest.report.generatedAt}), is used`,
        );
      kept.push(newest.report);
    }
    // In name order, as the files are listed, whatever order the identities were met in.
    return files.map((file) => file.report).filter((report) => kept.includes(report));
  };
  const readiness = read(
    readinessDir(root),
    'readiness',
    parseReadinessReport,
    readinessFileNameOf,
    readinessIdentity,
    (report) =>
      `a readiness run of ${report.envId} ${report.engine} over ${report.stream?.protocol ?? 'dash'} (${report.configurations.map((c) => c.id).join(', ')})`,
  );
  const soaks = read(
    soakDir(root),
    'soak',
    parseSoakReport,
    soakFileNameOf,
    soakIdentity,
    (report) =>
      `the ${Number(report.options.minutes.toFixed(2))}-minute soak of ${report.configuration.id} on ${report.engine} (${report.envId}, ${report.stream?.protocol ?? 'dash'})`,
    (report) =>
      soakFileName(report.envId, report.engine, report.options.minutes, {
        protocol: report.stream?.protocol ?? 'dash',
      }),
  );
  return { readiness, soaks, notes };
}

export { ResultFileError };
