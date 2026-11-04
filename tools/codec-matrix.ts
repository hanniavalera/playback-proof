// `npm run codec-matrix`: probes what the installed browsers can REALLY play through MSE (never trusting isTypeSupported),
// writes one JSON file per environment, and renders docs/CODEC_MATRIX.md from every committed file.
// Usage and options: `npm run codec-matrix -- --help`. Design: docs/decisions/codecs.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE, UsageError, parseCliArgs } from '../src/lab/probe/cli-args.ts';
import type { CliOptions } from '../src/lab/probe/cli-args.ts';
import {
  CONTROL_CASES,
  PROBE_CASES,
  SENSITIVITY_CASE,
  SENSITIVITY_PROFILES,
  findCase,
} from '../src/lab/probe/formats.ts';
import { collectHostInfo } from '../src/lab/probe/host-info.ts';
import { ensureProbeMedia } from '../src/lab/probe/media.ts';
import { RESULT_SCHEMA_VERSION, readResultFiles, serializeResultFile } from '../src/lab/probe/report.ts';
import type { ResultFile } from '../src/lab/probe/report.ts';
import { renderMatrix, renderSummary } from '../src/lab/probe/render.ts';
import type { EngineResult } from '../src/lab/probe/results.ts';
import { DEFAULT_MIN_FRAMES, DEFAULT_THRESHOLD_SEC, runEngine } from '../src/lab/probe/run.ts';
import type { ProbePlan } from '../src/lab/probe/run.ts';
import { detectEnvId } from '../src/shared/env.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RESULTS_DIR = join(ROOT, 'docs', 'results', 'codec-matrix');
const MATRIX_DOC = join(ROOT, 'docs', 'CODEC_MATRIX.md');

async function probe(options: CliOptions, argv: readonly string[]): Promise<void> {
  // Imported here so that --render, --check and the unit tests never load Playwright.
  const { chromium, firefox, webkit } = await import('@playwright/test');
  const browserTypes = { chromium, firefox, webkit };

  const media = await ensureProbeMedia({ log: (message) => console.error(message) });
  const envId = detectEnvId();
  const out = resolve(options.out ?? join(RESULTS_DIR, `${envId}.json`));
  // The checkout the run started on: read before the browsers run, which can take many minutes.
  const host = collectHostInfo(ROOT);

  const sensitivityCase = findCase(SENSITIVITY_CASE);
  const plan: ProbePlan = {
    cases: options.cases ? options.cases.flatMap((id) => findCase(id) ?? []) : PROBE_CASES,
    controls: options.controls ? CONTROL_CASES : [],
    ...(options.sensitivity && sensitivityCase
      ? { sensitivity: { probeCase: sensitivityCase, profiles: SENSITIVITY_PROFILES } }
      : {}),
  };

  const engines: Record<string, EngineResult> = {};
  for (const name of options.browsers) {
    console.error(`== ${name}`);
    engines[name] = await runEngine(browserTypes[name], plan, {
      mediaDir: media.dir,
      attempts: options.attempts,
      freshProcess: options.freshProcess,
      timeoutMs: options.timeoutMs,
      thresholdSec: DEFAULT_THRESHOLD_SEC,
      minFrames: DEFAULT_MIN_FRAMES,
      onProgress: ({ id, attempt, attempts, result }) => {
        const detail = result.ok ? '' : ` [${result.stage}] ${result.error}`;
        console.error(`   ${id} ${attempt}/${attempts}: ${result.ok ? 'ok' : 'FAIL'}${detail}`);
      },
    });
  }

  const viaDocker = process.env.PB_DOCKER_PW === '1';
  const dockerCpus = Number(process.env.PB_DOCKER_CPUS);
  const file: ResultFile = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    envId,
    generatedAt: new Date().toISOString(),
    invokedVia: viaDocker ? 'docker:pw' : 'direct',
    args: [...argv],
    ...(viaDocker && dockerCpus > 0 ? { dockerCpus } : {}),
    host,
    media: { ffmpeg: media.ffmpegVersion, specHash: media.specHash, files: media.files },
    options: {
      attempts: options.attempts,
      freshProcess: options.freshProcess,
      timeoutMs: options.timeoutMs,
      thresholdSec: DEFAULT_THRESHOLD_SEC,
      minFrames: DEFAULT_MIN_FRAMES,
    },
    engines,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeResultFile(file));
  console.log(renderSummary(file));
  console.error(`wrote ${relative(ROOT, out)}`);
}

function render(): void {
  const files = readResultFiles(RESULTS_DIR);
  writeFileSync(MATRIX_DOC, renderMatrix(files));
  console.log(`wrote ${relative(ROOT, MATRIX_DOC)} from ${files.length} result file(s)`);
}

/** Exit status 1 when the committed document is not exactly what the committed results render to. */
function check(): number {
  const expected = renderMatrix(readResultFiles(RESULTS_DIR));
  const actual = existsSync(MATRIX_DOC) ? readFileSync(MATRIX_DOC, 'utf8') : null;
  if (actual === expected) {
    console.log('codec matrix ok: docs/CODEC_MATRIX.md is what the committed results render to');
    return 0;
  }
  console.error(
    'docs/CODEC_MATRIX.md is stale (or missing): run `npm run codec-matrix -- --render` and commit it',
  );
  return 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  switch (options.mode) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'render':
      render();
      return 0;
    case 'check':
      return check();
    case 'media-only': {
      const media = await ensureProbeMedia({ log: (message) => console.error(message) });
      console.log(
        `probe media ready: ${relative(ROOT, media.dir)} (recipe ${media.specHash.slice(0, 12)}, ffmpeg ${media.ffmpegVersion})`,
      );
      return 0;
    }
    case 'run':
      await probe(options, argv);
      return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
