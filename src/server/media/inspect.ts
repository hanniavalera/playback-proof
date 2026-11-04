// Reads generated files back and reports what is REALLY in them: timescale, codec string, size, and per segment the first sample's decode
// time, the total sample duration, the sample count and whether the first sample is a sync sample. The index of a stream is built from
// this (never from what the generator meant to write), and tools/verify-streams.ts compares it with ffprobe's numbers.
//
// Structural rules enforced for every segment (a violation is an error that names the segment):
//   fMP4: [styp] + exactly one moof + exactly one mdat, no sidx, one traf of the track, tfdt present, samples tile the mdat payload;
//   WebM: exactly one Cluster.

import { parseVp9Frame, vp9LevelFor } from './codecs.ts';
import { parseWebmInit, parseWebmMediaSegment, type ParsedWebmInit, type WebmTrack } from './ebml.ts';
import { parseInit, parseMediaSegment, payloadStart, vp9CodecString, type InitTrack } from './isobmff.ts';

export interface InspectedSegment {
  /** Decode time of the first sample, in ticks. */
  start: number;
  /** Sum of the sample durations, in ticks. */
  duration: number;
  samples: number;
  startsWithSync: boolean;
  /** Number of sync samples in the segment (1 for a 2 s video GOP, all of them for audio). */
  syncSamples: number;
}

export interface InspectedRep {
  kind: 'video' | 'audio';
  timescale: number;
  codecs: string;
  width?: number;
  height?: number;
  frameRate?: number;
  channels?: number;
  sampleRate?: number;
  segments: InspectedSegment[];
}

function inspectIsobmff(initBuf: Buffer, segments: Buffer[]): InspectedRep {
  const init = parseInit(initBuf);
  if (init.tracks.length !== 1) throw new Error(`init segment has ${init.tracks.length} tracks, expected 1`);
  const track = init.tracks[0] as InitTrack;
  if (track.hasEditList)
    throw new Error(
      'init segment has an edit list: the media timeline would differ from the presentation timeline',
    );
  let firstSampleDuration = 0;
  let firstKeyframeWidth: number | undefined;
  const out: InspectedSegment[] = segments.map((buf, i) => {
    const where = `segment ${i + 1}`;
    const parsed = parseMediaSegment(buf, init);
    const types = parsed.boxes.map((b) => b.type);
    if (parsed.fragments.length !== 1 || parsed.mdats.length !== 1) {
      throw new Error(`${where}: expected one moof and one mdat, found ${types.join(' ')}`);
    }
    if (types.some((t) => t !== 'styp' && t !== 'moof' && t !== 'mdat')) {
      throw new Error(
        `${where}: unexpected top-level boxes (${types.join(' ')}); media segments carry no sidx, free or emsg`,
      );
    }
    const fragment = parsed.fragments[0];
    const traf = fragment?.trafs[0];
    if (!fragment || fragment.trafs.length !== 1 || !traf)
      throw new Error(`${where}: expected one traf, found ${fragment?.trafs.length ?? 0}`);
    if (traf.trackId !== track.trackId)
      throw new Error(`${where}: traf is for track ${traf.trackId}, init has track ${track.trackId}`);
    const mdat = parsed.mdats[0];
    if (!mdat) throw new Error(`${where}: no mdat`);
    if (traf.samples.length === 0) throw new Error(`${where}: no samples`);
    // The samples must tile the mdat payload exactly: no stray bytes, nothing outside the box.
    let cursor = payloadStart(mdat);
    for (const s of traf.samples) {
      if (s.offset !== cursor)
        throw new Error(
          `${where}: samples are not contiguous in the mdat (sample at ${s.offset}, expected ${cursor})`,
        );
      cursor += s.size;
    }
    if (cursor !== mdat.start + mdat.size)
      throw new Error(
        `${where}: the samples cover ${cursor - payloadStart(mdat)} of ${mdat.size - mdat.headerSize} mdat bytes`,
      );
    if (i === 0) {
      firstSampleDuration = (traf.samples[0] as { duration: number }).duration;
      const first = traf.samples[0];
      if (first && track.entry.kind === 'video') {
        const frame = parseVp9Frame(buf.subarray(first.offset, first.offset + first.size));
        if (!frame.keyFrame) throw new Error(`${where}: first frame is not a VP9 key frame`);
        firstKeyframeWidth = frame.width;
        const vpcC = track.entry.vpcC;
        if (vpcC && (vpcC.profile !== frame.profile || vpcC.bitDepth !== frame.bitDepth)) {
          throw new Error(
            `vpcC says profile ${vpcC.profile} / ${vpcC.bitDepth}-bit but the bitstream says ${frame.profile} / ${frame.bitDepth}-bit`,
          );
        }
      }
    }
    return {
      start: traf.baseMediaDecodeTime,
      duration: traf.duration,
      samples: traf.samples.length,
      startsWithSync: traf.samples[0]?.sync ?? false,
      syncSamples: traf.samples.filter((s) => s.sync).length,
    };
  });
  const rep: InspectedRep = {
    kind: track.entry.kind,
    timescale: track.timescale,
    codecs: track.codec,
    segments: out,
  };
  if (track.entry.kind === 'video') {
    rep.width = track.entry.width;
    rep.height = track.entry.height;
    if (firstKeyframeWidth !== undefined && firstKeyframeWidth !== track.entry.width) {
      throw new Error(
        `sample entry says ${track.entry.width} px wide but the key frame says ${firstKeyframeWidth}`,
      );
    }
    if (firstSampleDuration > 0) rep.frameRate = track.timescale / firstSampleDuration;
    const vpcC = track.entry.vpcC;
    if (vpcC && rep.frameRate !== undefined) {
      // The container's level must be the level the picture size and frame rate need (ffmpeg derives it the same way).
      const level = vp9LevelFor(track.entry.width, track.entry.height, rep.frameRate);
      if (vpcC.level !== level)
        throw new Error(
          `vpcC level ${vpcC.level} but ${track.entry.width}x${track.entry.height}@${rep.frameRate} needs ${level}`,
        );
    }
  } else {
    rep.channels = track.entry.channelCount;
    rep.sampleRate = track.entry.sampleRate;
  }
  return rep;
}

