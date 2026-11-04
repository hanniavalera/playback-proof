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
  /** Shaka error code, e.g. 1001 (BAD_HTTP_STATUS), 1002 (HTTP_ERROR), 1003 (TIMEOUT), 4032 (REQUESTED_ITEM_NOT_SUPPORTED), 3016 (MEDIA_SOURCE_OPERATION_THREW). 0 = an error of the page itself (unhandled exception or rejection, unusable page parameter, rejected play()), not of Shaka. */
  code: number;
  category: number;
  /** 1 = recoverable, 2 = critical (Shaka severity). Errors of the page itself (code 0) are 1: they never put the player in the `error` state on their own. */
  severity: number;
  message: string;
  /** A short, serialisable digest of Shaka's error data (URIs and status codes), for failure triage. */
  data?: unknown[];
  /** The name of `code` in Shaka's enum, e.g. 'BAD_HTTP_STATUS'. */
  codeName?: string;
  /** Where the error was caught: 'shaka' (error event), 'load' (player.load() rejected), 'play' (play() rejected), 'window.onerror', 'unhandledrejection', 'params'. */
  source?: string;
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
    /**
     * Stalls (Shaka `buffering` episodes) that started after the first frame and outside a viewer's seek window
     * (docs/METRICS.md). A stall that has not ended yet counts, with the duration so far, and is flagged `ongoing`.
     */
    count: number;
    totalMs: number;
    /** totalMs / (totalMs + time spent playing) since the first frame. 0 when both are 0 (nothing played, nothing stalled). */
    ratio: number;
    /** `startMs` is the page clock (performance.now()) at the `buffering-start` event, so it can be found in the timeline. */
    events: Array<{ startMs: number; durationMs: number; mediaTime: number; ongoing: boolean }>;
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
    /**
     * Distance of the playhead behind the live edge, ms: the end of the newest segment the origin has published, minus
     * the playhead. A healthy stream reads about `presentationDelayMs`. null for VOD. (docs/METRICS.md explains why this
     * is not `seekRange().end - currentTime`.)
     */
    latencyMs: number | null;
    /** The largest latency seen since the first frame. */
    latencyMaxMs: number | null;
    /** The presentation delay Shaka holds the playhead behind the live edge (the manifest's suggestedPresentationDelay): the latency a healthy stream settles at. null for VOD. */
    presentationDelayMs: number | null;
    /** Times the player jumped to the live edge by itself since the last load. */
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
  /** Extra filter, evaluated in the page (so it must be a function of the QAEvent only). Not available from a Playwright spec: a function cannot cross the page boundary and the page's CSP forbids `eval`; use `detail`. */
  predicate?: (event: QAEvent) => boolean;
  /**
   * Declarative filter that does cross the page boundary: only an event whose `detail` has every one of these keys with a strictly
   * equal value matches, for example `{ reason: 'abr', height: 720 }`. Values are strings, numbers, booleans or null; anything else
   * rejects the wait at once. Combined with `predicate` (both must hold).
   */
  detail?: Record<string, string | number | boolean | null>;
}

export interface QAInfo {
  shakaVersion: string;
  userAgent: string;
  /** 'A' | 'B' (see src/player/configs.ts) */
  config: string;
  /** The exact object the page handed to player.configure() at boot: the preset's overrides (empty for A) plus `abr: { enabled: false }` when abr=0. */
  configOverrides: Record<string, unknown>;
  /** What Shaka's own defaults held at each key of `configOverrides`, read from the player before the overrides were applied. */
  configDefaults: Record<string, unknown>;
  /** The qa.configure() and qa.setAbr() calls made since boot, in order. */
  configured: Array<Record<string, unknown>>;
  manifestUri: string | null;
  /** shaka.Player.isBrowserSupported() */
  supported: boolean;
  /**
   * player.getLoadMode(): 'media-source' (Shaka's MSE path) or 'src=' (the element's own pipeline, e.g. native HLS).
   * null until a load has completed. The lab plays everything through MSE, and its smoke checks assert 'media-source'.
   */
  loadMode: 'media-source' | 'src=' | null;
  /** The page parameters as applied, after defaults. */
  params: {
    config: 'A' | 'B';
    autoplay: boolean;
    muted: boolean;
    start: number | null;
    abr: boolean;
    hud: boolean;
  };
  /** Page parameters that could not be used (each is also recorded as an error event with code 0). */
  paramProblems: string[];
}

export interface FrameMeasurement {
  /** Frames presented while the media clock advanced (requestVideoFrameCallback). null where that API is missing. */
  presented: number | null;
  dropped: number;
  decoded: number;
  /** The media time that really elapsed in the window, from the frame callbacks' own media times (not the requested value). */
  mediaSeconds: number;
  /** presented / mediaSeconds, null when presented is unknown or no media time elapsed. */
  fps: number | null;
}

export interface QAHook {
  readonly version: 1;
  /** Resolves when the page has booted the player (and, if autoplay=0, is idle and waiting for load()). */
  readonly ready: Promise<void>;
  cursor(): number;
  events(): QAEvent[];
  metrics(): QAMetrics;
  info(): QAInfo;
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
  /** Pins the video variant whose height matches (ABR off). null re-enables ABR. Resolves when the variant-changed event is recorded. */
  selectVariantByHeight(height: number | null): Promise<void>;
  setAbr(enabled: boolean): void;
  /** Shaka player.configure() passthrough for experiments. Throws when Shaka rejects the object (a misspelt key must not pass silently). */
  configure(partial: Record<string, unknown>): void;
  /**
   * Counts the frames presented and dropped while the media clock advances by `mediaSeconds` (event-driven: it uses
   * requestVideoFrameCallback, not a timer). Effective fps = presented / the media time that elapsed. Rejects, with the
   * timeline, when no frame arrives for `stallTimeoutMs` (default 5000: a stall during the window is reported, never hidden)
   * or when the media clock jumps (a seek inside the window would make the number meaningless).
   */
  measureFrames(mediaSeconds: number, options?: { stallTimeoutMs?: number }): Promise<FrameMeasurement>;
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
  /** Start playing as soon as the page has loaded the manifest of its `manifest` parameter. Default true. A load started with qa.load() never starts playback by itself: call qa.play(). */
  autoplay?: boolean;
  /** Default true: muted media may autoplay in every engine without a user gesture. */
  muted?: boolean;
  /** Start position in seconds (Shaka startTime). */
  start?: number;
  /** Default true. false disables ABR (the first variant is pinned by selectVariantByHeight). */
  abr?: boolean;
  /** Default false. true shows a small overlay (state, startup, rebuffers, rung, live latency); off by default so the page under test carries no extra work. */
  hud?: boolean;
}
