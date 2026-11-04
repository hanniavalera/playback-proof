import { describe, expect, it } from 'vitest';
import {
  BoxError,
  box,
  buildMediaSegment,
  buildStyp,
  childBoxes,
  fullBox,
  parseMediaSegment,
  payloadStart,
  readBoxes,
  removeBoxes,
  type Box,
  type ParsedInit,
} from '../../../src/server/media/isobmff.ts';
import { protectedAudioInit } from './support/support.ts';

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

describe('readBoxes', () => {
  it('reads boxes laid end to end and their children', () => {
    const buf = Buffer.concat([
      box('ftyp', Buffer.from('isom'), u32(0)),
      box('moov', box('mvhd', Buffer.alloc(4)), box('free')),
    ]);
    const top = readBoxes(buf);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov']);
    expect(childBoxes(buf, top[1] as never).map((b) => b.type)).toEqual(['mvhd', 'free']);
  });

  it('handles a 64-bit size', () => {
    const payload = Buffer.from('abcd');
    const wide = Buffer.concat([u32(1), Buffer.from('wide'), u64(16 + payload.length), payload]);
    const [b] = readBoxes(Buffer.concat([wide, box('free')]));
    expect(b).toMatchObject({ type: 'wide', headerSize: 16, size: 20 });
  });

  it('lets size 0 run to the end of the container', () => {
    const buf = Buffer.concat([box('free'), u32(0), Buffer.from('mdat'), Buffer.from('12345678')]);
    const boxes = readBoxes(buf);
    expect(boxes).toHaveLength(2);
    expect(boxes[1]).toMatchObject({ type: 'mdat', size: 16 });
  });

  it.each([
    ['a truncated header', Buffer.from([0, 0, 0])],
    ['a size below the header size', Buffer.concat([u32(4), Buffer.from('free')])],
    ['a size past its container', Buffer.concat([u32(100), Buffer.from('free'), Buffer.alloc(8)])],
    ['a truncated 64-bit size', Buffer.concat([u32(1), Buffer.from('free'), Buffer.alloc(4)])],
    ['trailing bytes that are not a box', Buffer.concat([box('free'), Buffer.from([1, 2, 3])])],
  ])('rejects %s', (_name, buf) => {
    expect(() => readBoxes(buf)).toThrow(BoxError);
  });

  it('rejects an invalid range', () => {
    expect(() => readBoxes(Buffer.alloc(8), 4, 2)).toThrow(RangeError);
    expect(() => readBoxes(Buffer.alloc(8), 0, 9)).toThrow(RangeError);
  });
});

describe('buildMediaSegment and parseMediaSegment', () => {
  const samples = [
    { data: Buffer.from('keyframe-bytes'), duration: 512, sync: true },
    { data: Buffer.from('delta-1'), duration: 512, sync: false },
    { data: Buffer.from('delta-22'), duration: 512, sync: false },
  ];

  it('writes [styp] moof mdat, one tfdt of version 1, and reads back what it wrote', () => {
    const seg = buildMediaSegment({
      trackId: 7,
      sequenceNumber: 12,
      baseMediaDecodeTime: 2 ** 40 + 5,
      samples,
    });
    const parsed = parseMediaSegment(seg);
    expect(parsed.boxes.map((b) => b.type)).toEqual(['styp', 'moof', 'mdat']);
    expect(parsed.brands).toEqual({ major: 'msdh', minor: 0, compatible: ['msdh'] });
    const f = parsed.fragments[0];
    expect(f?.sequenceNumber).toBe(12);
    const traf = f?.trafs[0];
    expect(traf).toMatchObject({
      trackId: 7,
      baseMediaDecodeTime: 2 ** 40 + 5,
      tfdtVersion: 1,
      defaultBaseIsMoof: true,
      duration: 1536,
    });
    expect(traf?.samples.map((s) => s.sync)).toEqual([true, false, false]);
    expect(traf?.samples.map((s) => s.size)).toEqual(samples.map((s) => s.data.length));
    // every sample's recorded offset really points at its bytes
    traf?.samples.forEach((s, i) =>
      expect(seg.subarray(s.offset, s.offset + s.size).equals((samples[i] as { data: Buffer }).data)).toBe(
        true,
      ),
    );
  });

  it('does not write a sidx: media segments are rewritten per loop and an index would need its own rewrite', () => {
    const seg = buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples });
    expect(readBoxes(seg).some((b) => b.type === 'sidx')).toBe(false);
  });

  it('can omit the styp', () => {
    const seg = buildMediaSegment({
      trackId: 1,
      sequenceNumber: 1,
      baseMediaDecodeTime: 0,
      samples,
      styp: false,
    });
    expect(readBoxes(seg).map((b) => b.type)).toEqual(['moof', 'mdat']);
    expect(buildStyp().length).toBe(20);
  });

  it('rejects an empty segment and a decode time that is not a non-negative safe integer', () => {
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples: [] }),
    ).toThrow(RangeError);
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: -1, samples }),
    ).toThrow(RangeError);
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 2 ** 53, samples }),
    ).toThrow(RangeError);
  });
});

