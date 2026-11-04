import type { QAError, QAEvent, QAMetrics, QAState, VariantInfo } from '../shared/qa.ts';

// docs/METRICS.md as pure functions of the event timeline and a snapshot of the media element. No DOM, no Shaka: the page
// feeds these functions and the unit tests feed them fake timelines, so a definition is implemented once and can be tested
// at its edges (a stall that never ends, a stall inside a seek, a seek that needs no recovery).
//
// A measurement describes the LATEST load: the events from the most recent `load-requested`. A page that loads twice
// reports the second load, not a blend of the two. Errors are the exception: they cover the page's whole life, so that
// "there were none" can never be true because a reload came in between.

type Detail = Record<string, unknown>;

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const detailOf = (event: QAEvent): Detail => event.detail ?? {};

/** The events of the most recent load, from its `load-requested` on. Empty when nothing was ever loaded. */
export function lastLoad(events: readonly QAEvent[]): readonly QAEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.name === 'load-requested') return events.slice(i);
  }
  return [];
}

export interface StartupTimes {
  startupMs: number | null;
  manifestMs: number | null;
  loadedMs: number | null;
}

/** `load-requested` to `firstframe`, `manifest-loaded` and `loaded`. null until the event has happened. */
export function startupTimes(load: readonly QAEvent[]): StartupTimes {
  const start = load[0];
  if (!start || start.name !== 'load-requested') return { startupMs: null, manifestMs: null, loadedMs: null };
  const after = (name: QAEvent['name']): number | null => {
    const event = load.find((candidate) => candidate.name === name);
    return event ? event.t - start.t : null;
  };
  return { startupMs: after('firstframe'), manifestMs: after('manifest-loaded'), loadedMs: after('loaded') };
}

export interface BufferingEpisode {
  /** Index of the `buffering-start` event. */
  startIndex: number;
  startT: number;
  mediaTime: number;
  /** null while the episode has not ended. */
  endT: number | null;
  /** Why the episode is not a rebuffer, or null when it is one. */
  excluded: 'before-firstframe' | 'seek' | null;
}

/**
 * Every Shaka `buffering` episode of the load, each marked with why it does not count as a rebuffer (or not marked).
 *
 * An episode is not a rebuffer when it started
 *  - before the first frame (that is startup), or
 *  - inside a viewer's seek window.
 *
 * The seek window opens at `seeking` and closes at the first of
 *  1. a `playing` after `seeked` (docs/METRICS.md);
 *  2. the `buffering-end` that follows `seeked`: Shaka says the player has recovered;
 *  3. `seeked` itself when no episode is open then. A seek inside the buffered range keeps the element playable, so the
 *     element fires no `playing` for it; waiting for one would leave the window open and swallow the next real stall.
 *
 * The decision is made where the episode STARTS: a stall that began before the seek is a stall, even if the seek came
 * while it lasted; a stall that began in the window is the seek's cost, even if it ends after `playing`.
 */
export function bufferingEpisodes(load: readonly QAEvent[]): BufferingEpisode[] {
  const episodes: BufferingEpisode[] = [];
  let open: BufferingEpisode | null = null;
  let firstFrameSeen = false;
  let seekWindow: 'closed' | 'seeking' | 'recovering' = 'closed';

  for (const event of load) {
    switch (event.name) {
      case 'firstframe':
        firstFrameSeen = true;
        break;
      case 'seeking':
        seekWindow = 'seeking';
        break;
      case 'seeked':
        if (seekWindow === 'seeking') seekWindow = open ? 'recovering' : 'closed';
        break;
      case 'playing':
        if (seekWindow === 'recovering') seekWindow = 'closed';
        break;
      case 'buffering-start':
        if (!open) {
          open = {
            startIndex: event.index,
            startT: event.t,
            mediaTime: event.mediaTime,
            endT: null,
            excluded: !firstFrameSeen ? 'before-firstframe' : seekWindow !== 'closed' ? 'seek' : null,
          };
          episodes.push(open);
        }
        break;
      case 'buffering-end':
        if (open) {
          open.endT = event.t;
          open = null;
          if (seekWindow === 'recovering') seekWindow = 'closed';
        }
        break;
      case 'unloaded':
        // The viewer left: whatever was in progress ended here.
        if (open) open.endT = event.t;
        open = null;
        seekWindow = 'closed';
        break;
    }
  }
  return episodes;
}

