import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CalibrationResult } from './aa.ts';
import { VERDICTS } from './decision.ts';
import { ResultFileError, parseRawResult } from './results.ts';
import type { RawResult } from './results.ts';
import type { ReportJson } from './report.ts';

// The files of a run, under docs/results/ab/ (committed): the raw results of every session, the report made from them, and the A/A
// calibration of a pool (one file per condition, next to the raw results it is the calibration of).

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

export interface CalibrationEntry {
  condition: string;
  result: CalibrationResult;
}

/** `<stem>.calibration.<condition>`: the calibration of the pool of one condition of the run `<stem>`. */
export const calibrationStem = (stem: string, condition: string): string =>
  `${stem}.calibration.${condition}`;

export function writeCalibration(
  dir: string,
  stem: string,
  entry: CalibrationEntry,
  markdown: string,
): { markdown: string; json: string } {
  const base = join(dir, calibrationStem(stem, entry.condition));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${base}.md`, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return {
    markdown: `${base}.md`,
    json: writeJson(`${base}.json`, { condition: entry.condition, ...entry.result }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NUMBERS = ['poolSessions', 'sessionsPerArm', 'splits', 'alpha', 'falsePositives', 'rate'] as const;
const OUTCOMES = VERDICTS;

/** Reads and checks what a report and the Markdown of a calibration rely on: a damaged calibration is refused with what is wrong. */
export function parseCalibration(text: string, file = 'the calibration file'): CalibrationEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResultFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ResultFileError(`${file} must be a JSON object`);
  const problems: string[] = [];
  if (typeof parsed.condition !== 'string')
    problems.push('condition must say which condition the pool is of');
  for (const key of NUMBERS)
    if (typeof parsed[key] !== 'number' || !Number.isFinite(parsed[key]))
      problems.push(`${key} must be a number`);
  const interval = parsed.interval;
  if (
    !isRecord(interval) ||
    typeof interval.lower !== 'number' ||
    typeof interval.upper !== 'number' ||
    typeof interval.level !== 'number'
  )
    problems.push('interval must have a lower and an upper end and a level');
  const verdicts = parsed.verdicts;
  if (!isRecord(verdicts) || OUTCOMES.some((outcome) => typeof verdicts[outcome] !== 'number'))
    problems.push(`verdicts must count ${OUTCOMES.join(', ')}`);
  if (
    !Array.isArray(parsed.perMetric) ||
    parsed.perMetric.some(
      (metric) => !isRecord(metric) || typeof metric.id !== 'string' || !Array.isArray(metric.rejectionRates),
    )
  )
    problems.push('perMetric must list the rejection rates of every primary metric');
  if (typeof parsed.pass !== 'boolean' || typeof parsed.conservative !== 'boolean')
    problems.push('pass and conservative must be true or false');
  if (typeof parsed.reason !== 'string') problems.push('reason must be a sentence');
  if (problems.length > 0)
    throw new ResultFileError(`${file} is not an A/A calibration: ${problems.join('; ')}`);
  const { condition, ...result } = parsed;
  return { condition: condition as string, result: result as unknown as CalibrationResult };
}

/** The calibrations written next to the raw results of the run `<stem>` (one per condition), in the order of their names. */
export function readCalibrations(dir: string, stem: string): CalibrationEntry[] {
  if (!existsSync(dir)) return [];
  const prefix = `${stem}.calibration.`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .map((name) => parseCalibration(readFileSync(join(dir, name), 'utf8'), join(dir, name)));
}
