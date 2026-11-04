// `npm run build:player`
//
// Builds the player page (src/player) into dist/player, which the service serves at /player/:
//
//   index.html   the page
//   player.css   its two rules
//   shaka.js     Shaka Player's own full compiled build, COPIED VERBATIM from node_modules: the page runs exactly the bytes that
//                npm publishes (the build prints their sha256), not a re-printed copy. It defines the global `shaka`.
//   player.js    the lab's code (main.ts and what it imports) as one IIFE, plus its source map; unminified, so a stack trace
//                reads. It loads after shaka.js.
//
// Deterministic (same inputs, same bytes) and about a second. The page makes no request but its own.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PLAYER_DIST = join(ROOT, 'dist', 'player');
const SHAKA_DIR = join(ROOT, 'node_modules', 'shaka-player');

export interface BuiltFile {
  file: string;
  bytes: number;
}

export interface BuildResult {
  outDir: string;
  files: BuiltFile[];
  shaka: { version: string; sha256: string };
  ms: number;
}

export async function buildPlayer(outDir: string = PLAYER_DIST): Promise<BuildResult> {
  const started = performance.now();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [join(ROOT, 'src', 'player', 'main.ts')],
    outfile: join(outDir, 'player.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // What every engine the lab drives understands (Chromium, Firefox, WebKit as shipped with Playwright 1.64).
    target: 'es2022',
    sourcemap: true,
    logLevel: 'warning',
  });
  for (const asset of ['index.html', 'player.css']) {
    await copyFile(join(ROOT, 'src', 'player', asset), join(outDir, asset));
  }
  await copyFile(join(SHAKA_DIR, 'dist', 'shaka-player.compiled.js'), join(outDir, 'shaka.js'));

  const files: BuiltFile[] = [];
  for (const name of ['index.html', 'player.css', 'shaka.js', 'player.js', 'player.js.map']) {
    files.push({ file: relative(ROOT, join(outDir, name)), bytes: (await stat(join(outDir, name))).size });
  }
  const version = (JSON.parse(await readFile(join(SHAKA_DIR, 'package.json'), 'utf8')) as { version: string })
    .version;
  const sha256 = createHash('sha256')
    .update(await readFile(join(outDir, 'shaka.js')))
    .digest('hex');
  return { outDir, files, shaka: { version, sha256 }, ms: performance.now() - started };
}

async function main(): Promise<void> {
  const result = await buildPlayer();
  const width = Math.max(...result.files.map((f) => f.file.length));
  for (const { file, bytes } of result.files) {
    console.log(`${file.padEnd(width)}  ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`shaka.js is shaka-player ${result.shaka.version}, sha256 ${result.shaka.sha256}`);
  console.log(`built in ${Math.round(result.ms)} ms`);
}

// Run as a command, not when imported (the smoke tool builds the page when it is missing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
