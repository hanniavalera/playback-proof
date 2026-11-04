// A small, strict ISO BMFF (MP4) box reader and writer: only what the media pipeline needs, no dependencies.
//
//   reader: ftyp / styp, moov (mvhd, trak > tkhd, edts, mdia > mdhd, hdlr, minf > stbl > stsd > vpcC | esds, mvex > trex),
//           moof (mfhd, traf > tfhd, tfdt, trun), mdat, sidx (only to detect it);
//   writer: styp, one-fragment media segments (moof + mdat), and removal of boxes from an init segment;
//   rewriteTfdt: the live loop's only mutation of a segment.
//
// Strictness is deliberate: every size is bounds-checked against its container and anything unexpected throws a BoxError that says
// where. A parser that guesses would hide exactly the bugs this lab exists to find (see docs/decisions/media.md, ADR-040..049).

export class BoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxError';
  }
}

export interface Box {
  /** Four-character code. */
  type: string;
  /** Offset of the box header in the buffer that was read. */
  start: number;
  /** 8, or 16 for a box with a 64-bit size. */
  headerSize: number;
  /** Total size including the header. For `size == 0` (box runs to the end of its container) the resolved size. */
  size: number;
}

export const payloadStart = (box: Box): number => box.start + box.headerSize;
export const boxEnd = (box: Box): number => box.start + box.size;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = 0xffff_ffff;

/** Reads the boxes laid end to end in `buf[start, end)`. Throws if they do not tile the range exactly. */
export function readBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > buf.length || start > end) {
    throw new RangeError(`readBoxes: invalid range [${start}, ${end}) for a buffer of ${buf.length} bytes`);
  }
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    if (end - pos < 8) throw new BoxError(`truncated box header at ${pos} (${end - pos} bytes left)`);
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let headerSize = 8;
    if (size === 1) {
      if (end - pos < 16) throw new BoxError(`truncated 64-bit size of '${type}' at ${pos}`);
      const large = buf.readBigUInt64BE(pos + 8);
      if (large > MAX_SAFE) throw new BoxError(`box '${type}' at ${pos} is larger than 2^53 bytes`);
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize)
      throw new BoxError(`box '${type}' at ${pos} has size ${size}, smaller than its header`);
    if (pos + size > end) {
      throw new BoxError(
        `box '${type}' at ${pos} claims ${size} bytes but only ${end - pos} are left in its container`,
      );
    }
    boxes.push({ type, start: pos, headerSize, size });
    pos += size;
  }
  return boxes;
}

export function childBoxes(buf: Buffer, parent: Box, skipPayloadBytes = 0): Box[] {
  return readBoxes(buf, payloadStart(parent) + skipPayloadBytes, boxEnd(parent));
}

export function firstBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type);
}

export function requireBox(boxes: Box[], type: string, where: string): Box {
  const found = firstBox(boxes, type);
  if (!found)
    throw new BoxError(
      `${where}: missing '${type}' box (found: ${boxes.map((b) => b.type).join(', ') || 'none'})`,
    );
  return found;
}

/** Bounds-checked sequential reader over a byte range. */
class Reader {
  pos: number;
  constructor(
    readonly buf: Buffer,
    start: number,
    readonly end: number,
    private readonly what: string,
  ) {
    this.pos = start;
  }
  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new BoxError(
        `${this.what}: truncated (needs ${n} bytes at ${this.pos}, ${this.end - this.pos} left)`,
      );
    }
  }
  get left(): number {
    return this.end - this.pos;
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    if (v > MAX_SAFE) throw new BoxError(`${this.what}: 64-bit value ${v} exceeds 2^53`);
    return Number(v);
  }
  u24(): number {
    this.need(3);
    const v = this.buf.readUIntBE(this.pos, 3);
    this.pos += 3;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  fourcc(): string {
    return this.bytes(4).toString('latin1');
  }
}

