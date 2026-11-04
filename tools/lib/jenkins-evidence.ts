// Evidence of a Jenkins build: what tools/jenkins-evidence.ts reads from the controller, turned into one compact record without
// secrets (docs/results/jenkins/build-<n>.json) and an excerpt of the console log. Everything here is a pure function of the data the
// REST API returned, so that it is tested without a controller (tests/unit/jenkins/evidence.test.ts). docs/decisions/ci-jenkins.md.

import { stripVTControlCharacters } from 'node:util';

export const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The text with every given secret value removed, and every credential-shaped string too (a basic or bearer authorization header,
 * a crumb, the hex secret that follows `-secret`, the userinfo of a URL). The values are the ones this process knows (the admin
 * password); the shapes catch what it cannot know (a token a build printed). An empty value is skipped: it would match everywhere.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/(jenkins-crumb:\s*)\S+/gi, `$1${REDACTED}`)
    .replace(/(-secret\s+)[0-9a-f]{16,}/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The console log
// ---------------------------------------------------------------------------------------------------------------------------------

// The timestamps plugin puts `[2026-11-04T04:41:35.738Z] ` in front of every line of the log it saw.
const TIMESTAMP = /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] ?/;

export const stripTimestamp = (line: string): string => line.replace(TIMESTAMP, '');
export const stripAnsi = (text: string): string => stripVTControlCharacters(text);

