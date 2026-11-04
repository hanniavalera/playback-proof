import { describe, expect, it } from 'vitest';
import {
  Cleanup,
  DEFAULT_CONTROL_REF,
  PairedError,
  bindCleanupToSignals,
  buildPaired,
  comparePairedMachines,
  controlEnv,
  headOptions,
  inspectControlDir,
  measureArgs,
  nodeModulesPlan,
  pairedExitCode,
  pairedLine,
  readHeadCommit,
  refProblem,
  resolveCommit,
  runControl,
  sameBytes,
  withControlModel,
} from '../../../src/lab/measure/paired.ts';
import type {
  ControlRequest,
  ControlResult,
  ExecOptions,
  ExecResult,
  PairedDeps,
  SignalSource,
} from '../../../src/lab/measure/paired.ts';
import { STARTUP, baselineOf, startupBatch } from './fixtures.ts';

// The paired gate's core with every effect injected: a small simulated machine (git, npm, a file system, a clock) that records what was run,
// where and in which environment, so that the plan of steps, the clean-up on every path and the decisions are tested with no repository, no
// package manager and no browser.

const HEAD = '/work/head';
const HEAD_SHA = 'a'.repeat(40);
const CONTROL_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const TMP = '/scratch';
const ROOT = `${TMP}/pb-paired-000001`;
const CONTROL_DIR = `${ROOT}/control`;
const LOCK = '{"lockfileVersion": 3}\n';

interface Event {
  kind: 'run' | 'runSync' | 'remove' | 'symlink' | 'mkdtemp' | 'mkdir';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  path?: string;
  target?: string;
}

interface Failures {
  worktreeAdd?: boolean;
  worktreeRemove?: boolean;
  worktreeRemoveThrows?: boolean;
  npmCi?: number;
  build?: number;
  measure?: number;
  /** The measurement exits 0 but writes nothing. */
  noBaselines?: boolean;
  /** `run` rejects: the command cannot be started. */
  cannotStart?: string;
  removeThrows?: string;
  mkdtempThrows?: boolean;
}