function payloadReader(buf: Buffer, box: Box, what = `'${box.type}' box at ${box.start}`): Reader {
  return new Reader(buf, payloadStart(box), boxEnd(box), what);
}

function fullBoxHeader(r: Reader): { version: number; flags: number } {
  const version = r.u8();
  const flags = r.u24();
  return { version, flags };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Initialization segment
// ------------------------------------------------------------------------------------------------------------------------------

export interface Brands {
  major: string;
  minor: number;
  compatible: string[];
}

function parseBrands(buf: Buffer, box: Box): Brands {
  const r = payloadReader(buf, box);
  const major = r.fourcc();
  const minor = r.u32();
  if (r.left % 4 !== 0)
    throw new BoxError(`'${box.type}' at ${box.start}: compatible brands are not a multiple of 4 bytes`);
  const compatible: string[] = [];
  while (r.left > 0) compatible.push(r.fourcc());
  return { major, minor, compatible };
}

export interface VpcC {
  profile: number;
  level: number;
  bitDepth: number;
  chromaSubsampling: number;
  fullRange: boolean;
}

export interface EsdsInfo {
  /** DecoderConfigDescriptor.objectTypeIndication, 0x40 for MPEG-4 audio. */
  objectTypeIndication: number;
  /** AudioSpecificConfig.audioObjectType (2 = AAC-LC). */
  audioObjectType: number;
  samplingFrequencyIndex: number;
  channelConfiguration: number;
  avgBitrate: number;
  maxBitrate: number;
}

export interface VisualEntry {
  kind: 'video';
  format: string;
  width: number;
  height: number;
  vpcC?: VpcC;
}

export interface AudioEntry {
  kind: 'audio';
  format: string;
  channelCount: number;
  sampleRate: number;
  esds?: EsdsInfo;
}

export interface TrexDefaults {
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
}

export interface InitTrack {
  trackId: number;
  /** 'vide' | 'soun' | ... */
  handler: string;
  /** mdhd timescale: the ticks per second of this track's decode times and durations. */
  timescale: number;
  mdhdDuration: number;
  /** An edit list moves the presentation timeline away from the media timeline; the lab's streams must not have one. */
  hasEditList: boolean;
  entry: VisualEntry | AudioEntry;
  /** RFC 6381 codec string derived from the sample entry configuration (vpcC, esds), never from a constant. */
  codec: string;
  trex?: TrexDefaults;
}

export interface ParsedInit {
  brands?: Brands;
  movieTimescale: number;
  tracks: InitTrack[];
  topLevelTypes: string[];
  hasMvex: boolean;
}

export function vp9CodecString(profile: number, level: number, bitDepth: number): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `vp09.${two(profile)}.${two(level)}.${two(bitDepth)}`;
}

function parseVpcC(buf: Buffer, box: Box): VpcC {
  const r = payloadReader(buf, box);
  const { version } = fullBoxHeader(r);
  if (version !== 1) throw new BoxError(`vpcC at ${box.start}: unsupported version ${version}`);
  const profile = r.u8();
  const level = r.u8();
  const packed = r.u8();
  return {
    profile,
    level,
    bitDepth: packed >> 4,
    chromaSubsampling: (packed >> 1) & 0x7,
    fullRange: (packed & 1) === 1,
  };
}

/** MPEG-4 descriptor length: 1 to 4 bytes, 7 bits each, high bit = "more follows". */
function descriptorLength(r: Reader): number {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = r.u8();
    len = (len << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return len;
  }
  throw new BoxError('esds: descriptor length longer than 4 bytes');
}

