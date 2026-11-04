import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERF_PORT,
  DEFAULT_PROFILES,
  PERF_USAGE,
  PerfUsageError,
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
      allowMissingBaseline: false,
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
      '--allow-missing-baseline',
      '--write-baseline',
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
