import { describe, expect, it } from 'vitest';
import { USAGE, UsageError, parseCliArgs } from '../../../src/lab/probe/cli-args.ts';

describe('parseCliArgs', () => {
  it('defaults to probing the three engines, three attempts, a fresh process per attempt, controls and sensitivity on', () => {
    expect(parseCliArgs([])).toEqual({
      mode: 'run',
      browsers: ['chromium', 'firefox', 'webkit'],
      attempts: 3,
      controls: true,
      sensitivity: true,
      freshProcess: true,
      timeoutMs: 20_000,
    });
  });

  it('reads the options of a real run', () => {
    expect(
      parseCliArgs([
        '--browsers',
        'webkit,chromium,webkit',
        '--attempts',
        '5',
        '--out',
        'x.json',
        '--timeout',
        '1000',
        '--no-fresh-process',
      ]),
    ).toMatchObject({
      mode: 'run',
      browsers: ['webkit', 'chromium'],
      attempts: 5,
      out: 'x.json',
      timeoutMs: 1000,
      freshProcess: false,
    });
  });

  it.each([
    [['--browsers', 'chromium,edge'], /unknown browser "edge"/],
    [['--browsers', ''], /unknown browser ""/],
    [['--attempts', '0'], /--attempts must be a positive integer/],
    [['--attempts', '2.5'], /--attempts must be a positive integer/],
    [['--attempts', 'many'], /--attempts must be a positive integer/],
    [['--timeout=-5'], /--timeout must be a positive integer/],
    [['--timeout', '-5'], /ambiguous/],
    [['--cases', 'nope', '--out', 'x.json'], /unknown case "nope"/],
    [['--bogus'], /bogus/],
    [['positional'], /positional/i],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it("refuses a partial run without --out, so it cannot overwrite the environment's full result file", () => {
    expect(() => parseCliArgs(['--cases', 'cmaf-vp9-aac'])).toThrow(/give --out/);
  });

  it('limits a partial run to the named cases and skips the controls and sensitivity runs unless asked', () => {
    const partial = parseCliArgs(['--cases', 'cmaf-vp9-aac,hevc-fmp4-video', '--out', 'x.json']);
    expect(partial.cases).toEqual(['cmaf-vp9-aac', 'hevc-fmp4-video']);
    expect(partial.controls).toBe(false);
    expect(partial.sensitivity).toBe(false);
    const asked = parseCliArgs(['--cases', 'cmaf-vp9-aac', '--out', 'x.json', '--controls', '--sensitivity']);
    expect(asked.controls).toBe(true);
    expect(asked.sensitivity).toBe(true);
  });

  it('can turn controls and sensitivity off for a full run', () => {
    expect(parseCliArgs(['--no-controls', '--no-sensitivity'])).toMatchObject({
      controls: false,
      sensitivity: false,
    });
  });

  it.each([
    ['--render', 'render'],
    ['--check', 'check'],
    ['--media-only', 'media-only'],
    ['--help', 'help'],
  ] as const)('%s selects the %s mode', (flag, mode) => {
    expect(parseCliArgs([flag]).mode).toBe(mode);
  });

  it('does not mix rendering with probing, or two modes with each other', () => {
    expect(() => parseCliArgs(['--render', '--browsers', 'webkit'])).toThrow(/takes no probe options/);
    expect(() => parseCliArgs(['--render', '--check'])).toThrow(/cannot be combined/);
  });

  it('documents every option in the usage text', () => {
    for (const flag of [
      '--browsers',
      '--attempts',
      '--out',
      '--cases',
      '--render',
      '--check',
      '--media-only',
      '--timeout',
    ]) {
      expect(USAGE).toContain(flag);
    }
  });
});
