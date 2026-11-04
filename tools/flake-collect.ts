// Collects flake data from real runs (`tsx tools/flake-collect.ts --project chromium --runs 30 --grep @merge`): it repeats one Playwright
// invocation N times, and after each repetition appends that run to the history through the file store. A crash in repetition 17 keeps
// the 16 before it. The report of what it gathered is `npm run flake:report`; the gate reads the same history.
//
// A few decisions, each because the numbers would otherwise be wrong:
//   - `--retries 1` unless asked otherwise. With no retry a flaky test shows as a failure, never as a flake, and the rate collected would
//     be 0 for the wrong reason (the repository's own configuration retries only in CI).
//   - The flake reporter is put on the command line, so that the run is recorded whatever the configuration lists. Every other reporter
//     of the configuration is left out: the repetitions are for data, and thirty HTML reports are not.
//   - The browser tests need the test data service. Start it once (`npm run serve`) and let Playwright reuse it; each repetition would
//     otherwise build the player and start a service of its own.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRun, RunFormatError } from '../flake/run.ts';
import type { FlakeRun } from '../flake/run.ts';
import { FileStore } from '../flake/store.ts';
import type { FlakeStore } from '../flake/store.ts';
import { generatedRunId } from '../flake/reporter.ts';
import { playwrightRunner } from './gate-merge.ts';
import type { Invocation, Runner } from './gate-merge.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const FLAKE_REPORTER = resolve(ROOT, 'flake/reporter.ts');

export interface CollectOptions {
  runs: number;
  /** Playwright projects (`--project`); none means every project of the configuration. */
  projects: string[];
  /** Default `@merge`. */
  grep: string;
  /** Default 1. */
  retries: number;
  /** Reporters to run next to the flake reporter. Default `dot`. */
  reporters: string[];
  /** Where the history goes. Default `flake/history` under the current directory. */
  historyDir: string | undefined;
  /** Where each repetition's run file is kept before it is recorded. */
  runDir: string;
  /** Where Playwright runs (it finds its configuration from here). */
  cwd: string;
  /** Everything after `--` on the command line, for Playwright. */
  playwrightArgs: string[];
  /** The prefix of the run ids: repetition 3 is `<prefix>-3`. */
  runIdPrefix: string;
}

export function defaultOptions(cwd: string = process.cwd(), now: Date = new Date()): CollectOptions {
  return {
    runs: 10,
    projects: [],
    grep: '@merge',
    retries: 1,
    reporters: ['dot'],
    historyDir: undefined,
    runDir: resolve(cwd, 'reports/flake/collect'),
    cwd,
    playwrightArgs: [],
    runIdPrefix: `collect-${generatedRunId(now).slice('local-'.length)}`,
  };
}

/** The invocation of repetition `index` (1-based). Its run file is its own, so that a repetition never overwrites another. */
export function invocationFor(options: CollectOptions, index: number): Invocation {
  const runFile = resolve(options.runDir, `run-${index}.json`);
  return {
    label: `repetition ${index} of ${options.runs}`,
    args: [
      'test',
      ...options.projects.flatMap((project) => ['--project', project]),
      '--grep',
      options.grep,
      '--retries',
      String(options.retries),
      '--reporter',
      [...options.reporters, FLAKE_REPORTER].join(','),
      '--output',
      // Playwright empties its output directory at the start of an invocation: one directory per repetition keeps the
      // traces and diagnostics of the repetitions that failed, which is what a flake is diagnosed from.
      resolve(options.runDir, 'test-results', `run-${index}`),
      ...options.playwrightArgs,
    ],
    env: { PB_RUN_ID: `${options.runIdPrefix}-${index}`, PB_FLAKE_RUN_FILE: runFile },
  };
}

export class CollectError extends Error {
  override name = 'CollectError';
}

export interface Repetition {
  index: number;
  exitCode: number;
  run: FlakeRun;
  /** `PB-VOD-007 (webkit)` for every test that was flaky, and for every one that failed. */
  flaky: string[];
  failed: string[];
  /** `PB-ABR-002 (webkit): invalid run: ...` for every test that was skipped, with the start of its reason: an invalid run is counted here. */
  skipped: string[];
  added: boolean;
}

export interface CollectResult {
  repetitions: Repetition[];
  historyDir: string;
  /** Flaky and failed outcomes over all repetitions, for the summary line. */
  flakyOutcomes: number;
  failedOutcomes: number;
  /** Skipped outcomes: documented gaps and invalid runs. They are not executions: no rate counts them, so they are counted here. */
  skippedOutcomes: number;
  executions: number;
  interrupted: boolean;
}

export interface CollectDeps {
  run: Runner;
  /** Default: a file store in `options.historyDir`. */
  store?: FlakeStore;
  log?: (line: string) => void;
}

function readRunFile(path: string): FlakeRun {
  try {
    return parseRun(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof RunFormatError || error instanceof SyntaxError) {
      throw new CollectError(`${path} is not a run file: ${error.message}`);
    }
    throw error;
  }
}

