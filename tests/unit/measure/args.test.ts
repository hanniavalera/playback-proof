import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERF_PORT,
  DEFAULT_PROFILES,
  PERF_USAGE,
  PerfUsageError,
  injectionFor,
  parsePerfArgs,
} from '../../../src/lab/measure/args.ts';
import { PERF_LIMITS } from '../../../src/shared/criteria.ts';

const gate = (...argv: string[]) => parsePerfArgs('gate', argv, {});
const run = (...argv: string[]) => parsePerfArgs('run', argv, {});

describe('PB-PERF command line: defaults', () => {
  it('runs the first performance job of the strategy, with the policy numbers', () => {
    const options = gate();
    expect(options).toMatchObject({
      mode: 'gate',
      profiles: ['chromium', 'chromium-cpu4x'],
      scenarios: null,
      runs: PERF_LIMITS.runs,
      warmupRuns: PERF_LIMITS.warmupRuns,
      port: DEFAULT_PERF_PORT,
      baselineDir: null,
      reportsDir: null,
      runTimeoutMs: 120_000,
      injectFaults: [],
      injectCpuThrottle: null,
      injectOn: 'all',
      writeBaseline: false,
      help: false,
    });
    expect([...DEFAULT_PROFILES]).toStrictEqual(options.profiles);
  });

  it('takes the port of PB_PORT, and a --port over it', () => {
    expect(parsePerfArgs('gate', [], { PB_PORT: '4712' }).port).toBe(4712);
    expect(parsePerfArgs('gate', ['--port', '4715'], { PB_PORT: '4712' }).port).toBe(4715);
    expect(DEFAULT_PERF_PORT).toBeGreaterThanOrEqual(4710);
    expect(DEFAULT_PERF_PORT).toBeLessThanOrEqual(4729);
  });

  it('documents every flag it parses', () => {
    for (const flag of [
      '--profile',
      '--scenario',
      '--runs',
      '--warmup',
      '--port',
      '--baseline-dir',
      '--reports-dir',
      '--timeout-ms',
      '--inject-faults',
      '--inject-cpu-throttle',
      '--inject-on',
      '--allow-missing-baseline',
      '--write-baseline',
      '--paired',
      '--control-ref',
      '--control-dir',
    ]) {
      expect(PERF_USAGE, flag).toContain(flag);
    }
  });
});

describe('PB-PERF command line: choosing what to measure', () => {
  it('reads profiles, scenarios and counts', () => {
    expect(
      gate(
        '--profile',
        'webkit,firefox',
        '--scenario',
        'PB-PERF-001,PB-PERF-003',
        '--runs',
        '5',
        '--warmup',
        '0',
      ),
    ).toMatchObject({
      profiles: ['webkit', 'firefox'],
      scenarios: ['PB-PERF-001', 'PB-PERF-003'],
      runs: 5,
      warmupRuns: 0,
    });
  });

  it('expands all and drops repeats', () => {
    expect(gate('--profile', 'all').profiles).toStrictEqual([
      'chromium',
      'firefox',
      'webkit',
      'chromium-cpu4x',
    ]);
    expect(gate('--profile', 'chromium,chromium').profiles).toStrictEqual(['chromium']);
  });

  it.each([
    [['--profile', 'opera'], /unknown profile "opera"/],
    [['--profile', ','], /--profile is empty/],
    [['--scenario', 'PB-PERF-009'], /unknown scenario "PB-PERF-009"/],
    [['--runs', '0'], /--runs must be a positive integer/],
    [['--runs', '2.5'], /--runs must be a positive integer/],
    [['--warmup', '2'], /--warmup must be 0 or 1/],
    [['--port', '70000'], /the port must be an integer from 1 to 65535/],
    [['--timeout-ms', 'soon'], /--timeout-ms must be a positive integer/],
    [['--nonsense'], /nonsense/],
    [['positional'], /positional/],
  ])('refuses %j', (argv, message) => {
    expect(() => gate(...argv)).toThrow(PerfUsageError);
    expect(() => gate(...argv)).toThrow(message);
  });
});

