// The generated tables of the readiness evidence (docs/decisions/readiness-evidence.md, ADR-159a to ADR-159e): the manifest of
// docs/results/readiness/README.md and the verdict, restoration, soak and margin tables of docs/READINESS.md. Every number in them is read from
// the committed result files and from the provenance next to them (docs/results/provenance); none is typed. The join is refused when it does
// not hold (a file that is not what the job uploaded, a name that is not the one its content gets): src/lab/readiness/evidence.ts.
//
//   npm run results:docs               check that every generated block is up to date (exit 1 otherwise)
//   npm run results:docs -- --write    rewrite the blocks first, then check
//
// docs:check (tools/check-docs.ts) does not know these blocks; tests/unit/readiness/evidence.test.ts keeps them fresh in the unit suite.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEvidence, renderEvidenceBlocks } from '../src/lab/readiness/evidence.ts';
import type { EvidenceBlock } from '../src/lab/readiness/evidence.ts';
import { checkBlockFresh, replaceBlock } from './doc-blocks.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export const RUNS_FILE = 'docs/results/provenance/runs.json';

export const TARGETS: ReadonlyArray<{ file: string; blocks: readonly EvidenceBlock[] }> = [
  { file: 'docs/results/readiness/README.md', blocks: ['EVIDENCE_MANIFEST'] },
  {
    file: 'docs/READINESS.md',
    blocks: [
      'READINESS_VERDICTS',
      'READINESS_RESTORE',
      'READINESS_SOAKS',
      'READINESS_MARGINS',
      'EXTRA_STALE_RECOVERY',
      'EXTRA_STALE_STALLS',
      'EXTRA_SOAKS',
      'EXTRA_VERDICTS',
      'EXTRA_RESTORE',
      'EXTRA_MARGINS',
    ],
  },
];

/** The blocks as they would be written now, from the files under `root`. Throws an `EvidenceError` when the provenance does not hold. */
export function renderFromDisk(root = ROOT): { blocks: Record<EvidenceBlock, string>; repository: string } {
  const { runs, entries } = buildEvidence({
    runs: readFileSync(resolve(root, RUNS_FILE), 'utf8'),
    result: (file) => readFileSync(resolve(root, file)),
    machine: (label) => readFileSync(resolve(root, `docs/results/provenance/machines/${label}.txt`), 'utf8'),
  });
  return { blocks: renderEvidenceBlocks(entries, runs.repository), repository: runs.repository };
}

/** What is out of date, one sentence each; with `write` the stale blocks are rewritten first and the list is what is still wrong. */
export function resultsDocsProblems(options: { root?: string; write?: boolean } = {}): string[] {
  const root = options.root ?? ROOT;
  const { blocks } = renderFromDisk(root);
  const problems: string[] = [];
  for (const target of TARGETS) {
    const path = resolve(root, target.file);
    let markdown = readFileSync(path, 'utf8');
    for (const name of target.blocks) {
      const body = blocks[name];
      if (options.write === true && !checkBlockFresh(markdown, name, body).fresh) {
        markdown = replaceBlock(markdown, name, body);
        writeFileSync(path, markdown);
      }
      const fresh = checkBlockFresh(markdown, name, body);
      if (!fresh.fresh) problems.push(`${target.file}: block ${name} is ${fresh.reason}`);
    }
  }
  return problems;
}

function main(): void {
  const write = process.argv.includes('--write');
  const problems = resultsDocsProblems({ write });
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\nresults:docs FAILED (${problems.length}); run npm run results:docs -- --write`);
    process.exit(1);
  }
  console.log(
    `results:docs ok (${TARGETS.reduce((n, t) => n + t.blocks.length, 0)} generated blocks up to date)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
