import { describe, expect, it } from 'vitest';
import {
  BoxError,
  box,
  buildMediaSegment,
  childBoxes,
  fullBox,
  parseMediaSegment,
  payloadStart,
  readBoxes,
  readTfdts,
  rewriteTfdt,
} from '../../../src/server/media/isobmff.ts';
import { liveTiming } from '../../../src/server/media/live.ts';
import type { RepIndex } from '../../../src/server/media/types.ts';
import { syntheticIndex } from './support/support.ts';

/** mulberry32: a small seeded PRNG so that a failing property test can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSegment(rand: () => number): Buffer {
  const count = 1 + Math.floor(rand() * 40);
  const samples = Array.from({ length: count }, (_, i) => ({
    data: Buffer.from(Array.from({ length: 1 + Math.floor(rand() * 200) }, () => Math.floor(rand() * 256))),
    duration: 1 + Math.floor(rand() * 2000),
    sync: i === 0,
  }));
  return buildMediaSegment({
    trackId: 1 + Math.floor(rand() * 5),
    sequenceNumber: 1 + Math.floor(rand() * 1000),
    baseMediaDecodeTime: Math.floor(rand() * 2 ** 40),
    samples,
  });
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64raw = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

/** [moof [mfhd, traf [tfhd, tfdt, trun]...]] [mdat] with the given tfdt versions and values: one traf each. */
function handMade(tfdts: Array<{ version: 0 | 1; base: bigint }>): Buffer {
  const trafs = tfdts.map((t, i) =>
    box(
      'traf',
      fullBox('tfhd', 0, 0x020000 | 0x08 | 0x10 | 0x20, u32(i + 1), u32(512), u32(4), u32(0x02000000)),
      t.version === 1 ? fullBox('tfdt', 1, 0, u64raw(t.base)) : fullBox('tfdt', 0, 0, u32(Number(t.base))),
      fullBox('trun', 0, 0x1, u32(1), u32(0)),
    ),
  );
  return Buffer.concat([
    box('moof', fullBox('mfhd', 0, 0, u32(1)), ...trafs),
    box('mdat', Buffer.alloc(4 * tfdts.length)),
  ]);
}

/** The absolute byte offsets of every tfdt baseMediaDecodeTime field of a segment. */
function tfdtFields(seg: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const top of readBoxes(seg).filter((b) => b.type === 'moof')) {
    for (const traf of childBoxes(seg, top).filter((b) => b.type === 'traf')) {
      for (const t of childBoxes(seg, traf).filter((b) => b.type === 'tfdt')) {
        const version = seg.readUInt8(payloadStart(t));
        out.push([payloadStart(t) + 4, version === 1 ? 8 : 4]);
      }
    }
  }
  return out;
}

