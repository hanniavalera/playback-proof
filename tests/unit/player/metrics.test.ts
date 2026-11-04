import { describe, expect, it } from 'vitest';
import {
  FrameWindow,
  LatencyTracker,
  MAX_FRAME_GAP_SEC,
  bitrateMetrics,
  bufferedAheadSec,
  bufferingEpisodes,
  computeMetrics,
  deriveState,
  errorsFromEvents,
  isLiveEdgeCatchUp,
  lastLoad,
  liveLatencyMs,
  playingTimeMs,
  rebufferMetrics,
  startupTimes,
} from '../../../src/player/metrics.ts';
import type { MetricsInput, SeekFacts } from '../../../src/player/metrics.ts';
import type { QAEvent, QAEventName, VariantInfo } from '../../../src/shared/qa.ts';

type Spec = [name: QAEventName, t: number, detail?: Record<string, unknown>, mediaTime?: number];

/** A fake timeline: [name, page clock ms, detail?, media time?] per event, indexed in order. */
function tl(...specs: Spec[]): QAEvent[] {
  return specs.map(([name, t, detail, mediaTime], index) => ({
    index,
    t,
    name,
    mediaTime: mediaTime ?? 0,
    ...(detail ? { detail } : {}),
  }));
}

// A healthy start, as Shaka with its defaults produces it: it begins in the buffering state, the element plays, the first
// frame is presented, and Shaka leaves the buffering state on the first `playing`.
const START: Spec[] = [
  ['load-requested', 0],
  ['buffering-start', 2],
  ['manifest-loaded', 40],
  ['loaded', 150],
  ['playing', 400],
  ['buffering-end', 401],
  ['firstframe', 420],
];

describe('the latest load', () => {
  it('is everything from the most recent load-requested, and nothing when there was none', () => {
    expect(lastLoad([])).toEqual([]);
    expect(lastLoad(tl(['error', 5]))).toEqual([]);
    const events = tl(
      ['load-requested', 0],
      ['loaded', 10],
      ['unloaded', 20],
      ['load-requested', 30],
      ['loaded', 50],
    );
    expect(lastLoad(events).map((event) => event.index)).toEqual([3, 4]);
  });

  it('a second load is measured on its own, while the errors of the page keep their whole history', () => {
    const events = tl(
      ...START,
      ['buffering-start', 3000],
      ['buffering-end', 3500],
      ['error', 3600, { code: 1001, severity: 1 }],
      ['load-requested', 10_000],
      ['firstframe', 10_700],
    );
    const metrics = computeMetrics({ ...baseInput(), events, now: 11_000 });
    expect(metrics.startupMs).toBe(700);
    expect(metrics.rebuffer.count).toBe(0);
    expect(metrics.errors).toHaveLength(1);
  });
});

describe('startup', () => {
  it('is load-requested to firstframe, with the manifest and loaded times on the same clock', () => {
    expect(startupTimes(tl(...START))).toEqual({ startupMs: 420, manifestMs: 40, loadedMs: 150 });
  });

  it('is null until the event has happened, and for an empty timeline', () => {
    expect(startupTimes(tl(['load-requested', 100], ['manifest-loaded', 140]))).toEqual({
      startupMs: null,
      manifestMs: 40,
      loadedMs: null,
    });
    expect(startupTimes([])).toEqual({ startupMs: null, manifestMs: null, loadedMs: null });
  });

  it('does not depend on the order of loaded and firstframe, and uses the first firstframe', () => {
    const events = tl(['load-requested', 10], ['firstframe', 200], ['loaded', 260], ['firstframe', 900]);
    expect(startupTimes(events)).toEqual({ startupMs: 190, manifestMs: null, loadedMs: 250 });
  });
});

