import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_KEYS } from '../../../src/lab/measure/rules.ts';
import type { PlayerDriver } from '../../../src/lab/measure/page.ts';
import {
  FRAME_WARMUP_MEDIA_SEC,
  FRAME_WINDOW_MEDIA_SEC,
  PINNED_HEIGHT,
  REBUFFER_OBSERVE_MEDIA_SEC,
  SCENARIOS,
  scenarioById,
  scenariosFor,
} from '../../../src/lab/measure/scenarios.ts';
import type { Scenario } from '../../../src/lab/measure/scenarios.ts';
import { PERF_PROFILES } from '../../../src/lab/measure/types.ts';
import { PROFILE_DEFINITIONS } from '../../../src/shared/profiles.ts';
import type {
  FrameMeasurement,
  PlayerPageParams,
  QAError,
  QAEvent,
  QAEventName,
  QAMetrics,
} from '../../../src/shared/qa.ts';
import { ENGINES, expandEngines, parseCatalog } from '../../../tools/catalog.ts';

const STRATEGY = readFileSync(new URL('../../../TEST_STRATEGY.md', import.meta.url), 'utf8');
const SESSION = { id: 's1', manifestUrl: '/s/s1/vod-cmaf/dash/manifest.mpd' };

describe('PB-PERF scenarios: they are the catalog rows', () => {
  const perfRows = parseCatalog(STRATEGY).filter((row) => row.runsIn === 'perf');

  it('has a scenario for every performance row of the catalog and no other', () => {
    expect(perfRows.map((row) => row.id)).toStrictEqual(SCENARIOS.map((scenario) => scenario.id));
    expect(perfRows.map((row) => row.id)).toStrictEqual([
      'PB-PERF-001',
      'PB-PERF-002',
      'PB-PERF-003',
      'PB-PERF-004',
    ]);
  });

  it('runs each scenario in the engines the row names', () => {
    for (const row of perfRows) {
      expect([...scenarioById(row.id)!.profiles], row.id).toStrictEqual(expandEngines(row.engines));
    }
  });

  it('knows exactly the profiles of the catalog', () => {
    expect([...PERF_PROFILES]).toStrictEqual([...ENGINES]);
    expect(scenariosFor('chromium').map((s) => s.id)).toStrictEqual([
      'PB-PERF-001',
      'PB-PERF-002',
      'PB-PERF-003',
    ]);
    expect(scenariosFor('firefox').map((s) => s.id)).toStrictEqual([
      'PB-PERF-001',
      'PB-PERF-002',
      'PB-PERF-003',
    ]);
    expect(scenariosFor('webkit').map((s) => s.id)).toStrictEqual([
      'PB-PERF-001',
      'PB-PERF-002',
      'PB-PERF-003',
    ]);
    expect(scenariosFor('chromium-cpu4x').map((s) => s.id)).toStrictEqual(['PB-PERF-004']);
  });

  it('uses the named conditions the profile table says it uses them with', () => {
    for (const scenario of SCENARIOS) {
      expect(PROFILE_DEFINITIONS[scenario.faultProfile].usedBy, scenario.id).toContain(scenario.id);
    }
    expect(scenarioById('PB-PERF-003')!.faultProfile).toBe('bandwidth-drop');
  });

  it('pins the rung where the row says pinned, and only there or where the window needs it', () => {
    const row = perfRows.find((r) => r.id === 'PB-PERF-002')!;
    expect(row.scenario).toMatch(/pinned 720p/);
    expect(scenarioById('PB-PERF-002')!.pinnedHeight).toBe(720);
    expect(scenarioById('PB-PERF-001')!.pinnedHeight).toBeNull();
    expect(scenarioById('PB-PERF-003')!.pinnedHeight).toBeNull();
    expect(row.scenario).toMatch(/5 s measured window/);
    expect(FRAME_WINDOW_MEDIA_SEC).toBe(5);
  });

  it('gives every metric a unique id, a known unit and, where it gates, a rule that exists', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.metrics.map((metric) => metric.id);
      expect(new Set(ids).size, scenario.id).toBe(ids.length);
      for (const metric of scenario.metrics) {
        expect(['ms', 'fps', 'ratio', 'count'], `${scenario.id} ${metric.id}`).toContain(metric.unit);
        if (metric.rule !== null) expect(RULE_KEYS, `${scenario.id} ${metric.id}`).toContain(metric.rule);
      }
      expect(
        scenario.metrics.some((metric) => metric.rule !== null),
        `${scenario.id} gates something`,
      ).toBe(true);
    }
  });

  it('gates what the catalog rows name: startup, fps and dropped ratio, rebuffer count/duration/ratio, low-end startup and dropped', () => {
    const gated = (id: string): string[] =>
      scenarioById(id)!
        .metrics.filter((m) => m.rule !== null)
        .map((m) => `${m.id}:${m.rule}`);
    expect(gated('PB-PERF-001')).toStrictEqual(['startupMs:startup']);
    expect(gated('PB-PERF-002')).toStrictEqual(['fps:fps', 'droppedRatio:frameDropped']);
    expect(gated('PB-PERF-003')).toStrictEqual([
      'rebufferCount:rebufferCount',
      'rebufferMs:rebufferMs',
      'rebufferRatio:rebufferRatio',
    ]);
    expect(gated('PB-PERF-004')).toStrictEqual(['startupMs:lowEndStartup', 'droppedRatio:lowEndDropped']);
  });

  it('uses the low-end rules for the throttled profile, not the unthrottled ones', () => {
    expect(scenarioById('PB-PERF-004')!.profiles).toStrictEqual(['chromium-cpu4x']);
    expect(scenarioById('PB-PERF-004')!.metrics.find((m) => m.id === 'startupMs')!.rule).not.toBe(
      scenarioById('PB-PERF-001')!.metrics.find((m) => m.id === 'startupMs')!.rule,
    );
  });

  it('plays the observation window of the rebuffering row: four segments before the drop and ten seconds after', () => {
    expect(REBUFFER_OBSERVE_MEDIA_SEC).toBe(18);
    expect(PROFILE_DEFINITIONS['bandwidth-drop'].rules).toStrictEqual([
      { type: 'throttle', kbps: 600, afterMs: 8000 },
    ]);
  });
});

