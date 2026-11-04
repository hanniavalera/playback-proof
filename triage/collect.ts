import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { idOf } from '../flake/reporter.ts';
import { parseRun, tierOfTags } from '../flake/run.ts';
import { digestDiagnostics, emptyDiagnostics } from './digest.ts';
import type { AttachmentSet } from './digest.ts';
import { applicationFrames, MAX_FRAMES } from './stack.ts';
import { oneLine, stripAnsi, truncate } from './text.ts';
import type {
  Annotation,
  Collection,
  DiagnosticsDigest,
  Failure,
  FailureOutcome,
  SkippedTest,
  SourceSummary,
} from './types.ts';

// The collector: Playwright's JSON report (`reports/playwright.json`, one per engine job in CI: `reports/<engine>/playwright.json`, or
// `reports-<engine>/playwright.json` once downloaded) and the failure attachments of docs/CONTRACTS.md section 7.2, read into `Failure`s.
// The JSON reporter keeps an attachment's body in the report itself (base64), so the report alone is enough; an attachment that was
// written to a file instead is looked for next to the report and in the `test-results` of the artifacts. A launch failure has no
// attachments at all, and nothing here throws on that: what is missing is said in `Failure.missing`.

export const MAX_MESSAGE_CHARS = 4000;
const MAX_REPORT_BYTES = 400 * 1024 * 1024;
const MAX_WALK_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', 'html', 'playwright-report']);
const MAX_ANNOTATION_CHARS = 400;

// ---------------------------------------------------------------------------------------------------------------------
// The slice of Playwright's JSON report that triage reads (docs: the JSONReport types of @playwright/test/reporter). Everything is optional:
// a report of another version, or half a report of a run that was killed, is read as far as it goes.

interface PwError {
  message?: string;
  stack?: string;
  value?: string;
}
interface PwAttachment {
  name?: string;
  contentType?: string;
  path?: string;
  body?: string;
}
interface PwResult {
  status?: string;
  duration?: number;
  error?: PwError;
  errors?: Array<{ message?: string }>;
  retry?: number;
  startTime?: string;
  attachments?: PwAttachment[];
  annotations?: Array<{ type?: string; description?: string }>;
}
interface PwTest {
  projectName?: string;
  annotations?: Array<{ type?: string; description?: string }>;
  expectedStatus?: string;
  results?: PwResult[];
  status?: string;
}
interface PwSpec {
  title?: string;
  tags?: string[];
  tests?: PwTest[];
  id?: string;
  file?: string;
  line?: number;
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PlaywrightReport {
  config?: { rootDir?: string; projects?: Array<{ name?: string; retries?: number }> };
  suites?: PwSuite[];
  errors?: PwError[];
  stats?: { startTime?: string; duration?: number };
}

export function looksLikeReport(value: unknown): value is PlaywrightReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return Array.isArray(report.suites) && typeof report.config === 'object' && report.config !== null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the files

const REPORT_NAME = /^playwright.*\.json$|\.playwright\.json$/;

function walk(dir: string, visit: (path: string, name: string) => void, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), visit, depth + 1);
    } else if (entry.isFile()) {
      visit(join(dir, entry.name), entry.name);
    }
  }
}

/** The Playwright JSON reports under `from` (or `from` itself when it is a file), sorted by path so that two runs read in the same order. */
export function findReports(from: string): string[] {
  let stat;
  try {
    stat = statSync(from);
  } catch {
    return [];
  }
  if (stat.isFile()) return [from];
  const found: string[] = [];
  walk(from, (path, name) => {
    if (REPORT_NAME.test(name)) found.push(path);
  });
  return found;
}

