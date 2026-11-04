// The ClearKey stream through the real pipeline, tiny (160x90, 8 s): ffmpeg encodes clear samples, the lab cuts them (the audio on the 2 s
// grid), encrypts them with AES-CTR (CENC 'cenc') and writes the protected init segment and the per-fragment senc/saio/saiz, and ffmpeg
// decrypts with the key. The oracle is the same stream generated WITHOUT encryption: decrypted, it has to decode to exactly the same
// frames, and the packets (the plaintext bytes) have to be identical.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initFileName, readStreamFile, segmentFileName, streamDir } from '../../../src/server/media/cache.ts';
import { protectInit } from '../../../src/server/media/cenc.ts';
import { keyIdUuid } from '../../../src/server/media/dash.ts';
import { ffmpegBinary, run } from '../../../src/server/media/ffmpeg.ts';
import { generateStreams } from '../../../src/server/media/generate.ts';
import { createMediaStore } from '../../../src/server/media/index.ts';
import { parseInit, parseMediaSegment, type ParsedSample } from '../../../src/server/media/isobmff.ts';
import { AAC_GRID, audioFrameCount } from '../../../src/server/media/segmenter.ts';
import type { StreamSpec } from '../../../src/server/media/specs.ts';
import type { RepIndex, StreamIndex } from '../../../src/server/media/types.ts';
import { parseDash } from '../../../tools/lib/dash-client.ts';
import { scratchDir, tinyClearKeySpec } from './support/support.ts';

const scratch = scratchDir('clearkey');
const encrypted = tinyClearKeySpec();
const { drm: _drm, ...twin } = encrypted; // the same spec without encryption
const drm = encrypted.drm as NonNullable<StreamSpec['drm']>;
const encCache = join(scratch.dir, 'encrypted');
const clearCache = join(scratch.dir, 'clear');
const encDir = streamDir(encCache, encrypted);
const clearDir = streamDir(clearCache, twin);

beforeAll(async () => {
  await generateStreams({ cacheDir: encCache, specs: [encrypted], threads: 2 });
  await generateStreams({ cacheDir: clearCache, specs: [twin], threads: 2 });
}, 120_000);
afterAll(() => scratch.remove());

const indexOf = (dir: string): StreamIndex => readStreamFile(dir).index;
const rep = (index: StreamIndex, id: string): RepIndex => index.reps.find((r) => r.rep.id === id) as RepIndex;
const bytes = (dir: string, name: string): Buffer => readFileSync(join(dir, name));
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

/** The IVs of every sample of a representation, in order across the segments, as numbers (ffmpeg's IV is a counter). */
function ivsOf(repId: string): number[] {
  const r = rep(indexOf(encDir), repId);
  const init = parseInit(bytes(encDir, initFileName(r.rep)));
  return r.segments.flatMap((s) => {
    const traf = parseMediaSegment(bytes(encDir, segmentFileName(r.rep, s.number)), init).fragments[0]
      ?.trafs[0];
    return (traf?.encryption?.ivs ?? []).map((iv) => Number(iv.readBigUInt64BE()));
  });
}

describe('an encrypted stream, generated for real', () => {
  it('has a protected init segment per representation: encv / enca, cenc, the spec key id, 8-byte IVs, the real codec strings', () => {
    for (const [repId, format, original, codec] of [
      ['v360', 'encv', 'vp09', /^vp09\.00\.\d\d\.08$/],
      ['a-aac', 'enca', 'mp4a', 'mp4a.40.2'],
    ] as const) {
      const r = rep(indexOf(encDir), repId);
      const track = parseInit(bytes(encDir, initFileName(r.rep))).tracks[0];
      expect(track?.entry.format).toBe(format);
      expect(track?.entry.protection).toEqual({
        originalFormat: original,
        scheme: 'cenc',
        schemeVersion: 0x10000,
        defaultKid: drm.keyId,
        ivSize: 8,
      });
      expect(track?.codec).toMatch(codec);
      expect(r.rep.codecs).toMatch(codec);
    }
  });

  it('protects nothing but the sample entry: the init segment is the unencrypted twin init plus a sinf, built by protectInit', () => {
    for (const repId of ['v360', 'a-aac']) {
      const encInit = bytes(encDir, initFileName(rep(indexOf(encDir), repId).rep));
      const clearInit = bytes(clearDir, initFileName(rep(indexOf(clearDir), repId).rep));
      expect(protectInit(clearInit, Buffer.from(drm.keyId, 'hex')).equals(encInit)).toBe(true);
      expect(encInit.length).toBeGreaterThan(clearInit.length);
      // a track that is protected already (encv, enca) is not protected twice
      expect(() => protectInit(encInit, Buffer.from(drm.keyId, 'hex'))).toThrow(/cannot be protected/);
    }
  });

  it('gives every sample its own IV, its index in the track, and moves it with the sample through the re-cut: video 0..239, audio 0..374', () => {
    expect(ivsOf('v360')).toEqual(range(0, 4 * 60));
    expect(ivsOf('a-aac')).toEqual(range(0, audioFrameCount(8, AAC_GRID)));
  });

  it('is the unencrypted stream with every sample encrypted: the same timing and sample sizes, different bytes', () => {
    const enc = indexOf(encDir);
    const clear = indexOf(clearDir);
    expect(enc.info.drm).toEqual({ scheme: 'clearkey', keyId: drm.keyId, key: drm.key });
    expect(clear.info.drm).toBeUndefined();
    expect(enc.reps.map((r) => r.rep.id)).toEqual(['v360', 'a-aac']);
    for (const r of enc.reps) {
      const c = rep(clear, r.rep.id);
      expect(r.segments.map((s) => [s.start, s.duration])).toEqual(
        c.segments.map((s) => [s.start, s.duration]),
      );
      const encInit = parseInit(bytes(encDir, initFileName(r.rep)));
      const clearInit = parseInit(bytes(clearDir, initFileName(c.rep)));
      for (const s of r.segments) {
        const a = bytes(encDir, segmentFileName(r.rep, s.number));
        const b = bytes(clearDir, segmentFileName(c.rep, s.number));
        const sa = parseMediaSegment(a, encInit).fragments[0]?.trafs[0]?.samples ?? [];
        const sb = parseMediaSegment(b, clearInit).fragments[0]?.trafs[0]?.samples ?? [];
        expect(sa.map((x) => x.size)).toEqual(sb.map((x) => x.size)); // AES-CTR keeps every sample's size
        const unchanged = sa.filter((x, i) => {
          const y = sb[i] as ParsedSample;
          return a.subarray(x.offset, x.offset + x.size).equals(b.subarray(y.offset, y.offset + y.size));
        });
        expect(unchanged).toHaveLength(0); // no sample is left in the clear
      }
    }
  });
});