// --------------------------------------------------------------------------------------------------- a scripted player

function metrics(
  over: {
    startupMs?: number | null;
    manifestMs?: number | null;
    loadedMs?: number | null;
    rebuffer?: Partial<QAMetrics['rebuffer']>;
    startHeight?: number | null;
    history?: QAMetrics['bitrate']['history'];
    currentHeight?: number | null;
    switches?: number;
    errors?: QAError[];
  } = {},
): QAMetrics {
  const startHeight = over.startHeight === undefined ? 720 : over.startHeight;
  const history: QAMetrics['bitrate']['history'] =
    over.history ??
    (startHeight === null ? [] : [{ t: 50, from: null, to: 3, height: startHeight, reason: 'start' }]);
  return {
    state: 'playing',
    startupMs: over.startupMs === undefined ? 148 : over.startupMs,
    startup: {
      manifestMs: over.manifestMs === undefined ? 14 : over.manifestMs,
      loadedMs: over.loadedMs === undefined ? 22 : over.loadedMs,
    },
    rebuffer: { count: 0, totalMs: 0, ratio: 0, events: [], ...over.rebuffer },
    frames: { decoded: 0, dropped: 0, droppedRatio: 0, presented: 0 },
    bitrate: {
      switches: over.switches ?? 0,
      current:
        over.currentHeight === null
          ? null
          : {
              id: 3,
              bandwidth: 1_800_000,
              width: 1280,
              height: over.currentHeight ?? 720,
              videoCodec: 'vp09.00.10.08',
              audioCodec: 'mp4a.40.2',
            },
      history,
    },
    live: { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null, edgeSeeks: 0 },
    errors: over.errors ?? [],
    playback: {
      currentTime: 9,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 8,
      readyState: 4,
    },
  };
}

