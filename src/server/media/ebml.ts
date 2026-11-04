// A small, strict EBML / WebM reader and writer: only what the media pipeline needs, no dependencies.
//
//   reader: EBML header, Segment (known or unknown size) > Info, Tracks > TrackEntry, Cluster > Timecode, SimpleBlock, BlockGroup;
//   writer: the initialization segment (EBML header + Segment + Info + Tracks, no Clusters) and one Cluster per segment.
//
// A WebM media segment is exactly one Cluster; it is decodable only together with the init segment (docs/decisions/media.md, ADR-044).

export class EbmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbmlError';
  }
}

export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Void: 0xec,
} as const;

export interface EbmlElement {
  id: number;
  /** Offset of the element header. */
  start: number;
  headerSize: number;
  dataStart: number;
  dataEnd: number;
  sizeUnknown: boolean;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function readId(buf: Buffer, pos: number, end: number): { id: number; length: number } {
  if (pos >= end) throw new EbmlError(`truncated element id at ${pos}`);
  const first = buf.readUInt8(pos);
  if (first === 0) throw new EbmlError(`invalid element id at ${pos}: first byte is 0`);
  const length = Math.clz32(first) - 24 + 1;
  if (length > 4) throw new EbmlError(`invalid element id at ${pos}: ${length} bytes long (max 4)`);
  if (pos + length > end) throw new EbmlError(`truncated element id at ${pos}`);
  return { id: buf.readUIntBE(pos, length), length };
}

function readSize(
  buf: Buffer,
  pos: number,
  end: number,
): { value: number; length: number; unknown: boolean } {
  if (pos >= end) throw new EbmlError(`truncated element size at ${pos}`);
  const first = buf.readUInt8(pos);
  if (first === 0) throw new EbmlError(`invalid element size at ${pos}: first byte is 0`);
  const length = Math.clz32(first) - 24 + 1;
  if (pos + length > end) throw new EbmlError(`truncated element size at ${pos}`);
  let value = BigInt(first & (0xff >> length));
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = buf.readUInt8(pos + i);
    value = (value << 8n) | BigInt(byte);
    if (byte !== 0xff) allOnes = false;
  }
  if (allOnes) return { value: 0, length, unknown: true };
  if (value > MAX_SAFE) throw new EbmlError(`element size at ${pos} exceeds 2^53`);
  return { value: Number(value), length, unknown: false };
}

/** Reads the elements laid end to end in `buf[start, end)`. Only the Segment may have an unknown size (it then runs to `end`). */
export function readElements(buf: Buffer, start = 0, end = buf.length): EbmlElement[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > buf.length || start > end) {
    throw new RangeError(
      `readElements: invalid range [${start}, ${end}) for a buffer of ${buf.length} bytes`,
    );
  }
  const out: EbmlElement[] = [];
  let pos = start;
  while (pos < end) {
    const id = readId(buf, pos, end);
    const size = readSize(buf, pos + id.length, end);
    const headerSize = id.length + size.length;
    const dataStart = pos + headerSize;
    let dataEnd: number;
    if (size.unknown) {
      if (id.id !== ID.Segment) {
        throw new EbmlError(
          `element 0x${id.id.toString(16)} at ${pos} has an unknown size: only a Segment may`,
        );
      }
      dataEnd = end;
    } else {
      dataEnd = dataStart + size.value;
      if (dataEnd > end) {
        throw new EbmlError(
          `element 0x${id.id.toString(16)} at ${pos} claims ${size.value} bytes but only ${end - dataStart} are left`,
        );
      }
    }
    out.push({ id: id.id, start: pos, headerSize, dataStart, dataEnd, sizeUnknown: size.unknown });
    pos = dataEnd;
  }
  return out;
}

export const children = (buf: Buffer, el: EbmlElement): EbmlElement[] =>
  readElements(buf, el.dataStart, el.dataEnd);

function readUint(buf: Buffer, el: EbmlElement): number {
  const len = el.dataEnd - el.dataStart;
  if (len < 1 || len > 8) throw new EbmlError(`unsigned integer element at ${el.start} has ${len} bytes`);
  let v = 0n;
  for (let i = el.dataStart; i < el.dataEnd; i++) v = (v << 8n) | BigInt(buf.readUInt8(i));
  if (v > MAX_SAFE) throw new EbmlError(`unsigned integer element at ${el.start} exceeds 2^53`);
  return Number(v);
}