describe('rebuffering', () => {
  it('an unprompted stall after the first frame counts, with where and how long', () => {
    const events = tl(
      ...START,
      ['buffering-start', 3000, undefined, 2.5],
      ['buffering-end', 3800, undefined, 2.5],
    );
    expect(rebufferMetrics(events, 6000)).toMatchObject({
      count: 1,
      totalMs: 800,
      events: [{ startMs: 3000, durationMs: 800, mediaTime: 2.5, ongoing: false }],
    });
  });

  it('adds up several stalls', () => {
    const events = tl(
      ...START,
      ['buffering-start', 3000],
      ['buffering-end', 3400],
      ['buffering-start', 5000],
      ['buffering-end', 5700],
    );
    const metrics = rebufferMetrics(events, 9000);
    expect(metrics.count).toBe(2);
    expect(metrics.totalMs).toBe(1100);
  });

  it('a stall that starts before the first frame is startup, even when it ends after it', () => {
    const events = tl(
      ['load-requested', 0],
      ['buffering-start', 2],
      ['firstframe', 420],
      ['playing', 421],
      ['buffering-end', 422],
    );
    expect(rebufferMetrics(events, 5000).count).toBe(0);
    expect(bufferingEpisodes(events)[0]?.excluded).toBe('before-firstframe');
  });

  it('a stall that has not ended is reported with the duration so far, flagged, and keeps growing with the snapshot time', () => {
    const events = tl(...START, ['buffering-start', 3000, undefined, 2.5]);
    const early = rebufferMetrics(events, 3500);
    const late = rebufferMetrics(events, 9000);
    expect(early).toMatchObject({ count: 1, totalMs: 500, events: [{ durationMs: 500, ongoing: true }] });
    expect(late).toMatchObject({ count: 1, totalMs: 6000, events: [{ durationMs: 6000, ongoing: true }] });
  });

  it('a stall that is still open when the viewer unloads ends there and is no longer ongoing', () => {
    const events = tl(...START, ['buffering-start', 3000], ['unloaded', 3400]);
    const metrics = rebufferMetrics(events, 90_000);
    expect(metrics.events).toEqual([{ startMs: 3000, durationMs: 400, mediaTime: 0, ongoing: false }]);
  });

  it('ignores a second buffering-start while one is open, and a buffering-end with nothing open', () => {
    const events = tl(
      ...START,
      ['buffering-end', 1000],
      ['buffering-start', 3000],
      ['buffering-start', 3100],
      ['buffering-end', 3600],
    );
    expect(rebufferMetrics(events, 9000)).toMatchObject({ count: 1, totalMs: 600 });
  });

  describe("the viewer's seek window", () => {
    const PLAYING: Spec[] = [
      ['load-requested', 0],
      ['playing', 100],
      ['firstframe', 120],
    ];

    it('Shaka with its defaults buffers from `seeking` to `seeked`: that is the seek, not a rebuffer', () => {
      const events = tl(
        ...PLAYING,
        ['seeking', 5000, undefined, 10],
        ['buffering-start', 5000],
        ['seeked', 5300, undefined, 10],
        ['buffering-end', 5300],
        ['playing', 5320],
      );
      expect(rebufferMetrics(events, 9000).count).toBe(0);
      expect(bufferingEpisodes(events)[0]?.excluded).toBe('seek');
    });

    it('a stall that starts in the window is the seek, even if it ends after `playing`', () => {
      const events = tl(
        ...PLAYING,
        ['seeking', 5000],
        ['buffering-start', 5001],
        ['seeked', 5300],
        ['playing', 5310],
        ['buffering-end', 5900],
      );
      expect(rebufferMetrics(events, 9000).count).toBe(0);
    });

    it('a seek that needs no recovery does not swallow the next real stall', () => {
      // Inside the buffered range the element never leaves the playable state, so it fires no `playing`: a window that
      // waited for one would stay open and hide the stall at 9000.
      const events = tl(
        ...PLAYING,
        ['seeking', 5000],
        ['seeked', 5010],
        ['buffering-start', 9000, undefined, 14],
        ['buffering-end', 9400],
      );
      expect(rebufferMetrics(events, 12_000)).toMatchObject({ count: 1, totalMs: 400 });
    });

    it('a seek made while paused does not hide a stall after the viewer resumes', () => {
      const events = tl(
        ...PLAYING,
        ['paused', 4000],
        ['seeking', 5000],
        ['buffering-start', 5000],
        ['seeked', 5200],
        ['buffering-end', 5200],
        ['playing', 9000],
        ['buffering-start', 12_000],
        ['buffering-end', 12_500],
      );
      expect(rebufferMetrics(events, 15_000)).toMatchObject({ count: 1, totalMs: 500 });
    });

    it('a second seek before the first has recovered extends the same window', () => {
      const events = tl(
        ...PLAYING,
        ['seeking', 5000],
        ['buffering-start', 5000],
        ['seeking', 5100],
        ['seeked', 5400],
        ['buffering-end', 5400],
        ['playing', 5410],
        ['buffering-start', 8000],
        ['buffering-end', 8300],
      );
      expect(rebufferMetrics(events, 12_000)).toMatchObject({ count: 1, totalMs: 300 });
    });

    it('a stall that began before the seek is still a stall, counted from its own start', () => {
      const events = tl(
        ...PLAYING,
        ['buffering-start', 4000],
        ['seeking', 4500],
        ['seeked', 4800],
        ['buffering-end', 5000],
        ['playing', 5010],
      );
      expect(rebufferMetrics(events, 9000)).toMatchObject({ count: 1, totalMs: 1000 });
    });

    it('a stall right after the window has closed counts', () => {
      const events = tl(
        ...PLAYING,
        ['seeking', 5000],
        ['buffering-start', 5000],
        ['seeked', 5100],
        ['buffering-end', 5100],
        ['playing', 5150],
        ['buffering-start', 5160],
        ['buffering-end', 5400],
      );
      expect(rebufferMetrics(events, 9000)).toMatchObject({ count: 1, totalMs: 240 });
    });

    it('a seek that never completes keeps its window open (documented limit): the stall is not counted', () => {
      const events = tl(...PLAYING, ['seeking', 5000], ['buffering-start', 5000], ['buffering-end', 8000]);
      expect(rebufferMetrics(events, 9000).count).toBe(0);
    });
  });

  describe('the ratio', () => {
    it('is stall time over stall time plus playing time since the first frame', () => {
      const events = tl(
        ['load-requested', 0],
        ['playing', 100],
        ['firstframe', 100],
        ['buffering-start', 2100],
        ['buffering-end', 2600],
        ['playing', 2600],
      );
      // playing 100..2100 and 2600..4600 = 4000 ms, stalled 500 ms
      expect(playingTimeMs(events, 4600)).toBe(4000);
      expect(rebufferMetrics(events, 4600).ratio).toBeCloseTo(500 / 4500, 10);
    });

    it('is 0 when nothing played and nothing stalled, and 1 when it only stalled', () => {
      expect(rebufferMetrics(tl(['load-requested', 0], ['loaded', 10]), 500).ratio).toBe(0);
      expect(rebufferMetrics([], 500).ratio).toBe(0);
      const stalledFromTheFirstFrame = tl(
        ['load-requested', 0],
        ['playing', 50],
        ['firstframe', 100],
        ['buffering-start', 100],
      );
      expect(playingTimeMs(stalledFromTheFirstFrame, 600)).toBe(0);
      expect(rebufferMetrics(stalledFromTheFirstFrame, 600)).toMatchObject({ totalMs: 500, ratio: 1 });
    });

    it('does not count time before the first frame as playing time', () => {
      // `playing` fired at 400 but the first frame was only presented at 1000
      const events = tl(['load-requested', 0], ['playing', 400], ['firstframe', 1000]);
      expect(playingTimeMs(events, 3000)).toBe(2000);
    });

    it('does not count a paused period as playing time', () => {
      const events = tl(
        ['load-requested', 0],
        ['playing', 100],
        ['firstframe', 100],
        ['paused', 1100],
        ['playing', 6100],
      );
      expect(playingTimeMs(events, 7100)).toBe(2000);
    });

    it('resumes playing at buffering-end, not at the `playing` that precedes it', () => {
      // The page records the element's `playing` before Shaka reports that buffering ended.
      const events = tl(
        ['load-requested', 0],
        ['playing', 100],
        ['firstframe', 100],
        ['buffering-start', 1000],
        ['playing', 1500],
        ['buffering-end', 1501],
      );
      expect(playingTimeMs(events, 2501)).toBe(900 + 1000);
    });

    it('resumes playing after a seek that fires no `playing`, and does not count the seek itself', () => {
      const events = tl(
        ['load-requested', 0],
        ['playing', 100],
        ['firstframe', 100],
        ['seeking', 1100],
        ['buffering-start', 1100],
        ['seeked', 1400],
        ['buffering-end', 1400],
      );
      expect(playingTimeMs(events, 3400)).toBe(1000 + 2000);
    });

    it('stops at the end of the stream and at unload', () => {
      const events = tl(
        ['load-requested', 0],
        ['playing', 100],
        ['firstframe', 100],
        ['paused', 4100],
        ['ended', 4100],
        ['unloaded', 4200],
      );
      expect(playingTimeMs(events, 90_000)).toBe(4000);
    });
  });
});

