import type {
  EvidenceApi,
  ExperimentDeps,
  ExperimentProgress,
  SessionDriver,
} from '../../../ab/experiment.ts';
import type { Machine } from '../../../ab/execute.ts';
import { parsePreregistration, validatePreregistration } from '../../../ab/prereg.ts';
import type { LoadedPreregistration, Preregistration } from '../../../ab/prereg.ts';
import { resolveEnvironment } from '../../../src/lab/gaps.ts';
import type { LaunchedBrowser, Launcher, RunPage } from '../../../src/lab/measure/browser.ts';
import type { SessionApi } from '../../../src/lab/measure/runner.ts';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import { configFor } from '../../../src/player/configs.ts';
import type { RequestLogEntry, SessionDetail, SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import type { QAEvent, QAInfo, QAMetrics } from '../../../src/shared/qa.ts';
import { startupPrereg } from './fixtures.ts';
import type { Json } from './fixtures.ts';

// A browser, a service and a player that are fakes, for the tests of the runner and of the orchestration around it: what they check is WHEN
// things are created, recorded, discarded and closed, which arm runs with which configuration in which order, and what becomes of a
// session that fails. What a real browser does is the pipeline check of the second phase.

export const ENVIRONMENT = resolveEnvironment({
  envId: 'fixture-env',
  engine: 'chromium',
  platform: 'darwin',
});

export const HOST: HostInfo = {
  os: { platform: 'darwin', arch: 'arm64', release: '27.2', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 16,
  node: 'v22.11.0',
  playwright: '1.64.1',
  git: { commit: 'def5678', dirty: false },
};

export function planFrom(raw: Json): Preregistration {
  const result = validatePreregistration(raw);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.prereg;
}

/** A plan as the loader hands it over: its text, its hash and the plan itself. */
export function loadedFrom(raw: Json, path = 'plan.json'): LoadedPreregistration {
  return parsePreregistration(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/** A small experiment: 4 sessions per arm and one warm-up each (the validator wants 30 for a real one, so this is a pipeline check). */
export function smallJson(over: Json = {}): Json {
  return {
    ...startupPrereg(),
    kind: 'pipeline-check',
    catalogId: null,
    sessionsPerArm: 4,
    warmupSessionsPerArm: 1,
    bootstrapResamples: 100,
    ...over,
  };
}

export function smallPlan(over: Json = {}): Preregistration {
  return planFrom(smallJson(over));
}

/** What the fake player does for the session of a configuration letter at a position in the run. */
export type Script = (
  arm: 'A' | 'B',
  index: number,
) => {
  fail?:
    | 'timeout'
    | 'critical'
    | 'page'
    | 'mismatch'
    | 'not-mse'
    /** The service holds other rules for the session than the ones it was given. */
    | 'rules-mismatch'
    /** The rules are the right ones, but no request of the session met any of them. */
    | 'not-applied'
    /** The service cannot say what it holds for the session. */
    | 'unreadable';
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

export interface World {
  log: string[];
  sessions: SessionRequest[];
  opens: Array<{ manifest: string; config: string | undefined }>;
  mediaWaits: number[];
  deps: ExperimentDeps;
  progress: ExperimentProgress[];
}

export function world(
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
  /** The rules the fake service holds per session, and what the script said about each session once its page opened. */
  const held = new Map<string, FaultRule[]>();
  const scripted = new Map<string, string>();

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

  const client: SessionApi & EvidenceApi = {
    async createSession(request): Promise<SessionInfo> {
      if (options.failSession) throw new Error('the service is gone');
      sessions.push(request);
      const id = `s${++nextSession}`;
      held.set(id, structuredClone(request.faults ?? []));
      log.push(`session ${id} created`);
      return { id, manifestUrl: `/s/${id}/vod-cmaf/dash/manifest.mpd` } as SessionInfo;
    },
    async deleteSession(id) {
      log.push(`session ${id} deleted`);
    },
    async getSession(id): Promise<SessionDetail> {
      const fail = scripted.get(id);
      if (fail === 'unreadable') throw new Error('the service did not answer');
      const rules = held.get(id) ?? [];
      const faults = rules.map((rule, i) => ({ ...rule, id: `r${i + 1}` }));
      if (fail === 'rules-mismatch' && faults[0] && faults[0].type === 'latency')
        faults[0] = { ...faults[0], ms: faults[0].ms + 1 };
      return { id, faults } as unknown as SessionDetail;
    },
    async log(id): Promise<RequestLogEntry[]> {
      const fail = scripted.get(id);
      const rules = held.get(id) ?? [];
      return Array.from({ length: 12 }, (_, i) => ({
        seq: i + 1,
        faults: fail === 'not-applied' ? [] : rules.map((_rule, r) => `r${r + 1}`),
      })) as unknown as RequestLogEntry[];
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
        const sessionId = /\/s\/([^/]+)\//.exec(manifest)?.[1];
        if (sessionId !== undefined && fail !== undefined) scripted.set(sessionId, fail);
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

/** The machine of a run made of a fake world: what the command line starts, in the tests, instead of a service and a browser. */
export function machineOf(fake: World, over: Partial<Machine> = {}): Machine {
  return {
    envId: 'fixture-env',
    host: HOST,
    ffmpeg: '9.0.2',
    streams: { 'vod-cmaf': 'f00dfeed' },
    deps: { ...fake.deps },
    stop: async () => {
      fake.log.push('machine stopped');
    },
    ...over,
  };
}
