import { randomBytes } from 'node:crypto';
import type { LiveClockInfo, LiveOptions, SessionDetail, SessionInfo } from '../shared/api.ts';
import type { FaultRule } from '../shared/faults.ts';
import { STREAM_IDS } from '../shared/streams.ts';
import type { Protocol, StreamInfo } from '../shared/streams.ts';
import { manifestPath } from '../shared/urls.ts';
import type { Clock } from './clock.ts';
import {
  LIVE_DEFAULTS,
  MAX_LABEL_LENGTH,
  SESSION_DEFAULT_TTL_SEC,
  SESSION_LIMIT,
  SESSION_MAX_TTL_SEC,
} from './constants.ts';
import { FaultEngine, validateFaultRules } from './faults.ts';
import type { FaultPlan } from './faults.ts';
import { liveView } from './liveclock.ts';
import type { LiveParams, LiveView } from './liveclock.ts';
import { RequestLog } from './requestlog.ts';
import type { RequestLogEntry } from '../shared/api.ts';

// Sessions: everything a test owns (docs/CONTRACTS.md section 4): its live clock, its fault rules, its token buckets, its request log.
// Isolation is structural: nothing here is shared between two sessions.

export interface ParsedSessionRequest {
  stream: StreamInfo;
  protocol: Protocol;
  label?: string;
  ttlSec: number;
  faults: FaultRule[];
  live?: { startOffsetSec: number; windowSegments: number; presentationDelaySec: number };
}

