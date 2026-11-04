import { describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../../../tests/e2e/support/player.ts';
import type { TestSession } from '../../../tests/e2e/support/session.ts';
import {
  END_TOLERANCE_SEC,
  SEEK_LANDING_TOLERANCE_SEC,
  UNBUFFERED_FROM_SEC,
} from '../../../tests/e2e/vod/tolerances.ts';
import { expectEndedAtTheEnd } from '../../../tests/e2e/vod/ending.ts';
import { failure } from '../../../tests/e2e/vod/fail.ts';
import {
  originStartupSpanMs,
  sinceLoadRequested,
  videoFrameRate,
} from '../../../tests/e2e/vod/instrument.ts';
import {
  expectClockContinued,
  expectLanded,
  farTarget,
  fetchedAgain,
  rapidTargets,
  refetched,
  seekAndRecord,
} from '../../../tests/e2e/vod/seeking.ts';
import {
  allSegments,
  distinctAscending,
  middleOfSegment,
  repsOfTrack,
  segmentCovering,
  segmentNumbers,
} from '../../../tests/e2e/vod/segments.ts';

// The arithmetic and the readings of the log that the VOD specs' oracles stand on: a mistake here would make a spec pass for the wrong
// reason, which no browser run would show.

function stream(segmentCount: number, audio = 'a-aac'): StreamInfo {
  const video = (id: string, height: number) => ({
    id,
    track: 'video' as const,
    mimeType: 'video/mp4' as const,
    codecs: 'vp09.00.10.08',
    bandwidth: height * 2500,
    height,
    frameRate: 30,
    initExt: 'mp4' as const,
    segmentExt: 'm4s' as const,
  });
  return {
    id: 'vod-cmaf',
    kind: 'vod',
    packaging: 'cmaf',
    protocols: ['dash', 'hls'],
    segmentDurationSec: 2,
    segmentCount,
    durationSec: segmentCount * 2,
    reps: [
      video('v240', 240),
      video('v360', 360),
      video('v720', 720),
      {
        id: audio,
        track: 'audio',
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
        bandwidth: 64_000,
        initExt: 'mp4',
        segmentExt: 'm4s',
      },
    ],
    contentHash: 'x',
    ffmpegVersion: 'x',
  };
}

let seq = 0;
function request(rep: string, number: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  seq += 1;
  return {
    seq,
    t: '2030-01-01T00:00:00.000Z',
    msSinceStart: seq * 10,
    method: 'GET',
    path: `/s/x/vod-cmaf/dash/seg/${rep}/${number}.m4s`,
    kind: 'segment',
    rep,
    number,
    status: 200,
    bytes: 1000,
    ttfbMs: 1,
    totalMs: 2,
    faults: [],
    ...overrides,
  };
}

describe('segment arithmetic', () => {
  const info = stream(30);

  it('numbers segments from 1, a segment covering [(k - 1) d, k d)', () => {
    expect(segmentCovering(info, 0)).toBe(1);
    expect(segmentCovering(info, 1.999)).toBe(1);
    expect(segmentCovering(info, 2)).toBe(2);
    expect(segmentCovering(info, 41)).toBe(21);
    expect(segmentCovering(info, 59.9)).toBe(30);
  });

  it('puts a target in the middle of a segment, a whole second from either boundary of 2 s segments', () => {
    expect(middleOfSegment(info, 1)).toBe(1);
    expect(middleOfSegment(info, 4)).toBe(7);
    expect(middleOfSegment(info, 30)).toBe(59);
    expect(segmentCovering(info, middleOfSegment(info, 21))).toBe(21);
  });

  it('lists a title segments and de-duplicates a log', () => {
    expect(allSegments(3)).toEqual([1, 2, 3]);
    expect(distinctAscending([3, 1, 3, 2, 1])).toEqual([1, 2, 3]);
  });

  it('collects the numbers of a track over every representation of it, and not of the other track', () => {
    const log = [request('v360', 1), request('a-aac', 1), request('v720', 2), request('a-aac', 2)];
    expect(segmentNumbers(log, info, 'video')).toEqual([1, 2]);
    expect(segmentNumbers(log, info, 'audio')).toEqual([1, 2]);
    expect(repsOfTrack(stream(15, 'a-opus'), 'audio')).toEqual(['a-opus']);
    expect(
      segmentNumbers([request('v720', 1, { status: 404 }), request('v720', 2)], info, 'video', {
        status: 'ok',
      }),
    ).toEqual([2]);
  });
});

describe('the targets of the seek specs', () => {
  it('puts the far target two thirds in, in the middle of a segment: 41 s of the 60 s title, 21 s of the 30 s one', () => {
    expect(farTarget(stream(30))).toBe(41);
    expect(farTarget(stream(15))).toBe(21);
  });

  it('gives five rapid targets that are all beyond what a player a few seconds in has buffered and before the last segment, in the middle of a segment, each in another segment, the last one different from the others', () => {
    for (const info of [stream(30), stream(15)]) {
      const targets = rapidTargets(info);
      expect(targets).toHaveLength(5);
      expect(new Set(targets.map((target) => segmentCovering(info, target))).size).toBe(5);
      for (const target of targets) {
        expect(target).toBeGreaterThan(UNBUFFERED_FROM_SEC);
        expect(target).toBeLessThan(info.durationSec - info.segmentDurationSec);
        expect(target % 2).toBe(1);
      }
    }
    expect(rapidTargets(stream(30))).toEqual([57, 17, 47, 27, 37]);
    expect(rapidTargets(stream(15))).toEqual([27, 17, 25, 19, 23]);
  });
});

describe('what counts as a refetch', () => {
  const info = stream(30);
  const before = [request('v720', 1), request('v720', 2), request('a-aac', 1), request('v720', 3)];

  it('is the same segment of the same representation asked for again, after the point', () => {
    const after = [request('v720', 2), request('v720', 21)];
    expect(refetched(info, 'video', { before, after })).toEqual(['v720#2']);
  });

  it('is not the same number from another representation: that is the adaptation climbing a rung', () => {
    const lower = [request('v360', 1), request('v360', 2)];
    const after = [request('v720', 2), request('v720', 3)];
    expect(refetched(info, 'video', { before: lower, after })).toEqual([]);
    // but it is a number the buffer did not hold, which is what the way back of PB-VOD-008 looks at
    expect(fetchedAgain(info, 'video', { before: lower, after })).toEqual([2]);
  });

  it('does not mix tracks, and counts a request that failed or is still in flight as asked for', () => {
    const after = [request('a-aac', 1), request('v720', 3, { status: 0, pending: true })];
    expect(refetched(info, 'video', { before, after })).toEqual(['v720#3']);
    expect(refetched(info, 'audio', { before, after })).toEqual(['a-aac#1']);
    expect(fetchedAgain(info, 'video', { before, after: [request('a-aac', 2)] })).toEqual([]);
  });
});

describe('the startup the origin says the player cannot have beaten', () => {
  const info = stream(30);
  const manifest = (msSinceStart: number): RequestLogEntry =>
    request('', 0, {
      kind: 'manifest',
      rep: undefined,
      number: undefined,
      path: '/s/x/vod-cmaf/dash/manifest.mpd',
      msSinceStart,
    });

  it('runs from the arrival of the manifest to the end of the first video segment delivered', () => {
    const log = [
      manifest(100),
      request('a-aac', 1, { msSinceStart: 120, totalMs: 1 }),
      request('v360', 1, { msSinceStart: 125, totalMs: 4.5 }),
      request('v720', 1, { msSinceStart: 400, totalMs: 3 }),
    ];
    expect(originStartupSpanMs(log, info)).toBeCloseTo(29.5, 6);
  });

  it('ignores a first segment that was not delivered, and says what is missing when there is nothing to measure against', () => {
    const log = [
      manifest(100),
      request('v360', 1, { msSinceStart: 105, totalMs: 1, status: 503 }),
      request('v720', 1, { msSinceStart: 130, totalMs: 2 }),
    ];
    expect(originStartupSpanMs(log, info)).toBe(32);
    expect(() => originStartupSpanMs([request('v720', 1)], info)).toThrow(
      /no manifest request or no delivered first video segment/,
    );
  });

  it('reads the frame rate of the video from the catalog, one for every rung, and the startup from the raw events', () => {
    expect(videoFrameRate(stream(30))).toBe(30);
    const mixed = stream(30);
    const slower = mixed.reps.find((rep) => rep.id === 'v240');
    if (slower) slower.frameRate = 24;
    expect(() => videoFrameRate(mixed)).toThrow(/one frame rate/);
    const events = [
      { name: 'load-requested', t: 100 },
      { name: 'manifest-loaded', t: 112.5 },
      { name: 'firstframe', t: 340 },
    ];
    expect(sinceLoadRequested(events, 'firstframe')).toBe(240);
    expect(sinceLoadRequested(events, 'loaded')).toBeNull();
    expect(sinceLoadRequested([{ name: 'firstframe', t: 5 }], 'firstframe')).toBeNull();
  });
});

describe('the assertions of the helpers', () => {
  it('accept a landing, an end and a clock inside their tolerances and refuse the ones outside, saying the distance', () => {
    expect(() => expectLanded({ mediaTime: 41 + SEEK_LANDING_TOLERANCE_SEC }, 41)).not.toThrow();
    expect(() => expectLanded({ mediaTime: 40 }, 41)).toThrow(
      /distance in seconds between the media time of the seeked event \(40 s\) and the target \(41 s\)/,
    );
    const info = stream(6);
    expect(() =>
      expectEndedAtTheEnd({ mediaTime: info.durationSec - END_TOLERANCE_SEC }, info),
    ).not.toThrow();
    expect(() => expectEndedAtTheEnd({ mediaTime: 10 }, info)).toThrow(/ended.*\(10 s\).*\(12 s\)/);
    expect(() => expectClockContinued(42.01, 42, 'the clock jumped')).not.toThrow();
    expect(() => expectClockContinued(60, 42, 'the clock jumped after the seek')).toThrow(
      /media time reached \(60 s\) beyond the 42 s.*the clock jumped after the seek/,
    );
  });

  it('fail at the line of the caller: the frames of the helper folders are not in the stack', () => {
    const stackOf = (call: () => void): string => {
      try {
        call();
      } catch (error) {
        return (error as Error).stack ?? '';
      }
      return '';
    };
    for (const stack of [stackOf(() => expectLanded({ mediaTime: 0 }, 41)), failure('x').stack ?? '']) {
      expect(stack).toContain('helpers.test.ts');
      expect(stack).not.toMatch(/tests[\\/]e2e[\\/]vod[\\/]/);
    }
  });

  it('say, when a seek never finishes, what the origin was asked for and answered since the seek', async () => {
    const log = [
      request('v720', 29, { seq: 40, status: 200 }),
      request('v720', 30, { seq: 41, status: 404, faults: ['f1'] }),
    ];
    const session = { id: 's1', service: { log: () => Promise.resolve(log) } } as unknown as TestSession;
    const qa = {
      cursor: () => Promise.resolve(7),
      seek: () => Promise.reject(new Error("qa.waitFor('seeked') timed out after 20000 ms")),
    } as unknown as PlayerHandle;
    const failed = seekAndRecord(qa, 59, { session, logCursor: 40 });
    await expect(failed).rejects.toThrow(/timed out after 20000 ms/);
    await expect(failed).rejects.toThrow(
      /asked for 1 requests since the seek, the last 1:\n {2}#41 GET segment v720 #30 -> 404 in 2 ms \[faults f1\]/,
    );
    const quiet = {
      id: 's1',
      service: { log: () => Promise.resolve([request('v720', 29, { seq: 40 })]) },
    } as unknown as TestSession;
    await expect(seekAndRecord(qa, 59, { session: quiet, logCursor: 40 })).rejects.toThrow(
      /was not asked for anything since the seek/,
    );
  });
});