/** The flake run files (`reports/flake/**\/run*.json`) under `from`: they carry the environment id of each test. */
function readEnvIds(from: string): { byTest: Map<string, string>; only: string | null } {
  const byTest = new Map<string, string>();
  const ids = new Set<string>();
  if (!existsSync(from) || !statSync(from).isDirectory()) return { byTest, only: null };
  walk(from, (path, name) => {
    if (!/^run.*\.json$/.test(name) || !/(?:^|[\\/])flake[\\/]/.test(relative(from, path))) return;
    try {
      const run = parseRun(JSON.parse(readFileSync(path, 'utf8')), path);
      ids.add(run.envId);
      for (const test of run.tests) {
        if (!byTest.has(`${test.project}\u0000${test.id}`))
          byTest.set(`${test.project}\u0000${test.id}`, run.envId);
      }
    } catch {
      // A run file that does not parse is the flake gate's concern; the environment is then simply not known.
    }
  });
  return { byTest, only: ids.size === 1 ? ([...ids][0] ?? null) : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachments

const LAB_ATTACHMENT =
  /^(qa-events|qa-metrics|qa-info|page-console|session-detail|request-log)(?:-(\d+))?\.json$/;
const PROBLEMS_ATTACHMENT = 'diagnostics-problems.json';
const SET_KEYS = {
  'qa-events': 'events',
  'qa-metrics': 'metrics',
  'qa-info': 'info',
  'page-console': 'console',
  'session-detail': 'sessionDetail',
  'request-log': 'requestLog',
} as const;

/** Directories of the artifacts that hold what the tests wrote (`test-results`, `test-results-chromium`), for attachments kept as files. */
function testResultRoots(from: string): string[] {
  const roots = new Set<string>();
  for (const base of [from, dirname(from), process.cwd()]) {
    roots.add(base);
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^test-results/.test(entry.name)) roots.add(join(base, entry.name));
      }
    } catch {
      // A root that cannot be listed is not searched.
    }
  }
  return [...roots];
}

