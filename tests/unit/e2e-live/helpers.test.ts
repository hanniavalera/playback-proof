import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../../src/lab/service-client.ts';
import type { LiveClockInfo, RequestLogEntry, SessionDetail } from '../../../src/shared/api.ts';
import {
  deliveredVideoSegments,
  edgeAt,
  firstVideoSegmentRequest,
  liveClockOf,
  publishedEndSec,
  refusedRequests,
} from '../../e2e/live/edge.ts';
import {
  advanceProblems,
  answeredManifest,
  fetchesVideoSegmentFrom,
  gapsBetween,
  rangeProblems,
  readCheckpoints,
} from '../../e2e/live/refresh.ts';
import type { Checkpoint } from '../../e2e/live/refresh.ts';
import { describeSeries, measuredLatencies, percentile, sampleLatency } from '../../e2e/live/series.ts';
import type { TestSession } from '../../e2e/support/session.ts';

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

describe('what the origin refused and what it delivered', () => {
  const log = [
    entry(1, { number: 8 }),
    entry(2, { number: 9, status: 404 }),
    entry(3, { number: 10, aborted: true, bytes: 0 }),
    entry(4, { number: 11, status: 0, pending: true }),
    entry(5, { rep: 'a-aac', number: 12 }),
    entry(6, { number: 13, status: 503 }),
  ];

  it('counts an answer with an error status as a refusal, not a request the player abandoned or one still in flight', () => {
    expect(refusedRequests(log).map((request) => request.seq)).toEqual([2, 6]);
  });

  it('counts a video segment as delivered when it was answered with a 2xx and not abandoned', () => {
    expect(deliveredVideoSegments(log, ['v720'])).toEqual([8]);
    expect(deliveredVideoSegments(log, ['a-aac'])).toEqual([12]);
  });
});

describe('what counts as a refresh', () => {
  const manifest = (seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry =>
    entry(seq, { kind: 'manifest', rep: undefined, number: undefined, ...overrides });

  it('is a manifest the origin has answered with a 200: not a pending one, not an abandoned one, not a refusal, not a segment', () => {
    const isRefresh = answeredManifest();
    expect(isRefresh(manifest(1))).toBe(true);
    expect(isRefresh(manifest(2, { pending: true, status: 0 }))).toBe(false);
    expect(isRefresh(manifest(3, { status: 503 }))).toBe(false);
    expect(isRefresh(entry(4))).toBe(false);
    expect(isRefresh(manifest(5, { aborted: true, bytes: 0 }))).toBe(false);
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
      expect.stringContaining('refresh 2: the media clock advanced 0.90 s in the 2.00 s since refresh 1'),
    ]);
  });

  it('does not judge a few hundred milliseconds on their own: a burst of refreshes is folded into the next interval', () => {
    const burst = [point(1, 2000, 26), point(2, 2500, 26.5), point(3, 3000, 27), point(4, 4000, 28)];
    expect(advanceProblems(burst, 24, 0.5)).toEqual([]);
    // a stall inside a burst is still seen, over the folded interval
    const stalled = [point(1, 2000, 26), point(2, 2400, 26), point(3, 3000, 26.1)];
    expect(advanceProblems(stalled, 24, 0.5)).toEqual([
      expect.stringContaining('refresh 3: the media clock advanced 0.10 s in the 1.00 s since refresh 1'),
    ]);
  });

  it('flags a clock that never left the first frame', () => {
    expect(advanceProblems([point(1, 2000, 24)], 24, 0.5)).toEqual([
      expect.stringContaining('still at the first frame'),
    ]);
    expect(advanceProblems([], 24, 0.5)).toEqual([]);
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

  it('keeps what it measured when the clock stops, because that is the evidence of the stall', async () => {
    let reads = 0;
    const handle = {
      waitForMediaTime: (seconds: number): Promise<number> =>
        reads < 2
          ? Promise.resolve(seconds)
          : Promise.reject(new Error(`qa.waitForMediaTime(${seconds}) timed out`)),
      metrics: () => {
        reads += 1;
        return Promise.resolve({
          playback: { currentTime: 24 + reads },
          live: { latencyMs: 6100 + reads * 1000 },
        }) as never;
      },
    };
    await expect(sampleLatency(handle, { from: 24, seconds: 5 })).rejects.toThrow(
      /timed out[\s\S]*before the clock stopped: \+1 s 7100 ms, \+2 s 8100 ms/,
    );
  });
});

describe('readCheckpoints', () => {
  class FakeClient extends ServiceClient {
    constructor(
      private readonly entries: RequestLogEntry[],
      private readonly edge: number,
    ) {
      super('http://127.0.0.1:1');
    }
    override log(_id: string, since = 0): Promise<RequestLogEntry[]> {
      return Promise.resolve(this.entries.filter((e) => e.seq > since));
    }
    override detail(): Promise<SessionDetail> {
      return Promise.resolve({ live: { ...live, edgeNumber: this.edge } } as unknown as SessionDetail);
    }
  }

  // The answers of the origin, as `t`: the load at +90 ms after the stream had been on air for 30 s, then the given arrival times.
  const manifests = (arrivals: number[]): RequestLogEntry[] =>
    arrivals.map((ms, index) =>
      entry(index + 1, {
        kind: 'manifest',
        rep: undefined,
        number: undefined,
        msSinceStart: ms,
        t: at(30_000 + ms),
      }),
    );
  const readerOf = (arrivals: number[]) => {
    let time = 24;
    return {
      session: {
        id: 's1',
        stream: 'live-cmaf',
        live,
        service: new FakeClient(manifests(arrivals), 18),
      } as unknown as TestSession,
      qa: {
        metrics: () =>
          Promise.resolve({ playback: { currentTime: (time += 2) }, live: { latencyMs: 6200 } }) as never,
      },
    };
  };

  it('reads the player and the origin after each answered refresh, and ignores the answer that came with the load', async () => {
    const { session, qa } = readerOf([90, 2092, 4094, 6096]);
    const { checkpoints, answered, loadEdge } = await readCheckpoints(session, qa, {
      isRefresh: answeredManifest(),
      refreshes: 3,
      slideSegments: 3,
      live,
    });
    expect(answered).toHaveLength(4);
    expect(loadEdge).toBe(15);
    expect(checkpoints).toEqual([
      { refresh: 1, arrivedMs: 2092, mediaTime: 26, latencyMs: 6200, edge: 18 },
      { refresh: 2, arrivedMs: 4094, mediaTime: 28, latencyMs: 6200, edge: 18 },
      { refresh: 3, arrivedMs: 6096, mediaTime: 30, latencyMs: 6200, edge: 18 },
    ]);
  });

  it('goes on reading until the window has slid as far as it was asked to, when the refreshes came in a burst', async () => {
    // Five refreshes in the time of three segments: the fifth is at +6096 ms, which lists segment 18, three beyond the load's 15.
    const { session, qa } = readerOf([90, 2092, 4094, 4600, 5100, 6096]);
    const { checkpoints } = await readCheckpoints(session, qa, {
      isRefresh: answeredManifest(),
      refreshes: 3,
      slideSegments: 3,
      live,
    });
    expect(checkpoints.map((point) => point.refresh)).toEqual([1, 2, 3, 4, 5]);
  });
});
