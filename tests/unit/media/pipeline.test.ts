// The real pipeline on tiny streams: real ffmpeg, real files, real parsing. Kept small (160x90, 6 to 8 s of media) so that the whole file
// takes a few seconds; the full-size catalog is the business of tools/verify-streams.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkStreamDir,
  contentHashOf,
  initFileName,
  readStreamFile,
  segmentFileName,
  streamDir,
} from '../../../src/server/media/cache.ts';
import { vp9LevelFor } from '../../../src/server/media/codecs.ts';
import { ffmpegBinary, run } from '../../../src/server/media/ffmpeg.ts';
import { generateStreams, type GenerateResult } from '../../../src/server/media/generate.ts';
import { createMediaStore } from '../../../src/server/media/index.ts';
import { parseInit, parseMediaSegment, readBoxes, readTfdts } from '../../../src/server/media/isobmff.ts';
import { checkStreamIndex } from '../../../src/server/media/invariants.ts';
import { parseWebmInit, parseWebmMediaSegment } from '../../../src/server/media/ebml.ts';
import { audioSegmentFrameCounts, AAC_GRID } from '../../../src/server/media/segmenter.ts';
import { specHash, type StreamSpec } from '../../../src/server/media/specs.ts';
import type { MediaStore, RepIndex, StreamIndex } from '../../../src/server/media/types.ts';
import { parseDash } from '../../../tools/lib/dash-client.ts';
import { checkHlsMaster, checkHlsMedia } from './support/hls-check.ts';
import { microWebmSpec, scratchDir, tinyLiveSpec, tinyVodSpec, tinyWebmSpec } from './support/support.ts';

const scratch = scratchDir('pipeline');
const cacheDir = join(scratch.dir, 'cache');
const live = tinyLiveSpec();
const vod = tinyVodSpec();
const webm = tinyWebmSpec();
const specs = [live, vod, webm];

let generated: GenerateResult[] = [];

beforeAll(async () => {
  generated = await generateStreams({ cacheDir, specs, threads: 2 });
}, 120_000);
afterAll(() => scratch.remove());

const dirOf = (spec: StreamSpec): string => streamDir(cacheDir, spec);
const indexOf = (spec: StreamSpec): StreamIndex => readStreamFile(dirOf(spec)).index;
const rep = (index: StreamIndex, id: string): RepIndex => index.reps.find((r) => r.rep.id === id) as RepIndex;
const bytes = (spec: StreamSpec, name: string): Buffer => readFileSync(join(dirOf(spec), name));