export async function collect(options: CollectOptions, deps: CollectDeps): Promise<CollectResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const store = deps.store ?? new FileStore(options.historyDir ? { dir: options.historyDir } : {});
  const result: CollectResult = {
    repetitions: [],
    historyDir: options.historyDir ?? 'flake/history',
    flakyOutcomes: 0,
    failedOutcomes: 0,
    skippedOutcomes: 0,
    executions: 0,
    interrupted: false,
  };
  if (options.retries === 0) {
    log(
      'retries is 0: a flaky test cannot show as flaky without a retry, so these runs say nothing about flakiness (use --retries 1)',
    );
  }

  for (let index = 1; index <= options.runs; index++) {
    const invocation = invocationFor(options, index);
    const runFile = invocation.env.PB_FLAKE_RUN_FILE as string;
    const exitCode = await deps.run(invocation);
    if (exitCode === null) {
      log(`${invocation.label}: playwright was killed; stopping with ${result.repetitions.length} recorded`);
      result.interrupted = true;
      break;
    }
    if (!existsSync(runFile)) {
      throw new CollectError(
        `${invocation.label}: playwright exited with ${exitCode} and wrote no run file (${runFile}): the configuration did not load, or no test matched --grep ${options.grep}`,
      );
    }
    const run = readRunFile(runFile);
    const { added } = await store.append(run.envId, [run]);
    const flaky = run.tests.filter((t) => t.outcome === 'flaky').map((t) => `${t.id} (${t.project})`);
    const failed = run.tests
      .filter((t) => t.outcome === 'failed' || t.outcome === 'timedOut')
      .map((t) => `${t.id} (${t.project})`);
    const skipped = run.tests
      .filter((t) => t.outcome === 'skipped')
      .map((t) => `${t.id} (${t.project})${t.skipReason ? `: ${shortened(t.skipReason)}` : ''}`);
    const executed = run.tests.filter((t) =>
      ['passed', 'flaky', 'failed', 'timedOut'].includes(t.outcome),
    ).length;
    result.repetitions.push({ index, exitCode, run, flaky, failed, skipped, added: added > 0 });
    result.flakyOutcomes += flaky.length;
    result.failedOutcomes += failed.length;
    result.skippedOutcomes += skipped.length;
    result.executions += executed;
    log(
      `${invocation.label}: exit ${exitCode}, ${executed} tests executed, ${flaky.length} flaky${flaky.length ? ` [${flaky.join(', ')}]` : ''}, ${failed.length} failed${failed.length ? ` [${failed.join(', ')}]` : ''}${skipped.length ? `, ${skipped.length} skipped [${skipped.join('; ')}]` : ''}`,
    );
  }

  log(
    `collected ${result.repetitions.length} of ${options.runs} runs into ${result.historyDir}: ${result.executions} executions, ${result.flakyOutcomes} flaky, ${result.failedOutcomes} failed${result.skippedOutcomes > 0 ? `, ${result.skippedOutcomes} skipped` : ''}. Next: npm run flake:report`,
  );
  return result;
}

/** The start of a skip reason: the invalid runs of ADR-106 put their numbers first, and a log line is not the place for the rest. */
function shortened(reason: string, max = 110): string {
  const flat = reason.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const USAGE = `Usage: tsx tools/flake-collect.ts --runs <n> [--project <name>]... [--grep <pattern>] [--retries <n>] [--history-dir <dir>]
                                  [--reporter <name>]... [-- <more arguments for playwright test>]

Repeats \`playwright test\` n times (default 10) and records every repetition in the flake history (the file store).
  --project      a Playwright project; repeat it for several. Default: every project of the configuration.
  --grep         which tests (default @merge).
  --retries      retries per test (default 1: with none a flake cannot be seen).
  --history-dir  where the history goes (default flake/history).
  --reporter     a reporter to run next to the flake reporter (default dot).
Start the test data service once beforehand (npm run serve, on PB_PORT) so that the repetitions reuse it.`;

export function parseArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
  now: Date = new Date(),
): CollectOptions | 'help' {
  const options = defaultOptions(cwd, now);
  const reporters: string[] = [];
  const need = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new CollectError(`${flag} needs a value`);
    return value;
  };
  const number = (flag: string, value: string | undefined, min: number): number => {
    const n = Number(need(flag, value));
    if (!Number.isInteger(n) || n < min)
      throw new CollectError(`${flag} must be a whole number of at least ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case '--':
        options.playwrightArgs = argv.slice(i + 1).map(String);
        i = argv.length;
        break;
      case '--help':
      case '-h':
        return 'help';
      case '--runs':
        options.runs = number(flag, value(), 1);
        break;
      case '--retries':
        options.retries = number(flag, value(), 0);
        break;
      case '--project':
        options.projects.push(need(flag, value()));
        break;
      case '--grep':
        options.grep = need(flag, value());
        break;
      case '--history-dir':
        options.historyDir = resolve(cwd, need(flag, value()));
        break;
      case '--reporter':
        reporters.push(need(flag, value()));
        break;
      default:
        throw new CollectError(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if (reporters.length > 0) options.reporters = reporters;
  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === 'help') {
      console.log(USAGE);
      return;
    }
    const result = await collect(options, { run: playwrightRunner({ cwd: options.cwd }) });
    process.exit(result.interrupted ? 130 : 0);
  } catch (error) {
    console.error(`flake-collect: ${(error as Error).message}`);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) void main();
