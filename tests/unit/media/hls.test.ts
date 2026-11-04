import { describe, expect, it } from 'vitest';
import { buildHlsMaster, buildHlsMediaLive, buildHlsMediaVod } from '../../../src/server/media/hls.ts';
import { liveTiming } from '../../../src/server/media/live.ts';
import { instantAt, isoTimestamp } from '../../../src/server/media/time.ts';
import type { HlsLiveParams, RepIndex } from '../../../src/server/media/types.ts';
import { checkHlsMaster, checkHlsMedia, parseAttributes } from './support/hls-check.ts';
import { syntheticIndex } from './support/support.ts';

const AST = new Date('2026-01-01T00:00:00.000Z');
const window = (firstNumber: number, lastNumber: number): HlsLiveParams => ({
  firstNumber,
  lastNumber,
  availabilityStartTime: AST,
});

describe('HLS master playlist', () => {
  const index = syntheticIndex({ segmentCount: 30 });
  const { problems, facts } = checkHlsMaster(buildHlsMaster(index));

  it('is a well-formed version 7 multivariant playlist', () => {
    expect(problems).toEqual([]);
    expect(facts.variants.map((v) => v.uri)).toEqual(['v240.m3u8', 'v360.m3u8', 'v720.m3u8']);
  });

  it('declares audio as a separate group that every variant references', () => {
    expect(facts.media).toEqual([
      {
        TYPE: 'AUDIO',
        'GROUP-ID': 'audio',
        NAME: 'a-aac',
        DEFAULT: 'YES',
        AUTOSELECT: 'YES',
        CHANNELS: '2',
        URI: 'a-aac.m3u8',
      },
    ]);
    expect(facts.variants.every((v) => v.attrs.AUDIO === 'audio')).toBe(true);
  });

  it('takes codecs, resolution and frame rate from the index and bandwidth as video peak + audio peak', () => {
    const v360 = facts.variants[1];
    expect(v360?.attrs.CODECS).toBe('vp09.00.21.08,mp4a.40.2');
    expect(v360?.attrs.RESOLUTION).toBe('640x360');
    expect(v360?.attrs['FRAME-RATE']).toBe('30.000');
    expect(v360?.attrs.BANDWIDTH).toBe(String(700_000 + 66_000));
  });

  it('computes AVERAGE-BANDWIDTH from the segment sizes, never above the peak', () => {
    for (const v of facts.variants)
      expect(Number(v.attrs['AVERAGE-BANDWIDTH'])).toBeLessThanOrEqual(Number(v.attrs.BANDWIDTH));
  });

  it('refuses a stream that is not offered as HLS', () => {
    expect(() => buildHlsMaster(syntheticIndex({ packaging: 'webm', protocols: ['dash'] }))).toThrow(
      /not offered as HLS/,
    );
  });
});

describe('HLS VOD media playlists', () => {
  const index = syntheticIndex({ segmentCount: 30 });
  const audio = index.reps[3] as RepIndex;

  it('lists the REAL duration of every segment: audio is 2.005333 or 1.984000, never a flat 2.000', () => {
    const { problems, facts } = checkHlsMedia(buildHlsMediaVod(index, 'a-aac'));
    expect(problems).toEqual([]);
    const expected = audio.segments.map((s) => (s.duration / 48_000).toFixed(6));
    expect(facts.segments.map((s) => s.duration.toFixed(6))).toEqual(expected);
    expect(new Set(expected)).toEqual(new Set(['2.005333', '1.984000']));
    // the playlist adds up to the loop to within the microsecond rounding of each entry
    const total = facts.segments.reduce((n, s) => n + s.duration, 0);
    expect(Math.abs(total - audio.loopTicks / 48_000)).toBeLessThan(30 * 5e-7);
  });

  it('is a VOD playlist: PLAYLIST-TYPE:VOD, ENDLIST last, sequence 1, relative URIs that carry the segment number', () => {
    const { problems, facts } = checkHlsMedia(buildHlsMediaVod(index, 'v240'));
    expect(problems).toEqual([]);
    expect(facts).toMatchObject({
      playlistType: 'VOD',
      endList: true,
      mediaSequence: 1,
      mapUri: '../seg/v240/init.mp4',
      version: 7,
    });
    expect(facts.segments.map((s) => s.uri)).toEqual(
      Array.from({ length: 30 }, (_, i) => `../seg/v240/${i + 1}.m4s`),
    );
    expect(facts.segments.every((s) => s.programDateTime === undefined)).toBe(true);
  });

  it('sets TARGETDURATION = ceil(max EXTINF): 2 for video, 3 for audio (94 frames = 2.0053 s)', () => {
    expect(checkHlsMedia(buildHlsMediaVod(index, 'v360')).facts.targetDuration).toBe(2);
    expect(checkHlsMedia(buildHlsMediaVod(index, 'a-aac')).facts.targetDuration).toBe(3);
  });

  it('refuses an unknown representation and a live stream', () => {
    expect(() => buildHlsMediaVod(index, 'v999')).toThrow(/no representation 'v999'/);
    expect(() => buildHlsMediaVod(syntheticIndex({ kind: 'live', segmentCount: 12 }), 'v240')).toThrow(
      /is live/,
    );
  });
});

