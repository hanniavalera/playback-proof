import { describe, expect, it } from 'vitest';
import {
  claimsFalseButPlays,
  claimsTrueButFails,
  classifyReliability,
  deriveDisagreements,
  describeMediaError,
  dominantFailure,
  normalizeError,
  redactPaths,
  summarizeAttempts,
} from '../../../src/lab/probe/results.ts';
import type { AttemptResult } from '../../../src/lab/probe/results.ts';
import { PUSH_FAILURE, UNSUPPORTED_FAILURE, verdict } from './fixtures.ts';

describe('classifyReliability', () => {
  it.each([
    [3, 3, 'ok'],
    [1, 1, 'ok'],
    [0, 3, 'fail'],
    [0, 1, 'fail'],
    [1, 3, 'intermittent'],
    [2, 3, 'intermittent'],
    [4, 5, 'intermittent'],
  ] as const)('%i of %i attempts is %s', (passes, attempts, expected) => {
    expect(classifyReliability(passes, attempts)).toBe(expected);
  });

  it.each([
    [0, 0],
    [-1, 3],
    [4, 3],
    [1.5, 3],
    [1, 2.5],
    [Number.NaN, 3],
  ])('refuses the impossible input passes=%s attempts=%s', (passes, attempts) => {
    expect(() => classifyReliability(passes, attempts)).toThrow(RangeError);
  });
});

describe('dominantFailure and summarizeAttempts', () => {
  const other: AttemptResult = { ok: false, stage: 'append', error: 'Error: SourceBuffer error event' };
  const push: AttemptResult = { ok: false, ...PUSH_FAILURE };
  const pass: AttemptResult = { ok: true, currentTime: 1, framesPresented: 30 };

  it('reports nothing when every attempt passed', () => {
    expect(dominantFailure([pass, pass])).toBeUndefined();
    expect(summarizeAttempts([pass, pass], true)).toMatchObject({
      passes: 2,
      attempts: 2,
      reliability: 'ok',
    });
    expect(summarizeAttempts([pass, pass], true)).not.toHaveProperty('failure');
  });

  it('picks the most frequent failure and counts it', () => {
    expect(dominantFailure([other, push, pass, push])).toEqual({
      stage: 'play',
      error: PUSH_FAILURE.error,
      mediaError: PUSH_FAILURE.mediaError,
      count: 2,
    });
  });

  it('breaks a tie in favour of the earliest failure', () => {
    expect(dominantFailure([other, push])).toMatchObject({ stage: 'append', count: 1 });
  });

  it('treats the same error text with a different media error as a different failure', () => {
    const decode: AttemptResult = { ...push, mediaError: { code: 3, message: 'decode' } };
    expect(dominantFailure([push, decode, decode])).toMatchObject({ count: 2, mediaError: { code: 3 } });
  });

  it('keeps every raw attempt and records the claim', () => {
    const summary = summarizeAttempts([pass, push, push], true);
    expect(summary).toMatchObject({
      attempts: 3,
      passes: 1,
      reliability: 'intermittent',
      typeSupportedClaim: true,
    });
    expect(summary.runs).toHaveLength(3);
  });

  it('leaves the claim out for controls (no isTypeSupported question exists for them)', () => {
    expect(summarizeAttempts([pass])).not.toHaveProperty('typeSupportedClaim');
  });

  it('refuses an empty list of attempts', () => {
    expect(() => summarizeAttempts([])).toThrow(RangeError);
  });
});

describe('disagreements between isTypeSupported and real decoding', () => {
  it('flags a claim of support that did not decode every time (the "lie")', () => {
    expect(claimsTrueButFails(verdict(0, 3, true))).toBe(true);
    expect(claimsTrueButFails(verdict(1, 3, true))).toBe(true);
    expect(claimsTrueButFails(verdict(3, 3, true))).toBe(false);
  });

  it('does not call an honest "no" a lie', () => {
    expect(claimsTrueButFails(verdict(0, 3, false, UNSUPPORTED_FAILURE))).toBe(false);
  });

  it('flags the opposite disagreement: claimed unsupported but it played', () => {
    expect(claimsFalseButPlays(verdict(3, 3, false))).toBe(true);
    expect(claimsFalseButPlays(verdict(1, 3, false))).toBe(true);
    expect(claimsFalseButPlays(verdict(0, 3, false, UNSUPPORTED_FAILURE))).toBe(false);
    expect(claimsFalseButPlays(verdict(3, 3, true))).toBe(false);
  });

  it('ignores results without a claim (plain-playback controls)', () => {
    expect(claimsTrueButFails(verdict(0, 3))).toBe(false);
    expect(claimsFalseButPlays(verdict(3, 3))).toBe(false);
  });

  it('derives both lists over a set of cases', () => {
    expect(
      deriveDisagreements({
        liar: verdict(0, 3, true),
        flaky: verdict(2, 3, true),
        honest: verdict(0, 3, false, UNSUPPORTED_FAILURE),
        fine: verdict(3, 3, true),
        modest: verdict(3, 3, false),
      }),
    ).toEqual({ lies: ['liar', 'flaky'], underclaims: ['modest'] });
  });
});

describe('error text helpers', () => {
  it('makes failures that differ only in the random server port identical', () => {
    expect(normalizeError('Failed to fetch http://127.0.0.1:51234/media/a.mp4')).toBe(
      normalizeError('Failed to fetch http://127.0.0.1:60001/media/a.mp4'),
    );
    expect(normalizeError('HTTP 404 for http://127.0.0.1:1/x')).toBe(
      'HTTP 404 for http://127.0.0.1:<port>/x',
    );
  });

  it('removes the home and temp directories from text that is about to be committed', () => {
    const text =
      'launching /Users/someone/Library/Caches/ms-playwright/x -profile /var/folders/ab/T/profile-1';
    expect(redactPaths(text, '/Users/someone', '/var/folders/ab/T')).toBe(
      'launching ~/Library/Caches/ms-playwright/x -profile <tmpdir>/profile-1',
    );
  });

  it('does not mangle text when the home directory is the root (a container user without a home)', () => {
    expect(redactPaths('/etc/x and /tmp/y', '/', '/')).toBe('/etc/x and /tmp/y');
  });

  it('names MediaError codes the way the platform does', () => {
    expect(describeMediaError({ code: 4, message: 'Failed to push buffer' })).toBe(
      'MediaError 4 (MEDIA_ERR_SRC_NOT_SUPPORTED): Failed to push buffer',
    );
    expect(describeMediaError({ code: 3, message: '' })).toBe('MediaError 3 (MEDIA_ERR_DECODE)');
    expect(describeMediaError({ code: 99, message: 'x' })).toBe('MediaError 99: x');
  });
});
