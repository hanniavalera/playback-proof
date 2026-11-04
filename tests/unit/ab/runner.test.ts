import { describe, expect, it } from 'vitest';
import { assertConfiguration, blockSchedule, runCondition } from '../../../ab/experiment.ts';
import type { ExperimentDeps, ExperimentProgress, SessionDriver } from '../../../ab/experiment.ts';
import { canonicalJson, validatePreregistration } from '../../../ab/prereg.ts';
import type { Preregistration } from '../../../ab/prereg.ts';
import { FLAVOUR_IDS } from '../../../src/lab/probe/formats.ts';
import { resolveEnvironment } from '../../../src/lab/gaps.ts';
import { configFor } from '../../../src/player/configs.ts';
import type { LaunchedBrowser, Launcher, RunPage } from '../../../src/lab/measure/browser.ts';
import { HarnessError } from '../../../src/lab/measure/runner.ts';
import type { SessionApi } from '../../../src/lab/measure/runner.ts';
import type { SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import type { QAEvent, QAInfo, QAMetrics } from '../../../src/shared/qa.ts';
import { probedEngine, resultFile, verdict } from '../probe/fixtures.ts';
import { rebufferPrereg, startupPrereg } from './fixtures.ts';
import type { Json } from './fixtures.ts';

// The runner with a browser, a service and a player that are fakes: what is under test is WHEN things are created, recorded, discarded and
// closed, which arm runs with which configuration in which order, and what becomes of a session that fails. What a real browser does is
// the pipeline check of the second phase.

const ENVIRONMENT = resolveEnvironment({ envId: 'fixture-env', engine: 'chromium', platform: 'darwin' });

function planFrom(raw: Json): Preregistration {
  const result = validatePreregistration(raw);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.prereg;
}

/** A small experiment: 4 sessions per arm and one warm-up each (the validator wants 30 for a real one, so this is a pipeline check). */
function smallPlan(over: Json = {}): Preregistration {
  return planFrom({
    ...startupPrereg(),
    kind: 'pipeline-check',
    catalogId: null,
    sessionsPerArm: 4,
    warmupSessionsPerArm: 1,
    bootstrapResamples: 100,
    ...over,
  });
}

type Script = (
  arm: 'A' | 'B',
  index: number,
) => {
  fail?: 'timeout' | 'critical' | 'page' | 'mismatch' | 'not-mse';
  startupMs?: number;
  rebuffers?: number;
};

function metricsFor(
  arm: 'A' | 'B',
  index: number,
  startupMs: number,
  rebuffers: number,
  critical: boolean,
): QAMetrics {
  return {
    startupMs,
    startup: { manifestMs: 40 + index, loadedMs: 90 },
    rebuffer: { count: rebuffers, totalMs: rebuffers * 1500, ratio: rebuffers * 0.05, events: [] },
    frames: { decoded: 300, dropped: 3, droppedRatio: 0.01, presented: 300 },
    bitrate: {
      switches: arm === 'A' ? 0 : 2,
      current: null,
      history:
        arm === 'A'
          ? [{ t: 10, from: null, to: 1, height: 720, reason: 'start' }]
          : [
              { t: 10, from: null, to: 3, height: 240, reason: 'start' },
              { t: 3000, from: 3, to: 2, height: 360, reason: 'abr' },
              { t: 8000, from: 2, to: 1, height: 720, reason: 'abr' },
            ],
    },
    errors: critical
      ? [{ t: 5, code: 1001, category: 1, severity: 2, message: 'x', codeName: 'BAD_HTTP_STATUS' }]
      : [],
    live: { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null, edgeSeeks: 0 },
    playback: {
      currentTime: 20,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 8,
      readyState: 4,
    },
    state: 'playing',
  } as QAMetrics;
}

interface World {
  log: string[];
  sessions: SessionRequest[];
  opens: Array<{ manifest: string; config: string | undefined }>;
  mediaWaits: number[];
  deps: ExperimentDeps;
  progress: ExperimentProgress[];
}

function world(
  script: Script = () => ({}),
  options: { failSession?: boolean; failLaunch?: boolean } = {},
): World {
  const log: string[] = [];
  const sessions: SessionRequest[] = [];
  const opens: World['opens'] = [];
  const mediaWaits: number[] = [];
  const progress: ExperimentProgress[] = [];
  let contexts = 0;
  let nextSession = 0;
  const runArm = new Map<RunPage, { arm: 'A' | 'B'; index: number }>();

  const browser: LaunchedBrowser = {
    profile: 'chromium',
    engine: 'chromium',
    version: '156.0.8078.4',
    cpuThrottleRate: null,
    async newRun() {
      const id = ++contexts;
      log.push(`context ${id} open`);
      const run: RunPage = {
        page: {} as RunPage['page'],
        context: {} as RunPage['context'],
        close: async () => {
          log.push(`context ${id} closed`);
        },
      };
      return run;
    },
    userAgent: async () => 'Mozilla/5.0 Chrome/156',
    close: async () => {
      log.push('browser closed');
    },
  };
  const launch: Launcher = async () => {
    if (options.failLaunch) throw new Error("Executable doesn't exist");
    log.push('browser launched');
    return browser;
  };

  const client: SessionApi = {
    async createSession(request): Promise<SessionInfo> {
      if (options.failSession) throw new Error('the service is gone');
      sessions.push(request);
      const id = `s${++nextSession}`;
      log.push(`session ${id} created`);
      return { id, manifestUrl: `/s/${id}/vod-cmaf/dash/manifest.mpd` } as SessionInfo;
    },
    async deleteSession(id) {
      log.push(`session ${id} deleted`);
    },
  };

  const driverFor = (run: RunPage): SessionDriver => {
    let letter: 'A' | 'B' = 'A';
    const where = (): { arm: 'A' | 'B'; index: number } => runArm.get(run) ?? { arm: letter, index: 0 };
    let sequence = 0;
    return {
      async open(manifest, params) {
        letter = (params?.config ?? 'A') as 'A' | 'B';
        // The arm of a session is not known to the driver, only its configuration letter: scripts key on the session's order instead.
        sequence = opens.length;
        runArm.set(run, { arm: letter, index: sequence });
        opens.push({ manifest, config: params?.config });
        const { fail } = script(letter, sequence);
        return {
          shakaVersion: '5.3.3',
          userAgent: 'Mozilla/5.0 Chrome/156',
          config: fail === 'mismatch' ? (letter === 'A' ? 'B' : 'A') : letter,
          configOverrides: configFor(letter) as Record<string, unknown>,
          configDefaults: letter === 'B' ? { abr: { switchInterval: 8 } } : {},
          configured: [],
          manifestUri: manifest,
          supported: true,
          loadMode: null,
          params: { config: letter, autoplay: true, muted: true, start: null, abr: true, hud: false },
          paramProblems: [],
        } satisfies QAInfo;
      },
      async waitFor(name) {
        const { fail } = script(where().arm, where().index);
        if (name === 'firstframe') {
          if (fail === 'timeout')
            throw new Error("qa.waitFor('firstframe') timed out after 30000 ms: the last events ...");
          if (fail === 'page')
            throw new Error('page.evaluate: Target page, context or browser has been closed');
          return { index: 3, t: 1000, name: 'firstframe', mediaTime: 0.5 } satisfies QAEvent;
        }
        // 'error': nothing critical happens while the page is waited on.
        return new Promise<QAEvent>(() => {});
      },
      async waitForMediaTime(seconds) {
        mediaWaits.push(seconds);
        return seconds;
      },
      async metrics() {
        const { arm, index } = where();
        const scripted = script(arm, index);
        return metricsFor(
          arm,
          index,
          scripted.startupMs ?? 800 + index,
          scripted.rebuffers ?? 0,
          scripted.fail === 'critical',
        );
      },
      async info() {
        const { arm, index } = where();
        const scripted = script(arm, index);
        return {
          shakaVersion: '5.3.3',
          userAgent: 'Mozilla/5.0 Chrome/156',
          config: arm,
          configOverrides: configFor(arm) as Record<string, unknown>,
          configDefaults: arm === 'B' ? { abr: { switchInterval: 8 } } : {},
          configured: [],
          manifestUri: null,
          supported: true,
          loadMode: scripted.fail === 'not-mse' ? 'src=' : 'media-source',
          params: { config: arm, autoplay: true, muted: true, start: null, abr: true, hud: false },
          paramProblems: [],
        } satisfies QAInfo;
      },
      diagnostics: async () => 'the last events of the player: ...',
      load: async () => {},
      play: async () => {},
      selectVariantByHeight: async () => {},
      measureFrames: async () => ({ presented: 0, dropped: 0, decoded: 0, mediaSeconds: 0, fps: null }),
    } as SessionDriver;
  };

  let clock = Date.parse('2026-11-05T09:00:00.000Z');
  return {
    log,
    sessions,
    opens,
    mediaWaits,
    progress,
    deps: {
      service: { origin: 'http://127.0.0.1:4720', client },
      launch,
      environment: ENVIRONMENT,
      driverFor,
      now: () => new Date((clock += 1000)),
      loadAverage: () => 1.25,
      onProgress: (event) => progress.push(event),
    },
  };
}

describe('PB-AB runner: the order of the sessions', () => {
  it('interleaves the arms in blocks of two and alternates the arm that goes first (A B, B A, A B, ...)', () => {
    const schedule = blockSchedule(4, 0, { A: 'A', B: 'B' });
    expect(schedule.map((s) => s.arm).join('')).toBe('ABBAABBA');
    expect(schedule.map((s) => s.block)).toStrictEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(schedule.map((s) => s.index)).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(schedule.every((s) => !s.warmup)).toBe(true);
  });

  it('puts the same average position in time on both arms for an even number of blocks, so that a linear drift cancels', () => {
    for (const blocks of [2, 4, 30]) {
      const measured = blockSchedule(blocks, 2, { A: 'A', B: 'B' }).filter((s) => !s.warmup);
      const mean = (arm: 'A' | 'B'): number => {
        const own = measured.filter((s) => s.arm === arm);
        return own.reduce((sum, s) => sum + s.index, 0) / own.length;
      };
      expect(mean('A')).toBe(mean('B'));
    }
    // An odd number of measured blocks does not balance: that is why the pre-registration insists on an even one.
    const odd = blockSchedule(3, 0, { A: 'A', B: 'B' });
    const average = (arm: 'A' | 'B'): number =>
      odd.filter((s) => s.arm === arm).reduce((sum, s) => sum + s.index, 0) / 3;
    expect(average('A')).not.toBe(average('B'));
  });

  it('marks the first blocks as the warm-up of both arms, and hands the configuration letter of each arm', () => {
    const schedule = blockSchedule(2, 2, { A: 'A', B: 'B' });
    expect(schedule.map((s) => s.warmup)).toStrictEqual([true, true, true, true, false, false, false, false]);
    expect(schedule.filter((s) => s.arm === 'A').every((s) => s.config === 'A')).toBe(true);
    expect(schedule.filter((s) => s.arm === 'B').every((s) => s.config === 'B')).toBe(true);
    expect(blockSchedule(2, 0, { A: 'A', B: 'A' }).every((s) => s.config === 'A')).toBe(true);
  });

  it('refuses a design that is not one', () => {
    expect(() => blockSchedule(0, 0, { A: 'A', B: 'B' })).toThrow(RangeError);
    expect(() => blockSchedule(2.5, 0, { A: 'A', B: 'B' })).toThrow(RangeError);
    expect(() => blockSchedule(2, -1, { A: 'A', B: 'B' })).toThrow(RangeError);
  });
});

describe('PB-AB runner: one condition', () => {
  it('runs the schedule, hands each session the configuration of its arm, records the warm-up apart and keeps every number', async () => {
    const w = world();
    const prereg = smallPlan();
    const run = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    const { result } = run;
    expect(result.sessions).toHaveLength(10);
    expect(result.sessions.map((s) => s.arm).join('')).toBe('ABBAABBAAB');
    expect(result.sessions.map((s) => s.warmup)).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(w.opens.map((open) => open.config).join('')).toBe('ABBAABBAAB');
    for (const open of w.opens) expect(open.manifest).toMatch(/^\/s\/s\d+\/vod-cmaf\/dash\/manifest\.mpd$/);
    expect(result.id).toBe('high-latency');
    expect(result.aborted).toBeNull();
    expect(result.loadAverage).toStrictEqual({ before: 1.25, after: 1.25 });
    expect(run.browser).toStrictEqual({
      name: 'chromium',
      version: '156.0.8078.4',
      userAgent: 'Mozilla/5.0 Chrome/156',
    });

    const a = result.sessions.find((s) => s.arm === 'A' && !s.warmup);
    const b = result.sessions.find((s) => s.arm === 'B' && !s.warmup);
    expect(a).toMatchObject({ status: 'ok', config: 'A', condition: 'high-latency', startRungHeight: 720 });
    expect(a?.values).toMatchObject({ startupMs: expect.any(Number), manifestMs: expect.any(Number) });
    expect(b).toMatchObject({ status: 'ok', config: 'B', startRungHeight: 240 });
    expect(b?.rungs.map((rung) => `${rung.reason}:${rung.height}`)).toStrictEqual([
      'start:240',
      'abr:360',
      'abr:720',
    ]);
  });

  it('records what qa.info() said: the letter, the exact override object and what Shaka held at those keys', async () => {
    const w = world();
    const prereg = smallPlan();
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    const a = result.sessions.find((s) => s.arm === 'A');
    const b = result.sessions.find((s) => s.arm === 'B');
    expect(a?.info).toMatchObject({
      config: 'A',
      configOverrides: {},
      loadMode: 'media-source',
      userAgent: 'Mozilla/5.0 Chrome/156',
    });
    expect(canonicalJson(b?.info?.configOverrides)).toBe(canonicalJson(configFor('B')));
    expect(b?.info?.configOverrides).toMatchObject({
      abr: { useNetworkInformation: false, switchInterval: 4 },
      streaming: { bufferingGoal: 20 },
    });
    expect(b?.info?.configDefaults).toStrictEqual({ abr: { switchInterval: 8 } });
  });

  it("creates a service session for every session with the condition's rules (a copy), and a fresh context, closing both", async () => {
    const w = world();
    const prereg = smallPlan();
    const condition = prereg.conditions[0] as Preregistration['conditions'][number];
    await runCondition(prereg, condition, w.deps);
    expect(w.sessions).toHaveLength(10);
    for (const request of w.sessions) {
      expect(request).toMatchObject({ stream: 'vod-cmaf', protocol: 'dash', ttlSec: 600 });
      expect(request.label).toContain('ab PB-AB-002 high-latency');
      expect(request.faults).toStrictEqual(condition.rules);
      expect(request.faults).not.toBe(condition.rules);
    }
    expect(w.sessions[0]?.label).toContain('warm-up A #1');
    // One browser for the condition, a context per session opened and closed, a session per run created and deleted.
    expect(w.log.filter((line) => line === 'browser launched')).toHaveLength(1);
    expect(w.log.filter((line) => /^context \d+ open$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^context \d+ closed$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ created$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ deleted$/.test(line))).toHaveLength(10);
    expect(w.log.at(-1)).toBe('browser closed');
    const first = w.log.indexOf('session s1 created');
    expect(w.log.indexOf('session s1 deleted')).toBeLessThan(w.log.indexOf('session s2 created'));
    expect(first).toBeGreaterThan(w.log.indexOf('browser launched'));
  });

  it('ends a startup session at the first frame (no playback, the numbers that need playback are null), and plays on when the plan says so', async () => {
    const startup = world();
    const prereg = smallPlan();
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      startup.deps,
    );
    expect(startup.mediaWaits).toStrictEqual([]);
    expect(result.sessions[0]?.values).toMatchObject({
      rebufferCount: null,
      rebufferMs: null,
      rebufferRatio: null,
      switches: null,
      droppedRatio: null,
    });

    const rebuffer = world((arm) => ({ rebuffers: arm === 'B' ? 1 : 0 }));
    const plan = planFrom({
      ...rebufferPrereg(),
      kind: 'pipeline-check',
      catalogId: null,
      sessionsPerArm: 2,
      warmupSessionsPerArm: 0,
      bootstrapResamples: 100,
    });
    const played = await runCondition(
      plan,
      plan.conditions[0] as Preregistration['conditions'][number],
      rebuffer.deps,
    );
    expect(rebuffer.mediaWaits).toStrictEqual([18.5, 18.5, 18.5, 18.5]);
    const b = played.result.sessions.find((s) => s.arm === 'B');
    expect(b?.values).toMatchObject({
      rebufferCount: 1,
      rebufferMs: 1500,
      rebufferRatio: 0.05,
      switches: 2,
      droppedRatio: 0.01,
    });
  });

  it('reports progress: the condition, then every session as it finishes', async () => {
    const w = world();
    const prereg = smallPlan();
    await runCondition(prereg, prereg.conditions[0] as Preregistration['conditions'][number], w.deps);
    expect(w.progress[0]).toStrictEqual({
      kind: 'condition',
      condition: 'high-latency',
      sessions: 10,
      warmup: 2,
    });
    expect(w.progress.filter((event) => event.kind === 'session')).toHaveLength(10);
  });
});

