import { describe, expect, it } from 'vitest';
import { checkStreamIndex } from '../../../src/server/media/invariants.ts';
import {
  AAC_GRID,
  audioFrameCount,
  audioSegmentFrameCounts,
  audioSegmentStartFrames,
  buildIsobmffSegments,
  buildWebmSegments,
  ceilDiv,
  floorDiv,
  OPUS_WEBM_GRID,
  videoSegmentFrameCounts,
  type Packet,
} from '../../../src/server/media/segmenter.ts';
import { parseMediaSegment } from '../../../src/server/media/isobmff.ts';
import { parseWebmMediaSegment } from '../../../src/server/media/ebml.ts';
import { syntheticIndex } from './support/support.ts';

const pattern = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => [94, 94, 94, 93][i % 4] as number);

describe('the audio cutting rule (ADR-042)', () => {
  it('cuts 48 kHz AAC on the 2 s grid as 94, 94, 94, 93 frames, repeating', () => {
    // The oracle: 2 s = 93.75 frames of 1024 samples; 375 frames are exactly 8 s, so the pattern closes every four segments.
    expect(audioSegmentFrameCounts(12, 2, AAC_GRID)).toEqual([
      94, 94, 94, 93, 94, 94, 94, 93, 94, 94, 94, 93,
    ]);
    expect(audioSegmentFrameCounts(16, 2, AAC_GRID)).toEqual(pattern(16));
  });

  it('gives the live loop exactly 1125 frames = 24 s, with no drift against 24 s of video', () => {
    const counts = audioSegmentFrameCounts(12, 2, AAC_GRID);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1125);
    expect((1125 * 1024) / 48_000).toBe(24);
  });

  it('never strays more than one frame from the grid, however many segments (cumulative rounding)', () => {
    const starts = audioSegmentStartFrames(5000, 2, AAC_GRID);
    for (let k = 0; k < 5000; k++) {
      const frameStartSec = ((starts[k] as number) * 1024) / 48_000;
      const gridSec = k * 2;
      // segment k+1 starts at the first frame whose start is >= its grid time, so it is late by less than one frame
      expect(frameStartSec).toBeGreaterThanOrEqual(gridSec);
      expect(frameStartSec - gridSec).toBeLessThan(1024 / 48_000);
    }
  });

  it('is NOT "at least 2 s since the previous cut": that rule drifts 5.3 ms per segment', () => {
    // What ffmpeg's dash muxer does: every segment 94 frames. Twelve of them are 64 ms longer than 24 s.
    const naiveFrames = 12 * 94;
    const driftSec = (naiveFrames * 1024) / 48_000 - 24;
    expect(driftSec).toBeCloseTo(0.064, 6);
    const index = syntheticIndex({ kind: 'live', segmentCount: 12, audio: 'naive', id: 'live-cmaf' });
    const problems = checkStreamIndex(index);
    expect(problems.some((p) => /live loops must be equal to the tick/.test(p))).toBe(true);
    expect(checkStreamIndex(syntheticIndex({ kind: 'live', segmentCount: 12, id: 'live-cmaf' }))).toEqual([]);
  });

  it('counts whole frames only: the audio never runs past the video', () => {
    expect(audioFrameCount(60, AAC_GRID)).toBe(2812); // 2812.5 frames of audio in 60 s
    expect(audioFrameCount(12, AAC_GRID)).toBe(562);
    expect(audioFrameCount(24, AAC_GRID)).toBe(1125);
    expect((2812 * 1024) / 48_000).toBeLessThan(60);
  });

  it('cuts the 60 s VOD stream into 30 segments that tile its 2812 frames', () => {
    const counts = audioSegmentFrameCounts(30, 2, AAC_GRID);
    expect(counts).toHaveLength(30);
    expect(counts.slice(0, 28)).toEqual(pattern(28));
    expect(counts.slice(28)).toEqual([94, 93]); // the last segment ends at the last whole frame
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2812);
  });

  it('is exact for Opus in WebM: 100 frames of 20 ms per 2 s segment', () => {
    expect(audioSegmentFrameCounts(15, 2, OPUS_WEBM_GRID)).toEqual(Array.from({ length: 15 }, () => 100));
  });

  it('refuses a segment that holds no whole frame and a grid that is not whole units', () => {
    expect(() => audioSegmentFrameCounts(3, 0.0001, { sampleRate: 48_000, frameSamples: 1024 })).toThrow(
      RangeError,
    );
    expect(() => audioSegmentStartFrames(3, 0.5, { sampleRate: 1, frameSamples: 1 })).toThrow(RangeError);
  });
});

