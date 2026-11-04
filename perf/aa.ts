// `npx tsx perf/aa.ts [--out-dir docs/results/perf] <gate-report.json>...`
//
// Summarizes an A/A check: the reports that `npm run perf:gate` wrote when it was run several times against its own baseline, with
// nothing changed. Writes <out-dir>/<envId>/<profile>-aa.json and .md and prints the headline: the false-positive count.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderAaMarkdown, summarizeAa } from '../src/lab/measure/aa.ts';
import type { GateReport } from '../src/lab/measure/report.ts';

const root = new URL('..', import.meta.url).pathname;

function main(argv: string[]): number {
  let outDir = join(root, 'docs/results/perf');
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out-dir') outDir = join(process.cwd(), argv[(i += 1)] ?? '');
    else if (arg.startsWith('--')) {
      console.error(`unknown option ${arg}\nusage: npx tsx perf/aa.ts [--out-dir DIR] <gate-report.json>...`);
      return 2;
    } else files.push(arg);
  }
  if (files.length === 0) {
    console.error('usage: npx tsx perf/aa.ts [--out-dir DIR] <gate-report.json>...');
    return 2;
  }

  const reports = files.map((file) => ({
    file: relative(root, join(process.cwd(), file)),
    report: JSON.parse(readFileSync(file, 'utf8')) as GateReport,
  }));
  let summary;
  try {
    summary = summarizeAa(reports);
  } catch (error) {
    console.error(`PROBLEM: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  mkdirSync(join(outDir, summary.envId), { recursive: true });
  const base = join(outDir, summary.envId, `${summary.profile}-aa`);
  writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderAaMarkdown(summary));
  console.log(
    `A/A ${summary.profile} in ${summary.envId}: ${summary.passes} passes, ${summary.falsePositives} false positives (exit codes: 0 x ${summary.exitCodes['0']}, 1 x ${summary.exitCodes['1']}, 2 x ${summary.exitCodes['2']}), ${summary.firstBatchAlarms} first-batch alarms of which ${summary.notReproduced} did not reproduce\nwrote ${base}.json and .md`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
