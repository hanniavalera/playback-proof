// The quarantine-aware way to run the merge gate (`gate:merge`). Without quarantined tests it is exactly `playwright test --grep @merge`.
// With them it makes two invocations:
//
//   1. the blocking one: the @merge tests except the quarantined ones (`--grep-invert`). Its exit code is the command's exit code.
//   2. the non-blocking one: only the quarantined @merge tests. They still run, their results are recorded in the flake history as
//      quarantined (the reporter reads the same list), and whatever happens to them never fails the job.
//
// Arguments after the script name go to both invocations (`--project=webkit`). The wrapper's own options start with `--flake-`:
//   --flake-quarantine=<file>   --flake-strategy=<file>   --flake-today=<YYYY-MM-DD>   --flake-dry-run (print the plan, run nothing)
//
// What decides which test is excluded is a regular expression over the title Playwright builds for `--grep` (project, file, describe
// blocks, title, tags, separated by spaces). A pattern that matches too much would exclude a test that is not quarantined: a silent
// hole in the gate. So the pattern is anchored on the structure: the engine (when the entry names one) at the start, then the spec
// file, then the id right after it. It matches less than it could (a quarantined test inside a `test.describe` is not excluded and
// keeps blocking), never more.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ciRunId, generatedRunId } from '../flake/reporter.ts';
import { activeEntries, loadList, utcDay } from '../flake/quarantine.ts';
import type { QuarantineEntry } from '../flake/quarantine.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

export const MERGE_TAG = '@merge';
export const QUARANTINED_RUN_FILE = 'reports/flake/run-quarantined.json';
export const QUARANTINED_OUTPUT = 'reports/quarantined';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The part of Playwright's grep title that follows the engine: the spec file, then the id. */
const AFTER_ENGINE = '\\S*\\.spec\\.[cm]?[jt]s';

/** A pattern, anchored at the start of the grep title, that matches the test of one entry. */
export function patternFor(entry: Pick<QuarantineEntry, 'id' | 'project'>): string {
  const id = escapeRegExp(entry.id);
  return entry.project === undefined
    ? `.*\\.spec\\.[cm]?[jt]s ${id}(?: |$)`
    : `\\s*${escapeRegExp(entry.project)} ${AFTER_ENGINE} ${id}(?: |$)`;
}

/** The alternatives of every entry as one group, or null when nothing is quarantined. */
export function quarantineSelector(
  entries: readonly Pick<QuarantineEntry, 'id' | 'project'>[],
): string | null {
  const patterns = [...new Set(entries.map(patternFor))];
  return patterns.length === 0 ? null : `(?:${patterns.join('|')})`;
}

export interface Invocation {
  label: string;
  /** Arguments of `playwright`. */
  args: string[];
  env: Record<string, string>;
}

export interface GatePlan {
  blocking: Invocation;
  /** null when nothing is quarantined. */
  quarantined: Invocation | null;
}

/**
 * The invocations of a gate run. `runId` is shared by both so that they are one build in the history; the second one gets its own
 * run file, report and output folder, so that it does not overwrite the first one's (Playwright empties its output folder on every run).
 */
export function planGate(
  entries: readonly Pick<QuarantineEntry, 'id' | 'project'>[],
  extraArgs: readonly string[],
  runId: string,
): GatePlan {
  const selector = quarantineSelector(entries);
  const blocking: Invocation = {
    label: 'merge gate',
    args: ['test', '--grep', MERGE_TAG, ...(selector ? ['--grep-invert', `^${selector}`] : []), ...extraArgs],
    env: { PB_RUN_ID: runId },
  };
  if (!selector) return { blocking, quarantined: null };
  return {
    blocking,
    quarantined: {
      label: 'quarantined tests (non-blocking)',
      args: [
        'test',
        '--grep',
        `^(?=.*(?:^|\\s)${MERGE_TAG}(?:\\s|$))(?=${selector})`,
        '--pass-with-no-tests',
        '--output',
        `${QUARANTINED_OUTPUT}/test-results`,
        ...extraArgs,
      ],
      env: {
        PB_RUN_ID: runId,
        PB_FLAKE_RUN_FILE: QUARANTINED_RUN_FILE,
        PLAYWRIGHT_JSON_OUTPUT_FILE: `${QUARANTINED_OUTPUT}/playwright.json`,
        PLAYWRIGHT_HTML_OUTPUT_DIR: `${QUARANTINED_OUTPUT}/html`,
        PLAYWRIGHT_HTML_OPEN: 'never',
      },
    },
  };
}

export interface GateMergeOptions {
  extraArgs: string[];
  quarantineFile: string;
  strategyFile: string;
  today: string;
  dryRun: boolean;
}

