import { describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';
import {
  SHAKA_SWITCH_INTERVAL_S,
  droppedFramesNote,
  settleWindowSeconds,
  throttleOf,
  upshiftBoundSeconds,
} from '../../../tests/e2e/abr/conditions.ts';
import { orExplain, withExplanation } from '../../../tests/e2e/abr/explain.ts';
import { describeSegments, fromFirstOf, videoSegmentRequests } from '../../../tests/e2e/abr/log.ts';
import { describeVariantChanges, variantChanges } from '../../../tests/e2e/abr/variants.ts';

// The small pieces the ABR specs read their evidence with: the windows derived from Shaka's interval, the typed view of the hook's
// variant events, the video part of the request log, and the sentence in front of a failed wait.

describe('the windows derived from Shaka\u2019s switch interval', () => {
  it('a rung is settled after the interval and two segments, and a recovery shows within the interval and three', () => {
    expect(SHAKA_SWITCH_INTERVAL_S).toBe(8);
    expect(settleWindowSeconds(2)).toBe(12);
    expect(upshiftBoundSeconds(2)).toBe(14);
    expect(settleWindowSeconds(4)).toBe(16);
  });

  it('reads the one throttle of a profile and refuses zero or two links', () => {
    expect(throttleOf([{ type: 'throttle', kbps: 600, afterMs: 8000 }]).kbps).toBe(600);
    expect(() => throttleOf([])).toThrow(/exactly one throttle rule .* found 0/);
    expect(() =>
      throttleOf([
        { type: 'throttle', kbps: 600 },
        { type: 'throttle', kbps: 1500 },
      ]),
    ).toThrow(/found 2/);
    expect(
      throttleOf([
        { type: 'latency', ms: 300 },
        { type: 'throttle', kbps: 1500 },
      ]).kbps,
    ).toBe(1500);
  });

  it('names the other reason Shaka has to leave a rung, with the numbers of this load', () => {
    expect(droppedFramesNote({ decoded: 366, dropped: 13 })).toMatch(
      /15 % of the frames of a 2 s window .* 30 s\); dropped frames in this load: 13 of 366 \(3\.6 %\)/,
    );
    expect(droppedFramesNote({ decoded: 0, dropped: 0 })).toMatch(/0 of 0 \(0\.0 %\)/);
  });
});

function event(index: number, name: QAEvent['name'], detail?: Record<string, unknown>): QAEvent {
  return { index, t: index * 1000, name, mediaTime: index, ...(detail ? { detail } : {}) };
}

describe('variantChanges', () => {
  const start = event(2, 'variant-changed', {
    from: null,
    to: 2,
    bandwidth: 1845302,
    height: 720,
    reason: 'start',
  });
  const down = event(9, 'variant-changed', {
    from: 2,
    to: 0,
    bandwidth: 341878,
    height: 240,
    reason: 'abr',
  });

  it('takes the variant-changed events of a timeline, typed, and leaves the rest', () => {
    const changes = variantChanges([event(0, 'load-requested'), start, event(5, 'playing'), down]);
    expect(changes.map((c) => [c.height, c.reason, c.mediaTime, c.from, c.to])).toEqual([
      [720, 'start', 2, null, 2],
      [240, 'abr', 9, 2, 0],
    ]);
    expect(describeVariantChanges(changes)).toBe('720p start at 2.00 s, 240p abr at 9.00 s');
    expect(describeVariantChanges([])).toBe('none');
  });

  it('throws on an event the hook should never produce: the instrument is wrong, not the player', () => {
    expect(() =>
      variantChanges([event(1, 'variant-changed', { to: 2, height: 720, reason: 'abr' })]),
    ).toThrow(/not \{ from, to, bandwidth, height, reason \}/);
    expect(() =>
      variantChanges([
        event(1, 'variant-changed', { from: null, to: 2, bandwidth: 1, height: 720, reason: 'tuned' }),
      ]),
    ).toThrow(/not \{ from, to, bandwidth, height, reason \}/);
  });
});

function entry(
  seq: number,
  kind: RequestLogEntry['kind'],
  rep: string | undefined,
  number?: number,
): RequestLogEntry {
  return {
    seq,
    t: '2030-01-01T00:00:00.000Z',
    msSinceStart: seq * 10,
    method: 'GET',
    path: '/x',
    kind,
    ...(rep === undefined ? {} : { rep }),
    ...(number === undefined ? {} : { number }),
    status: 200,
    bytes: 1,
    ttfbMs: 1,
    totalMs: 1,
    faults: [],
  };
}

