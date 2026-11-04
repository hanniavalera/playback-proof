import { describe, expect, it } from 'vitest';
import { SMOKE_SESSIONS, SmokeUsageError, parseSmokeArgs } from '../../../src/lab/smoke/args.ts';
import {
  failedChecks,
  judgeBasic,
  noteOf,
  renderTable,
  summarize,
  summarizeMetrics,
} from '../../../src/lab/smoke/judge.ts';
import type { BasicObservation, SessionResult } from '../../../src/lab/smoke/judge.ts';
import { computeMetrics } from '../../../src/player/metrics.ts';
import type { QAEvent, QAInfo, QAMetrics } from '../../../src/shared/qa.ts';

describe('the command line', () => {
  it('plays chromium and webkit on macOS, where Firefox does not start, and all three engines elsewhere', () => {
    expect(parseSmokeArgs([], 'darwin').browsers).toEqual(['chromium', 'webkit']);
    expect(parseSmokeArgs([], 'linux').browsers).toEqual(['chromium', 'firefox', 'webkit']);
  });

  it('has the defaults the brief names: one repeat, muted, all six sessions, configuration A, 3 media seconds', () => {
    expect(parseSmokeArgs([], 'linux')).toMatchObject({
      repeat: 1,
      muted: true,
      sessions: [...SMOKE_SESSIONS],
      config: 'A',
      mediaSeconds: 3,
      timeoutMs: 20_000,
      useCapabilities: true,
      help: false,
    });
  });

  it('reads every option', () => {
    const options = parseSmokeArgs(
      [
        '--browsers=webkit,firefox',
        '--sessions',
        'vod-dash,vod-hls',
        '--repeat',
        '20',
        '--muted',
        '0',
        '--config',
        'B',
        '--media-seconds',
        '2.5',
        '--timeout',
        '8000',
        '--origin',
        'http://127.0.0.1:4640',
        '--out',
        'docs/results/x.json',
        '--no-capabilities',
      ],
      'linux',
    );
    expect(options).toEqual({
      browsers: ['webkit', 'firefox'],
      origin: 'http://127.0.0.1:4640',
      repeat: 20,
      muted: false,
      sessions: ['vod-dash', 'vod-hls'],
      config: 'B',
      mediaSeconds: 2.5,
      timeoutMs: 8000,
      out: 'docs/results/x.json',
      useCapabilities: false,
      help: false,
    });
  });

  it('removes duplicates and ignores spaces around names', () => {
    const options = parseSmokeArgs(
      ['--browsers', 'chromium, chromium', '--sessions', 'vod-dash , vod-dash'],
      'linux',
    );
    expect(options.browsers).toEqual(['chromium']);
    expect(options.sessions).toEqual(['vod-dash']);
  });

  it.each([
    [['--browsers', 'edge'], /unknown browser "edge"/],
    [['--browsers', ''], /--browsers is empty/],
    [['--sessions', 'vod-dash,vod-hlz'], /unknown session "vod-hlz"/],
    [['--repeat', '0'], /--repeat must be a positive integer/],
    [['--repeat', '2.5'], /--repeat must be a positive integer/],
    [['--muted', 'yes'], /--muted must be 0 or 1/],
    [['--config', 'C'], /--config must be A or B/],
    [['--media-seconds', '0'], /--media-seconds must be a number > 0/],
    [['--media-seconds', 'abc'], /--media-seconds must be a number > 0/],
    [['--timeout=-1'], /--timeout must be a positive integer/],
    [['--timeout', '-1'], /ambiguous/],
    [['--nonsense'], /nonsense/],
    [['positional'], /positional/i],
  ])('refuses %j', (argv, message) => {
    expect(() => parseSmokeArgs(argv, 'linux')).toThrow(SmokeUsageError);
    expect(() => parseSmokeArgs(argv, 'linux')).toThrow(message);
  });
});