describe('Common Encryption boxes: senc, saiz and saio of a protected track', () => {
  const iv = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  const samples = [10, 11, 12].map((n) => ({
    data: Buffer.from(`sample-${n}`),
    duration: 1024,
    sync: true,
    iv: iv(n),
  }));
  const init = protectedAudioInit();
  const build = (): Buffer =>
    buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples });

  /** The boxes inside the traf of a segment. */
  const trafBoxes = (seg: Buffer): Box[] => {
    const moof = readBoxes(seg).find((b) => b.type === 'moof') as Box;
    const traf = childBoxes(seg, moof).find((b) => b.type === 'traf') as Box;
    return childBoxes(seg, traf);
  };
  const find = (seg: Buffer, type: string): Box => trafBoxes(seg).find((b) => b.type === type) as Box;

  it('writes senc, saio and saiz after the trun and reads the IVs back in sample order', () => {
    const seg = build();
    expect(trafBoxes(seg).map((b) => b.type)).toEqual(['tfhd', 'tfdt', 'trun', 'senc', 'saio', 'saiz']);
    const traf = parseMediaSegment(seg, init).fragments[0]?.trafs[0];
    expect(traf?.encryption?.ivs.map((v) => Number(v.readBigUInt64BE()))).toEqual([10, 11, 12]);
    // the trun data offset still points at the first sample once the three extra boxes are in the moof
    const at = traf?.samples[0]?.offset ?? 0;
    expect(seg.subarray(at, at + 9).toString()).toBe('sample-10');
  });

  it('writes nothing of the sort for a track without IVs', () => {
    const clear = buildMediaSegment({
      trackId: 1,
      sequenceNumber: 1,
      baseMediaDecodeTime: 0,
      samples: samples.map(({ iv: _iv, ...s }) => s),
    });
    expect(readBoxes(clear).some((b) => ['senc', 'saio', 'saiz'].includes(b.type))).toBe(false);
    expect(parseMediaSegment(clear).fragments[0]?.trafs[0]?.encryption).toBeUndefined();
  });

  it('refuses IVs on some samples only, IVs of different sizes, and a size that is neither 8 nor 16', () => {
    const [first, ...rest] = samples;
    const mixed = [first as (typeof samples)[number], ...rest.map(({ iv: _iv, ...s }) => s)];
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples: mixed }),
    ).toThrow(/every sample has an IV of the same size or none/);
    const uneven = samples.map((s, i) => (i === 1 ? { ...s, iv: Buffer.alloc(16) } : s));
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples: uneven }),
    ).toThrow(/same size/);
    const short = samples.map((s) => ({ ...s, iv: Buffer.alloc(4) }));
    expect(() =>
      buildMediaSegment({ trackId: 1, sequenceNumber: 1, baseMediaDecodeTime: 0, samples: short }),
    ).toThrow(/IV size 4/);
  });

  it('rejects a senc whose track is not protected in the init segment (or that has no init at all)', () => {
    expect(() => parseMediaSegment(build())).toThrow(BoxError);
    expect(() => parseMediaSegment(build())).toThrow(/not protected/);
  });

  it.each([
    [
      'saio pointing one byte off the first IV',
      'saio',
      4 + 4 + 3,
      (old: number) => (old + 1) & 0xff,
      /saio points at/,
    ],
    ['saiz saying 16 bytes of auxiliary information for 8-byte IVs', 'saiz', 4, () => 16, /saiz says 16/],
    [
      'a senc that counts 2 entries for 3 samples',
      'senc',
      4 + 3,
      () => 2,
      /senc has 2 entries for 3 samples/,
    ],
    ['a senc with the subsample flag', 'senc', 3, () => 2, /subsample map is not supported/],
  ])('rejects %s', (_name, type, at, change, message) => {
    const seg = build();
    const position = find(seg, type).start + 8 + at;
    seg[position] = change(seg[position] as number);
    expect(() => parseMediaSegment(seg, init)).toThrow(message);
  });

  it('rejects saiz and saio without a senc: auxiliary information outside the moof is not supported', () => {
    const seg = build();
    seg.write('free', find(seg, 'senc').start + 4, 'latin1');
    expect(() => parseMediaSegment(seg, init)).toThrow(/saiz\/saio without senc/);
  });
});

