import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeResult } from '../../../ab/analyze.ts';
import {
  readRawResult,
  resultStem,
  stampOf,
  stemOfRawFile,
  writeRawResult,
  writeReport,
} from '../../../ab/files.ts';
import { renderReport } from '../../../ab/report.ts';
import { ResultFileError } from '../../../ab/results.ts';
import { startupPrereg } from './fixtures.ts';
import { scratchDirectory } from './scratch.ts';
import { buildRaw, interleaved, startupOnly } from './synthetic.ts';

// The files of a run: names that sort by time and carry the environment, and a raw results file that reads back as it was written.

const text = `${JSON.stringify(startupPrereg(), null, 2)}\n`;
const rules = [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }] as never;

describe('PB-AB files of a run', () => {
  const directory = scratchDirectory('ab-files');

  it('names a file by the experiment, the environment and the UTC time the run started', () => {
    expect(stampOf('2026-11-05T09:00:00.123Z')).toBe('20261105T090000Z');
    expect(stampOf('2026-11-05T03:00:00-06:00')).toBe('20261105T090000Z');
    expect(() => stampOf('yesterday')).toThrow(RangeError);
    expect(resultStem('PB-AB-002', 'local-darwin-arm64', '2026-11-05T09:00:00.000Z')).toBe(
      'PB-AB-002.local-darwin-arm64.20261105T090000Z',
    );
    expect(stemOfRawFile('/x/docs/results/ab/PB-AB-002.env.20261105T090000Z.raw.json')).toBe(
      'PB-AB-002.env.20261105T090000Z',
    );
  });

  it('writes the raw results and reads back exactly what was written', () => {
    const sessions = interleaved(startupOnly([900, 950, 1000, 1050]), startupOnly([850, 900, 930, 980]));
    const raw = buildRaw({ text, conditionId: 'high-latency', rules }, sessions);
    const path = writeRawResult(join(directory, 'nested', 'dir'), 'stem', raw);
    expect(path.endsWith('stem.raw.json')).toBe(true);
    expect(readRawResult(path)).toStrictEqual(raw);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('writes the report as Markdown and JSON next to each other', () => {
    const sessions = interleaved(startupOnly([900, 950, 1000, 1050]), startupOnly([850, 900, 930, 980]));
    const raw = buildRaw({ text, conditionId: 'high-latency', rules }, sessions);
    const report = renderReport(raw, analyzeResult(raw, { exploratory: false }), {
      rawFile: 'stem.raw.json',
    });
    const written = writeReport(directory, 'report-stem', report);
    expect(written.markdown).toBe(join(directory, 'report-stem.report.md'));
    expect(written.json).toBe(join(directory, 'report-stem.report.json'));
    expect(readFileSync(written.markdown, 'utf8')).toBe(report.markdown);
    expect(JSON.parse(readFileSync(written.json, 'utf8'))).toStrictEqual(
      JSON.parse(JSON.stringify(report.json)),
    );
  });

  it('refuses a results file that is not one, naming it', () => {
    const broken = join(directory, 'broken.raw.json');
    writeFileSync(broken, '{ "kind": ');
    expect(() => readRawResult(broken)).toThrow(ResultFileError);
    expect(() => readRawResult(broken)).toThrow(/broken\.raw\.json is not valid JSON/);
    const wrong = join(directory, 'wrong.raw.json');
    writeFileSync(wrong, JSON.stringify({ kind: 'other' }));
    expect(() => readRawResult(wrong)).toThrow(/wrong\.raw\.json/);
  });
});
