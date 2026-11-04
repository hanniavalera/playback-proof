// Packets in, segments out. Everything here is a pure function of buffers, so it is tested without ffmpeg (and again with real ffmpeg
// output in tests/unit/media). ffmpeg only encodes; where a segment starts and what its timestamps are is decided here, on the 2 s grid
// (docs/decisions/media.md: ADR-042 for the audio cutting rule, ADR-043 for timestamps).

import {
  buildMediaSegment,
  parseInit,
  parseMediaSegment,
  readBoxes,
  removeBoxes,
  type InitTrack,
  type ParsedInit,
} from './isobmff.ts';
import { buildCluster, parseWebmFile, type ParsedWebmInit, type WebmTrack } from './ebml.ts';

/** One encoded access unit (a video frame, an AAC frame, an Opus packet). */
export interface Packet {
  data: Buffer;
  /** A random access point. Every audio packet is one; a video packet is when it is a keyframe. */
  sync: boolean;
  /** Common Encryption: this sample's initialization vector. It belongs to the sample, so it moves with it into whichever segment it lands. */
  iv?: Buffer;
}

// ------------------------------------------------------------------------------------------------------------------------------
// The segment grid
// ------------------------------------------------------------------------------------------------------------------------------

/** The unit audio is cut in: `frameSamples` samples (or milliseconds) per frame at `sampleRate` units per second. */
export interface AudioGrid {
  sampleRate: number;
  frameSamples: number;
}

export const AAC_GRID: AudioGrid = { sampleRate: 48_000, frameSamples: 1024 };
/** WebM timestamps are milliseconds and an Opus frame is 20 ms. */
export const OPUS_WEBM_GRID: AudioGrid = { sampleRate: 1000, frameSamples: 20 };

/** Exact integer ceil(a / b). `%` on doubles is exact, so no rounding error can move a boundary by a frame. */
export function ceilDiv(a: number, b: number): number {
  const r = a % b;
  return (a - r) / b + (r === 0 ? 0 : 1);
}

export function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}

/**
 * Frames in `durationSec` seconds of audio, counting whole frames only: 60 s of 48 kHz AAC is 2812.5 frames, so 2812. The audio never
 * runs past the video, which is what makes the presentation duration equal the video duration.
 */
export function audioFrameCount(durationSec: number, grid: AudioGrid): number {
  return floorDiv(durationSec * grid.sampleRate, grid.frameSamples);
}

/**
 * First frame (0-based) of each segment, followed by the frame count in total: `segmentCount + 1` numbers.
 *
 * THE CUTTING RULE: segment k starts at the first frame whose start time is >= (k-1) * segmentSec, i.e. frame ceil((k-1) * T * rate / N).
 * Not "at least segmentSec after the previous segment started" (what ffmpeg's dash muxer does): 48 kHz AAC has 93.75 frames per 2 s,
 * that rule makes every segment 94 frames (2.0053 s) and the audio drifts 5.3 ms per segment against the video. By cumulative rounding
 * the counts repeat 94, 94, 94, 93 (375 frames = exactly 8 s every four segments) and the error never exceeds one frame.
 */
export function audioSegmentStartFrames(segmentCount: number, segmentSec: number, grid: AudioGrid): number[] {
  const unitsPerSegment = segmentSec * grid.sampleRate;
  if (!Number.isInteger(unitsPerSegment))
    throw new RangeError(`a ${segmentSec} s segment is not a whole number of ${grid.sampleRate} Hz units`);
  const starts: number[] = [];
  for (let k = 1; k <= segmentCount; k++) starts.push(ceilDiv((k - 1) * unitsPerSegment, grid.frameSamples));
  starts.push(audioFrameCount(segmentCount * segmentSec, grid));
  return starts;
}