describe('bitrate', () => {
  const change = (t: number, from: number | null, to: number, height: number, reason: string): Spec => [
    'variant-changed',
    t,
    { from, to, height, bandwidth: to * 1000, reason },
  ];

  it('counts the changes after the initial selection and keeps the history in order', () => {
    const events = tl(
      ['load-requested', 0],
      change(200, null, 1, 240, 'start'),
      change(9000, 1, 3, 720, 'abr'),
      change(20_000, 3, 2, 360, 'abr'),
      change(30_000, 2, 3, 720, 'manual'),
    );
    const metrics = bitrateMetrics(lastLoad(events), null);
    expect(metrics.switches).toBe(3);
    expect(metrics.history).toEqual([
      { t: 200, from: null, to: 1, height: 240, reason: 'start' },
      { t: 9000, from: 1, to: 3, height: 720, reason: 'abr' },
      { t: 20_000, from: 3, to: 2, height: 360, reason: 'abr' },
      { t: 30_000, from: 2, to: 3, height: 720, reason: 'manual' },
    ]);
  });

  it('is 0 switches with only the initial selection, and with none at all', () => {
    expect(
      bitrateMetrics(lastLoad(tl(['load-requested', 0], change(200, null, 2, 360, 'start'))), null).switches,
    ).toBe(0);
    expect(bitrateMetrics([], null)).toEqual({ switches: 0, current: null, history: [] });
  });

  it('does not count an event that does not change the variant, but still lists it', () => {
    const events = tl(
      ['load-requested', 0],
      change(200, null, 2, 360, 'start'),
      change(900, 2, 2, 360, 'abr'),
    );
    const metrics = bitrateMetrics(lastLoad(events), null);
    expect(metrics.switches).toBe(0);
    expect(metrics.history).toHaveLength(2);
  });

  it('reads an unknown reason as an adaptation and skips an event without a target', () => {
    const events = tl(
      ['load-requested', 0],
      ['variant-changed', 100, { from: 1, to: 2, reason: 'mystery' }],
      ['variant-changed', 200, { from: 2, reason: 'abr' }],
    );
    const metrics = bitrateMetrics(lastLoad(events), null);
    expect(metrics.history).toEqual([{ t: 100, from: 1, to: 2, height: null, reason: 'abr' }]);
  });

  it('counts only the latest load, and hands the current variant through', () => {
    const variant: VariantInfo = {
      id: 3,
      bandwidth: 1_900_000,
      width: 1280,
      height: 720,
      videoCodec: 'vp09.00.10.08',
      audioCodec: 'mp4a.40.2',
    };
    const events = tl(
      ['load-requested', 0],
      change(100, null, 1, 240, 'start'),
      change(900, 1, 2, 360, 'abr'),
      ['load-requested', 5000],
      change(5100, null, 3, 720, 'start'),
    );
    const metrics = bitrateMetrics(lastLoad(events), variant);
    expect(metrics.switches).toBe(0);
    expect(metrics.history).toHaveLength(1);
    expect(metrics.current).toBe(variant);
  });
});

