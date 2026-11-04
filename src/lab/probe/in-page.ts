import type { MediaErrorInfo, ProbeStage } from './results.ts';

// Code that runs INSIDE the page. Playwright serialises these functions with Function.prototype.toString, so each one must be
// completely self-contained: no module-level helpers, no imports used at run time (type imports are erased), no classes.
// Transpilers that keep function names (tsx) wrap inner functions in `__name(...)`; run.ts installs a no-op `__name` in the
// page first. A unit test runs the serialised source in a bare context to prove the self-containment.

export type InPageSource =
  { kind: 'mse'; tracks: Array<{ type: string; url: string }> } | { kind: 'native'; url: string };

export interface InPageSpec {
  source: InPageSource;
  /**
   * How the page drives the element. The default mirrors a player page: muted (so autoplay is allowed) and segments fetched
   * AFTER the SourceBuffers exist. Linux WebKit's MSE verdict depends on both, see ADR-031.
   */
  profile: { muted: boolean; prefetch: boolean };
  /** Whether a video track is part of the source: frames must be presented, not only time advance. */
  hasVideo: boolean;
  /** Media time that has to be reached, seconds. */
  thresholdSec: number;
  /** Video frames that have to be presented (when the engine can count them). */
  minFrames: number;
  /** Safety net for the whole attempt. Reaching it is a failure to report, never a measurement. */
  deadlineMs: number;
}

export interface InPageOutcome {
  ok: boolean;
  stage?: ProbeStage;
  error?: string;
  mediaError?: MediaErrorInfo;
  currentTime: number;
  framesPresented: number | null;
}

/**
 * Appends the source through MediaSource (or plays it as a plain `<video src>` for the control cases), plays it (muted,
 * unless the profile says otherwise), and passes only when media time passed the threshold and, for video, frames were
 * presented. Event-driven: it waits on `sourceopen`, `updateend`, `play()`, `timeupdate` and video frame callbacks. A media
 * element or SourceBuffer error ends the attempt at once with the stage it happened in; the deadline timer only catches a
 * pipeline that never says anything.
 */
