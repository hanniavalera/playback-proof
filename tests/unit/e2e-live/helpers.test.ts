import { describe, expect, it } from 'vitest';
import type { LiveClockInfo, RequestLogEntry } from '../../../src/shared/api.ts';
import { edgeAt, firstVideoSegmentRequest, liveClockOf, publishedEndSec } from '../../e2e/live/edge.ts';
import {
  advanceProblems,
  answeredManifest,
  fetchesVideoSegmentFrom,
  gapsBetween,
  rangeProblems,
} from '../../e2e/live/refresh.ts';
import type { Checkpoint } from '../../e2e/live/refresh.ts';
import { describeSeries, measuredLatencies, percentile, sampleLatency } from '../../e2e/live/series.ts';

// The helpers of the live specs (tests/e2e/live): they decide whether a spec passes, so they are checked without a browser. The cases
// are the ones where a wrong answer would make a spec pass for the wrong reason: the edge arithmetic at a segment boundary, what counts
// as a refresh, the limits of "inside the seek range", and how a series is summarised.

const AST = '2030-01-01T00:00:00.000Z';
const live: LiveClockInfo = {
  segmentDurationSec: 2,
  availabilityStartTime: AST,
  windowSegments: 15,
  presentationDelaySec: 6,
  edgeNumber: 15,
  stalled: false,
};
const at = (sinceAstMs: number): string => new Date(Date.parse(AST) + sinceAstMs).toISOString();

function entry(seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    seq,
    t: at(30_000 + seq * 100),
    msSinceStart: seq * 100,
    method: 'GET',
    path: '/s/x/live-cmaf/seg/v720/1.m4s',
    kind: 'segment',
    rep: 'v720',
    number: seq,
    status: 200,
    bytes: 1000,
    ttfbMs: 2,
    totalMs: 4,
    faults: [],
    ...overrides,
  };
}

describe('the edge, as the origin keeps it', () => {
  it('follows the contract formula, with the edge changing exactly on a segment boundary', () => {
    expect(edgeAt(live, at(30_000))).toBe(15);
    expect(edgeAt(live, at(29_999))).toBe(14);
    expect(edgeAt(live, at(31_999))).toBe(15);
    expect(edgeAt(live, at(32_000))).toBe(16);
    expect(edgeAt(live, Date.parse(AST) + 32_000)).toBe(16);
  });

  it('is never negative before the stream started', () => {
    expect(edgeAt(live, at(-5_000))).toBe(0);
  });

  it('puts the end of the published stream at edge x segment duration', () => {
    expect(publishedEndSec(live, 15)).toBe(30);
    expect(publishedEndSec(live, 0)).toBe(0);
  });

  it('refuses a session that has no live clock, naming its stream', () => {
    expect(() => liveClockOf({ id: 's1', stream: 'vod-cmaf' })).toThrow(/vod-cmaf.*no live clock/);
    expect(liveClockOf({ id: 's2', stream: 'live-cmaf', live })).toBe(live);
  });
});

describe('firstVideoSegmentRequest', () => {
  it('is the first video segment that arrived: not audio, not a manifest, not an init segment', () => {
    const log = [
      entry(1, { kind: 'manifest', rep: undefined, number: undefined }),
      entry(2, { kind: 'init', rep: 'v360', number: undefined }),
      entry(3, { rep: 'a-aac', number: 12 }),
      entry(4, { rep: 'v360', number: 13 }),
      entry(5, { rep: 'v720', number: 12 }),
    ];
    expect(firstVideoSegmentRequest(log)?.seq).toBe(4);
  });

  it('is undefined when only audio was asked for', () => {
    expect(firstVideoSegmentRequest([entry(1, { rep: 'a-aac', number: 3 })])).toBeUndefined();
    expect(firstVideoSegmentRequest([])).toBeUndefined();
  });
});

