// Stream generation: ffmpeg encodes each representation once into an intermediate file, then this module cuts it into segments on the
// 2 s grid (segmenter.ts), reads the written files back to build the index (inspect.ts), and installs the finished directory into the
// content-addressed cache with one atomic rename. A stream directory that exists is therefore complete.
//
// Idempotent: a complete cache is a no-op (no ffmpeg is started). `force` regenerates. `verify` re-hashes every file afterwards.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RepInfo, StreamId, StreamInfo } from '../../shared/streams.ts';
import {
  checkStreamDir,
  contentHashOf,
  defaultCacheDir,
  hashBuffer,
  initFileName,
  segmentFileName,
  STREAM_FILE,
  STREAM_FILE_VERSION,
  streamDir,
  type FileEntry,
  type StreamFile,
} from './cache.ts';
import { buildWebmInit, withDefaultDuration } from './ebml.ts';
import { ffmpegBinary, ffmpegVersion, run } from './ffmpeg.ts';
import { inspectRep, type InspectedRep } from './inspect.ts';
import { checkStreamIndex } from './invariants.ts';
import {
  AAC_GRID,
  audioFrameCount,
  audioSegmentFrameCounts,
  buildIsobmffSegments,
  buildWebmSegments,
  normalizeInit,
  OPUS_WEBM_GRID,
  readIsobmffPackets,
  readWebmPackets,
  videoSegmentFrameCounts,
} from './segmenter.ts';
import {
  CATALOG,
  ffmpegPlan,
  GENERATOR_VERSION,
  repIds,
  specHash,
  totalDurationSec,
  type StreamSpec,
} from './specs.ts';
import type { RepIndex, StreamIndex } from './types.ts';

export interface GenerateOptions {
  /** Default: <repo>/.cache/streams */
  cacheDir?: string;
  /** Default: the whole catalog. */
  streams?: StreamId[];
  /** The specs to choose from. Default: the catalog (src/server/media/specs.ts). Tests pass tiny specs to run the real pipeline quickly. */
  specs?: StreamSpec[];
  /** Regenerate even when the cache is complete. */
  force?: boolean;
  /** Re-hash every file against its index afterwards; a mismatch is an error. */
  verify?: boolean;
  /** ffmpeg -threads. The bytes do not depend on it (ADR-045). Default 4: the most the shared lab hosts allow. */
  threads?: number;
  /** Per ffmpeg process. Default 10 minutes. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface GenerateResult {
  id: StreamId;
  status: 'generated' | 'cached';
  dir: string;
  specHash: string;
  contentHash: string;
  files: number;
  bytes: number;
  durationSec: number;
  /** Wall-clock milliseconds spent in this call (about 0 for a cached stream). */
  elapsedMs: number;
  verified: boolean;
}

/** The mean audio frame a rep of this stream uses: AAC for fMP4, Opus (20 ms) for WebM. */
const audioGrid = (s: StreamSpec) => (s.packaging === 'webm' ? OPUS_WEBM_GRID : AAC_GRID);

// ------------------------------------------------------------------------------------------------------------------------------
// Packaging one representation
// ------------------------------------------------------------------------------------------------------------------------------

interface PackagedRep {
  init: Buffer;
  segments: Buffer[];
}

function expectAll(values: number[], expected: number, what: string, from = 0, to = values.length): void {
  for (let i = from; i < to; i++) {
    if (values[i] !== expected)
      throw new Error(`${what}: sample ${i} lasts ${values[i]} ticks, expected ${expected}`);
  }
}