class ScriptedPlayer implements PlayerDriver {
  readonly calls: string[] = [];
  /** The waits for a critical error that scenarios keep next to the media-time wait: they are not steps of the scenario, so they are listed apart. */
  readonly watches: string[] = [];
  constructor(
    private readonly script: {
      metrics: QAMetrics[];
      frames?: FrameMeasurement;
      firstMediaTime?: number;
      /** The player gives up: the wait for a critical error resolves, and the media clock never gets there. */
      givesUp?: boolean;
    },
  ) {}

  async open(manifest: string, params: PlayerPageParams = {}): Promise<never> {
    this.calls.push(`open ${manifest} ${JSON.stringify(params)}`);
    return {} as never;
  }
  async metrics(): Promise<QAMetrics> {
    this.calls.push('metrics');
    const next = this.script.metrics.length > 1 ? this.script.metrics.shift() : this.script.metrics[0];
    return next!;
  }
  waitFor(
    name: QAEventName,
    options: { timeoutMs?: number; detail?: Record<string, string | number | boolean | null> } = {},
  ): Promise<QAEvent> {
    if (name === 'error') {
      this.watches.push(
        `${name} ${JSON.stringify(options.detail)}${options.timeoutMs === undefined ? '' : ` within ${options.timeoutMs}`}`,
      );
      if (!this.script.givesUp) return new Promise(() => {}); // no critical error: the usual case, the wait never ends
      return Promise.resolve({
        index: 9,
        t: 900,
        name,
        mediaTime: 8.96,
        detail: { code: 1003, codeName: 'TIMEOUT', severity: 2 },
      });
    }
    this.calls.push(`waitFor ${name}`);
    return Promise.resolve({ index: 4, t: 150, name, mediaTime: this.script.firstMediaTime ?? 0.1 });
  }
  waitForMediaTime(seconds: number, timeoutMs?: number): Promise<number> {
    this.calls.push(`waitForMediaTime ${seconds}${timeoutMs === undefined ? '' : ` within ${timeoutMs}`}`);
    return this.script.givesUp ? new Promise(() => {}) : Promise.resolve(seconds);
  }
  async load(): Promise<void> {
    this.calls.push('load');
  }
  async play(): Promise<void> {
    this.calls.push('play');
  }
  async selectVariantByHeight(height: number): Promise<void> {
    this.calls.push(`pin ${height}`);
  }
  async measureFrames(mediaSeconds: number): Promise<FrameMeasurement> {
    this.calls.push(`measureFrames ${mediaSeconds}`);
    return this.script.frames ?? { presented: 149, dropped: 1, decoded: 150, mediaSeconds: 5, fps: 29.8 };
  }
}

async function run(
  scenario: Scenario,
  player: ScriptedPlayer,
  profile: Scenario['profiles'][number] = 'chromium',
) {
  return scenario.run({ qa: player, session: SESSION, stream: 'vod-cmaf', profile });
}

