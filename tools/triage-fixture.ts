import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import {
  LAB_ATTACHMENT,
  PROBLEMS_ATTACHMENT,
  looksLikeReport,
  resolveAttachmentPath,
} from '../triage/collect.ts';
import { containsSecret, STEPS } from '../triage/redact.ts';

// Reduces the Playwright output of a real run to a fixture small enough to commit and readable by a person. Run it with
// `npx tsx tools/triage-fixture.ts --from reports/playwright.json --out tests/fixtures/triage/<name>`. What stays is what triage reads:
// the tests that did not pass (with the title, tags, error and stack Playwright wrote), and for each the failure attachments of the lab
// (docs/CONTRACTS.md section 7.2) as files of their own, shortened when they are large. What goes is everything else: passed tests, traces,
// screenshots, videos, logs of the workers, the config of the machine, and the machine's own paths and names.
//
// The reduction is checked by what it must not change: `reduceReport` is tested to give the same failures, signatures and categories as the
// report it reduced (tests/unit/triage/fixture.test.ts), and the experiment that made the committed fixtures repeats that check on the real data
// (docs/results/triage/README.md).

export class FixtureError extends Error {}

export const DEFAULT_WORKSPACE = '/work/playback-proof';
export const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024;
const TEXT_LIMIT = 600;

export interface ReduceOptions {
  /** The checkout the report was written in, as its paths show it. Default: the parent of the report's `config.rootDir` (the `tests` directory). */
  repoRoot?: string;
  /** What that checkout is called in the fixture. */
  workspace?: string;
  /** The size above which an attachment that is a list is shortened (serialised, before formatting). */
  maxAttachmentBytes?: number;
  /** Where to look for attachments that Playwright kept as files (the directory of the report and its `test-results*` are always searched). */
  roots?: readonly string[];
}

export interface Reduction {
  /** The reduced report: the shape of Playwright's JSON report, whose attachments are files named in `files`. */
  report: unknown;
  /** Relative path (from the fixture directory) to the text of the file. */
  files: Record<string, string>;
  /** What was cut, one line each: a person reviewing the fixture reads these. */
  notes: string[];
  kept: {
    failed: number;
    flaky: number;
    skipped: number;
    runErrors: number;
    passedDropped: number;
    attachments: number;
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// ---------------------------------------------------------------------------------------------------------------------
// What goes in the fixture: the machine and the people are taken out, the lab's own addresses stay (they are the evidence)

// The same steps as the summarizer's redaction, minus the three that would rewrite what the lab itself says: the address and port of its
// service, and the path of the URLs it was asked for.
const KEPT_AS_IS = new Set(['url', 'ipv4', 'localhost']);
const SCRUB_STEPS = STEPS.filter((step) => !KEPT_AS_IS.has(step.name));

// What no fixture may still hold after the scrub: a person's home directory (the CI workspace of a runner was replaced by a step above).
const PERSONAL_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\'"`]+/;

function scrubber(repoRoots: readonly string[], workspace: string): (value: string) => string {
  // Longest first: a worktree inside the checkout is replaced whole.
  const roots = [...new Set(repoRoots)].filter((root) => root.length > 1).sort((a, b) => b.length - a.length);
  return (value) => {
    let out = value;
    for (const root of roots) out = out.split(root).join(workspace);
    return SCRUB_STEPS.reduce((acc, step) => step.apply(acc), out);
  };
}

function scrubValue<T extends Json>(value: T, scrub: (value: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub)) as T;
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubValue(item, scrub)]),
    ) as T;
  }
  return value;
}