describe('rewriteTfdt', () => {
  it('delta 0 returns identical bytes, in a new buffer', () => {
    const rand = prng(1);
    for (let i = 0; i < 50; i++) {
      const seg = randomSegment(rand);
      const out = rewriteTfdt(seg, 0);
      expect(out.equals(seg)).toBe(true);
      expect(out).not.toBe(seg);
    }
  });

  it('applying a then b equals applying a + b', () => {
    const rand = prng(2);
    for (let i = 0; i < 200; i++) {
      const seg = randomSegment(rand);
      const a = Math.floor(rand() * 2 ** 41);
      const b = Math.floor(rand() * 2 ** 41);
      expect(rewriteTfdt(rewriteTfdt(seg, a), b).equals(rewriteTfdt(seg, a + b))).toBe(true);
    }
  });

  it('moves the decode time by exactly the delta (negative deltas too)', () => {
    const rand = prng(3);
    for (let i = 0; i < 100; i++) {
      const seg = randomSegment(rand);
      const [before] = readTfdts(seg) as [number];
      const delta = Math.floor(rand() * 2 ** 41) - 2 ** 40;
      if (before + delta < 0) expect(() => rewriteTfdt(seg, delta)).toThrow(RangeError);
      else expect(readTfdts(rewriteTfdt(seg, delta))).toEqual([before + delta]);
    }
  });

  it('changes nothing but the tfdt field, and never touches its input', () => {
    const rand = prng(4);
    for (let i = 0; i < 100; i++) {
      const seg = randomSegment(rand);
      const snapshot = Buffer.from(seg);
      const out = rewriteTfdt(seg, 1 + Math.floor(rand() * 2 ** 40));
      expect(seg.equals(snapshot)).toBe(true);
      expect(out.length).toBe(seg.length);
      const fields = tfdtFields(seg);
      for (let p = 0; p < seg.length; p++) {
        if (seg[p] === out[p]) continue;
        expect(fields.some(([from, len]) => p >= from && p < from + len)).toBe(true);
      }
    }
  });

  it('moves every traf of the fragment and leaves a version 0 field 32 bits wide', () => {
    const seg = handMade([
      { version: 1, base: 1000n },
      { version: 0, base: 2000n },
    ]);
    const out = rewriteTfdt(seg, 500);
    expect(readTfdts(out)).toEqual([1500, 2500]);
    expect(out.length).toBe(seg.length);
  });

  it('refuses to wrap around: a version 0 tfdt that would overflow 32 bits is an error with a clear message', () => {
    const seg = handMade([{ version: 0, base: 0xffff_ff00n }]);
    expect(() => rewriteTfdt(seg, 0x1ff)).toThrow(/does not fit tfdt version 0/);
    expect(readTfdts(rewriteTfdt(seg, 0xff))).toEqual([0xffff_ffff]);
    expect(() => rewriteTfdt(handMade([{ version: 0, base: 5n }]), -6)).toThrow(RangeError);
  });

  it('refuses to overflow 64 bits and to move before zero', () => {
    const big = handMade([{ version: 1, base: (1n << 64n) - 10n }]);
    expect(() => rewriteTfdt(big, 20)).toThrow(/outside 0\.\.2\^64-1/);
    expect(() => rewriteTfdt(handMade([{ version: 1, base: 3n }]), -4)).toThrow(RangeError);
  });

  it('only accepts a delta that is a safe integer', () => {
    const seg = handMade([{ version: 1, base: 0n }]);
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])
      expect(() => rewriteTfdt(seg, bad)).toThrow(RangeError);
  });

  it('works on a segment whose boxes use 64-bit sizes', () => {
    const seg = handMade([{ version: 1, base: 7n }]);
    const [moof, mdat] = readBoxes(seg);
    const wide = (b: { type: string; start: number; headerSize: number; size: number }): Buffer => {
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(b.size + 8));
      return Buffer.concat([
        u32(1),
        Buffer.from(b.type, 'latin1'),
        size,
        seg.subarray(b.start + b.headerSize, b.start + b.size),
      ]);
    };
    const widened = Buffer.concat([wide(moof as never), wide(mdat as never)]);
    expect(readBoxes(widened).map((b) => b.headerSize)).toEqual([16, 16]);
    expect(readTfdts(rewriteTfdt(widened, 100))).toEqual([107]);
  });

  it('fails loudly on a segment it cannot move: no fragment, or a traf without a tfdt', () => {
    expect(() => rewriteTfdt(box('mdat', Buffer.alloc(4)), 1)).toThrow(BoxError);
    const noTfdt = box(
      'moof',
      fullBox('mfhd', 0, 0, u32(1)),
      box('traf', fullBox('tfhd', 0, 0x020000, u32(1))),
    );
    expect(() => rewriteTfdt(noTfdt, 1)).toThrow(/0 tfdt/);
    const twice = box(
      'moof',
      fullBox('mfhd', 0, 0, u32(1)),
      box(
        'traf',
        fullBox('tfhd', 0, 0x020000, u32(1)),
        fullBox('tfdt', 1, 0, u64raw(1n)),
        fullBox('tfdt', 1, 0, u64raw(2n)),
      ),
    );
    expect(() => rewriteTfdt(twice, 1)).toThrow(/2 tfdt/);
  });
});

