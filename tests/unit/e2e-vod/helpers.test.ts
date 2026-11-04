import { describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent, QAEventName } from '../../../src/shared/qa.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import type { PlayerHandle } from '../../../tests/e2e/support/player.ts';
import type { TestSession } from '../../../tests/e2e/support/session.ts';
import {
  END_TOLERANCE_SEC,
  FRAME_AGREEMENT_TOLERANCE,
  UNBUFFERED_FROM_SEC,
} from '../../../tests/e2e/vod/tolerances.ts';
import { expectEndedAtTheEnd } from '../../../tests/e2e/vod/ending.ts';
import { failure } from '../../../tests/e2e/vod/fail.ts';
import {
  framesUnaccountedFor,
  originStartupSpanMs,
  sinceLoadRequested,
  videoFrameRate,
} from '../../../tests/e2e/vod/instrument.ts';
import {
  expectClockContinued,
  expectClockPace,
  expectLanded,
  farTarget,
  fetchedAgain,
  rapidTargets,
  refetched,
  seekAndRecord,
  stopwatch,
} from '../../../tests/e2e/vod/seeking.ts';
import {
  allSegments,
  distinctAscending,
  middleOfSegment,
  repsOfTrack,
  segmentCovering,
  segmentNumbers,
} from '../../../tests/e2e/vod/segments.ts';
import { describePlayerTrouble, playAfterEnded, waitForFirstFrame } from '../../../tests/e2e/vod/trouble.ts';

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

const at = (name: QAEventName, t: number, mediaTime: number, index = 0): QAEvent => ({
  index,
  t,
  name,
  mediaTime,
});