/** Cuts the encoder's output into the init segment and the segments of the 2 s grid. */
export function packageRep(spec: StreamSpec, repId: string, intermediate: Buffer): PackagedRep {
  const isAudio = repId === spec.audio.id;
  const secs = spec.segmentDurationSec;
  if (spec.packaging === 'cmaf') {
    const src = readIsobmffPackets(intermediate);
    if (!isAudio) {
      if (src.track.timescale % spec.frameRate !== 0) {
        throw new Error(
          `${repId}: timescale ${src.track.timescale} is not a multiple of ${spec.frameRate} fps`,
        );
      }
      const ticksPerFrame = src.track.timescale / spec.frameRate;
      const frames = totalDurationSec(spec) * spec.frameRate;
      if (src.packets.length !== frames)
        throw new Error(`${repId}: the encoder produced ${src.packets.length} frames, expected ${frames}`);
      expectAll(src.durations, ticksPerFrame, repId);
      const segments = buildIsobmffSegments({
        trackId: src.track.trackId,
        ticksPerSample: ticksPerFrame,
        packets: src.packets,
        counts: videoSegmentFrameCounts(spec.segmentCount, secs, spec.frameRate),
      });
      return { init: normalizeInit(src.init), segments };
    }
    // AAC: the encoder emits one priming frame (1024 samples of pre-roll) before the first real frame and holds the time line in
    // whole frames. The priming frame is dropped, so frame i covers [i * 1024, (i + 1) * 1024) of the signal and starts at tick i * 1024;
    // the signal is silent at both ends so that the missing overlap of the first frame is inaudible (ADR-042).
    const wanted = audioFrameCount(totalDurationSec(spec), AAC_GRID);
    if (src.packets.length < wanted + 1) {
      throw new Error(
        `${repId}: the encoder produced ${src.packets.length} frames, at least ${wanted + 1} (priming + ${wanted}) are needed`,
      );
    }
    expectAll(src.durations, AAC_GRID.frameSamples, repId, 0, wanted + 1);
    const segments = buildIsobmffSegments({
      trackId: src.track.trackId,
      ticksPerSample: AAC_GRID.frameSamples,
      packets: src.packets.slice(1, wanted + 1),
      counts: audioSegmentFrameCounts(spec.segmentCount, secs, AAC_GRID),
      requireSyncStart: false,
    });
    return { init: normalizeInit(src.init), segments };
  }
  // WebM
  const src = readWebmPackets(intermediate);
  // Exact frame durations in nanoseconds: 1/30 s (33,333,333, as ffmpeg 9 writes it) and 20 ms. See withDefaultDuration.
  const defaultDurationNs = isAudio
    ? OPUS_WEBM_GRID.frameSamples * 1_000_000
    : Math.floor(1e9 / spec.frameRate);
  const init = buildWebmInit({
    ebmlHeader: src.init.ebmlHeader,
    tracksElement: withDefaultDuration(src.init.tracksElement, src.track.number, defaultDurationNs),
    timecodeScaleNs: src.init.timecodeScaleNs,
    app: 'playback-proof',
  });
  if (!isAudio) {
    const frames = totalDurationSec(spec) * spec.frameRate;
    if (src.packets.length !== frames)
      throw new Error(`${repId}: the encoder produced ${src.packets.length} frames, expected ${frames}`);
    const segments = buildWebmSegments({
      trackNumber: src.track.number,
      packets: src.packets,
      counts: videoSegmentFrameCounts(spec.segmentCount, secs, spec.frameRate),
      // Milliseconds, rounded from the frame index. The muxer's own timestamps are not used.
      timecodeMs: (i) => Math.round((i * 1000) / spec.frameRate),
    });
    return { init, segments };
  }
  // Opus: 20 ms frames, 100 per 2 s segment, so the grid needs no rounding. The encoder appends a short tail packet that carries the
  // last pre-skip's worth of samples; it is dropped so that every segment holds exactly 100 packets.
  const wanted = audioFrameCount(totalDurationSec(spec), OPUS_WEBM_GRID);
  if (src.packets.length < wanted)
    throw new Error(
      `${repId}: the encoder produced ${src.packets.length} packets, at least ${wanted} are needed`,
    );
  const segments = buildWebmSegments({
    trackNumber: src.track.number,
    packets: src.packets.slice(0, wanted),
    counts: audioSegmentFrameCounts(spec.segmentCount, secs, OPUS_WEBM_GRID),
    timecodeMs: (i) => i * OPUS_WEBM_GRID.frameSamples,
    requireSyncStart: false,
  });
  return { init, segments };
}

// ------------------------------------------------------------------------------------------------------------------------------
// The index of a written stream
// ------------------------------------------------------------------------------------------------------------------------------

/** Declared bandwidth: the peak bitrate over any one segment (bytes x 8 / real duration), rounded up. See ADR-043. */
export function peakBandwidth(rep: InspectedRep, sizes: number[]): number {
  let peak = 0;
  rep.segments.forEach((s, i) => {
    peak = Math.max(peak, ((sizes[i] as number) * 8 * rep.timescale) / s.duration);
  });
  return Math.ceil(peak);
}