/** Source segments of one representation of a synthetic index, with the real sample durations of the index. */
function sourceSegments(rep: RepIndex): Buffer[] {
  const perSegmentSamples = (d: number): number[] => {
    // video: 512-tick frames, audio: 1024-tick frames
    const unit = rep.rep.track === 'video' ? 512 : 1024;
    return Array.from({ length: d / unit }, () => unit);
  };
  return rep.segments.map((s) =>
    buildMediaSegment({
      trackId: 1,
      sequenceNumber: s.number,
      baseMediaDecodeTime: s.start,
      samples: perSegmentSamples(s.duration).map((duration, i) => ({
        data: Buffer.from([s.number, i & 0xff]),
        duration,
        sync: i === 0,
      })),
    }),
  );
}

describe('the live loop (1000 loops of 12 segments, video and audio)', () => {
  const index = syntheticIndex({ kind: 'live', segmentCount: 12, id: 'live-cmaf' });
  const video = index.reps[1] as RepIndex;
  const audio = index.reps[3] as RepIndex;
  const sources = new Map([
    [video, sourceSegments(video)],
    [audio, sourceSegments(audio)],
  ]);
  const LOOPS = 1000;

  /** Parses the rewritten segment n of a representation exactly as a player would: decode time and duration from the bytes. */
  const liveSegment = (rep: RepIndex, n: number): { start: number; duration: number } => {
    const k = ((n - 1) % 12) + 1;
    const loop = Math.floor((n - 1) / 12);
    const bytes = rewriteTfdt((sources.get(rep) as Buffer[])[k - 1] as Buffer, loop * rep.loopTicks);
    const traf = parseMediaSegment(bytes).fragments[0]?.trafs[0];
    return { start: traf?.baseMediaDecodeTime ?? Number.NaN, duration: traf?.duration ?? Number.NaN };
  };

  it('is gapless and overlap-free in every track: start(n+1) == start(n) + duration(n) for every n', () => {
    for (const rep of [video, audio]) {
      let prev = liveSegment(rep, 1);
      expect(prev.start).toBe(0);
      for (let n = 2; n <= LOOPS * 12; n++) {
        const cur = liveSegment(rep, n);
        if (cur.start !== prev.start + prev.duration) {
          throw new Error(
            `${rep.rep.id}: segment ${n} starts at ${cur.start}, the previous one ends at ${prev.start + prev.duration}`,
          );
        }
        prev = cur;
      }
    }
  });

  it('agrees with liveTiming (what the manifests announce) for every segment', () => {
    for (const rep of [video, audio]) {
      for (let n = 1; n <= 200; n++) expect(liveSegment(rep, n)).toEqual(liveTiming(rep, n));
    }
  });

  it('never lets audio and video drift apart: at every loop boundary both timelines are at the same instant, to the tick', () => {
    for (let loop = 0; loop <= LOOPS; loop++) {
      const n = loop * 12 + 1;
      const v = liveSegment(video, n);
      const a = liveSegment(audio, n);
      // v.start / 15360 == a.start / 48000, compared by cross-multiplication (no floating point)
      expect(v.start * 48_000).toBe(a.start * 15_360);
    }
  });

  it('keeps the rewritten bytes identical to the source except the tfdt field', () => {
    const src = (sources.get(audio) as Buffer[])[3] as Buffer;
    const out = rewriteTfdt(src, 7 * audio.loopTicks);
    const [field] = tfdtFields(src) as [[number, number]];
    for (let p = 0; p < src.length; p++)
      if (src[p] !== out[p]) expect(p >= field[0] && p < field[0] + field[1]).toBe(true);
  });
});