describe('errors', () => {
  it('turn error events into QAError with defaults for what a page error does not carry', () => {
    const events = tl(
      ['load-requested', 0],
      [
        'error',
        100,
        {
          code: 1001,
          codeName: 'BAD_HTTP_STATUS',
          category: 1,
          severity: 2,
          message: 'bad status',
          data: ['http://x/seg/3.m4s', 404],
          source: 'shaka',
        },
      ],
      ['error', 200, { code: 0, message: 'boom' }],
    );
    expect(errorsFromEvents(events)).toEqual([
      {
        t: 100,
        code: 1001,
        codeName: 'BAD_HTTP_STATUS',
        category: 1,
        severity: 2,
        message: 'bad status',
        data: ['http://x/seg/3.m4s', 404],
        source: 'shaka',
      },
      { t: 200, code: 0, category: 0, severity: 1, message: 'boom' },
    ]);
  });

  it('are none for a timeline without error events', () => {
    expect(errorsFromEvents(tl(...START))).toEqual([]);
  });
});

describe('state', () => {
  const stopped = { paused: true, ended: false };
  const running = { paused: false, ended: false };

  it.each<[string, Spec[], { paused: boolean; ended: boolean }, string]>([
    ['before anything happened', [], stopped, 'idle'],
    ['loading, until load() resolves', [['load-requested', 0]], running, 'loading'],
    [
      'ready: loaded, never played, paused',
      [
        ['load-requested', 0],
        ['loaded', 100],
      ],
      stopped,
      'ready',
    ],
    [
      'playing',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
      ],
      running,
      'playing',
    ],
    [
      'paused after playing',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['paused', 300],
      ],
      stopped,
      'paused',
    ],
    [
      'buffering: a stall in progress',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['buffering-start', 300],
      ],
      running,
      'buffering',
    ],
    [
      'back to playing when the stall ends',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['buffering-start', 300],
        ['buffering-end', 400],
      ],
      running,
      'playing',
    ],
    [
      'seeking, even while Shaka buffers',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['seeking', 300],
        ['buffering-start', 300],
      ],
      running,
      'seeking',
    ],
    [
      'ended, by what the element says',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['ended', 900],
      ],
      { paused: true, ended: true },
      'ended',
    ],
    [
      'error after a critical error',
      [
        ['load-requested', 0],
        ['error', 50, { code: 4032, severity: 2 }],
      ],
      stopped,
      'error',
    ],
    [
      'not error after a recoverable one',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['error', 250, { code: 1001, severity: 1 }],
      ],
      running,
      'playing',
    ],
    [
      'error for a critical error before any load',
      [['error', 5, { code: 9000, severity: 2 }]],
      stopped,
      'error',
    ],
    [
      'idle after unload',
      [
        ['load-requested', 0],
        ['loaded', 100],
        ['playing', 200],
        ['unloaded', 300],
      ],
      stopped,
      'idle',
    ],
    [
      'loading again after an error, once a new load is requested',
      [
        ['load-requested', 0],
        ['error', 50, { severity: 2 }],
        ['load-requested', 100],
      ],
      stopped,
      'loading',
    ],
  ])('%s', (_name, specs, playback, expected) => {
    expect(deriveState(tl(...specs), playback)).toBe(expected);
  });
});