describe('what ffmpeg says about it', () => {
  const concat = (which: 'enc' | 'clear', repId: string): string => {
    const dir = which === 'enc' ? encDir : clearDir;
    const r = rep(indexOf(dir), repId);
    const out = join(scratch.dir, `${which}-${repId}.mp4`);
    writeFileSync(
      out,
      Buffer.concat([
        bytes(dir, initFileName(r.rep)),
        ...r.segments.map((s) => bytes(dir, segmentFileName(r.rep, s.number))),
      ]),
    );
    return out;
  };
  /** One line per decoded frame: stream, pts, size and md5 of the decoded data. A file ffmpeg cannot decode at all is one 'failed' line. */
  const frames = async (file: string, key?: string): Promise<string[]> => {
    try {
      const { stdout } = await run(ffmpegBinary(), [
        '-hide_banner',
        '-nostdin',
        '-v',
        'quiet',
        ...(key ? ['-decryption_key', key] : []),
        '-i',
        file,
        '-f',
        'framemd5',
        '-',
      ]);
      return stdout
        .toString('utf8')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'));
    } catch {
      return ['failed'];
    }
  };

  it.each([
    ['v360', 240],
    ['a-aac', 375],
  ])(
    '%s: decrypted with the key it decodes to exactly the frames of the unencrypted stream (%i of them)',
    async (repId, count) => {
      const want = await frames(concat('clear', repId));
      expect(want).toHaveLength(count);
      expect(await frames(concat('enc', repId), drm.key)).toEqual(want);
    },
  );

  it.each(['v360', 'a-aac'])(
    '%s: without the key, or with a wrong one, it does NOT decode to the same frames',
    async (repId) => {
      const want = await frames(concat('clear', repId));
      const file = concat('enc', repId);
      expect(await frames(file)).not.toEqual(want);
      expect(await frames(file, '00112233445566778899aabbccddeeff')).not.toEqual(want);
    },
  );
});

describe('the store and the manifest', () => {
  it('serves the key pair in the index, and a DASH manifest whose default_KID is the one in the init segments', () => {
    const store = createMediaStore({ cacheDir: encCache, specs: [encrypted] });
    expect(store.has('vod-cmaf-clearkey')).toBe(true);
    expect(store.index('vod-cmaf-clearkey').info.drm).toEqual({
      scheme: 'clearkey',
      keyId: drm.keyId,
      key: drm.key,
    });
    const mpd = parseDash(
      store.dashVod('vod-cmaf-clearkey'),
      'http://127.0.0.1:4620/s/s1/vod-cmaf-clearkey/dash/manifest.mpd',
    );
    expect(mpd.adaptationSets).toHaveLength(2);
    for (const set of mpd.adaptationSets) {
      const kid = set.contentProtection.find(
        (c) => c.schemeIdUri === 'urn:mpeg:dash:mp4protection:2011',
      )?.defaultKid;
      expect(kid).toBe(keyIdUuid(drm.keyId));
      expect(set.contentProtection.map((c) => c.schemeIdUri)).toContain(
        'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e',
      );
    }
    for (const id of ['v360', 'a-aac']) {
      const entry = parseInit(store.init('vod-cmaf-clearkey', id)).tracks[0]?.entry;
      expect(entry?.protection?.defaultKid.replace(/-/g, '')).toBe(drm.keyId);
    }
  });

  it('is DASH only: there is no HLS manifest to ask for', () => {
    const store = createMediaStore({ cacheDir: encCache, specs: [encrypted] });
    expect(() => store.hlsMaster('vod-cmaf-clearkey')).toThrow(/not offered as HLS/);
  });
});
