// Documentation integrity checks (`npm run docs:check`, part of the static gate).
//
//  1. every relative link in a Markdown file points at a file that exists;
//  2. TEST_STRATEGY.md is internally true (checkStrategyDocument): the test catalog parses strictly, every tier follows the
//     tiering rule, the risk ranking agrees with the catalog, the merge tier fits its time budget, every generated block
//     (the policy tables rendered from src/shared) is up to date, and every test id cited anywhere in the documentation exists;
//  3. more checks are added by the phases that own the documents (the test catalog against the specs, the README result
//     tables against the committed result artifacts). Each check is a function below returning a list of problems.
//
//   npm run docs:check                 check everything
//   npm run docs:check -- --write      rewrite the generated blocks of TEST_STRATEGY.md first (then check)
//   npm run docs:check -- --print      print the generated blocks without writing anything
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CatalogError,
  checkBudgets,
  checkCatalogPolicy,
  checkIdCitations,
  checkRiskRanking,
  parseCatalog,
  readRiskRanking,
} from './catalog.ts';
import type { CatalogRow } from './catalog.ts';
import { checkBlockFresh, locateBlock, replaceBlock } from './doc-blocks.ts';
import {
  renderAreaLegend,
  renderFaultProfiles,
  renderFlakePolicy,
  renderGateBudgets,
  renderLiveCriteria,
  renderMergeBudget,
  renderPerfPolicy,
  renderRiskTiers,
} from './policy-tables.ts';

export { blockBody, blockMarkers, checkBlockFresh, locateBlock, replaceBlock } from './doc-blocks.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const STRATEGY_FILE = 'TEST_STRATEGY.md';
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'reports',
  'test-results',
  '.cache',
  'playwright-report',
  '.tmp',
  '.jenkins-home',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function checkRelativeLinks(files: string[]): string[] {
  const problems: string[] = [];
  const link = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(link)) {
      const target = (m[1] ?? '').split('#')[0] ?? '';
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = target.startsWith('/') ? join(ROOT, target) : resolve(dirname(file), target);
      if (!existsSync(resolved)) problems.push(`${relative(ROOT, file)}: broken link -> ${m[1]}`);
    }
  }
  return problems;
}

export interface GeneratedBlock {
  name: string;
  render: () => string;
}

/**
 * The generated blocks of TEST_STRATEGY.md. MERGE_BUDGET needs the parsed catalog, so it exists only when the catalog parses
 * (a malformed catalog is reported on its own).
 */
export function strategyBlocks(rows?: readonly CatalogRow[]): GeneratedBlock[] {
  const blocks: GeneratedBlock[] = [
    { name: 'RISK_TIERS', render: renderRiskTiers },
    { name: 'AREA_LEGEND', render: renderAreaLegend },
    { name: 'GATE_BUDGETS', render: renderGateBudgets },
    { name: 'PERF_POLICY', render: renderPerfPolicy },
    { name: 'FLAKE_POLICY', render: renderFlakePolicy },
    { name: 'LIVE_CRITERIA', render: renderLiveCriteria },
    { name: 'FAULT_PROFILES', render: renderFaultProfiles },
  ];
  if (rows) blocks.push({ name: 'MERGE_BUDGET', render: () => renderMergeBudget(rows) });
  return blocks;
}

/** One problem per generated block that is missing or out of date. */
export function checkGeneratedBlocks(markdown: string, blocks: readonly GeneratedBlock[]): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const result = checkBlockFresh(markdown, block.name, block.render());
    if (result.fresh) continue;
    problems.push(
      result.reason.startsWith('out of date')
        ? `generated block ${block.name} is ${result.reason}; run \`npm run docs:check -- --write\``
        : `generated block ${block.name}: ${result.reason}`,
    );
  }
  return problems;
}

/** The document with every generated block replaced by its fresh rendering; blocks whose markers are missing are skipped. */
export function writeGeneratedBlocks(markdown: string, blocks: readonly GeneratedBlock[]): string {
  let out = markdown;
  for (const block of blocks) {
    if (locateBlock(out, block.name).found) out = replaceBlock(out, block.name, block.render());
  }
  return out;
}

/** Rewrites the generated blocks of a document on disk. Returns whether the file changed (a fresh document is left untouched). */
export function writeGeneratedBlocksToFile(path: string, blocks: readonly GeneratedBlock[]): boolean {
  const before = readFileSync(path, 'utf8');
  const after = writeGeneratedBlocks(before, blocks);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

function parseCatalogOrProblems(markdown: string): { rows: CatalogRow[]; problems: string[] } {
  try {
    return { rows: parseCatalog(markdown), problems: [] };
  } catch (error) {
    if (error instanceof CatalogError) return { rows: [], problems: error.problems };
    throw error;
  }
}

/**
 * Everything that must be true of TEST_STRATEGY.md on its own: the catalog parses and follows the tiering rule, the risk ranking
 * agrees with it, the merge tier fits its time budget, the ids it cites exist, and the generated blocks are fresh.
 */
export function checkStrategyDocument(markdown: string): { problems: string[]; rows: CatalogRow[] } {
  const { rows, problems } = parseCatalogOrProblems(markdown);
  if (rows.length > 0) {
    problems.push(...checkCatalogPolicy(rows), ...checkBudgets(rows));
    const ranking = readRiskRanking(markdown);
    problems.push(...ranking.problems);
    if (ranking.problems.length === 0) problems.push(...checkRiskRanking(ranking.areas, rows));
    problems.push(...checkIdCitations(markdown, rows));
  }
  problems.push(...checkGeneratedBlocks(markdown, strategyBlocks(rows.length > 0 ? rows : undefined)));
  return { problems, rows };
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const files = walk(ROOT);
  const problems = [...checkRelativeLinks(files)];
  const notes: string[] = [];
  let rows: CatalogRow[] = [];

  const strategyPath = join(ROOT, STRATEGY_FILE);
  if (!existsSync(strategyPath)) {
    problems.push(`${STRATEGY_FILE}: the file is missing`);
  } else {
    let markdown = readFileSync(strategyPath, 'utf8');
    const parsed = parseCatalogOrProblems(markdown);
    const blocks = strategyBlocks(parsed.rows.length > 0 ? parsed.rows : undefined);
    if (args.has('--print')) {
      // `--print` shows every generated block; `--print NAME...` only the named ones.
      const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
      for (const block of blocks.filter((b) => wanted.length === 0 || wanted.includes(b.name))) {
        console.log(`${block.render()}\n`);
      }
      return;
    }
    if (args.has('--write') && writeGeneratedBlocksToFile(strategyPath, blocks)) {
      markdown = readFileSync(strategyPath, 'utf8');
      notes.push(`rewrote the generated blocks of ${STRATEGY_FILE}`);
    }
    const checked = checkStrategyDocument(markdown);
    rows = checked.rows;
    problems.push(...checked.problems.map((p) => `${STRATEGY_FILE}: ${p}`));
  }

  // A test id mentioned in any other document must exist too: ids are a contract.
  if (rows.length > 0) {
    for (const file of files) {
      if (resolve(file) === strategyPath) continue;
      for (const p of checkIdCitations(readFileSync(file, 'utf8'), rows))
        problems.push(`${relative(ROOT, file)}: ${p}`);
    }
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\ndocs:check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  const detail = rows.length > 0 ? `, ${rows.length} catalog rows, generated blocks up to date` : '';
  console.log(
    `docs:check ok (${files.length} markdown files${detail})${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