function repInfoOf(spec: StreamSpec, id: string, inspected: InspectedRep, bandwidth: number): RepInfo {
  const webm = spec.packaging === 'webm';
  const base = {
    id,
    codecs: inspected.codecs,
    bandwidth,
    initExt: webm ? ('webm' as const) : ('mp4' as const),
    segmentExt: webm ? ('webm' as const) : ('m4s' as const),
  };
  if (inspected.kind === 'video') {
    const rep: RepInfo = { ...base, track: 'video', mimeType: webm ? 'video/webm' : 'video/mp4' };
    if (inspected.width !== undefined) rep.width = inspected.width;
    if (inspected.height !== undefined) rep.height = inspected.height;
    if (inspected.frameRate !== undefined) rep.frameRate = Math.round(inspected.frameRate * 1000) / 1000;
    return rep;
  }
  const rep: RepInfo = { ...base, track: 'audio', mimeType: webm ? 'audio/webm' : 'audio/mp4' };
  if (inspected.channels !== undefined) rep.channels = inspected.channels;
  if (inspected.sampleRate !== undefined) rep.sampleRate = inspected.sampleRate;
  return rep;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Generating one stream
// ------------------------------------------------------------------------------------------------------------------------------

function writeFiles(root: string, entries: Array<[string, Buffer]>): Record<string, FileEntry> {
  const files: Record<string, FileEntry> = {};
  for (const [name, data] of entries) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    files[name] = { bytes: data.length, sha256: hashBuffer(data) };
  }
  return files;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Temporary and replaced directories left behind by a process that died: only ever removes ones whose owner is gone. */
function removeStaleTemps(parent: string, id: string): void {
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent)) {
    const m = new RegExp(`^\\.(?:tmp|old)-${id}-(\\d+)-`).exec(name);
    if (m && !isAlive(Number(m[1]))) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

/** Puts the finished directory in place. An existing one (a forced or repaired run) is moved aside first, then deleted. */
function install(tmp: string, finalDir: string, token: string): void {
  if (existsSync(finalDir)) {
    const old = `${finalDir}.old-${token}`;
    renameSync(finalDir, old);
    renameSync(tmp, finalDir);
    rmSync(old, { recursive: true, force: true });
  } else {
    renameSync(tmp, finalDir);
  }
}

async function generateOne(
  spec: StreamSpec,
  opts: Required<Pick<GenerateOptions, 'threads' | 'timeoutMs'>> & GenerateOptions,
  cacheDir: string,
): Promise<GenerateResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const hash = specHash(spec);
  const dir = streamDir(cacheDir, spec);
  const parent = dirname(dir);
  removeStaleTemps(parent, spec.id);

  if (!opts.force) {
    const check = checkStreamDir(dir, spec, { hash: false });
    if (check.ok && check.file) {
      log(`${spec.id}: complete in cache (${hash.slice(0, 12)}), nothing to do`);
      return summarize(spec, 'cached', dir, check.file, Date.now() - started, false);
    }
    if (existsSync(dir)) log(`${spec.id}: cache is incomplete or stale (${check.problems[0]}), regenerating`);
  }

  const version = await ffmpegVersion();
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const tmp = join(parent, `.tmp-${spec.id}-${token}`);
  const work = join(tmp, '.work');
  mkdirSync(work, { recursive: true });
  try {
    const entries: Array<[string, Buffer]> = [];
    const inspected = new Map<string, InspectedRep>();
    const packaged = new Map<string, PackagedRep>();
    for (const id of repIds(spec)) {
      const plan = ffmpegPlan(spec, id);
      const intermediate = join(work, `${id}.${plan.container}`);
      const t0 = Date.now();
      await run(
        ffmpegBinary(),
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-y',
          ...plan.input,
          '-threads',
          String(opts.threads),
          ...plan.output,
          intermediate,
        ],
        { timeoutMs: opts.timeoutMs },
      );
      const pkg = packageRep(spec, id, readFileSync(intermediate));
      rmSync(intermediate);
      packaged.set(id, pkg);
      log(
        `${spec.id}: ${id} encoded and cut into ${pkg.segments.length} segments (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
      );
    }
    for (const id of repIds(spec)) {
      const pkg = packaged.get(id) as PackagedRep;
      inspected.set(id, inspectRep(spec.packaging, pkg.init, pkg.segments));
    }
    rmSync(work, { recursive: true, force: true });

    // The index is built from the files as they were written, not from what the generator intended to write.
    const repInfos: RepInfo[] = [];
    for (const id of repIds(spec)) {
      const pkg = packaged.get(id) as PackagedRep;
      const insp = inspected.get(id) as InspectedRep;
      const info = repInfoOf(
        spec,
        id,
        insp,
        peakBandwidth(
          insp,
          pkg.segments.map((s) => s.length),
        ),
      );
      repInfos.push(info);
      entries.push([initFileName(info), pkg.init]);
      pkg.segments.forEach((s, i) => entries.push([segmentFileName(info, i + 1), s]));
    }
    const files = writeFiles(tmp, entries);
    const reps: RepIndex[] = repInfos.map((rep) => {
      const insp = inspected.get(rep.id) as InspectedRep;
      const segments = insp.segments.map((s, i) => {
        const entry = files[segmentFileName(rep, i + 1)] as FileEntry;
        return {
          number: i + 1,
          start: s.start,
          duration: s.duration,
          bytes: entry.bytes,
          sha256: entry.sha256,
        };
      });
      return {
        rep,
        timescale: insp.timescale,
        segments,
        loopTicks: segments.reduce((sum, s) => sum + s.duration, 0),
      };
    });
    const video = reps.find((r) => r.rep.track === 'video') as RepIndex;
    const info: StreamInfo = {
      id: spec.id,
      kind: spec.kind,
      packaging: spec.packaging,
      protocols: spec.protocols,
      segmentDurationSec: spec.segmentDurationSec,
      segmentCount: spec.segmentCount,
      durationSec: video.loopTicks / video.timescale,
      reps: repInfos,
      contentHash: contentHashOf(hash, files),
      ffmpegVersion: version,
    };
    const index: StreamIndex = { info, reps };
    const problems = checkStreamIndex(index, {
      audioFrameSec: audioGrid(spec).frameSamples / audioGrid(spec).sampleRate,
    });
    if (problems.length > 0)
      throw new Error(`generated stream ${spec.id} violates its invariants:\n  ${problems.join('\n  ')}`);

    const generationMs = Date.now() - started;
    const file: StreamFile = {
      formatVersion: STREAM_FILE_VERSION,
      specHash: hash,
      generatorVersion: GENERATOR_VERSION,
      ffmpegVersion: version,
      generationMs,
      index,
      files,
    };
    writeFileSync(join(tmp, STREAM_FILE), `${JSON.stringify(file, null, 2)}\n`);
    install(tmp, dir, token);
    log(`${spec.id}: generated in ${(generationMs / 1000).toFixed(1)} s -> ${dir}`);
    return summarize(spec, 'generated', dir, file, generationMs, false);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function summarize(
  spec: StreamSpec,
  status: 'generated' | 'cached',
  dir: string,
  file: StreamFile,
  elapsedMs: number,
  verified: boolean,
): GenerateResult {
  const entries = Object.values(file.files);
  return {
    id: spec.id,
    status,
    dir,
    specHash: file.specHash,
    contentHash: file.index.info.contentHash,
    files: entries.length,
    bytes: entries.reduce((sum, f) => sum + f.bytes, 0),
    durationSec: file.index.info.durationSec,
    elapsedMs,
    verified,
  };
}

export async function generateStreams(options: GenerateOptions = {}): Promise<GenerateResult[]> {
  const cacheDir = resolve(options.cacheDir ?? defaultCacheDir());
  const catalog = options.specs ?? CATALOG;
  const ids = [...new Set(options.streams ?? catalog.map((s) => s.id))];
  const specs = ids.map((id) => {
    const s = catalog.find((c) => c.id === id);
    if (!s) {
      throw new Error(
        `stream '${id}' is not in the catalog (available: ${catalog.map((c) => c.id).join(', ')}; vod-cmaf-clearkey is a stretch goal that is not implemented)`,
      );
    }
    return s;
  });
  const opts = { ...options, threads: options.threads ?? 4, timeoutMs: options.timeoutMs ?? 10 * 60_000 };
  const results: GenerateResult[] = [];
  for (const spec of specs) {
    const result = await generateOne(spec, opts, cacheDir);
    if (options.verify) {
      const check = checkStreamDir(result.dir, spec, { hash: true });
      if (!check.ok) throw new Error(`${spec.id}: verification failed:\n  ${check.problems.join('\n  ')}`);
      result.verified = true;
      (options.log ?? (() => {}))(`${spec.id}: ${result.files} files re-hashed against stream.json: ok`);
    }
    results.push(result);
  }
  return results;
}