function parseEsds(buf: Buffer, box: Box): EsdsInfo {
  const r = payloadReader(buf, box);
  fullBoxHeader(r);
  const esTag = r.u8();
  if (esTag !== 0x03)
    throw new BoxError(`esds at ${box.start}: expected ES_Descriptor (0x03), found 0x${esTag.toString(16)}`);
  descriptorLength(r);
  r.skip(2); // ES_ID
  const esFlags = r.u8();
  if (esFlags & 0x80) r.skip(2); // dependsOn_ES_ID
  if (esFlags & 0x40) r.skip(r.u8()); // URL
  if (esFlags & 0x20) r.skip(2); // OCR_ES_ID
  const dcTag = r.u8();
  if (dcTag !== 0x04)
    throw new BoxError(
      `esds at ${box.start}: expected DecoderConfigDescriptor (0x04), found 0x${dcTag.toString(16)}`,
    );
  descriptorLength(r);
  const objectTypeIndication = r.u8();
  r.skip(1 + 3); // streamType + bufferSizeDB
  const maxBitrate = r.u32();
  const avgBitrate = r.u32();
  const dsiTag = r.u8();
  if (dsiTag !== 0x05)
    throw new BoxError(
      `esds at ${box.start}: expected DecoderSpecificInfo (0x05), found 0x${dsiTag.toString(16)}`,
    );
  const dsiLength = descriptorLength(r);
  const asc = r.bytes(dsiLength);
  if (asc.length < 2) throw new BoxError(`esds at ${box.start}: AudioSpecificConfig is ${asc.length} bytes`);
  // AudioSpecificConfig: audioObjectType (5 bits, 31 = escape + 6 more), samplingFrequencyIndex (4), channelConfiguration (4).
  let bit = 0;
  const bits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      const byte = asc[bit >> 3];
      if (byte === undefined) throw new BoxError(`esds at ${box.start}: AudioSpecificConfig is too short`);
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    return v;
  };
  let audioObjectType = bits(5);
  if (audioObjectType === 31) audioObjectType = 32 + bits(6);
  const samplingFrequencyIndex = bits(4);
  if (samplingFrequencyIndex === 15) bits(24);
  const channelConfiguration = bits(4);
  return {
    objectTypeIndication,
    audioObjectType,
    samplingFrequencyIndex,
    channelConfiguration,
    avgBitrate,
    maxBitrate,
  };
}

function parseSampleEntry(
  buf: Buffer,
  entry: Box,
  handler: string,
): { entry: VisualEntry | AudioEntry; codec: string } {
  const r = payloadReader(buf, entry);
  r.skip(6 + 2); // reserved + data_reference_index
  if (handler === 'vide') {
    r.skip(2 + 2 + 12); // pre_defined, reserved, pre_defined[3]
    const width = r.u16();
    const height = r.u16();
    r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2); // resolutions, reserved, frame_count, compressorname, depth, pre_defined
    const kids = readBoxes(buf, r.pos, boxEnd(entry));
    const vpccBox = firstBox(kids, 'vpcC');
    const out: VisualEntry = { kind: 'video', format: entry.type, width, height };
    let codec = entry.type;
    if (vpccBox) {
      out.vpcC = parseVpcC(buf, vpccBox);
      codec = vp9CodecString(out.vpcC.profile, out.vpcC.level, out.vpcC.bitDepth);
    }
    return { entry: out, codec };
  }
  if (handler === 'soun') {
    const version = r.u16();
    if (version !== 0)
      throw new BoxError(
        `audio sample entry '${entry.type}' at ${entry.start}: unsupported version ${version}`,
      );
    r.skip(2 + 4); // revision, vendor
    const channelCount = r.u16();
    r.skip(2 + 2 + 2); // samplesize, pre_defined, reserved
    const sampleRate = r.u32() / 65536;
    const kids = readBoxes(buf, r.pos, boxEnd(entry));
    const esdsBox = firstBox(kids, 'esds');
    const out: AudioEntry = { kind: 'audio', format: entry.type, channelCount, sampleRate };
    let codec = entry.type;
    if (esdsBox) {
      out.esds = parseEsds(buf, esdsBox);
      codec = `mp4a.${out.esds.objectTypeIndication.toString(16)}.${out.esds.audioObjectType}`;
    }
    return { entry: out, codec };
  }
  throw new BoxError(`unsupported track handler '${handler}'`);
}

