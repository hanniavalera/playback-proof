import type { RequestLogEntry, SessionDetail } from '../../../src/shared/api.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import type { QAEvent, QAEventName, QAInfo, QAMetrics } from '../../../src/shared/qa.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import type {
  NewRunRequest,
  ReadinessPlayer,
  ReadinessRun,
  ReadinessService,
  ReadinessSession,
  ReadinessWorld,
} from '../../../src/lab/readiness/world.ts';

// A scripted live origin and player on a virtual clock, for the procedures of the readiness checks. It is a model of the behaviours the
// checks have to tell apart, not of Shaka: a join that takes a given time, a latency that is steady, an outage that drains the buffer and
// leaves the playhead 4 s further behind, a configuration that does or does not bring it back (only if the candidate patch was really
// applied through `configure`), a manifest that keeps being asked for or stops, a clock that hangs.

export interface Script {
  /** `startupMs` of each join in the order the world makes them; 15,000 or more is a join that never presents a frame. */
  startupMs?: number[];
  baseLatencyMs?: number;
  /** The player stays as far behind as the outage made it, unless live sync was configured. */
  neverRunsDry?: boolean;
  neverResumes?: boolean;
  /** Gap between manifest requests, ms; the log stops after `manifestStopsAfter` requests. */
  manifestEveryMs?: number;
  manifestStopsAfter?: number;
  /** The media clock stops this many seconds after the first frame (a hung player). */
  hangAfterMediaSec?: number;
  openFails?: boolean;
  /** Extra seconds the player spends dry on top of the part of the outage it could not cover. */
  resumeDelayMs?: number;
  /** The request log also holds the init segment and one media segment per 2 s, as a real session's does (the soak reads the first of them). */
  mediaRequests?: boolean;
}

export const AST_EPOCH = Date.parse('2030-01-01T00:00:00.000Z');
const SEGMENT_MS = 2000;
const TIMEOUT_ERROR = (what: string, ms: number): Error =>
  new Error(
    `${what} timed out after ${ms} ms\nthe last events of the player:\n  #0 +0 ms media 0.00 load-requested`,
  );

/**
 * The scripted player, with the synchronous members the real hook (`window.__qa`) has, so that the fake page of the command line's tests
 * (fake-playwright.ts) can serve them from inside a page function. `waitFor` and `waitForMediaTime` advance the virtual clock and
 * return, or throw the timeout, at once: nothing in the model waits.
 */
export interface FakeModel {
  open(): void;
  info(): QAInfo;
  configure(patch: Record<string, unknown>): void;
  metrics(): QAMetrics;
  cursor(): number;
  events(): QAEvent[];
  waitFor(name: QAEventName, options?: { since?: number; timeoutMs?: number }): QAEvent;
  waitForMediaTime(seconds: number, options?: { timeoutMs?: number }): number;
}

export interface Observed {
  runs: Array<{
    label: string;
    request: NewRunRequest;
    closed: boolean;
    configured: Array<Record<string, unknown>>;
    faults: FaultRule[];
    model: FakeModel;
  }>;
}