function readFloat(buf: Buffer, el: EbmlElement): number {
  const len = el.dataEnd - el.dataStart;
  if (len === 4) return buf.readFloatBE(el.dataStart);
  if (len === 8) return buf.readDoubleBE(el.dataStart);
  throw new EbmlError(`float element at ${el.start} has ${len} bytes`);
}

const readString = (buf: Buffer, el: EbmlElement): string =>
  buf.toString('utf8', el.dataStart, el.dataEnd).replace(/\0+$/, '');

const find = (els: EbmlElement[], id: number): EbmlElement | undefined => els.find((e) => e.id === id);

// ------------------------------------------------------------------------------------------------------------------------------
// Parsed structures
// ------------------------------------------------------------------------------------------------------------------------------

export interface WebmTrack {
  number: number;
  type: 'video' | 'audio' | 'other';
  codecId: string;
  /** Nanoseconds per frame. */
  defaultDurationNs?: number;
  width?: number;
  height?: number;
  channels?: number;
  samplingFrequency?: number;
  codecDelayNs?: number;
  seekPreRollNs?: number;
  codecPrivate?: Buffer;
}

export interface ParsedWebmInit {
  docType: string;
  /** Nanoseconds per timecode tick (1,000,000 = milliseconds). */
  timecodeScaleNs: number;
  tracks: WebmTrack[];
  /** The raw EBML header and Tracks elements, for re-use in the init segment the pipeline writes. */
  ebmlHeader: Buffer;
  tracksElement: Buffer;
  /** Ids of the Segment's children that were seen before the first Cluster. */
  segmentChildIds: number[];
}

export interface WebmBlock {
  track: number;
  /** Absolute timecode in timecode-scale ticks (cluster timecode + relative). */
  timecode: number;
  keyframe: boolean;
  /** The frame payload. */
  data: Buffer;
  /** BlockDuration in ticks, when the block came in a BlockGroup with one. */
  durationTicks?: number;
}

export interface ParsedWebmCluster {
  timecode: number;
  blocks: WebmBlock[];
}

function parseTrackEntry(buf: Buffer, entry: EbmlElement): WebmTrack {
  const kids = children(buf, entry);
  const num = find(kids, ID.TrackNumber);
  const type = find(kids, ID.TrackType);
  const codec = find(kids, ID.CodecID);
  if (!num || !type || !codec)
    throw new EbmlError(`TrackEntry at ${entry.start} lacks TrackNumber, TrackType or CodecID`);
  const typeValue = readUint(buf, type);
  const track: WebmTrack = {
    number: readUint(buf, num),
    type: typeValue === 1 ? 'video' : typeValue === 2 ? 'audio' : 'other',
    codecId: readString(buf, codec),
  };
  const dd = find(kids, ID.DefaultDuration);
  if (dd) track.defaultDurationNs = readUint(buf, dd);
  const delay = find(kids, ID.CodecDelay);
  if (delay) track.codecDelayNs = readUint(buf, delay);
  const preroll = find(kids, ID.SeekPreRoll);
  if (preroll) track.seekPreRollNs = readUint(buf, preroll);
  const priv = find(kids, ID.CodecPrivate);
  if (priv) track.codecPrivate = buf.subarray(priv.dataStart, priv.dataEnd);
  const video = find(kids, ID.Video);
  if (video) {
    const v = children(buf, video);
    const w = find(v, ID.PixelWidth);
    const h = find(v, ID.PixelHeight);
    if (w) track.width = readUint(buf, w);
    if (h) track.height = readUint(buf, h);
  }
  const audio = find(kids, ID.Audio);
  if (audio) {
    const a = children(buf, audio);
    const ch = find(a, ID.Channels);
    const sf = find(a, ID.SamplingFrequency);
    if (ch) track.channels = readUint(buf, ch);
    if (sf) track.samplingFrequency = readFloat(buf, sf);
  }
  return track;
}