function parseTrak(buf: Buffer, trak: Box): Omit<InitTrack, 'trex'> {
  const where = `trak at ${trak.start}`;
  const kids = childBoxes(buf, trak);
  const tkhd = requireBox(kids, 'tkhd', where);
  const tr = payloadReader(buf, tkhd);
  const { version: tkVersion } = fullBoxHeader(tr);
  tr.skip(tkVersion === 1 ? 16 : 8);
  const trackId = tr.u32();
  const mdia = requireBox(kids, 'mdia', where);
  const mdiaKids = childBoxes(buf, mdia);
  const mdhd = requireBox(mdiaKids, 'mdhd', `mdia at ${mdia.start}`);
  const mr = payloadReader(buf, mdhd);
  const { version: mdVersion } = fullBoxHeader(mr);
  mr.skip(mdVersion === 1 ? 16 : 8);
  const timescale = mr.u32();
  const mdhdDuration = mdVersion === 1 ? mr.u64() : mr.u32();
  if (timescale === 0) throw new BoxError(`mdhd at ${mdhd.start}: timescale is 0`);
  const hdlr = requireBox(mdiaKids, 'hdlr', `mdia at ${mdia.start}`);
  const hr = payloadReader(buf, hdlr);
  fullBoxHeader(hr);
  hr.skip(4);
  const handler = hr.fourcc();
  const minf = requireBox(mdiaKids, 'minf', `mdia at ${mdia.start}`);
  const stbl = requireBox(childBoxes(buf, minf), 'stbl', `minf at ${minf.start}`);
  const stsd = requireBox(childBoxes(buf, stbl), 'stsd', `stbl at ${stbl.start}`);
  const sr = payloadReader(buf, stsd);
  fullBoxHeader(sr);
  const entryCount = sr.u32();
  const entries = readBoxes(buf, sr.pos, boxEnd(stsd));
  if (entryCount !== 1 || entries.length !== 1) {
    throw new BoxError(
      `stsd at ${stsd.start}: expected exactly one sample entry, found ${entries.length} (count says ${entryCount})`,
    );
  }
  const first = entries[0] as Box;
  const parsed = parseSampleEntry(buf, first, handler);
  return {
    trackId,
    handler,
    timescale,
    mdhdDuration,
    hasEditList: firstBox(kids, 'edts') !== undefined,
    entry: parsed.entry,
    codec: parsed.codec,
  };
}