describe('live latency', () => {
  it('is the distance from the playhead to the end of the newest published segment', () => {
    expect(liveLatencyMs(106, 100)).toBe(6000);
    expect(liveLatencyMs(106.25, 100)).toBeCloseTo(6250, 6);
  });

  it('is never negative, and is null when the edge is not known', () => {
    expect(liveLatencyMs(100, 100.04)).toBe(0);
    expect(liveLatencyMs(Number.NaN, 5)).toBeNull();
    expect(liveLatencyMs(Number.POSITIVE_INFINITY, 5)).toBeNull();
  });

  describe('LatencyTracker', () => {
    it('keeps the current value and a maximum that only counts from the first frame', () => {
      const tracker = new LatencyTracker();
      tracker.sample(9000); // before the first frame: the join position, not a measurement
      expect(tracker.current).toBe(9000);
      expect(tracker.max).toBeNull();
      tracker.arm();
      tracker.sample(6200);
      tracker.sample(7400);
      tracker.sample(6100);
      expect(tracker.current).toBe(6100);
      expect(tracker.max).toBe(7400);
    });

    it('ignores an unknown sample for the maximum, and a reset starts a new measurement', () => {
      const tracker = new LatencyTracker();
      tracker.arm();
      tracker.sample(8000);
      tracker.sample(null);
      expect(tracker.current).toBeNull();
      expect(tracker.max).toBe(8000);
      tracker.reset();
      expect(tracker.max).toBeNull();
      tracker.sample(100);
      expect(tracker.max).toBeNull();
    });
  });

  it('counts the live-edge seeks of the latest load only', () => {
    const events = tl(
      ['load-requested', 0],
      ['live-edge-seek', 500],
      ['live-edge-seek', 900],
      ['load-requested', 2000],
      ['live-edge-seek', 3000],
    );
    expect(computeMetrics({ ...baseInput(), events }).live.edgeSeeks).toBe(1);
  });
});

