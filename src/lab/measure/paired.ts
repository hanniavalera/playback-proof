import { join, resolve } from 'node:path';
import { baselinePath } from './baseline.ts';
import type { Baseline } from './baseline.ts';
import { combineExitCodes } from './decide.ts';
import type { ExitCode } from './decide.ts';
import type { PerfProfile } from './types.ts';

// The paired gate (ADR-179). On a shared runner a committed baseline is a measurement of ONE machine, and the next job may land on
// another: the gate judges the head against a CONTROL (the base build) that it measured on this very machine minutes before, with the
// same rules, thresholds, stability limit and confirm-on-regression. This file is the part of that which has decisions in it, with every
// effect (git, npm, the file system, the clock, the signals) injected, so that it is tested without a repository, a package manager or a
// browser: resolving the control, the plan of steps that makes a checkout of it ready and measures it, the clean-up on every path, the
// A/A by construction, the comparison of the machines, the exit code and the fields of the report. perf/paired-deps.ts has the real effects
// and perf/gate.ts the wiring.

/** The control of a pull request when nothing else is said: the tip of the base branch. */
export const DEFAULT_CONTROL_REF = 'origin/main';

/** What each step may take before it is stopped: the job's own timeout is the net under these, a hung step should not use all of it. */
export const STEP_TIMEOUT_MS = { install: 10 * 60_000, build: 5 * 60_000, measure: 60 * 60_000 } as const;

export type PairedProblem =
  | 'bad-ref'
  | 'unknown-ref'
  | 'no-git'
  | 'bad-control-dir'
  | 'control-mismatch'
  | 'step-failed'
  | 'interrupted'
  | 'no-baseline';

/** The control could not be made ready or measured: the gate cannot be trusted (exit code 2), and `message` says what to do. */
export class PairedError extends Error {
  override name = 'PairedError';
  readonly problem: PairedProblem;
  constructor(problem: PairedProblem, message: string) {
    super(message);
    this.problem = problem;
  }
}