export function parseInit(init: Buffer): ParsedInit {
  const top = readBoxes(init);
  const ftyp = firstBox(top, 'ftyp');
  const moov = requireBox(top, 'moov', 'initialization segment');
  if (top.some((b) => b.type === 'moof' || b.type === 'mdat')) {
    throw new BoxError('initialization segment contains media (moof/mdat)');
  }
  const moovKids = childBoxes(init, moov);
  const mvhd = requireBox(moovKids, 'mvhd', 'moov');
  const mr = payloadReader(init, mvhd);
  const { version } = fullBoxHeader(mr);
  mr.skip(version === 1 ? 16 : 8);
  const movieTimescale = mr.u32();
  const mvex = firstBox(moovKids, 'mvex');
  const trexByTrack = new Map<number, TrexDefaults>();
  if (mvex) {
    for (const trex of childBoxes(init, mvex).filter((b) => b.type === 'trex')) {
      const r = payloadReader(init, trex);
      fullBoxHeader(r);
      const trackId = r.u32();
      trexByTrack.set(trackId, {
        defaultSampleDescriptionIndex: r.u32(),
        defaultSampleDuration: r.u32(),
        defaultSampleSize: r.u32(),
        defaultSampleFlags: r.u32(),
      });
    }
  }
  const tracks = moovKids
    .filter((b) => b.type === 'trak')
    .map((trak): InitTrack => {
      const base = parseTrak(init, trak);
      const trex = trexByTrack.get(base.trackId);
      return trex ? { ...base, trex } : base;
    });
  if (tracks.length === 0) throw new BoxError('initialization segment has no trak');
  const out: ParsedInit = {
    movieTimescale,
    tracks,
    topLevelTypes: top.map((b) => b.type),
    hasMvex: mvex !== undefined,
  };
  if (ftyp) out.brands = parseBrands(init, ftyp);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Media segments
// ------------------------------------------------------------------------------------------------------------------------------

export interface ParsedSample {
  duration: number;
  size: number;
  flags: number;
  /** composition time offset (pts - dts), in ticks. */
  ctsOffset: number;
  /** A sync sample (random access point): the "non-sync" bit (0x10000) of the sample flags is clear. */
  sync: boolean;
  /** Offset of the sample's bytes in the segment buffer. */
  offset: number;
}

export interface ParsedTrackFragment {
  trackId: number;
  /** tfdt baseMediaDecodeTime. */
  baseMediaDecodeTime: number;
  tfdtVersion: 0 | 1;
  defaultBaseIsMoof: boolean;
  samples: ParsedSample[];
  /** Sum of the sample durations: the real duration of this fragment of this track. */
  duration: number;
  /** Sum of the sample sizes. */
  dataSize: number;
}

export interface ParsedFragment {
  moof: Box;
  sequenceNumber: number;
  trafs: ParsedTrackFragment[];
}

export interface ParsedMediaSegment {
  boxes: Box[];
  brands?: Brands;
  fragments: ParsedFragment[];
  mdats: Box[];
}

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_DURATION = 0x000008;
const TFHD_DEFAULT_SIZE = 0x000010;
const TFHD_DEFAULT_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;
const NON_SYNC_SAMPLE = 0x10000;

interface Tfhd {
  trackId: number;
  flags: number;
  baseDataOffset?: number;
  defaultDuration?: number;
  defaultSize?: number;
  defaultFlags?: number;
}

function parseTfhd(buf: Buffer, box: Box): Tfhd {
  const r = payloadReader(buf, box);
  const { flags } = fullBoxHeader(r);
  const out: Tfhd = { trackId: r.u32(), flags };
  if (flags & TFHD_BASE_DATA_OFFSET) out.baseDataOffset = r.u64();
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) r.skip(4);
  if (flags & TFHD_DEFAULT_DURATION) out.defaultDuration = r.u32();
  if (flags & TFHD_DEFAULT_SIZE) out.defaultSize = r.u32();
  if (flags & TFHD_DEFAULT_FLAGS) out.defaultFlags = r.u32();
  return out;
}

