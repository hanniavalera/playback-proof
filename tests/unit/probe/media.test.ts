import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILE_FORMATS, PROBE_FILE_IDS } from '../../../src/lab/probe/formats.ts';
import {
  FFMPEG_RECIPES,
  ProbeMediaError,
  ensureProbeMedia,
  ffmpegArgs,
  listTopLevelBoxes,
  probeMediaSpecHash,
} from '../../../src/lab/probe/media.ts';
import { makeScratch } from '../support/scratch.ts';

const scratch = makeScratch('unit-media-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function available(command: string): boolean {
  try {
    execFileSync(command, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasFfmpeg = available('ffmpeg');
const hasFfprobe = available('ffprobe');

function box(type: string, payload = 0, size?: number): Buffer {
  const total = size ?? 8 + payload;
  const buffer = Buffer.alloc(Math.max(total, 8));
  buffer.writeUInt32BE(total, 0);
  buffer.write(type, 4, 'latin1');
  return buffer;
}

describe('the ffmpeg recipes', () => {
  const valueOf = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('only ever read test patterns: no third-party media', () => {
    for (const id of PROBE_FILE_IDS) {
      const inputs = FFMPEG_RECIPES[id].flatMap((arg, index, all) => (all[index - 1] === '-i' ? [arg] : []));
      expect(inputs, id).toHaveLength(1);
      expect(inputs[0], id).toMatch(/^(testsrc2|sine)=/);
    }
  });

  it('forces a keyframe at 0 s and every 2 s in every video file, so fragments start on keyframes', () => {
    for (const id of PROBE_FILE_IDS.filter((file) => FILE_FORMATS[file].kind === 'video')) {
      const args = FFMPEG_RECIPES[id];
      expect(valueOf(args, '-force_key_frames'), id).toBe('expr:gte(t,n_forced*2)');
      expect(valueOf(args, '-g'), id).toBe('60');
      expect(args, id).toContain('-an');
    }
  });

  it('writes fragmented MP4 the way MSE needs it (empty moov, moof-relative offsets, a fragment per 2 s)', () => {
    for (const id of PROBE_FILE_IDS.filter((file) => FILE_FORMATS[file].container === 'mp4')) {
      const movflags = valueOf(FFMPEG_RECIPES[id], '-movflags') ?? '';
      expect(movflags, id).toContain('empty_moov');
      expect(movflags, id).toContain('default_base_moof');
      expect(movflags, id).toContain('frag_keyframe');
    }
    expect(valueOf(FFMPEG_RECIPES['a-aac.mp4'], '-frag_duration')).toBe('2000000');
    expect(valueOf(FFMPEG_RECIPES['a-opus.mp4'], '-frag_duration')).toBe('2000000');
  });

  it('encodes VP9 for speed and for reproducibility', () => {
    for (const id of ['v-vp9.mp4', 'v-vp9.webm'] as const) {
      const args = FFMPEG_RECIPES[id];
      expect(valueOf(args, '-c:v')).toBe('libvpx-vp9');
      expect(valueOf(args, '-deadline')).toBe('realtime');
      expect(valueOf(args, '-cpu-used')).toBe('8');
      expect(valueOf(args, '-threads')).toBe('1');
    }
  });

  it('builds the full command line: global flags first, the output path last', () => {
    const args = ffmpegArgs('a-opus.webm', '/out/a-opus.webm');
    expect(args.slice(0, 5)).toEqual(['-y', '-hide_banner', '-loglevel', 'error', '-nostdin']);
    expect(args.at(-1)).toBe('/out/a-opus.webm');
    expect(args).toContain('libopus');
  });

  it('has a content address that is stable and depends on the recipes', () => {
    expect(probeMediaSpecHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(probeMediaSpecHash()).toBe(probeMediaSpecHash());
  });
});

describe('listTopLevelBoxes', () => {
  it('lists the boxes of a fragmented MP4 in order', () => {
    const file = Buffer.concat([
      box('ftyp', 8),
      box('moov', 40),
      box('moof', 16),
      box('mdat', 100),
      box('mfra', 12),
    ]);
    expect(listTopLevelBoxes(file)).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'mfra']);
  });

  it('understands a 64-bit box size and a box that runs to the end of the file', () => {
    const large = Buffer.alloc(24);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(24n, 8);
    const toEnd = box('free', 20, 0);
    expect(listTopLevelBoxes(Buffer.concat([box('ftyp', 8), large, toEnd]))).toEqual([
      'ftyp',
      'mdat',
      'free',
    ]);
  });

  it('rejects a box with an impossible size instead of looping', () => {
    expect(() => listTopLevelBoxes(Buffer.concat([box('ftyp', 8), box('moov', 0, 4)]))).toThrow(
      /invalid box size/,
    );
  });
});

describe('ensureProbeMedia without ffmpeg', () => {
  it('fails with an actionable message when nothing is cached and ffmpeg is unusable (the Playwright image has none)', async () => {
    const error = await ensureProbeMedia({
      cacheRoot: join(scratch, 'empty'),
      ffmpegPath: '/nonexistent/ffmpeg',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProbeMediaError);
    expect((error as Error).message).toContain('--media-only');
    expect((error as Error).message).toContain('ffmpeg is not usable');
  });
});

describe.skipIf(!hasFfmpeg)('ensureProbeMedia with ffmpeg', () => {
  const cacheRoot = join(scratch, 'cache');
  let first: Awaited<ReturnType<typeof ensureProbeMedia>>;

  beforeAll(async () => {
    first = await ensureProbeMedia({ cacheRoot });
  }, 120_000);

  it('writes every file and a manifest into a directory named after the recipe hash', () => {
    expect(first.dir).toBe(join(cacheRoot, probeMediaSpecHash().slice(0, 12)));
    expect(Object.keys(first.files).sort()).toEqual([...PROBE_FILE_IDS].sort());
    expect(first.ffmpegVersion).toMatch(/^\S+$/);
    for (const id of PROBE_FILE_IDS) expect(first.files[id].bytes, id).toBeGreaterThan(10_000);
    const manifest = JSON.parse(readFileSync(join(first.dir, 'manifest.json'), 'utf8')) as {
      specHash: string;
    };
    expect(manifest.specHash).toBe(probeMediaSpecHash());
  });

  it('produces fragmented MP4 and WebM files that MSE can take', () => {
    for (const id of PROBE_FILE_IDS) {
      const bytes = readFileSync(join(first.dir, id));
      if (FILE_FORMATS[id].container === 'mp4') {
        const boxes = listTopLevelBoxes(bytes);
        expect(boxes[0], id).toBe('ftyp');
        expect(boxes.filter((type) => type === 'moof').length, id).toBeGreaterThanOrEqual(2);
      } else {
        expect([...bytes.subarray(0, 4)], id).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      }
    }
  });

  it.skipIf(!hasFfprobe)('has keyframes exactly at 0 s and 2 s and lasts 4 s (keyframes aligned)', () => {
    for (const id of PROBE_FILE_IDS.filter((file) => FILE_FORMATS[file].kind === 'video')) {
      const packets = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v',
          '-show_entries',
          'packet=pts_time,flags',
          '-of',
          'csv=p=0',
          join(first.dir, id),
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .map((line) => line.split(','));
      const keyframes = packets.filter(([, flags]) => flags?.includes('K')).map(([time]) => Number(time));
      expect(keyframes, id).toHaveLength(2);
      expect(keyframes[0], id).toBeCloseTo(0, 2);
      expect(keyframes[1], id).toBeCloseTo(2, 2);
      expect(packets, id).toHaveLength(120);
    }
    for (const id of PROBE_FILE_IDS) {
      const duration = Number(
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(first.dir, id)],
          {
            encoding: 'utf8',
          },
        ),
      );
      expect(duration, id).toBeGreaterThan(3.9);
      expect(duration, id).toBeLessThan(4.1);
    }
  });

  it("is idempotent, and a warm cache needs no ffmpeg at all (how the container reuses the host's files)", async () => {
    const again = await ensureProbeMedia({ cacheRoot, ffmpegPath: '/nonexistent/ffmpeg' });
    expect(again).toEqual(first);
  });

  it('notices a corrupted cache file and regenerates it instead of serving bad media', async () => {
    const victim = join(first.dir, 'v-vp9.mp4');
    const original = readFileSync(victim);
    writeFileSync(
      victim,
      Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original.at(-1)! ^ 0xff])]),
    );
    await expect(ensureProbeMedia({ cacheRoot, ffmpegPath: '/nonexistent/ffmpeg' })).rejects.toThrow(
      ProbeMediaError,
    );
    const repaired = await ensureProbeMedia({ cacheRoot });
    expect(repaired.files['v-vp9.mp4'].sha256).toBe(first.files['v-vp9.mp4'].sha256);
    expect(readFileSync(victim).equals(original)).toBe(true);
  }, 60_000);

  it('generates the same bytes every time (the committed results name the files by hash)', async () => {
    const other = await ensureProbeMedia({ cacheRoot: join(scratch, 'second-cache') });
    for (const id of PROBE_FILE_IDS) expect(other.files[id].sha256, id).toBe(first.files[id].sha256);
  }, 60_000);
});