describe('PB-PERF-001 startup: one measurement', () => {
  const startup = scenarioById('PB-PERF-001')!;

  it('loads the page as a member would (autoplay, ABR on), waits for the first frame and reads the startup of the hook', async () => {
    const player = new ScriptedPlayer({ metrics: [metrics()] });
    const record = await run(startup, player);
    expect(player.calls).toStrictEqual([
      `open ${SESSION.manifestUrl} undefined`.replace('undefined', '{}'),
      'waitFor firstframe',
      'metrics',
    ]);
    expect(record.values).toStrictEqual({ startupMs: 148, manifestMs: 14, loadedMs: 22 });
  });

  it('records the rung it started on, the rung history and the errors the player reported', async () => {
    const history: QAMetrics['bitrate']['history'] = [
      { t: 50, from: null, to: 1, height: 360, reason: 'start' },
      { t: 900, from: 1, to: 3, height: 720, reason: 'abr' },
    ];
    const record = await run(
      startup,
      new ScriptedPlayer({
        metrics: [
          metrics({
            history,
            errors: [
              { t: 10, code: 1001, codeName: 'BAD_HTTP_STATUS', category: 1, severity: 1, message: 'x' },
            ],
          }),
        ],
      }),
    );
    expect(record.startRungHeight).toBe(360);
    expect(record.rungs).toStrictEqual(history);
    expect(record.errors).toStrictEqual(['BAD_HTTP_STATUS/1']);
  });

  it('reports a metric the player could not give as null, and a missing start rung as null', async () => {
    const record = await run(
      startup,
      new ScriptedPlayer({ metrics: [metrics({ manifestMs: null, startHeight: null })] }),
    );
    expect(record.values.manifestMs).toBeNull();
    expect(record.startRungHeight).toBeNull();
  });

  it('refuses a run in which the player had a critical error', async () => {
    const critical: QAError = {
      t: 1,
      code: 4032,
      codeName: 'REQUESTED_ITEM_NOT_SUPPORTED',
      category: 4,
      severity: 2,
      message: 'x',
    };
    await expect(
      run(startup, new ScriptedPlayer({ metrics: [metrics({ errors: [critical] })] })),
    ).rejects.toThrow(/PB-PERF-001: the player reported a critical error: REQUESTED_ITEM_NOT_SUPPORTED\/2/);
  });
});

describe('PB-PERF-002 frame rate: one measurement', () => {
  const frameRate = scenarioById('PB-PERF-002')!;
  const healthy = (): QAMetrics =>
    metrics({
      history: [
        { t: 50, from: null, to: 1, height: 360, reason: 'start' },
        { t: 60, from: 1, to: 3, height: 720, reason: 'manual' },
      ],
    });

  it('pins the rung BEFORE playing (so the buffer holds nothing else), warms up, then counts the window', async () => {
    const player = new ScriptedPlayer({ metrics: [healthy()], firstMediaTime: 0.5 });
    await run(frameRate, player);
    expect(player.calls).toStrictEqual([
      `open ${SESSION.manifestUrl} {"autoplay":false,"abr":false}`,
      'load',
      `pin ${PINNED_HEIGHT}`,
      'play',
      'waitFor firstframe',
      `waitForMediaTime ${0.5 + FRAME_WARMUP_MEDIA_SEC}`,
      `measureFrames ${FRAME_WINDOW_MEDIA_SEC}`,
      'metrics',
    ]);
  });

  it('reports the window: effective fps, the dropped ratio of the window and its raw counts', async () => {
    const record = await run(
      frameRate,
      new ScriptedPlayer({
        metrics: [healthy()],
        frames: { presented: 148, dropped: 3, decoded: 150, mediaSeconds: 5, fps: 29.6 },
      }),
    );
    expect(record.values).toStrictEqual({
      fps: 29.6,
      droppedRatio: 0.02,
      decodedFrames: 150,
      droppedFrames: 3,
    });
  });

  it('has no dropped ratio when nothing was decoded in the window, and no fps where the engine cannot count presented frames', async () => {
    const record = await run(
      frameRate,
      new ScriptedPlayer({
        metrics: [healthy()],
        frames: { presented: null, dropped: 0, decoded: 0, mediaSeconds: 5, fps: null },
      }),
    );
    expect(record.values.droppedRatio).toBeNull();
    expect(record.values.fps).toBeNull();
  });

  it('refuses a window that was not played on the pinned rung', async () => {
    await expect(
      run(frameRate, new ScriptedPlayer({ metrics: [metrics({ currentHeight: 360 })] })),
    ).rejects.toThrow(/meant to play at 720p but the active rung is 360p/);
  });

  it('refuses a window in which the rung changed by itself', async () => {
    const moved = metrics({
      history: [
        { t: 50, from: null, to: 3, height: 720, reason: 'start' },
        { t: 5000, from: 3, to: 1, height: 360, reason: 'abr' },
        { t: 5100, from: 1, to: 3, height: 720, reason: 'abr' },
      ],
    });
    await expect(run(frameRate, new ScriptedPlayer({ metrics: [moved] }))).rejects.toThrow(
      /the rung changed by itself \(360p, 720p\) although ABR was meant to be off/,
    );
  });
});