function webmTrackCodec(
  track: WebmTrack,
  firstFrame: Buffer | undefined,
  width: number | undefined,
  height: number | undefined,
  fps: number | undefined,
): string {
  if (track.codecId === 'A_OPUS') return 'opus';
  if (track.codecId === 'V_VP9') {
    if (!firstFrame || !width || !height || !fps)
      throw new Error('cannot derive the VP9 codec string without a key frame and a frame rate');
    const frame = parseVp9Frame(firstFrame);
    if (!frame.keyFrame) throw new Error('first WebM frame is not a VP9 key frame');
    return vp9CodecString(frame.profile, vp9LevelFor(width, height, fps), frame.bitDepth);
  }
  throw new Error(`unsupported WebM codec ${track.codecId}`);
}

function inspectWebm(initBuf: Buffer, segments: Buffer[]): InspectedRep {
  const init: ParsedWebmInit = parseWebmInit(initBuf);
  if (init.tracks.length !== 1) throw new Error(`init segment has ${init.tracks.length} tracks, expected 1`);
  const track = init.tracks[0] as WebmTrack;
  if (track.defaultDurationNs === undefined)
    throw new Error('the track has no DefaultDuration: sample durations cannot be derived');
  const ticksPerSecond = 1e9 / init.timecodeScaleNs;
  let firstFrame: Buffer | undefined;
  const out: InspectedSegment[] = segments.map((buf, i) => {
    const cluster = parseWebmMediaSegment(buf);
    if (cluster.blocks.length === 0) throw new Error(`segment ${i + 1}: no blocks`);
    if (i === 0) firstFrame = (cluster.blocks[0] as { data: Buffer }).data;
    const first = cluster.blocks[0];
    // Blocks carry no duration: the segment lasts (blocks x DefaultDuration), rounded to the timecode tick.
    return {
      start: first ? first.timecode : cluster.timecode,
      duration: Math.round((cluster.blocks.length * track.defaultDurationNs!) / init.timecodeScaleNs),
      samples: cluster.blocks.length,
      startsWithSync: first?.keyframe ?? false,
      syncSamples: cluster.blocks.filter((b) => b.keyframe).length,
    };
  });
  const kind = track.type === 'video' ? 'video' : 'audio';
  const rep: InspectedRep = { kind, timescale: ticksPerSecond, codecs: '', segments: out };
  if (kind === 'video') {
    rep.width = track.width;
    rep.height = track.height;
    const seg = out[0];
    if (seg) rep.frameRate = seg.samples / (seg.duration / ticksPerSecond);
    rep.codecs = webmTrackCodec(track, firstFrame, track.width, track.height, rep.frameRate);
  } else {
    rep.channels = track.channels;
    rep.sampleRate = track.samplingFrequency;
    rep.codecs = webmTrackCodec(track, firstFrame, undefined, undefined, undefined);
  }
  return rep;
}

export function inspectRep(packaging: 'cmaf' | 'webm', init: Buffer, segments: Buffer[]): InspectedRep {
  return packaging === 'cmaf' ? inspectIsobmff(init, segments) : inspectWebm(init, segments);
}
