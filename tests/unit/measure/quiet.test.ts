import { describe, expect, it } from 'vitest';
import {
  CPU_MODEL_DIFFERS_NOTE,
  compareCpuModels,
  cpuModelOf,
  loadAround,
  machineFacts,
  perfHost,
} from '../../../src/lab/measure/machine.ts';
import {
  MachineBusyError,
  QUIET_ENV_NAMES,
  QuietUsageError,
  parseQuietArgs,
  quietEnvironment,
  waitUntilQuiet,
} from '../../../src/lab/measure/quiet.ts';
import { HOST } from './fixtures.ts';

/** A machine whose load average follows `readings`, one per look, with a clock that only the waits advance. */
function machine(readings: number[]) {
  let now = 0;
  let index = 0;
  const looked: number[] = [];
  return {
    looked,
    load: (): number => {
      const value = readings[Math.min(index, readings.length - 1)]!;
      index += 1;
      looked.push(value);
      return value;
    },
    wait: async (ms: number): Promise<void> => {
      now += ms;
    },
    clock: (): number => now,
  };
}

describe('PB-PERF quiet machine: waiting for the load average to fall', () => {
  it('starts at once on a quiet machine, and says it did not wait', async () => {
    const m = machine([1.5]);
    await expect(waitUntilQuiet({ maxLoad: 3, ...m })).resolves.toStrictEqual({
      maxLoad: 3,
      hostLoad: 1.5,
      waitedMs: 0,
    });
  });

  it('waits while the load is above the limit and reports how long it took', async () => {
    const m = machine([9, 6, 3.4, 2.9]);
    const busy: Array<[number, number]> = [];
    const result = await waitUntilQuiet({
      maxLoad: 3,
      pollMs: 5000,
      ...m,
      onBusy: (load, waited) => busy.push([load, waited]),
    });
    expect(result).toStrictEqual({ maxLoad: 3, hostLoad: 2.9, waitedMs: 15_000 });
    expect(busy).toStrictEqual([
      [9, 0],
      [6, 5000],
      [3.4, 10_000],
    ]);
  });

  it('accepts a load exactly at the limit: the limit is the highest load that is still quiet', async () => {
    const m = machine([3]);
    expect((await waitUntilQuiet({ maxLoad: 3, ...m })).waitedMs).toBe(0);
  });

  it('gives up with the last load it saw when the machine never calms down', async () => {
    const m = machine([8]);
    const error = await waitUntilQuiet({ maxLoad: 3, timeoutMs: 20_000, pollMs: 5000, ...m }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MachineBusyError);
    expect((error as MachineBusyError).message).toMatch(
      /load average was 8\.00 after 20 s, and the limit is 3/,
    );
    expect((error as MachineBusyError).load).toBe(8);
    // Looked at 0, 5, 10, 15 and 20 s, and never slept past the deadline.
    expect(m.looked).toHaveLength(5);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the limit %s', async (maxLoad) => {
    await expect(waitUntilQuiet({ maxLoad, ...machine([1]) })).rejects.toThrow(RangeError);
  });
});

describe('PB-PERF quiet machine: handing the wait to the command', () => {
  const RESULT = { maxLoad: 3, hostLoad: 1.234, waitedMs: 12_345.6 };

  it('puts what the wait found in the environment, in the names machineFacts reads', () => {
    const env = quietEnvironment(RESULT, { PATH: '/bin' });
    expect(env).toMatchObject({
      PATH: '/bin',
      PB_QUIET_MAX_LOAD: '3',
      PB_QUIET_HOST_LOAD: '1.23',
      PB_QUIET_WAITED_MS: '12346',
    });
    expect(machineFacts(env, { before: 0.5, after: 0.7 }).quiet).toStrictEqual({
      maxLoad: 3,
      hostLoad: 1.23,
      waitedMs: 12_346,
    });
  });

  it('lists the names for the container, keeping the ones the user already listed, once', () => {
    const env = quietEnvironment(RESULT, { PB_DOCKER_ENV: 'FOO PB_QUIET_MAX_LOAD' });
    expect(env.PB_DOCKER_ENV?.split(' ').sort()).toStrictEqual([...QUIET_ENV_NAMES, 'FOO'].sort());
  });
});

