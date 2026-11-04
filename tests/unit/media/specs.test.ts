import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  GENERATOR_VERSION,
  LADDER,
  canonicalJson,
  ffmpegPlan,
  ffmpegPlans,
  repIds,
  sha256Hex,
  signalExpressions,
  specHash,
  streamSpec,
  totalDurationSec,
  type StreamSpec,
} from '../../../src/server/media/specs.ts';

const byId = (id: string): StreamSpec => CATALOG.find((s) => s.id === id) as StreamSpec;

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
  });

  it('does not depend on the order keys were inserted in', () => {
    const a: Record<string, unknown> = {};
    a.x = 1;
    a.y = { q: 1, p: 2 };
    const b: Record<string, unknown> = {};
    b.y = { p: 2, q: 1 };
    b.x = 1;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('drops undefined object members, writes undefined array members as null, escapes strings', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1], c: 'q"\n' })).toBe(
      '{"b":[null,1],"c":"q\\"\\n"}',
    );
  });

  it('refuses what JSON cannot say: NaN, Infinity, functions, symbols, bigint', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('x'), 1n]) {
      expect(() => canonicalJson({ v: bad })).toThrow();
    }
  });
});

describe('the catalog (docs/CONTRACTS.md section 3)', () => {
  it('has the four implemented streams with the contract durations, segment counts and protocols', () => {
    expect(
      CATALOG.map((s) => [
        s.id,
        s.kind,
        s.packaging,
        s.protocols.join('+'),
        s.segmentCount,
        totalDurationSec(s),
      ]),
    ).toEqual([
      ['vod-cmaf', 'vod', 'cmaf', 'dash+hls', 30, 60],
      ['vod-cmaf-short', 'vod', 'cmaf', 'dash+hls', 6, 12],
      ['vod-webm', 'vod', 'webm', 'dash', 15, 30],
      ['live-cmaf', 'live', 'cmaf', 'dash+hls', 12, 24],
    ]);
    expect(streamSpec('vod-cmaf-clearkey')).toBeUndefined();
  });

  it('uses the ladder 426x240 @ 300, 640x360 @ 700, 1280x720 @ 1800 kbps for every stream, 30 fps, 2 s segments', () => {
    expect(LADDER.map((r) => [r.id, r.width, r.height, r.bitrateKbps])).toEqual([
      ['v240', 426, 240, 300],
      ['v360', 640, 360, 700],
      ['v720', 1280, 720, 1800],
    ]);
    for (const s of CATALOG) {
      expect(s.rungs).toEqual(LADDER);
      expect([s.frameRate, s.segmentDurationSec]).toEqual([30, 2]);
    }
  });

  it('uses AAC-LC in fMP4 and Opus in WebM, 48 kHz stereo 64 kbps', () => {
    for (const s of CATALOG) {
      expect(s.audio).toMatchObject({
        bitrateKbps: 64,
        sampleRate: 48_000,
        channels: 2,
        id: s.packaging === 'webm' ? 'a-opus' : 'a-aac',
        codec: s.packaging === 'webm' ? 'opus' : 'aac',
      });
    }
  });

  it('gives the live source a whole number of AAC frames, which is what makes the loop equal for audio and video', () => {
    const l = byId('live-cmaf');
    expect((totalDurationSec(l) * 48_000) % 1024).toBe(0);
    expect(totalDurationSec(l) % 8).toBe(0);
  });

  it('lists the representations of a stream: the rungs then the audio', () => {
    expect(repIds(byId('vod-cmaf'))).toEqual(['v240', 'v360', 'v720', 'a-aac']);
    expect(repIds(byId('vod-webm'))).toEqual(['v240', 'v360', 'v720', 'a-opus']);
  });
});

