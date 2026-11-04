import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../../flake/cli.ts';
import { defaultIo, gateCommand } from '../../../flake/gate.ts';
import type { Io } from '../../../flake/gate.ts';
import { renderRunFile } from '../../../flake/reporter.ts';
import { GitStore, parseIdentity } from '../../../flake/store.ts';
import { detectEnvId } from '../../../src/shared/env.ts';
import { record, run } from '../flake/fixtures.ts';
import { git, makeWorld } from '../flake/git-world.ts';
import {
  ROOT,
  WORKFLOW_DIR,
  code,
  commandOf,
  jobsOf,
  legsOf,
  read,
  scriptArgs,
  stepsOf,
} from '../support/ci-files.ts';
import { makeScratch } from '../support/scratch.ts';

// The flake gate of the GitHub workflows (ADR-170 to ADR-172, docs/CI.md). The workflows cannot run here, so these tests do what
// can be done without GitHub: they check who may write (the trust model), and they run the arguments the workflow gives the gate,
// as written in the workflow, against a real git repository laid out as the job lays out its workspace.

const BOT = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
const LINUX = detectEnvId({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' });
const MACOS = detectEnvId({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' });
const environmentOf = (runner: string): string => (runner.startsWith('macos') ? MACOS : LINUX);

const ciJobs = jobsOf(code(read(`${WORKFLOW_DIR}/ci.yml`)));
const mergeGate = ciJobs.get('merge-gate') ?? '';
const judge = ciJobs.get('flake') ?? '';
const recorder = ciJobs.get('flake-record') ?? '';
const legs = legsOf(mergeGate);

interface Invocation {
  name: string;
  command: string;
  argv: string[];
}

/** Each `npm run gate:flake` of a job, with its arguments as the shell passes them (`$FLAKE_IDENTITY` replaced by the job's value). */
function invocations(job: string): Invocation[] {
  const identity = /^ {6}FLAKE_IDENTITY: '([^']+)'$/m.exec(job)?.[1] ?? '';
  return stepsOf(job).flatMap((step) => {
    const command = commandOf(step) ?? '';
    const argv = scriptArgs(command, 'gate:flake', { FLAKE_IDENTITY: identity });
    return argv === null ? [] : [{ name: step.name, command, argv }];
  });
}

describe('the trust model of the flake jobs', () => {
  it('has a judge that can only read: a read token, a checkout that keeps no credential, and no way to record', () => {
    expect(judge, 'the job is missing').not.toBe('');
    expect(judge).toMatch(/^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
    expect(judge).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
    expect(judge).not.toMatch(/--record|--push|ci-data/);
    expect(judge).toMatch(/^ {4}needs: merge-gate$/m);
    expect(judge).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m);
  });

  it('has a recorder with the one write token of the workflow, for a push to main only', () => {
    expect(recorder, 'the job is missing').not.toBe('');
    expect(recorder).toMatch(/^ {4}permissions:\n {6}contents: write\n(?! {6})/m);
    expect(recorder).toMatch(
      /^ {4}if: \$\{\{ !cancelled\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}$/m,
    );
    expect(recorder).toMatch(/^ {4}needs: merge-gate$/m);
  });

  it('lets no other job record or push', () => {
    for (const [id, job] of ciJobs) {
      if (id !== 'flake-record') expect(job, `job ${id}`).not.toMatch(/--record|--push/);
    }
  });

  it('judges with the gate’s own exit code, and lets the recorder pass over a verdict only', () => {
    for (const call of invocations(judge)) {
      expect(call.command, call.name).not.toMatch(/\|\||&&|;|\|/);
    }
    for (const call of invocations(recorder)) {
      expect(call.command, call.name).toMatch(/ \|\| \[ "\$\?" -eq 1 \]$/);
    }
  });
});

describe('the arguments of the flake jobs', () => {
  const byEnvironment = new Map<string, string[]>();
  for (const leg of legs) {
    const id = environmentOf(leg.runner);
    byEnvironment.set(id, [...(byEnvironment.get(id) ?? []), `reports/flake/reports-${leg.leg}`]);
  }
  const sorted = (paths: readonly string[]): string => [...paths].sort().join(' ');

  it('are two invocations, one per environment, each with the artifacts of the legs that run in that environment', () => {
    expect([...byEnvironment.keys()].sort()).toEqual([LINUX, MACOS].sort());
    for (const job of [judge, recorder]) {
      const calls = invocations(job);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => sorted(parseCliArgs(call.argv, {}).runs)).sort()).toEqual(
        [...byEnvironment.values()].map(sorted).sort(),
      );
    }
  });

  it('read the history from the git store as the bot, and write one decision file per invocation', () => {
    for (const job of [judge, recorder]) {
      const parsed = invocations(job).map((call) => parseCliArgs(call.argv, {}));
      for (const args of parsed) {
        expect(args.store).toBe('git');
        expect(args.gitIdentity).toBe(BOT);
        expect(parseIdentity(args.gitIdentity ?? '')).toEqual({
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
        });
        expect(args.json).toMatch(/^reports\/flake\/gate-[a-z]+\.json$/);
      }
      expect(new Set(parsed.map((args) => args.json)).size).toBe(parsed.length);
    }
  });

  it('are the same for the judge and the recorder, which only adds --record --push', () => {
    const judged = invocations(judge).map((call) => call.argv);
    const recorded = invocations(recorder).map((call) => call.argv);
    expect(recorded).toHaveLength(judged.length);
    recorded.forEach((argv, i) => {
      expect(argv.filter((a) => a === '--record' || a === '--push')).toEqual(['--record', '--push']);
      expect(argv.filter((a) => a !== '--record' && a !== '--push')).toEqual(judged[i]);
    });
  });

  it('are checked by the last step of the recorder, which names the files they write', () => {
    const check = stepsOf(recorder).at(-1);
    expect(check?.name).toMatch(/^Check that both environments are in the history/);
    const command = commandOf(check ?? { name: '', text: '' }) ?? '';
    for (const call of invocations(recorder)) {
      expect(command).toContain(parseCliArgs(call.argv, {}).json ?? 'no file');
    }
    expect(command).toContain('.recorded != null');
  });

  it('download the artifacts to where the arguments look for them', () => {
    for (const job of [judge, recorder]) {
      expect(job).toMatch(
        /- name: Download the run files of the legs\n {8}uses: actions\/download-artifact@v\d+\n {8}with:\n {10}pattern: reports-\*\n {10}path: reports\/flake\n/,
      );
    }
    expect(mergeGate).toContain('name: reports-${{ matrix.leg }}');
  });
});

describe('the script the flake jobs call', () => {
  // `gate:flake` was an alias of another script (`npm run flake:gate`), and npm gives the arguments of an alias to itself, not to the
  // script it runs: `--store git --runs ...` would have reached the gate as nothing, and the first run would have failed on it.
  it('hands its arguments to the gate and returns the gate’s exit code', () => {
    const call = (...args: string[]) =>
      spawnSync('npm', ['run', '--silent', 'gate:flake', '--', ...args], { cwd: ROOT, encoding: 'utf8' });
    const help = call('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: tsx flake/gate.ts');
    const missing = call('--runs', 'no/such/directory');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no/such/directory: no such file or directory');
  }, 60_000);
});

// What a leg leaves after the download step: one directory per artifact, with the workspace the leg uploaded inside it.
const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});