function parseBlockPayload(
  buf: Buffer,
  el: EbmlElement,
  clusterTimecode: number,
  simple: boolean,
): WebmBlock {
  const size = readSize(buf, el.dataStart, el.dataEnd);
  const headerEnd = el.dataStart + size.length;
  if (headerEnd + 3 > el.dataEnd) throw new EbmlError(`block at ${el.start} is too short`);
  const rel = buf.readInt16BE(headerEnd);
  const flags = buf.readUInt8(headerEnd + 2);
  if (flags & 0x06)
    throw new EbmlError(
      `block at ${el.start} uses lacing (flags 0x${flags.toString(16)}), which the lab does not support`,
    );
  return {
    track: size.value,
    timecode: clusterTimecode + rel,
    keyframe: simple ? (flags & 0x80) !== 0 : true,
    data: buf.subarray(headerEnd + 3, el.dataEnd),
  };
}

function parseCluster(buf: Buffer, cluster: EbmlElement): ParsedWebmCluster {
  const kids = children(buf, cluster);
  const tc = find(kids, ID.Timecode);
  if (!tc) throw new EbmlError(`Cluster at ${cluster.start} has no Timecode`);
  const timecode = readUint(buf, tc);
  const blocks: WebmBlock[] = [];
  for (const k of kids) {
    if (k.id === ID.SimpleBlock) {
      blocks.push(parseBlockPayload(buf, k, timecode, true));
    } else if (k.id === ID.BlockGroup) {
      const g = children(buf, k);
      const b = find(g, ID.Block);
      if (!b) throw new EbmlError(`BlockGroup at ${k.start} has no Block`);
      const block = parseBlockPayload(buf, b, timecode, false);
      block.keyframe = find(g, ID.ReferenceBlock) === undefined;
      const d = find(g, ID.BlockDuration);
      if (d) block.durationTicks = readUint(buf, d);
      blocks.push(block);
    }
  }
  return { timecode, blocks };
}

function parseInitElements(
  buf: Buffer,
  top: EbmlElement[],
  segment: EbmlElement,
  segKids: EbmlElement[],
): ParsedWebmInit {
  const header = find(top, ID.EBML);
  if (!header) throw new EbmlError('missing EBML header');
  const docTypeEl = find(children(buf, header), ID.DocType);
  const docType = docTypeEl ? readString(buf, docTypeEl) : '';
  if (docType !== 'webm') throw new EbmlError(`EBML DocType is '${docType}', expected 'webm'`);
  const info = find(segKids, ID.Info);
  const tracksEl = find(segKids, ID.Tracks);
  if (!info) throw new EbmlError(`Segment at ${segment.start} has no Info`);
  if (!tracksEl) throw new EbmlError(`Segment at ${segment.start} has no Tracks`);
  const scaleEl = find(children(buf, info), ID.TimecodeScale);
  const timecodeScaleNs = scaleEl ? readUint(buf, scaleEl) : 1_000_000;
  const tracks = children(buf, tracksEl)
    .filter((e) => e.id === ID.TrackEntry)
    .map((e) => parseTrackEntry(buf, e));
  if (tracks.length === 0) throw new EbmlError('Tracks has no TrackEntry');
  const beforeClusters: number[] = [];
  for (const k of segKids) {
    if (k.id === ID.Cluster) break;
    beforeClusters.push(k.id);
  }
  return {
    docType,
    timecodeScaleNs,
    tracks,
    ebmlHeader: buf.subarray(header.start, header.dataEnd),
    tracksElement: buf.subarray(tracksEl.start, tracksEl.dataEnd),
    segmentChildIds: beforeClusters,
  };
}

function topAndSegment(buf: Buffer): { top: EbmlElement[]; segment: EbmlElement; segKids: EbmlElement[] } {
  const top = readElements(buf);
  const segment = find(top, ID.Segment);
  if (!segment) throw new EbmlError('missing Segment');
  return { top, segment, segKids: children(buf, segment) };
}

/** Parses a WebM initialization segment: EBML header, Segment, Info, Tracks and no Cluster. */
export function parseWebmInit(init: Buffer): ParsedWebmInit {
  const { top, segment, segKids } = topAndSegment(init);
  if (segKids.some((e) => e.id === ID.Cluster))
    throw new EbmlError('initialization segment contains a Cluster');
  return parseInitElements(init, top, segment, segKids);
}

