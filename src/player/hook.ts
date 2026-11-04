import type {
  FrameMeasurement,
  QAEvent,
  QAEventName,
  QAHook,
  QAInfo,
  QAMetrics,
  QAWaitOptions,
  VariantInfo,
} from '../shared/qa.ts';
import { valuesAtShape } from './configs.ts';
import type { ShakaConfigPatch } from './configs.ts';
import { digestShakaError } from './errors.ts';
import type { ErrorDigest, ErrorNames } from './errors.ts';
import {
  FrameWindow,
  LatencyTracker,
  PresentedCounter,
  bufferedAheadSec,
  computeMetrics,
  isLiveEdgeCatchUp,
  liveLatencyMs,
} from './metrics.ts';
import type { FrameSample, TimeRangesLike } from './metrics.ts';
import type { ResolvedPlayerParams } from './params.ts';
import { REAL_TIMERS, Timeline } from './timeline.ts';
import type { Timers } from './timeline.ts';

// `window.__qa`: a thin, event-driven shell between the page and the lab. It records what the media element and Shaka
// report into the Timeline, answers `metrics()` by handing the timeline to the pure functions of metrics.ts, and turns each
// action into "do it, then wait for the event that proves it happened". It owns no DOM and imports no Shaka: the page
// (main.ts) hands it the element and the player, and the unit tests hand it fakes.

export interface FrameMetadataLike {
  mediaTime: number;
  presentedFrames?: number;
}

/** The parts of HTMLVideoElement the hook uses. */
export interface VideoLike extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly playbackRate: number;
  readonly buffered: TimeRangesLike;
  play(): Promise<void>;
  pause(): void;
  getVideoPlaybackQuality?(): { totalVideoFrames: number; droppedVideoFrames: number };
  requestVideoFrameCallback?(callback: (now: number, metadata: FrameMetadataLike) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export interface TrackLike {
  id: number;
  active: boolean;
  bandwidth: number;
  width: number | null;
  height: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
}

/** The parts of shaka.Player the hook uses. */
export interface PlayerLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  load(uri: string, startTime?: number | null): Promise<unknown>;
  unload(): Promise<unknown>;
  destroy(): Promise<unknown>;
  configure(config: object): boolean;
  getConfiguration(): object;
  getVariantTracks(): TrackLike[];
  selectVariantTrack(track: TrackLike, clearBuffer?: boolean, safeMargin?: number): void;
  isLive(): boolean;
  seekRange(): { start: number; end: number };
  getLoadMode(): number;
  goToLive?(): void;
  getManifest?(): {
    presentationTimeline?: { getSegmentAvailabilityEnd(): number; getDelay(): number };
  } | null;
}

export interface PlayerEnvironment {
  player: PlayerLike;
  shakaVersion: string;
  /** shaka.Player.isBrowserSupported() */
  supported: boolean;
  errorNames: ErrorNames;
  /** shaka.Player.LoadMode */
  loadModes: { notLoaded: number; mediaSource: number; srcEquals: number };
}

export interface HookOptions {
  video: VideoLike;
  /** `performance.now()` */
  now: () => number;
  params: ResolvedPlayerParams;
  paramProblems?: string[];
  userAgent: string;
  timers?: Timers;
  onListenerError?: (error: unknown) => void;
}

export const DEFAULT_FRAME_STALL_TIMEOUT_MS = 5000;