function put(dir: string, relative: string, text: string): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function download(checkout: string, build: string): void {
  for (const leg of legs) {
    const file = run([record({ project: leg.project })], {
      runId: build,
      invocationId: `${build}-${leg.leg}`,
      envId: environmentOf(leg.runner),
    });
    put(checkout, `reports/flake/reports-${leg.leg}/reports/flake/run.json`, renderRunFile(file));
  }
}

/** The directory the gate takes the strategy document and the quarantine list from: the real catalog, an empty list. */
function lab(parent: string): string {
  const dir = join(parent, 'lab');
  mkdirSync(join(dir, 'flake'), { recursive: true });
  copyFileSync(join(ROOT, 'TEST_STRATEGY.md'), join(dir, 'TEST_STRATEGY.md'));
  writeFileSync(join(dir, 'flake/quarantine.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
  return dir;
}

function ioIn(cwd: string, root: string): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    ...defaultIo(),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    env: {},
    cwd,
    root,
    now: () => new Date('2026-11-03T12:00:00Z'),
  };
  return { io, out, err };
}

async function runAll(job: string, checkout: string, root: string): Promise<number[]> {
  const exits: number[] = [];
  for (const call of invocations(job)) {
    exits.push(await gateCommand(call.argv, ioIn(checkout, root).io));
  }
  return exits;
}