export type ParseResult =
  | { ok: true; value: ParsedSessionRequest }
  /** `status`: 400 for a malformed request, 404 for a stream id that is valid but not available (not generated). */
  | { ok: false; status: 400 | 404; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseLive(
  raw: unknown,
  segmentDurationSec: number,
  errors: string[],
): ParsedSessionRequest['live'] | undefined {
  const options: LiveOptions = {};
  if (raw !== undefined) {
    if (!isRecord(raw)) {
      errors.push('live must be an object');
      return undefined;
    }
    for (const key of Object.keys(raw)) {
      if (!['startOffsetSec', 'windowSegments', 'presentationDelaySec'].includes(key))
        errors.push(`live.${key} is not a known live option`);
    }
    if (raw.startOffsetSec !== undefined) {
      if (inRange(raw.startOffsetSec, segmentDurationSec, 3600)) options.startOffsetSec = raw.startOffsetSec;
      else errors.push(`live.startOffsetSec must be a number from ${segmentDurationSec} to 3600`);
    }
    if (raw.windowSegments !== undefined) {
      if (inRange(raw.windowSegments, 2, 120) && Number.isInteger(raw.windowSegments))
        options.windowSegments = raw.windowSegments;
      else errors.push('live.windowSegments must be an integer from 2 to 120');
    }
    if (raw.presentationDelaySec !== undefined) {
      if (inRange(raw.presentationDelaySec, 0, 120)) options.presentationDelaySec = raw.presentationDelaySec;
      else errors.push('live.presentationDelaySec must be a number from 0 to 120');
    }
  }
  return {
    startOffsetSec: options.startOffsetSec ?? LIVE_DEFAULTS.startOffsetSec,
    windowSegments: options.windowSegments ?? LIVE_DEFAULTS.windowSegments,
    presentationDelaySec: options.presentationDelaySec ?? LIVE_DEFAULTS.presentationDelaySec,
  };
}

/** Validates a `POST /api/sessions` body against the streams that are ready. */
export function parseSessionRequest(raw: unknown, streams: readonly StreamInfo[]): ParseResult {
  if (!isRecord(raw)) return { ok: false, status: 400, errors: ['the body must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!['stream', 'protocol', 'label', 'ttlSec', 'faults', 'live'].includes(key))
      errors.push(`${key} is not a known session field`);
  }
  if (typeof raw.stream !== 'string' || !(STREAM_IDS as readonly string[]).includes(raw.stream))
    return { ok: false, status: 400, errors: [`stream must be one of ${STREAM_IDS.join(', ')}`] };
  const stream = streams.find((candidate) => candidate.id === raw.stream);
  if (!stream)
    return {
      ok: false,
      status: 404,
      errors: [`stream ${raw.stream} is not available (run npm run generate:streams)`],
    };

  let protocol: Protocol = 'dash';
  if (raw.protocol !== undefined) {
    if (raw.protocol === 'dash' || raw.protocol === 'hls') protocol = raw.protocol;
    else errors.push('protocol must be dash or hls');
  }
  if (!stream.protocols.includes(protocol)) errors.push(`${stream.id} is not served over ${protocol}`);

  let label: string | undefined;
  if (raw.label !== undefined) {
    if (typeof raw.label === 'string' && raw.label.length <= MAX_LABEL_LENGTH) label = raw.label;
    else errors.push(`label must be a string of at most ${MAX_LABEL_LENGTH} characters`);
  }
  let ttlSec = SESSION_DEFAULT_TTL_SEC;
  if (raw.ttlSec !== undefined) {
    if (inRange(raw.ttlSec, 1, SESSION_MAX_TTL_SEC)) ttlSec = raw.ttlSec;
    else errors.push(`ttlSec must be a number from 1 to ${SESSION_MAX_TTL_SEC}`);
  }

  let faults: FaultRule[] = [];
  if (raw.faults !== undefined) {
    const result = validateFaultRules(raw.faults, { live: stream.kind === 'live' });
    if (result.ok) faults = result.rules;
    else errors.push(...result.errors.map((error) => error.replace(/^rules/, 'faults')));
  }

  let live: ParsedSessionRequest['live'];
  if (stream.kind === 'live') live = parseLive(raw.live, stream.segmentDurationSec, errors);
  else if (raw.live !== undefined) errors.push(`live options need a live stream, ${stream.id} is VOD`);

  if (errors.length > 0) return { ok: false, status: 400, errors };
  return {
    ok: true,
    value: {
      stream,
      protocol,
      ...(label === undefined ? {} : { label }),
      ttlSec,
      faults,
      ...(live ? { live } : {}),
    },
  };
}

export class Session {
  readonly id: string;
  readonly stream: StreamInfo;
  readonly protocol: Protocol;
  readonly label: string | undefined;
  readonly createdAtMs: number;
  readonly ttlSec: number;
  readonly liveParams: LiveParams | undefined;
  readonly faults: FaultEngine;
  readonly log = new RequestLog();
  readonly counters = { requests: 0, bytes: 0, errors: 0, byKind: {} as Record<string, number> };
  /** Objects the HTTP layer attaches to the session, such as the token bucket of each throttle rule. They live and die with it. */
  readonly attachments = new Map<string, unknown>();
  private readonly manifestBodies = new Map<string, string>();

  constructor(id: string, parsed: ParsedSessionRequest, clock: Clock) {
    this.id = id;
    this.stream = parsed.stream;
    this.protocol = parsed.protocol;
    this.label = parsed.label;
    this.createdAtMs = clock.now();
    this.ttlSec = parsed.ttlSec;
    this.liveParams = parsed.live
      ? {
          availabilityStartMs: this.createdAtMs - parsed.live.startOffsetSec * 1000,
          segmentDurationMs: parsed.stream.segmentDurationSec * 1000,
          windowSegments: parsed.live.windowSegments,
          presentationDelaySec: parsed.live.presentationDelaySec,
        }
      : undefined;
    this.faults = new FaultEngine({ sessionId: id, live: parsed.stream.kind === 'live', clock });
  }

  get expiresAtMs(): number {
    return this.createdAtMs + this.ttlSec * 1000;
  }

  /** What the live origin publishes at `nowMs`; undefined for VOD. */
  liveView(nowMs: number): LiveView | undefined {
    return this.liveParams ? liveView(this.liveParams, this.faults.liveStalls(), nowMs) : undefined;
  }

  /**
   * The body to serve for a manifest or playlist request. While a `manifest-stale` rule is active for it, the body recorded when no such
   * rule was active is replayed; a URL that was never served has nothing to replay, so its fresh body is served and becomes the replay.
   * Otherwise the fresh body is built and recorded.
   */
  manifestBody(url: string, plan: Pick<FaultPlan, 'staleManifest'>, build: () => string): string {
    if (plan.staleManifest) {
      const recorded = this.manifestBodies.get(url);
      if (recorded !== undefined) return recorded;
    }
    const fresh = build();
    this.manifestBodies.set(url, fresh);
    return fresh;
  }

  /** Counts a finished (or aborted) response. */
  recordCompletion(entry: Pick<RequestLogEntry, 'kind' | 'bytes' | 'status' | 'aborted'>): void {
    this.counters.requests++;
    this.counters.bytes += entry.bytes;
    if (entry.status >= 400 || entry.aborted) this.counters.errors++;
    this.counters.byKind[entry.kind] = (this.counters.byKind[entry.kind] ?? 0) + 1;
  }

  info(nowMs: number): SessionInfo {
    const view = this.liveView(nowMs);
    const live: LiveClockInfo | undefined =
      this.liveParams && view
        ? {
            segmentDurationSec: this.liveParams.segmentDurationMs / 1000,
            availabilityStartTime: new Date(this.liveParams.availabilityStartMs).toISOString(),
            windowSegments: this.liveParams.windowSegments,
            presentationDelaySec: this.liveParams.presentationDelaySec,
            edgeNumber: view.edge,
            stalled: view.stalled,
          }
        : undefined;
    return {
      id: this.id,
      stream: this.stream.id,
      protocol: this.protocol,
      ...(this.label === undefined ? {} : { label: this.label }),
      createdAt: new Date(this.createdAtMs).toISOString(),
      ttlSec: this.ttlSec,
      manifestUrl: manifestPath(this.id, this.stream.id, this.protocol),
      ...(live ? { live } : {}),
    };
  }

  detail(nowMs: number): SessionDetail {
    return {
      ...this.info(nowMs),
      faults: this.faults.rules(),
      counters: { ...this.counters, byKind: { ...this.counters.byKind } },
    };
  }
}

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`the service already holds ${limit} sessions: delete the ones a test no longer needs`);
    this.name = 'SessionLimitError';
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly clock: Clock;
  private readonly limit: number;
  private readonly newId: () => string;

  constructor(options: { clock: Clock; limit?: number; newId?: () => string }) {
    this.clock = options.clock;
    this.limit = options.limit ?? SESSION_LIMIT;
    this.newId = options.newId ?? (() => randomBytes(6).toString('hex'));
  }

  /** Throws SessionLimitError when the store is full of live sessions. Expired sessions are collected first. */
  create(parsed: ParsedSessionRequest): Session {
    if (this.sessions.size >= this.limit) this.sweep();
    if (this.sessions.size >= this.limit) throw new SessionLimitError(this.limit);
    let id = this.newId();
    while (this.sessions.has(id)) id = this.newId();
    const session = new Session(id, parsed, this.clock);
    const added = session.faults.add(parsed.faults);
    if (!added.ok) throw new Error(`invalid fault rules reached the store: ${added.errors.join('; ')}`);
    this.sessions.set(id, session);
    return session;
  }

  /** The session, or undefined when it is unknown or has expired (an expired session is removed on this lookup). */
  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.clock.now() >= session.expiresAtMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Removes the expired sessions; returns how many. No timer calls this: the store collects when asked and when it is full. */
  sweep(): number {
    const now = this.clock.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now >= session.expiresAtMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
