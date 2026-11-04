import type { FrameMetadataLike, PlayerLike, TrackLike, VideoLike } from '../../../src/player/hook.ts';
import type { TimeRangesLike } from '../../../src/player/metrics.ts';

/**
 * A media element that does what the HTML spec says at the points the hook cares about: assigning `currentTime` starts a
 * seek whose `seeking` and `seeked` arrive as later tasks, `play()` resolves after `playing` has fired, `pause()` fires
 * `pause` later. Frame callbacks fire only when a test presents a frame.
 */
export class FakeVideo extends EventTarget implements VideoLike {
  duration = 60;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  playbackRate = 1;
  buffered: TimeRangesLike = { length: 1, start: () => 0, end: () => 30 };
  totalVideoFrames = 0;
  droppedVideoFrames = 0;
  /** false: a test drives `seeking` and `seeked` itself. */
  autoSeek = true;
  playError: Error | null = null;
  playCalls = 0;
  readonly cancelledFrameCallbacks: number[] = [];

  private time = 0;
  private nextHandle = 1;
  private readonly frameCallbacks = new Map<number, (now: number, metadata: FrameMetadataLike) => void>();

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    if (!this.autoSeek) return;
    this.seeking = true;
    queueMicrotask(() => {
      this.fire('seeking');
      queueMicrotask(() => {
        this.seeking = false;
        this.fire('timeupdate');
        this.fire('seeked');
      });
    });
  }

  /** An optional method of the contract, so a test can remove it (`undefined`) to play an engine that lacks it. */
  requestVideoFrameCallback: VideoLike['requestVideoFrameCallback'] = (callback) => {
    const handle = this.nextHandle++;
    this.frameCallbacks.set(handle, callback);
    return handle;
  };

  cancelVideoFrameCallback = (handle: number): void => {
    this.cancelledFrameCallbacks.push(handle);
    this.frameCallbacks.delete(handle);
  };

  getVideoPlaybackQuality = (): { totalVideoFrames: number; droppedVideoFrames: number } => ({
    totalVideoFrames: this.totalVideoFrames,
    droppedVideoFrames: this.droppedVideoFrames,
  });

  get pendingFrameCallbacks(): number {
    return this.frameCallbacks.size;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playError) return Promise.reject(this.playError);
    this.paused = false;
    return new Promise((resolve) => {
      queueMicrotask(() => {
        this.fire('play');
        this.fire('playing');
        resolve();
      });
    });
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.fire('pause'));
  }

  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /** Moves the media clock without a seek and fires `timeupdate`, as playback does. */
  advanceTo(time: number): void {
    this.time = time;
    this.fire('timeupdate');
  }

  /** A frame reaches the compositor: the registered callbacks run once, with the frame's media time. */
  presentFrame(mediaTime: number, presentedFrames?: number): void {
    this.time = mediaTime;
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const callback of callbacks) {
      callback(0, { mediaTime, ...(presentedFrames !== undefined ? { presentedFrames } : {}) });
    }
  }
}

export const TRACK_240: TrackLike = {
  id: 1,
  active: false,
  bandwidth: 364_000,
  width: 426,
  height: 240,
  videoCodec: 'vp09.00.10.08',
  audioCodec: 'mp4a.40.2',
};
export const TRACK_360: TrackLike = { ...TRACK_240, id: 2, bandwidth: 764_000, width: 640, height: 360 };
export const TRACK_720: TrackLike = { ...TRACK_240, id: 3, bandwidth: 1_864_000, width: 1280, height: 720 };

/** A Shaka player that dispatches the events the hook listens to, when a test says so, and records what it was asked. */
export class FakePlayer extends EventTarget implements PlayerLike {
  loadMode = 1;
  live = false;
  tracks: TrackLike[] = [{ ...TRACK_240 }, { ...TRACK_360 }, { ...TRACK_720 }];
  /** Which track Shaka picks first. */
  initialTrackId = 2;
  /** Dispatch `adaptation` for the initial selection, as some Shaka paths do. */
  announceInitialSelection = false;
  rejectConfiguration = false;
  defaults: Record<string, unknown> = {
    abr: {
      switchInterval: 8,
      enabled: true,
      useNetworkInformation: true,
      defaultBandwidthEstimate: 1_000_000,
    },
    streaming: { bufferingGoal: 10, rebufferingGoal: 0 },
  };
  loadError: unknown = null;
  /** Runs inside `load()`, after the manifest was parsed: a test dispatches what Shaka would during a load. */
  duringLoad: (() => void) | null = null;
  readonly loadCalls: Array<{ uri: string; startTime: number | null | undefined }> = [];
  readonly configureCalls: object[] = [];
  readonly selectCalls: Array<{
    track: TrackLike;
    clearBuffer: boolean | undefined;
    safeMargin: number | undefined;
  }> = [];
  unloadCalls = 0;
  destroyCalls = 0;
  seekEnd = 100;
  availabilityEnd = 106;
  delaySec = 6;
  goToLiveCalls = 0;

  constructor(private readonly video: FakeVideo) {
    super();
    // What Shaka's playhead and buffering observer do with rebufferingGoal 0: a seek starts a buffering episode, `seeked` ends it.
    video.addEventListener('seeking', () => this.emit('buffering', { buffering: true }));
    video.addEventListener('seeked', () => this.emit('buffering', { buffering: false }));
  }

  emit(type: string, properties: Record<string, unknown> = {}): void {
    this.dispatchEvent(Object.assign(new Event(type), properties));
  }

  async load(uri: string, startTime?: number | null): Promise<void> {
    this.loadCalls.push({ uri, startTime });
    await Promise.resolve();
    if (this.loadError) throw this.loadError;
    this.loadMode = 2;
    this.emit('manifestparsed');
    for (const track of this.tracks) track.active = track.id === this.initialTrackId;
    if (this.announceInitialSelection) this.emit('adaptation');
    this.duringLoad?.();
  }

  async unload(): Promise<void> {
    this.unloadCalls += 1;
    this.loadMode = 1;
    for (const track of this.tracks) track.active = false;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.loadMode = 0;
  }

  configure(config: object): boolean {
    this.configureCalls.push(config);
    return !this.rejectConfiguration;
  }

  getConfiguration(): object {
    return structuredClone(this.defaults);
  }

  getVariantTracks(): TrackLike[] {
    return this.tracks;
  }

  selectVariantTrack(track: TrackLike, clearBuffer?: boolean, safeMargin?: number): void {
    this.selectCalls.push({ track, clearBuffer, safeMargin });
    for (const candidate of this.tracks) candidate.active = candidate.id === track.id;
    // Shaka dispatches `variantchanged` a tick later, once getVariantTracks() already reflects the choice.
    queueMicrotask(() => this.emit('variantchanged'));
  }

  isLive(): boolean {
    return this.live;
  }

  seekRange(): { start: number; end: number } {
    return { start: 0, end: this.seekEnd };
  }

  getLoadMode(): number {
    return this.loadMode;
  }

  goToLive(): void {
    this.goToLiveCalls += 1;
    this.video.currentTime = this.seekEnd;
  }

  getManifest(): {
    presentationTimeline: { getSegmentAvailabilityEnd(): number; getDelay(): number };
  } | null {
    return this.live
      ? {
          presentationTimeline: {
            getSegmentAvailabilityEnd: () => this.availabilityEnd,
            getDelay: () => this.delaySec,
          },
        }
      : null;
  }
}
