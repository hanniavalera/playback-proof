import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { realPairedDeps } from '../../../perf/paired-deps.ts';
import { Cleanup, runControl } from '../../../src/lab/measure/paired.ts';
import type { ControlRequest } from '../../../src/lab/measure/paired.ts';

// The control of the paired gate made ready and "measured" for real: a real git repository of two commits, a real `git worktree`, real npm
// scripts and real processes, with a script of its own in place of the control's harness (nothing here starts a browser or the service).
// What the injected tests of paired.ts cannot show is that the pieces fit: the worktree is made at the control commit, the dependencies are
// linked or installed, the scripts get the arguments and the environment the gate means them to have, and nothing is left behind.

const SCRATCH = fileURLToPath(new URL('../../../.tmp/pb-paired-real-test/', import.meta.url));
const HEAD = join(SCRATCH, 'head');
const LOCK_A = `${JSON.stringify({ name: 'control-test', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'control-test', version: '1.0.0' } } }, null, 2)}\n`;
const PACKAGE = `${JSON.stringify({
  name: 'control-test',
  version: '1.0.0',
  private: true,
  scripts: { 'build:player': 'node scripts/build-player.cjs', 'perf:baseline': 'node scripts/baseline.cjs' },
})}\n`;
const BUILD = `require('node:fs').mkdirSync('dist/player', { recursive: true }); require('node:fs').writeFileSync('dist/player/index.html', 'built from ' + require('node:fs').readFileSync('marker.txt', 'utf8'));\n`;
const BASELINE = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (process.env.FAKE_BASELINE_EXIT) { console.error('PROBLEM: the player started on 360p'); process.exit(Number(process.env.FAKE_BASELINE_EXIT)); }
for (const profile of value('--profile').split(',')) {
  const dir = path.join(value('--baseline-dir'), 'test-env');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, profile + '.json'), JSON.stringify({
    cwd: process.cwd(), marker: fs.readFileSync('marker.txt', 'utf8'), page: fs.readFileSync('dist/player/index.html', 'utf8'),
    cache: process.env.PB_CACHE_DIR, gitCommit: process.env.PB_GIT_COMMIT ?? null, args,
  }));
}
`;

const git = (...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=control test',
      '-c',
      'user.email=control@test.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: HEAD,
      encoding: 'utf8',
    },
  ).trim();

function commit(marker: string, lock: string): string {
  mkdirSync(join(HEAD, 'scripts'), { recursive: true });
  writeFileSync(join(HEAD, 'package.json'), PACKAGE);
  writeFileSync(join(HEAD, 'package-lock.json'), lock);
  writeFileSync(join(HEAD, 'scripts', 'build-player.cjs'), BUILD);
  writeFileSync(join(HEAD, 'scripts', 'baseline.cjs'), BASELINE);
  writeFileSync(join(HEAD, 'marker.txt'), marker);
  git('add', '-A');
  git('commit', '-q', '-m', `commit ${marker}`);
  return git('rev-parse', 'HEAD');
}

let CONTROL_COMMIT = '';
let HEAD_COMMIT = '';
const real = realPairedDeps(() => undefined);
const deps = { ...real, tmpdir: () => SCRATCH };

const request = (overrides: Partial<ControlRequest> = {}): ControlRequest => ({
  headRoot: HEAD,
  envId: 'test-env',
  profiles: ['chromium', 'chromium-cpu4x'],
  controlRef: 'HEAD^1',
  controlDir: null,
  runs: 10,
  warmupRuns: 1,
  port: 4710,
  runTimeoutMs: 120_000,
  baseEnv: { ...process.env, PB_GIT_COMMIT: 'headfact', PB_GIT_DIRTY: '1' },
  ...overrides,
});

const worktrees = (): string[] =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));

beforeAll(() => {
  // A git hook or a rebase exports GIT_DIR and friends: with them the scratch repository below would be the real one.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(HEAD, { recursive: true });
  git('init', '-q', '-b', 'main');
  CONTROL_COMMIT = commit('the control', LOCK_A);
  HEAD_COMMIT = commit('the head', LOCK_A);
  // The head's installed dependencies: a marker is enough to tell the link from the real thing.
  mkdirSync(join(HEAD, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(HEAD, 'node_modules', 'dep', 'index.js'), '// the head\n');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('PB-PERF paired, for real: the control of two commits made ready and measured', () => {
  it("makes a worktree at the control commit, links the head's dependencies, builds, runs the control's script, and leaves nothing behind", async () => {
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(deps, request(), cleanup);
    expect(result.problem).toBeNull();
    expect(result).toMatchObject({ ok: true });
    expect(result.info).toMatchObject({
      controlCommit: CONTROL_COMMIT,
      headCommit: HEAD_COMMIT,
      aa: false,
      checkout: 'created',
      nodeModules: 'linked',
    });
    // The script ran in the control's checkout (the control's file, not the head's), after the control's own build, with what the gate gave it.
    const recorded = JSON.parse(
      readFileSync(join(result.baselineDir!, 'test-env', 'chromium.json'), 'utf8'),
    ) as {
      cwd: string;
      marker: string;
      page: string;
      cache: string;
      gitCommit: string | null;
      args: string[];
    };
    expect(recorded.marker).toBe('the control');
    expect(recorded.page).toBe('built from the control');
    expect(recorded.cwd.endsWith('/control')).toBe(true);
    expect(recorded.cache).toBe(join(HEAD, '.cache', 'streams'));
    expect(recorded.gitCommit).toBeNull();
    expect(recorded.args).toStrictEqual([
      '--profile',
      'chromium,chromium-cpu4x',
      '--runs',
      '10',
      '--warmup',
      '1',
      '--port',
      '4710',
      '--timeout-ms',
      '120000',
      '--baseline-dir',
      result.baselineDir,
      '--reports-dir',
      join(result.baselineDir!, '..', 'control-reports'),
    ]);
    expect(existsSync(join(result.baselineDir!, 'test-env', 'chromium-cpu4x.json'))).toBe(true);

    // The checkout is gone as soon as the control returns, the head's own files are untouched, and so is its list of worktrees.
    expect(worktrees()).toStrictEqual([HEAD]);
    expect(existsSync(join(result.baselineDir!, '..', 'control'))).toBe(false);
    expect(readFileSync(join(HEAD, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('// the head\n');
    expect(existsSync(join(HEAD, 'dist'))).toBe(false);
    // The temporary directory stays for the head's gate, and goes with the clean-up.
    const root = join(result.baselineDir!, '..');
    expect(existsSync(result.baselineDir!)).toBe(true);
    cleanup.disposeAll();
    expect(existsSync(root)).toBe(false);
  });

  it("is a failure, with the end of what the script said, and still leaves nothing behind, when the control's script exits 2", async () => {
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(
      deps,
      request({ baseEnv: { ...process.env, FAKE_BASELINE_EXIT: '2' } }),
      cleanup,
    );
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(
      /measuring the control \(chromium, chromium-cpu4x\) failed \(exit code 2\)[\s\S]*PROBLEM: the player started on 360p/,
    );
    expect(worktrees()).toStrictEqual([HEAD]);
    cleanup.disposeAll();
  });

  it("is an A/A by construction for the head's own commit, and measures it all the same", async () => {
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(deps, request({ controlRef: 'HEAD' }), cleanup);
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({ aa: true, controlCommit: HEAD_COMMIT });
    const recorded = JSON.parse(
      readFileSync(join(result.baselineDir!, 'test-env', 'chromium.json'), 'utf8'),
    ) as { marker: string };
    expect(recorded.marker).toBe('the head');
    cleanup.disposeAll();
    expect(worktrees()).toStrictEqual([HEAD]);
  });

  it('says what to do about a ref that is not there, and creates nothing', async () => {
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(deps, request({ controlRef: 'no-such-ref' }), cleanup);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/does not name a commit/);
    expect(worktrees()).toStrictEqual([HEAD]);
    cleanup.disposeAll();
  });

  it('uses the checkout it is given as it is, and never removes it', async () => {
    const given = join(SCRATCH, 'given');
    git('worktree', 'add', '-q', '--detach', given, 'HEAD^1');
    mkdirSync(join(given, 'perf'), { recursive: true });
    writeFileSync(join(given, 'perf', 'run.ts'), '// the harness\n');
    mkdirSync(join(given, 'node_modules'), { recursive: true });
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(deps, request({ controlRef: null, controlDir: given }), cleanup);
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({
      checkout: 'given',
      controlCommit: CONTROL_COMMIT,
      nodeModules: 'present',
    });
    cleanup.disposeAll();
    expect(existsSync(join(given, 'marker.txt'))).toBe(true);
    expect(worktrees()).toContain(given);
    git('worktree', 'remove', '--force', given);
  });

  it("installs the control's dependencies with npm ci when its lock file is not the head's", async () => {
    // A third commit whose lock file differs by one byte from its parent's, which is the control here (HEAD^1).
    writeFileSync(join(HEAD, 'package-lock.json'), `${LOCK_A} `);
    git('add', '-A');
    git('commit', '-q', '-m', 'a lock file of other bytes');
    const cleanup = new Cleanup(deps, HEAD);
    const result = await runControl(deps, request(), cleanup);
    expect(result.problem).toBeNull();
    expect(result.info.nodeModules).toBe('installed');
    expect(existsSync(join(result.baselineDir!, '..', 'control'))).toBe(false);
    cleanup.disposeAll();
    expect(worktrees()).toStrictEqual([HEAD]);
  });
});