describe('HLS live media playlists', () => {
  const index = syntheticIndex({ kind: 'live', segmentCount: 12 });
  const audio = index.reps[3] as RepIndex;
  const video = index.reps[0] as RepIndex;

  it('slides: MEDIA-SEQUENCE is the number of the first listed segment, and the URIs carry the live numbers', () => {
    const { problems, facts } = checkHlsMedia(buildHlsMediaLive(index, 'v240', window(86, 100)));
    expect(problems).toEqual([]);
    expect(facts.mediaSequence).toBe(86);
    expect(facts.endList).toBe(false);
    expect(facts.playlistType).toBeUndefined();
    expect(facts.segments.map((s) => s.uri)).toEqual(
      Array.from({ length: 15 }, (_, i) => `../seg/v240/${86 + i}.m4s`),
    );
  });

  it('puts a PROGRAM-DATE-TIME on every segment: AST plus the segment live start, so the loop never shows up as a jump', () => {
    const { facts } = checkHlsMedia(buildHlsMediaLive(index, 'a-aac', window(10, 16)));
    facts.segments.forEach((s, i) => {
      const t = liveTiming(audio, 10 + i);
      expect(s.programDateTime).toBe(isoTimestamp(instantAt(AST, t.start, 48_000)));
    });
    // segment 13 is the first of loop 1: it starts exactly 24 s after AST
    expect(facts.segments[3]?.programDateTime).toBe('2026-01-01T00:00:24.000Z');
  });

  it('lists the real EXTINF of loop-wrapped audio segments, 93 frames included', () => {
    const { facts } = checkHlsMedia(buildHlsMediaLive(index, 'a-aac', window(10, 16)));
    expect(facts.segments.map((s) => s.duration)).toEqual([
      2.005333, 2.005333, 1.984, 2.005333, 2.005333, 2.005333, 1.984,
    ]);
  });

  it('keeps TARGETDURATION stable while the window slides, even over a window of 93-frame segments only', () => {
    for (const [a, b] of [
      [1, 15],
      [12, 12],
      [4, 4],
      [86, 100],
    ] as const) {
      expect(checkHlsMedia(buildHlsMediaLive(index, 'a-aac', window(a, b))).facts.targetDuration).toBe(3);
      expect(checkHlsMedia(buildHlsMediaLive(index, 'v240', window(a, b))).facts.targetDuration).toBe(2);
    }
  });

  it('starts the video window at the right live time', () => {
    const { facts } = checkHlsMedia(buildHlsMediaLive(index, 'v240', window(13, 13)));
    expect(facts.segments[0]?.programDateTime).toBe(
      isoTimestamp(instantAt(AST, liveTiming(video, 13).start, 15_360)),
    );
  });

  it('refuses a VOD stream, an unknown rep and an invalid window', () => {
    expect(() => buildHlsMediaLive(syntheticIndex(), 'v240', window(1, 3))).toThrow(/not live/);
    expect(() => buildHlsMediaLive(index, 'nope', window(1, 3))).toThrow(/no representation/);
    expect(() => buildHlsMediaLive(index, 'v240', window(0, 3))).toThrow(RangeError);
    expect(() => buildHlsMediaLive(index, 'v240', window(5, 4))).toThrow(RangeError);
    expect(() => buildHlsMediaLive(index, 'v240', window(1.5, 4))).toThrow(RangeError);
  });
});

describe('the HLS checker itself', () => {
  it('parses attribute lists with quoted commas and rejects malformed ones', () => {
    expect(parseAttributes('A=1,B="x,y",C=z')).toEqual({ A: '1', B: 'x,y', C: 'z' });
    expect(parseAttributes('A=1,A=2')).toBeNull();
    expect(parseAttributes('A="unterminated')).toBeNull();
  });

  it('catches the mistakes it exists to catch', () => {
    const good = buildHlsMediaVod(syntheticIndex({ segmentCount: 3 }), 'v240');
    expect(checkHlsMedia(good).problems).toEqual([]);
    expect(checkHlsMedia(good.replace('#EXTINF:2.000000,\n', '')).problems.join()).toMatch(
      /without a preceding EXTINF/,
    );
    expect(
      checkHlsMedia(good.replace('#EXT-X-TARGETDURATION:2', '#EXT-X-TARGETDURATION:1')).problems.join(),
    ).toMatch(/longer than TARGETDURATION/);
    expect(checkHlsMedia(good.replace('#EXT-X-ENDLIST\n', '')).problems.join()).toMatch(
      /ENDLIST and PLAYLIST-TYPE/,
    );
    expect(checkHlsMedia(good.replace('../seg/v240/1.m4s', '/seg/v240/1.m4s')).problems.join()).toMatch(
      /not relative/,
    );
    expect(checkHlsMedia(good.replace('#EXTM3U', '#EXTM3X')).problems.join()).toMatch(
      /does not start with #EXTM3U/,
    );
    expect(checkHlsMedia(`${good}#EXT-X-BOGUS:1\n`).problems.join()).toMatch(/unknown tag/);
  });
});