describe('the flake jobs on a real git repository', () => {
  it('bootstrap the history: a judge writes nothing, the first push to main creates ci-data as the bot, a re-run adds nothing', async () => {
    const root = makeScratch('ci-flake-');
    scratches.push(root);
    const world = makeWorld(root);
    const checkout = world.writer('job');
    const strategy = lab(root);
    download(checkout, 'gha-100-1');
    const branches = (): string[] =>
      git(world.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');
    const main = git(world.bare, 'rev-parse', 'main');

    // `flake`, on a pull request or on the first run of all: there is no ci-data yet, which is an empty history and not an error.
    expect(await runAll(judge, checkout, strategy)).toEqual([0, 0]);
    expect(branches()).toEqual(['refs/heads/main']);

    // `flake-record`, on the first push to main: the branch is created, parentless, one commit per environment.
    expect(await runAll(recorder, checkout, strategy)).toEqual([0, 0]);
    expect(branches()).toEqual(['refs/heads/ci-data', 'refs/heads/main']);
    expect(git(world.bare, 'rev-parse', 'main')).toBe(main);
    expect(git(world.bare, 'ls-tree', '-r', '--name-only', 'ci-data').split('\n')).toEqual([
      `history/${LINUX}.jsonl`,
      `history/${MACOS}.jsonl`,
    ]);
    expect(git(world.bare, 'rev-list', '--count', 'ci-data')).toBe('2');
    expect(git(world.bare, 'rev-list', '--max-parents=0', 'ci-data').split('\n')).toHaveLength(1);
    expect(new Set(git(world.bare, 'log', '--format=%an <%ae>%n%cn <%ce>', 'ci-data').split('\n'))).toEqual(
      new Set([BOT]),
    );
    for (const file of ['gate-linux', 'gate-macos']) {
      const decision = JSON.parse(readFileSync(join(checkout, `reports/flake/${file}.json`), 'utf8')) as {
        recorded: { added: number; pushed: boolean } | null;
      };
      expect(decision.recorded?.pushed, file).toBe(true);
    }

    // What the next judge reads back: the four Linux runs and the macOS one.
    const reader = new GitStore({ repoDir: world.writer('reader'), identity: parseIdentity(BOT) });
    expect((await reader.load(LINUX)).map((r) => r.invocationId).sort()).toEqual(
      legs
        .filter((l) => environmentOf(l.runner) === LINUX)
        .map((l) => `gha-100-1-${l.leg}`)
        .sort(),
    );
    expect((await reader.load(MACOS)).map((r) => r.invocationId)).toEqual(['gha-100-1-webkit-macos']);

    // Running the job again (a re-run of the failed jobs) records the same runs: nothing new, nothing pushed.
    const tip = git(world.bare, 'rev-parse', 'ci-data');
    for (const call of invocations(recorder)) {
      const { io, out } = ioIn(checkout, strategy);
      expect(await gateCommand(call.argv, io), call.name).toBe(0);
      expect(out.join('\n'), call.name).toContain('0 new runs');
    }
    expect(git(world.bare, 'rev-parse', 'ci-data')).toBe(tip);
  });

  it('fail the judge when the merge gate left no run file: a merge gate that did not run is not a pass', async () => {
    const root = makeScratch('ci-flake-');
    scratches.push(root);
    const checkout = makeWorld(root).writer('job');
    const strategy = lab(root);
    // The streams job failed, the legs were skipped, and the download step found no artifact to download.
    const none = ioIn(checkout, strategy);
    expect(await gateCommand(invocations(judge)[0]?.argv ?? [], none.io)).toBe(2);
    expect(none.err.join('\n')).toContain('reports/flake/reports-chromium: no such file or directory');

    // One leg left nothing (its job died before the upload): that environment cannot be judged, the other one still is.
    download(checkout, 'gha-101-1');
    rmSync(join(checkout, 'reports/flake/reports-webkit-linux'), { recursive: true });
    const partial = ioIn(checkout, strategy);
    expect(await runAll(judge, checkout, strategy)).toEqual([2, 0]);
    expect(await gateCommand(invocations(judge)[0]?.argv ?? [], partial.io)).toBe(2);
    expect(partial.err.join('\n')).toContain('reports/flake/reports-webkit-linux: no such file or directory');
  });
});