describe('PB-PERF quiet machine: the command line', () => {
  it('takes the limit, the timeout in minutes, and everything after "--" as the command', () => {
    expect(
      parseQuietArgs([
        '--max-load',
        '3',
        '--timeout-min',
        '2.5',
        '--',
        'npm',
        'run',
        'perf',
        '--',
        '--runs',
        '3',
      ]),
    ).toStrictEqual({
      maxLoad: 3,
      timeoutMs: 150_000,
      command: ['npm', 'run', 'perf', '--', '--runs', '3'],
    });
    expect(parseQuietArgs(['--max-load', '2', '--', 'true']).timeoutMs).toBe(15 * 60_000);
  });

  it.each([
    ['no command separator', ['--max-load', '3'], /comes after "--"/],
    ['an empty command', ['--max-load', '3', '--'], /no command after/],
    ['no limit', ['--', 'true'], /--max-load is required/],
    ['a limit that is not a number', ['--max-load', 'quiet', '--', 'true'], /needs a number > 0/],
    ['a limit of zero', ['--max-load', '0', '--', 'true'], /needs a number > 0/],
    ['a flag without a value', ['--max-load', '--', 'true'], /needs a number > 0/],
    ['an unknown option', ['--max-load', '3', '--nice', '1', '--', 'true'], /unknown option "--nice"/],
  ])('refuses %s', (_name, argv, message) => {
    expect(() => parseQuietArgs(argv)).toThrow(QuietUsageError);
    expect(() => parseQuietArgs(argv)).toThrow(message);
  });
});

describe('PB-PERF machine facts: how the profile was measured', () => {
  const LOAD = { before: 0.9, after: 1.4 };

  it('says "direct" and no wait for a plain command on the host', () => {
    expect(machineFacts({}, LOAD)).toStrictEqual({
      invokedVia: 'direct',
      dockerCpus: null,
      quiet: null,
      loadBeforeProfile: 0.9,
      loadAfterProfile: 1.4,
    });
  });

  it('records the CPU limit of the Playwright container', () => {
    expect(machineFacts({ PB_DOCKER_PW: '1', PB_DOCKER_CPUS: '4' }, LOAD)).toMatchObject({
      invokedVia: 'docker:pw',
      dockerCpus: 4,
    });
    // A container without a limit that could be read says so rather than inventing one.
    expect(machineFacts({ PB_DOCKER_PW: '1' }, LOAD).dockerCpus).toBeNull();
    expect(machineFacts({ PB_DOCKER_PW: '1', PB_DOCKER_CPUS: 'many' }, LOAD).dockerCpus).toBeNull();
    // A limit variable outside a container is not a container.
    expect(machineFacts({ PB_DOCKER_CPUS: '4' }, LOAD)).toMatchObject({
      invokedVia: 'direct',
      dockerCpus: null,
    });
  });

  it('does not claim a wait when only part of the record arrived', () => {
    expect(machineFacts({ PB_QUIET_MAX_LOAD: '3', PB_QUIET_HOST_LOAD: '1' }, LOAD).quiet).toBeNull();
    expect(
      machineFacts({ PB_QUIET_MAX_LOAD: '3', PB_QUIET_HOST_LOAD: 'x', PB_QUIET_WAITED_MS: '0' }, LOAD).quiet,
    ).toBeNull();
  });

  it('takes the load before from the first batch and the load after from the last one', () => {
    const batches = [
      { loadAverage: { before: 0.5, after: 0.9 } },
      { loadAverage: { before: 0.9, after: 1.1 } },
      { loadAverage: { before: 1.1, after: 1.6 } },
    ];
    expect(loadAround(batches)).toStrictEqual({ before: 0.5, after: 1.6 });
    expect(loadAround([])).toStrictEqual({ before: 0, after: 0 });
  });
});

