import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

// Facts about the machine and the checkout a result was measured on: a number without them is not evidence.

export interface OsInfo {
  platform: string;
  arch: string;
  /** Kernel release (`uname -r`). */
  release: string;
  /** Human name: `macOS 27.2`, `Ubuntu 24.04.5 LTS`. */
  name: string;
}

export interface GitInfo {
  /** Short hash of HEAD; null when git is unavailable. */
  commit: string | null;
  /** Whether tracked or untracked files other than the generated results differ from HEAD; null when unknown. */
  dirty: boolean | null;
}

export interface HostInfo {
  os: OsInfo;
  cpus: number;
  memoryGiB: number;
  node: string;
  /** The installed @playwright/test version. */
  playwright: string;
  git: GitInfo;
}

function run(command: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function readOsName(): string {
  if (platform() === 'darwin') {
    const version = run('sw_vers', ['-productVersion']);
    return version ? `macOS ${version}` : 'macOS';
  }
  try {
    const match = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'));
    if (match?.[1]) return match[1];
  } catch {
    // not a Linux with os-release
  }
  return platform();
}

/**
 * `git -c safe.directory=*`: inside a container the checkout belongs to a uid that git may not trust. A container cannot read a
 * worktree's git directory at all (it lives outside the mounted checkout), so docker:pw hands over the host's answer in
 * PB_GIT_COMMIT and PB_GIT_DIRTY, which win when present.
 */
export function readGit(root: string, env: NodeJS.ProcessEnv = process.env): GitInfo {
  if (env.PB_GIT_COMMIT) {
    return {
      commit: env.PB_GIT_COMMIT,
      dirty: env.PB_GIT_DIRTY === undefined ? null : env.PB_GIT_DIRTY === '1',
    };
  }
  const git = (args: string[]): string | null => run('git', ['-c', 'safe.directory=*', ...args], root);
  const commit = git(['rev-parse', '--short', 'HEAD']);
  // Documentation and the generated results are not code under test: editing a document while a run is going, or writing the
  // result itself, must not make the run "dirty". Keep in step with tools/docker/pw.sh.
  const status = git(['status', '--porcelain', '--', '.', ':(exclude)docs', ':(exclude)*.md']);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export function readPlaywrightVersion(root: string): string {
  const manifest = JSON.parse(
    readFileSync(join(root, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
  ) as {
    version: string;
  };
  return manifest.version;
}

export function collectHostInfo(root: string): HostInfo {
  return {
    os: { platform: platform(), arch: arch(), release: release(), name: readOsName() },
    cpus: cpus().length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    playwright: readPlaywrightVersion(root),
    git: readGit(root),
  };
}