describe('what counts as a refresh', () => {
  const manifest = (seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry =>
    entry(seq, { kind: 'manifest', rep: undefined, number: undefined, ...overrides });

  it('is a manifest the origin has answered with a 200: not a pending one, not a refusal, not a segment', () => {
    const isRefresh = answeredManifest();
    expect(isRefresh(manifest(1))).toBe(true);
    expect(isRefresh(manifest(2, { pending: true, status: 0 }))).toBe(false);
    expect(isRefresh(manifest(3, { status: 503 }))).toBe(false);
    expect(isRefresh(entry(4))).toBe(false);
  });

  it('for HLS is a media playlist of the representations asked for, never the master playlist', () => {
    const isAudioRefresh = answeredManifest(['a-aac']);
    expect(isAudioRefresh(manifest(1, { rep: 'a-aac' }))).toBe(true);
    expect(isAudioRefresh(manifest(2, { rep: 'v720' }))).toBe(false);
    expect(isAudioRefresh(manifest(3))).toBe(false);
  });

  it('is measured between arrivals at the service', () => {
    expect(
      gapsBetween([
        manifest(1, { msSinceStart: 90 }),
        manifest(2, { msSinceStart: 2092 }),
        manifest(3, { msSinceStart: 4094 }),
      ]),
    ).toEqual([2002, 2002]);
    expect(gapsBetween([manifest(1)])).toEqual([]);
  });

  it('recognises a segment that only a refreshed manifest lists: video, at that number or later', () => {
    const wanted = fetchesVideoSegmentFrom(20);
    expect(wanted(entry(1, { rep: 'v720', number: 20 }))).toBe(true);
    expect(wanted(entry(2, { rep: 'v360', number: 25 }))).toBe(true);
    expect(wanted(entry(3, { rep: 'v720', number: 19 }))).toBe(false);
    expect(wanted(entry(4, { rep: 'a-aac', number: 25 }))).toBe(false);
    expect(wanted(entry(5, { kind: 'init', rep: 'v720', number: undefined }))).toBe(false);
  });
});

describe('inside the seek range, at a checkpoint', () => {
  // Edge 20: the origin holds segments 6..20, that is [10 s, 40 s] of the stream; a healthy playhead is about 34 s, 6.2 s behind Shaka's edge.
  const healthy: Checkpoint = { refresh: 5, arrivedMs: 10_100, mediaTime: 34, latencyMs: 6200, edge: 20 };

  it('finds nothing wrong with a playhead that plays about six seconds behind the edge', () => {
    expect(rangeProblems(healthy, live)).toEqual([]);
  });

  it('flags a missing, zero or too large latency: not behind the edge, or behind it by more than the DVR window', () => {
    expect(rangeProblems({ ...healthy, latencyMs: null }, live)).toEqual([expect.stringContaining('null')]);
    expect(rangeProblems({ ...healthy, latencyMs: 0 }, live)).toEqual([
      expect.stringContaining('not behind the live edge'),
    ]);
    expect(rangeProblems({ ...healthy, latencyMs: 30_000 }, live)).toEqual([]);
    expect(rangeProblems({ ...healthy, latencyMs: 30_001 }, live)).toEqual([
      expect.stringContaining('DVR window'),
    ]);
  });

  it('flags a playhead outside what the origin holds, on either side, and accepts the boundaries', () => {
    expect(rangeProblems({ ...healthy, mediaTime: 10 }, live)).toEqual([]);
    expect(rangeProblems({ ...healthy, mediaTime: 9.99 }, live)).toEqual([
      expect.stringContaining('before the start of the origin'),
    ]);
    expect(rangeProblems({ ...healthy, mediaTime: 40 }, live)).toEqual([]);
    expect(rangeProblems({ ...healthy, mediaTime: 40.01 }, live)).toEqual([
      expect.stringContaining('past the edge the origin'),
    ]);
  });

  it('starts the origin window at zero while fewer segments than the window have been published', () => {
    expect(rangeProblems({ ...healthy, edge: 15, mediaTime: 0, latencyMs: 29_000 }, live)).toEqual([]);
  });
});

describe('playback going on between refreshes', () => {
  const point = (refresh: number, arrivedMs: number, mediaTime: number): Checkpoint => ({
    refresh,
    arrivedMs,
    mediaTime,
    latencyMs: 6200,
    edge: 15 + refresh,
  });

  it('accepts a player at 1x, and one that advanced exactly the share it was asked to', () => {
    expect(advanceProblems([point(1, 2000, 26), point(2, 4000, 28), point(3, 6000, 30)], 24, 0.5)).toEqual(
      [],
    );
    expect(advanceProblems([point(1, 2000, 26), point(2, 4000, 27)], 24, 0.5)).toEqual([]);
  });

  it('flags the interval in which the clock did not advance enough, naming the refresh', () => {
    expect(advanceProblems([point(1, 2000, 26), point(2, 4000, 26.9)], 24, 0.5)).toEqual([
      expect.stringContaining('refresh 2: the media clock advanced 0.90 s in the 2.00 s'),
    ]);
  });

  it('flags a clock that never left the first frame', () => {
    expect(advanceProblems([point(1, 2000, 24)], 24, 0.5)).toEqual([
      expect.stringContaining('still at the first frame'),
    ]);
  });
});

describe('a latency series', () => {
  it('has a nearest-rank percentile: the 95th of twenty samples is the nineteenth', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile(values, 100)).toBe(2000);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('keeps the unmeasured samples out of the numbers and shows them in the text', () => {
    const samples = [
      { mediaTime: 25, latencyMs: 6150.4 },
      { mediaTime: 26, latencyMs: null },
      { mediaTime: 27.01, latencyMs: 6149.6 },
    ];
    expect(measuredLatencies(samples)).toEqual([6150.4, 6149.6]);
    expect(describeSeries(samples, 24)).toBe('+1 s 6150 ms, +2 s n/a, +3 s 6150 ms');
    expect(describeSeries([], 24)).toBe('no samples');
  });

  it('is sampled on the media clock: one wait and one read per step, from the start of the window', async () => {
    const waits: number[] = [];
    let now = 24;
    const handle = {
      waitForMediaTime: (seconds: number): Promise<number> => {
        waits.push(seconds);
        now = seconds;
        return Promise.resolve(seconds);
      },
      metrics: () =>
        Promise.resolve({ playback: { currentTime: now }, live: { latencyMs: 6000 + now } }) as never,
    };
    const samples = await sampleLatency(handle, { from: 24, seconds: 4 });
    expect(waits).toEqual([25, 26, 27, 28]);
    expect(samples.map((sample) => sample.latencyMs)).toEqual([6025, 6026, 6027, 6028]);
    expect(await sampleLatency(handle, { from: 0, seconds: 4, stepSec: 2 })).toHaveLength(2);
  });
});
