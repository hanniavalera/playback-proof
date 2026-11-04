// The stream catalog as pure data (docs/CONTRACTS.md section 3), and the cache key derived from it.
//
// A spec says WHAT to build. `ffmpegPlan` turns it into the exact ffmpeg arguments, and `specHash` hashes the spec together with the
// resolved plan of every representation, so changing an encoder option, the test pattern or a ladder rung changes the key and the
// cache regenerates. Changes outside ffmpeg's arguments (segmenter, writers) bump GENERATOR_VERSION.

import { createHash } from 'node:crypto';
import type { Protocol, StreamId } from '../../shared/streams.ts';

/**
 * Bump when the generator's own logic changes what lands in the cache without changing any ffmpeg argument: the segmenter, the box
 * writers, init normalization, or the shape of stream.json. The bump changes every spec hash, so stale caches are regenerated.
 */
export const GENERATOR_VERSION = 2;

export const SEGMENT_DURATION_SEC = 2;
export const FRAME_RATE = 30;
export const AUDIO_SAMPLE_RATE = 48_000;

export type VideoRepId = 'v240' | 'v360' | 'v720';
export type AudioRepId = 'a-aac' | 'a-opus';

export interface VideoRungSpec {
  id: VideoRepId;
  width: number;
  height: number;
  bitrateKbps: number;
}

/** The test tone: a pitch that climbs one semitone per segment and two short beeps per segment, silent at both ends of the stream. */
export interface SignalSpec {
  baseHz: number;
  /** The pitch pattern repeats after this many segments. */
  stepsPerOctave: number;
  amplitude: number;
  /** Beep windows in seconds from the start of each segment: [from, to]. The second beep is a fifth above the first. */
  beeps: [[number, number], [number, number]];
  fadeSec: number;
}

export interface AudioTrackSpec {
  id: AudioRepId;
  codec: 'aac' | 'opus';
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  signal: SignalSpec;
}

/** A fixed, public, throw-away key pair for the ClearKey stream: it protects nothing and is meant to be read. */
export interface DrmSpec {
  scheme: 'clearkey';
  keyId: string;
  key: string;
}

export interface StreamSpec {
  id: StreamId;
  kind: 'vod' | 'live';
  packaging: 'cmaf' | 'webm';
  protocols: Protocol[];
  segmentDurationSec: number;
  segmentCount: number;
  frameRate: number;
  rungs: VideoRungSpec[];
  audio: AudioTrackSpec;
  /** ffmpeg options shared by every rung (the bitrate is added per rung) and by the audio encoder. */
  encoders: { video: string[]; audio: string[] };
  drm?: DrmSpec;
}

export const LADDER: VideoRungSpec[] = [
  { id: 'v240', width: 426, height: 240, bitrateKbps: 300 },
  { id: 'v360', width: 640, height: 360, bitrateKbps: 700 },
  { id: 'v720', width: 1280, height: 720, bitrateKbps: 1800 },
];

const SIGNAL: SignalSpec = {
  baseHz: 261.63,
  stepsPerOctave: 12,
  amplitude: 0.25,
  beeps: [
    [0.1, 0.4],
    [1.1, 1.4],
  ],
  fadeSec: 0.02,
};

// libvpx-vp9, constant-ish bitrate (min = max = target selects CBR), a keyframe every 2 s (forced, so that it does not depend on scene
// detection), no look-ahead or alt-ref frames (so a segment's bytes never depend on what follows it), and row-mt OFF: with row-mt on the
// bitstream depends on whether the encoder runs on one thread or several, with it off it is identical for any thread count (ADR-045).
const VIDEO_ENCODER = [
  '-c:v',
  'libvpx-vp9',
  '-pix_fmt',
  'yuv420p',
  '-deadline',
  'good',
  '-cpu-used',
  '4',
  '-row-mt',
  '0',
  '-tile-columns',
  '2',
  '-frame-parallel',
  '0',
  '-auto-alt-ref',
  '0',
  '-lag-in-frames',
  '0',
  '-g',
  String(SEGMENT_DURATION_SEC * FRAME_RATE),
  '-keyint_min',
  String(SEGMENT_DURATION_SEC * FRAME_RATE),
  '-force_key_frames',
  `expr:gte(t,n_forced*${SEGMENT_DURATION_SEC})`,
];

const AAC_ENCODER = ['-c:a', 'aac', '-aac_coder', 'twoloop', '-profile:a', 'aac_low'];
const OPUS_ENCODER = [
  '-c:a',
  'libopus',
  '-vbr',
  'off',
  '-application',
  'audio',
  '-frame_duration',
  '20',
  '-compression_level',
  '10',
];

function spec(
  id: StreamId,
  kind: 'vod' | 'live',
  packaging: 'cmaf' | 'webm',
  protocols: Protocol[],
  segmentCount: number,
): StreamSpec {
  const aac = packaging === 'cmaf';
  return {
    id,
    kind,
    packaging,
    protocols,
    segmentDurationSec: SEGMENT_DURATION_SEC,
    segmentCount,
    frameRate: FRAME_RATE,
    rungs: LADDER,
    audio: {
      id: aac ? 'a-aac' : 'a-opus',
      codec: aac ? 'aac' : 'opus',
      bitrateKbps: 64,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 2,
      signal: SIGNAL,
    },
    encoders: { video: VIDEO_ENCODER, audio: aac ? AAC_ENCODER : OPUS_ENCODER },
  };
}

