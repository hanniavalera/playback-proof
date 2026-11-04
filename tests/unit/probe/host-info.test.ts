import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { collectHostInfo, readGit, readOsName } from '../../../src/lab/probe/host-info.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(ROOT, '.cache', 'unit-git-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('readGit', () => {
  it('takes the commit and the dirty flag from docker:pw when it provides them (a container cannot read a worktree)', () => {
    expect(readGit(ROOT, { PB_GIT_COMMIT: 'abc1234', PB_GIT_DIRTY: '1' })).toEqual({
      commit: 'abc1234',
      dirty: true,
    });
    expect(readGit(ROOT, { PB_GIT_COMMIT: 'abc1234', PB_GIT_DIRTY: '0' })).toEqual({
      commit: 'abc1234',
      dirty: false,
    });
    expect(readGit(ROOT, { PB_GIT_COMMIT: 'abc1234' })).toEqual({ commit: 'abc1234', dirty: null });
  });

  it('asks git itself otherwise: a short commit hash (or null where there is no git), and a dirty flag', () => {
    const own = readGit(ROOT, {});
    expect(own.commit === null || /^[0-9a-f]{7,}$/.test(own.commit)).toBe(true);
    expect(own.dirty === null || typeof own.dirty === 'boolean').toBe(true);
    expect(own.commit === null).toBe(own.dirty === null);
  });

  it('calls a tree dirty when code differs from the commit, never because of documentation or results', () => {
    const repo = join(scratch, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'results'), { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    git('init', '-q');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'docs', 'notes.md'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    const head = git('rev-parse', '--short', 'HEAD').trim();

    expect(readGit(repo, {})).toEqual({ commit: head, dirty: false });
    writeFileSync(join(repo, 'docs', 'notes.md'), 'two\n');
    writeFileSync(join(repo, 'README.md'), 'a new top-level document\n');
    writeFileSync(join(repo, 'docs', 'results', 'x.json'), '{}\n');
    expect(readGit(repo, {}).dirty, 'documentation and results').toBe(false);
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const b = 2;\n');
    expect(readGit(repo, {}).dirty, 'an untracked source file').toBe(true);
    rmSync(join(repo, 'src', 'new.ts'));
    expect(readGit(repo, {}).dirty).toBe(false);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
    expect(readGit(repo, {}).dirty, 'a modified source file').toBe(true);
  });
});

describe('collectHostInfo', () => {
  it('reports the machine and the versions that produced a result', () => {
    const info = collectHostInfo(ROOT);
    expect(info.node).toBe(process.version);
    expect(info.os.platform).toBe(process.platform);
    expect(info.os.arch).toBe(process.arch);
    expect(info.os.name.length).toBeGreaterThan(0);
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.memoryGiB).toBeGreaterThan(0);
  });

  it('reads the Playwright version that is installed, which must be the one pinned', () => {
    const pinned = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>;
      }
    ).devDependencies['@playwright/test'];
    expect(collectHostInfo(ROOT).playwright).toBe(pinned);
  });

  it('names the operating system the way a person would', () => {
    expect(readOsName()).toMatch(process.platform === 'darwin' ? /^macOS( \d+(\.\d+)*)?$/ : /\S+/);
  });
});