// ---------------------------------------------------------------------------------------------------------------------- effects

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stops the command (and what it started) when aborted. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PairedDeps {
  /** Runs a command to its end. Resolves with its exit code, also a non-zero one; rejects only when it cannot be started. */
  run(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** The same, synchronously: for the questions put to git and for the clean-up, which also runs in a signal handler. */
  runSync(command: string, args: readonly string[], options?: ExecOptions): ExecResult;
  exists(path: string): boolean;
  /** The bytes of a file, or null when it is not there. */
  readBytes(path: string): Uint8Array | null;
  mkdtemp(prefix: string): string;
  mkdir(path: string): void;
  symlink(target: string, path: string): void;
  /** Removes a file, a directory tree or a symbolic link (the link itself, never what it points to). Not an error when it is not there. */
  remove(path: string): void;
  realpath(path: string): string;
  tmpdir(): string;
  now(): number;
  cpuModel(): string | undefined;
  log(line: string): void;
}

// -------------------------------------------------------------------------------------------------------------------- the control

/** Why `ref` cannot be handed to git as a ref, or null. A ref that starts with a dash would be read by git as an option. */
export function refProblem(ref: string): string | null {
  if (ref.trim() === '') return 'is empty';
  if (ref.startsWith('-')) return 'must not start with a dash';
  if (/\s/.test(ref)) return 'must not contain whitespace';
  if ([...ref].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return 'must not contain control characters';
  return null;
}

const COMMIT = /^[0-9a-f]{40,64}$/;

/** The commit of the checkout the gate runs in (the head). */
export function readHeadCommit(deps: PairedDeps, root: string): string {
  const head = deps.runSync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = head.stdout.trim();
  if (head.code !== 0 || !COMMIT.test(commit))
    throw new PairedError(
      'no-git',
      `cannot read the commit of this checkout (git rev-parse HEAD in ${root} failed${firstLine(head.stderr)}): the paired gate needs a git checkout`,
    );
  return commit;
}

/** `ref` as a commit of this repository. An unknown ref is a problem with the fix in its message, not a guess. */
export function resolveCommit(deps: PairedDeps, root: string, ref: string): string {
  const problem = refProblem(ref);
  if (problem !== null) throw new PairedError('bad-ref', `--control-ref ${problem}`);
  const found = deps.runSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
  const commit = found.stdout.trim();
  if (found.code !== 0 || !COMMIT.test(commit))
    throw new PairedError(
      'unknown-ref',
      `the control ref "${ref}" does not name a commit in this checkout. Fetch it (git fetch origin main), or pass --control-ref <commit> or --control-dir <checkout>. A shallow CI checkout needs fetch-depth: 0 for a branch name, or 2 for HEAD^1.`,
    );
  return commit;
}

/** An existing checkout given as the control: it must be the top of a git checkout of this project. Its commit is the control's. */
export function inspectControlDir(
  deps: PairedDeps,
  dir: string,
): { commit: string; hasNodeModules: boolean } {
  if (!deps.exists(dir)) throw new PairedError('bad-control-dir', `--control-dir ${dir} does not exist`);
  const top = deps.runSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0 || deps.realpath(top.stdout.trim()) !== deps.realpath(dir))
    throw new PairedError('bad-control-dir', `--control-dir ${dir} is not the top of a git checkout`);
  if (!deps.exists(join(dir, 'perf', 'run.ts')))
    throw new PairedError(
      'bad-control-dir',
      `--control-dir ${dir} is not a checkout of this project: it has no perf/run.ts, which records the control's baseline`,
    );
  const head = deps.runSync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  const commit = head.stdout.trim();
  if (head.code !== 0 || !COMMIT.test(commit))
    throw new PairedError('bad-control-dir', `cannot read the commit of --control-dir ${dir}`);
  return { commit, hasNodeModules: deps.exists(join(dir, 'node_modules')) };
}

// ---------------------------------------------------------------------------------------------------------------- making it ready

export type NodeModulesPlan = 'keep' | 'link' | 'install';

/**
 * What the control's dependencies need: nothing when its checkout already has them; a link to the head's when the two lock files are
 * byte for byte the same (the same dependencies, installed once); an `npm ci` otherwise (also when there is nothing to link to).
 */
export function nodeModulesPlan(facts: {
  controlHasNodeModules: boolean;
  lockFilesEqual: boolean;
  headHasNodeModules: boolean;
}): NodeModulesPlan {
  if (facts.controlHasNodeModules) return 'keep';
  return facts.lockFilesEqual && facts.headHasNodeModules ? 'link' : 'install';
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

/**
 * The environment of every command run in the control: the caller's, with the stream cache of the HEAD (an absolute path: the streams are
 * not generated again, and the harness refuses a changed stream) and without the git facts that `docker:pw` hands over for the head, which
 * would make the control's baseline claim the head's commit.
 */
export function controlEnv(base: NodeJS.ProcessEnv, headRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PB_CACHE_DIR: resolve(headRoot, base.PB_CACHE_DIR ?? join('.cache', 'streams')),
  };
  delete env.PB_GIT_COMMIT;
  delete env.PB_GIT_DIRTY;
  return env;
}

/** The control's own harness records its baseline: `npm run perf:baseline` with the same profiles, N, warm-up, port and timeout as the head. */
export function measureArgs(request: {
  profiles: readonly PerfProfile[];
  runs: number;
  warmupRuns: number;
  port: number;
  runTimeoutMs: number;
  baselineDir: string;
  reportsDir: string;
}): string[] {
  return [
    'run',
    'perf:baseline',
    '--',
    '--profile',
    request.profiles.join(','),
    '--runs',
    String(request.runs),
    '--warmup',
    String(request.warmupRuns),
    '--port',
    String(request.port),
    '--timeout-ms',
    String(request.runTimeoutMs),
    '--baseline-dir',
    request.baselineDir,
    '--reports-dir',
    request.reportsDir,
  ];
}

// -------------------------------------------------------------------------------------------------------------------- clean-up

/**
 * What the run created and has to remove, on every path: the control checkout (a detached worktree, with the link to the head's
 * node_modules that it may hold) and the temporary directory with the control's baselines. A checkout that the caller GAVE is never
 * tracked, so it is never removed. Idempotent, never throws: it also runs in a signal handler.
 */
export class Cleanup {
  private root: string | null = null;
  private worktree: string | null = null;
  private link: string | null = null;

  constructor(
    private readonly deps: Pick<PairedDeps, 'runSync' | 'remove' | 'exists' | 'log'>,
    private readonly headRoot: string,
  ) {}

  trackRoot(path: string): void {
    this.root = path;
  }

  trackWorktree(path: string): void {
    this.worktree = path;
  }

  trackLink(path: string): void {
    this.link = path;
  }

  /** The control checkout: its baselines are written and it is not needed any more. The link goes first, so that nothing follows it. */
  disposeWorktree(): void {
    const link = this.link;
    this.link = null;
    if (link !== null) this.attempt(() => this.deps.remove(link));
    const dir = this.worktree;
    this.worktree = null;
    if (dir === null) return;
    let removed: ExecResult = { code: 1, stdout: '', stderr: '' };
    try {
      removed = this.deps.runSync('git', ['worktree', 'remove', '--force', dir], { cwd: this.headRoot });
    } catch {
      // git could not be started: the directory is removed by hand below.
    }
    if (removed.code !== 0 || this.deps.exists(dir)) {
      this.attempt(() => this.deps.remove(dir));
      this.attempt(() => {
        this.deps.runSync('git', ['worktree', 'prune'], { cwd: this.headRoot });
      });
    }
  }

  disposeAll(): void {
    this.disposeWorktree();
    const root = this.root;
    this.root = null;
    if (root !== null) this.attempt(() => this.deps.remove(root));
  }

  private attempt(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.deps.log(`paired: clean-up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface SignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/**
 * On SIGINT and SIGTERM: stop what the control is running, remove what the run created, and exit (130) unless the head's harness is
 * running, which stops its service and exits by itself. Returns the function that takes the listeners off again.
 */
export function bindCleanupToSignals(
  source: SignalSource,
  actions: { abort(): void; cleanup(): void; exit(code: number): void; harnessRunning(): boolean },
): () => void {
  const listener = (): void => {
    actions.abort();
    actions.cleanup();
    if (!actions.harnessRunning()) actions.exit(130);
  };
  source.once('SIGINT', listener);
  source.once('SIGTERM', listener);
  return () => {
    source.removeListener('SIGINT', listener);
    source.removeListener('SIGTERM', listener);
  };
}

// ----------------------------------------------------------------------------------------------------------------------- the run

export interface ControlRequest {
  /** The checkout the gate runs in: the head. */
  headRoot: string;
  /** `detectEnvId()`: the control's baselines are looked for under it. */
  envId: string;
  profiles: readonly PerfProfile[];
  controlRef: string | null;
  controlDir: string | null;
  runs: number;
  warmupRuns: 0 | 1;
  port: number;
  runTimeoutMs: number;
  /** The environment of the gate: the control's commands get it with `controlEnv`'s changes. */
  baseEnv: NodeJS.ProcessEnv;
}

export interface ControlInfo {
  /** The ref the control was resolved from: the default when none was given; null when only a checkout was given. */
  controlRef: string | null;
  controlCommit: string | null;
  headCommit: string | null;
  checkout: 'created' | 'given';
  /** The directory that was given; null for a checkout created for the run (a temporary path that is gone afterwards). */
  controlDir: string | null;
  /** The control is the head: an A/A by construction. */
  aa: boolean;
  nodeModules: 'linked' | 'installed' | 'present' | null;
  /** The CPU model the gate read before it started the control: the machine the control ran on. */
  cpuModelAtControl: string | null;
  wallMs: { controlPrepare: number; controlMeasure: number };
}

export interface ControlResult {
  ok: boolean;
  /** Why the control could not be measured, when it could not. */
  problem: string | null;
  /** Where the control's baselines are (`<dir>/<envId>/<profile>.json`), while the run's temporary directory exists. */
  baselineDir: string | null;
  info: ControlInfo;
}

const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : `: ${line.trim()}`;
};

/** The last lines of what a failed step said, for the message: the reason is almost always at the end. */
function tailOf(result: ExecResult): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-12);
  return lines.length === 0 ? '' : `\n${lines.join('\n')}`;
}

async function step(
  deps: PairedDeps,
  name: string,
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  if (options.signal?.aborted) throw new PairedError('interrupted', 'the paired run was interrupted');
  deps.log(`paired: ${name}`);
  let result: ExecResult;
  try {
    result = await deps.run(command, args, options);
  } catch (error) {
    throw new PairedError(
      'step-failed',
      `${name} could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (options.signal?.aborted) throw new PairedError('interrupted', 'the paired run was interrupted');
  if (result.code !== 0)
    throw new PairedError('step-failed', `${name} failed (exit code ${result.code})${tailOf(result)}`);
  return result;
}

/**
 * Makes a checkout of the control ready and measures it: the control's own harness records its baseline for the profiles, in a
 * temporary directory outside both checkouts, on this machine. Sequential: nothing here overlaps the head's batches, which start after
 * it returns. The control checkout it created is removed before it returns, whatever happened; the temporary directory with the
 * baselines stays for the head's gate and goes with `cleanup.disposeAll()`.
 */
export async function runControl(
  deps: PairedDeps,
  request: ControlRequest,
  cleanup: Cleanup,
  signal?: AbortSignal,
): Promise<ControlResult> {
  const given = request.controlDir !== null;
  const info: ControlInfo = {
    controlRef: given ? request.controlRef : (request.controlRef ?? DEFAULT_CONTROL_REF),
    controlCommit: null,
    headCommit: null,
    checkout: given ? 'given' : 'created',
    controlDir: request.controlDir,
    aa: false,
    nodeModules: null,
    cpuModelAtControl: deps.cpuModel() ?? null,
    wallMs: { controlPrepare: 0, controlMeasure: 0 },
  };
  const started = deps.now();
  let prepared: number | null = null;
  const failed = (problem: string): ControlResult => {
    const elapsed = deps.now();
    if (prepared === null) info.wallMs.controlPrepare = elapsed - started;
    else info.wallMs.controlMeasure = elapsed - prepared;
    return { ok: false, problem, baselineDir: null, info };
  };
  try {
    info.headCommit = readHeadCommit(deps, request.headRoot);
    let controlHasNodeModules = false;
    if (request.controlDir !== null) {
      const existing = inspectControlDir(deps, request.controlDir);
      if (request.controlRef !== null) {
        const wanted = resolveCommit(deps, request.headRoot, request.controlRef);
        if (wanted !== existing.commit)
          throw new PairedError(
            'control-mismatch',
            `--control-dir ${request.controlDir} is at ${existing.commit.slice(0, 12)}, but --control-ref ${request.controlRef} is ${wanted.slice(0, 12)}: they must name the same commit`,
          );
      }
      info.controlCommit = existing.commit;
      controlHasNodeModules = existing.hasNodeModules;
    } else {
      info.controlCommit = resolveCommit(deps, request.headRoot, request.controlRef ?? DEFAULT_CONTROL_REF);
    }
    const controlCommit = info.controlCommit;
    info.aa = controlCommit === info.headCommit;

    const root = deps.mkdtemp(join(deps.tmpdir(), 'pb-paired-'));
    cleanup.trackRoot(root);
    const baselineDir = join(root, 'baselines');
    const reportsDir = join(root, 'control-reports');
    deps.mkdir(baselineDir);
    deps.mkdir(reportsDir);
    const env = controlEnv(request.baseEnv, request.headRoot);
    const options: ExecOptions = { env, ...(signal ? { signal } : {}) };

    const controlDir = request.controlDir ?? join(root, 'control');
    if (!given) {
      cleanup.trackWorktree(controlDir);
      await step(
        deps,
        `creating the control checkout of ${controlCommit.slice(0, 12)}`,
        'git',
        ['worktree', 'add', '--detach', controlDir, controlCommit],
        { ...options, cwd: request.headRoot },
      );
    }

    const plan = nodeModulesPlan({
      controlHasNodeModules,
      lockFilesEqual: sameBytes(
        deps.readBytes(join(request.headRoot, 'package-lock.json')),
        deps.readBytes(join(controlDir, 'package-lock.json')),
      ),
      headHasNodeModules: deps.exists(join(request.headRoot, 'node_modules')),
    });
    if (plan === 'link') {
      deps.log("paired: the lock files are the same: linking the head's node_modules into the control");
      deps.symlink(join(request.headRoot, 'node_modules'), join(controlDir, 'node_modules'));
      cleanup.trackLink(join(controlDir, 'node_modules'));
      info.nodeModules = 'linked';
    } else if (plan === 'install') {
      await step(
        deps,
        "installing the control's dependencies (npm ci)",
        'npm',
        ['ci', '--no-audit', '--no-fund'],
        { ...options, cwd: controlDir, timeoutMs: STEP_TIMEOUT_MS.install },
      );
      info.nodeModules = 'installed';
    } else info.nodeModules = 'present';

    await step(deps, "building the control's player page", 'npm', ['run', 'build:player'], {
      ...options,
      cwd: controlDir,
      timeoutMs: STEP_TIMEOUT_MS.build,
    });
    prepared = deps.now();
    info.wallMs.controlPrepare = prepared - started;

    await step(
      deps,
      `measuring the control (${request.profiles.join(', ')})`,
      'npm',
      measureArgs({ ...request, baselineDir, reportsDir }),
      { ...options, cwd: controlDir, timeoutMs: STEP_TIMEOUT_MS.measure },
    );
    info.wallMs.controlMeasure = deps.now() - prepared;

    for (const profile of request.profiles) {
      const path = baselinePath(baselineDir, request.envId, profile);
      if (!deps.exists(path))
        throw new PairedError(
          'no-baseline',
          `the control measurement wrote no baseline for ${profile} (${path})`,
        );
    }
    return { ok: true, problem: null, baselineDir, info };
  } catch (error) {
    if (error instanceof PairedError) return failed(error.message);
    throw error;
  } finally {
    cleanup.disposeWorktree();
  }
}

// ---------------------------------------------------------------------------------------------------- what the head does with it

/** The options of the head's gate: the control's baselines, where the committed ones would be. Everything else is the caller's. */
export function headOptions<T extends { baselineDir: string | null }>(options: T, baselineDir: string): T {
  return { ...options, baselineDir };
}

/**
 * The baseline as the head's gate should read it: a control recorded by code that predates the CPU model has none, but it ran on this
 * machine, whose model the gate read before it started the control.
 */
export function withControlModel(baseline: Baseline, model: string | null): Baseline {
  if (baseline.host.cpuModel !== undefined || model === null) return baseline;
  return { ...baseline, host: { ...baseline.host, cpuModel: model } };
}

export interface PairedReport {
  controlRef: string | null;
  controlCommit: string | null;
  headCommit: string | null;
  checkout: 'created' | 'given';
  controlDir: string | null;
  aa: boolean;
  nodeModules: 'linked' | 'installed' | 'present' | null;
  wallMs: { controlPrepare: number; controlMeasure: number; head: number };
  /** The CPU model of the control's measurement and of the head's: one machine, so one model. `same` is null when either is unknown. */
  cpuModels: { control: string | null; head: string | null; same: boolean | null; warning: string | null };
  /** The first line of every rendering of the report. */
  line: string;
}

/** The first line of a paired report, the same words in the terminal, the Markdown and the JSON. */
export function pairedLine(controlCommit: string | null, aa: boolean): string {
  if (controlCommit === null)
    return 'paired: no control was measured on this machine; the committed baselines of this environment were not used';
  return `paired: the baseline was measured on this machine minutes ago from ${controlCommit.slice(0, 12)}; the committed baselines of this environment were not used${aa ? ' (A/A by construction: the control is this very commit)' : ''}`;
}

/**
 * The control and the head share a machine, so they share a CPU model. When they do not, the pairing is void and the report says so
 * loudly; the verdict stays what the numbers say.
 */
export function comparePairedMachines(models: {
  recordedByControl: string | undefined;
  readBeforeControl: string | null;
  head: string | undefined;
}): PairedReport['cpuModels'] {
  const control = models.recordedByControl ?? models.readBeforeControl;
  const head = models.head ?? null;
  const same = control !== null && head !== null ? control === head : null;
  return {
    control,
    head,
    same,
    warning:
      same === false
        ? `THE CONTROL AND THE HEAD DID NOT RUN ON THE SAME CPU MODEL (${control} and ${head}): they were meant to share one machine, so this comparison is not paired. The verdict is what the numbers say; read it with that in mind`
        : null,
  };
}

export function buildPaired(
  info: ControlInfo,
  input: { recordedByControl: string | undefined; head: string | undefined; headMs: number },
): PairedReport {
  return {
    controlRef: info.controlRef,
    controlCommit: info.controlCommit,
    headCommit: info.headCommit,
    checkout: info.checkout,
    controlDir: info.controlDir,
    aa: info.aa,
    nodeModules: info.nodeModules,
    wallMs: { ...info.wallMs, head: input.headMs },
    cpuModels: comparePairedMachines({
      recordedByControl: input.recordedByControl,
      readBeforeControl: info.cpuModelAtControl,
      head: input.head,
    }),
    line: pairedLine(info.controlCommit, info.aa),
  };
}

/** A control that could not be measured is a measurement that cannot be trusted: 2, never 0. Otherwise the profiles decide as they do unpaired. */
export function pairedExitCode(controlOk: boolean, profileCodes: readonly ExitCode[]): ExitCode {
  if (!controlOk) return 2;
  return combineExitCodes(profileCodes);
}