describe('generation', () => {
  it('writes every stream into <cache>/<specHash>/<streamId>, complete and consistent', () => {
    expect(generated.map((g) => [g.id, g.status])).toEqual([
      ['live-cmaf', 'generated'],
      ['vod-cmaf-short', 'generated'],
      ['vod-webm', 'generated'],
    ]);
    for (const spec of specs) {
      expect(dirOf(spec)).toBe(join(cacheDir, specHash(spec), spec.id));
      const check = checkStreamDir(dirOf(spec), spec, { hash: true });
      expect(check.problems).toEqual([]);
      expect(
        checkStreamIndex(indexOf(spec), { audioFrameSec: spec.packaging === 'webm' ? 0.02 : 1024 / 48000 }),
      ).toEqual([]);
    }
  });

  it('records what it generated with: ffmpeg version, spec hash, generator version, a content hash over the file hashes', () => {
    const file = readStreamFile(dirOf(live));
    expect(file.ffmpegVersion).toMatch(/^\d/);
    expect(file.specHash).toBe(specHash(live));
    expect(file.index.info.ffmpegVersion).toBe(file.ffmpegVersion);
    expect(file.generationMs).toBeGreaterThan(0);
    expect(file.index.info.contentHash).toBe(contentHashOf(file.specHash, file.files));
    expect(Object.keys(file.files).sort()).toEqual(
      ['v240', 'v360', 'a-aac']
        .flatMap((r) => [`${r}/init.mp4`, ...[1, 2, 3, 4].map((n) => `${r}/${n}.m4s`)])
        .sort(),
    );
  });

  it('cuts AAC by the rule on real encoder output: 94, 94, 94, 93 frames per segment, 375 frames = the 8 s loop', () => {
    const idx = indexOf(live);
    const audio = rep(idx, 'a-aac');
    const counts = audio.segments.map(
      (s) =>
        parseMediaSegment(bytes(live, segmentFileName(audio.rep, s.number))).fragments[0]?.trafs[0]?.samples
          .length,
    );
    expect(counts).toEqual([94, 94, 94, 93]);
    expect(counts).toEqual(audioSegmentFrameCounts(4, 2, AAC_GRID));
    expect(audio.loopTicks).toBe(375 * 1024);
    // the loop invariant, to the tick, for every video rung against the audio
    for (const v of idx.reps.filter((r) => r.rep.track === 'video'))
      expect(v.loopTicks * audio.timescale).toBe(audio.loopTicks * v.timescale);
  });

  it('keeps VOD audio to whole frames that end before the video does: 281 frames in 6 s', () => {
    const idx = indexOf(vod);
    const audio = rep(idx, 'a-aac');
    expect(audio.segments.map((s) => s.duration / 1024)).toEqual([94, 94, 93]);
    expect(audio.loopTicks / audio.timescale).toBeLessThan(idx.info.durationSec);
    expect(idx.info.durationSec).toBe(6);
  });

  it('gives every video segment one keyframe at its start and exactly 60 frames, in a segment of styp + moof + mdat and no sidx', () => {
    const idx = indexOf(live);
    for (const r of idx.reps.filter((x) => x.rep.track === 'video')) {
      r.segments.forEach((s, i) => {
        const buf = bytes(live, segmentFileName(r.rep, s.number));
        const parsed = parseMediaSegment(buf);
        expect(parsed.boxes.map((b) => b.type)).toEqual(['styp', 'moof', 'mdat']);
        const traf = parsed.fragments[0]?.trafs[0];
        expect(traf?.samples).toHaveLength(60);
        expect(traf?.samples.filter((x) => x.sync)).toHaveLength(1);
        expect(traf?.samples[0]?.sync).toBe(true);
        expect(traf?.tfdtVersion).toBe(1);
        expect(traf?.baseMediaDecodeTime).toBe(i * 30_720);
      });
    }
  });

  it('writes codec strings from the bitstream: vpcC and the key frame agree with the level the size needs; esds says AAC-LC', () => {
    const idx = indexOf(live);
    for (const r of idx.reps.filter((x) => x.rep.track === 'video')) {
      const init = parseInit(bytes(live, initFileName(r.rep)));
      const entry = init.tracks[0]?.entry;
      expect(entry?.kind).toBe('video');
      const level = vp9LevelFor(r.rep.width as number, r.rep.height as number, 30);
      expect(r.rep.codecs).toBe(`vp09.00.${String(level).padStart(2, '0')}.08`);
      expect(init.tracks[0]?.codec).toBe(r.rep.codecs);
      expect(r.rep.frameRate).toBe(30);
    }
    const audioInit = parseInit(bytes(live, 'a-aac/init.mp4'));
    expect(audioInit.tracks[0]?.codec).toBe('mp4a.40.2');
    expect(rep(idx, 'a-aac').rep).toMatchObject({ codecs: 'mp4a.40.2', channels: 2, sampleRate: 48_000 });
  });

  it('ships init segments without edit lists or metadata: the media timeline is the presentation timeline', () => {
    for (const r of indexOf(live).reps) {
      const init = bytes(live, initFileName(r.rep));
      expect(parseInit(init).tracks[0]?.hasEditList).toBe(false);
      const moov = readBoxes(init).find((b) => b.type === 'moov');
      const kids = moov ? readBoxes(init, moov.start + 8, moov.start + moov.size).map((b) => b.type) : [];
      expect(kids).toEqual(['mvhd', 'trak', 'mvex']);
    }
  });

  it('declares bandwidth = the peak bitrate over any one segment, rounded up', () => {
    for (const spec of [live, vod]) {
      for (const r of indexOf(spec).reps) {
        const peak = Math.max(...r.segments.map((s) => (s.bytes * 8 * r.timescale) / s.duration));
        expect(r.rep.bandwidth).toBe(Math.ceil(peak));
      }
    }
  });

  it('WebM: one Cluster per segment at the keyframe, timecodes on the 2000 ms grid, Opus at exactly 100 packets per segment', () => {
    const idx = indexOf(webm);
    const v = rep(idx, 'v240');
    const a = rep(idx, 'a-opus');
    expect(v.rep).toMatchObject({
      mimeType: 'video/webm',
      initExt: 'webm',
      segmentExt: 'webm',
      frameRate: 30,
    });
    expect(a.rep.codecs).toBe('opus');
    expect(v.rep.codecs).toBe(`vp09.00.${vp9LevelFor(160, 90, 30)}.08`);
    // the lab writes the frame durations itself, so the init segments do not depend on which ffmpeg made the packets
    expect(parseWebmInit(bytes(webm, 'v240/init.webm')).tracks[0]).toMatchObject({
      defaultDurationNs: 33_333_333,
      width: 160,
      height: 90,
    });
    expect(parseWebmInit(bytes(webm, 'a-opus/init.webm')).tracks[0]).toMatchObject({
      defaultDurationNs: 20_000_000,
      codecDelayNs: 6_500_000,
    });
    expect(v.timescale).toBe(1000);
    v.segments.forEach((s, i) => {
      const c = parseWebmMediaSegment(bytes(webm, segmentFileName(v.rep, s.number)));
      expect(c.timecode).toBe(i * 2000);
      expect(c.blocks).toHaveLength(60);
      expect(c.blocks.filter((b) => b.keyframe)).toHaveLength(1);
      expect(c.blocks[0]?.keyframe).toBe(true);
    });
    a.segments.forEach((s, i) => {
      const c = parseWebmMediaSegment(bytes(webm, segmentFileName(a.rep, s.number)));
      expect(c.blocks.map((b) => b.timecode)).toEqual(
        Array.from({ length: 100 }, (_, k) => i * 2000 + k * 20),
      );
    });
  });
});

