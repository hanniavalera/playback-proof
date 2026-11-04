import { describe, expect, it } from 'vitest';
import { AB_USAGE, AbUsageError, DEFAULT_AB_PORT, parseAbArgs } from '../../../ab/args.ts';

// The command line: what it accepts, and that it says why when it does not (a flag given to a mode it does nothing in is an error, not a
// silent no-op: the person who typed --splits on a report believes it did something).

const parse = (...argv: string[]) => parseAbArgs(argv, {});

describe('PB-AB command line', () => {
  it('takes exactly one thing to do, and a file for it', () => {
    expect(parse('--prereg', 'ab/prereg/x.json')).toMatchObject({
      mode: 'run',
      file: 'ab/prereg/x.json',
      port: DEFAULT_AB_PORT,
      allowUncommittedPrereg: false,
      noCalibration: false,
      condition: null,
      outDir: null,
    });
    expect(parse('--report', 'a.raw.json').mode).toBe('report');
    expect(parse('--calibrate', 'a.raw.json').mode).toBe('calibrate');
    expect(parse('--power', 'a.raw.json').mode).toBe('power');
    expect(() => parse()).toThrow(/say what to do/);
    expect(() => parse('--prereg', 'x.json', '--report', 'y.raw.json')).toThrow(
      /--prereg and --report were both given/,
    );
    expect(() => parse('--prereg', '')).toThrow(/needs a file/);
    expect(() => parse('--prereg')).toThrow(AbUsageError);
  });

  it('refuses a stray word and a flag it does not know', () => {
    expect(() => parse('--prereg', 'x.json', 'extra')).toThrow(AbUsageError);
    expect(() => parse('--prereg', 'x.json', '--fast')).toThrow(AbUsageError);
  });

  it('answers --help without a mode', () => {
    expect(parse('--help').help).toBe(true);
    expect(parse('-h').help).toBe(true);
    expect(AB_USAGE).toContain('--prereg');
  });

  it('takes the port from --port, then PB_PORT, then the first port of the A/B range, and refuses a port that is not one', () => {
    expect(parse('--prereg', 'x.json').port).toBe(4720);
    expect(parseAbArgs(['--prereg', 'x.json'], { PB_PORT: '4725' }).port).toBe(4725);
    expect(parseAbArgs(['--prereg', 'x.json', '--port', '4722'], { PB_PORT: '4725' }).port).toBe(4722);
    for (const bad of ['0', '70000', 'abc', '47.5', '-1', ''])
      expect(() => parse('--prereg', 'x.json', `--port=${bad}`)).toThrow(AbUsageError);
    expect(() => parse('--prereg', 'x.json', '--port=70000')).toThrow(
      /port must be an integer from 1 to 65535/,
    );
    expect(() => parseAbArgs(['--prereg', 'x.json'], { PB_PORT: 'abc' })).toThrow(/port must be an integer/);
  });

  it('reads the options of the modes without a browser', () => {
    expect(
      parse(
        '--calibrate',
        'a.raw.json',
        '--condition',
        'high-latency',
        '--only-a',
        '--splits',
        '500',
        '--seed',
        '0',
        '--out-dir',
        'out',
      ),
    ).toMatchObject({
      mode: 'calibrate',
      condition: 'high-latency',
      onlyA: true,
      splits: 500,
      seed: 0,
      outDir: 'out',
    });
    expect(
      parse(
        '--power',
        'a.raw.json',
        '--metric',
        'startupMs, rebufferShare',
        '--sessions-per-arm',
        '60',
        '--simulations',
        '300',
      ),
    ).toMatchObject({
      mode: 'power',
      metrics: ['startupMs', 'rebufferShare'],
      sessionsPerArm: 60,
      simulations: 300,
    });
    expect(parse('--prereg', 'x.json', '--allow-uncommitted-prereg', '--no-calibration')).toMatchObject({
      allowUncommittedPrereg: true,
      noCalibration: true,
    });
  });

  it('refuses numbers that are not what they claim to be', () => {
    for (const bad of ['0', '1.5', 'ten', '-3', ''])
      expect(() => parse('--calibrate', 'a.raw.json', `--splits=${bad}`)).toThrow(AbUsageError);
    expect(() => parse('--calibrate', 'a.raw.json', '--splits=ten')).toThrow(/positive integer/);
    for (const bad of ['-1', '4294967296', '1.5', 'x'])
      expect(() => parse('--calibrate', 'a.raw.json', `--seed=${bad}`)).toThrow(/--seed must be an integer/);
  });

  it('says which mode a flag belongs to when it is given to another', () => {
    expect(() => parse('--report', 'a.raw.json', '--splits', '10')).toThrow(
      /--splits belongs to --prereg and --calibrate, not to --report/,
    );
    expect(() => parse('--prereg', 'x.json', '--only-a')).toThrow(
      /--only-a belongs to --calibrate and --power/,
    );
    expect(() => parse('--power', 'a.raw.json', '--allow-uncommitted-prereg')).toThrow(
      /belongs to --prereg, not to --power/,
    );
    expect(() => parse('--report', 'a.raw.json', '--condition', 'x')).toThrow(/--condition belongs to/);
    expect(() => parse('--calibrate', 'a.raw.json', '--metric', 'startupMs')).toThrow(
      /--metric belongs to --power/,
    );
  });
});
