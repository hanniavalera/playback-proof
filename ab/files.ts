import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRawResult } from './results.ts';
import type { RawResult } from './results.ts';
import type { ReportJson } from './report.ts';

// The files of a run, under docs/results/ab/ (committed): the raw results of every session, and the report made from them.

/** `20261105T090000Z`: a UTC time as a file-name stamp. */
export function stampOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a time: ${iso}`);
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** `<experiment id>.<environment id>.<stamp>`: the part of the names every file of a run shares. */
export function resultStem(experimentId: string, envId: string, startedAt: string): string {
  return `${experimentId}.${envId}.${stampOf(startedAt)}`;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function writeRawResult(dir: string, stem: string, raw: RawResult): string {
  return writeJson(join(dir, `${stem}.raw.json`), raw);
}

export function writeReport(
  dir: string,
  stem: string,
  report: { markdown: string; json: ReportJson },
): { markdown: string; json: string } {
  const markdown = join(dir, `${stem}.report.md`);
  mkdirSync(dirname(markdown), { recursive: true });
  writeFileSync(markdown, report.markdown);
  return { markdown, json: writeJson(join(dir, `${stem}.report.json`), report.json) };
}

/** Reads and validates a raw results file. */
export function readRawResult(path: string): RawResult {
  return parseRawResult(readFileSync(path, 'utf8'), path);
}

/** The stem of a raw results file name (`<stem>.raw.json`), so that a report regenerated from it lands next to it. */
export function stemOfRawFile(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  return name.replace(/\.raw\.json$/, '');
}