// The positions a spec reads from a player are read when the page, or the call into it, gets to them, and a starved page gets to them
// seconds late (ADR-092). Every number below is either a reading of the first CI run on a 3-CPU macOS runner (run 41784609878, merge
// gate; 41784609875, release) or a synthetic case of the same shape.
describe('where the clock may be when it is read: the wall clock it had to run in, not a distance', () => {
  const info = stream(30);

  describe('a landing after a seek', () => {
    it('accepts a landing read on time: the clock at the target, within a frame, a few hundred milliseconds after the call', () => {
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1250, 41.0003), wallMs: 310 },
          41,
          info,
        ),
      ).not.toThrow();
      // the largest landing past the target measured in the four engines (Linux WebKit, 0.049 s) with the wall clock it had
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1300, 41.049), wallMs: 350 },
          41,
          info,
        ),
      ).not.toThrow();
    });

    it('accepts a seeked that the page recorded late, while the clock ran at rate 1 (the page was blocked after the seek finished)', () => {
      // seeking on time at page time 1000 ms; the page blocked for 3 s; seeked recorded at 4200 ms reads 44 s; seek() took 3.4 s
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 4200, 44), wallMs: 3400 },
          41,
          info,
        ),
      ).not.toThrow();
      // the page was blocked before it recorded the seeking too: both events of one burst, both reading the clock late
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 4190, 43.99), seeked: at('seeked', 4200, 44), wallMs: 3400 },
          41,
          info,
        ),
      ).not.toThrow();
    });

    it("accepts the landings of the first macOS CI run that the player's stall detector had nudged by 0.1 s for every second the seek waited", () => {
      // PB-VOD-007: seeking 41 s at page time 3715 ms, four nudges (41.1, 41.2, 41.3, 41.4), seeked at 41.4 s at 15218 ms
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 3715, 41), seeked: at('seeked', 15218, 41.4), wallMs: 11700 },
          41,
          info,
        ),
      ).not.toThrow();
      // PB-VOD-009: the last of the five seeks, 37 s at 4413 ms (nudged at 5503, 6512, 7516), seeked at 37.3 s at 8667 ms
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 4413, 37), seeked: at('seeked', 8667, 37.3), wallMs: 4400 },
          37,
          info,
        ),
      ).not.toThrow();
    });

    it('refuses a landing at the start of its segment, a second early, however late it was read', () => {
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1250, 40), wallMs: 310 },
          41,
          info,
        ),
      ).toThrow(
        /media time of the seeked event after a seek to 41 s: it is before the 41 s the clock started from/,
      );
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 4200, 40), wallMs: 3400 },
          41,
          info,
        ),
      ).toThrow(/it is before the 41 s the clock started from/);
    });

    it("refuses a seek that skipped ahead to the next segment, by the wall clock of the call and by the page's own two readings", () => {
      // 42 s a second past the target, 310 ms after the call: the wall clock of the test says the clock could not have run that far
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 42), seeked: at('seeked', 1250, 42), wallMs: 310 },
          41,
          info,
        ),
      ).toThrow(/it is past the 41 s the clock started from by more than the 310 ms of wall clock/);
      // the slow round trips of a loaded runner widen the wall bracket to 3.4 s, but the page recorded both events 250 ms apart
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1250, 42), wallMs: 3400 },
          41,
          info,
        ),
      ).toThrow(
        /the clock cannot have run past it by more than the 250 ms of the page's own clock between the two/,
      );
    });
  });

  describe('the clock after a wait, a resume or a restart', () => {
    it('accepts what a wait returned late: PB-VOD-006 of the first macOS CI run waited for 8 s and got 11.414 s, 4.6 s after the seek to 7 s', () => {
      expect(() =>
        expectClockContinued(
          { from: 7, to: 11.414253958, wallMs: 4600 },
          info,
          'the clock jumped after the seek',
        ),
      ).not.toThrow();
      expect(() =>
        expectClockContinued({ from: 7, to: 8.03, wallMs: 1350 }, info, 'the clock jumped after the seek'),
      ).not.toThrow();
    });

    it('refuses a clock that jumped ahead of the wall clock, and says what the failure means', () => {
      expect(() =>
        expectClockContinued({ from: 7, to: 9.5, wallMs: 1400 }, info, 'the clock jumped after the seek'),
      ).toThrow(
        /media time reached \(9.5 s\) after 7 s, the clock jumped after the seek: it is past the 7 s/,
      );
    });

    it('holds a restart to the beginning and a resume to the position of the pause, whenever the playing event was read', () => {
      const restart = 'media time of the playing event after play()';
      expect(() => expectClockPace({ from: 0, to: 0.074, wallMs: 400 }, info, restart)).not.toThrow();
      expect(() => expectClockPace({ from: 0, to: 2.9, wallMs: 3100 }, info, restart)).not.toThrow();
      expect(() => expectClockPace({ from: 0, to: 12, wallMs: 1300 }, info, restart)).toThrow(
        /media time of the playing event after play\(\): it is past the 0 s the clock started from by more than the 1300 ms/,
      );
      const resume = 'media time of the playing event after the resume';
      expect(() => expectClockPace({ from: 3.5, to: 3.55, wallMs: 200 }, info, resume)).not.toThrow();
      expect(() => expectClockPace({ from: 3.5, to: 2, wallMs: 300 }, info, resume)).toThrow(
        /it is before the 3.5 s the clock started from/,
      );
    });

    it('measures the wall clock of this process with a stopwatch that only goes forward', () => {
      const elapsed = stopwatch();
      const first = elapsed();
      expect(first).toBeGreaterThanOrEqual(0);
      expect(elapsed()).toBeGreaterThanOrEqual(first);
    });
  });

  // The clock is not wall-synchronous right after a restart: in the nightly of run 41793007785 (Linux), PB-VOD-005 failed both attempts in Chromium
  // because the `playing` event after the resume read 60.5 ms and 49.1 ms past the paused position, 10 ms and 8 ms of wall clock after
  // the call, and the first version of the bound did not allow for a step.
  describe('the step the clock takes when it restarts', () => {
    const resume = 'media time of the playing event after the resume';

    it('accepts the steps measured at a resume, in every engine, and the clock read a second later', () => {
      // Chromium on Linux, the two failed attempts: the events' own media times and the wall clock of the call
      expect(() => expectClockPace({ from: 3.000375, to: 3.060896, wallMs: 10 }, info, resume)).not.toThrow();
      expect(() => expectClockPace({ from: 2.991299, to: 3.040366, wallMs: 8 }, info, resume)).not.toThrow();
      // the largest steps of the other engines (Firefox once 101 ms, Linux WebKit 79 ms), with the little wall clock a call can take
      expect(() => expectClockPace({ from: 3, to: 3.101, wallMs: 25 }, info, resume)).not.toThrow();
      expect(() => expectClockPace({ from: 3, to: 3.0792, wallMs: 20 }, info, resume)).not.toThrow();
      // a second later the clock is 1.06 s past the pause in 1.01 s of wall clock: the step is still in it
      expect(() =>
        expectClockContinued({ from: 3.000375, to: 4.06, wallMs: 1010 }, info, 'the clock jumped forward'),
      ).not.toThrow();
    });

    it('accepts a landing read right after the clock restarted at it', () => {
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1020, 41.06), wallMs: 40 },
          41,
          info,
        ),
      ).not.toThrow();
    });

    it('still refuses a jump: a resume that skipped a segment or two, one that went back to the start of its GOP or of the title', () => {
      const skipped = /it is past the 3 s the clock started from by more than the 10 ms of wall clock/;
      expect(() => expectClockPace({ from: 3, to: 4, wallMs: 10 }, info, resume)).toThrow(skipped);
      expect(() => expectClockPace({ from: 3, to: 5, wallMs: 10 }, info, resume)).toThrow(skipped);
      expect(() => expectClockPace({ from: 3, to: 2, wallMs: 10 }, info, resume)).toThrow(
        /it is before the 3 s the clock started from/,
      );
      expect(() => expectClockPace({ from: 3, to: 0, wallMs: 10 }, info, resume)).toThrow(
        /it is before the 3 s the clock started from/,
      );
      expect(() => expectClockContinued({ from: 3, to: 6, wallMs: 1000 }, info, 'the clock jumped')).toThrow(
        /media time reached \(6 s\) after 3 s, the clock jumped: it is past the 3 s/,
      );
      // a landing a second ahead within 20 ms of the page clock, whatever the wall bracket
      expect(() =>
        expectLanded(
          { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1020, 42), wallMs: 3400 },
          41,
          info,
        ),
      ).toThrow(/the clock cannot have run past it by more than the 20 ms of the page's own clock/);
    });
  });

  describe('the frames of the counters', () => {
    it('counts the dropped frames as accounted for: the readings of the first macOS CI run, 22 and 24 short before, 10 and 3 after', () => {
      // presented 113 and decoded 135 with 12 dropped; presented 187 (and 12 frames before the first one) and decoded 223 with 21 dropped
      expect(framesUnaccountedFor({ decoded: 135, presented: 113, dropped: 12, beforeFirstFrame: 0 })).toBe(
        10,
      );
      expect(framesUnaccountedFor({ decoded: 223, presented: 187, dropped: 21, beforeFirstFrame: 12 })).toBe(
        3,
      );
      for (const unaccounted of [10, 3]) expect(unaccounted).toBeLessThanOrEqual(FRAME_AGREEMENT_TOLERANCE);
      expect(framesUnaccountedFor({ decoded: 135, presented: 113, dropped: 0, beforeFirstFrame: 0 })).toBe(
        22,
      );
    });

    it('reads the clean runs of the four engines as a few frames, and a counter that doubles or restarts as far more than the tolerance', () => {
      for (const clean of [
        { decoded: 156, presented: 152, dropped: 0, beforeFirstFrame: 0 }, // Chromium and WebKit
        { decoded: 153, presented: 155, dropped: 0, beforeFirstFrame: 0 }, // Firefox, the presented counter ahead
        { decoded: 153, presented: 150, dropped: 0, beforeFirstFrame: 4 }, // Linux WebKit, a slow first paint
      ]) {
        expect(framesUnaccountedFor(clean)).toBeLessThanOrEqual(5);
      }
      expect(
        framesUnaccountedFor({ decoded: 156, presented: 304, dropped: 0, beforeFirstFrame: 0 }),
      ).toBeGreaterThan(FRAME_AGREEMENT_TOLERANCE);
      expect(
        framesUnaccountedFor({ decoded: 156, presented: 60, dropped: 0, beforeFirstFrame: 0 }),
      ).toBeGreaterThan(FRAME_AGREEMENT_TOLERANCE);
    });
  });
});

