import { describe, expect, it } from 'vitest';
import { analyzeResult } from '../../../ab/analyze.ts';
import { executeExperiment } from '../../../ab/execute.ts';
import type { ExecuteInput } from '../../../ab/execute.ts';
import { HarnessError } from '../../../src/lab/measure/runner.ts';
import { parseRawResult } from '../../../ab/results.ts';
import { HOST, loadedFrom, smallJson, world } from './fake-world.ts';
import type { Script } from './fake-world.ts';
import type { Json } from './fixtures.ts';

// The whole run of a pre-registration with a fake browser, service and player: conditions in order, one browser each, the raw results file
// that comes out of it, and what happens to the file when a condition is stopped or the harness itself is broken.

const COMMITTED = { clean: true, commit: 'abc1234', date: '2026-11-05T08:00:00Z' };

function twoConditions(): Json {
  const base = smallJson();
  return {
    ...base,
    conditions: [
      ...(base.conditions as Json[]),
      {
        id: 'slow-link',
        profile: null,
        rules: [{ type: 'throttle', kbps: 1500 }],
        rationale: 'A finite link, so that the ladder can be measured on it.',
      },
    ],
  };
}

const inputOf = (raw: Json, over: Partial<ExecuteInput> = {}): ExecuteInput => ({
  loaded: loadedFrom(raw),
  committed: COMMITTED,
  command: 'npm run ab -- --prereg plan.json',
  environment: { envId: 'fixture-env', host: HOST, ffmpeg: '9.0.2', streams: { 'vod-cmaf': 'f00dfeed' } },
  ...over,
});

describe('PB-AB execution of a pre-registration', () => {
  it('runs the conditions of the plan in order, a browser for each, and keeps them all in one raw results file', async () => {
    const fake = world();
    const input = inputOf(twoConditions());
    const raw = await executeExperiment(input, fake.deps);

    expect(raw.conditions.map((condition) => condition.id)).toStrictEqual(['high-latency', 'slow-link']);
    expect(raw.conditions.map((condition) => condition.sessions.length)).toStrictEqual([10, 10]);
    const launches = fake.log.flatMap((line, i) => (line === 'browser launched' ? [i] : []));
    expect(launches).toHaveLength(2);
    expect(fake.log.indexOf('browser closed')).toBeLessThan(launches[1] as number);

    expect(raw.preregistration).toStrictEqual({
      path: 'plan.json',
      sha256: input.loaded.sha256,
      text: input.loaded.text,
      committed: COMMITTED,
    });
    expect(raw.environment).toStrictEqual({
      envId: 'fixture-env',
      host: HOST,
      browser: { name: 'chromium', version: '156.0.8078.4', userAgent: 'Mozilla/5.0 Chrome/156' },
      ffmpeg: '9.0.2',
      streams: { 'vod-cmaf': 'f00dfeed' },
    });
    expect(raw.run.command).toBe('npm run ab -- --prereg plan.json');
    expect(Date.parse(raw.run.finishedAt)).toBeGreaterThan(Date.parse(raw.run.startedAt));
  });

  it('writes a results file that reads back unchanged and that the analysis accepts (the plan in it hashes to the recorded hash)', async () => {
    const fake = world();
    const raw = await executeExperiment(inputOf(twoConditions()), fake.deps);
    const text = JSON.stringify(raw);
    expect(parseRawResult(text, 'raw')).toStrictEqual(JSON.parse(text));
    const analysis = analyzeResult(raw, { exploratory: false });
    expect(analysis.conditions.map((entry) => entry.result.id)).toStrictEqual(['high-latency', 'slow-link']);
    expect(analysis.conditions.every((entry) => entry.analysis.decision === null)).toBe(true);
  });

  it('runs only the condition it is asked for, and refuses one the plan does not have before starting anything', async () => {
    const fake = world();
    const raw = await executeExperiment(inputOf(twoConditions(), { condition: 'slow-link' }), fake.deps);
    expect(raw.conditions.map((condition) => condition.id)).toStrictEqual(['slow-link']);
    expect(fake.log.filter((line) => line === 'browser launched')).toHaveLength(1);

    const untouched = world();
    await expect(
      executeExperiment(inputOf(twoConditions(), { condition: 'nope' }), untouched.deps),
    ).rejects.toThrow(/no condition "nope" \(it has high-latency, slow-link\)/);
    expect(untouched.log).toStrictEqual([]);
  });

  it('keeps a condition that was stopped, with the reason, and still runs the next one', async () => {
    const stopFirst: Script = (_arm, index) => (index < 5 ? { fail: 'timeout' } : {});
    const fake = world(stopFirst);
    const raw = await executeExperiment(inputOf(twoConditions()), fake.deps);
    const [first, second] = raw.conditions;
    expect(first?.aborted).toMatch(/5 sessions failed in a row/);
    expect(first?.sessions).toHaveLength(5);
    expect(first?.sessions.every((session) => session.status === 'failed')).toBe(true);
    expect(second?.aborted).toBeNull();
  });

  it('lets a defect of the harness through instead of passing off partial results, and still closes the browser', async () => {
    const fake = world(() => ({ fail: 'mismatch' }));
    await expect(executeExperiment(inputOf(twoConditions()), fake.deps)).rejects.toThrow(HarnessError);
    expect(fake.log).toContain('browser closed');
    expect(fake.log.filter((line) => line === 'browser launched')).toHaveLength(1);
  });
});
