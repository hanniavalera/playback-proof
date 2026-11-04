// `npm run generate:streams -- [--streams vod-cmaf,live-cmaf] [--force] [--verify] [--threads N] [--cache-dir DIR] [--quiet]`
//
// Generates the lab's streams into the content-addressed cache (.cache/streams/<specHash>/<streamId>/). Idempotent: a complete cache is
// a no-op. PB_FFMPEG / PB_FFPROBE override the binaries. Exit code 0 on success, 1 on any failure.

import { parseArgs } from 'node:util';
import { STREAM_IDS, type StreamId } from '../src/shared/streams.ts';
import { generateStreams, type GenerateResult } from '../src/server/media/generate.ts';

const USAGE = `usage: npm run generate:streams -- [options]

  --streams <a,b>    streams to generate (default: all). One of: ${STREAM_IDS.join(', ')}
  --force            regenerate even if the cache is complete
  --verify           re-hash every file against stream.json afterwards
  --threads <n>      ffmpeg -threads (default 4; the output does not depend on it)
  --cache-dir <dir>  cache root (default: .cache/streams in the repository)
  --quiet            only print the summary table
  --help`;

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function summary(results: GenerateResult[]): string {
  const rows = [['stream', 'status', 'files', 'size', 'duration', 'spec', 'content', 'time', 'verified']];
  for (const r of results) {
    rows.push([
      r.id,
      r.status,
      String(r.files),
      megabytes(r.bytes),
      `${r.durationSec} s`,
      r.specHash.slice(0, 12),
      r.contentHash.slice(0, 12),
      `${(r.elapsedMs / 1000).toFixed(1)} s`,
      r.verified ? 'yes' : 'no',
    ]);
  }
  const total = results.reduce((sum, r) => sum + r.bytes, 0);
  return `${table(rows)}\n\ntotal: ${results.reduce((n, r) => n + r.files, 0)} files, ${megabytes(total)}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      streams: { type: 'string' },
      force: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      threads: { type: 'string' },
      'cache-dir': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    // `npm run generate:streams -- ...` passes a lone `--` through on some npm versions.
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const streams = values.streams
    ? values.streams
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  for (const s of streams ?? []) {
    if (!(STREAM_IDS as readonly string[]).includes(s))
      throw new Error(`unknown stream '${s}' (one of: ${STREAM_IDS.join(', ')})`);
  }
  const threads = values.threads === undefined ? undefined : Number(values.threads);
  if (threads !== undefined && (!Number.isInteger(threads) || threads < 1 || threads > 64))
    throw new Error(`--threads must be an integer from 1 to 64, got '${values.threads}'`);

  const results = await generateStreams({
    ...(streams ? { streams: streams as StreamId[] } : {}),
    force: values.force,
    verify: values.verify,
    ...(threads !== undefined ? { threads } : {}),
    ...(values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {}),
    ...(values.quiet ? {} : { log: (line: string) => console.log(line) }),
  });
  console.log(`\n${summary(results)}`);
}

main().catch((e: unknown) => {
  console.error(`generate:streams failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