/** Frames per segment. For 48 kHz AAC and 2 s segments: 94, 94, 94, 93, 94, 94, 94, 93, ... */
export function audioSegmentFrameCounts(segmentCount: number, segmentSec: number, grid: AudioGrid): number[] {
  const starts = audioSegmentStartFrames(segmentCount, segmentSec, grid);
  const counts = starts.slice(1).map((end, i) => end - (starts[i] as number));
  if (counts.some((c) => c < 1)) throw new RangeError(`a ${segmentSec} s segment holds no whole audio frame`);
  return counts;
}

export function videoSegmentFrameCounts(
  segmentCount: number,
  segmentSec: number,
  frameRate: number,
): number[] {
  const perSegment = segmentSec * frameRate;
  if (!Number.isInteger(perSegment))
    throw new RangeError(`${segmentSec} s at ${frameRate} fps is not a whole number of frames`);
  return Array.from({ length: segmentCount }, () => perSegment);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Reading ffmpeg's intermediates
// ------------------------------------------------------------------------------------------------------------------------------

export interface IsobmffSource {
  /** ftyp + moov exactly as the muxer wrote them (see `normalizeInit`). */
  init: Buffer;
  parsedInit: ParsedInit;
  track: InitTrack;
  /** In decode order. */
  packets: Packet[];
  /** Per-packet duration in ticks of the track timescale, as the muxer recorded them. */
  durations: number[];
}

/** Reads the packets of a single-track fragmented MP4 written by ffmpeg. Composition offsets would mean reordering: not supported. */
export function readIsobmffPackets(file: Buffer): IsobmffSource {
  const top = readBoxes(file);
  const firstMoof = top.find((b) => b.type === 'moof');
  if (!firstMoof)
    throw new Error(
      'intermediate MP4 has no fragments (moof): was it written with frag_keyframe/empty_moov?',
    );
  const init = file.subarray(0, firstMoof.start);
  const parsedInit = parseInit(init);
  if (parsedInit.tracks.length !== 1)
    throw new Error(`intermediate MP4 has ${parsedInit.tracks.length} tracks, expected 1`);
  const track = parsedInit.tracks[0] as InitTrack;
  if (track.entry.protection)
    throw new Error(
      'intermediate MP4 is protected: the lab encrypts after the cut, ffmpeg must write clear samples',
    );
  const parsed = parseMediaSegment(file, parsedInit);
  const packets: Packet[] = [];
  const durations: number[] = [];
  for (const fragment of parsed.fragments) {
    for (const traf of fragment.trafs) {
      if (traf.trackId !== track.trackId)
        throw new Error(`fragment carries track ${traf.trackId}, expected ${track.trackId}`);
      for (const s of traf.samples) {
        if (s.ctsOffset !== 0)
          throw new Error('intermediate MP4 has composition time offsets (frame reordering): unsupported');
        if (s.offset + s.size > file.length)
          throw new Error('sample data runs past the end of the intermediate MP4');
        packets.push({ data: file.subarray(s.offset, s.offset + s.size), sync: s.sync });
        durations.push(s.duration);
      }
    }
  }
  return { init, parsedInit, track, packets, durations };
}

/**
 * The init segment the pipeline ships: ffmpeg's ftyp + moov without the metadata box (`udta`: an empty iTunes-style `meta`) and
 * without any edit list. An edit list moves the presentation timeline away from the media timeline, and the live loop rewrites the
 * media timeline: the two must stay the same thing (ADR-043).
 */
export function normalizeInit(init: Buffer): Buffer {
  return removeBoxes(init, [
    ['moov', 'udta'],
    ['moov', 'trak', 'edts'],
  ]);
}

export interface WebmSource {
  init: ParsedWebmInit;
  track: WebmTrack;
  packets: Packet[];
  /** Timecodes (ms) as the muxer wrote them: only used to sanity-check the packet order. */
  timecodes: number[];
}

/** Reads the packets of a single-track WebM file written by ffmpeg. */
export function readWebmPackets(file: Buffer): WebmSource {
  const { init, clusters } = parseWebmFile(file);
  if (init.tracks.length !== 1)
    throw new Error(`intermediate WebM has ${init.tracks.length} tracks, expected 1`);
  const track = init.tracks[0] as WebmTrack;
  const packets: Packet[] = [];
  const timecodes: number[] = [];
  for (const c of clusters) {
    for (const b of c.blocks) {
      if (b.track !== track.number)
        throw new Error(`block of track ${b.track} in a single-track file (track ${track.number})`);
      packets.push({ data: b.data, sync: b.keyframe });
      timecodes.push(b.timecode);
    }
  }
  return { init, track, packets, timecodes };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Writing segments
// ------------------------------------------------------------------------------------------------------------------------------

function splitByCounts<T>(items: T[], counts: number[], what: string): T[][] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== items.length)
    throw new Error(
      `${what}: ${items.length} packets cannot be split as ${counts.length} segments of ${total} packets`,
    );
  const out: T[][] = [];
  let at = 0;
  for (const c of counts) {
    out.push(items.slice(at, at + c));
    at += c;
  }
  return out;
}

