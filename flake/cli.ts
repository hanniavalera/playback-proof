// What the flake commands (`flake/gate.ts`, `flake/report.ts`) share: reading their arguments, finding the run files, opening the store
// the history lives in, and writing to the job summary of GitHub Actions.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dayNumber } from './quarantine.ts';
import { parseRun, RunFormatError } from './run.ts';
import type { FlakeRun } from './run.ts';
import { openStore, parseIdentity } from './store.ts';
import type { FlakeStore } from './store.ts';

/** The gate or the report could not do what it was asked: a missing file, an unreadable history, an argument it does not understand. Exit 2. */
export class EnvironmentProblem extends Error {
  override name = 'EnvironmentProblem';
}

export interface CliArgs {
  /** Run files, or directories to look for them in. Empty: `reports/flake`. */
  runs: string[];
  store: 'file' | 'git';
  historyDir: string | undefined;
  gitRemote: string | undefined;
  gitBranch: string | undefined;
  gitRepo: string | undefined;
  gitIdentity: string | undefined;
  env: string | undefined;
  today: string | undefined;
  quarantine: string | undefined;
  strategy: string | undefined;
  json: string | undefined;
  md: string | undefined;
  /** Record the runs of this build in the history after judging them. */
  record: boolean;
  /** Git store: publish what is recorded (a build of main), never a pull request. */
  push: boolean;
  help: boolean;
}

const FLAGS_WITH_VALUE = [
  '--runs',
  '--store',
  '--history-dir',
  '--git-remote',
  '--git-branch',
  '--git-repo',
  '--git-identity',
  '--env',
  '--today',
  '--quarantine',
  '--strategy',
  '--json',
  '--md',
] as const;

/**
 * The arguments, with the environment variables that CI sets once for every job: PB_FLAKE_STORE, PB_FLAKE_HISTORY_DIR,
 * PB_FLAKE_GIT_REMOTE, PB_FLAKE_GIT_BRANCH, PB_FLAKE_GIT_IDENTITY. An argument wins over its variable.
 */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    runs: [],
    store: env.PB_FLAKE_STORE === 'git' ? 'git' : 'file',
    historyDir: env.PB_FLAKE_HISTORY_DIR,
    gitRemote: env.PB_FLAKE_GIT_REMOTE,
    gitBranch: env.PB_FLAKE_GIT_BRANCH,
    gitRepo: undefined,
    gitIdentity: env.PB_FLAKE_GIT_IDENTITY,
    env: undefined,
    today: undefined,
    quarantine: undefined,
    strategy: undefined,
    json: undefined,
    md: undefined,
    record: false,
    push: false,
    help: false,
  };
  if (env.PB_FLAKE_STORE !== undefined && env.PB_FLAKE_STORE !== 'git' && env.PB_FLAKE_STORE !== 'file') {
    throw new EnvironmentProblem(`PB_FLAKE_STORE must be file or git, not "${env.PB_FLAKE_STORE}"`);
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--record') args.record = true;
    else if (flag === '--push') args.push = true;
    else if ((FLAGS_WITH_VALUE as readonly string[]).includes(flag)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new EnvironmentProblem(`${flag} needs a value`);
      }
      switch (flag) {
        case '--runs':
          args.runs.push(value);
          break;
        case '--store':
          if (value !== 'file' && value !== 'git')
            throw new EnvironmentProblem(`--store must be file or git, not "${value}"`);
          args.store = value;
          break;
        case '--history-dir':
          args.historyDir = value;
          break;
        case '--git-remote':
          args.gitRemote = value;
          break;
        case '--git-branch':
          args.gitBranch = value;
          break;
        case '--git-repo':
          args.gitRepo = value;
          break;
        case '--git-identity':
          args.gitIdentity = value;
          break;
        case '--env':
          args.env = value;
          break;
        case '--today':
          if (dayNumber(value) === null)
            throw new EnvironmentProblem(`--today must be a day written YYYY-MM-DD, not "${value}"`);
          args.today = value;
          break;
        case '--quarantine':
          args.quarantine = value;
          break;
        case '--strategy':
          args.strategy = value;
          break;
        case '--json':
          args.json = value;
          break;
        case '--md':
          args.md = value;
          break;
      }
    } else {
      throw new EnvironmentProblem(`unknown argument ${arg}`);
    }
  }
  if (args.push && !args.record)
    throw new EnvironmentProblem('--push publishes what --record records: give both, or neither');
  if (args.push && args.store !== 'git')
    throw new EnvironmentProblem(
      '--push is for the git store (--store git); the file store has nothing to publish',
    );
  return args;
}

export function storeFromArgs(args: CliArgs, cwd: string = process.cwd()): FlakeStore {
  if (args.store === 'file')
    return openStore({ kind: 'file', ...(args.historyDir ? { dir: resolve(cwd, args.historyDir) } : {}) });
  return openStore({
    kind: 'git',
    repoDir: resolve(cwd, args.gitRepo ?? '.'),
    ...(args.gitRemote ? { remote: args.gitRemote } : {}),
    ...(args.gitBranch ? { branch: args.gitBranch } : {}),
    ...(args.gitIdentity ? { identity: parseIdentity(args.gitIdentity) } : {}),
  });
}

const RUN_FILE_NAME = /^run[^/\\]*\.json$/;

function walk(directory: string, out: string[]): void {
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (RUN_FILE_NAME.test(name)) out.push(full);
  }
}

/**
 * The run files of the given paths: a file as it is, a directory searched at every depth for `run*.json` (a CI job that downloads the
 * run files of several engine jobs has one directory each). A path that does not exist is a mistake, not an empty result.
 */
export function findRunFiles(
  paths: readonly string[],
  cwd: string = process.cwd(),
  required = true,
): string[] {
  const found: string[] = [];
  for (const path of paths) {
    const full = resolve(cwd, path);
    if (!existsSync(full)) {
      if (required) throw new EnvironmentProblem(`${path}: no such file or directory`);
      continue;
    }
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return [...new Set(found)];
}

export function readRunFiles(files: readonly string[]): FlakeRun[] {
  return files.map((file) => {
    try {
      return parseRun(JSON.parse(readFileSync(file, 'utf8')), file);
    } catch (error) {
      if (error instanceof RunFormatError) throw new EnvironmentProblem(`${error.message}`);
      if (error instanceof SyntaxError) throw new EnvironmentProblem(`${file}: not JSON: ${error.message}`);
      throw error;
    }
  });
}

/** The environment of a set of runs: one, since a history is per environment. */
export function environmentOf(runs: readonly FlakeRun[], requested: string | undefined): string {
  const ids = [...new Set(runs.map((run) => run.envId))];
  if (requested !== undefined) {
    const stray = ids.filter((id) => id !== requested);
    if (stray.length > 0) {
      throw new EnvironmentProblem(
        `--env ${requested}, but the run files are from ${stray.join(', ')}: a history is per environment`,
      );
    }
    return requested;
  }
  if (ids.length > 1) {
    throw new EnvironmentProblem(
      `the run files are from ${ids.length} environments (${ids.join(', ')}): judge one environment at a time (--runs <its directory>)`,
    );
  }
  return ids[0] as string;
}

/** Adds to the job summary of GitHub Actions when there is one. */
export function appendStepSummary(env: NodeJS.ProcessEnv, markdown: string): boolean {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  appendFileSync(file, `${markdown}\n`);
  return true;
}
