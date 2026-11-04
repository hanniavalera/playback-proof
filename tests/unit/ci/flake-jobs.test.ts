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
// as written in the workflow, against a real git repository laid out as the job lays out its workspace. The merge gate (ci.yml)
// and the nightly (nightly.yml) have the same two jobs, and every test of a job runs for both.

const BOT = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
const LINUX = detectEnvId({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' });
const MACOS = detectEnvId({ GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64' });
const environmentOf = (runner: string): string => (runner.startsWith('macos') ? MACOS : LINUX);

interface Pipeline {
  file: string;
  /** The job that runs the browsers: the flake jobs wait for it and judge what it uploaded. */
  legsId: string;
  /** The names of the two checks. `flake` is the required one, so the nightly's jobs say what they are. */
  judgeName: string;
  recordName: string;
  /** What the recorder's condition says about the event. */
  events: string;
  /** The tiers the runs of the legs hold. */
  tiers: Array<'merge' | 'release'>;
}

const PIPELINES: Pipeline[] = [
  {
    file: 'ci.yml',
    legsId: 'merge-gate',
    judgeName: 'flake',
    recordName: 'flake-record',
    events: "github.event_name == 'push'",
    tiers: ['merge'],
  },
  {
    file: 'nightly.yml',
    legsId: 'release',
    judgeName: 'flake (nightly)',
    recordName: 'flake-record (nightly)',
    events: "(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')",
    tiers: ['merge', 'release'],
  },
];

function load(pipeline: Pipeline) {
  const jobs = jobsOf(code(read(`${WORKFLOW_DIR}/${pipeline.file}`)));
  return {
    ...pipeline,
    jobs,
    judge: jobs.get('flake') ?? '',
    recorder: jobs.get('flake-record') ?? '',
    legs: legsOf(jobs.get(pipeline.legsId) ?? ''),
  };
}
type Loaded = ReturnType<typeof load>;
const loaded = PIPELINES.map(load);

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

describe.each(loaded)('the trust model of the flake jobs of $file', (p) => {
  it('has a judge that can only read: a read token, a checkout that keeps no credential, and no way to record', () => {
    expect(p.judge, 'the job is missing').not.toBe('');
    expect(p.judge).toContain(`\n    name: ${p.judgeName}\n`);
    expect(p.judge).toContain(`\n    needs: ${p.legsId}\n`);
    expect(p.judge).toContain('\n    if: ${{ !cancelled() }}\n');
    expect(p.judge).toMatch(/^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
    expect(p.judge).toMatch(/- uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
    expect(p.judge).not.toMatch(/--record|--push|ci-data/);
  });

  it('has a recorder with the one write token of the workflow, for the events that record and for main only', () => {
    expect(p.recorder, 'the job is missing').not.toBe('');
    expect(p.recorder).toContain(`\n    name: ${p.recordName}\n`);
    expect(p.recorder).toContain(`\n    needs: ${p.legsId}\n`);
    expect(p.recorder).toContain(
      `\n    if: \${{ !cancelled() && ${p.events} && github.ref == 'refs/heads/main' }}\n`,
    );
    expect(p.recorder).toMatch(/^ {4}permissions:\n {6}contents: write\n(?! {6})/m);
  });

  it('lets no other job record or push', () => {
    for (const [id, job] of p.jobs) {
      if (id !== 'flake-record') expect(job, `job ${id}`).not.toMatch(/--record|--push/);
    }
  });

  it('judges with the gate’s own exit code, and lets the recorder pass over a verdict only', () => {
    for (const call of invocations(p.judge)) {
      expect(call.command, call.name).not.toMatch(/\|\||&&|;|\|/);
    }
    for (const call of invocations(p.recorder)) {
      expect(call.command, call.name).toMatch(/ \|\| \[ "\$\?" -eq 1 \]$/);
    }
  });
});

describe.each(loaded)('the arguments of the flake jobs of $file', (p) => {
  const byEnvironment = new Map<string, string[]>();
  for (const leg of p.legs) {
    const id = environmentOf(leg.runner);
    byEnvironment.set(id, [...(byEnvironment.get(id) ?? []), `reports/flake/reports-${leg.leg}`]);
  }
  const sorted = (paths: readonly string[]): string => [...paths].sort().join(' ');

  it('are two invocations, one per environment, each with the artifacts of the legs that run in that environment', () => {
    expect([...byEnvironment.keys()].sort()).toEqual([LINUX, MACOS].sort());
    for (const job of [p.judge, p.recorder]) {
      const calls = invocations(job);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => sorted(parseCliArgs(call.argv, {}).runs)).sort()).toEqual(
        [...byEnvironment.values()].map(sorted).sort(),
      );
    }
  });

  it('read the history from the git store as the bot, and write one decision file per invocation', () => {
    for (const job of [p.judge, p.recorder]) {
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
    const judged = invocations(p.judge).map((call) => call.argv);
    const recorded = invocations(p.recorder).map((call) => call.argv);
    expect(recorded).toHaveLength(judged.length);
    recorded.forEach((argv, i) => {
      expect(argv.filter((a) => a === '--record' || a === '--push')).toEqual(['--record', '--push']);
      expect(argv.filter((a) => a !== '--record' && a !== '--push')).toEqual(judged[i]);
    });
  });

  it('are checked by the last step of the recorder, which names the files they write', () => {
    const check = stepsOf(p.recorder).at(-1);
    expect(check?.name).toMatch(/^Check that both environments are in the history/);
    const command = commandOf(check ?? { name: '', text: '' }) ?? '';
    for (const call of invocations(p.recorder)) {
      expect(command).toContain(parseCliArgs(call.argv, {}).json ?? 'no file');
    }
    expect(command).toContain('.recorded != null');
  });

  it('download the artifacts of the legs to where the arguments look for them', () => {
    for (const job of [p.judge, p.recorder]) {
      expect(job).toMatch(
        /- name: Download the run files of the legs\n {8}uses: actions\/download-artifact@v\d+\n {8}with:\n {10}pattern: reports-\*\n {10}path: reports\/flake\n/,
      );
    }
    expect(read(`${WORKFLOW_DIR}/${p.file}`)).toContain('name: reports-${{ matrix.leg }}');
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

/** The artifacts of one build: a run file per leg, in the tiers the workflow's legs run. */
function download(checkout: string, build: string, p: Loaded): void {
  for (const leg of p.legs) {
    const tests = p.tiers.map((tier) =>
      record({ id: tier === 'merge' ? 'PB-VOD-001' : 'PB-VOD-003', project: leg.project, tier }),
    );
    const file = run(tests, {
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

/** A temporary bare repository, a CI checkout of it (which is not the bot) and the directory of the strategy document. */
function bench(): { bare: string; checkout: string; strategy: string; reader: () => GitStore } {
  const root = makeScratch('ci-flake-');
  scratches.push(root);
  const world = makeWorld(root);
  return {
    bare: world.bare,
    checkout: world.writer('job'),
    strategy: lab(root),
    reader: () => new GitStore({ repoDir: world.writer('reader'), identity: parseIdentity(BOT) }),
  };
}

const branches = (bare: string): string[] =>
  git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n');

describe.each(loaded)('the flake jobs of $file on a real git repository', (p) => {
  it('bootstrap the history: a judge writes nothing, the first push creates ci-data as the bot, a re-run adds nothing', async () => {
    const { bare, checkout, strategy, reader } = bench();
    download(checkout, 'gha-100-1', p);
    const main = git(bare, 'rev-parse', 'main');

    // `flake`, on a pull request or on the first run of all: there is no ci-data yet, which is an empty history and not an error.
    expect(await runAll(p.judge, checkout, strategy)).toEqual([0, 0]);
    expect(branches(bare)).toEqual(['refs/heads/main']);

    // `flake-record`, on the first recording: the branch is created, parentless, one commit per environment.
    expect(await runAll(p.recorder, checkout, strategy)).toEqual([0, 0]);
    expect(branches(bare)).toEqual(['refs/heads/ci-data', 'refs/heads/main']);
    expect(git(bare, 'rev-parse', 'main')).toBe(main);
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'ci-data').split('\n')).toEqual([
      `history/${LINUX}.jsonl`,
      `history/${MACOS}.jsonl`,
    ]);
    expect(git(bare, 'rev-list', '--count', 'ci-data')).toBe('2');
    expect(git(bare, 'rev-list', '--max-parents=0', 'ci-data').split('\n')).toHaveLength(1);
    expect(new Set(git(bare, 'log', '--format=%an <%ae>%n%cn <%ce>', 'ci-data').split('\n'))).toEqual(
      new Set([BOT]),
    );
    for (const file of ['gate-linux', 'gate-macos']) {
      const decision = JSON.parse(readFileSync(join(checkout, `reports/flake/${file}.json`), 'utf8')) as {
        recorded: { added: number; pushed: boolean } | null;
      };
      expect(decision.recorded?.pushed, file).toBe(true);
    }

    // What the next judge reads back: the Linux runs of the four legs and the macOS run of the fifth.
    const history = reader();
    expect((await history.load(LINUX)).map((r) => r.invocationId).sort()).toEqual(
      p.legs
        .filter((l) => environmentOf(l.runner) === LINUX)
        .map((l) => `gha-100-1-${l.leg}`)
        .sort(),
    );
    expect((await history.load(MACOS)).map((r) => r.invocationId)).toEqual(['gha-100-1-webkit-macos']);

    // Running the job again (a re-run of the failed jobs) records the same runs: nothing new, nothing pushed.
    const tip = git(bare, 'rev-parse', 'ci-data');
    for (const call of invocations(p.recorder)) {
      const { io, out } = ioIn(checkout, strategy);
      expect(await gateCommand(call.argv, io), call.name).toBe(0);
      expect(out.join('\n'), call.name).toContain('0 new runs');
    }
    expect(git(bare, 'rev-parse', 'ci-data')).toBe(tip);
  });

  it('fail the judge when the legs left no run file: a merge gate that did not run is not a pass', async () => {
    const { checkout, strategy } = bench();
    // The streams job failed, the legs were skipped, and the download step found no artifact to download.
    const none = ioIn(checkout, strategy);
    expect(await gateCommand(invocations(p.judge)[0]?.argv ?? [], none.io)).toBe(2);
    expect(none.err.join('\n')).toContain('reports/flake/reports-chromium: no such file or directory');

    // One leg left nothing (its job died before the upload): that environment cannot be judged, the other one still is.
    download(checkout, 'gha-101-1', p);
    rmSync(join(checkout, 'reports/flake/reports-webkit-linux'), { recursive: true });
    const partial = ioIn(checkout, strategy);
    expect(await runAll(p.judge, checkout, strategy)).toEqual([2, 0]);
    expect(await gateCommand(invocations(p.judge)[0]?.argv ?? [], partial.io)).toBe(2);
    expect(partial.err.join('\n')).toContain('reports/flake/reports-webkit-linux: no such file or directory');
  });
});

describe('the flake jobs of the merge gate and of the nightly', () => {
  const [gate, night] = loaded as [Loaded, Loaded];

  it('have four different check names, so that the required `flake` is one job', () => {
    const names = [gate, night].flatMap((p) => [p.judgeName, p.recordName]);
    expect(new Set(names).size).toBe(4);
    expect(gate.judgeName).toBe('flake');
  });

  it('run the same steps, which the nightly repeats because a reusable workflow would rename the required check', () => {
    expect(stepsOf(night.judge).map((s) => s.text)).toEqual(stepsOf(gate.judge).map((s) => s.text));
    expect(stepsOf(night.recorder).map((s) => s.text)).toEqual(stepsOf(gate.recorder).map((s) => s.text));
  });

  it('have the same legs, so that one set of arguments serves both', () => {
    expect(night.legs.map((l) => [l.leg, l.runner])).toEqual(gate.legs.map((l) => [l.leg, l.runner]));
  });

  it('record into one history: a push to main and a night add to the same file of each environment, on top of each other', async () => {
    const { bare, checkout, strategy, reader } = bench();
    download(checkout, 'gha-100-1', gate);
    expect(await runAll(gate.recorder, checkout, strategy)).toEqual([0, 0]);

    rmSync(join(checkout, 'reports'), { recursive: true });
    download(checkout, 'gha-200-1', night);
    expect(await runAll(night.recorder, checkout, strategy)).toEqual([0, 0]);

    expect(git(bare, 'rev-list', '--count', 'ci-data')).toBe('4');
    expect(git(bare, 'rev-list', '--max-parents=0', 'ci-data').split('\n')).toHaveLength(1);
    const linux = await reader().load(LINUX);
    expect(linux).toHaveLength(8);
    const nights = linux.filter((r) => r.runId === 'gha-200-1');
    expect(nights).toHaveLength(4);
    expect(nights.every((r) => r.tests.some((t) => t.tier === 'release'))).toBe(true);
    expect(
      linux.filter((r) => r.runId === 'gha-100-1').every((r) => r.tests.every((t) => t.tier === 'merge')),
    ).toBe(true);
  });
});
