import { describe, expect, it } from 'vitest';
import type { LaunchOptions, Launcher, LaunchedBrowser, RunPage } from '../../../src/lab/measure/browser.ts';
import { HarnessError, runBatch } from '../../../src/lab/measure/runner.ts';
import type { BatchProgress, Driver, SessionApi } from '../../../src/lab/measure/runner.ts';
import type { Scenario } from '../../../src/lab/measure/scenarios.ts';
import type { SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import { FLAVOUR_IDS } from '../../../src/lab/probe/formats.ts';
import { resolveEnvironment } from '../../../src/lab/gaps.ts';
import { profile } from '../../../src/shared/profiles.ts';
import { probedEngine, resultFile, verdict } from '../probe/fixtures.ts';
import { STARTUP } from './fixtures.ts';

// The orchestration of a batch, with a launcher, a service and scenarios that are fakes: what is under test is WHEN things are created,
// recorded, discarded and closed, not what a browser does.

const ENVIRONMENT = resolveEnvironment({
  envId: 'fixture-new-runner',
  engine: 'chromium',
  platform: 'darwin',
});

interface World {
  log: string[];
  sessions: SessionRequest[];
  /** The options each launch was given, in order. */
  launches: Array<LaunchOptions | undefined>;
  launcher: Launcher;
  service: { origin: string; client: SessionApi };
  driverFor: (run: RunPage) => Driver;
}

function world(options: { failLaunch?: boolean } = {}): World {
  const log: string[] = [];
  const sessions: SessionRequest[] = [];
  const launches: Array<LaunchOptions | undefined> = [];
  let contexts = 0;
  let nextSession = 0;
  const launcher: Launcher = async (profileName, launchOptions) => {
    if (options.failLaunch) throw new Error("Executable doesn't exist at /nowhere");
    log.push(`launch ${profileName}`);
    launches.push(launchOptions);
    const browser: LaunchedBrowser = {
      profile: profileName,
      engine: 'chromium',
      version: '156.0',
      cpuThrottleRate: null,
      async newRun() {
        const id = ++contexts;
        log.push(`context ${id} open`);
        return {
          page: {} as RunPage['page'],
          context: {} as RunPage['context'],
          close: async () => {
            log.push(`context ${id} closed`);
          },
        };
      },
      userAgent: async () => 'UA',
      close: async () => {
        log.push('browser closed');
      },
    };
    return browser;
  };
  const client: SessionApi = {
    async createSession(request): Promise<SessionInfo> {
      sessions.push(request);
      const id = `s${++nextSession}`;
      log.push(`session ${id} created`);
      return { id, manifestUrl: `/s/${id}/manifest.mpd` } as SessionInfo;
    },
    async deleteSession(id) {
      log.push(`session ${id} deleted`);
    },
  };
  return {
    log,
    sessions,
    launches,
    launcher,
    service: { origin: 'http://127.0.0.1:1', client },
    driverFor: () => ({ diagnostics: async () => 'the last events of the player: ...' }) as unknown as Driver,
  };
}

/** A scenario whose run returns a value that counts up (10, 20, 30...), so that every run can be told apart. */
function counting(overrides: Partial<Scenario> = {}): { scenario: Scenario; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const scenario: Scenario = {
    ...STARTUP,
    async run({ session, stream, profile: where }) {
      n += 1;
      calls.push(`run ${n} ${session.id} ${stream} ${where}`);
      return { values: { startupMs: n * 10, manifestMs: n }, startRungHeight: 720, rungs: [], errors: [] };
    },
    ...overrides,
  };
  return { scenario, calls };
}

const request = (w: World, scenario: Scenario, extra: Partial<Parameters<typeof runBatch>[0]> = {}) => ({
  scenario,
  profile: 'chromium' as const,
  runs: 3,
  warmupRuns: 1,
  environment: ENVIRONMENT,
  service: w.service,
  launch: w.launcher,
  driverFor: w.driverFor,
  ...extra,
});

describe('PB-PERF runner: warm-up, contexts and sessions', () => {
  it('makes the first run a warm-up: recorded in the batch, left out of the measured runs', async () => {
    const w = world();
    const { scenario } = counting();
    const batch = await runBatch(request(w, scenario));
    expect(batch.warmup?.values.startupMs).toBe(10);
    expect(batch.runs.map((run) => run.values.startupMs)).toStrictEqual([20, 30, 40]);
    expect(batch.runs).toHaveLength(3);
  });

  it('can run without a warm-up', async () => {
    const w = world();
    const batch = await runBatch(request(w, counting().scenario, { warmupRuns: 0 }));
    expect(batch.warmup).toBeNull();
    expect(batch.runs.map((run) => run.values.startupMs)).toStrictEqual([10, 20, 30]);
  });

  it('launches one browser per batch, a fresh context and a session of its own per run, and cleans up after each', async () => {
    const w = world();
    await runBatch(request(w, counting().scenario, { runs: 2 }));
    expect(w.log).toStrictEqual([
      'launch chromium',
      'session s1 created',
      'context 1 open',
      'context 1 closed',
      'session s1 deleted',
      'session s2 created',
      'context 2 open',
      'context 2 closed',
      'session s2 deleted',
      'session s3 created',
      'context 3 open',
      'context 3 closed',
      'session s3 deleted',
      'browser closed',
    ]);
  });

  it('creates every session with the condition and the stream of the scenario, labelled for the log', async () => {
    const w = world();
    const { scenario, calls } = counting({ faultProfile: 'bandwidth-drop' });
    await runBatch(request(w, scenario, { runs: 1, warmupRuns: 0 }));
    expect(w.sessions).toStrictEqual([
      {
        stream: 'vod-cmaf',
        protocol: 'dash',
        label: 'perf PB-PERF-001 chromium #1',
        ttlSec: 300,
        faults: profile('bandwidth-drop'),
      },
    ]);
    expect(calls).toStrictEqual(['run 1 s1 vod-cmaf chromium']);
  });

  it('adds injected faults to the condition of every session, as copies, and records them in the batch', async () => {
    const w = world();
    const injected = [{ type: 'latency' as const, ms: 150, match: { kind: 'manifest' as const } }];
    const batch = await runBatch(
      request(w, counting({ faultProfile: 'bandwidth-drop' }).scenario, { runs: 2, extraFaults: injected }),
    );
    expect(w.sessions).toHaveLength(3);
    for (const session of w.sessions) {
      expect(session.faults).toStrictEqual([...profile('bandwidth-drop'), ...injected]);
    }
    expect(w.sessions[0]!.faults![1]).not.toBe(injected[0]);
    expect(batch.injectedFaults).toStrictEqual(injected);
  });

  it('does not mention injected faults in a normal batch', async () => {
    const batch = await runBatch(request(world(), counting().scenario, { runs: 1 }));
    expect('injectedFaults' in batch).toBe(false);
    expect('injectedCpuThrottle' in batch).toBe(false);
  });

  it('launches the browser with a replaced CPU throttle and records it in the batch; otherwise with no options', async () => {
    const heavy = world();
    const batch = await runBatch(request(heavy, counting().scenario, { runs: 1, cpuThrottleRate: 8 }));
    expect(heavy.launches).toStrictEqual([{ cpuThrottleRate: 8 }]);
    expect(batch.injectedCpuThrottle).toBe(8);

    const normal = world();
    await runBatch(request(normal, counting().scenario, { runs: 1 }));
    expect(normal.launches).toStrictEqual([undefined]);
  });

  it('labels the warm-up as such in the service log', async () => {
    const w = world();
    await runBatch(request(w, counting().scenario, { runs: 1 }));
    expect(w.sessions.map((s) => s.label)).toStrictEqual([
      'perf PB-PERF-001 chromium warm-up',
      'perf PB-PERF-001 chromium #1',
    ]);
  });

  it('describes the batch: what was measured, under which condition, when, and how loaded the machine was', async () => {
    const w = world();
    const times = ['2026-11-04T09:00:00.000Z', '2026-11-04T09:00:42.000Z'];
    const loads = [0.8, 3.2];
    const batch = await runBatch(
      request(w, counting({ pinnedHeight: 720 }).scenario, {
        now: () => new Date(times.shift() as string),
        load: () => loads.shift() as number,
      }),
    );
    expect(batch).toMatchObject({
      scenarioId: 'PB-PERF-001',
      profile: 'chromium',
      stream: 'vod-cmaf',
      protocol: 'dash',
      faultProfile: 'clean',
      pinnedHeight: 720,
      loadAverage: { before: 0.8, after: 3.2 },
      startedAt: '2026-11-04T09:00:00.000Z',
      finishedAt: '2026-11-04T09:00:42.000Z',
    });
    expect(batch.runs.every((run) => run.durationMs >= 0)).toBe(true);
  });

  it('reports its progress: the batch, then every run with its warm-up flag', async () => {
    const w = world();
    const events: BatchProgress[] = [];
    await runBatch(request(w, counting().scenario, { runs: 2, onProgress: (event) => events.push(event) }));
    expect(
      events.map((e) =>
        e.kind === 'batch' ? 'batch' : `run ${e.index + 1}/${e.total}${e.warmup ? ' warm-up' : ''}`,
      ),
    ).toStrictEqual(['batch', 'run 1/3 warm-up', 'run 2/3', 'run 3/3']);
  });
});

describe('PB-PERF runner: when something goes wrong the batch stops and cleans up', () => {
  it('ends the batch at the first run that fails, names it, and closes everything it opened', async () => {
    const w = world();
    const scenario: Scenario = {
      ...STARTUP,
      async run({ session }) {
        if (session.id === 's3') throw new Error("qa.waitFor('firstframe'): timed out");
        return { values: { startupMs: 1 }, startRungHeight: 720, rungs: [], errors: [] };
      },
    };
    const attempt = runBatch(request(w, scenario));
    await expect(attempt).rejects.toBeInstanceOf(HarnessError);
    await expect(attempt).rejects.toThrow(
      /PB-PERF-001 on chromium, run 2 of 3: qa\.waitFor\('firstframe'\): timed out\nthe last events of the player/,
    );
    expect(w.log.filter((line) => line.startsWith('launch'))).toHaveLength(1);
    expect(w.log.slice(-5)).toStrictEqual([
      'session s3 created',
      'context 3 open',
      'context 3 closed',
      'session s3 deleted',
      'browser closed',
    ]);
  });

  it('does not run on after a failure: the later runs never start', async () => {
    const w = world();
    let started = 0;
    const scenario: Scenario = {
      ...STARTUP,
      async run() {
        started += 1;
        throw new Error('the player reported a critical error');
      },
    };
    await expect(runBatch(request(w, scenario))).rejects.toThrow(
      /the warm-up run: the player reported a critical error/,
    );
    expect(started).toBe(1);
    expect(w.log.at(-1)).toBe('browser closed');
  });

  it('fails a run that does not finish, and says which', async () => {
    const w = world();
    const scenario: Scenario = { ...STARTUP, run: () => new Promise(() => {}) };
    await expect(runBatch(request(w, scenario, { runTimeoutMs: 40 }))).rejects.toThrow(
      /the warm-up run: PB-PERF-001 the warm-up run did not finish within 40 ms/,
    );
    expect(w.log).toContain('context 1 closed');
    expect(w.log).toContain('session s1 deleted');
  });

  it('fails a run whose session cannot be created, and still closes the browser', async () => {
    const w = world();
    w.service.client.createSession = async () => {
      throw new Error('POST /api/sessions -> 0 ECONNREFUSED');
    };
    await expect(runBatch(request(w, counting().scenario))).rejects.toThrow(
      /the warm-up run: POST \/api\/sessions -> 0 ECONNREFUSED/,
    );
    expect(w.log).toStrictEqual(['launch chromium', 'browser closed']);
  });

  it('says that the browser did not start, with its own reason', async () => {
    const w = world({ failLaunch: true });
    const attempt = runBatch(request(w, counting().scenario));
    await expect(attempt).rejects.toThrow(
      /the browser of chromium did not start: Executable doesn't exist at \/nowhere/,
    );
    await expect(attempt).rejects.toMatchObject({ kind: 'launch' });
  });

  it('does not launch anything where the engine cannot play the stream (a documented gap), and says why', async () => {
    const gapped = resolveEnvironment({
      envId: 'fixture-linux-arm64',
      engine: 'webkit',
      platform: 'linux',
      runInLinuxWebKit: false,
      evidence: resultFile('fixture-linux-arm64', {
        webkit: probedEngine({
          version: '3.0',
          cases: Object.fromEntries(FLAVOUR_IDS.map((id) => [id, verdict(2, 5, true)])),
        }),
      }),
    });
    const w = world();
    const attempt = runBatch(request(w, counting().scenario, { environment: gapped, profile: 'webkit' }));
    await expect(attempt).rejects.toMatchObject({ kind: 'gap' });
    await expect(attempt).rejects.toThrow(
      /PB-PERF-001 cannot run on webkit in fixture-linux-arm64: documented gap in fixture-linux-arm64/,
    );
    expect(w.log).toStrictEqual([]);
  });

  it('refuses a batch that is not one: no runs, or a warm-up that is not 0 or 1', async () => {
    const w = world();
    await expect(runBatch(request(w, counting().scenario, { runs: 0 }))).rejects.toThrow(RangeError);
    await expect(runBatch(request(w, counting().scenario, { warmupRuns: 2 }))).rejects.toThrow(
      /warmupRuns must be 0 or 1/,
    );
    expect(w.log).toStrictEqual([]);
  });
});
