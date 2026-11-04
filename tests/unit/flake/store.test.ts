import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryError, parseHistory, serializeHistory } from '../../../flake/history.ts';
import {
  assertSafeEnvId,
  FileStore,
  GitStore,
  openStore,
  parseIdentity,
  realGit,
  StoreError,
} from '../../../flake/store.ts';
import type { FlakeStore, GitRunner } from '../../../flake/store.ts';
import type { FlakeRun } from '../../../flake/run.ts';
import { makeScratch } from '../support/scratch.ts';
import { record, run } from './fixtures.ts';

const ENV = 'gha-linux-x64';
const CI = { name: 'playback-proof ci', email: 'ci@example.invalid' };

const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
  const dir = makeScratch(prefix);
  scratches.push(dir);
  return dir;
};

/** A run of one environment with a name of its own, as the next build of that environment. */
const newRun = (name: string, envId = ENV): FlakeRun =>
  run([record({ id: 'PB-VOD-001', outcome: name.endsWith('flaky') ? 'flaky' : 'passed' })], {
    envId,
    invocationId: `inv-${name}`,
    runId: `run-${name}`,
  });

/** A bare repository (`…/bare.git`) is addressed with --git-dir: the machine's git may refuse to discover one (safe.bareRepository). */
function invocation(cwd: string, args: string[]): { cwd: string; args: string[] } {
  return cwd.endsWith('.git') ? { cwd: dirname(cwd), args: ['--git-dir', cwd, ...args] } : { cwd, args };
}
function git(cwd: string, ...args: string[]): string {
  const call = invocation(cwd, args);
  const result = spawnSync('git', call.args, { cwd: call.cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
const gitStatus = (cwd: string, ...args: string[]): number | null => {
  const call = invocation(cwd, args);
  return spawnSync('git', call.args, { cwd: call.cwd, encoding: 'utf8' }).status;
};

interface World {
  root: string;
  bare: string;
  /** A fresh repository with `origin` set to the bare one, as a CI checkout that has not fetched anything. */
  writer(name: string): string;
}

/** A temporary bare repository with a `main` branch that has history of its own, and writers' repositories that point at it. */
function makeWorld(): World {
  const root = scratch('flake-git-');
  const bare = join(root, 'bare.git');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'the code branch\n');
  git(seed, 'add', '.');
  git(
    seed,
    '-c',
    'user.name=Seed',
    '-c',
    'user.email=seed@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'the code',
  );
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '--quiet', 'origin', 'main');
  return {
    root,
    bare,
    writer(name) {
      const dir = join(root, name);
      if (existsSync(dir)) return dir;
      git(root, 'init', '--quiet', '-b', 'main', dir);
      git(dir, 'remote', 'add', 'origin', bare);
      // Not the CI identity: the store must commit as the identity it is given, whatever the checkout says.
      git(dir, 'config', 'user.name', 'hanniavalera');
      git(dir, 'config', 'user.email', 'hannia.cpp@gmail.com');
      return dir;
    },
  };
}

const storeOf = (repoDir: string, extra: Partial<ConstructorParameters<typeof GitStore>[0]> = {}) =>
  new GitStore({ repoDir, identity: CI, backoff: async () => {}, ...extra });

const fileAt = (bare: string, ref: string, envId = ENV): string =>
  git(bare, 'show', `${ref}:history/${envId}.jsonl`);

describe('PB-LAB-004 git store: the orphan branch ci-data, against a real bare repository', () => {
  it('treats a branch that does not exist as an empty history, and PR mode does not create it', async () => {
    const world = makeWorld();
    const store = storeOf(world.writer('a'));
    expect(await store.load(ENV)).toEqual([]);

    const result = await store.append(ENV, [newRun('1')], { push: false });
    expect(result).toMatchObject({ added: 1, pushed: false, attempts: 1 });
    expect(result.history.map((r) => r.invocationId)).toEqual(['inv-1']);
    // Nothing left the process: the remote has no branch but main.
    expect(git(world.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('creates ci-data as an orphan branch with history/<env>.jsonl, committed as the CI identity, when told to push', async () => {
    const world = makeWorld();
    const writer = world.writer('a');
    const first = newRun('1');
    const result = await storeOf(writer).append(ENV, [first], { push: true });
    expect(result).toMatchObject({ added: 1, pushed: true, attempts: 1 });

    // The branch exists on the remote, with one commit that has no parent...
    expect(git(world.bare, 'rev-list', '--parents', '-n', '1', 'ci-data')).toMatch(/^[0-9a-f]{40}$/);
    // ...and no history in common with the code.
    expect(gitStatus(world.bare, 'merge-base', 'main', 'ci-data')).toBe(1);
    expect(git(world.bare, 'ls-tree', '-r', '--name-only', 'ci-data')).toBe(`history/${ENV}.jsonl`);
    expect(fileAt(world.bare, 'ci-data')).toBe(serializeHistory([first]).trim());
    expect(git(world.bare, 'log', '-1', '--format=%an <%ae> | %cn <%ce>', 'ci-data')).toBe(
      'playback-proof ci <ci@example.invalid> | playback-proof ci <ci@example.invalid>',
    );
    expect(git(world.bare, 'log', '-1', '--format=%s', 'ci-data')).toBe(`flake history: ${ENV} +1 run`);

    // The checkout it ran in is as it was: no branch, no commit, a clean tree. The only refs it gained are the private one and the
    // remote-tracking ref that git itself updates after a push to a named remote.
    expect(git(writer, 'status', '--porcelain')).toBe('');
    expect(git(writer, 'branch', '--list')).toBe('');
    expect(gitStatus(writer, 'rev-parse', '--verify', '--quiet', 'HEAD')).toBe(1);
    expect(git(writer, 'for-each-ref', '--format=%(refname)').split('\n')).toEqual([
      'refs/flake-store/ci-data',
      'refs/remotes/origin/ci-data',
    ]);
    // And the main branch of the remote is untouched.
    expect(git(world.bare, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('loads what another job pushed, appends on top of it, and keeps the files of the other environments', async () => {
    const world = makeWorld();
    const mac = newRun('mac-1', 'gha-macos-arm64');
    await storeOf(world.writer('a')).append('gha-macos-arm64', [mac], { push: true });

    const b = storeOf(world.writer('b'));
    expect(await b.load(ENV)).toEqual([]);
    expect(await b.load('gha-macos-arm64')).toEqual([mac]);

    const linux = newRun('1');
    const result = await b.append(ENV, [linux], { push: true });
    expect(result.pushed).toBe(true);
    expect(git(world.bare, 'ls-tree', '-r', '--name-only', 'ci-data').split('\n')).toEqual([
      'history/gha-linux-x64.jsonl',
      'history/gha-macos-arm64.jsonl',
    ]);
    // A second commit on top of the first: nothing was replaced.
    expect(git(world.bare, 'rev-list', '--count', 'ci-data')).toBe('2');
    expect(git(world.bare, 'rev-parse', 'ci-data~1')).toBe(
      git(world.bare, 'rev-list', '--max-parents=0', 'ci-data'),
    );
    expect(fileAt(world.bare, 'ci-data', 'gha-macos-arm64')).toBe(serializeHistory([mac]).trim());
    expect(await storeOf(world.writer('c')).load(ENV)).toEqual([linux]);
  });

  it('does not push a run it already has: recording the same invocation again is no commit', async () => {
    const world = makeWorld();
    const store = storeOf(world.writer('a'));
    const first = newRun('1');
    await store.append(ENV, [first], { push: true });
    const tip = git(world.bare, 'rev-parse', 'ci-data');
    const again = await store.append(ENV, [first], { push: true });
    expect(again).toMatchObject({ added: 0, pushed: false });
    expect(git(world.bare, 'rev-parse', 'ci-data')).toBe(tip);
  });

  it('computes the history of a pull request without pushing it: the branch stays where it was', async () => {
    const world = makeWorld();
    await storeOf(world.writer('a')).append(ENV, [newRun('1')], { push: true });
    const tip = git(world.bare, 'rev-parse', 'ci-data');
    const pr = await storeOf(world.writer('b')).append(ENV, [newRun('2')], { push: false });
    expect(pr).toMatchObject({ added: 1, pushed: false });
    expect(pr.history.map((r) => r.invocationId)).toEqual(['inv-1', 'inv-2']);
    expect(git(world.bare, 'rev-parse', 'ci-data')).toBe(tip);
  });

  it('wins a race it lost: the push is refused, the append is made again on the new tip, and both runs are in the history', async () => {
    const world = makeWorld();
    await storeOf(world.writer('seed')).append(ENV, [newRun('0')], { push: true });
    const a = storeOf(world.writer('a'));
    const slow = world.writer('b');
    const backoffs: number[] = [];
    let raced = false;

    const b = storeOf(slow, {
      backoff: async (attempt) => {
        backoffs.push(attempt);
      },
      // After B has built its commit on the tip it fetched, and before it pushes, A publishes its own run: B's push is now behind.
      beforePush: async ({ attempt }) => {
        if (attempt === 1 && !raced) {
          raced = true;
          const publishedByA = await a.append(ENV, [newRun('from-a')], { push: true });
          expect(publishedByA.pushed).toBe(true);
        }
      },
    });
    const result = await b.append(ENV, [newRun('from-b')], { push: true });

    expect(result).toMatchObject({ added: 1, pushed: true, attempts: 2 });
    expect(backoffs).toEqual([1]);
    // The history is in the order the runs started: B started before A and finished after it, so it takes its place before A's.
    expect(result.history.map((r) => r.invocationId)).toEqual(['inv-0', 'inv-from-b', 'inv-from-a']);
    const onRemote = parseHistory(fileAt(world.bare, 'ci-data'));
    expect(onRemote.map((r) => r.invocationId)).toEqual(['inv-0', 'inv-from-b', 'inv-from-a']);
    // A line of history, no merge and nothing rewritten: A's commit is under B's.
    expect(git(world.bare, 'rev-list', '--count', 'ci-data')).toBe('3');
    expect(git(world.bare, 'rev-list', '--merges', '--count', 'ci-data')).toBe('0');
    expect(git(world.bare, 'log', '--format=%s', 'ci-data').split('\n')).toEqual([
      `flake history: ${ENV} +1 run`,
      `flake history: ${ENV} +1 run`,
      `flake history: ${ENV} +1 run`,
    ]);
  });

  it('gives up with an error, and leaves the other writers` work alone, when it keeps losing', async () => {
    const world = makeWorld();
    await storeOf(world.writer('seed')).append(ENV, [newRun('0')], { push: true });
    const other = storeOf(world.writer('a'));
    let n = 0;
    const loser = storeOf(world.writer('b'), {
      maxAttempts: 2,
      beforePush: async () => {
        n += 1;
        await other.append(ENV, [newRun(`rival-${n}`)], { push: true });
      },
    });
    await expect(loser.append(ENV, [newRun('mine')], { push: true })).rejects.toThrow(
      /could not publish the history to ci-data of origin in 2 tries: other writers kept winning the race/,
    );
    const ids = parseHistory(fileAt(world.bare, 'ci-data')).map((r) => r.invocationId);
    expect(ids).toEqual(['inv-0', 'inv-rival-1', 'inv-rival-2']);
  });

  it('keeps every run when several jobs push at the same moment', async () => {
    const world = makeWorld();
    const names = ['1', '2', '3', '4'];
    const results = await Promise.all(
      names.map((name) =>
        storeOf(world.writer(`w${name}`), { maxAttempts: 40 }).append(ENV, [newRun(name)], { push: true }),
      ),
    );
    expect(results.every((r) => r.pushed && r.added === 1)).toBe(true);
    const ids = parseHistory(fileAt(world.bare, 'ci-data')).map((r) => r.invocationId);
    expect([...ids].sort()).toEqual(names.map((n) => `inv-${n}`));
    expect(git(world.bare, 'rev-list', '--count', 'ci-data')).toBe(String(names.length));
    expect(git(world.bare, 'rev-list', '--merges', '--count', 'ci-data')).toBe('0');
    // How many of them lost a race depends on how the processes interleave, so it is not asserted: the test above makes one lose on purpose.
  });

  it('never forces a push: no force flag and no forced refspec in any push it makes', async () => {
    const world = makeWorld();
    const commands: string[][] = [];
    const recording: GitRunner = (args, options) => {
      commands.push(args);
      return realGit(args, options);
    };
    const a = storeOf(world.writer('a'), { git: recording });
    await a.append(ENV, [newRun('1')], { push: true });
    await a.append(ENV, [newRun('2')], { push: true });
    const pushes = commands.filter((c) => c[0] === 'push');
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push.some((arg) => /^(--force|-f$|--force-with-lease|--mirror|--delete)/.test(arg))).toBe(false);
      expect(push.some((arg) => arg.startsWith('+'))).toBe(false);
      expect(push[2]).toMatch(/^[0-9a-f]{40}:refs\/heads\/ci-data$/);
    }
  });

  it('says so when the remote cannot be reached, instead of reading an empty history', async () => {
    const world = makeWorld();
    const writer = world.writer('a');
    git(writer, 'remote', 'set-url', 'origin', join(world.root, 'nowhere.git'));
    await expect(storeOf(writer).load(ENV)).rejects.toThrow(/cannot fetch branch ci-data from origin/);
    await expect(storeOf(writer).append(ENV, [newRun('1')], { push: true })).rejects.toBeInstanceOf(
      StoreError,
    );
    // A directory that is not a repository. The scratch directory sits inside this repository's working tree, so git is told where to stop
    // looking: it must not find the enclosing repository and talk to ITS remote.
    const nowhere: GitRunner = (args, options) =>
      realGit(args, { ...options, env: { ...options.env, GIT_CEILING_DIRECTORIES: dirname(world.root) } });
    await expect(storeOf(world.root, { git: nowhere }).load(ENV)).rejects.toBeInstanceOf(StoreError);
  });

  it('does not retry a push the remote refuses for another reason', async () => {
    const world = makeWorld();
    const hook = join(world.bare, 'hooks', 'pre-receive');
    mkdirSync(join(world.bare, 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const attempts: number[] = [];
    const store = storeOf(world.writer('a'), { beforePush: ({ attempt }) => void attempts.push(attempt) });
    await expect(store.append(ENV, [newRun('1')], { push: true })).rejects.toThrow(
      /cannot push ci-data to origin/,
    );
    expect(attempts).toEqual([1]);
  });

  it('refuses a history file that is damaged, naming the branch, the file and the line', async () => {
    const world = makeWorld();
    const good = newRun('1');
    await storeOf(world.writer('a')).append(ENV, [good], { push: true });
    const text = `${serializeHistory([good])}{not json}\n`;
    // Put the damaged file on the branch with plain git: a writer that is not this tool.
    const w = world.writer('b');
    git(w, 'fetch', '--quiet', 'origin', '+refs/heads/ci-data:refs/heads/damage');
    git(w, 'checkout', '--quiet', 'damage');
    writeFileSync(join(w, 'history', `${ENV}.jsonl`), text);
    git(w, 'add', '.');
    git(w, 'commit', '--quiet', '-m', 'damage', '--no-gpg-sign');
    git(w, 'push', '--quiet', 'origin', 'damage:ci-data');
    await expect(storeOf(world.writer('c')).load(ENV)).rejects.toThrow(HistoryError);
    await expect(storeOf(world.writer('c')).load(ENV)).rejects.toThrow(
      new RegExp(`ci-data:history/${ENV}.jsonl:2: not JSON`),
    );
  });

  it('refuses an environment id that is not a file name, and a run from another environment', async () => {
    const world = makeWorld();
    const store = storeOf(world.writer('a'));
    for (const bad of ['../x', 'a/b', '', '.hidden', 'a b', '-rf']) {
      await expect(store.load(bad), bad).rejects.toThrow(/cannot be a file name/);
    }
    await expect(store.append(ENV, [newRun('1', 'gha-macos-arm64')], { push: true })).rejects.toThrow(
      /is from environment gha-macos-arm64, not gha-linux-x64: histories are per environment/,
    );
  });

  it('trims to the limit when it appends', async () => {
    const world = makeWorld();
    const store = storeOf(world.writer('a'), { maxRuns: 2 });
    await store.append(ENV, [newRun('1'), newRun('2')], { push: true });
    const result = await store.append(ENV, [newRun('3')], { push: true });
    expect(result).toMatchObject({ added: 1, trimmed: 1 });
    expect(parseHistory(fileAt(world.bare, 'ci-data')).map((r) => r.invocationId)).toEqual([
      'inv-2',
      'inv-3',
    ]);
  });
});

describe('PB-LAB-004 file store: flake/history/<env>.jsonl', () => {
  it('starts empty, creates its directory, and keeps JSON lines that read back', async () => {
    const dir = join(scratch('flake-file-'), 'nested', 'history');
    const store = new FileStore({ dir });
    expect(await store.load(ENV)).toEqual([]);
    const a = newRun('1');
    const b = newRun('2');
    expect(await store.append(ENV, [a, b])).toMatchObject({ added: 2, trimmed: 0, pushed: false });
    expect(readFileSync(join(dir, `${ENV}.jsonl`), 'utf8')).toBe(serializeHistory([a, b]));
    expect(await new FileStore({ dir }).load(ENV)).toEqual([a, b]);
    expect(readdirSync(dir)).toEqual([`${ENV}.jsonl`]);
  });

  it('does not count a run twice, keeps environments in files of their own, and trims', async () => {
    const dir = scratch('flake-file-');
    const store = new FileStore({ dir, maxRuns: 2 });
    const a = newRun('1');
    await store.append(ENV, [a]);
    expect(await store.append(ENV, [a])).toMatchObject({ added: 0 });
    await store.append('gha-macos-arm64', [newRun('m', 'gha-macos-arm64')]);
    expect(readdirSync(dir).sort()).toEqual([`${ENV}.jsonl`, 'gha-macos-arm64.jsonl']);
    await store.append(ENV, [newRun('2')]);
    const third = await store.append(ENV, [newRun('3')]);
    expect(third).toMatchObject({ added: 1, trimmed: 1 });
    expect((await store.load(ENV)).map((r) => r.invocationId)).toEqual(['inv-2', 'inv-3']);
  });

  it('keeps every run when appends overlap in one process: one writer at a time, and no lock left behind', async () => {
    const dir = scratch('flake-file-');
    const store = new FileStore({ dir });
    await Promise.all(['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => store.append(ENV, [newRun(n)])));
    expect((await store.load(ENV)).map((r) => r.invocationId).sort()).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => `inv-${n}`),
    );
    expect(readdirSync(dir)).toEqual([`${ENV}.jsonl`]);
  });

  it('breaks the lock of a writer that died, and gives up on one that is still there', async () => {
    const dir = scratch('flake-file-');
    const lock = join(dir, `${ENV}.jsonl.lock`);
    writeFileSync(lock, '');
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(lock, longAgo, longAgo);
    const store = new FileStore({ dir, staleLockMs: 60_000, lockTimeoutMs: 500 });
    expect(await store.append(ENV, [newRun('1')])).toMatchObject({ added: 1 });
    expect(readdirSync(dir)).toEqual([`${ENV}.jsonl`]);

    writeFileSync(lock, '');
    await expect(store.append(ENV, [newRun('2')])).rejects.toThrow(
      /held by another writer for more than 500 ms/,
    );
    expect((await store.load(ENV)).map((r) => r.invocationId)).toEqual(['inv-1']);
  });

  it('refuses a file that is damaged, a run of another environment, and an id that is not a file name', async () => {
    const dir = scratch('flake-file-');
    const store = new FileStore({ dir });
    writeFileSync(join(dir, `${ENV}.jsonl`), `${serializeHistory([newRun('1')])}oops\n`);
    await expect(store.load(ENV)).rejects.toThrow(new RegExp(`${ENV}.jsonl:2: not JSON`));
    await expect(store.append(ENV, [newRun('2')])).rejects.toBeInstanceOf(HistoryError);
    await expect(
      new FileStore({ dir: scratch('flake-file-') }).append(ENV, [newRun('3', 'other-env')]),
    ).rejects.toThrow(/histories are per environment/);
    expect(() => store.path('../escape')).toThrow(StoreError);
  });
});

describe('PB-LAB-004 stores: one interface', () => {
  const stores: Array<[string, () => FlakeStore]> = [
    ['file store', () => new FileStore({ dir: scratch('flake-contract-') })],
    ['git store', () => storeOf(makeWorld().writer('a'))],
  ];

  it.each(stores)('%s: load, append, load again', async (_name, make) => {
    const store = make();
    expect(await store.load(ENV)).toEqual([]);
    const runs = [newRun('1'), newRun('2flaky')];
    const result = await store.append(ENV, runs, { push: true });
    expect(result).toMatchObject({ added: 2, trimmed: 0 });
    expect(await store.load(ENV)).toEqual(runs);
    expect(await store.append(ENV, runs, { push: true })).toMatchObject({ added: 0 });
    expect(store.description).toMatch(/store|branch/);
  });

  it('chooses a store, and the git store needs an identity to commit as', () => {
    expect(openStore({ kind: 'file', dir: '/x/history' })).toBeInstanceOf(FileStore);
    expect(() => openStore({ kind: 'git' })).toThrow(/commits as the CI identity/);
    expect(openStore({ kind: 'git', identity: CI, branch: 'data' }).description).toBe(
      'git branch data of origin',
    );
    expect(
      parseIdentity('github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'),
    ).toEqual({
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    });
    expect(() => parseIdentity('no email')).toThrow(/must look like: Name <email>/);
    expect(() => assertSafeEnvId('local-darwin-arm64')).not.toThrow();
  });
});
