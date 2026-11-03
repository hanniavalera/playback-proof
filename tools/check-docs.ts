// Documentation integrity checks (`npm run docs:check`, part of the static gate).
//
//  1. every relative link in a Markdown file points at a file that exists;
//  2. more checks are added by the phases that own the documents (the test catalog against the specs, the README result
//     tables against the committed result artifacts). Each check is a function below returning a list of problems.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
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

function main(): void {
  const files = walk(ROOT);
  const problems = [...checkRelativeLinks(files)];
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\ndocs:check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
    process.exit(1);
  }
  console.log(`docs:check ok (${files.length} markdown files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