describe('what a real decoder says', () => {
  const concat = (spec: StreamSpec, repId: string): string => {
    const r = rep(indexOf(spec), repId);
    const out = join(scratch.dir, `${spec.id}-${repId}.${r.rep.initExt}`);
    writeFileSync(
      out,
      Buffer.concat([
        bytes(spec, initFileName(r.rep)),
        ...r.segments.map((s) => bytes(spec, segmentFileName(r.rep, s.number))),
      ]),
    );
    return out;
  };

  it.each([
    ['live-cmaf', 'v240'],
    ['live-cmaf', 'v360'],
    ['live-cmaf', 'a-aac'],
    ['vod-cmaf-short', 'v240'],
    ['vod-webm', 'v240'],
    ['vod-webm', 'a-opus'],
  ] as const)('%s/%s: init + segments decode without error', async (id, repId) => {
    const spec = specs.find((s) => s.id === id) as StreamSpec;
    const { stderr } = await run(ffmpegBinary(), [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-xerror',
      '-i',
      concat(spec, repId),
      '-f',
      'null',
      '-',
    ]);
    expect(stderr).toBe('');
  });

  it('decodes AAC to exactly frames x 1024 samples, with the first beep where the signal puts it (no priming offset)', async () => {
    const { stdout } = await run(ffmpegBinary(), [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-i',
      concat(live, 'a-aac'),
      '-f',
      'f32le',
      '-ac',
      '2',
      '-',
    ]);
    const samples = stdout.length / 8; // two channels of float32
    expect(samples).toBe(375 * 1024);
    let first = -1;
    for (let i = 0; i < samples; i++) {
      if (Math.abs(stdout.readFloatLE(i * 8)) > 0.01) {
        first = i;
        break;
      }
    }
    // the signal is silent until 0.1 s = sample 4800 and fades in over 20 ms; the priming frame (1024 samples) would push it past 5800
    expect(first).toBeGreaterThanOrEqual(4800);
    expect(first).toBeLessThan(5200);
    // silent in the first and last 2048 samples: the loop splice and the missing pre-roll are inaudible
    let edge = 0;
    for (let i = 0; i < 2048; i++)
      edge += Math.abs(stdout.readFloatLE(i * 8)) + Math.abs(stdout.readFloatLE((samples - 1 - i) * 8));
    expect(edge).toBeLessThan(1e-3);
  });
});