export interface IsobmffSegmentation {
  trackId: number;
  /** Every sample lasts exactly this many ticks (512 for 30 fps video at 15360, 1024 for AAC at 48000). */
  ticksPerSample: number;
  packets: Packet[];
  /** Samples per segment. */
  counts: number[];
  /** A video segment must start at a sync sample; audio segments always do. */
  requireSyncStart?: boolean;
}

/** One file per segment: [styp] moof(mfhd, traf(tfhd, tfdt v1, trun)) mdat, with the decode time on the track's own timeline. */
export function buildIsobmffSegments(opts: IsobmffSegmentation): Buffer[] {
  const groups = splitByCounts(opts.packets, opts.counts, 'buildIsobmffSegments');
  let sampleIndex = 0;
  return groups.map((group, i) => {
    const first = group[0];
    if (opts.requireSyncStart !== false && !first?.sync) {
      throw new Error(
        `segment ${i + 1} does not start with a sync sample (sample ${sampleIndex}): the encoder did not honour the keyframe grid`,
      );
    }
    const segment = buildMediaSegment({
      trackId: opts.trackId,
      sequenceNumber: i + 1,
      baseMediaDecodeTime: sampleIndex * opts.ticksPerSample,
      samples: group.map((p) => {
        const sample = { data: p.data, duration: opts.ticksPerSample, sync: p.sync };
        return p.iv ? { ...sample, iv: p.iv } : sample;
      }),
    });
    sampleIndex += group.length;
    return segment;
  });
}

export interface WebmSegmentation {
  trackNumber: number;
  packets: Packet[];
  counts: number[];
  /** Timecode in milliseconds of packet i. Synthesized from the index, not copied from the muxer (which rounds a few of them by 1 ms). */
  timecodeMs: (packetIndex: number) => number;
  requireSyncStart?: boolean;
}

/** One Cluster per segment; the cluster timecode is the timecode of its first packet and every block is relative to it. */
export function buildWebmSegments(opts: WebmSegmentation): Buffer[] {
  const groups = splitByCounts(opts.packets, opts.counts, 'buildWebmSegments');
  let sampleIndex = 0;
  return groups.map((group, i) => {
    if (opts.requireSyncStart !== false && !group[0]?.sync) {
      throw new Error(
        `segment ${i + 1} does not start with a keyframe (packet ${sampleIndex}): the encoder did not honour the keyframe grid`,
      );
    }
    const clusterTimecode = opts.timecodeMs(sampleIndex);
    const cluster = buildCluster(
      clusterTimecode,
      group.map((p, j) => ({
        trackNumber: opts.trackNumber,
        relativeTimecode: opts.timecodeMs(sampleIndex + j) - clusterTimecode,
        keyframe: p.sync,
        data: p.data,
      })),
    );
    sampleIndex += group.length;
    return cluster;
  });
}