/** A hand-made fragment: tfhd and trun flags chosen by the test, with the moof size and data offset worked out. */
function fragment(opts: {
  tfhdFlags: number;
  tfhdFields: Buffer[];
  trunFlags: number;
  trunBody: (dataOffset: number) => Buffer;
  payload: Buffer;
  trunVersion?: number;
}): Buffer {
  const build = (dataOffset: number): Buffer => {
    const mfhd = fullBox('mfhd', 0, 0, u32(1));
    const tfhd = fullBox('tfhd', 0, opts.tfhdFlags, u32(1), ...opts.tfhdFields);
    const tfdt = fullBox('tfdt', 1, 0, u64(1000));
    const trun = fullBox('trun', opts.trunVersion ?? 0, opts.trunFlags, opts.trunBody(dataOffset));
    return box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  };
  const moof = build(0);
  return Buffer.concat([build(moof.length + 8), box('mdat', opts.payload)]);
}

describe('sample durations, sizes and flags: trun, then tfhd, then trex', () => {
  it('takes them from the tfhd defaults when the trun has none', () => {
    const seg = fragment({
      tfhdFlags: 0x020000 | 0x08 | 0x10 | 0x20,
      tfhdFields: [u32(1000), u32(4), u32(0x02000000)],
      trunFlags: 0x1,
      trunBody: (off) => Buffer.concat([u32(3), i32(off)]),
      payload: Buffer.alloc(12),
    });
    const traf = parseMediaSegment(seg).fragments[0]?.trafs[0];
    expect(traf?.samples.map((s) => [s.duration, s.size, s.sync])).toEqual([
      [1000, 4, true],
      [1000, 4, true],
      [1000, 4, true],
    ]);
    expect(traf?.duration).toBe(3000);
  });

  it('takes them from the trex defaults of the init segment when the tfhd has none either', () => {
    const seg = fragment({
      tfhdFlags: 0x020000,
      tfhdFields: [],
      trunFlags: 0x1,
      trunBody: (off) => Buffer.concat([u32(2), i32(off)]),
      payload: Buffer.alloc(16),
    });
    const init = {
      tracks: [
        {
          trackId: 1,
          entry: { kind: 'audio', format: 'mp4a', channelCount: 2, sampleRate: 48_000 },
          trex: {
            defaultSampleDescriptionIndex: 1,
            defaultSampleDuration: 1024,
            defaultSampleSize: 8,
            defaultSampleFlags: 0x01010000,
          },
        },
      ],
    } as unknown as ParsedInit;
    const traf = parseMediaSegment(seg, init).fragments[0]?.trafs[0];
    expect(traf?.samples.map((s) => [s.duration, s.size, s.sync])).toEqual([
      [1024, 8, false],
      [1024, 8, false],
    ]);
    // and without the init segment there is nothing to fall back to: an error, not a guess
    expect(() => parseMediaSegment(seg)).toThrow(/no duration\/size\/flags/);
  });

  it('applies first-sample-flags to the first sample only', () => {
    const seg = fragment({
      tfhdFlags: 0x020000 | 0x08 | 0x10 | 0x20,
      tfhdFields: [u32(512), u32(2), u32(0x01010000)],
      trunFlags: 0x1 | 0x4,
      trunBody: (off) => Buffer.concat([u32(3), i32(off), u32(0x02000000)]),
      payload: Buffer.alloc(6),
    });
    const samples = parseMediaSegment(seg).fragments[0]?.trafs[0]?.samples;
    expect(samples?.map((s) => s.sync)).toEqual([true, false, false]);
  });

  it('reads per-sample fields in their order, including signed composition offsets of a version 1 trun', () => {
    const seg = fragment({
      tfhdFlags: 0x020000,
      tfhdFields: [],
      trunFlags: 0x1 | 0x100 | 0x200 | 0x400 | 0x800,
      trunVersion: 1,
      trunBody: (off) =>
        Buffer.concat([
          u32(2),
          i32(off),
          u32(100),
          u32(3),
          u32(0x02000000),
          i32(-50),
          u32(200),
          u32(5),
          u32(0x01010000),
          i32(70),
        ]),
      payload: Buffer.alloc(8),
    });
    const samples = parseMediaSegment(seg).fragments[0]?.trafs[0]?.samples;
    expect(samples?.map((s) => [s.duration, s.size, s.sync, s.ctsOffset])).toEqual([
      [100, 3, true, -50],
      [200, 5, false, 70],
    ]);
  });

  it('honours an explicit base-data-offset', () => {
    const seg = fragment({
      tfhdFlags: 0x01 | 0x08 | 0x10 | 0x20,
      tfhdFields: [u64(40), u32(512), u32(2), u32(0)],
      trunFlags: 0x1,
      trunBody: () => Buffer.concat([u32(1), i32(4)]),
      payload: Buffer.alloc(2),
    });
    expect(parseMediaSegment(seg).fragments[0]?.trafs[0]?.samples[0]?.offset).toBe(44);
  });

  it('rejects a traf without exactly one tfdt', () => {
    const noTfdt = box(
      'moof',
      fullBox('mfhd', 0, 0, u32(1)),
      box('traf', fullBox('tfhd', 0, 0x020000, u32(1))),
    );
    expect(() => parseMediaSegment(noTfdt)).toThrow(/expected one tfdt/);
  });
});