// What an excerpt keeps: where the build started and ran, the stage markers, the tools, the result of each gate (the summary lines
// the scripts and the test runners print), and everything that says something failed. The rest is progress output.
const KEPT: readonly RegExp[] = [
  /^Started by /,
  /^Obtained Jenkinsfile from /,
  /^Running on /,
  /^Checking out Revision /,
  /^\[Pipeline\] \{ \((?!Branch: )/,
  /^tool-version /,
  /^added \d+ packages/,
  /^All matched files use Prettier code style/,
  /^docs:check ok/,
  /^codec matrix ok/,
  /^\s*(Test Files|Tests|Start at|Duration)\s+\d/,
  /^stream\s+status\s/,
  /^(vod|live)-[a-z0-9-]+\s+(generated|cached|regenerated)\s/,
  /^total: \d+ files/,
  /^\s+(✓|✘|-)\s+\d+ \[/,
  /^\s+\d+ (passed|failed|flaky|skipped|did not run)\b/,
  /^\s+\d+\) \[/,
  /^\s*(Error|AssertionError|Expected|Received|TimeoutError)\b/,
  /^\s*(FAIL|×)\s/,
  /^Archiving artifacts/,
  /^Stage ".+" skipped due to earlier failure/,
  /^Failed in branch /,
  /^ERROR: /,
  /^script returned exit code/,
  /^Finished: /,
];

export interface Excerpt {
  text: string;
  kept: number;
  omitted: number;
}

/** A gap shorter than this is not marked: a marker for every two lines of progress output would be most of the excerpt. */
const MARKED_GAP = 4;

/**
 * The lines of a console log that show what ran and how each gate ended, in order, with a marker where a long stretch was left
 * out. A line is compared without its timestamp and the colour codes, and kept as it is. The log is redacted before it gets here.
 * `omitted` counts every line left out, marked or not.
 */
export function excerptConsole(log: string): Excerpt {
  const out: string[] = [];
  let omitted = 0;
  let gap = 0;
  const closeGap = (): void => {
    if (gap >= MARKED_GAP) out.push(`[... ${gap} lines left out ...]`);
    omitted += gap;
    gap = 0;
  };
  for (const line of log.split('\n')) {
    const plain = stripAnsi(stripTimestamp(line));
    if (KEPT.some((pattern) => pattern.test(plain))) {
      closeGap();
      out.push(stripAnsi(line).replace(/\s+$/, ''));
    } else if (plain.trim() !== '') {
      gap++;
    }
  }
  closeGap();
  return { text: `${out.join('\n')}\n`, kept: out.filter((l) => !l.startsWith('[... ')).length, omitted };
}

/**
 * The tools the Install stage printed as `tool-version <name> <what the tool said>`: node, npm, ffmpeg, java and playwright. Only
 * what the log says is returned (a tool that did not print, or printed something unrecognizable, is absent, not guessed).
 */
export function parseToolVersions(log: string): Record<string, string> {
  const shapes: Record<string, RegExp> = {
    node: /^v?(\d+\.\d+\.\d+\S*)$/,
    npm: /^(\d+\.\d+\.\d+\S*)$/,
    ffmpeg: /^ffmpeg version (\S+)/,
    java: /^\S+ version "([^"]+)"/,
    playwright: /^Version (\S+)/,
  };
  const found: Record<string, string> = {};
  for (const raw of log.split('\n')) {
    const match = /^tool-version (\S+) (.*)$/.exec(stripAnsi(stripTimestamp(raw)).trim());
    const name = match?.[1];
    const said = match?.[2]?.trim();
    const shape = name === undefined ? undefined : shapes[name];
    if (name === undefined || said === undefined || shape === undefined) continue;
    const version = shape.exec(said)?.[1];
    if (version !== undefined) found[name] = name === 'node' ? `v${version}` : version;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The stages (wfapi)
// ---------------------------------------------------------------------------------------------------------------------------------

/** One entry of `stages` in `/job/<job>/<n>/wfapi/describe`. */
export interface RawStage {
  id: string;
  name: string;
  /** SUCCESS, FAILED, ABORTED, UNSTABLE, NOT_EXECUTED, IN_PROGRESS... */
  status: string;
  startTimeMillis: number;
  durationMillis: number;
  error?: { message?: string; type?: string };
}

/** What `/job/<job>/<n>/execution/node/<id>/wfapi/describe` says about the steps a stage ran itself. */
export interface StageSteps {
  stepCount: number;
  /** When the first step started (epoch ms): the gap after the stage's own start is the wait for an executor. */
  firstStepStartMillis: number | null;
}

export interface EvidenceStage {
  name: string;
  /** The stage this one is nested in, or null (a stage that only groups other stages has null here, and no steps of its own). */
  group: string | null;
  status: string;
  /** Milliseconds from the start of the build to the start of the stage. */
  startMs: number;
  /** What the stage view shows: for a stage with an agent it includes the wait for an executor. For a group, the wall-clock of its stages. */
  durationMs: number;
  /** Time spent waiting for an executor before the first step (0 for a group). */
  waitedMs: number;
  error?: string;
}

const SEVERITY = ['FAILED', 'ABORTED', 'UNSTABLE', 'IN_PROGRESS', 'SUCCESS', 'NOT_EXECUTED'];

/** The worst status of a list (the one Jenkins would put on a group if it did not report the group's own steps). */
export function worstStatus(statuses: readonly string[]): string {
  const ranks = statuses.map((s) => {
    const rank = SEVERITY.indexOf(s);
    return rank === -1 ? 0 : rank;
  });
  return SEVERITY[Math.min(...ranks)] ?? 'NOT_EXECUTED';
}

/**
 * The stages Jenkins skipped because an earlier one failed. The stage view reports such a stage as FAILED with the error of the
 * stage that really failed, which would make every skipped stage look like a second failure; the console says what happened:
 * `Stage "Streams" skipped due to earlier failure(s)`.
 */
export function parseSkippedStages(log: string): Set<string> {
  const skipped = new Set<string>();
  for (const raw of log.split('\n')) {
    const name = /^Stage "(.+)" skipped due to earlier failure\(s\)/.exec(
      stripAnsi(stripTimestamp(raw)),
    )?.[1];
    if (name !== undefined) skipped.add(name);
  }
  return skipped;
}

/**
 * The stages of a build as the evidence lists them. The stage view reports a stage that only groups others (`Checks`, `Merge gate`)
 * with its own milliseconds and its own status, so a red branch inside `Merge gate` leaves `Merge gate` green there; here a group
 * takes the worst status of its stages and the wall-clock from the first of them to the end of the last. A group is a stage that ran
 * no step itself; the stages after it, up to the next group, belong to it. A stage that was skipped belongs to no group and
 * is not a group (the stage view gives it a step of its own, and the status and the error of the stage that really failed).
 */
export function groupStages(
  stages: readonly RawStage[],
  steps: ReadonlyMap<string, StageSteps>,
  buildStartMs: number,
  skipped: ReadonlySet<string> = new Set(),
): EvidenceStage[] {
  const out: EvidenceStage[] = [];
  let group: string | null = null;
  for (const stage of stages) {
    const own = steps.get(stage.id);
    // A skipped stage runs a step of its own (it only resolves its context) and waited for nothing: it belongs to no group.
    const wasSkipped = skipped.has(stage.name);
    const isGroup = !wasSkipped && own !== undefined && own.stepCount === 0;
    const waitedMs =
      !isGroup && !wasSkipped && own?.firstStepStartMillis != null
        ? Math.max(0, own.firstStepStartMillis - stage.startTimeMillis)
        : 0;
    const entry: EvidenceStage = {
      name: stage.name,
      group: isGroup || wasSkipped ? null : group,
      status: wasSkipped ? 'NOT_EXECUTED' : stage.status,
      startMs: Math.max(0, stage.startTimeMillis - buildStartMs),
      durationMs: stage.durationMillis,
      waitedMs,
    };
    const message = stage.error?.message;
    if (message && !wasSkipped) entry.error = message;
    out.push(entry);
    if (isGroup) group = stage.name;
  }
  for (const parent of out.filter((s) => out.some((c) => c.group === s.name))) {
    const children = out.filter((c) => c.group === parent.name);
    const start = Math.min(parent.startMs, ...children.map((c) => c.startMs));
    const end = Math.max(...children.map((c) => c.startMs + c.durationMs));
    parent.status = worstStatus(children.map((c) => c.status));
    parent.startMs = start;
    parent.durationMs = end - start;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Playwright reports (reports/<project>/playwright.json, archived by the branch of each engine)
// ---------------------------------------------------------------------------------------------------------------------------------

interface PwAttachment {
  name?: string;
}
interface PwResult {
  duration?: number;
  error?: { message?: string };
  attachments?: PwAttachment[];
}
interface PwTest {
  projectName?: string;
  status?: string;
  annotations?: { type?: string; description?: string }[];
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  tests?: PwTest[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  stats?: { duration?: number };
}

export type TestStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface TestOutcome {
  id: string;
  status: TestStatus;
  /** Wall-clock of the attempts together, in milliseconds. */
  durationMs: number;
  /** Present when the test was run more than once (a retry). */
  attempts?: number;
  /** The first line of the failure, without colour codes. */
  error?: string;
  /** The names of the files attached to the failure (docs/CONTRACTS.md 7.2). */
  attachments?: string[];
}

export interface ProjectSummary {
  project: string;
  tests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** Wall-clock of the whole `playwright test` run (the report's own figure). */
  runDurationMs: number | null;
  /** The `environment` annotation PB-ENV-001 leaves: the environment id, the engine and its version, and what the evidence is. */
  environment: string | null;
  results: TestOutcome[];
}

const STATUS: Record<string, TestStatus> = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

function collectSpecs(suites: readonly PwSuite[] | undefined, out: PwSpec[] = []): PwSpec[] {
  for (const suite of suites ?? []) {
    out.push(...(suite.specs ?? []));
    collectSpecs(suite.suites, out);
  }
  return out;
}

/** What the Playwright JSON reporter wrote, by project. A report that is not what the reporter writes yields nothing. */
export function summarizePlaywright(report: unknown): ProjectSummary[] {
  const parsed = (report ?? {}) as PwReport;
  const byProject = new Map<string, ProjectSummary>();
  for (const spec of collectSpecs(parsed.suites)) {
    for (const test of spec.tests ?? []) {
      const project = test.projectName ?? 'unknown';
      let summary = byProject.get(project);
      if (!summary) {
        summary = {
          project,
          tests: 0,
          passed: 0,
          failed: 0,
          flaky: 0,
          skipped: 0,
          runDurationMs: parsed.stats?.duration === undefined ? null : Math.round(parsed.stats.duration),
          environment: null,
          results: [],
        };
        byProject.set(project, summary);
      }
      const status = STATUS[test.status ?? ''] ?? 'failed';
      const title = spec.title ?? '';
      const attempts = test.results ?? [];
      const outcome: TestOutcome = {
        id: /^PB-[A-Z]+-\d+/.exec(title)?.[0] ?? title,
        status,
        durationMs: Math.round(attempts.reduce((sum, r) => sum + (r.duration ?? 0), 0)),
      };
      if (attempts.length > 1) outcome.attempts = attempts.length;
      if (status === 'failed' || status === 'flaky') {
        const message = attempts.map((r) => r.error?.message).find((m) => m !== undefined);
        const firstLine = stripAnsi(message ?? '')
          .split('\n')
          .find((l) => l.trim() !== '');
        if (firstLine) outcome.error = firstLine.trim().slice(0, 240);
        const names = [
          ...new Set(
            attempts.flatMap((r) => (r.attachments ?? []).map((a) => a.name).filter((n) => n !== undefined)),
          ),
        ];
        if (names.length > 0) outcome.attachments = names;
      }
      summary.tests++;
      summary[status]++;
      summary.results.push(outcome);
      const environment = test.annotations?.find((a) => a.type === 'environment')?.description;
      if (environment && summary.environment === null) summary.environment = environment;
    }
  }
  return [...byProject.values()];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ArtifactSummary {
  /** Everything the build archived. */
  count: number;
  /** The reports of the engines: the JSON of each run and the entry page of its HTML report. */
  reports: string[];
  /** The files Playwright kept for a failing test, by test directory (the failure attachments of docs/CONTRACTS.md 7.2). */
  failureFiles: Record<string, string[]>;
}

/** What a build archived, cut down to what is evidence: the reports, and the directories of the tests that left files. */
export function summarizeArtifacts(paths: readonly string[]): ArtifactSummary {
  const failureFiles: Record<string, string[]> = {};
  for (const path of paths) {
    const match = /^(test-results\/[^/]+)\/(.+)$/.exec(path);
    if (match?.[1] !== undefined && match[2] !== undefined) (failureFiles[match[1]] ??= []).push(match[2]);
  }
  return {
    count: paths.length,
    reports: paths.filter((p) => /^reports\/[^/]+\/(playwright\.json|html\/index\.html)$/.test(p)),
    failureFiles,
  };
}

export interface EvidenceInput {
  job: string;
  build: number;
  /** One line that says what this run is for. */
  label: string;
  /** What the run is meant to show: a green build, or a red one (the negative run). */
  expected: 'SUCCESS' | 'FAILURE';
  result: string;
  startedAtMs: number;
  durationMs: number;
  queuedMs: number;
  commit: string | null;
  branch: string | null;
  jenkinsVersion: string | null;
  /** Executors on the controller (the lab keeps this at 0). */
  controllerExecutors: number;
  plugins: Record<string, string>;
  agents: { name: string; executors: number; labels: string[] }[];
  tools: Record<string, string>;
  stages: EvidenceStage[];
  playwright: ProjectSummary[];
  artifacts: string[];
}

export interface Evidence {
  schemaVersion: 1;
  job: string;
  build: number;
  label: string;
  result: string;
  expected: string;
  /** Whether the result is the one the run was meant to show. */
  asExpected: boolean;
  startedAt: string;
  durationMs: number;
  queuedMs: number;
  commit: string | null;
  branch: string | null;
  jenkins: {
    version: string | null;
    executorsOnController: number;
    pluginCount: number;
    /** `name:version`, sorted: the format of jenkins/controller/plugins.txt, so that the two can be compared. */
    plugins: string[];
  };
  agents: { name: string; executors: number; labels: string[] }[];
  tools: Record<string, string>;
  stages: EvidenceStage[];
  /** The merge gate: how long its engines took together against what they would take one after the other. */
  mergeGate: { wallClockMs: number; branchesMs: number; waitedMs: number; branches: number } | null;
  playwright: ProjectSummary[];
  artifacts: ArtifactSummary;
  /** Only for a build that did not succeed: the first stage that failed, and the tests that did. */
  failure?: { stage: string | null; message: string | null; tests: { project: string; test: TestOutcome }[] };
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const branches = input.stages.filter((s) => s.group === 'Merge gate');
  const group = input.stages.find((s) => s.name === 'Merge gate' && s.group === null);
  const evidence: Evidence = {
    schemaVersion: 1,
    job: input.job,
    build: input.build,
    label: input.label,
    result: input.result,
    expected: input.expected,
    asExpected: input.result === input.expected,
    startedAt: new Date(input.startedAtMs).toISOString(),
    durationMs: input.durationMs,
    queuedMs: input.queuedMs,
    commit: input.commit,
    branch: input.branch,
    jenkins: {
      version: input.jenkinsVersion,
      executorsOnController: input.controllerExecutors,
      pluginCount: Object.keys(input.plugins).length,
      plugins: Object.entries(input.plugins)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, version]) => `${name}:${version}`),
    },
    agents: input.agents,
    tools: input.tools,
    stages: input.stages,
    mergeGate:
      group && branches.length > 0
        ? {
            wallClockMs: group.durationMs,
            branchesMs: branches.reduce((sum, b) => sum + (b.durationMs - b.waitedMs), 0),
            waitedMs: branches.reduce((sum, b) => sum + b.waitedMs, 0),
            branches: branches.length,
          }
        : null,
    playwright: input.playwright,
    artifacts: summarizeArtifacts(input.artifacts),
  };
  if (input.result !== 'SUCCESS') {
    const failed = input.stages.find(
      (s) => s.status === 'FAILED' && !input.stages.some((c) => c.group === s.name),
    );
    evidence.failure = {
      stage: failed?.name ?? null,
      message: failed?.error ?? null,
      tests: input.playwright.flatMap((p) =>
        p.results
          .filter((t) => t.status === 'failed' || t.status === 'flaky')
          .map((test) => ({ project: p.project, test })),
      ),
    };
  }
  return evidence;
}

const WIDTH = 120;

/** `JSON.stringify` with a space after every colon and comma: how the record is written when it fits on one line. */
function inline(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => inline(item === undefined ? null : item)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length === 0
      ? '{}'
      : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * JSON with two spaces of indentation in which every array or object that fits on one line (at most 120 columns, with its
 * indentation) is written on one line, and a long list of short strings or numbers (the plugins) is filled line by line, so
 * that the record stays short. `JSON.parse` reads it back.
 */
export function stringifyEvidence(value: unknown): string {
  const write = (v: unknown, indent: string): string => {
    const flat = inline(v);
    if (v === null || typeof v !== 'object' || indent.length + flat.length <= WIDTH) return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.every((item) => typeof item === 'string' || typeof item === 'number')) {
        const lines: string[] = [];
        let line = '';
        for (const item of v) {
          const text = `${inline(item)},`;
          if (line !== '' && inner.length + line.length + 1 + text.length > WIDTH) {
            lines.push(line);
            line = '';
          }
          line = line === '' ? text : `${line} ${text}`;
        }
        if (line !== '') lines.push(line);
        return `[\n${lines
          .map((l) => `${inner}${l}`)
          .join('\n')
          .replace(/,$/, '')}\n${indent}]`;
      }
      return `[\n${v.map((item) => `${inner}${write(item === undefined ? null : item, inner)}`).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(',\n')}\n${indent}}`;
  };
  return `${write(value, '')}\n`;
}
