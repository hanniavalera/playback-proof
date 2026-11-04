import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A real git world for the tests of the git store and of the gate that records into it: a temporary bare repository and checkouts
// that point at it. Everything lives in a scratch directory the caller made; nothing here knows of any other remote.

/** A bare repository (`…/bare.git`) is addressed with --git-dir: the machine's git may refuse to discover one (safe.bareRepository). */
function invocation(cwd: string, args: string[]): { cwd: string; args: string[] } {
  return cwd.endsWith('.git') ? { cwd: dirname(cwd), args: ['--git-dir', cwd, ...args] } : { cwd, args };
}

export function git(cwd: string, ...args: string[]): string {
  const call = invocation(cwd, args);
  const result = spawnSync('git', call.args, { cwd: call.cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

export const gitStatus = (cwd: string, ...args: string[]): number | null => {
  const call = invocation(cwd, args);
  return spawnSync('git', call.args, { cwd: call.cwd, encoding: 'utf8' }).status;
};

export interface World {
  root: string;
  bare: string;
  /** A fresh repository with `origin` set to the bare one, as a CI checkout that has not fetched anything. */
  writer(name: string): string;
}

/** A temporary bare repository with a `main` branch that has history of its own, and writers' repositories that point at it. */
export function makeWorld(root: string): World {
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
