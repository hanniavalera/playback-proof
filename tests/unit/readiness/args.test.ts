import { describe, expect, it } from 'vitest';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import {
  DEFAULT_READINESS_PORT,
  DEFAULT_REFRESHES,
  DEFAULT_STALL_RUNS,
  DEFAULT_WINDOW_SEC,
  READINESS_CHECKS,
  READINESS_USAGE,
  ReadinessUsageError,
  SOAK_USAGE,
  defaultInjections,
  parseReadinessArgs,
  parseSoakArgs,
} from '../../../src/lab/readiness/args.ts';
import { CANDIDATES, candidateById, customCandidate } from '../../../src/lab/readiness/candidates.ts';

// The command lines are the first thing a person runs: a typo must be an error that says what was expected, and the defaults must be the
// ones the policy names (never a number typed twice).

describe('npm run readiness', () => {
  it("defaults to Chromium, DASH, every check, the criterion's own number of joins and the live port range", () => {
    const options = parseReadinessArgs([], {});
    expect(options).toMatchObject({
      engines: ['chromium'],
      candidates: [],
      protocol: 'dash',
      checks: READINESS_CHECKS,
      joins: LIVE_LIMITS.startSamples,
      stallRuns: DEFAULT_STALL_RUNS,
      windowSec: DEFAULT_WINDOW_SEC,
      refreshes: DEFAULT_REFRESHES,
      port: DEFAULT_READINESS_PORT,
      write: true,
      fromResults: false,
      help: false,
    });
    expect(DEFAULT_READINESS_PORT).toBeGreaterThanOrEqual(4740);
    expect(DEFAULT_READINESS_PORT).toBeLessThanOrEqual(4749);
  });

  it('takes engines, candidates and checks as lists, each by its name', () => {
    const options = parseReadinessArgs(
      [
        '--engine',
        'webkit,chromium,webkit',
        '--candidate',
        'live-sync',
        '--checks',
        '3,PB-RDY-001',
        '--protocol',
        'hls',
      ],
      {},
    );
    expect(options.engines).toEqual(['webkit', 'chromium']);
    expect(options.candidates.map((c) => c.id)).toEqual(['live-sync']);
    expect(options.checks).toEqual(['PB-RDY-001', 'PB-RDY-003']);
    expect(options.protocol).toBe('hls');
    expect(parseReadinessArgs(['--engine', 'all'], {}).engines).toEqual(['chromium', 'firefox', 'webkit']);
    expect(parseReadinessArgs(['--checks', 'all'], {}).checks).toEqual(READINESS_CHECKS);
  });

  it('reads PB_PORT, and the flag wins over it', () => {
    expect(parseReadinessArgs([], { PB_PORT: '4745' }).port).toBe(4745);
    expect(parseReadinessArgs(['--port', '4742'], { PB_PORT: '4745' }).port).toBe(4742);
  });

  it('adds a custom configuration from JSON as a candidate called custom', () => {
    const options = parseReadinessArgs(
      ['--config-json', '{"streaming":{"liveSync":{"enabled":true,"targetLatency":1}}}'],
      {},
    );
    expect(options.candidates).toHaveLength(1);
    expect(options.candidates[0]?.id).toBe('custom');
    expect(options.candidates[0]?.patch).toEqual({
      streaming: { liveSync: { enabled: true, targetLatency: 1 } },
    });
  });

  it.each([
    [['--engine', 'edge'], 'unknown engine "edge"'],
    [['--engine', ''], '--engine is empty'],
    [['--candidate', 'faster'], 'unknown candidate "faster"'],
    [['--config-json', '{nope'], '--config-json: the configuration is not valid JSON'],
    [['--config-json', '[1]'], 'must be a non-empty JSON object'],
    [['--config-json', '{}'], 'must be a non-empty JSON object'],
    [['--checks', '5'], 'PB-RDY-005 is `npm run soak`'],
    [['--checks', 'PB-RDY-009'], 'unknown check'],
    [['--protocol', 'smooth'], '--protocol must be dash or hls'],
    [['--joins', '0'], '--joins must be a positive integer'],
    [['--joins', '2.5'], '--joins must be a positive integer'],
    [['--stall-runs=-1'], '--stall-runs must be a positive integer'],
    [['--window-sec', 'sixty'], '--window-sec must be a positive integer'],
    [['--port', '70000'], 'the port must be an integer from 1 to 65535'],
    [['--nope'], 'Unknown option'],
    [['stray'], 'Unexpected argument'],
  ])('refuses %j with a reason', (argv, reason) => {
    expect(() => parseReadinessArgs(argv, {})).toThrow(ReadinessUsageError);
    expect(() => parseReadinessArgs(argv, {})).toThrow(reason);
  });

  it('documents every option in its usage text and names the live range', () => {
    for (const flag of [
      '--engine',
      '--candidate',
      '--config-json',
      '--protocol',
      '--checks',
      '--joins',
      '--stall-runs',
      '--window-sec',
      '--refreshes',
      '--port',
      '--out-dir',
      '--no-write',
      '--from-results',
      '--results-dir',
    ]) {
      expect(READINESS_USAGE).toContain(flag);
    }
    expect(READINESS_USAGE).toContain('docker:pw');
  });
});