describe('the media store on real files', () => {
  let store: MediaStore;
  beforeAll(() => {
    // after the top-level beforeAll has generated the streams; 'vod-cmaf' has a spec here that was never generated
    store = createMediaStore({ cacheDir, specs: [...specs, { ...tinyVodSpec(), id: 'vod-cmaf' }] });
  });

  it('reports the ready streams in STREAM_IDS order and the ffmpeg that made them', () => {
    expect(store.streams().map((s) => s.id)).toEqual(['vod-cmaf-short', 'vod-webm', 'live-cmaf']);
    expect(store.has('live-cmaf')).toBe(true);
    expect(store.has('vod-cmaf')).toBe(false);
    expect(store.ffmpegVersion()).toBe(readStreamFile(dirOf(live)).ffmpegVersion);
  });

  it('serves init and source segments as the files on disk, and undefined for a number out of range', () => {
    expect(store.init('live-cmaf', 'v240').equals(bytes(live, 'v240/init.mp4'))).toBe(true);
    expect(store.segment('live-cmaf', 'a-aac', 3)?.equals(bytes(live, 'a-aac/3.m4s'))).toBe(true);
    for (const n of [0, 5, -1, 1.5, Number.NaN])
      expect(store.segment('live-cmaf', 'v240', n)).toBeUndefined();
  });

  it('throws clear errors for unknown streams, unknown representations and streams that are not ready', () => {
    expect(() => store.init('live-cmaf', 'v999')).toThrow(
      /no representation 'v999' \(has: v240, v360, a-aac\)/,
    );
    expect(() => store.index('vod-cmaf')).toThrow(/not ready.*npm run generate:streams/);
    expect(() => store.init('vod-cmaf', 'v240')).toThrow(/not ready/);
    expect(() => store.dashVod('vod-cmaf')).toThrow(/not ready/);
    // a stream without any spec cannot be fixed by generating: the error must not send the reader to the generator
    let message = '';
    try {
      store.index('vod-cmaf-clearkey');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not ready: it has no spec in this catalog/);
    expect(message).not.toContain('generate:streams');
    expect(() => store.liveSegment('vod-cmaf-short', 'v240', 1)).toThrow(/not live/);
    expect(() => store.liveSegmentTiming('vod-webm', 'v240', 1)).toThrow(/not live/);
  });

  it('live segment n is source segment ((n-1) mod 4) + 1 with only its tfdt moved by whole loops', () => {
    const idx = indexOf(live);
    for (const repId of ['v240', 'v360', 'a-aac']) {
      const r = rep(idx, repId);
      for (const n of [1, 2, 4, 5, 8, 9, 13, 42, 1000]) {
        const k = ((n - 1) % 4) + 1;
        const loop = Math.floor((n - 1) / 4);
        const src = bytes(live, segmentFileName(r.rep, k));
        const out = store.liveSegment('live-cmaf', repId, n);
        expect(readTfdts(out)).toEqual([(r.segments[k - 1] as { start: number }).start + loop * r.loopTicks]);
        expect(out.length).toBe(src.length);
        let differing = 0;
        for (let p = 0; p < src.length; p++) if (src[p] !== out[p]) differing++;
        expect(differing).toBeLessThanOrEqual(8); // the 8 bytes of one 64-bit tfdt field, nothing else
        expect(store.liveSegmentTiming('live-cmaf', repId, n)).toEqual({
          start: readTfdts(out)[0],
          duration: (r.segments[k - 1] as { duration: number }).duration,
        });
      }
    }
  });

  it('hands out a fresh buffer for every live segment: writing to it cannot damage the cache', () => {
    const a = store.liveSegment('live-cmaf', 'v240', 5);
    a.fill(0);
    const b = store.liveSegment('live-cmaf', 'v240', 5);
    expect(b.equals(a)).toBe(false);
    expect(store.segment('live-cmaf', 'v240', 1)?.equals(bytes(live, 'v240/1.m4s'))).toBe(true);
  });

  it('plays 1000 loops without a gap, an overlap or any drift between audio and video, measured on the bytes it serves', () => {
    const idx = indexOf(live);
    const v = rep(idx, 'v360');
    const a = rep(idx, 'a-aac');
    const times = (r: RepIndex, n: number): { start: number; duration: number } => {
      const traf = parseMediaSegment(store.liveSegment('live-cmaf', r.rep.id, n)).fragments[0]?.trafs[0];
      return { start: traf?.baseMediaDecodeTime ?? Number.NaN, duration: traf?.duration ?? Number.NaN };
    };
    let pv = times(v, 1);
    let pa = times(a, 1);
    for (let n = 2; n <= 4000; n++) {
      const cv = times(v, n);
      const ca = times(a, n);
      if (cv.start !== pv.start + pv.duration)
        throw new Error(
          `video segment ${n} starts at ${cv.start}, previous ends at ${pv.start + pv.duration}`,
        );
      if (ca.start !== pa.start + pa.duration)
        throw new Error(
          `audio segment ${n} starts at ${ca.start}, previous ends at ${pa.start + pa.duration}`,
        );
      if ((n - 1) % 4 === 0 && cv.start * a.timescale !== ca.start * v.timescale)
        throw new Error(`audio and video drifted apart at loop boundary ${n}`);
      pv = cv;
      pa = ca;
    }
  });

  it('builds manifests that a consumer reads back as the index says (VOD DASH, VOD HLS, live DASH across the wrap, live HLS)', () => {
    const idx = indexOf(vod);
    const dash = parseDash(store.dashVod('vod-cmaf-short'), 'http://h/s/x/vod-cmaf-short/dash/manifest.mpd');
    expect(dash.mediaPresentationDuration).toBe(6);
    for (const r of idx.reps) {
      expect(
        dash.representations.find((x) => x.id === r.rep.id)?.segments.map((s) => [s.start, s.duration]),
      ).toEqual(r.segments.map((s) => [s.start, s.duration]));
    }
    expect(checkHlsMaster(store.hlsMaster('vod-cmaf-short')).problems).toEqual([]);
    for (const id of ['v240', 'a-aac'])
      expect(checkHlsMedia(store.hlsMediaVod('vod-cmaf-short', id)).problems).toEqual([]);

    const ast = new Date('2026-01-01T00:00:00.000Z');
    const params = {
      firstNumber: 3,
      lastNumber: 7,
      availabilityStartTime: ast,
      publishTime: ast,
      timeShiftBufferDepthSec: 30,
      presentationDelaySec: 6,
      minimumUpdatePeriodSec: 2,
    };
    const liveMpd = parseDash(
      store.dashLive('live-cmaf', params),
      'http://h/s/x/live-cmaf/dash/manifest.mpd',
    );
    for (const r of liveMpd.representations) {
      expect(r.segments.map((s) => [s.number, s.start])).toEqual(
        [3, 4, 5, 6, 7].map((n) => [n, store.liveSegmentTiming('live-cmaf', r.id, n).start]),
      );
    }
    expect(checkHlsMedia(store.hlsMediaLive('live-cmaf', 'a-aac', params)).problems).toEqual([]);
    expect(() => store.hlsMaster('vod-webm')).toThrow(/not offered as HLS/);
  });

  it('is bounded: with room for one file, reading another evicts the first (the file is read from disk again)', () => {
    const dir = join(scratch.dir, 'lru');
    mkdirSync(dir, { recursive: true });
    const tiny = createMediaStore({ cacheDir, specs, maxCacheBytes: 1 });
    const victim = join(dirOf(live), 'v240', '1.m4s');
    const keep = readFileSync(victim);
    expect(tiny.segment('live-cmaf', 'v240', 1)?.equals(keep)).toBe(true);
    expect(tiny.segment('live-cmaf', 'v240', 2)).toBeDefined(); // evicts segment 1
    rmSync(victim);
    expect(() => tiny.segment('live-cmaf', 'v240', 1)).toThrow(/ENOENT/);
    writeFileSync(victim, keep);
    // a large bound keeps it: the deleted file is still served from memory
    const big = createMediaStore({ cacheDir, specs });
    expect(big.segment('live-cmaf', 'v240', 3)).toBeDefined();
    const other = join(dirOf(live), 'v240', '3.m4s');
    const copy = readFileSync(other);
    rmSync(other);
    expect(big.segment('live-cmaf', 'v240', 3)?.equals(copy)).toBe(true);
    writeFileSync(other, copy);
  });

  it('never fails to construct: an empty or missing cache just has nothing ready', () => {
    for (const dir of [join(scratch.dir, 'empty'), join(scratch.dir, 'does', 'not', 'exist')]) {
      const empty = createMediaStore({ cacheDir: dir, specs });
      expect(empty.streams()).toEqual([]);
      expect(empty.has('live-cmaf')).toBe(false);
      expect(empty.ffmpegVersion()).toBe('unknown');
    }
  });
});