describe('PB-AB runner: a session that fails is recorded, never dropped, and the run goes on', () => {
  const failing: Script = (arm, index) =>
    index === 4
      ? { fail: 'timeout' }
      : index === 6
        ? { fail: 'critical' }
        : index === 7
          ? { fail: 'page' }
          : {};

  it('classifies a timeout, a critical error and a page failure, keeps no numbers for them, and still closes what it opened', async () => {
    const w = world(failing);
    const prereg = smallPlan();
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    expect(result.sessions).toHaveLength(10);
    const failures = result.sessions.filter((s) => s.status === 'failed');
    expect(failures.map((s) => [s.index, s.failure?.kind])).toStrictEqual([
      [4, 'timeout'],
      [6, 'critical-error'],
      [7, 'page'],
    ]);
    for (const failure of failures) {
      expect(failure.values).toStrictEqual({});
      expect(failure.failure?.message).toContain('the last events of the player');
    }
    expect(failures[1]?.failure?.message).toContain('BAD_HTTP_STATUS/2');
    expect(result.sessions.filter((s) => s.status === 'ok')).toHaveLength(7);
    expect(w.log.filter((line) => /^context \d+ closed$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ deleted$/.test(line))).toHaveLength(10);
  });

  it('a session that played through something other than Media Source Extensions is a failure, not a measurement', async () => {
    const w = world((arm, index) => (index === 3 ? { fail: 'not-mse' } : {}));
    const prereg = smallPlan();
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    expect(result.sessions[3]).toMatchObject({ status: 'failed', failure: { kind: 'page' } });
    expect(result.sessions[3]?.failure?.message).toContain('Media Source Extensions');
  });

  it('stops the condition after the pre-registered number of failures in a row, with the sessions it has, and says why', async () => {
    const w = world((arm, index) => (index >= 2 ? { fail: 'timeout' } : {}));
    const prereg = smallPlan({
      exclusionRule: { text: 'x'.repeat(70), maxFailedShare: 0.1, abortAfterConsecutiveFailures: 3 },
    });
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    expect(result.sessions).toHaveLength(5);
    expect(result.aborted).toContain('3 sessions failed in a row');
    expect(result.aborted).toContain('the harness or the environment is broken');
    expect(w.log.at(-1)).toBe('browser closed');
  });

  it('a failure between two good sessions does not count as a streak', async () => {
    const w = world((arm, index) => (index === 2 || index === 4 || index === 6 ? { fail: 'timeout' } : {}));
    const prereg = smallPlan({
      exclusionRule: { text: 'x'.repeat(70), maxFailedShare: 0.1, abortAfterConsecutiveFailures: 2 },
    });
    const { result } = await runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    expect(result.sessions).toHaveLength(10);
    expect(result.aborted).toBeNull();
  });
});