describe('ffmpeg plans: what the determinism guarantee rests on', () => {
  const flat = (id: string, rep: string): string[] => {
    const p = ffmpegPlan(byId(id), rep);
    return [...p.input, ...p.output];
  };
  const has = (args: string[], ...seq: string[]): boolean =>
    args.some((_, i) => seq.every((s, k) => args[i + k] === s));

  it.each(['v240', 'v360', 'v720'])(
    '%s: constant-ish bitrate, forced keyframes every 2 s, no look-ahead, row-mt OFF, bit-exact output',
    (rep) => {
      const a = flat('vod-cmaf', rep);
      const kbps = `${(LADDER.find((r) => r.id === rep) as { bitrateKbps: number }).bitrateKbps}k`;
      expect(has(a, '-b:v', kbps, '-minrate', kbps, '-maxrate', kbps)).toBe(true); // min = max = target selects CBR in libvpx
      expect(has(a, '-row-mt', '0')).toBe(true); // row-mt 1 makes the bitstream depend on the thread count (ADR-045)
      expect(has(a, '-g', '60', '-keyint_min', '60')).toBe(true);
      expect(has(a, '-force_key_frames', 'expr:gte(t,n_forced*2)')).toBe(true);
      expect(has(a, '-lag-in-frames', '0')).toBe(true);
      expect(has(a, '-auto-alt-ref', '0')).toBe(true);
      expect(has(a, '-fflags', '+bitexact')).toBe(true);
      expect(has(a, '-flags:v', '+bitexact')).toBe(true);
      expect(has(a, '-map_metadata', '-1')).toBe(true);
      expect(
        a.some((x) => x.startsWith('testsrc2=size=') && x.includes(':rate=30:duration=60,format=yuv420p')),
      ).toBe(true);
    },
  );

  it('the thread count is not part of the plan, so it cannot be part of the cache key', () => {
    for (const s of CATALOG)
      for (const p of ffmpegPlans(s)) expect([...p.input, ...p.output]).not.toContain('-threads');
  });

  it('fMP4 plans write CMAF fragments; WebM plans use -dash 1 (a cluster per keyframe)', () => {
    expect(
      has(
        flat('vod-cmaf', 'v240'),
        '-f',
        'mp4',
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof+cmaf',
      ),
    ).toBe(true);
    expect(has(flat('vod-webm', 'v240'), '-f', 'webm', '-dash', '1')).toBe(true);
    expect(has(flat('vod-webm', 'a-opus'), '-f', 'webm', '-dash', '1')).toBe(true);
  });

  it('AAC: native encoder with a pinned coder and profile; Opus: CBR 20 ms frames; both bit-exact and at 64 kbps', () => {
    const aac = flat('vod-cmaf', 'a-aac');
    expect(has(aac, '-c:a', 'aac', '-aac_coder', 'twoloop', '-profile:a', 'aac_low')).toBe(true);
    expect(has(aac, '-b:a', '64k', '-ar', '48000', '-ac', '2')).toBe(true);
    expect(has(aac, '-flags:a', '+bitexact')).toBe(true);
    const opus = flat('vod-webm', 'a-opus');
    expect(has(opus, '-c:a', 'libopus', '-vbr', 'off')).toBe(true);
    expect(has(opus, '-frame_duration', '20')).toBe(true);
    expect(has(opus, '-b:a', '64k')).toBe(true);
  });

  it('feeds the audio encoder the whole stream length, so the encoder never runs short of the cutting rule', () => {
    expect(
      flat('vod-cmaf', 'a-aac').some((x) => x.startsWith('aevalsrc=') && x.endsWith(':duration=60')),
    ).toBe(true);
    expect(
      flat('live-cmaf', 'a-aac').some((x) => x.startsWith('aevalsrc=') && x.endsWith(':duration=24')),
    ).toBe(true);
  });

  it('uses ffmpeg sources only (testsrc2, aevalsrc): no drawtext, no external media', () => {
    for (const s of CATALOG)
      for (const p of ffmpegPlans(s)) expect(p.input.join(' ')).not.toMatch(/drawtext|movie=|\.mp4|\.mkv/);
  });

  it('refuses a representation the stream does not have', () => {
    expect(() => ffmpegPlan(byId('vod-cmaf'), 'a-opus')).toThrow(/no representation 'a-opus'/);
  });

  it('draws a pitch that climbs one semitone per segment, with a beep at the start and one a fifth above in the middle of each segment', () => {
    const [left, right] = signalExpressions(byId('vod-cmaf').audio.signal, 2);
    expect(left).toContain('pow(2,mod(floor(t/2),12)/12)');
    expect(left).toContain('1.5*261.63');
    expect(right).not.toBe(left); // the channels differ
    expect(left.startsWith('0.25*(')).toBe(true);
  });
});

describe('specHash (the cache key)', () => {
  it('is a sha256 of the canonical JSON of generator version, spec and resolved ffmpeg plans', () => {
    const s = byId('vod-cmaf-short');
    expect(specHash(s)).toBe(
      sha256Hex(canonicalJson({ generator: GENERATOR_VERSION, spec: s, plans: ffmpegPlans(s) })),
    );
    expect(specHash(s)).toMatch(/^[0-9a-f]{64}$/);
  });

  // A golden value per catalog stream: if one of these fails, something that changes the generated bytes was changed. If that was on
  // purpose, update the value here (every machine then regenerates that stream once); if not, you just caught a silent change.
  it('is stable: golden hashes for the catalog', () => {
    expect(Object.fromEntries(CATALOG.map((s) => [s.id, specHash(s)]))).toEqual({
      'vod-cmaf': '59da288111154ba61dbaeff8413f4e4cc4e219e6027cb1e51c1fb6d0a33849ad',
      'vod-cmaf-short': '8be82b6d2779813c092c8950a00f82e04dc55c9cbf705be5fa986d5ac0a46710',
      'vod-webm': 'ec18cc8d5ac9602878578c5941be989bffd86034fe6c47784f9149f9af19d0ca',
      'live-cmaf': '4390d4693a06367bc5853493d5ea14e6ee83bc4c11d8833db87048379fb1cf3c',
    });
  });

  it('does not depend on the order of keys in the spec object', () => {
    const s = byId('vod-cmaf');
    const shuffled = Object.fromEntries(Object.entries(s).reverse()) as unknown as StreamSpec;
    expect(specHash(shuffled)).toBe(specHash(s));
  });

  it('changes with anything that changes the bytes: a rung, an encoder option, the signal, the length, the container, the audio', () => {
    const base = byId('vod-cmaf-short');
    const h = specHash(base);
    const variants: StreamSpec[] = [
      { ...base, rungs: base.rungs.map((r, i) => (i === 1 ? { ...r, bitrateKbps: r.bitrateKbps + 1 } : r)) },
      { ...base, rungs: base.rungs.slice(1) },
      { ...base, encoders: { ...base.encoders, video: [...base.encoders.video, '-crf', '30'] } },
      { ...base, encoders: { ...base.encoders, audio: [...base.encoders.audio, '-cutoff', '15000'] } },
      { ...base, audio: { ...base.audio, signal: { ...base.audio.signal, baseHz: 262 } } },
      { ...base, audio: { ...base.audio, bitrateKbps: 96 } },
      { ...base, segmentCount: 7 },
      { ...base, frameRate: 25 },
      { ...base, id: 'live-cmaf' },
    ];
    const hashes = variants.map((v) => specHash(v));
    expect(hashes.every((x) => x !== h)).toBe(true);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('is the cache key per stream: no two catalog streams share one', () => {
    expect(new Set(CATALOG.map((s) => specHash(s))).size).toBe(CATALOG.length);
  });
});
