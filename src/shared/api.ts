import type { FaultRule, FaultRuleWithId } from './faults.ts';
import type { Protocol, StreamId, StreamInfo } from './streams.ts';

// HTTP control API of the test data service. Everything below is JSON over HTTP. See docs/CONTRACTS.md for the full tables.

export interface LiveOptions {
  /** The stream has been "on air" this many seconds when the session is created (so a DVR window exists immediately). Default 30. */
  startOffsetSec?: number;
  /** DVR depth in segments (DASH timeShiftBufferDepth / HLS playlist length). Default 15. */
  windowSegments?: number;
  /** DASH suggestedPresentationDelay in seconds. Default 6 (three 2 s segments). */
  presentationDelaySec?: number;
}

export interface SessionRequest {
  stream: StreamId;
  /** Default 'dash'. 'hls' is rejected for streams that do not list it (vod-webm). */
  protocol?: Protocol;
  /** Free text, normally the test id; it appears in logs. */
  label?: string;
  /** Session lifetime in seconds (garbage collected afterwards). Default 900. */
  ttlSec?: number;
  faults?: FaultRule[];
  live?: LiveOptions;
}

export interface LiveClockInfo {
  segmentDurationSec: number;
  /** ISO 8601. The wall-clock instant of live segment 0's start (DASH availabilityStartTime). */
  availabilityStartTime: string;
  windowSegments: number;
  presentationDelaySec: number;
  /** Highest segment number published at the moment of the response. */
  edgeNumber: number;
  /** Currently inside a live-stall rule. */
  stalled: boolean;
}

export interface SessionInfo {
  id: string;
  stream: StreamId;
  protocol: Protocol;
  label?: string;
  /** ISO 8601 */
  createdAt: string;
  ttlSec: number;
  /** Absolute path on the service, e.g. /s/<id>/vod-cmaf/dash/manifest.mpd. Resolve against the service origin. */
  manifestUrl: string;
  live?: LiveClockInfo;
}

export interface SessionDetail extends SessionInfo {
  faults: FaultRuleWithId[];
  /** `errors` counts every answer with a status of 400 or more and every aborted response, a client's hang-up included (`RequestLogEntry.abortReason` tells them apart). */
  counters: { requests: number; bytes: number; errors: number; byKind: Record<string, number> };
}

export interface RequestLogEntry {
  /** Monotonic per session, starting at 1. Use ?since=<seq> to read only new entries. */
  seq: number;
  /** ISO 8601 time the request arrived. */
  t: string;
  /** ms since the session was created. */
  msSinceStart: number;
  method: string;
  path: string;
  kind: 'manifest' | 'init' | 'segment' | 'other';
  rep?: string;
  number?: number;
  status: number;
  bytes: number;
  /** ms from arrival to the first response byte */
  ttfbMs: number;
  /** ms from arrival to the end of the response (or the abort) */
  totalMs: number;
  /** ids of the fault rules that fired for this request */
  faults: string[];
  /** true when the response did not reach the client whole: see `abortReason` for who ended it. A client that hangs up after receiving every byte is not an abort. */
  aborted?: boolean;
  /**
   * Who ended the response early; set whenever `aborted` is true, absent otherwise.
   * - `client-closed`: the client hung up before it had received every byte (a player that cancels an in-flight request when it seeks or switches rung does this; it is not an origin failure).
   * - `fault-abort`: an `abort` fault cut the connection (the origin did).
   * - `error`: the service could not write the response (a bug of the service, never expected).
   */
  abortReason?: 'client-closed' | 'fault-abort' | 'error';
  /** true while the response is still being written: status, bytes, ttfbMs and totalMs are then the values so far (status 0 until the head is sent). */
  pending?: boolean;
}

export interface HealthInfo {
  status: 'ok';
  version: string;
  ffmpeg: string;
  streams: Record<StreamId, 'ready' | 'missing'>;
  player: 'built' | 'missing';
  uptimeSec: number;
}

export type CatalogResponse = { streams: StreamInfo[] };