describe('PB-AB runner: what stops the whole run', () => {
  it('a page that runs another configuration than its arm is a defect of the harness, not a failed session', async () => {
    const w = world((arm, index) => (index === 2 ? { fail: 'mismatch' } : {}));
    const prereg = smallPlan();
    const attempt = runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    await expect(attempt).rejects.toBeInstanceOf(HarnessError);
    await expect(attempt).rejects.toThrow(/the page runs configuration .*, the arm needs/);
    expect(w.log.at(-1)).toBe('browser closed');
    expect(w.log.filter((line) => /^session s\d+ created$/.test(line)).length).toBe(
      w.log.filter((line) => /^session s\d+ deleted$/.test(line)).length,
    );
  });

  it('checks the exact overrides, and that ABR is on', () => {
    const base = {
      config: 'B',
      configOverrides: configFor('B') as Record<string, unknown>,
      params: { abr: true },
    } as unknown as QAInfo;
    expect(() => assertConfiguration(base, 'B', 'x')).not.toThrow();
    expect(() =>
      assertConfiguration({ ...base, configOverrides: { abr: { switchInterval: 4 } } }, 'B', 'x'),
    ).toThrow(/overrides the page applied/);
    expect(() => assertConfiguration({ ...base, config: 'A', configOverrides: {} }, 'B', 'x')).toThrow(
      /runs configuration A/,
    );
    expect(() =>
      assertConfiguration({ ...base, params: { abr: false } } as unknown as QAInfo, 'B', 'x'),
    ).toThrow(/ABR was off/);
    expect(() =>
      assertConfiguration(
        {
          config: 'A',
          configOverrides: { abr: { switchInterval: 1 } },
          params: { abr: true },
        } as unknown as QAInfo,
        'A',
        'x',
      ),
    ).toThrow();
  });

  it('a service that cannot create a session ends the run, naming the session', async () => {
    const w = world(() => ({}), { failSession: true });
    const prereg = smallPlan();
    const attempt = runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    await expect(attempt).rejects.toMatchObject({ kind: 'run' });
    await expect(attempt).rejects.toThrow(
      /PB-AB-002 high-latency warm-up A #1: could not set the session up: the service is gone/,
    );
    expect(w.log.at(-1)).toBe('browser closed');
  });

  it('a browser that does not start ends the run before any session exists', async () => {
    const w = world(() => ({}), { failLaunch: true });
    const prereg = smallPlan();
    const attempt = runCondition(
      prereg,
      prereg.conditions[0] as Preregistration['conditions'][number],
      w.deps,
    );
    await expect(attempt).rejects.toMatchObject({ kind: 'launch' });
    expect(w.sessions).toStrictEqual([]);
  });

  it('refuses where the engine cannot play the stream (a documented gap), launching nothing', async () => {
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
    const prereg = smallPlan({ engine: 'webkit' });
    const attempt = runCondition(prereg, prereg.conditions[0] as Preregistration['conditions'][number], {
      ...w.deps,
      environment: gapped,
    });
    await expect(attempt).rejects.toMatchObject({ kind: 'gap' });
    await expect(attempt).rejects.toThrow(/PB-AB-002 cannot run in fixture-linux-arm64: documented gap/);
    expect(w.log).toStrictEqual([]);
  });
});