describe('removeBoxes', () => {
  it('drops a box and fixes every container size on the way, leaving the rest byte-identical', () => {
    const mvhd = fullBox('mvhd', 0, 0, Buffer.alloc(96));
    const trak = box(
      'trak',
      box('tkhd', Buffer.alloc(4)),
      box('edts', box('elst', Buffer.alloc(12))),
      box('mdia', Buffer.alloc(8)),
    );
    const udta = box('udta', box('meta', Buffer.alloc(40)));
    const moov = box('moov', mvhd, trak, udta);
    const init = Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0)), moov]);
    const out = removeBoxes(init, [
      ['moov', 'udta'],
      ['moov', 'trak', 'edts'],
    ]);
    const expectedTrak = box('trak', box('tkhd', Buffer.alloc(4)), box('mdia', Buffer.alloc(8)));
    const expected = Buffer.concat([
      box('ftyp', Buffer.from('isom'), u32(0)),
      box('moov', mvhd, expectedTrak),
    ]);
    expect(out.equals(expected)).toBe(true);
    const [, moovBox] = readBoxes(out);
    expect(childBoxes(out, moovBox as never).map((b) => b.type)).toEqual(['mvhd', 'trak']);
    expect(payloadStart(moovBox as never)).toBeGreaterThan(0);
  });

  it('is the identity when nothing matches', () => {
    const init = Buffer.concat([
      box('ftyp', Buffer.from('isom'), u32(0)),
      box('moov', box('mvhd', Buffer.alloc(8))),
    ]);
    expect(removeBoxes(init, [['moov', 'udta']]).equals(init)).toBe(true);
  });
});
