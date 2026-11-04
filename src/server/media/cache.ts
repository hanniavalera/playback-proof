// The content-addressed stream cache: layout, the stream.json index, and the checks that decide whether a directory is a complete stream.
//
//   <cacheDir>/<specHash>/<streamId>/stream.json
//   <cacheDir>/<specHash>/<streamId>/<rep>/init.mp4|webm
//   <cacheDir>/<specHash>/<streamId>/<rep>/<n>.m4s|webm
//
// A directory is only ever created by renaming a fully written temporary directory into place (generate.ts), so "stream.json exists"
// already means "complete"; the checks below also notice a directory that was damaged afterwards (a deleted or truncated file).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RepInfo } from '../../shared/streams.ts';
import { checkStreamIndex } from './invariants.ts';
import { canonicalJson, GENERATOR_VERSION, sha256Hex, specHash, type StreamSpec } from './specs.ts';
import type { StreamIndex } from './types.ts';

export const STREAM_FILE = 'stream.json';
export const STREAM_FILE_VERSION = 1;

export interface FileEntry {
  bytes: number;
  sha256: string;
}

/** The content of stream.json. */
export interface StreamFile {
  formatVersion: typeof STREAM_FILE_VERSION;
  specHash: string;
  generatorVersion: number;
  ffmpegVersion: string;
  /** Wall-clock milliseconds the generation took (the only field that differs between two generations of the same content). */
  generationMs: number;
  index: StreamIndex;
  /** Every file of the stream except stream.json: path relative to the stream directory, size and sha256. */
  files: Record<string, FileEntry>;
}

/** <repo>/.cache/streams, wherever the process was started from. */
export function defaultCacheDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '.cache', 'streams');
}

export const streamDir = (cacheDir: string, spec: StreamSpec): string =>
  join(cacheDir, specHash(spec), spec.id);
export const initFileName = (rep: RepInfo): string => `${rep.id}/init.${rep.initExt}`;
export const segmentFileName = (rep: RepInfo, n: number): string => `${rep.id}/${n}.${rep.segmentExt}`;

export const hashBuffer = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export function hashFile(path: string): string {
  return hashBuffer(readFileSync(path));
}

/** sha256 over the spec hash and every file's path and hash, in path order: identical spec + identical bytes <=> identical hash. */
export function contentHashOf(spec: string, files: Record<string, FileEntry>): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p} ${(files[p] as FileEntry).sha256}`);
  return sha256Hex(canonicalJson({ spec, files: lines }));
}

export function readStreamFile(dir: string): StreamFile {
  const path = join(dir, STREAM_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
  const f = parsed as Partial<StreamFile>;
  if (f.formatVersion !== STREAM_FILE_VERSION || !f.index || !f.files || typeof f.specHash !== 'string') {
    throw new Error(`${path} is not a version ${STREAM_FILE_VERSION} stream index`);
  }
  return parsed as StreamFile;
}

export interface CacheCheck {
  ok: boolean;
  problems: string[];
  file?: StreamFile;
}

/**
 * Is `dir` a complete, consistent stream for `spec`? Always checks stream.json against the spec, the index invariants, and that every
 * listed file exists with its recorded size. With `hash`, also re-hashes every file (about 50 MB for the whole catalog: well under a second).
 */
export function checkStreamDir(dir: string, spec: StreamSpec, options: { hash: boolean }): CacheCheck {
  const problems: string[] = [];
  if (!existsSync(join(dir, STREAM_FILE))) return { ok: false, problems: [`${STREAM_FILE} is missing`] };
  let file: StreamFile;
  try {
    file = readStreamFile(dir);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message] };
  }
  const expectedHash = specHash(spec);
  if (file.specHash !== expectedHash) problems.push(`spec hash ${file.specHash} is not ${expectedHash}`);
  if (file.generatorVersion !== GENERATOR_VERSION)
    problems.push(`generator version ${file.generatorVersion} is not ${GENERATOR_VERSION}`);
  if (file.index.info.id !== spec.id) problems.push(`index is for '${file.index.info.id}', not '${spec.id}'`);
  problems.push(...checkStreamIndex(file.index));
  if (file.index.info.contentHash !== contentHashOf(file.specHash, file.files))
    problems.push('contentHash does not match the file hashes');

  // Every file the index promises must be listed, and every listed file must be on disk with its size (and hash).
  const expected = new Set<string>();
  for (const r of file.index.reps) {
    expected.add(initFileName(r.rep));
    for (const s of r.segments) {
      const name = segmentFileName(r.rep, s.number);
      expected.add(name);
      const entry = file.files[name];
      if (entry && (entry.sha256 !== s.sha256 || entry.bytes !== s.bytes))
        problems.push(`${name}: stream.json lists different hash or size than the index`);
    }
  }
  for (const name of expected) if (!file.files[name]) problems.push(`${name}: not listed in ${STREAM_FILE}`);
  for (const [name, entry] of Object.entries(file.files)) {
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      problems.push(`${name}: missing`);
      continue;
    }
    if (size !== entry.bytes) {
      problems.push(`${name}: ${size} bytes on disk, ${entry.bytes} recorded`);
      continue;
    }
    if (options.hash && hashFile(path) !== entry.sha256)
      problems.push(`${name}: sha256 does not match the recorded hash`);
  }
  return { ok: problems.length === 0, problems, file };
}