describe('catching up to the live edge', () => {
  const facts: SeekFacts = {
    isLive: true,
    firstFrameSeen: true,
    requestedByViewer: false,
    fromTime: 100,
    toTime: 116,
    seekRangeEnd: 117,
  };

  it('is a forward jump the viewer did not ask for that lands near the end of the seek range', () => {
    expect(isLiveEdgeCatchUp(facts)).toBe(true);
    expect(isLiveEdgeCatchUp({ ...facts, toTime: 114.5 })).toBe(true);
  });

  it.each<[string, Partial<SeekFacts>]>([
    ['a seek the viewer asked for (qa.seek, qa.seekToLiveEdge)', { requestedByViewer: true }],
    ['the initial positioning, before the first frame', { firstFrameSeen: false }],
    ['a VOD seek', { isLive: false }],
    ['a backward seek', { toTime: 90 }],
    ['a small forward jump such as a gap jump', { toTime: 100.4, seekRangeEnd: 101 }],
    ['a jump that lands far from the edge (the DVR window moved past the playhead)', { toTime: 108 }],
    ['an unknown starting point', { fromTime: null }],
    ['an unknown seek range', { seekRangeEnd: null }],
  ])('is not %s', (_name, change) => {
    expect(isLiveEdgeCatchUp({ ...facts, ...change })).toBe(false);
  });
});

describe('buffered ahead', () => {
  const ranges = (...pairs: Array<[number, number]>) => ({
    length: pairs.length,
    start: (i: number) => pairs[i]?.[0] ?? Number.NaN,
    end: (i: number) => pairs[i]?.[1] ?? Number.NaN,
  });

  it('is the distance to the end of the buffered range that holds the playhead', () => {
    expect(bufferedAheadSec(ranges([0, 10]), 4)).toBe(6);
    expect(bufferedAheadSec(ranges([0, 4], [6, 20]), 7)).toBe(13);
  });

  it('is 0 in a gap, past the end, and with nothing buffered', () => {
    expect(bufferedAheadSec(ranges([0, 4], [6, 20]), 5)).toBe(0);
    expect(bufferedAheadSec(ranges([0, 4]), 4.5)).toBe(0);
    expect(bufferedAheadSec(ranges(), 0)).toBe(0);
  });

  it('treats a playhead a hair before the first buffered frame as inside, as Shaka does', () => {
    expect(bufferedAheadSec(ranges([0.04, 10]), 0)).toBeCloseTo(10, 6);
    expect(bufferedAheadSec(ranges([0.5, 10]), 0)).toBe(0);
  });
});

describe('FrameWindow', () => {
  /** 30 fps content: a frame every 1/30 s, presentedFrames counting up. */
  function feed(window: FrameWindow, frames: number, start = 0, withCounter = true): boolean {
    let done = false;
    for (let i = 0; i < frames && !done; i++) {
      done = window.push({
        mediaTime: start + i / 30,
        ...(withCounter ? { presentedFrames: 100 + i } : {}),
      });
    }
    return done;
  }

  it('measures 30 fps over five media seconds from the engine counter', () => {
    const window = new FrameWindow(5);
    expect(feed(window, 151)).toBe(true);
    const result = window.result({ decoded: 152, dropped: 2 });
    expect(result.presented).toBe(150);
    expect(result.mediaSeconds).toBeCloseTo(5, 10);
    expect(result.fps).toBeCloseTo(30, 6);
    expect(result).toMatchObject({ decoded: 152, dropped: 2 });
  });

  it('is complete only when the media clock has advanced by the window, and the elapsed time is the real one', () => {
    const window = new FrameWindow(1);
    expect(feed(window, 20)).toBe(false);
    // the callback that completes the window arrives late: 1.1 s of media time have passed, and fps divides by that
    expect(window.push({ mediaTime: 19 / 30 + 0.5, presentedFrames: 100 + 20 + 15 })).toBe(true);
    const result = window.result({ decoded: 0, dropped: 0 });
    expect(result.mediaSeconds).toBeCloseTo(19 / 30 + 0.5, 10);
    expect(result.presented).toBe(35);
    expect(result.fps).toBeCloseTo(35 / (19 / 30 + 0.5), 6);
  });

  it('counts the frames a busy main thread coalesced into one callback, which a callback counter would miss', () => {
    const counted = new FrameWindow(1);
    const callbackOnly = new FrameWindow(1);
    // 31 media frames, but only every second callback is delivered: presentedFrames still advances by 2
    for (let i = 0; i <= 30; i += 2) {
      counted.push({ mediaTime: i / 30, presentedFrames: i });
      callbackOnly.push({ mediaTime: i / 30 });
    }
    expect(counted.result({ decoded: 0, dropped: 0 }).presented).toBe(30);
    expect(callbackOnly.result({ decoded: 0, dropped: 0 }).presented).toBe(15);
  });

  it('counts callbacks when the engine has no running counter', () => {
    const window = new FrameWindow(1);
    expect(feed(window, 31, 0, false)).toBe(true);
    expect(window.result({ decoded: 0, dropped: 0 }).presented).toBe(30);
  });

  it('reports no frame count and no fps when it only has a clock to go by', () => {
    const window = new FrameWindow(1, false);
    expect(feed(window, 31)).toBe(true);
    expect(window.result({ decoded: 31, dropped: 0 })).toMatchObject({
      presented: null,
      fps: null,
      decoded: 31,
    });
  });

  it('refuses a window measured across a seek or a jump of the media clock', () => {
    const forward = new FrameWindow(5);
    forward.push({ mediaTime: 10 });
    forward.push({ mediaTime: 10.03 });
    expect(() => forward.push({ mediaTime: 10.03 + MAX_FRAME_GAP_SEC + 0.1 })).toThrow(/media clock jumped/);

    const backward = new FrameWindow(5);
    backward.push({ mediaTime: 10 });
    expect(() => backward.push({ mediaTime: 9 })).toThrow(/media clock jumped from 10.000 s to 9.000 s/);
  });

  it('accepts a long pause between frames that is not a jump of the clock (a stall shows as media time not advancing)', () => {
    const window = new FrameWindow(1);
    window.push({ mediaTime: 5, presentedFrames: 10 });
    expect(window.push({ mediaTime: 5.9, presentedFrames: 37 })).toBe(false);
    expect(window.push({ mediaTime: 6.0, presentedFrames: 40 })).toBe(true);
  });

  it('rejects a window that is not a positive number of seconds, and a result without samples', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FrameWindow(bad)).toThrow(RangeError);
    }
    expect(() => new FrameWindow(1).result({ decoded: 0, dropped: 0 })).toThrow(/no samples/);
  });
});