const INFO: QAInfo = {
  shakaVersion: 'v5.3.3',
  userAgent: 'test',
  config: 'A',
  configOverrides: {},
  configDefaults: {},
  configured: [],
  manifestUri: '/s/x/vod-cmaf/dash/manifest.mpd',
  supported: true,
  loadMode: 'media-source',
  params: { config: 'A', autoplay: true, muted: true, start: null, abr: true, hud: false },
  paramProblems: [],
};

function metricsOf(events: QAEvent[], live = false): QAMetrics {
  return computeMetrics({
    events,
    now: 5000,
    playback: {
      currentTime: 3.2,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 8,
      readyState: 4,
    },
    frames: { decoded: 96, dropped: 0, presented: 95 },
    variant: { id: 2, bandwidth: 764_000, width: 640, height: 360, videoCodec: null, audioCodec: null },
    live: live
      ? { isLive: true, latencyMs: 6100, latencyMaxMs: 6400, presentationDelayMs: 6000 }
      : { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null },
  });
}

const healthyEvents: QAEvent[] = [
  { index: 0, t: 0, name: 'load-requested', mediaTime: 0 },
  { index: 1, t: 300, name: 'firstframe', mediaTime: 0 },
];

const healthy: BasicObservation = {
  kind: 'vod',
  mediaSeconds: 3,
  firstFrameSeen: true,
  startMediaTime: 0.03,
  reachedMediaTime: 3.2,
  info: INFO,
  metrics: metricsOf(healthyEvents),
};

describe('judgeBasic', () => {
  it('passes a session that played through MSE, showed a frame, advanced and had no error', () => {
    const checks = judgeBasic(healthy);
    expect(failedChecks(checks)).toEqual([]);
    expect(checks.map((check) => check.name)).toContain('plays through MSE (loadMode media-source)');
  });

  it.each<[string, Partial<BasicObservation>, string]>([
    ['the media did not advance enough', { reachedMediaTime: 2.9 }, 'media time advanced 3 s'],
    ['the media did not advance at all', { reachedMediaTime: null }, 'media time advanced 3 s'],
    ['no first frame was seen', { firstFrameSeen: false }, 'first frame presented (startupMs known)'],
    [
      'startupMs is null',
      { metrics: metricsOf([healthyEvents[0] as QAEvent]) },
      'first frame presented (startupMs known)',
    ],
    [
      'Shaka played natively instead of through MSE',
      { info: { ...INFO, loadMode: 'src=' } },
      'plays through MSE (loadMode media-source)',
    ],
    [
      'nothing was loaded',
      { info: { ...INFO, loadMode: null } },
      'plays through MSE (loadMode media-source)',
    ],
    ['the browser is unsupported', { info: { ...INFO, supported: false } }, 'browser supported by Shaka'],
    [
      'a page parameter was unusable',
      { info: { ...INFO, paramProblems: ['muted="yes" is not 1/0'] } },
      'page parameters usable',
    ],
    ['there is no snapshot at all', { info: null, metrics: null }, 'no error events'],
  ])('fails when %s', (_name, change, failing) => {
    const failed = failedChecks(judgeBasic({ ...healthy, ...change })).map((check) => check.name);
    expect(failed).toContain(failing);
  });

  it('fails on a single error event, whatever its severity, and says which', () => {
    const events: QAEvent[] = [
      ...healthyEvents,
      {
        index: 2,
        t: 900,
        name: 'error',
        mediaTime: 1,
        detail: {
          code: 1001,
          codeName: 'BAD_HTTP_STATUS',
          severity: 1,
          message: 'bad status',
          source: 'shaka',
        },
      },
    ];
    const failed = failedChecks(judgeBasic({ ...healthy, metrics: metricsOf(events) }));
    expect(failed).toEqual([
      { name: 'no error events', ok: false, detail: 'BAD_HTTP_STATUS (shaka): bad status' },
    ]);
  });

  it('measures progress from the media time of the first frame, which is far from 0 for a live stream', () => {
    const live: BasicObservation = {
      ...healthy,
      kind: 'live',
      startMediaTime: 24.1,
      reachedMediaTime: 24.5,
      metrics: metricsOf(healthyEvents, true),
    };
    expect(failedChecks(judgeBasic(live)).map((check) => check.name)).toEqual(['media time advanced 3 s']);
    expect(failedChecks(judgeBasic({ ...live, reachedMediaTime: 27.2 }))).toEqual([]);
  });

  it('wants a live latency and a presentation delay on a live session', () => {
    const blind = { ...healthy, kind: 'live' as const, metrics: metricsOf(healthyEvents, false) };
    expect(failedChecks(judgeBasic(blind)).map((check) => check.name)).toEqual(['live latency measured']);
  });
});

