// The test hook contract: `window.__qa`, implemented by the player page (src/player) and consumed by Playwright specs,
// the performance harness, the A/B runner and the soak test. Metric definitions are in docs/METRICS.md: read them before
// changing anything here, a metric whose definition drifts silently invalidates every baseline.

export type QAEventName =
  | 'load-requested' // player.load() is about to be called (the startup clock starts here)
  | 'manifest-loaded' // Shaka finished parsing the manifest
  | 'loaded' // player.load() resolved
  | 'firstframe' // first video frame presented after load (requestVideoFrameCallback, or 'playing' where unavailable)
  | 'playing' // the media element fired 'playing' (after play, resume after a pause, or after buffering)
  | 'paused'
  | 'seeking'
  | 'seeked'
  | 'buffering-start' // Shaka 'buffering' event with buffering=true
  | 'buffering-end'
  | 'variant-changed' // the active video variant changed; detail has from/to/bandwidth/height/reason
  | 'error' // a Shaka error (detail has code/category/severity)
  | 'ended'
  | 'live-edge-seek' // the player jumped to the live edge on its own (catch-up)
  | 'unloaded';

export interface QAEvent {
  /** Position in the timeline, starting at 0. This is the "cursor" unit of qa.waitFor({ since }). */
  index: number;
  /** performance.now() in the page, milliseconds. */
  t: number;
  name: QAEventName;
  /** video.currentTime when the event was recorded. */
  mediaTime: number;
  detail?: Record<string, unknown>;
}

export type QAState =
  'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'seeking' | 'ended' | 'error';

export interface VariantInfo {
  id: number;
  /** Declared bandwidth in bits per second. */
  bandwidth: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

export interface QAError {
  /** performance.now() */
  t: number;
  /** Shaka error code, e.g. 1001 (BAD_HTTP_STATUS), 1002 (HTTP_ERROR), 1003 (TIMEOUT), 4032 (REQUESTED_ITEM_NOT_SUPPORTED), 3016 (MEDIA_SOURCE_OPERATION_THREW). */
  code: number;
  category: number;
  /** 1 = recoverable, 2 = critical (Shaka severity). */
  severity: number;
  message: string;
  /** A short, serialisable digest of Shaka's error data (URIs and status codes), for failure triage. */
  data?: unknown[];
}

export interface QAMetrics {
  state: QAState;
  /** ms from 'load-requested' to 'firstframe'. null until the first frame is presented. */
  startupMs: number | null;
  startup: {
    /** ms from 'load-requested' to 'manifest-loaded' */
    manifestMs: number | null;
    /** ms from 'load-requested' to 'loaded' */
    loadedMs: number | null;
  };
  rebuffer: {
    /** Stalls after the first frame, excluding stalls caused by the viewer's own seeks. */
    count: number;
    totalMs: number;
    /** totalMs / (totalMs + time spent playing) since the first frame. 0 when nothing played. */
    ratio: number;
    events: Array<{ startMs: number; durationMs: number; mediaTime: number }>;
  };
  frames: {
    decoded: number;
    dropped: number;
    /** dropped / decoded, 0 when nothing decoded. */
    droppedRatio: number;
    /** Frames presented, counted with requestVideoFrameCallback (null where the API is missing). */
    presented: number | null;
  };
  bitrate: {
    /** Number of changes of the active video variant after the initial selection. */
    switches: number;
    current: VariantInfo | null;
    history: Array<{
      t: number;
      from: number | null;
      to: number;
      height: number | null;
      reason: 'start' | 'abr' | 'manual';
    }>;
  };
  live: {
    isLive: boolean;
    /** Distance of the playhead behind the live edge, ms. null for VOD. */
    latencyMs: number | null;
    /** The largest latency seen since the first frame. */
    latencyMaxMs: number | null;
    /** Times the player jumped to the live edge by itself. */
    edgeSeeks: number;
  };
  errors: QAError[];
  playback: {
    currentTime: number;
    duration: number;
    paused: boolean;
    ended: boolean;
    playbackRate: number;
    /** Seconds of media buffered ahead of the playhead. */
    bufferedAheadSec: number;
    readyState: number;
  };
}

export interface QAWaitOptions {
  /** Reject after this long. Default 20000. A timeout is a test failure with the event timeline attached, never a pass. */
  timeoutMs?: number;
  /**
   * Only consider events with index >= since. Default 0 (the whole history), which makes `waitFor` race-free: an event
   * that already happened still resolves it. Take a cursor with qa.cursor() before an action to wait for NEW events only.
   */
  since?: number;
  /** Extra filter, evaluated in the page (so it must be a function of the QAEvent only). */
  predicate?: (event: QAEvent) => boolean;
}

export interface QAHook {
  readonly version: 1;
  /** Resolves when the page has booted the player (and, if autoplay=0, is idle and waiting for load()). */
  readonly ready: Promise<void>;
  cursor(): number;
  events(): QAEvent[];
  metrics(): QAMetrics;
  info(): {
    shakaVersion: string;
    userAgent: string;
    /** 'A' | 'B' (see src/player/configs.ts) */
    config: string;
    manifestUri: string | null;
    /** shaka.Player.isBrowserSupported() */
    supported: boolean;
  };
  /** Event-driven wait. Resolves with the matching event; rejects on timeout with the recent timeline in the message. */
  waitFor(name: QAEventName, options?: QAWaitOptions): Promise<QAEvent>;
  /** Resolves with the media time reached once video.currentTime >= seconds (driven by timeupdate / video frames, not by a timer). */
  waitForMediaTime(seconds: number, options?: { timeoutMs?: number }): Promise<number>;
  load(manifestUri?: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Resolves on 'seeked'. */
  seek(seconds: number): Promise<void>;
  seekToLiveEdge(): Promise<void>;
  /** Pins the video variant whose height matches (ABR off). null re-enables ABR. */
  selectVariantByHeight(height: number | null): Promise<void>;
  setAbr(enabled: boolean): void;
  /** Shaka player.configure() passthrough for experiments. */
  configure(partial: Record<string, unknown>): void;
  /**
   * Counts the frames presented and dropped while the media clock advances by `mediaSeconds` (event-driven: it uses
   * requestVideoFrameCallback / timeupdate, not a timer). Effective fps = presented / mediaSeconds.
   */
  measureFrames(
    mediaSeconds: number,
  ): Promise<{ presented: number; dropped: number; decoded: number; fps: number | null }>;
  unload(): Promise<void>;
  destroy(): Promise<void>;
}

declare global {
  interface Window {
    __qa: QAHook;
  }
}

/** Query parameters of the player page (/player/). */
export interface PlayerPageParams {
  /** Manifest URL (absolute path or URL). Without it the page boots idle (use qa.load). */
  manifest?: string;
  /** Player configuration preset. Default 'A'. */
  config?: 'A' | 'B';
  /** Start playing as soon as the manifest is loaded. Default true. */
  autoplay?: boolean;
  /** Default true: muted media may autoplay in every engine without a user gesture. */
  muted?: boolean;
  /** Start position in seconds (Shaka startTime). */
  start?: number;
  /** Default true. false disables ABR (the first variant is pinned by selectVariantByHeight). */
  abr?: boolean;
}