function baseInput(): MetricsInput {
  return {
    events: [],
    now: 1000,
    playback: {
      currentTime: 0,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 0,
      readyState: 4,
    },
    frames: { decoded: 0, dropped: 0, presented: null },
    variant: null,
    live: { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null },
  };
}

describe('computeMetrics', () => {
  it('assembles the whole snapshot from the timeline and the element', () => {
    const variant: VariantInfo = {
      id: 2,
      bandwidth: 800_000,
      width: 640,
      height: 360,
      videoCodec: 'vp09.00.10.08',
      audioCodec: 'mp4a.40.2',
    };
    const events = tl(
      ...START,
      ['variant-changed', 450, { from: null, to: 2, height: 360, reason: 'start' }],
      ['buffering-start', 3000, undefined, 2.5],
      ['buffering-end', 3800],
    );
    const metrics = computeMetrics({
      ...baseInput(),
      events,
      now: 6000,
      frames: { decoded: 200, dropped: 3, presented: 197 },
      variant,
      live: { isLive: true, latencyMs: 6100, latencyMaxMs: 7200, presentationDelayMs: 6000 },
    });
    expect(metrics.state).toBe('playing');
    expect(metrics.startupMs).toBe(420);
    expect(metrics.startup).toEqual({ manifestMs: 40, loadedMs: 150 });
    expect(metrics.rebuffer.count).toBe(1);
    expect(metrics.frames).toEqual({ decoded: 200, dropped: 3, droppedRatio: 0.015, presented: 197 });
    expect(metrics.bitrate).toMatchObject({ switches: 0, current: variant });
    expect(metrics.live).toEqual({
      isLive: true,
      latencyMs: 6100,
      latencyMaxMs: 7200,
      presentationDelayMs: 6000,
      edgeSeeks: 0,
    });
    expect(metrics.errors).toEqual([]);
  });

  it('has a dropped ratio of 0 when nothing was decoded, and no startup before the first frame', () => {
    const metrics = computeMetrics({
      ...baseInput(),
      events: tl(['load-requested', 0], ['manifest-loaded', 30]),
      frames: { decoded: 0, dropped: 0, presented: null },
    });
    expect(metrics.frames.droppedRatio).toBe(0);
    expect(metrics.startupMs).toBeNull();
    expect(metrics.startup).toEqual({ manifestMs: 30, loadedMs: null });
    expect(metrics.state).toBe('loading');
  });
});
