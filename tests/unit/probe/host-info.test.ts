import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectHostInfo, readGit, readOsName } from '../../../src/lab/probe/host-info.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

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