function parseTraf(
  buf: Buffer,
  traf: Box,
  moof: Box,
  trexFor: (trackId: number) => TrexDefaults | undefined,
): ParsedTrackFragment {
  const where = `traf at ${traf.start}`;
  const kids = childBoxes(buf, traf);
  const tfhd = parseTfhd(buf, requireBox(kids, 'tfhd', where));
  const tfdts = kids.filter((b) => b.type === 'tfdt');
  if (tfdts.length !== 1) throw new BoxError(`${where}: expected one tfdt, found ${tfdts.length}`);
  const tfdtBox = tfdts[0] as Box;
  const tr = payloadReader(buf, tfdtBox);
  const { version } = fullBoxHeader(tr);
  if (version !== 0 && version !== 1)
    throw new BoxError(`tfdt at ${tfdtBox.start}: unsupported version ${version}`);
  const baseMediaDecodeTime = version === 1 ? tr.u64() : tr.u32();

  const trex = trexFor(tfhd.trackId);
  const baseOffset = tfhd.baseDataOffset ?? moof.start;
  const samples: ParsedSample[] = [];
  let cursor = baseOffset;
  let firstTrun = true;
  for (const trun of kids.filter((b) => b.type === 'trun')) {
    const r = payloadReader(buf, trun);
    const { version: trunVersion, flags } = fullBoxHeader(r);
    const count = r.u32();
    if (flags & TRUN_DATA_OFFSET) cursor = baseOffset + r.i32();
    else if (firstTrun) cursor = baseOffset;
    const firstSampleFlags = flags & TRUN_FIRST_SAMPLE_FLAGS ? r.u32() : undefined;
    for (let i = 0; i < count; i++) {
      const duration =
        flags & TRUN_SAMPLE_DURATION ? r.u32() : (tfhd.defaultDuration ?? trex?.defaultSampleDuration);
      const size = flags & TRUN_SAMPLE_SIZE ? r.u32() : (tfhd.defaultSize ?? trex?.defaultSampleSize);
      const sampleFlags =
        flags & TRUN_SAMPLE_FLAGS
          ? r.u32()
          : i === 0 && firstSampleFlags !== undefined
            ? firstSampleFlags
            : (tfhd.defaultFlags ?? trex?.defaultSampleFlags);
      const ctsOffset = flags & TRUN_SAMPLE_CTS ? (trunVersion === 0 ? r.u32() : r.i32()) : 0;
      if (duration === undefined || size === undefined || sampleFlags === undefined) {
        throw new BoxError(
          `${where}: sample ${samples.length} has no duration/size/flags in trun, tfhd or trex`,
        );
      }
      samples.push({
        duration,
        size,
        flags: sampleFlags,
        ctsOffset,
        sync: (sampleFlags & NON_SYNC_SAMPLE) === 0,
        offset: cursor,
      });
      cursor += size;
    }
    firstTrun = false;
  }
  return {
    trackId: tfhd.trackId,
    baseMediaDecodeTime,
    tfdtVersion: version,
    defaultBaseIsMoof: (tfhd.flags & TFHD_DEFAULT_BASE_IS_MOOF) !== 0,
    samples,
    duration: samples.reduce((sum, s) => sum + s.duration, 0),
    dataSize: samples.reduce((sum, s) => sum + s.size, 0),
  };
}

/** Parses the moof/mdat boxes of a media segment (a whole file works too: it lists every fragment). `init` supplies the trex defaults. */
export function parseMediaSegment(segment: Buffer, init?: ParsedInit): ParsedMediaSegment {
  const boxes = readBoxes(segment);
  const trexFor = (trackId: number): TrexDefaults | undefined =>
    init?.tracks.find((t) => t.trackId === trackId)?.trex;
  const fragments: ParsedFragment[] = [];
  for (const moof of boxes.filter((b) => b.type === 'moof')) {
    const kids = childBoxes(segment, moof);
    const mfhd = requireBox(kids, 'mfhd', `moof at ${moof.start}`);
    const mr = payloadReader(segment, mfhd);
    fullBoxHeader(mr);
    const sequenceNumber = mr.u32();
    const trafs = kids
      .filter((b) => b.type === 'traf')
      .map((traf) => parseTraf(segment, traf, moof, trexFor));
    fragments.push({ moof, sequenceNumber, trafs });
  }
  const styp = firstBox(boxes, 'styp');
  const out: ParsedMediaSegment = { boxes, fragments, mdats: boxes.filter((b) => b.type === 'mdat') };
  if (styp) out.brands = parseBrands(segment, styp);
  return out;
}

/** The decode time of every traf of every fragment, in file order. */
export function readTfdts(segment: Buffer): number[] {
  return parseMediaSegment(segment).fragments.flatMap((f) => f.trafs.map((t) => t.baseMediaDecodeTime));
}

// ------------------------------------------------------------------------------------------------------------------------------
// The live loop's only mutation
// ------------------------------------------------------------------------------------------------------------------------------

/**
 * Moves the baseMediaDecodeTime of every traf by `deltaTicks` and returns a new buffer that is byte-identical everywhere else
 * (it is a copy with the 4 or 8 bytes of each tfdt patched in place, never a re-serialization). All trafs move by the same delta,
 * so it is meant for segments that carry one track (the lab's CMAF segments). tfdt version 1 holds 64 bits; version 0 holds 32 and
 * throws when the result does not fit instead of wrapping around.
 */
