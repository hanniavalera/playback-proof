// Shared helpers of the media unit tests: a scratch directory INSIDE the repository (.cache is git-ignored; never the system temp
// directory), tiny specs that run the real pipeline in a second or two, and a synthetic StreamIndex for tests that need no files.

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Protocol, RepInfo, StreamId, StreamInfo } from '../../../../src/shared/streams.ts';
import { AAC_GRID, audioSegmentFrameCounts, OPUS_WEBM_GRID } from '../../../../src/server/media/segmenter.ts';
import { CATALOG, type StreamSpec } from '../../../../src/server/media/specs.ts';
import type { ParsedInit } from '../../../../src/server/media/isobmff.ts';
import type { RepIndex, StreamIndex } from '../../../../src/server/media/types.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

export function scratchDir(name: string): { dir: string; remove: () => void } {
  const dir = join(
    REPO,
    '.cache',
    'tmp',
    'unit-media',
    `${name}-${process.pid}-${randomBytes(3).toString('hex')}`,
  );
  mkdirSync(dir, { recursive: true });
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

const specOf = (id: StreamId): StreamSpec => CATALOG.find((s) => s.id === id) as StreamSpec;

/** 4 segments (8 s = exactly 375 AAC frames), two small rungs: a live loop whose audio and video have the same length to the tick. */
export function tinyLiveSpec(): StreamSpec {
  return {
    ...specOf('live-cmaf'),
    segmentCount: 4,
    rungs: [
      { id: 'v240', width: 160, height: 90, bitrateKbps: 120 },
      { id: 'v360', width: 320, height: 180, bitrateKbps: 250 },
    ],
  };
}

/** 3 segments (6 s = 281.25 AAC frames): the last audio segment is a frame shorter, the VOD case. */
export function tinyVodSpec(): StreamSpec {
  return {
    ...specOf('vod-cmaf-short'),
    segmentCount: 3,
    rungs: [{ id: 'v240', width: 160, height: 90, bitrateKbps: 120 }],
  };
}

/** WebM + Opus, 3 segments, one rung. */
export function tinyWebmSpec(): StreamSpec {
  return {
    ...specOf('vod-webm'),
    segmentCount: 3,
    rungs: [{ id: 'v240', width: 160, height: 90, bitrateKbps: 120 }],
  };
}

/** The smallest stream there is: 2 segments, one rung. Used where a test only needs bytes (determinism, repair, corruption). */
export function microWebmSpec(): StreamSpec {
  return { ...tinyWebmSpec(), segmentCount: 2 };
}

/**
 * The encrypted stream, small: 160x90, 4 segments (so the audio cut is 94, 94, 94, 93), the catalog's own key pair. The unencrypted
 * twin (same spec, no `drm`) is what the decrypted output has to equal.
 */
export function tinyClearKeySpec(): StreamSpec {
  return {
    ...specOf('vod-cmaf-clearkey'),
    segmentCount: 4,
    rungs: [{ id: 'v360', width: 160, height: 90, bitrateKbps: 120 }],
  };
}

/** What `parseInit` reports for one protected AAC track (cenc, 8-byte IVs): the context `parseMediaSegment` needs to read a senc. */
export function protectedAudioInit(): ParsedInit {
  return {
    movieTimescale: 1000,
    topLevelTypes: ['ftyp', 'moov'],
    hasMvex: true,
    tracks: [
      {
        trackId: 1,
        handler: 'soun',
        timescale: 48_000,
        mdhdDuration: 0,
        hasEditList: false,
        codec: 'mp4a.40.2',
        entry: {
          kind: 'audio',
          format: 'enca',
          channelCount: 2,
          sampleRate: 48_000,
          protection: {
            originalFormat: 'mp4a',
            scheme: 'cenc',
            schemeVersion: 0x10000,
            defaultKid: '00'.repeat(16),
            ivSize: 8,
          },
        },
      },
    ],
  };
}

const sha = (n: number): string => n.toString(16).padStart(64, '0');

export interface SyntheticOptions {
  id?: StreamId;
  kind?: 'vod' | 'live';
  packaging?: 'cmaf' | 'webm';
  segmentCount?: number;
  /** 'rule': the cutting rule (94, 94, 94, 93, ...). 'naive': every audio segment 94 frames, what "at least 2 s since the last cut" gives. */
  audio?: 'rule' | 'naive';
  protocols?: Protocol[];
}

/** A StreamIndex built from numbers only: video 30 fps in 15360 ticks, AAC in 48000 (or WebM in 1000), real-looking sizes. */
export function syntheticIndex(o: SyntheticOptions = {}): StreamIndex {
  const kind = o.kind ?? 'vod';
  const packaging = o.packaging ?? 'cmaf';
  const count = o.segmentCount ?? 6;
  const webm = packaging === 'webm';
  const videoScale = webm ? 1000 : 15360;
  const videoTicks = webm ? 2000 : 30720;
  const mime = (t: 'video' | 'audio'): RepInfo['mimeType'] => `${t}/${webm ? 'webm' : 'mp4'}`;
  const ladder: Array<[string, number, number, number, string]> = [
    ['v240', 426, 240, 300_000, 'vp09.00.20.08'],
    ['v360', 640, 360, 700_000, 'vp09.00.21.08'],
    ['v720', 1280, 720, 1_800_000, 'vp09.00.31.08'],
  ];
  const mk = (rep: RepInfo, timescale: number, durations: number[], bytesPerSecond: number): RepIndex => {
    let start = 0;
    const segments = durations.map((duration, i) => {
      const seg = {
        number: i + 1,
        start,
        duration,
        bytes: Math.round(((bytesPerSecond / 8) * duration) / timescale) + i,
        sha256: sha(i + 1),
      };
      start += duration;
      return seg;
    });
    return { rep, timescale, segments, loopTicks: start };
  };
  const reps: RepIndex[] = ladder.map(([id, width, height, bandwidth, codecs]) =>
    mk(
      {
        id,
        track: 'video',
        mimeType: mime('video'),
        codecs,
        bandwidth,
        width,
        height,
        frameRate: 30,
        initExt: webm ? 'webm' : 'mp4',
        segmentExt: webm ? 'webm' : 'm4s',
      },
      videoScale,
      Array.from({ length: count }, () => videoTicks),
      bandwidth,
    ),
  );
  const grid = webm ? OPUS_WEBM_GRID : AAC_GRID;
  const frames =
    o.audio === 'naive' ? Array.from({ length: count }, () => 94) : audioSegmentFrameCounts(count, 2, grid);
  const audioScale = webm ? 1000 : 48_000;
  reps.push(
    mk(
      {
        id: webm ? 'a-opus' : 'a-aac',
        track: 'audio',
        mimeType: mime('audio'),
        codecs: webm ? 'opus' : 'mp4a.40.2',
        bandwidth: 66_000,
        channels: 2,
        sampleRate: 48_000,
        initExt: webm ? 'webm' : 'mp4',
        segmentExt: webm ? 'webm' : 'm4s',
      },
      audioScale,
      frames.map((f) => f * grid.frameSamples),
      64_000,
    ),
  );
  const info: StreamInfo = {
    id: o.id ?? (kind === 'live' ? 'live-cmaf' : webm ? 'vod-webm' : 'vod-cmaf'),
    kind,
    packaging,
    protocols: o.protocols ?? (webm ? ['dash'] : ['dash', 'hls']),
    segmentDurationSec: 2,
    segmentCount: count,
    durationSec: count * 2,
    reps: reps.map((r) => r.rep),
    contentHash: sha(7),
    ffmpegVersion: 'test',
  };
  return { info, reps };
}