describe('the assertions of the helpers', () => {
  it('accept an end inside its tolerance and refuse the one outside, saying the distance', () => {
    const info = stream(6);
    expect(() =>
      expectEndedAtTheEnd({ mediaTime: info.durationSec - END_TOLERANCE_SEC }, info),
    ).not.toThrow();
    expect(() => expectEndedAtTheEnd({ mediaTime: 10 }, info)).toThrow(/ended.*\(10 s\).*\(12 s\)/);
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
    const info = stream(30);
    const early = { seeking: at('seeking', 1000, 41), seeked: at('seeked', 1250, 0), wallMs: 310 };
    for (const stack of [stackOf(() => expectLanded(early, 41, info)), failure('x').stack ?? '']) {
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

  it('give the wall clock of a seek that finished, and the stopwatch to read it again after the wait that follows', async () => {
    const qa = {
      cursor: () => Promise.resolve(3),
      seek: () => Promise.resolve(),
      events: () => Promise.resolve([at('seeking', 10, 41, 3), at('seeked', 260, 41, 4)]),
    } as unknown as PlayerHandle;
    const seek = await seekAndRecord(qa, 41);
    expect(seek.seeking.index).toBe(3);
    expect(seek.seeked.mediaTime).toBe(41);
    expect(seek.wallMs).toBeGreaterThanOrEqual(0);
    expect(seek.elapsed()).toBeGreaterThanOrEqual(seek.wallMs);
  });
});

describe('what a failed precondition or action says about itself', () => {
  const metricsOf = (overrides: Record<string, unknown>) => () =>
    Promise.resolve({
      state: 'playing',
      errors: [],
      rebuffer: { count: 0, events: [] },
      playback: { currentTime: 4.8, duration: 60, paused: false, ended: false, readyState: 4 },
      frames: { decoded: 23, dropped: 0, presented: 1 },
      ...overrides,
    });
  const timedOut = () =>
    Promise.reject(new Error("qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0)."));

  it('names the critical error that ended the load, with when it came, when the wait for the first frame gave up (PB-VOD-006 of the release run: 4032 after 103 ms)', async () => {
    const qa = {
      waitFor: timedOut,
      events: () => Promise.resolve([at('load-requested', 5038, 0, 0), at('error', 5141, 0, 4)]),
      metrics: metricsOf({
        errors: [
          {
            t: 5141,
            code: 4032,
            codeName: 'CONTENT_UNSUPPORTED_BY_BROWSER',
            category: 4,
            severity: 2,
            source: 'load',
            message: 'MANIFEST.CONTENT_UNSUPPORTED_BY_BROWSER: Shaka Error 4032',
          },
        ],
      }),
    } as unknown as PlayerHandle;
    const waited = waitForFirstFrame(qa);
    await expect(waited).rejects.toThrow(
      /gave up on the load before the wait did[^]*error 4032 CONTENT_UNSUPPORTED_BY_BROWSER \(source load, critical\) 103 ms after the load was requested[^]*timed out after 15000 ms/,
    );
    const slow = {
      waitFor: timedOut,
      events: () => Promise.resolve([]),
      metrics: metricsOf({}),
    } as unknown as PlayerHandle;
    await expect(waitForFirstFrame(slow)).rejects.toThrow(
      /^qa.waitFor\('firstframe'\) timed out after 15000 ms/,
    );
    const started = {
      waitFor: () => Promise.resolve(at('firstframe', 300, 0, 8)),
    } as unknown as PlayerHandle;
    await expect(waitForFirstFrame(started)).resolves.toMatchObject({ name: 'firstframe' });
  });

  it('says what the element looked like, whether the player restarted by itself and what the origin was asked for when play() after the end is rejected (PB-VOD-011 of the release run)', async () => {
    const session = { id: 's1', service: { log: () => Promise.resolve([]) } } as unknown as TestSession;
    const from = { since: 12, logCursor: 0 };
    const aborted = () =>
      Promise.reject(new Error('qa.play() was rejected: AbortError: The operation was aborted..'));
    const neverRestarted = () =>
      Promise.reject(new Error("qa.waitFor('playing') timed out after 10000 ms (looking from index 12)."));
    const emptied = {
      play: aborted,
      waitFor: neverRestarted,
      metrics: metricsOf({
        playback: { currentTime: 0, duration: 0, paused: false, ended: false, readyState: 0 },
      }),
    } as unknown as PlayerHandle;
    const failed = playAfterEnded(emptied, session, from);
    await expect(failed).rejects.toThrow(/qa.play\(\) was rejected: AbortError/);
    await expect(failed).rejects.toThrow(
      /The element afterwards: readyState 0, duration 0 s, media time 0 s, paused false, ended false\. It has no media any more/,
    );
    await expect(failed).rejects.toThrow(
      /did not restart by itself either: no playing event within 10000 ms of the rejection/,
    );
    await expect(failed).rejects.toThrow(/The origin was not asked for anything since play\(\) was called/);
    const recovering = {
      play: aborted,
      waitFor: () => Promise.resolve(at('playing', 9000, 0.05, 20)),
      metrics: metricsOf({
        playback: { currentTime: 0.3, duration: 12, paused: false, ended: false, readyState: 1 },
      }),
    } as unknown as PlayerHandle;
    const reset = playAfterEnded(recovering, session, from);
    await expect(reset).rejects.toThrow(
      /readyState 1, duration 12 s, media time 0.3 s, paused false, ended false\.\n/,
    );
    await expect(reset).rejects.toThrow(
      /restarted by itself: a playing event at media time 0.05 s since play\(\) was called/,
    );
    const restarted = { play: () => Promise.resolve() } as unknown as PlayerHandle;
    await expect(playAfterEnded(restarted, session, from)).resolves.toBeUndefined();
  });

  it('adds the stalls and the errors of the player to a measurement that could not be made (PB-VOD-012 of the release run: one stall of 2838 ms at media time 0)', async () => {
    const qa = {
      metrics: metricsOf({
        state: 'playing',
        rebuffer: { count: 1, events: [{ startMs: 6897, durationMs: 2838, mediaTime: 0, ongoing: false }] },
      }),
    } as unknown as PlayerHandle;
    const said = await describePlayerTrouble(qa);
    expect(said).toContain('1 rebuffers (2838 ms at media time 0.000 s)');
    expect(said).toContain('0 errors');
    expect(said).toContain('23 decoded and 1 presented frames');
    const gone = { metrics: () => Promise.reject(new Error('page closed')) } as unknown as PlayerHandle;
    await expect(describePlayerTrouble(gone)).resolves.toBe('');
  });
});
