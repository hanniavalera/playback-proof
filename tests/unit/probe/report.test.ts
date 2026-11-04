import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ResultFileError,
  parseResultFile,
  readResultFiles,
  serializeResultFile,
} from '../../../src/lab/probe/report.ts';
import { probedEngine, resultFile, verdict } from './fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(ROOT, '.cache', 'unit-report-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The tests break parsed JSON in deliberate ways; typing every path would only hide what is being broken.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

function fixtureJson(mutate?: (raw: Raw) => void): string {
  const raw = JSON.parse(
    serializeResultFile(
      resultFile('fixture-env', { chromium: probedEngine(), firefox: { launchFailed: 'boom' } }),
    ),
  );
  mutate?.(raw);
  return JSON.stringify(raw);
}

describe('parseResultFile', () => {
  it('accepts a well-formed file, including an engine that did not start', () => {
    const parsed = parseResultFile(fixtureJson(), 'fixture-env.json');
    expect(parsed.envId).toBe('fixture-env');
    expect(parsed.engines.firefox).toEqual({ launchFailed: 'boom' });
  });

  it('treats a missing sensitivity section (older files) as empty', () => {
    const parsed = parseResultFile(
      fixtureJson((raw) => delete raw.engines.chromium.sensitivity),
      'fixture-env.json',
    );
    expect((parsed.engines.chromium as { sensitivity: object }).sensitivity).toEqual({});
  });

  it.each<[string, (raw: Raw) => void, RegExp]>([
    ['not JSON', () => undefined, /not valid JSON/],
    ['an unknown schema version', (raw) => (raw.schemaVersion = 2), /schemaVersion: expected 1, got 2/],
    ['a missing environment id', (raw) => delete raw.envId, /envId: expected a string/],
    ['an invalid date', (raw) => (raw.generatedAt = 'yesterday'), /generatedAt: not a date/],
    [
      'passes that disagree with the attempts',
      (raw) => (raw.engines.chromium.cases['cmaf-vp9-aac'].passes = 4),
      /cases\["cmaf-vp9-aac"\]\.reliability: says ok but 4\/5 is intermittent|says 4 but the runs contain 5 passes/,
    ],
    [
      'a reliability that does not follow from the counts',
      (raw) => (raw.engines.chromium.cases['cmaf-vp9-aac'].reliability = 'fail'),
      /reliability: says fail but 5\/5 is ok/,
    ],
    [
      'a number of runs that is not the number of attempts',
      (raw) => raw.engines.chromium.cases['cmaf-vp9-aac'].runs.pop(),
      /runs: expected 5 runs/,
    ],
    [
      'a run that failed at an unknown stage',
      (raw) => {
        const c = raw.engines.chromium.cases['cmaf-vp9-aac'];
        Object.assign(c, {
          passes: 4,
          reliability: 'intermittent',
          failure: { stage: 'play', error: 'x', count: 1 },
        });
        c.runs[0] = { ok: false, stage: 'teleport', error: 'x' };
      },
      /unknown stage "teleport"/,
    ],
    [
      'a failing case without its failure summary',
      (raw) => {
        const c = raw.engines.chromium.cases['cmaf-vp9-aac'];
        Object.assign(c, { passes: 4, reliability: 'intermittent' });
        c.runs[0] = { ok: false, stage: 'play', error: 'x' };
      },
      /failure: expected an object/,
    ],
    [
      'a failure summary on a case that never failed',
      (raw) => (raw.engines.chromium.cases['cmaf-vp9-aac'].failure = { stage: 'play', error: 'x', count: 1 }),
      /failure: present although every attempt passed/,
    ],
    [
      'a claim that is not a boolean',
      (raw) => (raw.engines.chromium.cases['cmaf-vp9-aac'].typeSupportedClaim = 'yes'),
      /typeSupportedClaim: expected a boolean/,
    ],
    [
      'an engine that is neither launch-failed nor complete',
      (raw) => delete raw.engines.chromium.userAgent,
      /engines\.chromium\.userAgent: expected a string/,
    ],
  ])('rejects %s, naming the file and the path', (name, mutate, message) => {
    const text = name === 'not JSON' ? '{ nope' : fixtureJson(mutate);
    expect(() => parseResultFile(text, 'fixture-env.json')).toThrow(ResultFileError);
    expect(() => parseResultFile(text, 'fixture-env.json')).toThrow(/^fixture-env\.json: /);
    expect(() => parseResultFile(text, 'fixture-env.json')).toThrow(message);
  });
});

describe('readResultFiles', () => {
  it('reads every JSON file in file-name order', () => {
    const dir = join(scratch, 'ok');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'b-env.json'),
      serializeResultFile(resultFile('b-env', { chromium: probedEngine() })),
    );
    writeFileSync(
      join(dir, 'a-env.json'),
      serializeResultFile(resultFile('a-env', { chromium: probedEngine() })),
    );
    writeFileSync(join(dir, 'README.txt'), 'not a result');
    expect(readResultFiles(dir).map((file) => file.envId)).toEqual(['a-env', 'b-env']);
  });

  it('refuses a file that is not named after its environment (the document links to <envId>.json)', () => {
    const dir = join(scratch, 'misnamed');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'copy.json'),
      serializeResultFile(resultFile('a-env', { chromium: probedEngine() })),
    );
    expect(() => readResultFiles(dir)).toThrow(/must be named a-env\.json/);
  });

  it('fails on a broken file instead of skipping it (a missing environment would be a silent gap)', () => {
    const dir = join(scratch, 'broken');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'a-env.json'),
      serializeResultFile(
        resultFile('a-env', { chromium: probedEngine({ cases: { 'vp9-fmp4-video': verdict(1, 5, true) } }) }),
      ).replace('"passes": 1', '"passes": 3'),
    );
    expect(() => readResultFiles(dir)).toThrow(ResultFileError);
  });
});