describe('npm run soak', () => {
  it('needs --minutes, and takes a number, ci or release', () => {
    expect(() => parseSoakArgs([], {})).toThrow('--minutes is required');
    expect(parseSoakArgs(['--minutes', '1.5'], {}).minutes).toBe(1.5);
    expect(parseSoakArgs(['--minutes', 'ci'], {}).minutes).toBe(LIVE_LIMITS.soakMinutesCi);
    expect(parseSoakArgs(['--minutes', 'release'], {}).minutes).toBe(LIVE_LIMITS.soakMinutesRelease);
    expect(() => parseSoakArgs(['--minutes', '0'], {})).toThrow('--minutes must be a number above 0');
    expect(() => parseSoakArgs(['--minutes', 'soon'], {})).toThrow('--minutes must be a number above 0');
  });

  it('puts the outage in the middle of a CI soak and the two outages a third and two thirds into a release soak', () => {
    expect(parseSoakArgs(['--minutes', 'ci'], {})).toMatchObject({
      stallAtMinutes: 2.5,
      staleAtMinutes: null,
    });
    expect(parseSoakArgs(['--minutes', 'release'], {})).toMatchObject({
      stallAtMinutes: 10,
      staleAtMinutes: 20,
    });
    expect(defaultInjections(10)).toEqual({ stallAtMinutes: 5, staleAtMinutes: null });
  });

  it('lets the outage be placed, or switched off', () => {
    expect(parseSoakArgs(['--minutes', '10', '--stall-at-minutes', '3'], {}).stallAtMinutes).toBe(3);
    expect(parseSoakArgs(['--minutes', '10', '--no-stall'], {})).toMatchObject({
      stallAtMinutes: null,
      staleAtMinutes: null,
    });
    expect(parseSoakArgs(['--minutes', 'release', '--stall-at-minutes', '19'], {}).staleAtMinutes).toBeNull();
    expect(() => parseSoakArgs(['--minutes', '10', '--no-stall', '--stall-at-minutes', '3'], {})).toThrow(
      'contradict',
    );
  });

  it('refuses an outage that would disturb the warm-up or that has no room to recover', () => {
    expect(() => parseSoakArgs(['--minutes', '10', '--stall-at-minutes', '0.5'], {})).toThrow(
      'inside the 60 s warm-up',
    );
    expect(() => parseSoakArgs(['--minutes', '5', '--stall-at-minutes', '4.9'], {})).toThrow(
      'do not fit in a 5 min soak',
    );
    expect(() =>
      parseSoakArgs(['--minutes', '30', '--stall-at-minutes', '10', '--stale-at-minutes', '11'], {}),
    ).toThrow('apart');
    // A harness check shortens the warm-up, and then an outage at 30 s fits in a minute.
    expect(parseSoakArgs(['--minutes', '1', '--warmup-sec', '15'], {})).toMatchObject({
      stallAtMinutes: 0.5,
      warmupSec: 15,
    });
  });

  it('takes one engine and one configuration, because a soak occupies the machine', () => {
    expect(parseSoakArgs(['--minutes', '5', '--engine', 'webkit'], {}).engine).toBe('webkit');
    expect(() => parseSoakArgs(['--minutes', '5', '--engine', 'webkit,chromium'], {})).toThrow(
      'takes one engine',
    );
    expect(() =>
      parseSoakArgs(['--minutes', '5', '--candidate', 'live-sync', '--config-json', '{"a":1}'], {}),
    ).toThrow('one configuration');
    expect(parseSoakArgs(['--minutes', '5', '--candidate', 'live-sync'], {}).candidate?.id).toBe('live-sync');
  });

  it('defaults the warm-up to the policy and the cadences to a few seconds, and answers --help without --minutes', () => {
    const options = parseSoakArgs(['--minutes', 'ci'], {});
    expect(options.warmupSec).toBe(LIVE_LIMITS.warmupSec);
    expect(options.sampleSec).toBe(5);
    expect(options.heapEverySec).toBe(30);
    expect(options.port).toBe(DEFAULT_READINESS_PORT);
    expect(parseSoakArgs(['--help'], {}).help).toBe(true);
    expect(SOAK_USAGE).toContain('--stall-at-minutes');
    expect(SOAK_USAGE).toContain(`${LIVE_LIMITS.soakMinutesRelease} min`);
  });
});

describe('the candidate configurations', () => {
  it('has live sync, as the one knob Shaka 5.3.3 offers for holding the playhead at the edge', () => {
    expect(CANDIDATES.map((c) => c.id)).toContain('live-sync');
    expect(candidateById('live-sync')?.patch).toEqual({ streaming: { liveSync: { enabled: true } } });
    expect(candidateById('live-sync')?.hypothesis).toContain('Rejected if');
    expect(candidateById('nothing')).toBeUndefined();
  });

  it('refuses a configuration that is not a JSON object', () => {
    expect(() => customCandidate('3')).toThrow(TypeError);
    expect(() => customCandidate('nope')).toThrow(SyntaxError);
  });
});