describe('integer division helpers', () => {
  it('are exact where floating point division would not be', () => {
    expect(ceilDiv(96_000, 1024)).toBe(94);
    expect(ceilDiv(1024 * 30, 1024)).toBe(30);
    expect(ceilDiv(0, 1024)).toBe(0);
    expect(floorDiv(1023, 1024)).toBe(0);
    expect(floorDiv(2_880_000, 1024)).toBe(2812);
    expect(ceilDiv(3 * 96_000, 1024)).toBe(282);
  });
});

describe('videoSegmentFrameCounts', () => {
  it('is 60 frames per 2 s segment at 30 fps', () => {
    expect(videoSegmentFrameCounts(3, 2, 30)).toEqual([60, 60, 60]);
  });
  it('refuses a frame rate that does not divide the segment into whole frames', () => {
    expect(() => videoSegmentFrameCounts(3, 2, 29.97)).toThrow(RangeError);
  });
});

const packet = (n: number, sync: boolean): Packet => ({ data: Buffer.from([n, n, n]), sync });

describe('buildIsobmffSegments', () => {
  it('cuts the packets as told, on the track timeline: tfdt = samples before x ticks per sample', () => {
    const packets = Array.from({ length: 10 }, (_, i) => packet(i, i % 4 === 0));
    const segments = buildIsobmffSegments({ trackId: 1, ticksPerSample: 512, packets, counts: [4, 4, 2] });
    const parsed = segments.map((s) => parseMediaSegment(s).fragments[0]);
    expect(parsed.map((f) => f?.trafs[0]?.baseMediaDecodeTime)).toEqual([0, 2048, 4096]);
    expect(parsed.map((f) => f?.trafs[0]?.duration)).toEqual([2048, 2048, 1024]);
    expect(parsed.map((f) => f?.sequenceNumber)).toEqual([1, 2, 3]);
  });

  it('refuses to cut a video segment that does not start at a sync sample (the encoder missed the keyframe grid)', () => {
    const packets = Array.from({ length: 6 }, (_, i) => packet(i, i === 0));
    expect(() => buildIsobmffSegments({ trackId: 1, ticksPerSample: 512, packets, counts: [3, 3] })).toThrow(
      /does not start with a sync sample/,
    );
    expect(
      buildIsobmffSegments({
        trackId: 1,
        ticksPerSample: 512,
        packets,
        counts: [3, 3],
        requireSyncStart: false,
      }),
    ).toHaveLength(2);
  });

  it('refuses counts that do not add up to the packets it was given', () => {
    const packets = [packet(1, true), packet(2, true)];
    expect(() => buildIsobmffSegments({ trackId: 1, ticksPerSample: 512, packets, counts: [1, 2] })).toThrow(
      /cannot be split/,
    );
  });
});

describe('buildWebmSegments', () => {
  it('writes one Cluster per segment with timecodes synthesized from the packet index', () => {
    const packets = Array.from({ length: 6 }, (_, i) => packet(i, i % 3 === 0));
    const segments = buildWebmSegments({
      trackNumber: 1,
      packets,
      counts: [3, 3],
      timecodeMs: (i) => Math.round((i * 1000) / 30),
    });
    const clusters = segments.map((s) => parseWebmMediaSegment(s));
    expect(clusters.map((c) => c.timecode)).toEqual([0, 100]);
    expect(clusters[1]?.blocks.map((b) => b.timecode)).toEqual([100, 133, 167]);
    expect(clusters[1]?.blocks.map((b) => b.keyframe)).toEqual([true, false, false]);
  });

  it('refuses a segment that does not start at a keyframe', () => {
    const packets = Array.from({ length: 4 }, (_, i) => packet(i, i === 0));
    expect(() =>
      buildWebmSegments({ trackNumber: 1, packets, counts: [2, 2], timecodeMs: (i) => i * 33 }),
    ).toThrow(/does not start with a keyframe/);
  });
});