/**
 * Milliseconds spent in the playing state since the first frame: the element has fired `playing` and has not been paused
 * or ended, and neither a seek nor a Shaka buffering episode is in progress. The denominator of the rebuffer ratio.
 */
export function playingTimeMs(load: readonly QAEvent[], now: number): number {
  let firstFrameSeen = false;
  let elementPlaying = false;
  let buffering = false;
  let seeking = false;
  let since: number | null = null;
  let total = 0;

  const stop = (t: number): void => {
    if (since !== null) total += t - since;
    since = null;
  };
  const start = (t: number): void => {
    if (firstFrameSeen && elementPlaying && !buffering && !seeking && since === null) since = t;
  };

  for (const event of load) {
    switch (event.name) {
      case 'firstframe':
        firstFrameSeen = true;
        start(event.t);
        break;
      case 'playing':
        elementPlaying = true;
        start(event.t);
        break;
      case 'paused':
      case 'ended':
        elementPlaying = false;
        stop(event.t);
        break;
      case 'seeking':
        seeking = true;
        stop(event.t);
        break;
      case 'seeked':
        seeking = false;
        start(event.t);
        break;
      case 'buffering-start':
        buffering = true;
        stop(event.t);
        break;
      case 'buffering-end':
        buffering = false;
        start(event.t);
        break;
      case 'unloaded':
        elementPlaying = false;
        buffering = false;
        seeking = false;
        stop(event.t);
        break;
    }
  }
  // A playing interval still open at the snapshot counts up to the snapshot.
  if (since !== null) total += Math.max(0, now - since);
  return total;
}

export function rebufferMetrics(load: readonly QAEvent[], now: number): QAMetrics['rebuffer'] {
  const events = bufferingEpisodes(load)
    .filter((episode) => episode.excluded === null)
    .map((episode) => ({
      startMs: episode.startT,
      durationMs: Math.max(0, (episode.endT ?? now) - episode.startT),
      mediaTime: episode.mediaTime,
      ongoing: episode.endT === null,
    }));
  const totalMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  const denominator = totalMs + playingTimeMs(load, now);
  return { count: events.length, totalMs, ratio: denominator > 0 ? totalMs / denominator : 0, events };
}

const REASONS = new Set(['start', 'abr', 'manual']);

export function bitrateMetrics(load: readonly QAEvent[], current: VariantInfo | null): QAMetrics['bitrate'] {
  const history: QAMetrics['bitrate']['history'] = [];
  for (const event of load) {
    if (event.name !== 'variant-changed') continue;
    const detail = detailOf(event);
    const to = number(detail.to);
    if (to === undefined) continue;
    const reason = text(detail.reason);
    history.push({
      t: event.t,
      from: number(detail.from) ?? null,
      to,
      height: number(detail.height) ?? null,
      reason: reason !== undefined && REASONS.has(reason) ? (reason as 'start' | 'abr' | 'manual') : 'abr',
    });
  }
  const switches = history.filter((change) => change.reason !== 'start' && change.from !== change.to).length;
  return { switches, current, history };
}