describe('PB-PERF command line: injecting a regression on purpose', () => {
  const latency = '[{"type":"latency","ms":150,"match":{"kind":"manifest"}}]';

  it('reads a JSON array of fault rules', () => {
    expect(gate('--inject-faults', latency).injectFaults).toStrictEqual([
      { type: 'latency', ms: 150, match: { kind: 'manifest' } },
    ]);
  });

  it.each([
    ['not JSON', '{oops', /not valid JSON/],
    ['an object, not an array', '{"type":"latency"}', /non-empty JSON array/],
    ['an empty array', '[]', /non-empty JSON array/],
    ['a rule of an unknown type', '[{"type":"slowdown"}]', /\[0\]: "type" must be one of throttle, latency/],
    ['a rule without a type', '[{"ms":150}]', /"type" must be one of/],
  ])('refuses %s', (_name, text, message) => {
    expect(() => gate('--inject-faults', text)).toThrow(message);
  });

  it('is never recorded as a baseline', () => {
    expect(() => run('--write-baseline', '--inject-faults', latency)).toThrow(
      /a baseline is the condition without the fault/,
    );
    expect(() => run('--write-baseline', '--inject-cpu-throttle', '8')).toThrow(
      /a baseline is the condition without the injection/,
    );
  });

  it('replaces the CPU slowdown of a Chromium profile by a rate of at least 1', () => {
    expect(gate('--inject-cpu-throttle', '8').injectCpuThrottle).toBe(8);
    expect(gate('--inject-cpu-throttle', '1.5', '--profile', 'chromium-cpu4x').injectCpuThrottle).toBe(1.5);
    expect(gate().injectCpuThrottle).toBeNull();
  });

  it.each([
    ['a rate below 1', ['--inject-cpu-throttle', '0.5'], /number >= 1/],
    ['a rate that is not a number', ['--inject-cpu-throttle', 'heavy'], /number >= 1/],
    ['an empty rate', ['--inject-cpu-throttle', ' '], /number >= 1/],
    [
      'a profile that cannot be throttled',
      ['--inject-cpu-throttle', '4', '--profile', 'chromium,webkit'],
      /Chromium DevTools command: webkit cannot be given one/,
    ],
  ])('refuses %s', (_name, argv, message) => {
    expect(() => gate(...argv)).toThrow(PerfUsageError);
    expect(() => gate(...argv)).toThrow(message);
  });

  it('can scope the injection to the first batch, so that the fresh batch of the gate is clean', () => {
    expect(gate().injectOn).toBe('all');
    expect(gate('--inject-faults', latency, '--inject-on', 'first').injectOn).toBe('first');
    expect(gate('--inject-cpu-throttle', '6', '--inject-on', 'all').injectOn).toBe('all');
    expect(() => gate('--inject-faults', latency, '--inject-on', 'second')).toThrow(
      /--inject-on must be all or first/,
    );
    expect(() => gate('--inject-on', 'first')).toThrow(/needs --inject-faults or --inject-cpu-throttle/);
  });

  it('gives a batch what it was told to inject, in every batch or only in the first one of a scenario', () => {
    const rule = { type: 'latency' as const, ms: 150, match: { kind: 'manifest' as const } };
    const both = (injectOn: string) =>
      gate(
        '--inject-faults',
        JSON.stringify([rule]),
        '--inject-cpu-throttle',
        '6',
        '--inject-on',
        injectOn,
        '--profile',
        'chromium',
      );
    // Every batch: the first and the fresh one.
    for (const attempt of ['first', 'remeasure'] as const)
      expect(injectionFor(both('all'), attempt)).toStrictEqual({ extraFaults: [rule], cpuThrottleRate: 6 });
    // The first batch only: the fresh batch of the gate sees a clean condition, so that a one-off disturbance does not reproduce.
    expect(injectionFor(both('first'), 'first')).toStrictEqual({ extraFaults: [rule], cpuThrottleRate: 6 });
    expect(injectionFor(both('first'), 'remeasure')).toStrictEqual({});
  });

  it('injects only what was asked for: faults without a throttle, a throttle without faults, and nothing in a normal run', () => {
    const rule = { type: 'latency' as const, ms: 150 };
    expect(injectionFor(gate('--inject-faults', JSON.stringify([rule])), 'first')).toStrictEqual({
      extraFaults: [rule],
    });
    expect(injectionFor(gate('--inject-cpu-throttle', '8'), 'first')).toStrictEqual({ cpuThrottleRate: 8 });
    for (const attempt of ['first', 'remeasure'] as const) {
      expect(injectionFor(gate(), attempt)).toStrictEqual({});
    }
  });
});

