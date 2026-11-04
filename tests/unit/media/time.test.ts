import { describe, expect, it } from 'vitest';
import {
  formatSeconds,
  instantAt,
  isoDuration,
  isoTimestamp,
  xmlEscape,
} from '../../../src/server/media/time.ts';

describe('isoDuration', () => {
  it.each([
    [0, 'PT0S'],
    [2, 'PT2S'],
    [30, 'PT30S'],
    [60, 'PT1M'],
    [61, 'PT1M1S'],
    [3600, 'PT1H'],
    [3661.5, 'PT1H1M1.5S'],
    [2.005333, 'PT2.005S'],
    [60.0107, 'PT1M0.011S'],
    [0.5, 'PT0.5S'],
    [0.001, 'PT0.001S'],
    [36 * 3600, 'PT36H'],
  ])('%s s is %s', (seconds, text) => {
    expect(isoDuration(seconds)).toBe(text);
  });

  it('rounds to the millisecond and carries into the next unit', () => {
    expect(isoDuration(59.9996)).toBe('PT1M');
    expect(isoDuration(0.0004)).toBe('PT0S');
    expect(isoDuration(3599.9996)).toBe('PT1H');
  });

  it('rejects negative and non-finite durations', () => {
    expect(() => isoDuration(-1)).toThrow(RangeError);
    expect(() => isoDuration(Number.NaN)).toThrow(RangeError);
    expect(() => isoDuration(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('isoTimestamp and instantAt', () => {
  it('prints UTC with milliseconds', () => {
    expect(isoTimestamp(new Date(Date.UTC(2026, 10, 3, 23, 0, 0, 7)))).toBe('2026-11-03T23:00:00.007Z');
  });

  it('rejects an invalid Date instead of printing garbage', () => {
    expect(() => isoTimestamp(new Date('nope'))).toThrow(RangeError);
  });

  it('places a media time on the wall clock, rounded to the millisecond', () => {
    const ast = new Date('2026-01-01T00:00:00.000Z');
    // 94 AAC frames = 96256 ticks at 48 kHz = 2.005333 s
    expect(isoTimestamp(instantAt(ast, 96_256, 48_000))).toBe('2026-01-01T00:00:02.005Z');
    expect(isoTimestamp(instantAt(ast, 30_720, 15_360))).toBe('2026-01-01T00:00:02.000Z');
    expect(() => instantAt(ast, 1, 0)).toThrow(RangeError);
  });
});

describe('formatSeconds', () => {
  it('shows microsecond resolution: 94 and 93 AAC frames', () => {
    expect(formatSeconds(96_256, 48_000, 6)).toBe('2.005333');
    expect(formatSeconds(95_232, 48_000, 6)).toBe('1.984000');
    expect(formatSeconds(30_720, 15_360, 6)).toBe('2.000000');
  });
});

describe('xmlEscape', () => {
  it('escapes the five predefined entities', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('keeps whitespace characters that attribute-value normalization would alter, as references', () => {
    expect(xmlEscape('a\tb\nc\rd')).toBe('a&#9;b&#10;c&#13;d');
  });

  it('refuses characters XML 1.0 cannot carry instead of dropping them silently', () => {
    expect(() => xmlEscape('bad\u0000value')).toThrow(RangeError);
    expect(() => xmlEscape('bad\u0008value')).toThrow(RangeError);
  });

  it('leaves ordinary and non-ASCII text alone', () => {
    expect(xmlEscape('vp09.00.31.08 — vídeo')).toBe('vp09.00.31.08 — vídeo');
  });
});
