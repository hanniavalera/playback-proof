import { describe, expect, it } from 'vitest';
import type { QAMetrics } from '../../../src/shared/qa.ts';
import {
  describeError,
  expectAtMostRebuffers,
  expectHealthyPlayback,
  expectNoErrors,
  expectNoRebuffer,
  playFor,
} from '../../../tests/e2e/support/assertions.ts';

// The assertions are what a red test shows a person, so the tests pin what the message says (the metric, the value) as well as
// whether it throws.

function metrics(overrides: Partial<QAMetrics> = {}): QAMetrics {
  return {
    state: 'playing',
    startupMs: 412,
    startup: { manifestMs: 40, loadedMs: 200 },
    rebuffer: { count: 0, totalMs: 0, ratio: 0, events: [] },
    frames: { decoded: 90, dropped: 0, droppedRatio: 0, presented: 89 },
    bitrate: { switches: 0, current: null, history: [] },
    live: { isLive: false, latencyMs: null, latencyMaxMs: null, presentationDelayMs: null, edgeSeeks: 0 },
    errors: [],
    playback: {
      currentTime: 3.2,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 8,
      readyState: 4,
    },
    ...overrides,
  };
}

const recoverable = {
  t: 1,
  code: 1001,
  category: 1,
  severity: 1,
  message: 'HTTP error 404',
  codeName: 'BAD_HTTP_STATUS',
  source: 'shaka',
};
const critical = {
  t: 2,
  code: 4032,
  category: 4,
  severity: 2,
  message: 'no variant plays',
  codeName: 'REQUESTED_ITEM_NOT_SUPPORTED',
};

describe('describeError', () => {
  it('names the code, its number, the severity and where it was caught', () => {
    expect(describeError(recoverable)).toBe('BAD_HTTP_STATUS (code 1001, severity 1, shaka): HTTP error 404');
    expect(describeError({ ...critical, source: 'load' })).toBe(
      'REQUESTED_ITEM_NOT_SUPPORTED (code 4032, severity 2, load): no variant plays',
    );
    expect(describeError({ t: 0, code: 0, category: 0, severity: 1, message: 'boom' })).toBe(
      'error (code 0, severity 1, shaka): boom',
    );
  });
});

describe('expectHealthyPlayback', () => {
  it('passes for a playing player with a startup time and decoded frames', () => {
    expect(() => expectHealthyPlayback(metrics())).not.toThrow();
  });

  it('allows a recoverable error (it is not "no error": see expectNoErrors) but not a critical one, and lists it', () => {
    expect(() => expectHealthyPlayback(metrics({ errors: [recoverable] }))).not.toThrow();
    expect(() => expectHealthyPlayback(metrics({ errors: [recoverable, critical] }))).toThrow(
      /critical player errors \(metrics\.errors with severity 2\)[\s\S]*REQUESTED_ITEM_NOT_SUPPORTED \(code 4032/,
    );
  });

  it.each([
    ['the error state', { state: 'error' as const }, /player state \(metrics\.state\)/],
    [
      'a startup time that is null',
      { startupMs: null },
      /startup time \(metrics\.startupMs\) is null: the first frame was never presented/,
    ],
    [
      'no decoded frame',
      { frames: { decoded: 0, dropped: 0, droppedRatio: 0, presented: 0 } },
      /decoded frames \(metrics\.frames\.decoded\)[\s\S]*Received:\s+0/,
    ],
  ])('fails on %s, naming the metric', (_label, overrides, message) => {
    expect(() => expectHealthyPlayback(metrics(overrides))).toThrow(message);
  });
});

describe('expectNoErrors', () => {
  it('is stricter: a recoverable error fails it, and the message shows what was caught', () => {
    expect(() => expectNoErrors(metrics())).not.toThrow();
    expect(() => expectNoErrors(metrics({ errors: [recoverable] }))).toThrow(/BAD_HTTP_STATUS \(code 1001/);
  });
});

describe('rebuffers', () => {
  const stalled = metrics({
    rebuffer: {
      count: 2,
      totalMs: 1840.4,
      ratio: 0.2,
      events: [
        { startMs: 5000, durationMs: 1200.2, mediaTime: 4.5, ongoing: false },
        { startMs: 9000, durationMs: 640.2, mediaTime: 8.25, ongoing: true },
      ],
    },
  });

  it('expectNoRebuffer lists every stall with its media time and duration', () => {
    expect(() => expectNoRebuffer(metrics())).not.toThrow();
    expect(() => expectNoRebuffer(stalled)).toThrow(
      /rebuffers \(metrics\.rebuffer\.count\): expected none, saw 2 totalling 1840 ms: at media time 4\.50 s for 1200 ms; at media time 8\.25 s for 640 ms \(ongoing\)/,
    );
  });

  it('expectAtMostRebuffers allows up to the limit and says the limit in the message', () => {
    expect(() => expectAtMostRebuffers(stalled, 2)).not.toThrow();
    expect(() => expectAtMostRebuffers(stalled, 1)).toThrow(/expected at most 1, saw 2 totalling/);
    expect(() => expectAtMostRebuffers(metrics(), 0)).not.toThrow();
  });
});

describe('playFor', () => {
  function fakePlayer(paused: boolean, currentTime = 5) {
    const calls: string[] = [];
    return {
      calls,
      metrics: async () => metrics({ playback: { ...metrics().playback, paused, currentTime } }),
      play: async () => void calls.push('play'),
      waitForMediaTime: async (seconds: number, options?: { timeoutMs?: number }) => {
        calls.push(`waitForMediaTime ${seconds} ${JSON.stringify(options)}`);
        return seconds + 0.04;
      },
    };
  }

  it('waits for the media clock to advance by the duration from where it is now, and returns the time reached', async () => {
    const player = fakePlayer(false, 5);
    await expect(playFor(player, 3, { timeoutMs: 9000 })).resolves.toBeCloseTo(8.04);
    expect(player.calls).toStrictEqual(['waitForMediaTime 8 {"timeoutMs":9000}']);
  });

  it('resumes a paused element first', async () => {
    const player = fakePlayer(true, 2);
    await playFor(player, 1);
    expect(player.calls).toStrictEqual(['play', 'waitForMediaTime 3 {}']);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s seconds: that is a mistake, not a wait',
    async (seconds) => {
      await expect(playFor(fakePlayer(false), seconds)).rejects.toThrow(RangeError);
    },
  );
});
