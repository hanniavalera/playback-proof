// Where the history lives. Two stores behind one interface:
//
//   FileStore  `flake/history/<envId>.jsonl` (or another directory): local use, `flake-collect`, a Jenkins agent that keeps its workspace.
//   GitStore   the orphan branch `ci-data`, holding `history/<envId>.jsonl`: CI, where nothing else survives a job. `load()` fetches the
//              branch and reads the file. `append()` builds a commit on top of what it fetched and pushes it, and when another job
//              pushed in the meantime (the push is rejected as a non-fast-forward) it fetches again, applies the same append to the new
//              tip and pushes again. It never forces. It pushes only when told to (a build of `main`), never on a pull request.
//
// The git store works with git's plumbing (a blob, a tree built in a private index file, a commit) and a private ref
// (`refs/flake-store/ci-data`). It never touches the working tree, the index, `HEAD` or any branch of the checkout it runs in, and it
// uses that checkout's remote and credentials, which is what a CI job has configured.
import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendRun, HISTORY_MAX_RUNS, hasRun, parseHistory, serializeHistory } from './history.ts';
import type { FlakeRun } from './run.ts';

export class StoreError extends Error {
  override name = 'StoreError';
}

export interface AppendOptions {
  /** Git store: publish the new history. Without it the history is computed and returned, and nothing leaves this process. */
  push?: boolean;
}

export interface AppendResult {
  /** The history after the append. */
  history: FlakeRun[];
  /** Runs that were new. A run already in the history is not added again. */
  added: number;
  /** Runs that fell off the start of the history to keep it within its limit. */
  trimmed: number;
  /** Git store: whether the new history was pushed. */
  pushed: boolean;
  /** Git store: how many times the push was tried; more than one means another writer won a race and this one tried again on top of it. */
  attempts: number;
}

export interface FlakeStore {
  readonly description: string;
  /** The history of one environment, oldest first; empty when there is none yet. Throws when it exists and cannot be read. */
  load(envId: string): Promise<FlakeRun[]>;
  append(envId: string, runs: readonly FlakeRun[], options?: AppendOptions): Promise<AppendResult>;
}

/** An environment id becomes a file name, so it may not say where the file goes. */
export function assertSafeEnvId(envId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(envId)) {
    throw new StoreError(
      `environment id "${envId}" cannot be a file name: use letters, digits, dots, dashes and underscores`,
    );
  }
}

function addAll(
  history: readonly FlakeRun[],
  envId: string,
  runs: readonly FlakeRun[],
  maxRuns: number,
): { next: FlakeRun[]; added: number; trimmed: number } {
  let next = [...history];
  let added = 0;
  let trimmed = 0;
  for (const run of runs) {
    if (run.envId !== envId) {
      throw new StoreError(
        `run ${run.invocationId} is from environment ${run.envId}, not ${envId}: histories are per environment`,
      );
    }
    if (hasRun(next, run.invocationId)) continue;
    const before = next.length + 1;
    next = appendRun(next, run, maxRuns);
    added += 1;
    trimmed += before - next.length;
  }
  return { next, added, trimmed };
}

// ---------------------------------------------------------------------------------------------------------------------
// The file store

export interface FileStoreOptions {
  /** Default `flake/history` under the current directory. */
  dir?: string;
  maxRuns?: number;
  /** How long to wait for another writer's lock before giving up, and after how long a lock is taken for a dead writer's. */
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class FileStore implements FlakeStore {
  readonly description: string;
  private readonly dir: string;
  private readonly maxRuns: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options: FileStoreOptions = {}) {
    this.dir = resolve(options.dir ?? 'flake/history');
    this.maxRuns = options.maxRuns ?? HISTORY_MAX_RUNS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    this.description = `file store ${this.dir}`;
  }

  path(envId: string): string {
    assertSafeEnvId(envId);
    return join(this.dir, `${envId}.jsonl`);
  }

  async load(envId: string): Promise<FlakeRun[]> {
    return this.read(envId);
  }

  private read(envId: string): FlakeRun[] {
    const file = this.path(envId);
    return existsSync(file) ? parseHistory(readFileSync(file, 'utf8'), file) : [];
  }

