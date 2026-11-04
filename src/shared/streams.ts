// The stream catalog contract. The authoritative catalog (durations, ladders, hashes) is produced by the media
// pipeline (src/server/media) and served by `GET /api/streams`. Tests read it from there, they never hard-code a duration.

export const STREAM_IDS = [
  'vod-cmaf',
  'vod-cmaf-short',
  'vod-webm',
  'live-cmaf',
  'vod-cmaf-clearkey',
] as const;
export type StreamId = (typeof STREAM_IDS)[number];

export type Protocol = 'dash' | 'hls';
export type Track = 'video' | 'audio';

export interface RepInfo {
  /** 'v240' | 'v360' | 'v720' (video, ascending bitrate) | 'a-aac' | 'a-opus' (audio). */
  id: string;
  track: Track;
  mimeType: 'video/mp4' | 'audio/mp4' | 'video/webm' | 'audio/webm';
  /** RFC 6381 codec string, e.g. 'vp09.00.10.08', 'mp4a.40.2', 'opus'. */
  codecs: string;
  /** Declared bandwidth in bits per second (what the manifest advertises). */
  bandwidth: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** Audio only: channel count and sample rate as found in the file (manifests need them: AudioChannelConfiguration, CHANNELS). */
  channels?: number;
  sampleRate?: number;
  initExt: 'mp4' | 'webm';
  segmentExt: 'm4s' | 'webm';
}

export interface DrmInfo {
  scheme: 'clearkey';
  /** 16 bytes, hex. A fixed, public, throw-away test key (never a real secret). */
  keyId: string;
  key: string;
}

export interface StreamInfo {
  id: StreamId;
  kind: 'vod' | 'live';
  packaging: 'cmaf' | 'webm';
  protocols: Protocol[];
  /** Nominal segment duration in seconds. Every rung is GOP-aligned to it. */
  segmentDurationSec: number;
  /** VOD: number of segments. Live: number of distinct source segments that are looped (the loop is rewritten to a monotonic timeline). */
  segmentCount: number;
  /** VOD: total duration. Live: duration of the looped source. */
  durationSec: number;
  reps: RepInfo[];
  drm?: DrmInfo;
  /** sha256 hex over the generation spec and every segment hash: identical spec + ffmpeg build => identical hash. */
  contentHash: string;
  ffmpegVersion: string;
}