/** Parses a whole WebM file (what ffmpeg writes): init information plus every Cluster. */
export function parseWebmFile(file: Buffer): { init: ParsedWebmInit; clusters: ParsedWebmCluster[] } {
  const { top, segment, segKids } = topAndSegment(file);
  const init = parseInitElements(file, top, segment, segKids);
  const clusters = segKids.filter((e) => e.id === ID.Cluster).map((c) => parseCluster(file, c));
  return { init, clusters };
}

/** Parses a WebM media segment: exactly one Cluster and nothing else. */
export function parseWebmMediaSegment(segment: Buffer): ParsedWebmCluster {
  const top = readElements(segment);
  if (top.length !== 1 || top[0]?.id !== ID.Cluster) {
    throw new EbmlError(
      `a WebM media segment must be exactly one Cluster, found ${top.map((e) => `0x${e.id.toString(16)}`).join(', ') || 'nothing'}`,
    );
  }
  return parseCluster(segment, top[0]);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Writer
// ------------------------------------------------------------------------------------------------------------------------------

function encodeId(id: number): Buffer {
  const len = id > 0xff_ffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const b = Buffer.alloc(len);
  b.writeUIntBE(id, 0, len);
  return b;
}

/** Minimal-length EBML size. The all-ones pattern is reserved for "unknown", so a value needs one more bit than its length suggests. */
function encodeSize(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid EBML size ${value}`);
  for (let len = 1; len <= 8; len++) {
    if (BigInt(value) < (1n << BigInt(7 * len)) - 1n) {
      const out = Buffer.alloc(len);
      let v = BigInt(value) | (1n << BigInt(7 * len));
      for (let i = len - 1; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new RangeError(`EBML size ${value} is too large`);
}

export function element(id: number, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([encodeId(id), encodeSize(body.length), body]);
}

export function uintElement(id: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid unsigned value ${value}`);
  let v = BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  return element(id, Buffer.from(bytes));
}

export const stringElement = (id: number, value: string): Buffer => element(id, Buffer.from(value, 'utf8'));

export interface WebmInitSource {
  ebmlHeader: Buffer;
  tracksElement: Buffer;
  timecodeScaleNs: number;
  app: string;
}

/**
 * EBML header + Segment (unknown size, so that Clusters can follow in separate files) + Info + Tracks. Info carries no Duration: a
 * fragment stream's duration belongs to the manifest. SeekHead, Cues and Tags are not written: nothing here seeks by byte position.
 */
export function buildWebmInit(src: WebmInitSource): Buffer {
  const info = element(
    ID.Info,
    uintElement(ID.TimecodeScale, src.timecodeScaleNs),
    stringElement(ID.MuxingApp, src.app),
    stringElement(ID.WritingApp, src.app),
  );
  const segmentHeader = Buffer.concat([
    encodeId(ID.Segment),
    Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  ]);
  return Buffer.concat([src.ebmlHeader, segmentHeader, info, src.tracksElement]);
}

export interface WriteBlock {
  trackNumber: number;
  /** Timecode relative to the cluster, in timecode-scale ticks. */
  relativeTimecode: number;
  keyframe: boolean;
  data: Buffer;
}

export function buildCluster(timecode: number, blocks: WriteBlock[]): Buffer {
  if (blocks.length === 0) throw new RangeError('a Cluster needs at least one block');
  const simpleBlocks = blocks.map((b) => {
    if (b.trackNumber < 1 || b.trackNumber > 126)
      throw new RangeError(`unsupported track number ${b.trackNumber}`);
    if (!Number.isInteger(b.relativeTimecode) || b.relativeTimecode < -32768 || b.relativeTimecode > 32767) {
      throw new RangeError(`relative timecode ${b.relativeTimecode} does not fit 16 bits`);
    }
    const head = Buffer.alloc(4);
    head.writeUInt8(0x80 | b.trackNumber, 0);
    head.writeInt16BE(b.relativeTimecode, 1);
    head.writeUInt8(b.keyframe ? 0x80 : 0x00, 3);
    return element(ID.SimpleBlock, head, b.data);
  });
  return element(ID.Cluster, uintElement(ID.Timecode, timecode), ...simpleBlocks);
}