/**
 * Every stream is encoded on its own: a stream is a pure function of its spec, with no dependency on another stream's cache. (They are
 * not slices of each other: the encoders see a different end of stream, so the bytes would differ anyway. ADR-041.)
 * `vod-cmaf-clearkey` (the stretch goal) is not in the catalog: see docs/decisions/media.md.
 */
export const CATALOG: StreamSpec[] = [
  spec('vod-cmaf', 'vod', 'cmaf', ['dash', 'hls'], 30),
  spec('vod-cmaf-short', 'vod', 'cmaf', ['dash', 'hls'], 6),
  spec('vod-webm', 'vod', 'webm', ['dash'], 15),
  spec('live-cmaf', 'live', 'cmaf', ['dash', 'hls'], 12),
];

export function streamSpec(id: StreamId): StreamSpec | undefined {
  return CATALOG.find((s) => s.id === id);
}

export const totalDurationSec = (s: StreamSpec): number => s.segmentCount * s.segmentDurationSec;

// ------------------------------------------------------------------------------------------------------------------------------
// ffmpeg plans
// ------------------------------------------------------------------------------------------------------------------------------

export interface FfmpegPlan {
  repId: string;
  container: 'mp4' | 'webm';
  /** Input options up to and including `-i <source>`. */
  input: string[];
  /** Output options, without `-threads` and without the output path. */
  output: string[];
}

/** ffmpeg expression language: `t` is the time in seconds. See SignalSpec for what it draws. */
export function signalExpressions(signal: SignalSpec, segmentSec: number): [string, string] {
  const u = `(t-${segmentSec}*floor(t/${segmentSec}))`;
  const envelope = ([from, to]: [number, number]): string =>
    `clip(min((${u}-${from})/${signal.fadeSec},(${to}-${u})/${signal.fadeSec}),0,1)`;
  const f1 = `${signal.baseHz}*pow(2,mod(floor(t/${segmentSec}),${signal.stepsPerOctave})/12)`;
  const f2 = `1.5*${f1}`;
  const [beep1, beep2] = signal.beeps;
  const channel = (omega: string): string =>
    `${signal.amplitude}*(${envelope(beep1)}*sin(${omega}*${f1}*t)+${envelope(beep2)}*sin(${omega}*${f2}*t))`;
  // Left: the tones. Right: one octave lower, so that the two channels are not identical.
  return [channel('2*PI'), channel('PI')];
}

function videoPlan(s: StreamSpec, rung: VideoRungSpec): FfmpegPlan {
  const container = s.packaging === 'webm' ? 'webm' : 'mp4';
  const bitrate = `${rung.bitrateKbps}k`;
  return {
    repId: rung.id,
    container,
    input: [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${rung.width}x${rung.height}:rate=${s.frameRate}:duration=${totalDurationSec(s)},format=yuv420p`,
    ],
    output: [
      '-an',
      ...s.encoders.video,
      '-b:v',
      bitrate,
      '-minrate',
      bitrate,
      '-maxrate',
      bitrate,
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-map_metadata',
      '-1',
      ...containerOptions(container),
    ],
  };
}

function audioPlan(s: StreamSpec): FfmpegPlan {
  const container = s.packaging === 'webm' ? 'webm' : 'mp4';
  const [left, right] = signalExpressions(s.audio.signal, s.segmentDurationSec);
  return {
    repId: s.audio.id,
    container,
    input: [
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=exprs='${left}|${right}':sample_rate=${s.audio.sampleRate}:channel_layout=stereo:duration=${totalDurationSec(s)}`,
    ],
    output: [
      '-vn',
      ...s.encoders.audio,
      '-b:a',
      `${s.audio.bitrateKbps}k`,
      '-ar',
      String(s.audio.sampleRate),
      '-ac',
      String(s.audio.channels),
      '-fflags',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      '-map_metadata',
      '-1',
      ...containerOptions(container),
    ],
  };
}

function containerOptions(container: 'mp4' | 'webm'): string[] {
  return container === 'webm'
    ? ['-f', 'webm', '-dash', '1']
    : ['-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+cmaf'];
}

export function ffmpegPlan(s: StreamSpec, repId: string): FfmpegPlan {
  const rung = s.rungs.find((r) => r.id === repId);
  if (rung) return videoPlan(s, rung);
  if (repId === s.audio.id) return audioPlan(s);
  throw new Error(`stream ${s.id} has no representation '${repId}'`);
}

export const repIds = (s: StreamSpec): string[] => [...s.rungs.map((r) => r.id), s.audio.id];

export const ffmpegPlans = (s: StreamSpec): FfmpegPlan[] => repIds(s).map((id) => ffmpegPlan(s, id));

// ------------------------------------------------------------------------------------------------------------------------------
// The cache key
// ------------------------------------------------------------------------------------------------------------------------------

/** JSON with sorted object keys and no whitespace: the same value always serializes to the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError(`canonicalJson: ${value} is not representable`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** sha256 of the canonical JSON of the spec, the generator version and the resolved ffmpeg arguments of every representation. */
export function specHash(s: StreamSpec): string {
  return sha256Hex(canonicalJson({ generator: GENERATOR_VERSION, spec: s, plans: ffmpegPlans(s) }));
}
