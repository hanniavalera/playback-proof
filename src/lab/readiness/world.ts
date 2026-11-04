import type { LiveOptions, RequestLogEntry, SessionDetail, SessionInfo } from '../../shared/api.ts';
import type { FaultRule } from '../../shared/faults.ts';
import type { PlayerPageParams, QAEvent, QAEventName, QAInfo, QAMetrics } from '../../shared/qa.ts';
import type { Protocol, StreamId, StreamInfo } from '../../shared/streams.ts';
import type { Engine } from './soak-evaluators.ts';

// What the readiness checks need from the outside world, as interfaces: a player, the test data service and a way to open a fresh
// session with a fresh browser context. The Playwright support library's `PlayerHandle` has most of `ReadinessPlayer` as it is (the
// spec wraps it and adds the two members it lacks, tests/live/support.ts), the command line gives the same checks a player of its own
// (`page.ts`), and the unit tests give them a scripted one: the procedures are written once and are the same in all three places
// (docs/decisions/readiness.md, ADR-150).

/** The part of the hook the checks use. `PlayerHandle` (tests/e2e/support/player.ts) has every member but `openIdle` and `loadAndPlay`, with these signatures. */
export interface ReadinessPlayer {
  /** Navigates to the player page for the session's manifest and resolves when the player is built (`qa.ready`). Does not wait for the load: the page starts it by itself. */
  open(params?: PlayerPageParams): Promise<unknown>;
  /**
   * Navigates to the player page WITHOUT a manifest and resolves when the player is built: it waits, loading nothing, until `loadAndPlay`.
   * It exists for the configurations that Shaka reads when it loads (`streaming.liveSync.enabled` is one: ADR-153), which can only
   * reach it between the build of the player and its load.
   */
  openIdle(): Promise<unknown>;
  /**
   * What the page does by itself when it is opened with a manifest, done for a page opened idle: `qa.load(manifestUri)` and then `qa.play()`,
   * started inside the page one after the other (no round trip between the two, so the startup of a join is the one of the page's own start)
   * and not waited for: the first frame is what the check waits on, with its own timeout, and a failure of either is on the player's timeline
   * (an `error` event), where the checks read it, as it is when the page starts itself.
   */
  loadAndPlay(manifestUri: string): Promise<void>;
  metrics(): Promise<QAMetrics>;
  info(): Promise<QAInfo>;
  cursor(): Promise<number>;
  events(since?: number): Promise<QAEvent[]>;
  waitFor(name: QAEventName, options?: { since?: number; timeoutMs?: number }): Promise<QAEvent>;
  waitForMediaTime(seconds: number, options?: { timeoutMs?: number }): Promise<number>;
  /** Shaka's `player.configure()`; rejects a key Shaka does not know. What Shaka reads when it loads has to be set before `loadAndPlay`. */
  configure(patch: Record<string, unknown>): Promise<void>;
}

/** The part of the service client the checks use (`ServiceClient` satisfies it). */
export interface ReadinessService {
  detail(id: string): Promise<SessionDetail>;
  addFaults(id: string, rules: FaultRule[]): Promise<unknown>;
  log(id: string, since?: number): Promise<RequestLogEntry[]>;
  waitForLog(
    id: string,
    predicate: (entries: RequestLogEntry[]) => boolean,
    options?: { timeoutMs?: number; since?: number },
  ): Promise<RequestLogEntry[]>;
  streams(): Promise<StreamInfo[]>;
}

export type ReadinessSession = SessionInfo & { readonly service: ReadinessService };

export interface NewRunRequest {
  /** Shown in the service's logs: the check and the repetition. */
  label: string;
  live?: LiveOptions;
  /** Session lifetime in seconds; the service's default (15 min) is enough for a check, a soak asks for its own length. */
  ttlSec?: number;
  faults?: FaultRule[];
}

/** One session, one fresh browser context, one player on it; `close` releases them (the context is closed, the session left to its owner). */
export interface ReadinessRun {
  session: ReadinessSession;
  player: ReadinessPlayer;
  close(): Promise<void>;
}

export interface ReadinessWorld {
  engine: Engine;
  /** The live stream this engine plays (`live-cmaf` for every engine today) and how it is packaged. */
  stream: StreamId;
  protocol: Protocol;
  /** The service the sessions are on. */
  service: ReadinessService;
  /** A fresh live session and a player on a fresh browser context for it: a viewer who opens the page. */
  newRun(request: NewRunRequest): Promise<ReadinessRun>;
  /** A monotonic clock in milliseconds. The harness's own (a unit test gives a virtual one that its fake player advances). */
  now(): number;
}