describe('the video part of the request log', () => {
  const log = [
    entry(1, 'manifest', undefined),
    entry(2, 'init', 'v720'),
    entry(3, 'segment', 'a-aac', 1),
    entry(4, 'segment', 'v720', 1),
    entry(5, 'segment', 'v720', 2),
    entry(6, 'segment', 'v240', 2),
    entry(7, 'segment', 'a-opus', 2),
  ];

  it('keeps video segment requests, in arrival order, and no audio, init or manifest', () => {
    expect(describeSegments(videoSegmentRequests(log))).toBe('v720 #1, v720 #2, v240 #2');
    expect(describeSegments([])).toBe('none');
  });

  it('shortens a long list to its last entries, saying so', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(i + 1, 'segment', 'v240', i + 1));
    expect(describeSegments(many, 3)).toBe('... v240 #18, v240 #19, v240 #20');
  });

  it('cuts from the first request of a rung, and is empty when the rung was never asked for', () => {
    const video = videoSegmentRequests(log);
    expect(fromFirstOf(video, 'v240').map((e) => e.seq)).toEqual([6]);
    expect(fromFirstOf(video, 'v720').map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(fromFirstOf(video, 'v360')).toEqual([]);
  });
});

describe('orExplain', () => {
  it('passes the value of a wait through', async () => {
    await expect(orExplain(Promise.resolve(7), 'never shown')).resolves.toBe(7);
  });

  it('puts the sentence first and the wait\u2019s own message after it, unchanged', async () => {
    const wait = Promise.reject(
      new Error('qa.waitFor(variant-changed) timed out after 40000 ms.\n  #1 t=1 load-requested'),
    );
    await expect(orExplain(wait, 'the player stayed on 240p.')).rejects.toThrow(
      'the player stayed on 240p.\nqa.waitFor(variant-changed) timed out after 40000 ms.\n  #1 t=1 load-requested',
    );
  });

  it('points the stack at the caller, not at the helper', async () => {
    const error = await orExplain(Promise.reject(new Error('boom')), 'explained').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).stack).not.toMatch(/tests[\\/]e2e[\\/]abr[\\/]explain\.ts/);
  });

  it('explains a synchronous check the same way: the sentence first, the check\u2019s own message after it', () => {
    expect(() => withExplanation(() => undefined, 'never shown')).not.toThrow();
    expect(() =>
      withExplanation(() => {
        throw new Error('rebuffers (metrics.rebuffer.count): expected at most 1, saw 2');
      }, 'rung changes: 360p at 16.65 s.'),
    ).toThrow(
      'rung changes: 360p at 16.65 s.\nrebuffers (metrics.rebuffer.count): expected at most 1, saw 2',
    );
    let thrown: unknown;
    try {
      withExplanation(() => {
        throw new Error('boom');
      }, 'explained');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).stack).not.toMatch(/tests[\\/]e2e[\\/]abr[\\/]explain\.ts/);
  });

  it('asks the page for its addendum only when the wait failed, and puts it after the sentence', async () => {
    let asked = 0;
    const addendum = async () => {
      asked += 1;
      return '37 of 1271 frames were dropped.';
    };
    await expect(orExplain(Promise.resolve(1), 'never shown', addendum)).resolves.toBe(1);
    expect(asked).toBe(0);
    await expect(
      orExplain(Promise.reject(new Error('timed out')), 'stayed on 240p.', addendum),
    ).rejects.toThrow('stayed on 240p. 37 of 1271 frames were dropped.\ntimed out');
    expect(asked).toBe(1);
  });

  it('reports the wait\u2019s failure even when the page cannot give its addendum', async () => {
    const addendum = async () => {
      throw new Error('Target page, context or browser has been closed');
    };
    await expect(
      orExplain(Promise.reject(new Error('timed out')), 'stayed on 240p.', addendum),
    ).rejects.toThrow(
      /^stayed on 240p\. \(what the page could add to this could not be read: Target page, context or browser has been closed\)\ntimed out$/,
    );
  });
});