/** Where an attachment kept as a file is now: its recorded path (this machine), or the same path below `test-results` in the artifacts. */
export function resolveAttachmentPath(path: string, roots: readonly string[]): string | null {
  if (existsSync(path)) return path;
  const tail = /(?:^|[\\/])test-results[^\\/]*[\\/](.+)$/.exec(path)?.[1];
  if (tail === undefined) return null;
  for (const root of roots) {
    for (const candidate of [join(root, tail), join(root, 'test-results', tail)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

interface AttachmentReading {
  set: AttachmentSet;
  missing: string[];
}

function readAttachments(attachments: readonly PwAttachment[], roots: readonly string[]): AttachmentReading {
  const set: AttachmentSet = {
    events: [],
    metrics: [],
    info: [],
    console: [],
    sessionDetail: [],
    requestLog: [],
    problems: null,
    attached: [],
  };
  const missing: string[] = [];
  const present = new Set<string>();
  for (const attachment of attachments) {
    const name = attachment.name ?? '';
    const lab = LAB_ATTACHMENT.exec(name);
    if (!lab && name !== PROBLEMS_ATTACHMENT) continue;
    let text: string | null = null;
    if (typeof attachment.body === 'string') {
      text = Buffer.from(attachment.body, 'base64').toString('utf8');
    } else if (typeof attachment.path === 'string') {
      const path = resolveAttachmentPath(attachment.path, roots);
      if (path === null) {
        missing.push(`${name}: the file ${basename(attachment.path)} is not in the artifacts`);
        continue;
      }
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        missing.push(`${name}: could not be read (${(error as Error).message})`);
        continue;
      }
    }
    if (text === null) {
      missing.push(`${name}: the attachment has neither a body nor a path`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      missing.push(`${name}: is not valid JSON`);
      continue;
    }
    set.attached.push(name);
    if (name === PROBLEMS_ATTACHMENT) {
      set.problems = value;
      continue;
    }
    const key = SET_KEYS[lab?.[1] as keyof typeof SET_KEYS];
    const index = lab?.[2] === undefined ? 0 : Number(lab[2]) - 1;
    present.add(`${lab?.[1]}:${index}`);
    set[key][index] = value;
  }
  set.attached.sort();
  // A player with a timeline and no metrics, or a session with a log and no detail, means the fixture could not read it: say which.
  for (const [group, names] of [
    [
      set.events.length + set.metrics.length + set.info.length + set.console.length,
      ['qa-events', 'qa-metrics', 'qa-info', 'page-console'],
    ],
    [set.sessionDetail.length + set.requestLog.length, ['session-detail', 'request-log']],
  ] as const) {
    if (group === 0) continue;
    for (const name of names) {
      if (!present.has(`${name}:0`)) missing.push(`${name}.json: not attached`);
    }
  }
  return { set, missing };
}

// ---------------------------------------------------------------------------------------------------------------------
// One test

const toAnnotations = (
  ...lists: Array<ReadonlyArray<{ type?: string; description?: string }> | undefined>
): Annotation[] => {
  const seen = new Set<string>();
  const out: Annotation[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (typeof item.type !== 'string') continue;
      const annotation = {
        type: item.type,
        description: truncate(item.description ?? '', MAX_ANNOTATION_CHARS),
      };
      const key = `${annotation.type}\u0000${annotation.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(annotation);
    }
  }
  return out;
};

const failing = (result: PwResult, expected: string): boolean =>
  result.status !== undefined && result.status !== expected && result.status !== 'skipped';

function errorOf(result: PwResult): PwError {
  if (result.error && (result.error.message || result.error.stack || result.error.value)) return result.error;
  const formatted = result.errors?.find((error) => typeof error.message === 'string');
  return formatted ? { message: formatted.message ?? '' } : {};
}

/** The message of a TestError: its message, else the head of its stack (the lines before the first frame), else the thrown value. */
function messageOf(error: PwError): string {
  let text = error.message ?? '';
  if (text.trim() === '' && error.stack) {
    text = error.stack
      .split(/\r?\n/)
      .filter((line, index) => index === 0 || !/^\s+at /.test(line))
      .join('\n');
  }
  if (text.trim() === '' && error.value) text = error.value;
  return truncate(stripAnsi(text).trim(), MAX_MESSAGE_CHARS);
}

interface Context {
  source: string;
  rootDir: string | null;
  retries: Map<string, number>;
  roots: readonly string[];
  envIds: ReturnType<typeof readEnvIds>;
  quarantined: boolean;
}

/** The spec file as the repository writes it: Playwright's report keeps it relative to its test directory. */
function specFile(file: string | undefined, rootDir: string | null): string {
  if (!file) return '';
  const posix = file.replace(/\\/g, '/');
  const base = rootDir ? basename(rootDir) : '';
  return base === 'tests' && !posix.startsWith('tests/') ? `tests/${posix}` : posix;
}

function envIdOf(
  annotations: readonly Annotation[],
  context: Context,
  project: string,
  id: string,
): string | null {
  const known = context.envIds.byTest.get(`${project}\u0000${id}`);
  if (known) return known;
  const environment = annotations.find((annotation) => annotation.type === 'environment')?.description;
  const fromAnnotation = environment ? /^([\w.-]+):\s/.exec(environment)?.[1] : undefined;
  return fromAnnotation ?? context.envIds.only;
}

interface TestReading {
  failure?: Failure;
  skipped?: SkippedTest;
  interrupted?: boolean;
  passed?: boolean;
}

function readTest(suiteTitles: readonly string[], spec: PwSpec, test: PwTest, context: Context): TestReading {
  const results = test.results ?? [];
  const expected = test.expectedStatus ?? 'passed';
  const project = test.projectName ?? 'unknown';
  const title = [...suiteTitles, spec.title ?? ''].filter((part) => part !== '').join(' › ');
  const id = idOf(spec.title ?? '', suiteTitles);

  if (test.status === 'skipped') {
    const annotations = toAnnotations(test.annotations, ...results.map((result) => result.annotations));
    const reason = annotations.find(
      (a) => (a.type === 'skip' || a.type === 'fixme') && a.description.trim() !== '',
    );
    return { skipped: { id, project, reason: reason?.description.trim() ?? null, source: context.source } };
  }
  if (test.status === 'expected') return { passed: true };

  const firstFailing = results.findIndex((result) => failing(result, expected));
  const last = results[results.length - 1];
  if (test.status === 'unexpected' && (firstFailing < 0 || last?.status === 'interrupted')) {
    return { interrupted: true };
  }
  if (firstFailing < 0) return {};
  const outcome: FailureOutcome =
    test.status === 'flaky' ? 'flaky' : last?.status === 'timedOut' ? 'timedOut' : 'failed';

  // The attachments of the first failing attempt; when it has none and a later one has, the later one explains more than nothing.
  const readings = results
    .map((result, index) => ({ index, result }))
    .filter(({ result }) => failing(result, expected));
  let chosen = readings[0] as { index: number; result: PwResult };
  let reading = readAttachments(chosen.result.attachments ?? [], context.roots);
  const notes: string[] = [];
  if (reading.set.attached.length === 0) {
    for (const candidate of readings.slice(1)) {
      const next = readAttachments(candidate.result.attachments ?? [], context.roots);
      if (next.set.attached.length === 0) continue;
      notes.push(
        `the failure attachments are from attempt ${candidate.index + 1}: the first failing attempt had none`,
      );
      chosen = candidate;
      reading = next;
      break;
    }
  }
  const first = readings[0]?.result as PwResult;
  const error = errorOf(first);
  const diagnostics: DiagnosticsDigest =
    reading.set.attached.length > 0 ? digestDiagnostics(reading.set) : emptyDiagnostics();
  const missing = [...notes, ...reading.missing];
  if (reading.set.attached.length === 0 && reading.missing.length === 0) {
    missing.unshift(
      'no failure attachments: the test failed before the diagnostics fixture could read anything (a browser that did not launch, a setup that threw)',
    );
  }
  const annotations = toAnnotations(test.annotations, first.annotations, chosen.result.annotations);
  const tags = (spec.tags ?? []).map((tag) => `@${tag}`).sort();
  return {
    failure: {
      scope: 'test',
      id,
      title,
      file: specFile(spec.file, context.rootDir),
      line: typeof spec.line === 'number' ? spec.line : null,
      project,
      tags,
      tier: tierOfTags(tags),
      outcome,
      retries: context.retries.get(project) ?? 0,
      attempts: results.length,
      failedAttempts: readings.length,
      attempt: readings[0]?.index ?? 0,
      durationMs: Math.round(first.duration ?? 0),
      quarantined: context.quarantined,
      experimental: annotations.some((annotation) => annotation.type === 'experimental-engine'),
      annotations,
      envId: envIdOf(annotations, context, project, id),
      source: context.source,
      error: {
        message: messageOf(error),
        frames: applicationFrames(error.stack, { rootDir: context.rootDir, max: MAX_FRAMES }),
      },
      diagnostics,
      missing,
    },
  };
}

/** The top-level suites of a report are files (their title is the path); the suites inside them are `describe` blocks. */
function walkSuites(
  suites: readonly PwSuite[] | undefined,
  titles: readonly string[],
  visit: (titles: readonly string[], spec: PwSpec) => void,
  isFile = true,
): void {
  for (const suite of suites ?? []) {
    const inside = isFile ? titles : [...titles, suite.title ?? ''];
    for (const spec of suite.specs ?? []) visit(inside, spec);
    walkSuites(suite.suites, inside, visit, false);
  }
}

/** A failure of the run itself (a global setup that threw, a config that did not load): no test started, so no test is to blame. */
function runFailure(error: PwError, context: Context): Failure {
  return {
    scope: 'run',
    id: '(run)',
    title: '(run)',
    file: '',
    line: null,
    project: '(run)',
    tags: [],
    tier: null,
    outcome: 'failed',
    retries: 0,
    attempts: 0,
    failedAttempts: 0,
    attempt: 0,
    durationMs: 0,
    quarantined: false,
    experimental: false,
    annotations: [],
    envId: context.envIds.only,
    source: context.source,
    error: {
      message: messageOf(error),
      frames: applicationFrames(error.stack, { rootDir: context.rootDir, max: MAX_FRAMES }),
    },
    diagnostics: emptyDiagnostics(),
    missing: ['an error of the run, not of a test: there are no failure attachments'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A report, and a directory of them

export interface ReportReading {
  failures: Failure[];
  skipped: SkippedTest[];
  summary: SourceSummary;
}

/** The failures, the skips and the counts of one parsed report. `source` is how the report is named in what is printed. */
export function readReport(
  report: PlaywrightReport,
  options: {
    from: string;
    source: string;
    envIds?: ReturnType<typeof readEnvIds>;
    roots?: readonly string[];
  },
): ReportReading {
  const rootDir = report.config?.rootDir ?? null;
  const retries = new Map<string, number>();
  for (const project of report.config?.projects ?? []) {
    if (typeof project.name === 'string') retries.set(project.name, project.retries ?? 0);
  }
  const context: Context = {
    source: options.source,
    rootDir,
    retries,
    roots: options.roots ?? [options.from],
    envIds: options.envIds ?? { byTest: new Map(), only: null },
    quarantined: /(?:^|[\\/])quarantined[\\/]/.test(options.source),
  };
  const failures: Failure[] = [];
  const skipped: SkippedTest[] = [];
  const summary: SourceSummary = {
    path: options.source,
    tests: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    runErrors: (report.errors ?? []).length,
    startTime: report.stats?.startTime ?? null,
    durationMs: typeof report.stats?.duration === 'number' ? Math.round(report.stats.duration) : null,
  };
  walkSuites(report.suites, [], (titles, spec) => {
    for (const test of spec.tests ?? []) {
      summary.tests += 1;
      const reading = readTest(titles, spec, test, context);
      if (reading.failure) {
        failures.push(reading.failure);
        if (reading.failure.outcome === 'flaky') summary.flaky += 1;
        else summary.failed += 1;
      } else if (reading.skipped) {
        skipped.push(reading.skipped);
        summary.skipped += 1;
      } else if (reading.interrupted) {
        summary.interrupted += 1;
      } else if (reading.passed) {
        summary.passed += 1;
      }
    }
  });
  for (const error of report.errors ?? []) failures.push(runFailure(error, context));
  return { failures, skipped, summary };
}

export interface CollectOptions {
  /** Extra directories to look in for attachments that were kept as files. */
  roots?: readonly string[];
  /** What the directory is called in the problems that are reported (the path as the person gave it, not the absolute one). */
  label?: string;
}

/** The key of one execution of one test: the same report read twice (an artifact uploaded twice) counts once. */
function executionKey(failure: Failure, startTime: string | null): string {
  const run = failure.scope === 'run' ? failure.error.message : '';
  return [failure.project, failure.file, failure.title, failure.attempt, startTime ?? '', run].join('\u0000');
}

/**
 * Reads every Playwright JSON report under `from` (a directory of reports and artifacts, or one report file) into a `Collection`.
 * It never throws on what it finds: a file that is not a report, or cannot be parsed, is named in `problems` and the rest is read.
 */
export function collect(from: string, options: CollectOptions = {}): Collection {
  const absolute = resolve(from);
  const label = options.label ?? from;
  const base = existsSync(absolute) && statSync(absolute).isFile() ? dirname(absolute) : absolute;
  const result: Collection = { failures: [], skipped: [], sources: [], problems: [] };
  if (!existsSync(absolute)) {
    result.problems.push(`${label}: does not exist`);
    return result;
  }
  const files = findReports(absolute);
  if (files.length === 0) {
    result.problems.push(`${label}: no Playwright JSON report (playwright*.json) was found`);
    return result;
  }
  const envIds = readEnvIds(base);
  const roots = [...testResultRoots(base), ...(options.roots ?? [])];
  const seen = new Set<string>();
  for (const file of files) {
    const source = relative(base, file) || basename(file);
    let report: unknown;
    try {
      if (statSync(file).size > MAX_REPORT_BYTES) {
        result.problems.push(`${source}: larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB, not read`);
        continue;
      }
      report = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      result.problems.push(`${source}: could not be read (${oneLine((error as Error).message, 200)})`);
      continue;
    }
    if (!looksLikeReport(report)) {
      result.problems.push(`${source}: is not a Playwright JSON report (no config and suites), skipped`);
      continue;
    }
    const reading = readReport(report, { from: base, source, envIds, roots });
    const startTime = reading.summary.startTime;
    for (const failure of reading.failures) {
      const key = executionKey(failure, startTime);
      if (seen.has(key)) continue;
      seen.add(key);
      result.failures.push(failure);
    }
    result.skipped.push(...reading.skipped);
    result.sources.push(reading.summary);
  }
  return result;
}