type ErrorSource = 'shaka' | 'load' | 'play' | 'boot' | 'params' | 'window.onerror' | 'unhandledrejection';

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class PlayerHook implements QAHook {
  readonly version = 1 as const;
  readonly ready: Promise<void>;

  private readonly video: VideoLike;
  private readonly now: () => number;
  private readonly timers: Timers | undefined;
  private readonly params: ResolvedPlayerParams;
  private readonly paramProblems: string[];
  private readonly userAgent: string;
  private readonly timeline: Timeline;
  private readonly latency = new LatencyTracker();
  private readonly presented = new PresentedCounter();
  private readonly configured: Array<Record<string, unknown>> = [];
  private readonly reportedErrors = new WeakSet<object>();
  private readonly disposers: Array<() => void> = [];
  private resolveReady: () => void = () => {};
  private rejectReady: (error: unknown) => void = () => {};
  private env: PlayerEnvironment | null = null;
  private configOverrides: Record<string, unknown> = {};
  private configDefaults: Record<string, unknown> = {};
  private manifestUri: string | null = null;
  private loadActive = false;
  private manifestSeen = false;
  private firstFrameSeen = false;
  private hasPlayed = false;
  private lastVariantId: number | null = null;
  private lastObservedTime: number | null = null;
  private viewerSeeks = 0;
  private frameHandle: number | null = null;
  private destroyed = false;

  constructor(options: HookOptions) {
    this.video = options.video;
    this.now = options.now;
    this.timers = options.timers;
    this.params = options.params;
    this.paramProblems = [...(options.paramProblems ?? [])];
    this.userAgent = options.userAgent;
    this.timeline = new Timeline({
      now: options.now,
      mediaTime: () => this.video.currentTime,
      ...(options.timers ? { timers: options.timers } : {}),
      ...(options.onListenerError ? { onListenerError: options.onListenerError } : {}),
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A rejected `ready` is reported by the test that awaits it and recorded as an error event; it must not also surface as unhandled.
    this.ready.catch(() => {});

    for (const problem of this.paramProblems) this.recordError('params', problem);

    // The element's listeners go first, before Shaka exists: listeners of one target run in registration order, so an
    // element event is recorded before the Shaka events it causes (a `seeking` before the `buffering` it starts). The seek
    // window of the metrics depends on it.
    this.listenVideo('playing', this.onPlaying);
    this.listenVideo('pause', () => this.timeline.record('paused'));
    this.listenVideo('ended', () => this.timeline.record('ended'));
    this.listenVideo('seeking', this.onSeeking);
    this.listenVideo('seeked', () =>
      this.timeline.record('seeked', { readyState: this.video.readyState, paused: this.video.paused }),
    );
    this.listenVideo('timeupdate', this.onTimeUpdate);
  }

  // ------------------------------------------------------------------------------------------------------ boot

  /** Builds the player (the factory), applies the configuration and starts listening to it. Resolves `ready`. */
  async boot(
    createEnvironment: () => Promise<PlayerEnvironment>,
    bootPatch: ShakaConfigPatch,
  ): Promise<void> {
    try {
      const env = await createEnvironment();
      this.env = env;
      this.configDefaults = valuesAtShape(env.player.getConfiguration(), bootPatch);
      if (Object.keys(bootPatch).length > 0 && !env.player.configure(bootPatch)) {
        throw new Error(`Shaka rejected the boot configuration ${JSON.stringify(bootPatch)}`);
      }
      this.configOverrides = structuredClone(bootPatch) as Record<string, unknown>;
      this.listenPlayer(env.player);
      this.resolveReady();
    } catch (error) {
      this.recordError('boot', error, 2);
      this.rejectReady(error);
    }
  }

  private listenVideo(type: string, handler: () => void): void {
    this.video.addEventListener(type, handler);
    this.disposers.push(() => this.video.removeEventListener(type, handler));
  }

  private listenPlayer(player: PlayerLike): void {
    // Shaka's events carry their payload as properties of the event (`buffering`, `detail`): each handler says which.
    const on = <T>(type: string, handler: (event: T) => void): void => {
      const listener = handler as unknown as (event: Event) => void;
      player.addEventListener(type, listener);
      this.disposers.push(() => player.removeEventListener(type, listener));
    };
    on('manifestparsed', () => {
      if (!this.manifestSeen) this.timeline.record('manifest-loaded');
      this.manifestSeen = true;
    });
    on('buffering', (event: { buffering: boolean }) =>
      this.timeline.record(event.buffering ? 'buffering-start' : 'buffering-end'),
    );
    on('adaptation', () => this.syncVariant('abr'));
    on('variantchanged', () => this.syncVariant('manual'));
    on('error', (event: { detail: unknown }) => this.recordShakaError(event.detail, 'shaka'));
    // Shaka resets the MediaSource after some media errors and then raises no error event at all: the recovery is the only trace.
    on('mediasourcerecovered', () =>
      this.timeline.record('error', {
        code: 0,
        codeName: 'MEDIA_SOURCE_RECOVERED',
        category: 0,
        severity: 1,
        message: 'Shaka reset the MediaSource to recover from a media error that it did not report',
        source: 'shaka',
      }),
    );
  }

  // --------------------------------------------------------------------------------------- element events

  private readonly onPlaying = (): void => {
    this.hasPlayed = true;
    this.timeline.record('playing');
    // Without requestVideoFrameCallback the first `playing` of the load is the best available first-frame signal.
    if (this.loadActive && !this.firstFrameSeen && !this.video.requestVideoFrameCallback) {
      this.recordFirstFrame('playing');
    }
  };

  private readonly onSeeking = (): void => {
    const to = this.video.currentTime;
    const from = this.lastObservedTime;
    const requested = this.viewerSeeks > 0;
    if (requested) this.viewerSeeks -= 1;
    this.timeline.record('seeking', { from, to, requested });
    if (
      isLiveEdgeCatchUp({
        isLive: this.isLive(),
        firstFrameSeen: this.firstFrameSeen,
        requestedByViewer: requested,
        fromTime: from,
        toTime: to,
        seekRangeEnd: this.seekRangeEnd(),
      })
    ) {
      this.timeline.record('live-edge-seek', { from, to, jumpSec: from === null ? null : to - from });
    }
  };

  private readonly onTimeUpdate = (): void => {
    const time = this.video.currentTime;
    // While a seek is in progress `currentTime` is already the target: the position before the seek is what a jump is measured from.
    if (!this.video.seeking) this.lastObservedTime = time;
    this.timeline.notifyMediaTime(time);
    this.sampleLatency();
  };

  // ----------------------------------------------------------------------------------------- frame callback

  private armFrameCallback(): void {
    this.cancelFrameCallback();
    const request = this.video.requestVideoFrameCallback;
    if (!request) return;
    this.frameHandle = request.call(this.video, (_now, metadata) => this.onFrame(metadata));
  }

  private cancelFrameCallback(): void {
    if (this.frameHandle !== null) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.frameHandle = null;
  }

  private onFrame(metadata: FrameMetadataLike): void {
    this.frameHandle = null;
    if (!this.loadActive) return;
    this.presented.observe(metadata);
    if (!this.firstFrameSeen) this.recordFirstFrame('requestVideoFrameCallback');
    this.timeline.notifyMediaTime(metadata.mediaTime);
    this.armFrameCallback();
  }

  private recordFirstFrame(source: string): void {
    this.firstFrameSeen = true;
    this.latency.arm();
    this.timeline.record('firstframe', { source });
    this.sampleLatency();
  }

  // ------------------------------------------------------------------------------------------------ errors

  private recordError(source: ErrorSource, error: unknown, severity = 1): void {
    this.timeline.record('error', { code: 0, category: 0, severity, message: describeThrown(error), source });
  }

  /** The page's own failures: `window.onerror` and unhandled rejections are wired here by main.ts. */
  recordPageError(source: 'window.onerror' | 'unhandledrejection', error: unknown): void {
    this.recordError(source, error);
  }

  private recordShakaError(error: unknown, source: 'shaka' | 'load'): ErrorDigest {
    const digest = digestShakaError(error, this.env?.errorNames);
    // `player.load()` rejects with an error that Shaka may also have dispatched: one event per error object.
    if (typeof error === 'object' && error !== null) {
      if (this.reportedErrors.has(error)) return digest;
      this.reportedErrors.add(error);
    }
    this.timeline.record('error', { ...digest, source });
    return digest;
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private async environment(): Promise<PlayerEnvironment> {
    await this.ready;
    if (this.destroyed) throw new Error('the player page was destroyed');
    return this.env as PlayerEnvironment;
  }

  private isLive(): boolean {
    return this.env?.player.isLive() ?? false;
  }

  private seekRangeEnd(): number | null {
    const player = this.env?.player;
    if (!player || !player.isLive()) return null;
    const end = player.seekRange().end;
    return Number.isFinite(end) ? end : null;
  }

  private liveEdge(): { availabilityEnd: number; delayMs: number } | null {
    const player = this.env?.player;
    if (!player || !player.isLive()) return null;
    const timeline = player.getManifest?.()?.presentationTimeline;
    if (!timeline) return null;
    const availabilityEnd = timeline.getSegmentAvailabilityEnd();
    return Number.isFinite(availabilityEnd) ? { availabilityEnd, delayMs: timeline.getDelay() * 1000 } : null;
  }

  private sampleLatency(): void {
    const edge = this.liveEdge();
    this.latency.sample(edge ? liveLatencyMs(edge.availabilityEnd, this.video.currentTime) : null);
  }

  private activeTrack(): TrackLike | null {
    return this.env?.player.getVariantTracks().find((track) => track.active) ?? null;
  }

  private variantInfo(track: TrackLike | null): VariantInfo | null {
    if (!track) return null;
    return {
      id: track.id,
      bandwidth: track.bandwidth,
      width: track.width ?? null,
      height: track.height ?? null,
      videoCodec: track.videoCodec ?? null,
      audioCodec: track.audioCodec ?? null,
    };
  }

  /** Records `variant-changed` when the active variant is not the one last recorded. The first one of a load is `start`. */
  private syncVariant(hint: 'abr' | 'manual'): void {
    const active = this.activeTrack();
    if (!active || active.id === this.lastVariantId) return;
    const reason = this.lastVariantId === null ? 'start' : hint;
    this.timeline.record('variant-changed', {
      from: this.lastVariantId,
      to: active.id,
      bandwidth: active.bandwidth,
      height: active.height,
      reason,
    });
    this.lastVariantId = active.id;
  }

  private beginLoad(uri: string): void {
    this.manifestUri = uri;
    this.loadActive = true;
    this.manifestSeen = false;
    this.firstFrameSeen = false;
    this.hasPlayed = false;
    this.lastVariantId = null;
    this.lastObservedTime = null;
    this.latency.reset();
    this.presented.reset();
  }

  private describeVideo(): string {
    const v = this.video;
    return `currentTime ${v.currentTime.toFixed(3)} s, paused ${v.paused}, ended ${v.ended}, readyState ${v.readyState}`;
  }

  private quality(): { decoded: number; dropped: number } {
    const q = this.video.getVideoPlaybackQuality?.();
    return { decoded: q?.totalVideoFrames ?? 0, dropped: q?.droppedVideoFrames ?? 0 };
  }

  private loadMode(): QAInfo['loadMode'] {
    const env = this.env;
    if (!env) return null;
    const mode = env.player.getLoadMode();
    if (mode === env.loadModes.mediaSource) return 'media-source';
    if (mode === env.loadModes.srcEquals) return 'src=';
    return null;
  }

  private applyConfigure(patch: Record<string, unknown>): void {
    const player = this.env?.player;
    if (!player) throw new Error('qa.configure(): the player is not ready (await qa.ready)');
    if (!player.configure(patch)) {
      throw new Error(
        `qa.configure() was rejected by Shaka (an unknown key, or a value of the wrong type; the browser console has the details): ${JSON.stringify(patch)}`,
      );
    }
    this.configured.push(structuredClone(patch));
  }

  // -------------------------------------------------------------------------------------------- the QAHook

  cursor(): number {
    return this.timeline.cursor();
  }

  events(): QAEvent[] {
    return this.timeline.events();
  }

  /** The page's own listeners (the HUD). Not part of the contract the tests use. */
  subscribe(listener: (event: QAEvent) => void): () => void {
    return this.timeline.subscribe(listener);
  }

  waitFor(name: QAEventName, options?: QAWaitOptions): Promise<QAEvent> {
    return this.timeline.waitFor(name, options);
  }

  waitForMediaTime(seconds: number, options?: { timeoutMs?: number }): Promise<number> {
    return this.timeline.waitForMediaTime(seconds, options);
  }

  info(): QAInfo {
    return {
      shakaVersion: this.env?.shakaVersion ?? '',
      userAgent: this.userAgent,
      config: this.params.config,
      configOverrides: structuredClone(this.configOverrides),
      configDefaults: structuredClone(this.configDefaults),
      configured: structuredClone(this.configured),
      manifestUri: this.manifestUri,
      supported: this.env?.supported ?? false,
      loadMode: this.loadMode(),
      params: {
        config: this.params.config,
        autoplay: this.params.autoplay,
        muted: this.params.muted,
        start: this.params.start,
        abr: this.params.abr,
        hud: this.params.hud,
      },
      paramProblems: [...this.paramProblems],
    };
  }

  metrics(): QAMetrics {
    this.sampleLatency();
    const video = this.video;
    const edge = this.liveEdge();
    const quality = this.quality();
    return computeMetrics({
      events: this.timeline.events(),
      now: this.now(),
      playback: {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        ended: video.ended,
        playbackRate: video.playbackRate,
        bufferedAheadSec: bufferedAheadSec(video.buffered, video.currentTime),
        readyState: video.readyState,
      },
      frames: {
        decoded: quality.decoded,
        dropped: quality.dropped,
        presented: video.requestVideoFrameCallback ? this.presented.value : null,
      },
      variant: this.variantInfo(this.activeTrack()),
      live: {
        isLive: this.isLive(),
        latencyMs: this.latency.current,
        latencyMaxMs: this.latency.max,
        presentationDelayMs: edge ? edge.delayMs : null,
      },
    });
  }

  async load(manifestUri?: string): Promise<void> {
    const env = await this.environment();
    const uri = manifestUri ?? this.manifestUri ?? this.params.manifest;
    if (!uri) {
      throw new Error('qa.load(): no manifest URI. Pass one, or open the page with ?manifest=...');
    }
    if (!env.supported) {
      const error = new Error('qa.load(): shaka.Player.isBrowserSupported() is false in this browser');
      this.recordError('load', error, 2);
      throw error;
    }
    // Playing content must go before the new load starts: its frames would otherwise answer the first-frame callback of the next one.
    if (env.player.getLoadMode() !== env.loadModes.notLoaded) await this.unloadInternal();
    this.beginLoad(uri);
    this.timeline.record('load-requested', { uri });
    this.armFrameCallback();
    try {
      await env.player.load(uri, this.params.start);
    } catch (error) {
      this.loadActive = false;
      this.cancelFrameCallback();
      const digest = this.recordShakaError(error, 'load');
      const data = digest.data ? ` ${JSON.stringify(digest.data)}` : '';
      throw new Error(
        `qa.load(${JSON.stringify(uri)}) failed: ${digest.message} (code ${digest.code}, severity ${digest.severity})${data}\n${this.timeline.describeRecent()}`,
        { cause: error },
      );
    }
    this.timeline.record('loaded');
    // Shaka announces the initial rung with an adaptation event on some paths and not on others; make sure it is on record.
    this.syncVariant('abr');
  }

  async play(): Promise<void> {
    await this.environment();
    try {
      await this.video.play();
    } catch (error) {
      this.recordError('play', error);
      throw new Error(
        `qa.play() was rejected: ${describeThrown(error)}.\n${this.timeline.describeRecent()}`,
        {
          cause: error,
        },
      );
    }
  }

  async pause(): Promise<void> {
    await this.environment();
    if (this.video.paused) return;
    const cursor = this.timeline.cursor();
    this.video.pause();
    await this.timeline.waitFor('paused', { since: cursor });
  }

  async seek(seconds: number): Promise<void> {
    await this.environment();
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError(`qa.seek(): seconds must be a finite number >= 0, got ${String(seconds)}`);
    }
    await this.seekTo(() => {
      this.video.currentTime = seconds;
    }, `qa.seek(${seconds})`);
  }

  async seekToLiveEdge(): Promise<void> {
    const { player } = await this.environment();
    if (!player.isLive()) throw new Error('qa.seekToLiveEdge(): the loaded presentation is not live');
    await this.seekTo(() => {
      if (player.goToLive) player.goToLive();
      else this.video.currentTime = player.seekRange().end;
    }, 'qa.seekToLiveEdge()');
  }

  /** Starts a seek that the viewer asked for and resolves on its `seeked`, which must come after its own `seeking`. */
  private async seekTo(start: () => void, label: string): Promise<void> {
    if (this.video.readyState === 0) {
      throw new Error(`${label}: nothing is loaded (readyState 0).\n${this.timeline.describeRecent()}`);
    }
    const cursor = this.timeline.cursor();
    this.viewerSeeks += 1;
    try {
      start();
      const seeking = await this.timeline.waitFor('seeking', { since: cursor });
      await this.timeline.waitFor('seeked', { since: seeking.index });
    } finally {
      // The `seeking` event normally consumed the mark; if the browser fired none, it must not leak into a later seek.
      if (this.viewerSeeks > 0) this.viewerSeeks -= 1;
    }
  }

  async selectVariantByHeight(height: number | null): Promise<void> {
    const { player } = await this.environment();
    if (height === null) {
      this.setAbr(true);
      return;
    }
    const tracks = player.getVariantTracks();
    const matches = tracks.filter((track) => track.height === height);
    const target = matches.reduce<TrackLike | null>(
      (best, track) => (best === null || track.bandwidth > best.bandwidth ? track : best),
      null,
    );
    if (!target) {
      const heights =
        [...new Set(tracks.map((track) => track.height))].join(', ') || 'none (is a manifest loaded?)';
      throw new Error(
        `qa.selectVariantByHeight(${height}): no variant has that height. Heights available: ${heights}`,
      );
    }
    this.applyConfigure({ abr: { enabled: false } });
    if (target.active) return; // already on it: Shaka would announce nothing
    const cursor = this.timeline.cursor();
    // Before anything has played there is nothing worth keeping: flush, so that the pinned rung is what plays first.
    // Once playback has started the change is seamless: it applies to what is fetched next.
    player.selectVariantTrack(target, !this.hasPlayed, 0);
    await this.timeline.waitFor('variant-changed', {
      since: cursor,
      predicate: (event) => event.detail?.to === target.id,
    });
  }

  setAbr(enabled: boolean): void {
    this.applyConfigure({ abr: { enabled } });
  }

  configure(partial: Record<string, unknown>): void {
    this.applyConfigure(partial);
  }

  measureFrames(mediaSeconds: number, options: { stallTimeoutMs?: number } = {}): Promise<FrameMeasurement> {
    const stallMs = options.stallTimeoutMs ?? DEFAULT_FRAME_STALL_TIMEOUT_MS;
    const label = `qa.measureFrames(${String(mediaSeconds)})`;
    const request = this.video.requestVideoFrameCallback;
    let frames: FrameWindow;
    try {
      frames = new FrameWindow(mediaSeconds, request !== undefined);
      if (!Number.isFinite(stallMs) || stallMs <= 0)
        throw new RangeError(`stallTimeoutMs must be > 0, got ${stallMs}`);
    } catch (error) {
      return Promise.reject(error);
    }
    const timers = this.timers ?? REAL_TIMERS;

    return new Promise<FrameMeasurement>((resolve, reject) => {
      let finished = false;
      let baseline: { decoded: number; dropped: number } | null = null;
      let handle: number | null = null;
      let stallTimer: unknown;
      let stopListening: (() => void) | null = null;

      const finish = (outcome: { measurement: FrameMeasurement } | { error: Error }): void => {
        if (finished) return;
        finished = true;
        timers.clearTimeout(stallTimer);
        if (handle !== null) this.video.cancelVideoFrameCallback?.(handle);
        stopListening?.();
        if ('measurement' in outcome) resolve(outcome.measurement);
        else reject(outcome.error);
      };
      const armStall = (): void => {
        timers.clearTimeout(stallTimer);
        stallTimer = timers.setTimeout(() => {
          finish({
            error: new Error(
              `${label}: no video frame for ${stallMs} ms, so the media clock is not advancing (${this.describeVideo()}).\n${this.timeline.describeRecent()}`,
            ),
          });
        }, stallMs);
      };
      const sample = (frame: FrameSample): void => {
        if (finished) return;
        armStall();
        baseline ??= this.quality();
        let complete: boolean;
        try {
          complete = frames.push(frame);
        } catch (error) {
          finish({
            error: new Error(`${label}: ${describeThrown(error)}.\n${this.timeline.describeRecent()}`),
          });
          return;
        }
        if (!complete) return;
        const now = this.quality();
        finish({
          measurement: frames.result({
            decoded: now.decoded - baseline.decoded,
            dropped: now.dropped - baseline.dropped,
          }),
        });
      };

      if (request) {
        const onFrame = (_now: number, metadata: FrameMetadataLike): void => {
          handle = null;
          sample({
            mediaTime: metadata.mediaTime,
            ...(metadata.presentedFrames !== undefined ? { presentedFrames: metadata.presentedFrames } : {}),
          });
          if (!finished) handle = request.call(this.video, onFrame);
        };
        handle = request.call(this.video, onFrame);
      } else {
        const onTime = (): void => sample({ mediaTime: this.video.currentTime });
        this.video.addEventListener('timeupdate', onTime);
        stopListening = () => this.video.removeEventListener('timeupdate', onTime);
      }
      armStall();
    });
  }

  async unload(): Promise<void> {
    const env = await this.environment();
    if (env.player.getLoadMode() === env.loadModes.notLoaded) return;
    await this.unloadInternal();
  }

  private async unloadInternal(): Promise<void> {
    const env = this.env as PlayerEnvironment;
    this.cancelFrameCallback();
    this.loadActive = false;
    await env.player.unload();
    this.timeline.record('unloaded');
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    const env = await this.ready.then(
      () => this.env,
      () => null,
    );
    this.cancelFrameCallback();
    this.loadActive = false;
    if (env) {
      const wasLoaded = env.player.getLoadMode() !== env.loadModes.notLoaded;
      await env.player.destroy();
      if (wasLoaded) this.timeline.record('unloaded');
    }
    this.destroyed = true;
    this.timeline.close('destroyed');
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