describe('idempotence, repair and corruption', () => {
  const micro = microWebmSpec();

  it('a complete cache is a no-op that does not start ffmpeg (proved by pointing PB_FFMPEG at nothing)', async () => {
    const saved = process.env.PB_FFMPEG;
    process.env.PB_FFMPEG = join(scratch.dir, 'no-such-ffmpeg');
    try {
      const again = await generateStreams({ cacheDir, specs });
      expect(again.map((r) => r.status)).toEqual(['cached', 'cached', 'cached']);
      expect(again.every((r) => r.elapsedMs < 2000)).toBe(true);
      expect(again.map((r) => r.contentHash)).toEqual(generated.map((r) => r.contentHash));
    } finally {
      if (saved === undefined) delete process.env.PB_FFMPEG;
      else process.env.PB_FFMPEG = saved;
    }
  });

  it('detects a partially damaged cache (a segment is gone) and regenerates it to the same bytes', async () => {
    const [first] = await generateStreams({ cacheDir, specs: [micro], streams: ['vod-webm'], threads: 2 });
    rmSync(join(streamDir(cacheDir, micro), 'v240', '2.webm'));
    expect(checkStreamDir(streamDir(cacheDir, micro), micro, { hash: false }).ok).toBe(false);
    const [second] = await generateStreams({ cacheDir, specs: [micro], streams: ['vod-webm'], threads: 2 });
    expect(second?.status).toBe('generated');
    expect(second?.contentHash).toBe(first?.contentHash);
    expect(checkStreamDir(streamDir(cacheDir, micro), micro, { hash: true }).ok).toBe(true);
  }, 60_000);

  it('a directory without stream.json never looks complete, and leftovers of a dead process are cleaned up', async () => {
    const half = join(scratch.dir, 'half-cache');
    const dir = streamDir(half, micro);
    mkdirSync(join(dir, 'v240'), { recursive: true });
    writeFileSync(join(dir, 'v240', '1.webm'), 'partial');
    expect(checkStreamDir(dir, micro, { hash: false })).toMatchObject({
      ok: false,
      problems: ['stream.json is missing'],
    });
    const stale = join(dir, '..', `.tmp-vod-webm-2147483646-deadbeef`);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk'), 'x');
    const [r] = await generateStreams({ cacheDir: half, specs: [micro], threads: 2 });
    expect(r?.status).toBe('generated');
    expect(checkStreamDir(dir, micro, { hash: true }).ok).toBe(true);
    expect(readdirSync(join(dir, '..')).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(existsSync(stale)).toBe(false);
  }, 60_000);

  it('--verify finds a corrupted file of the right size; the plain size check cannot', async () => {
    const dir = streamDir(cacheDir, micro);
    const victim = join(dir, 'a-opus', '1.webm');
    const original = readFileSync(victim);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 0xff;
    writeFileSync(victim, flipped);
    const [plain] = await generateStreams({ cacheDir, specs: [micro], streams: ['vod-webm'] });
    expect(plain?.status).toBe('cached');
    await expect(
      generateStreams({ cacheDir, specs: [micro], streams: ['vod-webm'], verify: true }),
    ).rejects.toThrow(/a-opus\/1\.webm: sha256 does not match/);
    writeFileSync(victim, original);
    const [ok] = await generateStreams({ cacheDir, specs: [micro], streams: ['vod-webm'], verify: true });
    expect(ok?.verified).toBe(true);
  }, 60_000);

  it('produces identical bytes whatever the ffmpeg thread count (row-mt is pinned off): 1 thread vs 4 threads', async () => {
    const a = await generateStreams({ cacheDir: join(scratch.dir, 'threads-1'), specs: [micro], threads: 1 });
    const b = await generateStreams({ cacheDir: join(scratch.dir, 'threads-4'), specs: [micro], threads: 4 });
    expect(b[0]?.contentHash).toBe(a[0]?.contentHash);
    const fa = readStreamFile(a[0]?.dir as string).files;
    const fb = readStreamFile(b[0]?.dir as string).files;
    expect(fb).toEqual(fa);
  }, 60_000);

  it('refuses a stream that is not in the catalog, naming the ones that are', async () => {
    await expect(generateStreams({ cacheDir, specs, streams: ['vod-cmaf'] })).rejects.toThrow(
      /not in the catalog \(available: live-cmaf, vod-cmaf-short, vod-webm/,
    );
  });
});