describe('PB-PERF command line: what belongs to which command', () => {
  it('lets the gate allow a missing baseline, and the measurement write one', () => {
    expect(gate('--allow-missing-baseline').allowMissingBaseline).toBe(true);
    expect(run('--write-baseline').writeBaseline).toBe(true);
    expect(run().mode).toBe('run');
  });

  it('keeps them apart', () => {
    expect(() => run('--allow-missing-baseline')).toThrow(/belongs to the gate/);
    expect(() => gate('--write-baseline')).toThrow(/the gate never writes a baseline/);
  });

  it('records a whole profile or nothing', () => {
    expect(() => run('--write-baseline', '--scenario', 'PB-PERF-001')).toThrow(/records the whole profile/);
  });

  it('reads --help', () => {
    expect(gate('--help').help).toBe(true);
    expect(gate('-h').help).toBe(true);
  });
});

describe('PB-PERF command line: the paired gate', () => {
  it('is off by default, and names no control until it is asked for', () => {
    expect(gate()).toMatchObject({ paired: false, controlRef: null, controlDir: null });
    expect(run()).toMatchObject({ paired: false, controlRef: null, controlDir: null });
  });

  it('reads --paired with a control ref, with a control checkout, or with neither (the default control is chosen where it is used)', () => {
    expect(gate('--paired')).toMatchObject({ paired: true, controlRef: null, controlDir: null });
    expect(gate('--paired', '--control-ref', 'origin/main')).toMatchObject({
      paired: true,
      controlRef: 'origin/main',
      controlDir: null,
    });
    expect(gate('--paired', '--control-ref', 'HEAD^1', '--profile', 'chromium')).toMatchObject({
      controlRef: 'HEAD^1',
      profiles: ['chromium'],
    });
    expect(gate('--paired', '--control-dir', '../control')).toMatchObject({
      controlRef: null,
      controlDir: '../control',
    });
    expect(gate('--paired', '--control-dir', '/work/main', '--control-ref', 'v1.2.3')).toMatchObject({
      controlRef: 'v1.2.3',
      controlDir: '/work/main',
    });
  });

  it('belongs to the gate, and its control options belong to it', () => {
    expect(() => run('--paired')).toThrow(/--paired belongs to the gate/);
    expect(() => gate('--control-ref', 'origin/main')).toThrow(
      /--control-ref and --control-dir belong to --paired/,
    );
    expect(() => gate('--control-dir', '/work/main')).toThrow(/belong to --paired/);
  });

  it('refuses a control ref that is not a ref: empty, an option, or with whitespace', () => {
    expect(() => gate('--paired', '--control-ref', '')).toThrow(/--control-ref is empty/);
    expect(() => gate('--paired', '--control-ref=--upload-pack=x')).toThrow(
      /--control-ref must not start with a dash/,
    );
    expect(() => gate('--paired', '--control-ref', 'origin main')).toThrow(
      /--control-ref must not contain whitespace/,
    );
    expect(() => gate('--paired', '--control-dir', ' ')).toThrow(/--control-dir is empty/);
  });

  it('measures its own baseline and judges the whole profile of it: no committed baseline directory, no allowance for a missing baseline, no scenario subset', () => {
    expect(() => gate('--paired', '--baseline-dir', 'perf/baselines')).toThrow(
      /--paired measures its own baseline: --baseline-dir/,
    );
    expect(() => gate('--paired', '--allow-missing-baseline')).toThrow(
      /--allow-missing-baseline does not apply/,
    );
    expect(() => gate('--paired', '--scenario', 'PB-PERF-001')).toThrow(/cannot be combined with --scenario/);
  });

  it('keeps the injection of a sensitivity check, which goes to the head only', () => {
    expect(
      gate('--paired', '--inject-faults', '[{"type":"latency","ms":150}]', '--inject-on', 'first'),
    ).toMatchObject({ paired: true, injectOn: 'first', injectFaults: [{ type: 'latency', ms: 150 }] });
  });
});
