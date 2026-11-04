import type { LiveOptions, RequestLogEntry, SessionDetail, SessionInfo } from '../../shared/api.ts';
import type { FaultRule } from '../../shared/faults.ts';
import type { PlayerPageParams, QAEvent, QAEventName, QAInfo, QAMetrics } from '../../shared/qa.ts';
import type { Protocol, StreamId, StreamInfo } from '../../shared/streams.ts';
import type { Engine } from './soak-evaluators.ts';

// What the readiness checks need from the outside world, as interfaces: a player, the test data service and a way to open a fresh
// session with a fresh browser context. The Playwright support library's `PlayerHandle` satisfies `ReadinessPlayer` as it is (the
// spec passes it), the command line gives the same checks a player of its own (`page.ts`), and the unit tests give them a scripted
// one: the procedures are written once and are the same in all three places (docs/decisions/readiness.md, ADR-150).

/** The part of the hook the checks use. `PlayerHandle` (tests/e2e/support/player.ts) has every one of these members with these signatures. */
export interface ReadinessPlayer {
  /** Navigates to the player page for the session's manifest and resolves when the player is built (`qa.ready`). Does not wait for the load. */
  open(params?: PlayerPageParams): Promise<unknown>;
  metrics(): Promise<QAMetrics>;
  info(): Promise<QAInfo>;
  cursor(): Promise<number>;
  events(since?: number): Promise<QAEvent[]>;
  waitFor(name: QAEventName, options?: { since?: number; timeoutMs?: number }): Promise<QAEvent>;
  waitForMediaTime(seconds: number, options?: { timeoutMs?: number }): Promise<number>;
  /** Shaka's `player.configure()`; rejects a key Shaka does not know. */
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