export function rewriteTfdt(segment: Buffer, deltaTicks: number): Buffer {
  if (!Number.isSafeInteger(deltaTicks))
    throw new RangeError(`rewriteTfdt: deltaTicks must be a safe integer, got ${deltaTicks}`);
  const out = Buffer.from(segment);
  let patched = 0;
  for (const top of readBoxes(out)) {
    if (top.type !== 'moof') continue;
    for (const traf of childBoxes(out, top).filter((b) => b.type === 'traf')) {
      const tfdts = childBoxes(out, traf).filter((b) => b.type === 'tfdt');
      if (tfdts.length !== 1) {
        throw new BoxError(
          `traf at ${traf.start} has ${tfdts.length} tfdt boxes: cannot move its decode time`,
        );
      }
      patchTfdt(out, tfdts[0] as Box, deltaTicks);
      patched++;
    }
  }
  if (patched === 0) throw new BoxError('rewriteTfdt: the segment has no moof/traf/tfdt to move');
  return out;
}

function patchTfdt(buf: Buffer, tfdt: Box, delta: number): void {
  const at = payloadStart(tfdt);
  const version = buf.readUInt8(at);
  const field = at + 4;
  if (version === 1) {
    if (tfdt.size - tfdt.headerSize < 12)
      throw new BoxError(`tfdt at ${tfdt.start} is too short for version 1`);
    const next = buf.readBigUInt64BE(field) + BigInt(delta);
    if (next < 0n || next > MAX_U64) {
      throw new RangeError(`rewriteTfdt: baseMediaDecodeTime would become ${next} (outside 0..2^64-1)`);
    }
    buf.writeBigUInt64BE(next, field);
  } else if (version === 0) {
    if (tfdt.size - tfdt.headerSize < 8)
      throw new BoxError(`tfdt at ${tfdt.start} is too short for version 0`);
    const next = buf.readUInt32BE(field) + delta;
    if (next < 0 || next > MAX_U32) {
      throw new RangeError(
        `rewriteTfdt: baseMediaDecodeTime ${next} does not fit tfdt version 0 (32 bits); the segment needs a version 1 tfdt`,
      );
    }
    buf.writeUInt32BE(next, field);
  } else {
    throw new BoxError(`tfdt at ${tfdt.start}: unsupported version ${version}`);
  }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Writer
// ------------------------------------------------------------------------------------------------------------------------------

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

/** A plain box: 32-bit size, fourcc, payload. */
export function box(type: string, ...payload: Buffer[]): Buffer {
  if (type.length !== 4) throw new RangeError(`box type must be four characters, got '${type}'`);
  const body = Buffer.concat(payload);
  const size = 8 + body.length;
  if (size > MAX_U32)
    throw new RangeError(`box '${type}' is ${size} bytes: the writer does not emit 64-bit sizes`);
  return Buffer.concat([u32(size), Buffer.from(type, 'latin1'), body]);
}

export function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xff_ffff)), ...payload);
}

/** Segment type box of a DASH/CMAF media segment: brands `msdh`. */
export function buildStyp(): Buffer {
  return box('styp', Buffer.from('msdh', 'latin1'), u32(0), Buffer.from('msdh', 'latin1'));
}

export interface WriteSample {
  data: Buffer;
  /** Duration in ticks of the track's timescale. */
  duration: number;
  /** Sync sample (a video keyframe; every audio frame). */
  sync: boolean;
}

export interface MediaSegmentSpec {
  trackId: number;
  sequenceNumber: number;
  baseMediaDecodeTime: number;
  samples: WriteSample[];
  /** Write the leading styp box (default true). */
  styp?: boolean;
}

// sample_depends_on = 2 (an I-frame, does not depend on others) / depends_on = 1 + non-sync flag.
const SYNC_SAMPLE_FLAGS = 0x0200_0000;
const NON_SYNC_SAMPLE_FLAGS = 0x0101_0000;