  /** One writer at a time: the file is read, changed and written back, and two writers doing that at once would lose a run. */
  private async locked<T>(file: string, work: () => T): Promise<T> {
    mkdirSync(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          // A writer that died holding the lock must not stop the history for good.
          if (Date.now() - statSync(lock).mtimeMs > this.staleLockMs) unlinkSync(lock);
        } catch {
          // Released in the meantime: try again.
        }
        if (Date.now() > deadline)
          throw new StoreError(`${lock}: held by another writer for more than ${this.lockTimeoutMs} ms`);
        await sleep(10 + Math.floor(Math.random() * 15));
      }
    }
    try {
      return work();
    } finally {
      unlinkSync(lock);
    }
  }

  async append(envId: string, runs: readonly FlakeRun[]): Promise<AppendResult> {
    const file = this.path(envId);
    return this.locked(file, () => {
      const { next, added, trimmed } = addAll(this.read(envId), envId, runs, this.maxRuns);
      if (added > 0) {
        const partial = `${file}.${process.pid}.tmp`;
        writeFileSync(partial, serializeHistory(next));
        renameSync(partial, file);
      }
      return { history: next, added, trimmed, pushed: false, attempts: 1 };
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The git-branch store

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Runs git; a non-zero exit rejects with the exit code and what git said. */
export type GitRunner = (
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string },
) => Promise<GitResult>;

export class GitError extends Error {
  override name = 'GitError';
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} failed${code === null ? '' : ` (exit ${code})`}: ${stderr.trim() || stdout.trim() || 'no output'}`,
    );
  }
}

export const realGit: GitRunner = (args, { cwd, env, input }) =>
  new Promise((resolveRun, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as NodeJS.ErrnoException).code === 'number'
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : null;
          reject(
            new GitError(
              args,
              code,
              stdout,
              error.message.includes('ENOENT') ? 'git is not installed' : stderr,
            ),
          );
        } else {
          resolveRun({ stdout, stderr });
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

export interface GitStoreOptions {
  /** Any directory of a checkout: its remote and its credentials are used, and nothing in it is changed except private refs and objects. */
  repoDir: string;
  /** A remote name or a URL. Default `origin`. */
  remote?: string;
  /** Default `ci-data`. */
  branch?: string;
  /** Who the commits are made as: the CI identity. */
  identity: { name: string; email: string };
  maxRuns?: number;
  /** Pushes tried before giving up on a race that keeps being lost. Default 10. */
  maxAttempts?: number;
  /** Waits between two tries of a lost race (default: a few milliseconds at random, so that writers do not retry in step). */
  backoff?: (attempt: number) => Promise<void>;
  /** For tests: runs between the commit being built and the push, where another writer can get in. */
  beforePush?: (info: { attempt: number; envId: string }) => Promise<void> | void;
  git?: GitRunner;
}

/** What git says when a push loses to another writer: not a fast-forward, the remote moved, or the ref was locked at that moment. */
const LOST_RACE =
  /non-fast-forward|fetch first|\(rejected\)|\[rejected\]|failed to update ref|cannot lock ref|reference already exists|stale info/i;
const MISSING_BRANCH = /couldn't find remote ref|could not find remote ref/i;

export class GitStore implements FlakeStore {
  readonly description: string;
  private readonly remote: string;
  private readonly branch: string;
  private readonly privateRef: string;
  private readonly maxRuns: number;
  private readonly maxAttempts: number;
  private readonly repoDir: string;
  private readonly git: GitRunner;

  constructor(private readonly options: GitStoreOptions) {
    this.remote = options.remote ?? 'origin';
    this.branch = options.branch ?? 'ci-data';
    this.privateRef = `refs/flake-store/${this.branch}`;
    this.maxRuns = options.maxRuns ?? HISTORY_MAX_RUNS;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.repoDir = resolve(options.repoDir);
    this.git = options.git ?? realGit;
    this.description = `git branch ${this.branch} of ${this.remote}`;
  }

  private run(args: string[], extra: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra.env };
    // A hook or a wrapper may have pointed these at some other repository.
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
      if (!(extra.env && name in extra.env)) delete env[name];
    }
    return this.git(args, {
      cwd: this.repoDir,
      env,
      ...(extra.input !== undefined ? { input: extra.input } : {}),
    });
  }

  /** The tip of the branch on the remote, fetched into the private ref; null when the remote has no such branch. */
  private async fetchTip(): Promise<string | null> {
    try {
      await this.run([
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        this.remote,
        `+refs/heads/${this.branch}:${this.privateRef}`,
      ]);
    } catch (error) {
      if (error instanceof GitError && MISSING_BRANCH.test(error.stderr)) return null;
      throw new StoreError(
        `cannot fetch branch ${this.branch} from ${this.remote} (${this.repoDir}): ${(error as Error).message}`,
      );
    }
    return (
      await this.run(['rev-parse', '--verify', '--quiet', `${this.privateRef}^{commit}`])
    ).stdout.trim();
  }

  private async readFileAt(tip: string | null, envId: string): Promise<string> {
    if (tip === null) return '';
    const path = `history/${envId}.jsonl`;
    const listed = await this.run(['ls-tree', '--name-only', tip, '--', path]);
    if (listed.stdout.trim() === '') return '';
    return (await this.run(['show', `${tip}:${path}`])).stdout;
  }

  async load(envId: string): Promise<FlakeRun[]> {
    assertSafeEnvId(envId);
    const tip = await this.fetchTip();
    return parseHistory(await this.readFileAt(tip, envId), `${this.branch}:history/${envId}.jsonl`);
  }

  /** A commit holding `text` as `history/<envId>.jsonl` on top of `tip` (or with no parent when there is none): an orphan branch begins so. */
  private async commit(tip: string | null, envId: string, text: string, message: string): Promise<string> {
    const gitPath = (
      await this.run([
        'rev-parse',
        '--git-path',
        `flake-store-index-${process.pid}-${Math.random().toString(36).slice(2)}`,
      ])
    ).stdout.trim();
    const index = resolve(this.repoDir, gitPath);
    const env = { GIT_INDEX_FILE: index };
    try {
      const blob = (await this.run(['hash-object', '-w', '--stdin'], { input: text })).stdout.trim();
      if (tip !== null) await this.run(['read-tree', tip], { env });
      await this.run(['update-index', '--add', '--cacheinfo', `100644,${blob},history/${envId}.jsonl`], {
        env,
      });
      const tree = (await this.run(['write-tree'], { env })).stdout.trim();
      const { name, email } = this.options.identity;
      return (
        await this.run(['commit-tree', tree, ...(tip !== null ? ['-p', tip] : []), '-m', message], {
          env: {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: name,
            GIT_COMMITTER_EMAIL: email,
          },
        })
      ).stdout.trim();
    } finally {
      try {
        unlinkSync(index);
      } catch {
        // Never written, or already gone.
      }
    }
  }

  async append(envId: string, runs: readonly FlakeRun[], options: AppendOptions = {}): Promise<AppendResult> {
    assertSafeEnvId(envId);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const tip = await this.fetchTip();
      const before = parseHistory(await this.readFileAt(tip, envId), `${this.branch}:history/${envId}.jsonl`);
      const { next, added, trimmed } = addAll(before, envId, runs, this.maxRuns);
      if (added === 0 || options.push !== true) {
        return { history: next, added, trimmed, pushed: false, attempts: attempt };
      }

      const ids = runs.map((r) => r.runId).filter((id, i, all) => all.indexOf(id) === i);
      const message = `flake history: ${envId} +${added} run${added === 1 ? '' : 's'}\n\n${ids.join('\n')}\n`;
      const commit = await this.commit(tip, envId, serializeHistory(next), message);
      await this.options.beforePush?.({ attempt, envId });
      try {
        // Never forced: if the remote moved on, the push is refused and the append is made again on top of the new tip.
        await this.run(['push', this.remote, `${commit}:refs/heads/${this.branch}`]);
      } catch (error) {
        if (error instanceof GitError && LOST_RACE.test(error.stderr)) {
          if (attempt < this.maxAttempts) {
            await (this.options.backoff ?? ((n) => sleep(Math.floor(Math.random() * 20) * n)))(attempt);
            continue;
          }
          throw new StoreError(
            `could not publish the history to ${this.branch} of ${this.remote} in ${this.maxAttempts} tries: other writers kept winning the race (${error.stderr.trim()})`,
          );
        }
        throw new StoreError(`cannot push ${this.branch} to ${this.remote}: ${(error as Error).message}`);
      }
      await this.run(['update-ref', this.privateRef, commit]);
      return { history: next, added, trimmed, pushed: true, attempts: attempt };
    }
    throw new StoreError(`could not publish the history to ${this.branch} of ${this.remote}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Choosing one

export interface StoreChoice {
  kind: 'file' | 'git';
  /** File store. */
  dir?: string;
  /** Git store. */
  repoDir?: string;
  remote?: string;
  branch?: string;
  identity?: { name: string; email: string };
}

export function openStore(choice: StoreChoice): FlakeStore {
  if (choice.kind === 'file') return new FileStore(choice.dir ? { dir: choice.dir } : {});
  if (!choice.identity) {
    throw new StoreError(
      'the git store commits as the CI identity: give it a name and an email (--git-identity "Name <email>")',
    );
  }
  return new GitStore({
    repoDir: choice.repoDir ?? process.cwd(),
    identity: choice.identity,
    ...(choice.remote ? { remote: choice.remote } : {}),
    ...(choice.branch ? { branch: choice.branch } : {}),
  });
}

/** `Name <email>`, as git writes an identity. */
export function parseIdentity(text: string): { name: string; email: string } {
  const m = /^\s*(.+?)\s*<([^<>\s]+)>\s*$/.exec(text);
  if (!m) throw new StoreError(`identity "${text}" must look like: Name <email>`);
  return { name: m[1] as string, email: m[2] as string };
}