/** Every error event of the page's life as a `QAError`. */
export function errorsFromEvents(events: readonly QAEvent[]): QAError[] {
  const errors: QAError[] = [];
  for (const event of events) {
    if (event.name !== 'error') continue;
    const detail = detailOf(event);
    const codeName = text(detail.codeName);
    const source = text(detail.source);
    errors.push({
      t: event.t,
      code: number(detail.code) ?? 0,
      category: number(detail.category) ?? 0,
      severity: number(detail.severity) ?? 1,
      message: text(detail.message) ?? '',
      ...(Array.isArray(detail.data) ? { data: detail.data as unknown[] } : {}),
      ...(codeName !== undefined ? { codeName } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }
  return errors;
}

/**
 * The state of the player, from the timeline and what the element says about itself. The order is the priority: a critical
 * error beats everything but an unload, a seek or a stall beats playing.
 */
export function deriveState(
  events: readonly QAEvent[],
  playback: Pick<QAMetrics['playback'], 'paused' | 'ended'>,
): QAState {
  let loadStart = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.name === 'load-requested') {
      loadStart = i;
      break;
    }
  }
  let loaded = false;
  let unloaded = false;
  let critical = false;
  let played = false;
  let seeking = false;
  let buffering = false;
  for (const event of events.slice(Math.max(loadStart, 0))) {
    switch (event.name) {
      case 'loaded':
        loaded = true;
        break;
      case 'unloaded':
        unloaded = true;
        break;
      case 'error':
        if (number(detailOf(event).severity) === 2) critical = true;
        break;
      case 'playing':
        played = true;
        break;
      case 'seeking':
        seeking = true;
        break;
      case 'seeked':
        seeking = false;
        break;
      case 'buffering-start':
        buffering = true;
        break;
      case 'buffering-end':
        buffering = false;
        break;
    }
  }
  if (unloaded) return 'idle';
  if (critical) return 'error';
  if (loadStart < 0) return 'idle';
  if (!loaded) return 'loading';
  if (playback.ended) return 'ended';
  if (seeking) return 'seeking';
  if (buffering) return 'buffering';
  if (playback.paused) return played ? 'paused' : 'ready';
  return 'playing';
}

export interface MetricsInput {
  events: readonly QAEvent[];
  /** `performance.now()` at the snapshot: a stall or a playing interval still open is measured up to here. */
  now: number;
  playback: QAMetrics['playback'];
  /** `getVideoPlaybackQuality()` and the presented-frame counter (null where requestVideoFrameCallback is missing). */
  frames: { decoded: number; dropped: number; presented: number | null };
  /** The active video variant. */
  variant: VariantInfo | null;
  live: {
    isLive: boolean;
    latencyMs: number | null;
    latencyMaxMs: number | null;
    presentationDelayMs: number | null;
  };
}

export function computeMetrics(input: MetricsInput): QAMetrics {
  const load = lastLoad(input.events);
  const { startupMs, manifestMs, loadedMs } = startupTimes(load);
  const { decoded, dropped, presented } = input.frames;
  return {
    state: deriveState(input.events, input.playback),
    startupMs,
    startup: { manifestMs, loadedMs },
    rebuffer: rebufferMetrics(load, input.now),
    frames: { decoded, dropped, droppedRatio: decoded > 0 ? dropped / decoded : 0, presented },
    bitrate: bitrateMetrics(load, input.variant),
    live: {
      isLive: input.live.isLive,
      latencyMs: input.live.latencyMs,
      latencyMaxMs: input.live.latencyMaxMs,
      presentationDelayMs: input.live.presentationDelayMs,
      edgeSeeks: load.filter((event) => event.name === 'live-edge-seek').length,
    },
    errors: errorsFromEvents(input.events),
    playback: input.playback,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live

/**
 * Distance of the playhead behind the live edge, ms. `availabilityEndSec` is the end of the newest segment the origin has
 * published (Shaka: `presentationTimeline.getSegmentAvailabilityEnd()`, in the player's clock, corrected by UTCTiming).
 *
 * This is deliberately NOT `player.seekRange().end - currentTime`. For a live presentation Shaka's seek range ends one
 * presentation delay (the manifest's suggestedPresentationDelay, 6 s for the lab's streams) BEHIND the live edge, because
 * that is where it starts playback and tries to stay: a healthy stream reads about 0 there, and the number only measures how
 * far the playhead has drifted from Shaka's own target. What a live-event owner is paged about is the distance to the edge
 * itself, which is that drift plus the delay (about 6 s when healthy). Both are the same quantity moved by a constant;
 * `presentationDelayMs` is exposed next to the latency so that either can be read off the other. Shaka's own live-sync
 * (`streaming.liveSync`, off in both configurations) works on the same wall-clock distance and changes the playback rate to
 * hold a target; nothing here changes the playback.
 *
 * Clamped at 0: the playhead can read a few milliseconds past the end of the newest segment.
 */
export function liveLatencyMs(availabilityEndSec: number, currentTimeSec: number): number | null {
  const ms = (availabilityEndSec - currentTimeSec) * 1000;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** The current and the largest latency, the maximum counting only from the first frame on. */
export class LatencyTracker {
  private armed = false;
  private maxMs: number | null = null;
  private currentMs: number | null = null;

  /** The first frame was presented: samples count towards the maximum from now on. */
  arm(): void {
    this.armed = true;
  }

  /** A new load starts a new measurement. */
  reset(): void {
    this.armed = false;
    this.maxMs = null;
    this.currentMs = null;
  }

  sample(latencyMs: number | null): void {
    this.currentMs = latencyMs;
    if (this.armed && latencyMs !== null && (this.maxMs === null || latencyMs > this.maxMs))
      this.maxMs = latencyMs;
  }

  get current(): number | null {
    return this.currentMs;
  }

  get max(): number | null {
    return this.maxMs;
  }
}

/** Shaka's gap jumps and stall skips are well under a segment; a catch-up to the edge jumps by seconds. */
export const LIVE_EDGE_MIN_JUMP_SEC = 2;
/** A jump "to the live edge" lands within this many seconds of the end of Shaka's seek range (one 2 s segment of positioning granularity and a margin). */
export const LIVE_EDGE_LANDING_SEC = 3;

export interface SeekFacts {
  isLive: boolean;
  firstFrameSeen: boolean;
  /** The seek was started by qa.seek() / qa.seekToLiveEdge(). */
  requestedByViewer: boolean;
  /** The last playhead position seen before the seek (timeupdate), null when none. */
  fromTime: number | null;
  /** `video.currentTime` when `seeking` fired: where the seek goes. */
  toTime: number;
  /** `player.seekRange().end`, null when unknown. */
  seekRangeEnd: number | null;
}

/**
 * True for a forward jump to the live edge that the viewer did not ask for: a catch-up by the player (for example Shaka's
 * live-sync panic mode). The initial positioning (before the first frame), seeks started through the hook, backwards
 * seeks, small forward jumps (gap jumps) and jumps that do not land near the edge (falling out of the DVR window lands
 * at its start) are not.
 */
export function isLiveEdgeCatchUp(facts: SeekFacts): boolean {
  if (!facts.isLive || !facts.firstFrameSeen || facts.requestedByViewer) return false;
  if (facts.fromTime === null || facts.seekRangeEnd === null) return false;
  if (!(facts.toTime - facts.fromTime >= LIVE_EDGE_MIN_JUMP_SEC)) return false;
  const short = facts.seekRangeEnd - facts.toTime;
  return short >= -0.5 && short <= LIVE_EDGE_LANDING_SEC;
}

// ---------------------------------------------------------------------------------------------------------------------
// The media element

export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/** Shaka treats a playhead this close to the start of a buffered range as inside it; so does this. */
const BUFFERED_TOLERANCE_SEC = 0.1;

/** Seconds of media buffered ahead of `time`: up to the end of the buffered range that holds it. 0 when it is in a gap. */
export function bufferedAheadSec(ranges: TimeRangesLike, time: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (time >= ranges.start(i) - BUFFERED_TOLERANCE_SEC && time <= ranges.end(i)) {
      return Math.max(0, ranges.end(i) - time);
    }
  }
  return 0;
}

/** One frame callback (`requestVideoFrameCallback`): the frame's media time and, where the engine has it, the running count. */
export interface FrameSample {
  mediaTime: number;
  presentedFrames?: number;
}

/** A jump of the media clock between two frames that this large is not playback (a seek, a recovery jump). */
export const MAX_FRAME_GAP_SEC = 1;

/**
 * The arithmetic of `qa.measureFrames`: the window opens at the first sample and is complete when the media clock has
 * advanced by `mediaSeconds`. The elapsed time comes from the samples' own media times, never from the requested value or
 * a wall clock, so a stall cannot read as low fps. Frames are counted from the engine's running `presentedFrames` where
 * it has one (a callback can cover several frames when the main thread is busy), otherwise one per callback.
 */
export class FrameWindow {
  private base: FrameSample | null = null;
  private last: FrameSample | null = null;
  private callbacks = 0;

  constructor(
    private readonly mediaSeconds: number,
    private readonly countFrames = true,
  ) {
    if (!Number.isFinite(mediaSeconds) || mediaSeconds <= 0) {
      throw new RangeError(`mediaSeconds must be a finite number > 0, got ${mediaSeconds}`);
    }
  }

  /** Feeds a sample. Returns true when the window is complete. Throws when the media clock jumped. */
  push(sample: FrameSample): boolean {
    if (!this.base || !this.last) {
      this.base = sample;
      this.last = sample;
      return false;
    }
    const gap = sample.mediaTime - this.last.mediaTime;
    if (gap < 0 || gap > MAX_FRAME_GAP_SEC) {
      throw new Error(
        `the media clock jumped from ${this.last.mediaTime.toFixed(3)} s to ${sample.mediaTime.toFixed(3)} s inside the measurement window (a seek or a recovery jump): the frame rate of that window means nothing`,
      );
    }
    this.last = sample;
    this.callbacks += 1;
    return sample.mediaTime - this.base.mediaTime >= this.mediaSeconds;
  }

  /** The measurement, given the decoded and dropped frames of the same window. Call after `push` returned true. */
  result(quality: { decoded: number; dropped: number }): {
    presented: number | null;
    dropped: number;
    decoded: number;
    mediaSeconds: number;
    fps: number | null;
  } {
    if (!this.base || !this.last) throw new Error('the measurement window has no samples');
    const elapsed = this.last.mediaTime - this.base.mediaTime;
    let presented: number | null = null;
    if (this.countFrames) {
      presented =
        this.base.presentedFrames !== undefined && this.last.presentedFrames !== undefined
          ? this.last.presentedFrames - this.base.presentedFrames
          : this.callbacks;
    }
    return {
      presented,
      dropped: quality.dropped,
      decoded: quality.decoded,
      mediaSeconds: elapsed,
      fps: presented !== null && elapsed > 0 ? presented / elapsed : null,
    };
  }
}

/**
 * Frames presented since a load began, for `metrics().frames.presented`: from the engine's running `presentedFrames`
 * where it has one (counted from the first frame callback of the load, because the engine's counter may carry on across
 * loads), otherwise one per callback. 0 until a frame has been seen.
 */
export class PresentedCounter {
  private first: number | null = null;
  private latest: number | null = null;
  private callbacks = 0;

  observe(metadata: { presentedFrames?: number }): void {
    this.callbacks += 1;
    if (metadata.presentedFrames === undefined) return;
    this.first ??= metadata.presentedFrames;
    this.latest = metadata.presentedFrames;
  }

  reset(): void {
    this.first = null;
    this.latest = null;
    this.callbacks = 0;
  }

  get value(): number {
    return this.first !== null && this.latest !== null ? this.latest - this.first + 1 : this.callbacks;
  }
}
