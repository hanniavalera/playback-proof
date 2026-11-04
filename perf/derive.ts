// `npx tsx perf/derive.ts [--baseline-dir perf/baselines] [--out-dir docs/results/perf]`
//
// Derives what the thresholds have to be from the baselines on disk (src/lab/measure/derive.ts has the method) and writes
// <out-dir>/threshold-derivation.json and .md: the variation of every metric, what each rule needs, what the baselines show for the
// metrics judged by a budget, and how the committed PERF_POLICY sits above the noise.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseBaseline } from '../src/lab/measure/baseline.ts';
import type { Baseline } from '../src/lab/measure/baseline.ts';
import { deriveFrom, renderDerivationMarkdown } from '../src/lab/measure/derive.ts';

const root = new URL('..', import.meta.url).pathname;

function baselineFiles(dir: string): string[] {
  const files: string[] = [];
  for (const environment of readdirSync(dir).sort()) {
    const environmentDir = join(dir, environment);
    if (!statSync(environmentDir).isDirectory()) continue;
    for (const file of readdirSync(environmentDir).sort())
      if (file.endsWith('.json')) files.push(join(environmentDir, file));
  }
  return files;
}

function main(argv: string[]): number {
  let baselineDir = join(root, 'perf/baselines');
  let outDir = join(root, 'docs/results/perf');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--baseline-dir') baselineDir = join(process.cwd(), argv[(i += 1)] ?? '');
    else if (arg === '--out-dir') outDir = join(process.cwd(), argv[(i += 1)] ?? '');
    else {
      console.error(
        `unknown option ${arg}\nusage: npx tsx perf/derive.ts [--baseline-dir DIR] [--out-dir DIR]`,
      );
      return 2;
    }
  }
  const files: Array<{ file: string; baseline: Baseline }> = baselineFiles(baselineDir).map((file) => ({
    file: relative(root, file),
    baseline: parseBaseline(readFileSync(file, 'utf8'), file),
  }));
  if (files.length === 0) {
    console.error(`no baseline under ${baselineDir}`);
    return 2;
  }
  const derivation = deriveFrom(files, new Date().toISOString());
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'threshold-derivation.json'), `${JSON.stringify(derivation, null, 2)}\n`);
  writeFileSync(join(outDir, 'threshold-derivation.md'), renderDerivationMarkdown(derivation));
  for (const need of derivation.needs) {
    console.log(
      `${need.rule.padEnd(14)} ${need.gatedPairs} gated, ${need.trackedPairs} tracked: noise share median ${(need.share.median * 100).toFixed(1)} %, tail ${(need.share.tail * 100).toFixed(1)} %; noise median ${need.absolute.median.toPrecision(3)}, tail ${need.absolute.tail.toPrecision(3)}; suggested ${(need.suggested.medianShare * 100).toFixed(0)} % / ${(need.suggested.tailShare * 100).toFixed(0)} % / floor ${need.suggested.floor}`,
    );
  }
  console.log(`wrote ${join(outDir, 'threshold-derivation.json')} and .md`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
