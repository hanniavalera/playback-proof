import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FILE_FORMATS, PROBE_FILE_IDS } from './formats.ts';
import type { ProbeFileId } from './formats.ts';

// Generates the tiny probe media with ffmpeg test patterns (testsrc2, sine): no third-party media. The files are
// content-addressed by the hash of their ffmpeg arguments, so generation is idempotent and a changed recipe can never be
// confused with an old cache. The hash does not include the ffmpeg version: the probe decodes whatever bytes it is given,
// and the manifest records which ffmpeg produced them. That also lets a container without ffmpeg (the Playwright image
// has none) reuse the files the host generated into the shared `.cache/` directory.

const execFileAsync = promisify(execFile);

const CLIP_SECONDS = 4;
const GOP_SECONDS = 2;
const FPS = 30;
const GOP_FRAMES = GOP_SECONDS * FPS;

/** Bump when the generation logic changes in a way the ffmpeg arguments do not show (post-processing, validation). */
const MEDIA_SPEC_VERSION = 1;

const GLOBAL_ARGS = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
const VIDEO_SOURCE = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}:duration=${CLIP_SECONDS}`];
const AUDIO_SOURCE = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${CLIP_SECONDS}`];

// Reproducible bytes: no encoder version tag, no wall-clock timestamps, and single-threaded encoders (libvpx's output
// depends on the thread count, which differs between machines).
const DETERMINISTIC = [
  '-map_metadata',
  '-1',
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
];

// A keyframe at t=0 and at every 2 s whatever the encoder's scene detection thinks, so every fragment starts on a keyframe:
// the same structure as the lab's 2 s segments.
const KEYFRAMES = [
  '-force_key_frames',
  `expr:gte(t,n_forced*${GOP_SECONDS})`,
  '-g',
  String(GOP_FRAMES),
  '-keyint_min',
  String(GOP_FRAMES),
  '-sc_threshold',
  '0',
];

const FMP4_FLAGS = '+frag_keyframe+empty_moov+default_base_moof';
const FMP4_VIDEO = ['-movflags', FMP4_FLAGS, '-f', 'mp4'];
// Audio packets are all keyframes, so fragment by duration: two 2 s fragments, like a segmented stream.
const FMP4_AUDIO = ['-movflags', FMP4_FLAGS, '-frag_duration', String(GOP_SECONDS * 1_000_000), '-f', 'mp4'];
const WEBM = ['-f', 'webm'];

const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-threads',
  '1',
  '-b:v',
  '600k',
];
const VP8 = ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-b:v', '600k'];
const H264 = [
  '-c:v',
  'libx264',
  '-profile:v',
  'baseline',
  '-level',
  '3.0',
  '-preset',
  'veryfast',
  '-b:v',
  '600k',
];
// SVT-AV1 is only reproducible single-threaded (lp=1): with several threads two runs differ by a few bytes.
const AV1 = ['-c:v', 'libsvtav1', '-preset', '8', '-b:v', '600k', '-svtav1-params', 'lp=1'];
// No B-frames: with reordering the first frame's presentation time is not 0 and the buffered range would start late.
const HEVC = [
  '-c:v',
  'libx265',
  '-preset',
  'ultrafast',
  '-b:v',
  '600k',
  '-x265-params',
  `keyint=${GOP_FRAMES}:min-keyint=${GOP_FRAMES}:scenecut=0:bframes=0:level-idc=31:log-level=error`,
  '-tag:v',
  'hvc1',
];
const AAC = ['-c:a', 'aac', '-b:a', '64k'];
const OPUS = ['-c:a', 'libopus', '-b:a', '64k'];

function video(codec: string[], container: string[]): string[] {
  return [
    ...VIDEO_SOURCE,
    ...DETERMINISTIC,
    ...codec,
    '-pix_fmt',
    'yuv420p',
    ...KEYFRAMES,
    '-an',
    ...container,
  ];
}

function audio(codec: string[], container: string[]): string[] {
  return [...AUDIO_SOURCE, ...DETERMINISTIC, ...codec, '-ac', '1', '-ar', '48000', '-vn', ...container];
}

/** The ffmpeg arguments that precede the output path, per file. The single source of truth for what the probe plays. */
export const FFMPEG_RECIPES: Record<ProbeFileId, readonly string[]> = {
  'v-vp9.mp4': video(VP9, FMP4_VIDEO),
  'v-vp9.webm': video(VP9, WEBM),
  'v-vp8.webm': video(VP8, WEBM),
  'v-h264.mp4': video(H264, FMP4_VIDEO),
  'v-av1.mp4': video(AV1, FMP4_VIDEO),
  'v-hevc.mp4': video(HEVC, FMP4_VIDEO),
  'a-aac.mp4': audio(AAC, FMP4_AUDIO),
  'a-opus.mp4': audio(OPUS, FMP4_AUDIO),
  'a-opus.webm': audio(OPUS, WEBM),
};

export function ffmpegArgs(file: ProbeFileId, outputPath: string): string[] {
  return [...GLOBAL_ARGS, ...FFMPEG_RECIPES[file], outputPath];
}

export function probeMediaSpecHash(): string {
  const recipes = PROBE_FILE_IDS.map((id) => [id, FFMPEG_RECIPES[id]]);
  return createHash('sha256')
    .update(JSON.stringify({ version: MEDIA_SPEC_VERSION, recipes }))
    .digest('hex');
}