export function fakeWorld(script: Script = {}): {
  world: ReadinessWorld;
  observed: Observed;
  clock: { now: number };
} {
  const clock = { now: AST_EPOCH + 30 * SEGMENT_MS };
  const observed: Observed = { runs: [] };
  const base = script.baseLatencyMs ?? 6200;
  let joinIndex = 0;

  function makeRun(request: NewRunRequest): ReadinessRun {
    const createdAt = clock.now;
    const ast = createdAt - (request.live?.startOffsetSec ?? 30) * 1000;
    const record: Observed['runs'][number] = {
      label: request.label,
      request,
      closed: false,
      configured: [],
      faults: [],
      model: undefined as unknown as FakeModel,
    };
    observed.runs.push(record);
    const startupMs = script.startupMs?.[joinIndex] ?? script.startupMs?.at(-1) ?? 900;
    joinIndex += 1;

    let events = 0;
    let media = 0;
    let started = false;
    let lastNow = clock.now;
    let firstFrameAt = 0;
    let outage: { start: number; end: number } | null = null;
    let dryAt: number | null = null;
    let resumedAt: number | null = null;
    let lostMs = 0;
    let liveSync = false;

    const edgeNumber = (): number => {
      const frozen = outage && clock.now >= outage.start && clock.now < outage.end ? outage.start : clock.now;
      return Math.floor((frozen - ast) / SEGMENT_MS);
    };
    const hung = (): boolean => script.hangAfterMediaSec !== undefined && media >= script.hangAfterMediaSec;
    const stalledNow = (): boolean => dryAt !== null && resumedAt === null && clock.now >= dryAt;
    const rateNow = (): number => {
      if (resumedAt === null || !liveSync) return 1;
      return lostMs - 0.1 * (clock.now - resumedAt) > 0 ? 1.1 : 1;
    };
    const sync = (): void => {
      if (started && !hung() && !stalledNow()) media += ((clock.now - lastNow) / 1000) * rateNow();
      if (script.hangAfterMediaSec !== undefined) media = Math.min(media, script.hangAfterMediaSec);
      lastNow = clock.now;
    };
    const advance = (ms: number): void => {
      sync();
      clock.now += ms;
      sync();
    };
    const latencyNow = (): number => {
      if (resumedAt === null) return base + (stalledNow() ? clock.now - (dryAt ?? clock.now) : 0);
      const decayed = liveSync ? 0.1 * (clock.now - resumedAt) : 0;
      return base + Math.max(0, lostMs - decayed);
    };
    const history: QAEvent[] = [];
    const event = (name: QAEventName): QAEvent => {
      const made: QAEvent = { index: events++, t: clock.now - AST_EPOCH, name, mediaTime: media };
      history.push(made);
      return made;
    };

    const manifestTimes = (): number[] => {
      const every = script.manifestEveryMs ?? 2000;
      const times: number[] = [];
      for (let at = createdAt + 300; at <= clock.now; at += every) times.push(at);
      return script.manifestStopsAfter === undefined ? times : times.slice(0, script.manifestStopsAfter);
    };
    const logEntry = (
      seq: number,
      at: number,
      kind: RequestLogEntry['kind'],
      path: string,
      bytes: number,
    ): RequestLogEntry => ({
      seq,
      t: new Date(at).toISOString(),
      msSinceStart: at - createdAt,
      method: 'GET',
      path,
      kind,
      status: 200,
      bytes,
      ttfbMs: 2,
      totalMs: 3,
      faults: [],
    });
    const entries = (): RequestLogEntry[] => {
      const manifests = manifestTimes().map((at, i) =>
        logEntry(i + 1, at, 'manifest', '/s/x/live-cmaf/dash/manifest.mpd', 4000),
      );
      if (!script.mediaRequests) return manifests;
      // The init segment right after the first manifest, then one video segment every segment duration: what a playing session asks for.
      const media: RequestLogEntry[] = [
        logEntry(0, createdAt + 400, 'init', '/s/x/live-cmaf/dash/v720/init.mp4', 900),
      ];
      for (let at = createdAt + 800; at <= clock.now; at += SEGMENT_MS)
        media.push(logEntry(0, at, 'segment', '/s/x/live-cmaf/dash/v720/seg.m4s', 180_000));
      return [...manifests, ...media]
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
        .map((entry, i) => ({ ...entry, seq: i + 1 }));
    };

    const service: ReadinessService = {
      async detail(id): Promise<SessionDetail> {
        return {
          ...session,
          id,
          live: {
            ...session.live!,
            edgeNumber: edgeNumber(),
            stalled: outage !== null && clock.now >= outage.start && clock.now < outage.end,
          },
          faults: [],
          counters: { requests: 0, bytes: 0, errors: 0, byKind: {} },
        };
      },
      async addFaults(_id, rules) {
        record.faults.push(...rules);
        const stall = rules.find((rule) => rule.type === 'live-stall');
        if (stall && stall.type === 'live-stall') {
          const start = Math.max(ast + stall.atNumber * SEGMENT_MS, clock.now);
          outage = { start, end: start + stall.ms };
        }
        return rules;
      },
      async log() {
        return entries();
      },
      async waitForLog(_id, predicate, options) {
        const deadline = clock.now + (options?.timeoutMs ?? 10_000);
        while (!predicate(entries())) {
          if (clock.now >= deadline)
            throw new Error('the request log of session x did not reach the expected state');
          advance(1000);
        }
        return entries();
      },
      async streams() {
        return [
          {
            id: 'live-cmaf',
            reps: [
              { id: 'v720', track: 'video' },
              { id: 'a-aac', track: 'audio' },
            ],
          } as unknown as StreamInfo,
        ];
      },
    };

    const session: ReadinessSession = {
      id: `session-${observed.runs.length}`,
      stream: 'live-cmaf',
      protocol: 'dash',
      createdAt: new Date(createdAt).toISOString(),
      ttlSec: 900,
      manifestUrl: '/s/x/live-cmaf/dash/manifest.mpd',
      live: {
        segmentDurationSec: 2,
        availabilityStartTime: new Date(ast).toISOString(),
        windowSegments: 15,
        presentationDelaySec: 6,
        edgeNumber: Math.floor((createdAt - ast) / SEGMENT_MS),
        stalled: false,
      },
      service,
    };

    const model: FakeModel = {
      open() {
        if (script.openFails)
          throw new Error(
            'the player page did not boot (http://127.0.0.1/player/?manifest=...): net::ERR_CONNECTION_REFUSED',
          );
        advance(200);
      },
      info() {
        return {
          shakaVersion: '5.3.3',
          userAgent: 'FakeBrowser/1',
          config: 'A',
          configured: record.configured,
          loadMode: 'media-source',
          paramProblems: [],
          supported: true,
        } as unknown as QAInfo;
      },
      configure(patch) {
        record.configured.push(patch);
        const sync = (patch as { streaming?: { liveSync?: { enabled?: boolean } } }).streaming?.liveSync
          ?.enabled;
        if (sync !== undefined) liveSync = sync;
      },
      metrics() {
        sync();
        return {
          state: stalledNow() ? 'buffering' : 'playing',
          startupMs: started ? startupMs : null,
          errors: [],
          rebuffer: { count: dryAt === null ? 0 : 1, totalMs: 0, ratio: 0, events: [] },
          frames: { decoded: 100, dropped: 0, droppedRatio: 0, presented: 100 },
          live: {
            isLive: true,
            latencyMs: latencyNow(),
            latencyMaxMs: latencyNow(),
            presentationDelayMs: 6000,
            edgeSeeks: 0,
          },
          playback: {
            currentTime: media,
            duration: Infinity,
            paused: false,
            ended: false,
            playbackRate: rateNow(),
            bufferedAheadSec: 6,
            readyState: 4,
          },
        } as unknown as QAMetrics;
      },
      cursor() {
        return events;
      },
      events() {
        return history.slice();
      },
      waitFor(name, options) {
        const timeoutMs = options?.timeoutMs ?? 15_000;
        if (name === 'firstframe') {
          if (startupMs >= timeoutMs) {
            advance(timeoutMs);
            throw TIMEOUT_ERROR("qa.waitFor('firstframe')", timeoutMs);
          }
          advance(startupMs);
          started = true;
          firstFrameAt = clock.now;
          return event('firstframe');
        }
        if (name === 'buffering-start') {
          if (script.neverRunsDry || outage === null) {
            advance(timeoutMs);
            throw TIMEOUT_ERROR("qa.waitFor('buffering-start')", timeoutMs);
          }
          const at = outage.start + 6000;
          if (at - clock.now > timeoutMs) {
            advance(timeoutMs);
            throw TIMEOUT_ERROR("qa.waitFor('buffering-start')", timeoutMs);
          }
          if (at > clock.now) advance(at - clock.now);
          dryAt = clock.now;
          return event('buffering-start');
        }
        if (name === 'playing') {
          if (script.neverResumes || outage === null || dryAt === null) {
            advance(timeoutMs);
            throw TIMEOUT_ERROR("qa.waitFor('playing')", timeoutMs);
          }
          const at = outage.end + (script.resumeDelayMs ?? 0) + 100;
          advance(at - clock.now);
          resumedAt = clock.now;
          lostMs = clock.now - dryAt;
          return event('playing');
        }
        throw new Error(`the fake player does not know ${name}`);
      },
      waitForMediaTime(seconds, options) {
        sync();
        if (hung()) {
          advance(options?.timeoutMs ?? 15_000);
          throw TIMEOUT_ERROR(`qa.waitForMediaTime(${seconds})`, options?.timeoutMs ?? 15_000);
        }
        if (seconds > media) advance(((seconds - media) / rateNow()) * 1000);
        if (hung() && seconds > media) {
          advance(options?.timeoutMs ?? 15_000);
          throw TIMEOUT_ERROR(`qa.waitForMediaTime(${seconds})`, options?.timeoutMs ?? 15_000);
        }
        void firstFrameAt;
        return media;
      },
    };
    record.model = model;

    // The async members of the interface the checks are written against: the model's, one microtask later.
    const player: ReadinessPlayer = {
      open: async () => model.open(),
      info: async () => model.info(),
      configure: async (patch) => model.configure(patch),
      metrics: async () => model.metrics(),
      cursor: async () => model.cursor(),
      events: async () => model.events(),
      waitFor: async (name, options) => model.waitFor(name, options),
      waitForMediaTime: async (seconds, options) => model.waitForMediaTime(seconds, options),
    };

    return {
      session,
      player,
      async close() {
        record.closed = true;
      },
    };
  }

  const world: ReadinessWorld = {
    engine: 'chromium',
    stream: 'live-cmaf',
    protocol: 'dash',
    service: {} as ReadinessService,
    async newRun(request) {
      return makeRun(request);
    },
    now: () => clock.now,
  };
  return { world, observed, clock };
}