describe('PB-PERF-003 rebuffering: one measurement', () => {
  const rebuffering = scenarioById('PB-PERF-003')!;

  it('plays a fixed number of MEDIA seconds with the player on its own, then reads the rebuffer metrics', async () => {
    const stalled = metrics({ rebuffer: { count: 1, totalMs: 850, ratio: 0.045 }, switches: 2 });
    const player = new ScriptedPlayer({ metrics: [stalled], firstMediaTime: 0.2 });
    const record = await run(rebuffering, player);
    expect(player.calls).toStrictEqual([
      `open ${SESSION.manifestUrl} {}`,
      'waitFor firstframe',
      `waitForMediaTime ${0.2 + REBUFFER_OBSERVE_MEDIA_SEC} within 90000`,
      'metrics',
    ]);
    expect(player.watches).toStrictEqual(['error {"severity":2} within 90000']);
    expect(record.values).toStrictEqual({
      rebufferCount: 1,
      rebufferMs: 850,
      rebufferRatio: 0.045,
      switches: 2,
    });
  });

  it('fails the moment the player gives up with a critical error, and does not wait out its safety net', async () => {
    const player = new ScriptedPlayer({ metrics: [metrics()], givesUp: true });
    await expect(run(rebuffering, player)).rejects.toThrow(
      /the player reported a critical error before media time 18\.1 s: \{"code":1003,"codeName":"TIMEOUT","severity":2\}/,
    );
    expect(player.calls).not.toContain('metrics');
  });
});

describe('PB-PERF scenarios: a player that has given up fails every wait for the clock', () => {
  it('in the frame-rate warm-up and the low-end warm-up as well', async () => {
    const pinnedAtStart = metrics({ currentHeight: 720 });
    await expect(
      run(scenarioById('PB-PERF-002')!, new ScriptedPlayer({ metrics: [pinnedAtStart], givesUp: true })),
    ).rejects.toThrow(/critical error before media time 2\.1 s/);
    await expect(
      run(
        scenarioById('PB-PERF-004')!,
        new ScriptedPlayer({ metrics: [pinnedAtStart], givesUp: true }),
        'chromium-cpu4x',
      ),
    ).rejects.toThrow(/critical error before media time 2\.1 s/);
  });
});

describe('PB-PERF-004 low-end profile: one measurement', () => {
  const lowEnd = scenarioById('PB-PERF-004')!;

  it('takes the startup of the plain load, pins the rung it already plays, warms up and counts the window', async () => {
    const started = metrics({ startupMs: 612, manifestMs: 61, loadedMs: 90 });
    const finished = metrics({ currentHeight: 720 });
    const player = new ScriptedPlayer({ metrics: [started, finished], firstMediaTime: 0.4 });
    const record = await run(lowEnd, player, 'chromium-cpu4x');
    expect(player.calls).toStrictEqual([
      `open ${SESSION.manifestUrl} {}`,
      'waitFor firstframe',
      'metrics',
      `pin ${PINNED_HEIGHT}`,
      `waitForMediaTime ${0.4 + FRAME_WARMUP_MEDIA_SEC}`,
      `measureFrames ${FRAME_WINDOW_MEDIA_SEC}`,
      'metrics',
    ]);
    expect(record.values).toStrictEqual({
      startupMs: 612,
      manifestMs: 61,
      loadedMs: 90,
      droppedRatio: 1 / 150,
      fps: 29.8,
      decodedFrames: 150,
      droppedFrames: 1,
    });
    expect(record.startRungHeight).toBe(720);
  });

  it('refuses to measure a window when the player did not start on the pinned rung, and says why', async () => {
    const player = new ScriptedPlayer({ metrics: [metrics({ startHeight: 360 })] });
    await expect(run(lowEnd, player, 'chromium-cpu4x')).rejects.toThrow(
      /the player started on 360p, not on 720p: pinning 720p now would leave the first rung in the buffer.*downlink/,
    );
    expect(player.calls).not.toContain('measureFrames 5');
  });
});