export interface ProbeMediaManifest {
  specHash: string;
  /** The ffmpeg that produced the files (the machine that runs the probe may not have ffmpeg at all). */
  ffmpegVersion: string;
  files: Record<ProbeFileId, { sha256: string; bytes: number }>;
}

export interface ProbeMedia extends ProbeMediaManifest {
  dir: string;
}

export interface EnsureProbeMediaOptions {
  /** Default: `<repo>/.cache/probe-media`. */
  cacheRoot?: string;
  /** Default: `ffmpeg` from the PATH. */
  ffmpegPath?: string;
  log?: (message: string) => void;
}

export class ProbeMediaError extends Error {
  override name = 'ProbeMediaError';
}

export function defaultMediaCacheRoot(): string {
  return join(fileURLToPath(new URL('../../../', import.meta.url)), '.cache', 'probe-media');
}

export async function ffmpegVersion(ffmpegPath = 'ffmpeg'): Promise<string> {
  const { stdout } = await execFileAsync(ffmpegPath, ['-version']);
  const match = /^ffmpeg version (\S+)/m.exec(stdout);
  if (!match?.[1]) throw new Error(`cannot parse the output of "${ffmpegPath} -version"`);
  return match[1];
}

/** Top-level ISO BMFF box types, in order. Enough to tell a fragmented MP4 (moov, then moof+mdat pairs) from a plain one. */
export function listTopLevelBoxes(buffer: Uint8Array): string[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
    if (size === 1) size = Number(view.getBigUint64(offset + 8));
    else if (size === 0) size = buffer.byteLength - offset;
    if (size < 8) throw new Error(`invalid box size ${size} at offset ${offset}`);
    boxes.push(type);
    offset += size;
  }
  return boxes;
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

function validateGenerated(id: ProbeFileId, bytes: Buffer): void {
  const container = FILE_FORMATS[id].container;
  if (container === 'mp4') {
    const boxes = listTopLevelBoxes(bytes);
    if (!boxes.includes('moof') || boxes[0] !== 'ftyp') {
      throw new ProbeMediaError(
        `${id}: ffmpeg did not write a fragmented MP4 (boxes: ${boxes.join(' ')}); MSE would reject it`,
      );
    }
  } else if (!EBML_MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw new ProbeMediaError(`${id}: not a WebM/Matroska file (no EBML header)`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The manifest of an existing cache directory, only if it is complete and every file still has its recorded hash. */
function readValidManifest(dir: string, specHash: string): ProbeMediaManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ProbeMediaManifest;
    if (manifest.specHash !== specHash) return null;
    for (const id of PROBE_FILE_IDS) {
      const entry = manifest.files[id];
      if (!entry || statSync(join(dir, id)).size !== entry.bytes) return null;
      if (sha256(readFileSync(join(dir, id))) !== entry.sha256) return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

async function runFfmpeg(ffmpegPath: string, id: ProbeFileId, outputPath: string): Promise<void> {
  try {
    await execFileAsync(ffmpegPath, ffmpegArgs(id, outputPath));
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? '';
    throw new ProbeMediaError(
      `ffmpeg failed for ${id}: ${stderr.trim().split('\n').slice(-5).join(' | ') || String(cause)}`,
    );
  }
}

/**
 * Returns the directory with the probe media, generating it first if needed. Idempotent and safe to call concurrently:
 * files are written to a staging directory that is renamed into place only when complete.
 */
export async function ensureProbeMedia(options: EnsureProbeMediaOptions = {}): Promise<ProbeMedia> {
  const cacheRoot = options.cacheRoot ?? defaultMediaCacheRoot();
  const log = options.log ?? (() => undefined);
  const specHash = probeMediaSpecHash();
  const dir = join(cacheRoot, specHash.slice(0, 12));

  const cached = readValidManifest(dir, specHash);
  if (cached) return { dir, ...cached };

  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  let version: string;
  try {
    version = await ffmpegVersion(ffmpegPath);
  } catch (cause) {
    throw new ProbeMediaError(
      `no probe media cached for recipe ${specHash.slice(0, 12)} in ${cacheRoot} and ffmpeg is not usable here ` +
        `("${ffmpegPath}": ${cause instanceof Error ? cause.message : String(cause)}). Generate it on a host that has ffmpeg ` +
        `(npm run codec-matrix -- --media-only); the files are shared through the repository's .cache directory.`,
    );
  }

  log(`generating probe media with ffmpeg ${version} into ${dir}`);
  mkdirSync(cacheRoot, { recursive: true });
  const staging = join(cacheRoot, `.staging-${specHash.slice(0, 12)}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const files = {} as ProbeMediaManifest['files'];
    for (const id of PROBE_FILE_IDS) {
      const path = join(staging, id);
      await runFfmpeg(ffmpegPath, id, path);
      const bytes = readFileSync(path);
      validateGenerated(id, bytes);
      files[id] = { sha256: sha256(bytes), bytes: bytes.byteLength };
    }
    const manifest: ProbeMediaManifest = { specHash, ffmpegVersion: version, files };
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(staging, dir);
    } catch (error) {
      // Another process finished first: its result is as good as ours.
      if (!readValidManifest(dir, specHash)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const written = readValidManifest(dir, specHash);
  if (!written) throw new ProbeMediaError(`probe media in ${dir} failed verification right after generation`);
  return { dir, ...written };
}