function result(change: Partial<SessionResult> = {}): SessionResult {
  return {
    repeat: 1,
    engine: 'chromium',
    session: 'vod-dash',
    status: 'pass',
    stream: 'vod-cmaf',
    durationMs: 4200,
    ...summarizeMetrics(metricsOf(healthyEvents)),
    mediaTime: 3.2,
    info: INFO,
    errors: [],
    checks: [],
    consoleErrors: [],
    ...change,
  };
}

describe('the table and the summary', () => {
  it('summarizes a metrics snapshot into the cells of the table, and nulls when there is none', () => {
    expect(summarizeMetrics(metricsOf(healthyEvents))).toEqual({
      startupMs: 300,
      rebuffers: 0,
      decoded: 96,
      dropped: 0,
      presented: 95,
      rungHeight: 360,
      switches: 0,
      latencyMs: null,
    });
    expect(summarizeMetrics(null)).toEqual({
      startupMs: null,
      rebuffers: null,
      decoded: null,
      dropped: null,
      presented: null,
      rungHeight: null,
      switches: null,
      latencyMs: null,
    });
  });

  it('prints one row per run with the verdict, the numbers, and why a run failed or was skipped', () => {
    const table = renderTable([
      result(),
      result({
        engine: 'webkit',
        session: 'vod-hls',
        status: 'fail',
        stage: 'playback',
        error: 'qa.waitForMediaTime(3) timed out after 20000 ms\nmore lines',
        startupMs: null,
        mediaTime: null,
        rungHeight: null,
      }),
      result({
        engine: 'webkit',
        session: 'live-dash',
        status: 'skip',
        stream: null,
        skipReason: 'no live stream plays over dash in webkit',
        startupMs: null,
        mediaTime: null,
      }),
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(
      /^run\s+engine\s+session\s+stream\s+result\s+startup\s+media\s+rebuf\s+dropped\/decoded\s+presented\s+rung\s+latency\s+note$/,
    );
    expect(lines[1]).toMatch(
      /^1\s+chromium\s+vod-dash\s+vod-cmaf\s+PASS\s+300 ms\s+3\.20 s\s+0\s+0\/96\s+95\s+360p\s+-$/,
    );
    expect(lines[2]).toContain('FAIL');
    expect(lines[2]).toContain('[playback] qa.waitForMediaTime(3) timed out after 20000 ms');
    expect(lines[2]).not.toContain('more lines');
    expect(lines[3]).toContain('SKIP');
    expect(lines[3]).toContain('skipped: no live stream plays over dash in webkit');
  });

  it('notes nothing for a pass and cuts a very long failure line', () => {
    expect(noteOf(result())).toBe('');
    expect(noteOf(result({ status: 'fail', stage: 'load', error: 'x'.repeat(300) })).length).toBeLessThan(
      130,
    );
  });

  it('counts passes, failures and skips per engine and session over the repeats; a skip is not a run', () => {
    const rows = summarize([
      result({ repeat: 1 }),
      result({ repeat: 2, status: 'fail', stage: 'playback', error: 'x' }),
      result({ repeat: 3 }),
      result({ engine: 'webkit', status: 'skip', stream: null, skipReason: 'gap' }),
    ]);
    expect(rows).toEqual([
      { engine: 'chromium', session: 'vod-dash', runs: 3, passes: 2, failures: 1, skips: 0 },
      { engine: 'webkit', session: 'vod-dash', runs: 0, passes: 0, failures: 0, skips: 1 },
    ]);
  });
});
