// Codec facts read from the media itself: the VP9 uncompressed header of a key frame (profile, bit depth, size) and the VP9 level
// table. Codec strings in manifests come from here and from vpcC / esds, never from constants (docs/decisions/media.md, ADR-043).

export interface Vp9FrameInfo {
  profile: number;
  bitDepth: number;
  showExistingFrame: boolean;
  keyFrame: boolean;
  showFrame: boolean;
  /** Present for key frames. */
  width?: number;
  height?: number;
  subsamplingX?: number;
  subsamplingY?: number;
}

class Bits {
  private bit = 0;
  constructor(private readonly buf: Buffer) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.bit++) {
      const byte = this.buf[this.bit >> 3];
      if (byte === undefined) throw new RangeError('VP9 frame header is truncated');
      v = v * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
    }
    return v;
  }
}

/** The first frame of a packet. A VP9 packet may be a superframe (hidden frames then a shown one, with an index at the end). */
function firstFrame(packet: Buffer): Buffer {
  const marker = packet[packet.length - 1];
  if (marker === undefined || (marker & 0xe0) !== 0xc0) return packet;
  const frames = (marker & 0x7) + 1;
  const magnitude = ((marker >> 3) & 0x3) + 1;
  const indexSize = 2 + magnitude * frames;
  if (packet.length < indexSize || packet[packet.length - indexSize] !== marker) return packet;
  const size = packet.readUIntLE(packet.length - indexSize + 1, magnitude);
  return packet.subarray(0, size);
}

/** Parses the uncompressed header of the first frame of a VP9 packet (VP9 bitstream specification, section 6.2). */
export function parseVp9Frame(packet: Buffer): Vp9FrameInfo {
  const r = new Bits(firstFrame(packet));
  if (r.read(2) !== 2) throw new RangeError('not a VP9 frame: frame_marker is not 2');
  const profileLow = r.read(1);
  const profileHigh = r.read(1);
  const profile = (profileHigh << 1) + profileLow;
  if (profile === 3) r.read(1);
  const showExistingFrame = r.read(1) === 1;
  if (showExistingFrame) {
    return { profile, bitDepth: 8, showExistingFrame, keyFrame: false, showFrame: true };
  }
  const keyFrame = r.read(1) === 0;
  const showFrame = r.read(1) === 1;
  r.read(1); // error_resilient_mode
  const info: Vp9FrameInfo = { profile, bitDepth: 8, showExistingFrame, keyFrame, showFrame };
  if (!keyFrame) return info;
  if (r.read(8) !== 0x49 || r.read(8) !== 0x83 || r.read(8) !== 0x42)
    throw new RangeError('VP9 key frame has a wrong sync code');
  info.bitDepth = profile >= 2 ? (r.read(1) === 1 ? 12 : 10) : 8;
  const colorSpace = r.read(3);
  if (colorSpace !== 7) {
    r.read(1); // color_range
    if (profile === 1 || profile === 3) {
      info.subsamplingX = r.read(1);
      info.subsamplingY = r.read(1);
      r.read(1);
    } else {
      info.subsamplingX = 1;
      info.subsamplingY = 1;
    }
  } else {
    info.subsamplingX = 0;
    info.subsamplingY = 0;
    if (profile === 1 || profile === 3) r.read(1);
  }
  info.width = r.read(16) + 1;
  info.height = r.read(16) + 1;
  return info;
}

// VP9 levels (WebM project / VP9 codec string specification): maximum luma sample rate (samples per second) and luma picture size.
const VP9_LEVELS: ReadonlyArray<{ level: number; maxLumaSampleRate: number; maxLumaPictureSize: number }> = [
  { level: 10, maxLumaSampleRate: 829_440, maxLumaPictureSize: 36_864 },
  { level: 11, maxLumaSampleRate: 2_764_800, maxLumaPictureSize: 73_728 },
  { level: 20, maxLumaSampleRate: 4_608_000, maxLumaPictureSize: 122_880 },
  { level: 21, maxLumaSampleRate: 9_216_000, maxLumaPictureSize: 245_760 },
  { level: 30, maxLumaSampleRate: 20_736_000, maxLumaPictureSize: 552_960 },
  { level: 31, maxLumaSampleRate: 36_864_000, maxLumaPictureSize: 983_040 },
  { level: 40, maxLumaSampleRate: 83_558_400, maxLumaPictureSize: 2_228_224 },
  { level: 41, maxLumaSampleRate: 160_432_128, maxLumaPictureSize: 2_228_224 },
  { level: 50, maxLumaSampleRate: 311_951_360, maxLumaPictureSize: 8_912_896 },
  { level: 51, maxLumaSampleRate: 588_251_136, maxLumaPictureSize: 8_912_896 },
  { level: 52, maxLumaSampleRate: 1_176_502_272, maxLumaPictureSize: 8_912_896 },
  { level: 60, maxLumaSampleRate: 1_176_502_272, maxLumaPictureSize: 35_651_584 },
  { level: 61, maxLumaSampleRate: 2_353_004_544, maxLumaPictureSize: 35_651_584 },
  { level: 62, maxLumaSampleRate: 4_706_009_088, maxLumaPictureSize: 35_651_584 },
];

/** The lowest VP9 level (as the two-digit code of the codec string, 31 = level 3.1) that holds this picture size and frame rate. */
export function vp9LevelFor(width: number, height: number, frameRate: number): number {
  const size = width * height;
  const rate = size * frameRate;
  const level = VP9_LEVELS.find((l) => size <= l.maxLumaPictureSize && rate <= l.maxLumaSampleRate);
  if (!level) throw new RangeError(`no VP9 level holds ${width}x${height} at ${frameRate} fps`);
  return level.level;
}