describe('PB-PERF machine facts: the CPU model', () => {
  const XEON = 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz';
  const EPYC = 'AMD EPYC 9V74 80-Core Processor';

  it('takes the model of the first CPU, trimmed, with its runs of whitespace collapsed', () => {
    expect(
      cpuModelOf([{ model: `  Intel(R)   Xeon(R) Platinum 8370C CPU @\t2.80GHz \n` }, { model: EPYC }]),
    ).toBe(XEON);
    expect(cpuModelOf([{ model: 'Apple M2 Pro' }, { model: 'Apple M2 Pro' }])).toBe('Apple M2 Pro');
  });

  it('has no model where the OS names none: no CPU, an empty name, or the placeholder libuv reports', () => {
    expect(cpuModelOf([])).toBeUndefined();
    expect(cpuModelOf([{ model: '' }])).toBeUndefined();
    expect(cpuModelOf([{ model: ' \t ' }])).toBeUndefined();
    // What os.cpus() says inside the Playwright container on an Apple-silicon host (Linux arm64 has no model name in /proc/cpuinfo).
    expect(cpuModelOf([{ model: 'unknown' }])).toBeUndefined();
    expect(cpuModelOf([{ model: ' Unknown ' }])).toBeUndefined();
    // Only the placeholder is dropped, not a name that happens to contain the word.
    expect(cpuModelOf([{ model: 'unknown CPU 9' }])).toBe('unknown CPU 9');
  });

  it('adds the model to the host facts when there is one, and leaves them as they are when there is not', () => {
    const named = perfHost(HOST, [{ model: EPYC }]);
    expect(named).toStrictEqual({ ...HOST, cpuModel: EPYC });
    const unnamed = perfHost(HOST, [{ model: 'unknown' }]);
    expect(unnamed).toStrictEqual(HOST);
    expect(unnamed).not.toHaveProperty('cpuModel');
  });

  it('says so, with the same words, when both are known and equal: no note', () => {
    expect(compareCpuModels({ cpuModel: EPYC }, EPYC)).toStrictEqual({
      baseline: EPYC,
      current: EPYC,
      differs: false,
      line: `baseline machine: ${EPYC}; this machine: ${EPYC}`,
      note: null,
    });
  });

  it('adds the note when both are known and differ, and keeps both names', () => {
    const comparison = compareCpuModels({ cpuModel: XEON }, EPYC);
    expect(comparison).toStrictEqual({
      baseline: XEON,
      current: EPYC,
      differs: true,
      line: `baseline machine: ${XEON}; this machine: ${EPYC}`,
      note: 'the CPU model differs from the one the baseline was recorded on: a difference in startup of that size may be the machine',
    });
    expect(comparison.note).toBe(CPU_MODEL_DIFFERS_NOTE);
  });

  it('does not call a difference what it cannot tell: a baseline recorded without the model, or a machine that does not name its CPU', () => {
    expect(compareCpuModels({}, EPYC)).toStrictEqual({
      baseline: null,
      current: EPYC,
      differs: false,
      line: `baseline machine: not recorded; this machine: ${EPYC}`,
      note: null,
    });
    expect(compareCpuModels({ cpuModel: XEON }, undefined)).toStrictEqual({
      baseline: XEON,
      current: null,
      differs: false,
      line: `baseline machine: ${XEON}; this machine: unknown`,
      note: null,
    });
    expect(compareCpuModels({}, undefined).differs).toBe(false);
  });

  it('says there is no baseline when there is none, rather than that the baseline did not record a model', () => {
    expect(compareCpuModels(null, EPYC)).toStrictEqual({
      baseline: null,
      current: EPYC,
      differs: false,
      line: `baseline machine: no baseline; this machine: ${EPYC}`,
      note: null,
    });
  });
});