/**
 * One CMAF-style fragment: [styp] moof(mfhd, traf(tfhd, tfdt v1, trun)) mdat. Every sample carries its own duration, size and flags
 * in the trun, so a reader never depends on defaults that live in the init segment. No sidx: it would need its own rewrite per loop.
 */
export function buildMediaSegment(spec: MediaSegmentSpec): Buffer {
  const { samples } = spec;
  if (samples.length === 0) throw new RangeError('buildMediaSegment: a segment needs at least one sample');
  if (!Number.isSafeInteger(spec.baseMediaDecodeTime) || spec.baseMediaDecodeTime < 0) {
    throw new RangeError(`buildMediaSegment: invalid baseMediaDecodeTime ${spec.baseMediaDecodeTime}`);
  }
  const mfhd = fullBox('mfhd', 0, 0, u32(spec.sequenceNumber));
  const tfhd = fullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(spec.trackId));
  const tfdtValue = Buffer.alloc(8);
  tfdtValue.writeBigUInt64BE(BigInt(spec.baseMediaDecodeTime));
  const tfdt = fullBox('tfdt', 1, 0, tfdtValue);

  const trunHeaderSize = 8 + 4 + 4 + 4; // box header, version/flags, sample_count, data_offset
  const trunSize = trunHeaderSize + samples.length * 12;
  const trafSize = 8 + tfhd.length + tfdt.length + trunSize;
  const moofSize = 8 + mfhd.length + trafSize;
  const dataOffset = moofSize + 8; // first sample byte, relative to the moof start (default-base-is-moof)

  const trunBody = Buffer.alloc(8 + samples.length * 12);
  trunBody.writeUInt32BE(samples.length, 0);
  trunBody.writeInt32BE(dataOffset, 4);
  let p = 8;
  let dataSize = 0;
  for (const s of samples) {
    trunBody.writeUInt32BE(s.duration, p);
    trunBody.writeUInt32BE(s.data.length, p + 4);
    trunBody.writeUInt32BE(s.sync ? SYNC_SAMPLE_FLAGS : NON_SYNC_SAMPLE_FLAGS, p + 8);
    p += 12;
    dataSize += s.data.length;
  }
  const trun = fullBox(
    'trun',
    0,
    TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS,
    trunBody,
  );
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);
  if (moof.length !== moofSize)
    throw new Error(`buildMediaSegment: moof is ${moof.length} bytes, expected ${moofSize}`);
  const mdat = box('mdat', ...samples.map((s) => s.data));
  if (mdat.length - 8 !== dataSize) throw new Error('buildMediaSegment: mdat size mismatch');
  return Buffer.concat([...(spec.styp === false ? [] : [buildStyp()]), moof, mdat]);
}

/**
 * Returns `init` without the boxes at the given paths (for example ['moov', 'udta'] or ['moov', 'trak', 'edts']), with the sizes of
 * the containers on the way fixed. Only boxes without offsets into other boxes may be removed (the lab removes metadata and edit lists
 * from an empty-moov init segment, where no sample table has any entry).
 */
export function removeBoxes(init: Buffer, paths: string[][]): Buffer {
  const rebuild = (buf: Buffer, start: number, end: number, prefix: string[]): Buffer => {
    const parts: Buffer[] = [];
    for (const b of readBoxes(buf, start, end)) {
      const path = [...prefix, b.type];
      if (paths.some((p) => p.length === path.length && p.every((t, i) => t === path[i]))) continue;
      if (
        paths.some((p) => p.length > path.length && p.slice(0, path.length).every((t, i) => t === path[i]))
      ) {
        parts.push(box(b.type, rebuild(buf, payloadStart(b), boxEnd(b), path)));
      } else {
        parts.push(buf.subarray(b.start, boxEnd(b)));
      }
    }
    return Buffer.concat(parts);
  };
  return rebuild(init, 0, init.length, []);
}
