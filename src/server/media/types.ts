// The interface between the media pipeline (src/server/media: ffmpeg, ISO BMFF / WebM parsing, manifest builders) and the HTTP
// service (src/server: sessions, fault engine, live clock, request log). The service never touches ffmpeg or box parsing,
// it asks a MediaStore. The service's tests use an in-memory fake; the real implementation is `createMediaStore` (./index.ts).
// docs/CONTRACTS.md sections 3 and 5 define the semantics behind every field.

import type { RepInfo, StreamId, StreamInfo } from '../../shared/streams.ts';

/** One segment of the pre-encoded source of one representation. Times are ticks of the representation's timescale. */
export interface SourceSegment {
  /** 1-based. */
  number: number;
  /** Decode time of the first sample (fMP4: tfdt baseMediaDecodeTime; WebM: cluster timecode), in ticks. */
  start: number;
  /**
   * The REAL duration: the sum of the sample durations in the file. Never the nominal segment duration: 2 s of 48 kHz AAC is
   * 93.75 frames, so audio segments hold 93 or 94 frames, and manifests must say so.
   */
  duration: number;
  bytes: number;
  sha256: string;
}

export interface RepIndex {
  rep: RepInfo;
  /** Ticks per second of this representation's timeline (for example 15360 for video, 48000 for AAC, 1000 for WebM). */
  timescale: number;
  segments: SourceSegment[];
  /**
   * Length of one pass over the source in ticks (the sum of the segment durations). `loopTicks / timescale` is the same number
   * of seconds for every representation of a stream, to the tick: a live loop must never drift audio against video.
   */
  loopTicks: number;
}

export interface StreamIndex {
  info: StreamInfo;
  reps: RepIndex[];
}

/** The live window a manifest lists: live segment numbers, 1-based, inclusive. */
export interface LiveWindow {
  firstNumber: number;
  lastNumber: number;
}

export interface DashLiveParams extends LiveWindow {
  /** Wall-clock instant of stream time 0 (DASH availabilityStartTime). */
  availabilityStartTime: Date;
  /** When this manifest version was published. A stalled origin keeps the value it had when it stalled. */
  publishTime: Date;
  /** DVR depth in seconds (timeShiftBufferDepth). */
  timeShiftBufferDepthSec: number;
  presentationDelaySec: number;
  minimumUpdatePeriodSec: number;
}

export interface HlsLiveParams extends LiveWindow {
  /** Wall-clock instant of stream time 0; EXT-X-PROGRAM-DATE-TIME of segment n is this + the segment's live start time. */
  availabilityStartTime: Date;
}

export interface MediaStore {
  /** Version string of the ffmpeg that generated the content (also in every StreamInfo). */
  ffmpegVersion(): string;
  /** The ready streams, in STREAM_IDS order. */
  streams(): StreamInfo[];
  has(id: StreamId): boolean;
  /** Throws for a stream that is not ready. */
  index(id: StreamId): StreamIndex;

  /** Initialization segment of a representation. Throws for an unknown stream or representation. */
  init(id: StreamId, repId: string): Buffer;
  /** Source (= VOD) segment, 1-based. `undefined` when the number is out of range. */
  segment(id: StreamId, repId: string, number: number): Buffer | undefined;
  /**
   * Live segment, any n >= 1: source segment ((n-1) mod segmentCount) + 1 with the decode time of every fragment moved by
   * floor((n-1) / segmentCount) * loopTicks. Throws for a stream that is not live.
   */
  liveSegment(id: StreamId, repId: string, number: number): Buffer;
  /** Start and duration of live segment n on the live timeline, in the representation's ticks. */
  liveSegmentTiming(id: StreamId, repId: string, number: number): { start: number; duration: number };

  /** Manifests. Every URL inside is relative to the manifest's own URL (see docs/CONTRACTS.md section 3). */
  dashVod(id: StreamId): string;
  dashLive(id: StreamId, params: DashLiveParams): string;
  hlsMaster(id: StreamId): string;
  hlsMediaVod(id: StreamId, repId: string): string;
  hlsMediaLive(id: StreamId, repId: string, params: HlsLiveParams): string;
}