/** Throws when the fixture still carries a secret or a person's path: a fixture that leaks is not written. */
export function assertClean(where: string, value: string): void {
  const secret = containsSecret(value);
  if (secret !== null)
    throw new FixtureError(`${where}: still matches the secret pattern "${secret}" after the scrub`);
  const path = PERSONAL_PATH.exec(value)?.[0];
  if (path !== undefined)
    throw new FixtureError(`${where}: still holds a personal path (${path}) after the scrub`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shortening a large attachment

// What each list is shortened around: the entries that explain a failure stay, with the first and the last few for context. Order is kept.
const BUDGETS = [
  { head: 5, tail: 20, interesting: 30 },
  { head: 3, tail: 10, interesting: 15 },
  { head: 2, tail: 4, interesting: 8 },
  { head: 0, tail: 2, interesting: 4 },
];

function interesting(kind: string, entry: Json): boolean {
  if (!isObject(entry)) return false;
  if (kind === 'qa-events') return entry.name === 'error';
  if (kind === 'request-log') {
    return (
      (typeof entry.status === 'number' && entry.status >= 400) ||
      entry.aborted === true ||
      (Array.isArray(entry.faults) && entry.faults.length > 0)
    );
  }
  if (kind === 'page-console') return entry.type === 'error' || entry.type === 'pageerror';
  return false;
}

const size = (value: Json): number => JSON.stringify(value).length;

function shorten(kind: string, entries: Json[], limit: number): Json[] {
  if (size(entries) <= limit) return entries;
  let chosen = entries;
  for (const budget of BUDGETS) {
    const hot = new Set<number>();
    entries.forEach((entry, index) => {
      if (hot.size < budget.interesting && interesting(kind, entry)) hot.add(index);
    });
    chosen = entries.filter(
      (_, index) => index < budget.head || index >= entries.length - budget.tail || hot.has(index),
    );
    if (size(chosen) <= limit) break;
  }
  return chosen;
}

/** Long strings of a document (a console line, a stack in an event) are cut: nothing the digests read is that long. */
function cutStrings(value: Json): Json {
  if (typeof value === 'string')
    return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}...` : value;
  if (Array.isArray(value)) return value.map(cutStrings);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v)]));
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The report

interface Context {
  scrub: (value: string) => string;
  maxBytes: number;
  roots: readonly string[];
  files: Record<string, string>;
  notes: string[];
  kept: Reduction['kept'];
  directories: Map<string, number>;
}

const failing = (result: Obj, expected: string): boolean => {
  const status = text(result.status);
  return status !== null && status !== expected && status !== 'skipped';
};

function attachmentText(attachment: Obj, roots: readonly string[]): string | null {
  const body = text(attachment.body);
  if (body !== null) return Buffer.from(body, 'base64').toString('utf8');
  const path = text(attachment.path);
  if (path === null) return null;
  const resolved = resolveAttachmentPath(path, roots);
  if (resolved === null) return null;
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

const labAttachment = (attachment: Obj): boolean => {
  const name = text(attachment.name) ?? '';
  return LAB_ATTACHMENT.test(name) || name === PROBLEMS_ATTACHMENT;
};

const slug = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function reduceAttachments(
  attachments: readonly Json[],
  label: string,
  context: Context,
): Array<{ name: string; contentType: string; path: string }> {
  const count = (context.directories.get(label) ?? 0) + 1;
  context.directories.set(label, count);
  const directory = `test-results/${String(context.directories.size).padStart(2, '0')}-${label}${count > 1 ? `-${count}` : ''}`;
  const out: Array<{ name: string; contentType: string; path: string }> = [];
  for (const raw of attachments) {
    if (!isObject(raw) || !labAttachment(raw)) continue;
    const name = text(raw.name) as string;
    const source = attachmentText(raw, context.roots);
    let value: Json;
    try {
      value = JSON.parse(source ?? '') as Json;
    } catch {
      context.notes.push(`${label}: ${name} could not be read as JSON and was left out`);
      continue;
    }
    const kind = name.replace(/(?:-\d+)?\.json$/, '');
    if (Array.isArray(value)) {
      const shorter = shorten(kind, value, context.maxBytes);
      if (shorter.length < value.length) {
        context.notes.push(`${label}: ${name} shortened from ${value.length} to ${shorter.length} entries`);
      }
      value = shorter;
    }
    value = scrubValue(cutStrings(value), context.scrub);
    const path = `${directory}/${name}`;
    const serialised = JSON.stringify(value, null, 2);
    assertClean(path, serialised);
    context.files[path] = `${serialised}\n`;
    context.kept.attachments += 1;
    out.push({ name, contentType: 'application/json', path });
  }
  return out;
}

function reduceTest(test: Obj, spec: Obj, titles: readonly string[], context: Context): Obj | null {
  const status = text(test.status);
  if (status !== 'unexpected' && status !== 'flaky' && status !== 'skipped') {
    context.kept.passedDropped += 1;
    return null;
  }
  if (status === 'flaky') context.kept.flaky += 1;
  else if (status === 'unexpected') context.kept.failed += 1;
  else context.kept.skipped += 1;

  const expected = text(test.expectedStatus) ?? 'passed';
  const project = text(test.projectName) ?? 'unknown';
  const results = list(test.results).filter(isObject);
  // The attachments of the first failing attempt that has any: the attempt triage reads. The others keep none.
  const chosen = results.findIndex(
    (result) =>
      failing(result, expected) && list(result.attachments).some((a) => isObject(a) && labAttachment(a)),
  );
  const label = slug(`${[...titles, text(spec.title) ?? ''].join(' ').slice(0, 60)}-${project}`);
  const reduced = results.map((result, index): Obj => {
    const error = isObject(result.error) ? result.error : null;
    return {
      status: text(result.status) ?? 'passed',
      duration: typeof result.duration === 'number' ? result.duration : 0,
      retry: typeof result.retry === 'number' ? result.retry : index,
      ...(text(result.startTime) === null ? {} : { startTime: text(result.startTime) }),
      ...(error === null
        ? {}
        : {
            error: {
              message: text(error.message) ?? '',
              ...(text(error.stack) ? { stack: text(error.stack) } : {}),
            },
          }),
      annotations: list(result.annotations)
        .filter(isObject)
        .map((a) => ({ type: a.type ?? '', description: a.description ?? '' })),
      attachments: index === chosen ? reduceAttachments(list(result.attachments), label, context) : [],
    };
  });
  return {
    projectName: project,
    expectedStatus: expected,
    status,
    annotations: list(test.annotations)
      .filter(isObject)
      .map((a) => ({ type: a.type ?? '', description: a.description ?? '' })),
    results: reduced,
  };
}

function reduceSuite(suite: Obj, titles: readonly string[], context: Context, isFile: boolean): Obj | null {
  const inside = isFile ? titles : [...titles, text(suite.title) ?? ''];
  const specs: Json[] = [];
  for (const spec of list(suite.specs).filter(isObject)) {
    const tests = list(spec.tests)
      .filter(isObject)
      .map((test) => reduceTest(test, spec, inside, context))
      .filter((test): test is Obj => test !== null);
    if (tests.length === 0) continue;
    specs.push({
      title: text(spec.title) ?? '',
      tags: list(spec.tags).filter((tag) => typeof tag === 'string'),
      file: text(spec.file) ?? '',
      line: typeof spec.line === 'number' ? spec.line : 0,
      tests,
    });
  }
  const suites = list(suite.suites)
    .filter(isObject)
    .map((child) => reduceSuite(child, inside, context, false))
    .filter((child): child is Obj => child !== null);
  if (specs.length === 0 && suites.length === 0) return null;
  return { title: text(suite.title) ?? '', specs, suites };
}

/** The failed, flaky and skipped tests of a Playwright JSON report, with their failure attachments as files, and the machine taken out. */
export function reduceReport(input: unknown, options: ReduceOptions = {}): Reduction {
  if (!looksLikeReport(input)) throw new FixtureError('not a Playwright JSON report (no config and suites)');
  const report = input as unknown as Obj;
  const config = isObject(report.config) ? report.config : {};
  const rootDir = text(config.rootDir);
  const derived = rootDir !== null && basename(rootDir) === 'tests' ? dirname(rootDir) : null;
  const repoRoot = options.repoRoot ?? derived;
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const context: Context = {
    scrub: scrubber(repoRoot === null ? [] : [repoRoot], workspace),
    maxBytes: options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    roots: options.roots ?? [],
    files: {},
    notes: [],
    kept: { failed: 0, flaky: 0, skipped: 0, runErrors: 0, passedDropped: 0, attachments: 0 },
    directories: new Map(),
  };
  const suites = list(report.suites)
    .filter(isObject)
    .map((suite) => reduceSuite(suite, [], context, true))
    .filter((suite): suite is Obj => suite !== null);
  const errors = list(report.errors)
    .filter(isObject)
    .map((error) => ({
      message: text(error.message) ?? '',
      ...(text(error.stack) ? { stack: text(error.stack) } : {}),
    }));
  context.kept.runErrors = errors.length;
  const stats = isObject(report.stats) ? report.stats : {};
  const reduced = scrubValue(
    {
      config: {
        rootDir: rootDir === null ? null : `${workspace}/tests`,
        projects: list(config.projects)
          .filter(isObject)
          .map((project) => ({
            name: text(project.name) ?? '',
            retries: typeof project.retries === 'number' ? project.retries : 0,
          })),
      },
      suites,
      errors,
      stats: {
        startTime: text(stats.startTime) ?? '',
        duration: typeof stats.duration === 'number' ? stats.duration : 0,
      },
    } as Json,
    context.scrub,
  );
  assertClean('playwright.json', JSON.stringify(reduced));
  return { report: reduced, files: context.files, notes: context.notes, kept: context.kept };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files

async function formatted(path: string, value: string): Promise<string> {
  const config = (await resolveConfig(path)) ?? {};
  return format(value, { ...config, parser: 'json' });
}

/** Writes the fixture into `outDir`, formatted the way the repository formats JSON (so that `format:check` accepts it). Returns the files written. */
export async function writeFixture(
  reduction: Reduction,
  outDir: string,
  options: { force?: boolean } = {},
): Promise<string[]> {
  const dir = resolve(outDir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    if (!options.force) throw new FixtureError(`${outDir} is not empty (--force replaces it)`);
    rmSync(dir, { recursive: true, force: true });
  }
  const written: string[] = [];
  const entries: Array<[string, string]> = [
    ['playwright.json', JSON.stringify(reduction.report)],
    ...Object.entries(reduction.files),
  ];
  for (const [name, content] of entries) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await formatted(path, content));
    written.push(name);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command

const USAGE = `usage: tsx tools/triage-fixture.ts --from <playwright.json> --out <dir> [--repo-root <dir>] [--max-attachment-bytes N] [--force]
  --from                   the Playwright JSON report of a real run (attachments it kept as files are looked for next to it, in its test-results*)
  --out                    the fixture directory to write (it must be empty unless --force)
  --repo-root              the checkout the report was written in, when it is not the parent of the report's rootDir
  --max-attachment-bytes   shorten the lists (events, request log, console) of a failure's attachments above this size (default ${DEFAULT_MAX_ATTACHMENT_BYTES})`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

const PROCESS_IO: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function main(argv: readonly string[], io: Io = PROCESS_IO): Promise<number> {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--force') force = true;
    else if (arg === '--help') {
      io.stdout(`${USAGE}\n`);
      return 0;
    } else if (['--from', '--out', '--repo-root', '--max-attachment-bytes'].includes(arg)) {
      const next = argv[index + 1];
      if (next === undefined) {
        io.stderr(`${arg} needs a value\n${USAGE}\n`);
        return 2;
      }
      values.set(arg, next);
      index += 1;
    } else {
      io.stderr(`unknown option ${arg}\n${USAGE}\n`);
      return 2;
    }
  }
  const from = values.get('--from');
  const out = values.get('--out');
  if (from === undefined || out === undefined) {
    io.stderr(`--from and --out are required\n${USAGE}\n`);
    return 2;
  }
  const limit = values.get('--max-attachment-bytes');
  if (limit !== undefined && !(Number.isInteger(Number(limit)) && Number(limit) > 0)) {
    io.stderr(`--max-attachment-bytes needs a positive whole number, not "${limit}"\n`);
    return 2;
  }
  try {
    const source = resolve(from);
    const report = JSON.parse(readFileSync(source, 'utf8')) as unknown;
    const reduction = reduceReport(report, {
      ...(values.has('--repo-root') ? { repoRoot: resolve(values.get('--repo-root') as string) } : {}),
      ...(limit === undefined ? {} : { maxAttachmentBytes: Number(limit) }),
      roots: [dirname(source), process.cwd()],
    });
    const written = await writeFixture(reduction, out, { force });
    const { kept } = reduction;
    io.stdout(
      `${out}: ${kept.failed} failed, ${kept.flaky} flaky, ${kept.skipped} skipped, ${kept.runErrors} run errors kept (${kept.passedDropped} passed left out), ${kept.attachments} attachments, ${written.length} files\n`,
    );
    for (const note of reduction.notes) io.stdout(`  ${note}\n`);
    return 0;
  } catch (error) {
    io.stderr(`triage-fixture: ${(error as Error).message}\n`);
    return error instanceof FixtureError ? 1 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
