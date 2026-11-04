import { describe, expect, it } from 'vitest';
import {
  buildDashLive,
  buildDashVod,
  timelineEntries,
  UTC_TIMING_PATH,
} from '../../../src/server/media/dash.ts';
import { liveTiming } from '../../../src/server/media/live.ts';
import type { DashLiveParams, RepIndex, StreamIndex } from '../../../src/server/media/types.ts';
import { parseDash } from '../../../tools/lib/dash-client.ts';
import { parseXml } from '../../../tools/lib/xml.ts';
import { syntheticIndex } from './support/support.ts';

const MANIFEST_URL = 'http://127.0.0.1:4620/s/sess1/vod-cmaf/dash/manifest.mpd';
const AST = new Date('2026-01-01T00:00:00.000Z');
const live = (firstNumber: number, lastNumber: number): DashLiveParams => ({
  firstNumber,
  lastNumber,
  availabilityStartTime: AST,
  publishTime: new Date(AST.getTime() + lastNumber * 2000),
  timeShiftBufferDepthSec: 30,
  presentationDelaySec: 6,
  minimumUpdatePeriodSec: 2,
});

describe('DASH VOD manifest', () => {
  const index = syntheticIndex({ segmentCount: 30 });
  const xml = buildDashVod(index);
  const mpd = parseDash(xml, MANIFEST_URL);

  it('is a static MPD of the isoff-live profile with the stream duration, parsed strictly by an independent reader', () => {
    expect(mpd).toMatchObject({
      type: 'static',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      mediaPresentationDuration: 60,
      minBufferTime: 2,
    });
    expect(mpd.adaptationSets.map((s) => [s.id, s.contentType, s.segmentAlignment, s.startWithSAP])).toEqual([
      ['1', 'video', true, 1],
      ['2', 'audio', true, 1],
    ]);
  });

  it('declares the real timing of every segment, equal to the index: video 2 s, audio 94/93 frames', () => {
    for (const r of mpd.representations) {
      const idx = index.reps.find((x) => x.rep.id === r.id) as RepIndex;
      expect(r.timescale).toBe(idx.timescale);
      expect(r.segments.map((s) => [s.number, s.start, s.duration])).toEqual(
        idx.segments.map((s) => [s.number, s.start, s.duration]),
      );
    }
    const audio = mpd.representations.find((r) => r.id === 'a-aac');
    expect(new Set(audio?.segments.map((s) => s.duration))).toEqual(new Set([96_256, 95_232]));
  });

  it('uses relative URLs that resolve against the manifest URL to the contract layout', () => {
    const v = mpd.representations.find((r) => r.id === 'v240');
    expect(v?.initUrl).toBe('http://127.0.0.1:4620/s/sess1/vod-cmaf/seg/v240/init.mp4');
    expect(v?.segments[0]?.url).toBe('http://127.0.0.1:4620/s/sess1/vod-cmaf/seg/v240/1.m4s');
    expect(v?.segments[29]?.url).toBe('http://127.0.0.1:4620/s/sess1/vod-cmaf/seg/v240/30.m4s');
    expect(xml).not.toMatch(/(?:initialization|media)="(?:\/|https?:)/);
  });

  it('carries codecs, bandwidth, size, frame rate, mime type and the audio layout from the index', () => {
    const v = mpd.representations.find((r) => r.id === 'v720');
    expect(v).toMatchObject({
      codecs: 'vp09.00.31.08',
      bandwidth: 1_800_000,
      width: 1280,
      height: 720,
      frameRate: 30,
      mimeType: 'video/mp4',
    });
    const a = mpd.representations.find((r) => r.id === 'a-aac');
    expect(a).toMatchObject({
      codecs: 'mp4a.40.2',
      mimeType: 'audio/mp4',
      audioSamplingRate: 48_000,
      channels: 2,
    });
  });

  it('compresses runs with S@r and writes t only where it is needed', () => {
    const video = xml.match(/<S [^>]*\/>/g) ?? [];
    expect(video[0]).toBe('<S t="0" d="30720" r="29"/>');
    expect(xml).toContain('<S t="0" d="96256" r="2"/>');
    expect(xml).toContain('<S d="95232"/>');
    expect((xml.match(/ t="/g) ?? []).length).toBe(2); // one per AdaptationSet: the timelines are contiguous
  });

  it('rounds maxSegmentDuration up: 2.00533 s is announced as 2.006 s, never 2.005', () => {
    expect(xml).toContain('maxSegmentDuration="PT2.006S"');
  });

  it('refuses a live stream, a stream without DASH, and an encrypted stream', () => {
    expect(() => buildDashVod(syntheticIndex({ kind: 'live', segmentCount: 12 }))).toThrow(/is live/);
    expect(() => buildDashVod(syntheticIndex({ protocols: ['hls'] }))).toThrow(/not offered as DASH/);
    const encrypted = syntheticIndex();
    encrypted.info.drm = { scheme: 'clearkey', keyId: '0'.repeat(32), key: '1'.repeat(32) };
    expect(() => buildDashVod(encrypted)).toThrow(/encrypted/);
  });
});

describe('DASH live manifest', () => {
  const index = syntheticIndex({ kind: 'live', segmentCount: 12 });
  const url = 'http://127.0.0.1:4620/s/sess1/live-cmaf/dash/manifest.mpd';

  it('is a dynamic MPD with the timing attributes of the parameters and a UTCTiming at /api/time (absolute path)', () => {
    const xml = buildDashLive(index, live(86, 100));
    const mpd = parseDash(xml, url);
    expect(mpd).toMatchObject({
      type: 'dynamic',
      minimumUpdatePeriod: 2,
      timeShiftBufferDepth: 30,
      suggestedPresentationDelay: 6,
      minBufferTime: 2,
    });
    expect(mpd.availabilityStartTime?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(mpd.publishTime?.toISOString()).toBe('2026-01-01T00:03:20.000Z');
    expect(xml).toContain(
      `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="${UTC_TIMING_PATH}"/>`,
    );
    expect(mpd.utcTiming?.url).toBe('http://127.0.0.1:4620/api/time');
    expect(xml).not.toMatch(/mediaPresentationDuration/);
  });

  it('lists exactly the window, numbered from startNumber, with the real live time of every segment', () => {
    for (const [first, last] of [
      [86, 100],
      [1, 15],
      [10, 16],
      [12, 13],
    ] as const) {
      const mpd = parseDash(buildDashLive(index, live(first, last)), url);
      for (const r of mpd.representations) {
        const idx = index.reps.find((x) => x.rep.id === r.id) as RepIndex;
        expect(r.segments.map((s) => s.number)).toEqual(
          Array.from({ length: last - first + 1 }, (_, i) => first + i),
        );
        expect(r.segments.map((s) => [s.start, s.duration])).toEqual(
          Array.from({ length: last - first + 1 }, (_, i) => {
            const t = liveTiming(idx, first + i);
            return [t.start, t.duration];
          }),
        );
      }
    }
  });

  it('keeps the timeline continuous across the loop boundary: segment 13 starts where segment 12 ended, in every track', () => {
    const mpd = parseDash(buildDashLive(index, live(10, 16)), url);
    for (const r of mpd.representations) {
      const s12 = r.segments.find((s) => s.number === 12);
      const s13 = r.segments.find((s) => s.number === 13);
      expect(s13?.start).toBe((s12?.start ?? 0) + (s12?.duration ?? 0));
    }
    const video = mpd.representations[0];
    const audio = mpd.representations[3];
    expect((video?.segments[3]?.start ?? 0) / (video?.timescale ?? 1)).toBe(24);
    expect((audio?.segments[3]?.start ?? 0) / (audio?.timescale ?? 1)).toBe(24);
  });

  it('renders the audio window with runs and the 93-frame segments as separate S entries', () => {
    const xml = buildDashLive(index, live(10, 16));
    expect(xml).toContain('<S t="864256" d="96256" r="1"/>');
    expect(xml).toContain('<S d="95232"/>');
  });

  it('rejects a VOD stream and an invalid window or parameters', () => {
    expect(() => buildDashLive(syntheticIndex(), live(1, 3))).toThrow(/not live/);
    expect(() => buildDashLive(index, live(0, 3))).toThrow(RangeError);
    expect(() => buildDashLive(index, live(4, 3))).toThrow(RangeError);
    expect(() => buildDashLive(index, { ...live(1, 3), timeShiftBufferDepthSec: -1 })).toThrow(RangeError);
    expect(() => buildDashLive(index, { ...live(1, 3), publishTime: new Date('nope') })).toThrow(RangeError);
  });
});

describe('DASH for WebM', () => {
  it('uses the full profile (isoff-live promises ISO BMFF segments), .webm templates and 2000 ms segments', () => {
    const xml = buildDashVod(syntheticIndex({ packaging: 'webm', segmentCount: 15 }));
    const mpd = parseDash(xml, 'http://h/s/x/vod-webm/dash/manifest.mpd');
    expect(mpd.profiles).toBe('urn:mpeg:dash:profile:full:2011');
    expect(mpd.mediaPresentationDuration).toBe(30);
    expect(mpd.representations.map((r) => r.mimeType)).toEqual([
      'video/webm',
      'video/webm',
      'video/webm',
      'audio/webm',
    ]);
    expect(mpd.representations[0]?.segments[0]?.url).toBe('http://h/s/x/vod-webm/seg/v240/1.webm');
    expect(mpd.representations[3]?.codecs).toBe('opus');
    expect(mpd.representations[3]?.timescale).toBe(1000);
    expect(mpd.representations[3]?.segments.every((s) => s.duration === 2000)).toBe(true);
  });
});

describe('alignment is derived from the data, not asserted', () => {
  it('writes one template per representation, and no alignment claim, when the rungs differ', () => {
    const index: StreamIndex = JSON.parse(JSON.stringify(syntheticIndex({ segmentCount: 4 }))) as StreamIndex;
    // v360 is cut differently: segment 2 is a frame longer and segment 3 a frame shorter
    const v360 = index.reps[1] as RepIndex;
    (v360.segments[1] as { duration: number }).duration += 512;
    (v360.segments[2] as { duration: number; start: number }).start += 512;
    (v360.segments[2] as { duration: number }).duration -= 512;
    const xml = buildDashVod(index);
    const mpd = parseDash(xml, MANIFEST_URL);
    expect(mpd.adaptationSets.map((s) => s.segmentAlignment)).toEqual([false, true]);
    expect(xml.match(/<SegmentTemplate /g)).toHaveLength(4); // three video representations and the audio set, not one per set
    const v360Parsed = mpd.representations.find((r) => r.id === 'v360');
    expect(v360Parsed?.segments.map((s) => s.duration)).toEqual(v360.segments.map((s) => s.duration));
    expect(mpd.representations.find((r) => r.id === 'v240')?.segments.map((s) => s.duration)).toEqual([
      30_720, 30_720, 30_720, 30_720,
    ]);
  });
});

describe('escaping and well-formedness', () => {
  it('escapes attribute values so that hostile ids and codec strings cannot break the XML', () => {
    const index: StreamIndex = JSON.parse(JSON.stringify(syntheticIndex({ segmentCount: 2 }))) as StreamIndex;
    const nasty = `v"<&>'x`;
    (index.reps[0] as RepIndex).rep.id = nasty;
    (index.reps[0] as RepIndex).rep.codecs = `a"b&c<d>`;
    index.info.reps[0] = (index.reps[0] as RepIndex).rep;
    const xml = buildDashVod(index);
    const root = parseXml(xml);
    const set = root.children[0]?.children[0];
    const rep = set?.children.find((c) => c.name === 'Representation');
    expect(rep?.attrs.id).toBe(nasty);
    expect(rep?.attrs.codecs).toBe(`a"b&c<d>`);
  });

  it('refuses characters XML cannot carry rather than emitting an invalid manifest', () => {
    const index: StreamIndex = JSON.parse(JSON.stringify(syntheticIndex({ segmentCount: 2 }))) as StreamIndex;
    (index.reps[0] as RepIndex).rep.codecs = 'bad\u0000codec';
    expect(() => buildDashVod(index)).toThrow(RangeError);
  });
});

describe('timelineEntries', () => {
  it('merges equal contiguous durations into one run and starts a new S at a duration change', () => {
    const e = timelineEntries([
      { start: 0, duration: 10 },
      { start: 10, duration: 10 },
      { start: 20, duration: 10 },
      { start: 30, duration: 9 },
      { start: 39, duration: 10 },
    ]);
    expect(e).toEqual([{ t: 0, d: 10, r: 2 }, { d: 9 }, { d: 10 }]);
  });

  it('states t again after a discontinuity, so that a gap can never be misread as contiguity', () => {
    expect(
      timelineEntries([
        { start: 0, duration: 10 },
        { start: 25, duration: 10 },
        { start: 35, duration: 10 },
      ]),
    ).toEqual([
      { t: 0, d: 10 },
      { t: 25, d: 10, r: 1 },
    ]);
  });
});