function world(
  options: {
    headLock?: string | null;
    controlLock?: string | null;
    headHasNodeModules?: boolean;
    refs?: Record<string, string>;
    failures?: Failures;
    cpu?: string | undefined;
    checkouts?: Record<string, string>;
    controlDirHasNodeModules?: boolean;
    controlDirHasHarness?: boolean;
    /** What the measurement waits for before it ends (an interrupt), instead of ending at once. */
    holdMeasure?: boolean;
  } = {},
) {
  const events: Event[] = [];
  const files = new Map<string, string>();
  const dirs = new Set<string>([HEAD]);
  const links = new Map<string, string>();
  const logs: string[] = [];
  const state = { time: 0, running: 0, maxRunning: 0 };
  const refs = options.refs ?? { [DEFAULT_CONTROL_REF]: CONTROL_SHA, 'HEAD^1': CONTROL_SHA, HEAD: HEAD_SHA };
  const failures = options.failures ?? {};
  if (options.headLock !== null) files.set(`${HEAD}/package-lock.json`, options.headLock ?? LOCK);
  if (options.headHasNodeModules !== false) dirs.add(`${HEAD}/node_modules`);
  const checkouts = options.checkouts ?? {};
  for (const dir of Object.keys(checkouts)) {
    dirs.add(dir);
    if (options.controlDirHasHarness !== false) files.set(`${dir}/perf/run.ts`, '// harness');
    if (options.controlDirHasNodeModules) dirs.add(`${dir}/node_modules`);
    files.set(`${dir}/package-lock.json`, options.controlLock ?? LOCK);
  }
  const startsWith = (path: string, prefix: string): boolean =>
    path === prefix || path.startsWith(`${prefix}/`);
  const present = (path: string): boolean => files.has(path) || dirs.has(path) || links.has(path);

  const removeTree = (path: string): void => {
    for (const map of [files, links] as const)
      for (const key of [...map.keys()]) if (startsWith(key, path)) map.delete(key);
    for (const key of [...dirs]) if (startsWith(key, path)) dirs.delete(key);
  };

  const git = (args: readonly string[], cwd: string | undefined): ExecResult | null => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const sha = cwd === HEAD ? HEAD_SHA : cwd !== undefined ? checkouts[cwd] : undefined;
      return sha
        ? { code: 0, stdout: `${sha}\n`, stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = String(args[3]).replace(/\^\{commit\}$/, '');
      const sha = refs[ref];
      if (ref === 'garbage') return { code: 0, stdout: 'not a commit id\n', stderr: '' };
      return sha ? { code: 0, stdout: `${sha}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (cwd !== undefined && checkouts[cwd]) return { code: 0, stdout: `${cwd}\n`, stderr: '' };
      // A directory inside another checkout reports the top of that one.
      return cwd !== undefined && present(cwd)
        ? { code: 0, stdout: `${HEAD}\n`, stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (failures.worktreeRemoveThrows) throw new Error('git: command not found');
      if (failures.worktreeRemove) return { code: 1, stdout: '', stderr: 'fatal: cannot remove' };
      removeTree(String(args[3]));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'prune') return { code: 0, stdout: '', stderr: '' };
    return null;
  };

  const record = (
    kind: 'run' | 'runSync',
    command: string,
    args: readonly string[],
    opts: ExecOptions | undefined,
  ): void => {
    events.push({
      kind,
      command,
      args: [...args],
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  };

  const durations = { worktree: 1_000, install: 20_000, build: 4_000, measure: 90_000 };

  const deps: PairedDeps = {
    run: async (command, args, opts) => {
      record('run', command, args, opts);
      if (failures.cannotStart) throw new Error(failures.cannotStart);
      state.running += 1;
      state.maxRunning = Math.max(state.maxRunning, state.running);
      try {
        await Promise.resolve();
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
          if (failures.worktreeAdd)
            return { code: 128, stdout: '', stderr: 'fatal: could not create the worktree' };
          const dir = String(args[3]);
          dirs.add(dir);
          files.set(`${dir}/perf/run.ts`, '// harness');
          if (options.controlLock !== null)
            files.set(`${dir}/package-lock.json`, options.controlLock ?? LOCK);
          state.time += durations.worktree;
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'ci') {
          state.time += durations.install;
          if (failures.npmCi)
            return { code: failures.npmCi, stdout: '', stderr: 'npm ERR! lock file out of date' };
          dirs.add(`${opts?.cwd}/node_modules`);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'run' && args[1] === 'build:player') {
          state.time += durations.build;
          return failures.build
            ? { code: failures.build, stdout: '', stderr: 'esbuild: error: could not resolve' }
            : { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'run' && args[1] === 'perf:baseline') {
          if (options.holdMeasure) {
            await new Promise<void>((resolve) => {
              if (opts?.signal?.aborted) resolve();
              opts?.signal?.addEventListener('abort', () => resolve());
            });
            return { code: 143, stdout: '', stderr: 'terminated' };
          }
          state.time += durations.measure;
          if (failures.measure)
            return {
              code: failures.measure,
              stdout: 'PB-PERF-004 on chromium-cpu4x: the player started on 360p',
              stderr: 'PROBLEM: x',
            };
          if (!failures.noBaselines) {
            const dir = args[args.indexOf('--baseline-dir') + 1] as string;
            const profiles = (args[args.indexOf('--profile') + 1] as string).split(',');
            for (const profile of profiles) files.set(`${dir}/gha-linux-x64/${profile}.json`, '{}');
          }
          return { code: 0, stdout: 'wrote the baselines', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      } finally {
        state.running -= 1;
      }
    },
    runSync: (command, args, opts) => {
      record('runSync', command, args, opts);
      if (command === 'git') {
        const result = git(args, opts?.cwd);
        if (result) return result;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    exists: present,
    readBytes: (path) => (files.has(path) ? new TextEncoder().encode(files.get(path)) : null),
    mkdtemp: (prefix) => {
      if (failures.mkdtempThrows) throw new Error('no space left on device');
      const path = `${prefix}000001`;
      events.push({ kind: 'mkdtemp', path });
      dirs.add(path);
      return path;
    },
    mkdir: (path) => {
      events.push({ kind: 'mkdir', path });
      dirs.add(path);
    },
    symlink: (target, path) => {
      events.push({ kind: 'symlink', path, target });
      links.set(path, target);
    },
    remove: (path) => {
      events.push({ kind: 'remove', path });
      if (failures.removeThrows) throw new Error(failures.removeThrows);
      removeTree(path);
    },
    realpath: (path) => path.replace(/\/$/, ''),
    tmpdir: () => TMP,
    now: () => state.time,
    cpuModel: () => ('cpu' in options ? options.cpu : 'AMD EPYC 9V74 80-Core Processor'),
    log: (line) => logs.push(line),
  };
  const commands = (): string[] =>
    events
      .filter((event) => event.kind === 'run' || event.kind === 'runSync')
      .map((event) => `${event.command} ${(event.args ?? []).join(' ')}`);
  return { deps, events, files, dirs, links, logs, state, durations, commands, present };
}

const request = (overrides: Partial<ControlRequest> = {}): ControlRequest => ({
  headRoot: HEAD,
  envId: 'gha-linux-x64',
  profiles: ['chromium', 'chromium-cpu4x'],
  controlRef: null,
  controlDir: null,
  runs: 10,
  warmupRuns: 1,
  port: 4710,
  runTimeoutMs: 120_000,
  baseEnv: { PATH: '/usr/bin', CI: 'true' },
  ...overrides,
});

async function control(
  w: ReturnType<typeof world>,
  overrides: Partial<ControlRequest> = {},
  signal?: AbortSignal,
): Promise<{ result: ControlResult; cleanup: Cleanup }> {
  const cleanup = new Cleanup(w.deps, HEAD);
  const result = await runControl(w.deps, request(overrides), cleanup, signal);
  return { result, cleanup };
}

const call = (w: ReturnType<typeof world>, prefix: string): Event | undefined =>
  w.events.find((event) => `${event.command} ${(event.args ?? []).join(' ')}`.startsWith(prefix));

describe('PB-PERF paired: choosing the control commit', () => {
  it('takes origin/main when nothing is said, and resolves it to a commit of this checkout', async () => {
    const w = world();
    const { result } = await control(w);
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({
      controlRef: 'origin/main',
      controlCommit: CONTROL_SHA,
      headCommit: HEAD_SHA,
    });
    expect(call(w, 'git rev-parse --verify --quiet origin/main^{commit}')?.cwd).toBe(HEAD);
  });

  it('takes the ref it is given, a base commit of a pull request for one', async () => {
    const w = world();
    const { result } = await control(w, { controlRef: 'HEAD^1' });
    expect(result.info).toMatchObject({ controlRef: 'HEAD^1', controlCommit: CONTROL_SHA });
    expect(call(w, 'git rev-parse --verify --quiet HEAD^1^{commit}')).toBeDefined();
  });

  it('refuses an unknown ref with the way to fix it, and creates nothing', async () => {
    const w = world({ refs: {} });
    const { result, cleanup } = await control(w);
    expect(result).toMatchObject({ ok: false, baselineDir: null });
    expect(result.problem).toMatch(/the control ref "origin\/main" does not name a commit/);
    expect(result.problem).toMatch(/git fetch origin main/);
    expect(result.problem).toMatch(/fetch-depth: 0/);
    expect(w.events.some((event) => event.kind === 'mkdtemp')).toBe(false);
    expect(w.commands().some((command) => command.startsWith('git worktree add'))).toBe(false);
    cleanup.disposeAll();
    expect(w.events.some((event) => event.kind === 'remove')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['an option for git', '--upload-pack=evil'],
    ['starting with a dash', '-x'],
    ['with whitespace', 'origin main'],
    ['with a control character', 'main\u0000'],
  ])('refuses a ref that is %s before git is asked anything', (_name, ref) => {
    const w = world();
    expect(refProblem(ref)).not.toBeNull();
    expect(() => resolveCommit(w.deps, HEAD, ref)).toThrow(PairedError);
    expect(w.commands()).toStrictEqual([]);
  });

  it('accepts the usual refs', () => {
    for (const ref of ['origin/main', 'HEAD^1', 'refs/pull/7/merge', 'v1.2.3', 'main~2', 'a'.repeat(40)])
      expect(refProblem(ref), ref).toBeNull();
  });

  it('does not take what git printed for a commit when it is not a commit id', () => {
    const w = world({ refs: { garbage: CONTROL_SHA } });
    expect(() => resolveCommit(w.deps, HEAD, 'garbage')).toThrow(/does not name a commit/);
  });

  it('says so when the commit of this checkout cannot be read, and measures nothing', async () => {
    const w = world();
    w.deps.runSync = () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories)',
    });
    const { result } = await control(w);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/cannot read the commit of this checkout .*not a git repository/);
    expect(w.events.some((event) => event.kind === 'run')).toBe(false);
    expect(() => readHeadCommit(w.deps, HEAD)).toThrow(PairedError);
  });
});

describe('PB-PERF paired: an A/A by construction', () => {
  it('says so when the control is the head, and still measures both: the whole sequence runs', async () => {
    const w = world({ refs: { HEAD: HEAD_SHA } });
    const { result } = await control(w, { controlRef: 'HEAD' });
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({ aa: true, controlCommit: HEAD_SHA, headCommit: HEAD_SHA });
    expect(w.commands().some((command) => command.startsWith('npm run perf:baseline'))).toBe(true);
    expect(pairedLine(HEAD_SHA, true)).toContain('(A/A by construction: the control is this very commit)');
  });

  it('is not an A/A when the control is another commit', async () => {
    const w = world();
    const { result } = await control(w);
    expect(result.info.aa).toBe(false);
    expect(pairedLine(CONTROL_SHA, false)).not.toContain('A/A');
  });

  it("is an A/A when a given checkout is at the head, by the checkout's own commit", async () => {
    const w = world({ checkouts: { '/work/main': HEAD_SHA } });
    const { result } = await control(w, { controlDir: '/work/main' });
    expect(result.info).toMatchObject({ aa: true, controlCommit: HEAD_SHA, checkout: 'given' });
  });
});

describe("PB-PERF paired: the control's dependencies", () => {
  it.each([
    [{ controlHasNodeModules: true, lockFilesEqual: false, headHasNodeModules: false }, 'keep'],
    [{ controlHasNodeModules: true, lockFilesEqual: true, headHasNodeModules: true }, 'keep'],
    [{ controlHasNodeModules: false, lockFilesEqual: true, headHasNodeModules: true }, 'link'],
    [{ controlHasNodeModules: false, lockFilesEqual: false, headHasNodeModules: true }, 'install'],
    [{ controlHasNodeModules: false, lockFilesEqual: true, headHasNodeModules: false }, 'install'],
    [{ controlHasNodeModules: false, lockFilesEqual: false, headHasNodeModules: false }, 'install'],
  ] as const)('%j needs: %s', (facts, plan) => {
    expect(nodeModulesPlan(facts)).toBe(plan);
  });

  it('compares lock files by their bytes', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(sameBytes(bytes(LOCK), bytes(LOCK))).toBe(true);
    expect(sameBytes(bytes(LOCK), bytes(`${LOCK}\n`))).toBe(false);
    expect(sameBytes(bytes('{"a": 1}'), bytes('{"a": 2}'))).toBe(false);
    expect(sameBytes(bytes(LOCK), null)).toBe(false);
    expect(sameBytes(null, null)).toBe(false);
  });

  it("links the head's node_modules when the lock files are the same: no install", async () => {
    const w = world();
    const { result } = await control(w);
    expect(result.info.nodeModules).toBe('linked');
    expect(w.events.filter((event) => event.kind === 'symlink')).toStrictEqual([
      { kind: 'symlink', path: `${CONTROL_DIR}/node_modules`, target: `${HEAD}/node_modules` },
    ]);
    expect(w.commands().some((command) => command.startsWith('npm ci'))).toBe(false);
  });

  it('installs when the lock files differ by a single byte: a link would give the control the wrong dependencies', async () => {
    const w = world({ controlLock: `${LOCK}\n` });
    const { result } = await control(w);
    expect(result.info.nodeModules).toBe('installed');
    expect(call(w, 'npm ci --no-audit --no-fund')).toMatchObject({ cwd: CONTROL_DIR });
    expect(w.events.some((event) => event.kind === 'symlink')).toBe(false);
  });

  it('installs when the control has no lock file, and when the head has no node_modules to link to', async () => {
    const noLock = world({ controlLock: null });
    expect((await control(noLock)).result.info.nodeModules).toBe('installed');
    const noModules = world({ headHasNodeModules: false });
    expect((await control(noModules)).result.info.nodeModules).toBe('installed');
    expect(noModules.events.some((event) => event.kind === 'symlink')).toBe(false);
  });

  it('leaves a given checkout that has its dependencies alone', async () => {
    const w = world({ checkouts: { '/work/main': CONTROL_SHA }, controlDirHasNodeModules: true });
    const { result } = await control(w, { controlDir: '/work/main' });
    expect(result.info.nodeModules).toBe('present');
    expect(w.commands().some((command) => command.startsWith('npm ci'))).toBe(false);
    expect(w.events.some((event) => event.kind === 'symlink')).toBe(false);
  });
});

describe('PB-PERF paired: the sequence of steps', () => {
  it('creates the control checkout, links the dependencies, builds the page, measures, and removes the checkout, in that order', async () => {
    const w = world();
    const { result } = await control(w);
    expect(result.ok).toBe(true);
    expect(w.commands()).toStrictEqual([
      'git rev-parse HEAD',
      `git rev-parse --verify --quiet origin/main^{commit}`,
      `git worktree add --detach ${CONTROL_DIR} ${CONTROL_SHA}`,
      'npm run build:player',
      `npm run perf:baseline -- --profile chromium,chromium-cpu4x --runs 10 --warmup 1 --port 4710 --timeout-ms 120000 --baseline-dir ${ROOT}/baselines --reports-dir ${ROOT}/control-reports`,
      `git worktree remove --force ${CONTROL_DIR}`,
    ]);
    expect(call(w, 'git worktree add')?.cwd).toBe(HEAD);
    expect(call(w, 'npm run build:player')?.cwd).toBe(CONTROL_DIR);
    expect(call(w, 'npm run perf:baseline')?.cwd).toBe(CONTROL_DIR);
    expect(result.baselineDir).toBe(`${ROOT}/baselines`);
  });

  it('puts the control at the CONTROL commit and its baselines where the head will read them, and never the other way round', async () => {
    const w = world({ refs: { [DEFAULT_CONTROL_REF]: OTHER_SHA } });
    const { result } = await control(w);
    expect(call(w, 'git worktree add')?.args).toStrictEqual([
      'worktree',
      'add',
      '--detach',
      CONTROL_DIR,
      OTHER_SHA,
    ]);
    expect(call(w, 'git worktree add')?.args).not.toContain(HEAD_SHA);
    const measure = call(w, 'npm run perf:baseline')!;
    expect(measure.args![measure.args!.indexOf('--baseline-dir') + 1]).toBe(result.baselineDir);
    expect(measure.args![measure.args!.indexOf('--reports-dir') + 1]).toBe(`${ROOT}/control-reports`);
    expect(w.files.has(`${result.baselineDir}/gha-linux-x64/chromium.json`)).toBe(true);
    expect(w.files.has(`${result.baselineDir}/gha-linux-x64/chromium-cpu4x.json`)).toBe(true);
  });

  it("measures with the head's own N, warm-up, port and timeout, and with no injection", async () => {
    const w = world();
    await control(w, { runs: 7, warmupRuns: 0, port: 4715, runTimeoutMs: 90_000, profiles: ['firefox'] });
    const args = call(w, 'npm run perf:baseline')!.args!.join(' ');
    expect(args).toContain('--profile firefox --runs 7 --warmup 0 --port 4715 --timeout-ms 90000');
    expect(args).not.toContain('inject');
    expect(args).not.toContain('--write-baseline');
    expect(
      measureArgs({
        profiles: ['webkit', 'chromium'],
        runs: 3,
        warmupRuns: 1,
        port: 1,
        runTimeoutMs: 2,
        baselineDir: 'b',
        reportsDir: 'r',
      }),
    ).toStrictEqual([
      'run',
      'perf:baseline',
      '--',
      '--profile',
      'webkit,chromium',
      '--runs',
      '3',
      '--warmup',
      '1',
      '--port',
      '1',
      '--timeout-ms',
      '2',
      '--baseline-dir',
      'b',
      '--reports-dir',
      'r',
    ]);
  });

  it('runs the steps one after another, never two at once', async () => {
    const w = world({ controlLock: `${LOCK} ` });
    await control(w);
    expect(w.state.maxRunning).toBe(1);
  });

  it("gives every command the head's stream cache (absolute) and not the head's git facts", async () => {
    const w = world();
    await control(w, {
      baseEnv: { PATH: '/usr/bin', PB_GIT_COMMIT: 'abc1234', PB_GIT_DIRTY: '1', PB_ENV_ID: 'x', CI: 'true' },
    });
    for (const event of w.events.filter((e) => e.kind === 'run')) {
      expect(event.env?.PB_CACHE_DIR, event.command).toBe(`${HEAD}/.cache/streams`);
      expect(event.env).not.toHaveProperty('PB_GIT_COMMIT');
      expect(event.env).not.toHaveProperty('PB_GIT_DIRTY');
      expect(event.env).toMatchObject({ PATH: '/usr/bin', PB_ENV_ID: 'x', CI: 'true' });
    }
  });

  it('keeps a stream cache the caller named, and makes a relative one absolute against the head', () => {
    expect(controlEnv({ PB_CACHE_DIR: '/cache/streams' }, HEAD).PB_CACHE_DIR).toBe('/cache/streams');
    expect(controlEnv({ PB_CACHE_DIR: 'streams' }, HEAD).PB_CACHE_DIR).toBe(`${HEAD}/streams`);
    expect(controlEnv({}, HEAD).PB_CACHE_DIR).toBe(`${HEAD}/.cache/streams`);
  });

  it('keeps the time of the preparation and of the measurement apart', async () => {
    const w = world({ controlLock: `${LOCK} ` });
    const { result } = await control(w);
    // The checkout, the install and the build are the preparation; the measurement is what the control's harness took.
    expect(result.info.wallMs).toStrictEqual({
      controlPrepare: w.durations.worktree + w.durations.install + w.durations.build,
      controlMeasure: w.durations.measure,
    });
  });

  it('gives each step a limit of its own, so that a hung one does not use the whole job', async () => {
    const w = world({ controlLock: `${LOCK} ` });
    await control(w);
    expect(call(w, 'npm ci')?.timeoutMs).toBe(10 * 60_000);
    expect(call(w, 'npm run build:player')?.timeoutMs).toBe(5 * 60_000);
    expect(call(w, 'npm run perf:baseline')?.timeoutMs).toBe(60 * 60_000);
  });

  it('uses a given checkout as it is: nothing created for it and nothing removed of it', async () => {
    const w = world({ checkouts: { '/work/main': CONTROL_SHA }, controlDirHasNodeModules: true });
    const { result, cleanup } = await control(w, { controlDir: '/work/main' });
    expect(result.ok).toBe(true);
    expect(result.info).toMatchObject({
      checkout: 'given',
      controlDir: '/work/main',
      controlRef: null,
      controlCommit: CONTROL_SHA,
    });
    expect(w.commands().some((command) => command.startsWith('git worktree'))).toBe(false);
    expect(call(w, 'npm run build:player')?.cwd).toBe('/work/main');
    expect(call(w, 'npm run perf:baseline')?.cwd).toBe('/work/main');
    cleanup.disposeAll();
    expect(w.present('/work/main')).toBe(true);
    expect(w.present('/work/main/perf/run.ts')).toBe(true);
    expect(w.present(ROOT)).toBe(false);
  });

  it('refuses a given checkout and a ref that name different commits: measuring the wrong control is the one mistake that lies', async () => {
    const w = world({ checkouts: { '/work/main': OTHER_SHA } });
    const { result } = await control(w, { controlDir: '/work/main', controlRef: 'origin/main' });
    expect(result.ok).toBe(false);
    expect(result.problem).toBe(
      `--control-dir /work/main is at ${OTHER_SHA.slice(0, 12)}, but --control-ref origin/main is ${CONTROL_SHA.slice(0, 12)}: they must name the same commit`,
    );
    expect(w.events.some((event) => event.kind === 'mkdtemp')).toBe(false);
  });

  it.each([
    ['a directory that is not there', {}, '/work/nowhere', /does not exist/],
    [
      'a directory that is not the top of a checkout (inside the head, say)',
      {},
      `${HEAD}/sub`,
      /is not the top of a git checkout/,
    ],
    [
      'a checkout of something else: no perf/run.ts',
      { controlDirHasHarness: false },
      '/work/other',
      /is not a checkout of this project/,
    ],
  ])('refuses %s as the control', async (_name, options, dir, message) => {
    const w = world({ checkouts: { '/work/other': CONTROL_SHA }, ...options });
    w.dirs.add(`${HEAD}/sub`);
    expect(() => inspectControlDir(w.deps, dir)).toThrow(message);
    const { result } = await control(w, { controlDir: dir });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(message);
    expect(w.events.some((event) => event.kind === 'mkdtemp' || event.kind === 'run')).toBe(false);
  });
});

describe('PB-PERF paired: what is left behind', () => {
  it.each([
    [
      'the control checkout cannot be created',
      { worktreeAdd: true },
      /creating the control checkout of b{12} failed \(exit code 128\)/,
      ['git worktree add'],
    ],
    [
      'the dependencies cannot be installed',
      { npmCi: 1 },
      /npm ci\) failed \(exit code 1\)\nnpm ERR! lock file out of date/,
      ['npm ci'],
    ],
    [
      'the player page does not build',
      { build: 1 },
      /building the control's player page failed \(exit code 1\)\nesbuild: error/,
      ['npm run build:player'],
    ],
    [
      'the control measurement fails',
      { measure: 2 },
      /measuring the control \(chromium, chromium-cpu4x\) failed \(exit code 2\)\nPB-PERF-004 on chromium-cpu4x: the player started on 360p/,
      ['npm run perf:baseline'],
    ],
  ] as Array<[string, Failures, RegExp, string[]]>)(
    'removes the control checkout and, with disposeAll, everything else, when %s',
    async (_name, failures, message, ran) => {
      const w = world({ failures, ...(failures.npmCi ? { controlLock: `${LOCK} ` } : {}) });
      const { result, cleanup } = await control(w);
      expect(result).toMatchObject({ ok: false, baselineDir: null });
      expect(result.problem).toMatch(message);
      for (const prefix of ran) expect(call(w, prefix), prefix).toBeDefined();
      // The control checkout is gone as soon as the control returns; the head's own node_modules were never touched.
      expect(w.commands()).toContain(`git worktree remove --force ${CONTROL_DIR}`);
      expect(w.present(CONTROL_DIR)).toBe(false);
      expect(w.present(`${HEAD}/node_modules`)).toBe(true);
      // The temporary directory stays for the report and goes with disposeAll.
      expect(w.present(ROOT)).toBe(true);
      cleanup.disposeAll();
      expect(w.present(ROOT)).toBe(false);
    },
  );

  it('does not measure after a step before it failed', async () => {
    const w = world({ failures: { build: 1 } });
    await control(w);
    expect(call(w, 'npm run perf:baseline')).toBeUndefined();
  });

  it('is a failure, never a pass, when the measurement exits 0 but wrote no baseline for a profile', async () => {
    const w = world({ failures: { noBaselines: true } });
    const { result } = await control(w);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(
      /the control measurement wrote no baseline for chromium \(.*\/gha-linux-x64\/chromium\.json\)/,
    );
    expect(w.commands()).toContain(`git worktree remove --force ${CONTROL_DIR}`);
  });

  it('keeps the time spent before the failure, in the part of the run it was spent in', async () => {
    const w = world({ failures: { measure: 2 }, controlLock: `${LOCK} ` });
    const { result } = await control(w);
    expect(result.info.wallMs.controlPrepare).toBe(
      w.durations.worktree + w.durations.install + w.durations.build,
    );
    expect(result.info.wallMs.controlMeasure).toBe(w.durations.measure);
    const early = world({ failures: { build: 1 } });
    expect((await control(early)).result.info.wallMs).toStrictEqual({
      controlPrepare: early.durations.worktree + early.durations.build,
      controlMeasure: 0,
    });
  });

  it('turns a command that cannot be started into a failure of the control, and still cleans up', async () => {
    const w = world({ failures: { cannotStart: 'spawn npm ENOENT' } });
    const { result, cleanup } = await control(w);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/could not be started: spawn npm ENOENT/);
    cleanup.disposeAll();
    expect(w.present(ROOT)).toBe(false);
    expect(w.present(CONTROL_DIR)).toBe(false);
  });

  it('removes the directory by hand and prunes when git cannot remove the worktree, or cannot be started', async () => {
    for (const failures of [{ worktreeRemove: true }, { worktreeRemoveThrows: true }] as const) {
      const w = world({ failures });
      const { cleanup } = await control(w);
      expect(w.present(CONTROL_DIR)).toBe(false);
      expect(w.events.some((event) => event.kind === 'remove' && event.path === CONTROL_DIR)).toBe(true);
      expect(w.commands()).toContain('git worktree prune');
      cleanup.disposeAll();
      expect(w.present(ROOT)).toBe(false);
    }
  });

  it("removes the link to the head's node_modules before the checkout, and never what the link points to", async () => {
    const w = world();
    const { cleanup } = await control(w);
    cleanup.disposeAll();
    const removals = w.events.filter(
      (event) => event.kind === 'remove' || (event.kind === 'runSync' && event.args?.[0] === 'worktree'),
    );
    expect(removals[0]).toMatchObject({ kind: 'remove', path: `${CONTROL_DIR}/node_modules` });
    expect(removals[1]).toMatchObject({
      kind: 'runSync',
      args: ['worktree', 'remove', '--force', CONTROL_DIR],
    });
    expect(w.present(`${HEAD}/node_modules`)).toBe(true);
    expect(w.links.size).toBe(0);
  });

  it('never throws from the clean-up, says what failed, and does it once', async () => {
    const w = world({ failures: { removeThrows: 'EBUSY: resource busy' } });
    const { cleanup } = await control(w);
    expect(() => cleanup.disposeAll()).not.toThrow();
    expect(w.logs.some((line) => line.includes('clean-up') && line.includes('EBUSY'))).toBe(true);
    const before = w.events.length;
    cleanup.disposeAll();
    cleanup.disposeWorktree();
    expect(w.events.length).toBe(before);
  });

  it('lets an unexpected error out, after the checkout it created is gone', async () => {
    const w = world();
    w.deps.exists = ((original) => (path: string) => {
      if (path === `${HEAD}/node_modules`) throw new Error('EACCES');
      return original(path);
    })(w.deps.exists);
    const cleanup = new Cleanup(w.deps, HEAD);
    await expect(runControl(w.deps, request(), cleanup)).rejects.toThrow('EACCES');
    expect(w.commands()).toContain(`git worktree remove --force ${CONTROL_DIR}`);
    cleanup.disposeAll();
    expect(w.present(ROOT)).toBe(false);
  });
});

describe('PB-PERF paired: an interrupt', () => {
  it('stops before the next step when the run was aborted, and cleans up', async () => {
    const w = world();
    const controller = new AbortController();
    const original = w.deps.run;
    w.deps.run = async (command, args, options) => {
      const result = await original(command, args, options);
      if (command === 'npm' && args[1] === 'build:player') controller.abort();
      return result;
    };
    const { result, cleanup } = await control(w, {}, controller.signal);
    expect(result).toMatchObject({ ok: false, problem: 'the paired run was interrupted' });
    expect(call(w, 'npm run perf:baseline')).toBeUndefined();
    expect(w.present(CONTROL_DIR)).toBe(false);
    cleanup.disposeAll();
    expect(w.present(ROOT)).toBe(false);
  });

  it('removes everything when a signal arrives in the middle of the measurement', async () => {
    const w = world({ holdMeasure: true });
    const controller = new AbortController();
    const cleanup = new Cleanup(w.deps, HEAD);
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const source: SignalSource = {
      once: (event, listener) => void listeners.set(event, listener),
      removeListener: (event) => void listeners.delete(event),
    };
    bindCleanupToSignals(source, {
      abort: () => controller.abort(),
      cleanup: () => cleanup.disposeAll(),
      exit: (code) => void exits.push(code),
      harnessRunning: () => false,
    });
    const running = runControl(w.deps, request(), cleanup, controller.signal);
    // Let the sequence reach the measurement, which waits for the signal.
    for (let index = 0; index < 20 && !call(w, 'npm run perf:baseline'); index += 1) await Promise.resolve();
    expect(call(w, 'npm run perf:baseline')).toBeDefined();
    expect(w.present(CONTROL_DIR)).toBe(true);
    listeners.get('SIGINT')!();
    const result = await running;
    expect(result).toMatchObject({ ok: false, problem: 'the paired run was interrupted' });
    expect(exits).toStrictEqual([130]);
    expect(w.present(CONTROL_DIR)).toBe(false);
    expect(w.present(ROOT)).toBe(false);
    expect(w.present(`${HEAD}/node_modules`)).toBe(true);
  });

  it("on SIGINT and SIGTERM aborts, cleans up and exits 130, unless the head's harness is running and exits by itself", () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const harnessRunning of [false, true]) {
        const listeners = new Map<string, () => void>();
        const calls: string[] = [];
        const release = bindCleanupToSignals(
          {
            once: (event, listener) => void listeners.set(event, listener),
            removeListener: (event) => void listeners.delete(event),
          },
          {
            abort: () => void calls.push('abort'),
            cleanup: () => void calls.push('cleanup'),
            exit: (code) => void calls.push(`exit ${code}`),
            harnessRunning: () => harnessRunning,
          },
        );
        expect([...listeners.keys()].sort()).toStrictEqual(['SIGINT', 'SIGTERM']);
        listeners.get(signal)!();
        expect(calls, `${signal} ${harnessRunning}`).toStrictEqual(
          harnessRunning ? ['abort', 'cleanup'] : ['abort', 'cleanup', 'exit 130'],
        );
        release();
        expect(listeners.size).toBe(0);
      }
    }
  });
});

describe('PB-PERF paired: what the head does with the control', () => {
  const options = { profiles: ['chromium'], runs: 10, baselineDir: null as string | null, injectOn: 'first' };

  it("reads the control's baselines where the committed ones would be, and changes nothing else", () => {
    expect(headOptions(options, '/scratch/pb-paired-000001/baselines')).toStrictEqual({
      ...options,
      baselineDir: '/scratch/pb-paired-000001/baselines',
    });
    expect(options.baselineDir).toBeNull();
  });

  it('gives a control that predates the CPU model the model of this machine, and leaves a recorded one alone', () => {
    const baseline = baselineOf([{ spec: STARTUP, batch: startupBatch([100, 110]) }]);
    expect(baseline.host.cpuModel).toBeUndefined();
    expect(withControlModel(baseline, 'AMD EPYC 9V74 80-Core Processor').host.cpuModel).toBe(
      'AMD EPYC 9V74 80-Core Processor',
    );
    expect(withControlModel(baseline, null)).toBe(baseline);
    const recorded = {
      ...baseline,
      host: { ...baseline.host, cpuModel: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz' },
    };
    expect(withControlModel(recorded, 'AMD EPYC 9V74 80-Core Processor').host.cpuModel).toBe(
      'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz',
    );
  });

  it('is exit 2 when the control could not be measured, whatever the profiles say, and otherwise what the profiles say', () => {
    expect(pairedExitCode(false, [])).toBe(2);
    expect(pairedExitCode(false, [0, 0])).toBe(2);
    expect(pairedExitCode(false, [1])).toBe(2);
    expect(pairedExitCode(true, [])).toBe(0);
    expect(pairedExitCode(true, [0, 0])).toBe(0);
    expect(pairedExitCode(true, [0, 2])).toBe(2);
    expect(pairedExitCode(true, [2, 1])).toBe(1);
  });
});

describe('PB-PERF paired: the fields of the report', () => {
  const XEON = 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz';
  const EPYC = 'AMD EPYC 9V74 80-Core Processor';
  const info = {
    controlRef: 'origin/main',
    controlCommit: CONTROL_SHA,
    headCommit: HEAD_SHA,
    checkout: 'created' as const,
    controlDir: null,
    aa: false,
    nodeModules: 'linked' as const,
    cpuModelAtControl: EPYC,
    wallMs: { controlPrepare: 25_000, controlMeasure: 370_000 },
  };

  it('names the control and the head, how the control came to be, and the time of each', () => {
    const paired = buildPaired(info, { recordedByControl: EPYC, head: EPYC, headMs: 380_000 });
    expect(paired).toMatchObject({
      controlRef: 'origin/main',
      controlCommit: CONTROL_SHA,
      headCommit: HEAD_SHA,
      checkout: 'created',
      controlDir: null,
      aa: false,
      nodeModules: 'linked',
      wallMs: { controlPrepare: 25_000, controlMeasure: 370_000, head: 380_000 },
    });
    expect(paired.controlCommit).not.toBe(paired.headCommit);
  });

  it('opens with the same line in every format: the baseline was measured here, minutes ago, from this commit', () => {
    const paired = buildPaired(info, { recordedByControl: EPYC, head: EPYC, headMs: 1 });
    expect(paired.line).toBe(
      `paired: the baseline was measured on this machine minutes ago from ${CONTROL_SHA.slice(0, 12)}; the committed baselines of this environment were not used`,
    );
    expect(
      buildPaired(
        { ...info, aa: true, controlCommit: HEAD_SHA },
        { recordedByControl: EPYC, head: EPYC, headMs: 1 },
      ).line,
    ).toBe(
      `paired: the baseline was measured on this machine minutes ago from ${HEAD_SHA.slice(0, 12)}; the committed baselines of this environment were not used (A/A by construction: the control is this very commit)`,
    );
    expect(pairedLine(null, false)).toBe(
      'paired: no control was measured on this machine; the committed baselines of this environment were not used',
    );
  });

  it('says the control and the head ran on one CPU model, with no warning', () => {
    expect(
      comparePairedMachines({ recordedByControl: EPYC, readBeforeControl: EPYC, head: EPYC }),
    ).toStrictEqual({
      control: EPYC,
      head: EPYC,
      same: true,
      warning: null,
    });
  });

  it('prints a loud finding, and keeps both names, when they ran on different CPU models', () => {
    const models = comparePairedMachines({ recordedByControl: XEON, readBeforeControl: EPYC, head: EPYC });
    expect(models).toMatchObject({ control: XEON, head: EPYC, same: false });
    expect(models.warning).toBe(
      `THE CONTROL AND THE HEAD DID NOT RUN ON THE SAME CPU MODEL (${XEON} and ${EPYC}): they were meant to share one machine, so this comparison is not paired. The verdict is what the numbers say; read it with that in mind`,
    );
    expect(buildPaired(info, { recordedByControl: XEON, head: EPYC, headMs: 1 }).cpuModels.same).toBe(false);
  });

  it('takes the model the gate read before the control for a control that recorded none, and does not guess when either is unknown', () => {
    expect(
      comparePairedMachines({ recordedByControl: undefined, readBeforeControl: EPYC, head: EPYC }),
    ).toMatchObject({
      control: EPYC,
      same: true,
    });
    expect(
      comparePairedMachines({ recordedByControl: undefined, readBeforeControl: null, head: EPYC }),
    ).toStrictEqual({
      control: null,
      head: EPYC,
      same: null,
      warning: null,
    });
    expect(
      comparePairedMachines({ recordedByControl: XEON, readBeforeControl: null, head: undefined }),
    ).toMatchObject({
      same: null,
      warning: null,
    });
  });

  it('reads the model of this machine before it starts the control', async () => {
    const w = world({ cpu: 'AMD EPYC 7763 64-Core Processor' });
    expect((await control(w)).result.info.cpuModelAtControl).toBe('AMD EPYC 7763 64-Core Processor');
    expect((await control(world({ cpu: undefined }))).result.info.cpuModelAtControl).toBeNull();
  });
});