/** Takes the wrapper's own `--flake-*` options out of the arguments; the rest is for Playwright. */
export function parseArgs(
  argv: readonly string[],
  root: string = ROOT,
  now: Date = new Date(),
): GateMergeOptions {
  const options: GateMergeOptions = {
    extraArgs: [],
    quarantineFile: resolve(root, 'flake/quarantine.json'),
    strategyFile: resolve(root, 'TEST_STRATEGY.md'),
    today: utcDay(now),
    dryRun: false,
  };
  for (const arg of argv) {
    const value = (name: string): string | null =>
      arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null;
    if (arg === '--flake-dry-run') options.dryRun = true;
    else if (value('--flake-quarantine') !== null)
      options.quarantineFile = resolve(value('--flake-quarantine') as string);
    else if (value('--flake-strategy') !== null)
      options.strategyFile = resolve(value('--flake-strategy') as string);
    else if (value('--flake-today') !== null) options.today = value('--flake-today') as string;
    else options.extraArgs.push(arg);
  }
  return options;
}

export type Runner = (invocation: Invocation) => Promise<number | null>;

export interface GateMergeResult {
  exitCode: number;
  plan: GatePlan;
  /** What the non-blocking invocation exited with, or null when there was none. Never part of `exitCode`. */
  quarantinedExitCode: number | null;
  warnings: string[];
}

/** Runs the plan: the blocking invocation first, then the non-blocking one, and returns the first one's code. */
export async function runGateMerge(
  options: GateMergeOptions,
  run: Runner,
  log: (line: string) => void = (line) => console.log(line),
  runId: string = ciRunId() ?? generatedRunId(),
): Promise<GateMergeResult> {
  let active: QuarantineEntry[] = [];
  let found = false;
  const warnings: string[] = [];
  try {
    const { read, assessment } = loadList(options);
    found = read.found;
    warnings.push(
      ...assessment.problems.map(
        (problem) =>
          `quarantine list: ${problem} (the flake gate fails on it; an entry with a problem quarantines nothing)`,
      ),
    );
    active = activeEntries(assessment.effective, options.today);
  } catch (error) {
    // The safe direction: a list that cannot be judged excludes nothing, so every @merge test blocks.
    warnings.push(`quarantine list not applied, every @merge test blocks: ${(error as Error).message}`);
  }
  for (const warning of warnings) log(warning);
  const plan = planGate(active, options.extraArgs, runId);
  if (active.length > 0) {
    log(
      `quarantined (non-blocking, still running): ${active.map((e) => `${e.id}${e.project ? ` on ${e.project}` : ''} until ${e.expires} (${e.owner})`).join('; ')}`,
    );
  } else if (found) {
    log('nothing is quarantined: the merge gate runs every @merge test');
  }
  if (options.dryRun) {
    for (const invocation of [plan.blocking, plan.quarantined]) {
      if (invocation)
        log(`${invocation.label}: playwright ${invocation.args.map((a) => JSON.stringify(a)).join(' ')}`);
    }
    return { exitCode: 0, plan, quarantinedExitCode: null, warnings };
  }

  const first = await run(plan.blocking);
  // A run that was killed has no exit code; the second invocation would be a run nobody asked for.
  if (first === null) return { exitCode: 130, plan, quarantinedExitCode: null, warnings };
  let quarantinedExitCode: number | null = null;
  if (plan.quarantined) {
    quarantinedExitCode = await run(plan.quarantined);
    log(
      `${plan.quarantined.label}: playwright exited with ${quarantinedExitCode ?? 'a signal'}; it does not change the result of the gate (exit ${first})`,
    );
  }
  return { exitCode: first, plan, quarantinedExitCode, warnings };
}

export interface PlaywrightRunnerOptions {
  cwd?: string;
  /** What the process starts from (the invocation's own variables are added to it). Default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Capture the output instead of passing it through. */
  onOutput?: (chunk: string) => void;
}

/** Spawns Playwright's own CLI; by default with this process's streams, so that the output is exactly what `playwright test` prints. */
export function playwrightRunner(options: PlaywrightRunnerOptions = {}): Runner {
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  return (invocation) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [cli, ...invocation.args], {
        cwd: options.cwd ?? process.cwd(),
        stdio: options.onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: { ...(options.env ?? process.env), ...invocation.env },
      });
      if (options.onOutput) {
        child.stdout?.setEncoding('utf8').on('data', options.onOutput);
        child.stderr?.setEncoding('utf8').on('data', options.onOutput);
      }
      child.once('error', reject);
      child.once('close', (code) => resolveRun(code));
    });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await runGateMerge(options, playwrightRunner());
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`gate:merge could not run: ${(error as Error).message}`);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) void main();