export async function probeInPage(spec: InPageSpec): Promise<InPageOutcome> {
  let stage: ProbeStage = 'setup';
  const cleanups: Array<() => void> = [];
  let frames = 0;
  let frameSource: 'callback' | 'quality' | 'none' = 'none';
  let onProgress = (): void => undefined;

  const video = document.createElement('video');
  video.muted = spec.profile.muted;
  video.playsInline = true;
  document.body.appendChild(video);

  const presented = (): number | null => {
    if (frameSource === 'callback') return frames;
    if (frameSource === 'quality') {
      const quality = video.getVideoPlaybackQuality();
      return quality.totalVideoFrames - quality.droppedVideoFrames;
    }
    return null;
  };

  const mediaError = (): MediaErrorInfo | undefined =>
    video.error ? { code: video.error.code, message: video.error.message } : undefined;

  const outcome = (ok: boolean): InPageOutcome => ({
    ok,
    currentTime: Math.round(video.currentTime * 100) / 100,
    framesPresented: presented(),
  });

  // Rejects on a media element error or when the safety-net deadline passes, whichever comes first.
  const interrupted = new Promise<never>((_resolve, reject) => {
    const onError = (): void =>
      reject(Object.assign(new Error('media element error'), { origin: 'media-element' }));
    video.addEventListener('error', onError);
    cleanups.push(() => video.removeEventListener('error', onError));
    const timer = setTimeout(
      () => reject(Object.assign(new Error(`timeout after ${spec.deadlineMs} ms`), { origin: 'deadline' })),
      spec.deadlineMs,
    );
    cleanups.push(() => clearTimeout(timer));
  });
  interrupted.catch(() => undefined);

  if (typeof video.requestVideoFrameCallback === 'function') {
    frameSource = 'callback';
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      frames = typeof metadata.presentedFrames === 'number' ? metadata.presentedFrames : frames + 1;
      video.requestVideoFrameCallback(onFrame);
      onProgress();
    };
    video.requestVideoFrameCallback(onFrame);
  } else if (typeof video.getVideoPlaybackQuality === 'function') {
    frameSource = 'quality';
  }

  const run = async (): Promise<void> => {
    if (spec.source.kind === 'mse') {
      const tracks = spec.source.tracks;
      const scope = window as unknown as {
        MediaSource?: typeof MediaSource;
        ManagedMediaSource?: typeof MediaSource;
      };
      const MediaSourceType = scope.MediaSource ?? scope.ManagedMediaSource;
      if (!MediaSourceType) throw new Error('neither MediaSource nor ManagedMediaSource exists');
      // ManagedMediaSource (where it replaces MediaSource) refuses to attach to an element that allows remote playback.
      if (!scope.MediaSource) video.disableRemotePlayback = true;

      const fetchAll = async (): Promise<ArrayBuffer[]> => {
        stage = 'fetch';
        const data: ArrayBuffer[] = [];
        for (const track of tracks) {
          const response = await fetch(track.url);
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${track.url}`);
          data.push(await response.arrayBuffer());
        }
        return data;
      };

      let data: ArrayBuffer[] = [];
      if (spec.profile.prefetch) data = await fetchAll();

      stage = 'setup';
      const mediaSource = new MediaSourceType();
      const opened = new Promise<void>((resolve) =>
        mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }),
      );
      video.src = URL.createObjectURL(mediaSource);
      stage = 'sourceopen';
      await opened;

      // Chromium requires every SourceBuffer to exist before the first initialization segment is appended.
      stage = 'addSourceBuffer';
      const buffers = tracks.map((track) => mediaSource.addSourceBuffer(track.type));

      // A player fetches its segments after it has created the SourceBuffers; so does the probe, unless told to prefetch.
      if (!spec.profile.prefetch) data = await fetchAll();

      stage = 'append';
      for (const [index, buffer] of buffers.entries()) {
        await new Promise<void>((resolve, reject) => {
          buffer.addEventListener('updateend', () => resolve(), { once: true });
          buffer.addEventListener(
            'error',
            () => reject(Object.assign(new Error('SourceBuffer error event'), { origin: 'source-buffer' })),
            { once: true },
          );
          buffer.appendBuffer(data[index] as ArrayBuffer);
        });
      }

      stage = 'endOfStream';
      mediaSource.endOfStream();
    } else {
      stage = 'setup';
      video.preload = 'auto';
      video.src = spec.source.url;
    }

    stage = 'play';
    await video.play();

    stage = 'currentTime';
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        const timeReached = video.currentTime >= spec.thresholdSec;
        stage = timeReached ? 'frames' : 'currentTime';
        if (!timeReached) return;
        if (spec.hasVideo) {
          if (video.videoWidth === 0) return;
          const count = presented();
          if (count !== null && count < spec.minFrames) return;
        }
        resolve();
      };
      onProgress = check;
      video.addEventListener('timeupdate', check);
      video.addEventListener(
        'ended',
        () => {
          check();
          reject(
            Object.assign(new Error('playback ended before the thresholds were reached'), {
              origin: 'ended',
            }),
          );
        },
        { once: true },
      );
      check();
    });
  };

  try {
    await Promise.race([run(), interrupted]);
    return outcome(true);
  } catch (caught) {
    // The element's `error` event can be queued after the SourceBuffer's own: let it land before reading `video.error`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const failure = caught as { name?: string; message?: string; origin?: string };
    const element = mediaError();
    let error: string;
    if (failure.origin === 'media-element') {
      error = element ? `MediaError ${element.code}: ${element.message}` : 'media element error';
    } else if (failure.origin === 'deadline') {
      error = failure.message ?? 'timeout';
    } else {
      error = `${failure.name ?? 'Error'}: ${failure.message ?? String(caught)}`;
    }
    return { ...outcome(false), stage, error, ...(element ? { mediaError: element } : {}) };
  } finally {
    for (const cleanup of cleanups) cleanup();
    onProgress = (): void => undefined;
    video.remove();
  }
}

export interface BrowserFacts {
  userAgent: string;
  mediaSource: 'MediaSource' | 'ManagedMediaSource' | 'none';
  /** `isTypeSupported` per type; null when the engine has no MediaSource or the call threw. */
  typeSupported: Record<string, boolean | null>;
  /** `canPlayType` answers for the two HLS types ('', 'maybe' or 'probably'). */
  canPlayType: Record<string, string>;
  requestVideoFrameCallback: boolean;
  getVideoPlaybackQuality: boolean;
}

/** What the engine says about itself, before anything is played. Also in-page code: keep it self-contained. */
export function collectBrowserFacts(types: string[]): BrowserFacts {
  const scope = window as unknown as {
    MediaSource?: typeof MediaSource;
    ManagedMediaSource?: typeof MediaSource;
  };
  const MediaSourceType = scope.MediaSource ?? scope.ManagedMediaSource;
  const typeSupported: Record<string, boolean | null> = {};
  for (const type of types) {
    try {
      typeSupported[type] = MediaSourceType ? MediaSourceType.isTypeSupported(type) : null;
    } catch {
      typeSupported[type] = null;
    }
  }
  const element = document.createElement('video');
  const canPlayType: Record<string, string> = {};
  for (const type of ['application/vnd.apple.mpegurl', 'application/x-mpegURL']) {
    canPlayType[type] = element.canPlayType(type);
  }
  return {
    userAgent: navigator.userAgent,
    mediaSource: scope.MediaSource ? 'MediaSource' : scope.ManagedMediaSource ? 'ManagedMediaSource' : 'none',
    typeSupported,
    canPlayType,
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    getVideoPlaybackQuality: typeof HTMLVideoElement.prototype.getVideoPlaybackQuality === 'function',
  };
}
