import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAKE_LIMITS } from '../../../src/shared/criteria.ts';
import { defaultIo, gateCommand } from '../../../flake/gate.ts';
import type { Io } from '../../../flake/gate.ts';
import { addDays } from '../../../flake/quarantine.ts';
import { renderRunFile } from '../../../flake/reporter.ts';
import type { FlakeRun } from '../../../flake/run.ts';
import { FileStore, GitStore } from '../../../flake/store.ts';
import type { AppendResult, FlakeStore } from '../../../flake/store.ts';
import { makeScratch } from '../support/scratch.ts';
import { builds } from './fixtures.ts';
import { git, makeWorld } from './git-world.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TODAY = '2026-11-03';
const W = FLAKE_LIMITS.windowRuns;
const VOD_007 = 6;
const ENV = 'gha-linux-x64';

const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});

interface Scenario {
  dir: string;
  out: string[];
  err: string[];
  io: Io;
  argv: (...more: string[]) => string[];
  write: (relative: string, text: string) => string;
  store: FileStore;
}

/** A directory with what a build leaves: run files under reports/flake, a history directory and a quarantine list. */
function scenario(
  options: { env?: NodeJS.ProcessEnv; entries?: unknown[]; quarantineText?: string } = {},
): Scenario {
  const dir = makeScratch('flake-gate-');
  scratches.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const write = (relative: string, text: string): string => {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  if (options.quarantineText !== undefined) write('quarantine.json', options.quarantineText);
  else write('quarantine.json', JSON.stringify({ schemaVersion: 1, entries: options.entries ?? [] }));
  const io: Io = {
    ...defaultIo(),
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    env: options.env ?? {},
    cwd: dir,
    root: ROOT,
    now: () => new Date(`${TODAY}T12:00:00Z`),
  };
  return {
    dir,
    out,
    err,
    io,
    write,
    store: new FileStore({ dir: join(dir, 'history') }),
    argv: (...more) => [
      '--history-dir',
      'history',
      '--quarantine',
      join(dir, 'quarantine.json'),
      '--today',
      TODAY,
      ...more,
    ],
  };
}

const runFile = (run: FlakeRun): string => renderRunFile(run);

/** A flaky PB-VOD-007 on webkit in the history and in the build: two in a full window. */
function flakyWebkit(): { history: FlakeRun[]; current: FlakeRun[] } {
  const all = builds(W, {
    project: 'webkit',
    flaky: (build, test) => test === VOD_007 && (build === 3 || build === W - 1),
  });
  return { history: all.slice(0, -1), current: all.slice(-1) };
}

describe('PB-LAB-004 flake gate command: the verdict and the exit code', () => {
  it('passes a healthy build: exit 0, one line saying so, and the decision as JSON', async () => {
    const s = scenario();
    const all = builds(W, { project: 'chromium' });
    await s.store.append(ENV, all.slice(0, -1));
    s.write('reports/flake/run.json', runFile(all.at(-1) as FlakeRun));

    expect(await gateCommand(s.argv(), s.io)).toBe(0);
    expect(s.out.join('\n').split('\n')[0]).toBe(
      `flake gate: PASS  [${ENV}, ${TODAY}, 1 run in this build, ${W} runs judged]`,
    );
    expect(s.err).toEqual([]);
    const decision = JSON.parse(readFileSync(join(s.dir, 'reports/flake/gate.json'), 'utf8'));
    expect(decision).toMatchObject({ decision: 'pass', envId: ENV, failures: [], recorded: null });
    expect(decision.suites[0]).toMatchObject({ project: 'chromium', builds: W, verdict: 'ok' });
  });

  it('fails a flaky test above the trigger: exit 1, with the failure and the decision it drives', async () => {
    const s = scenario();
    const { history, current } = flakyWebkit();
    await s.store.append(ENV, history);
    s.write('reports/flake/run.json', runFile(current[0] as FlakeRun));

    expect(await gateCommand(s.argv(), s.io)).toBe(1);
    const text = s.out.join('\n');
    expect(text).toContain('flake gate: FAIL (1 failure)');
    expect(text).toContain('[over-trigger] PB-VOD-007 on webkit is above the quarantine trigger');
    expect(text).toContain('Decision: Fix PB-VOD-007 on webkit today, or quarantine it today');
    const decision = JSON.parse(readFileSync(join(s.dir, 'reports/flake/gate.json'), 'utf8'));
    expect(decision.decision).toBe('fail');
    expect(decision.failures[0]).toMatchObject({ kind: 'over-trigger', subject: 'PB-VOD-007 on webkit' });
  });

  it('passes the same build once the test is quarantined with an owner and an expiry', async () => {
    const entry = {
      id: 'PB-VOD-007',
      project: 'webkit',
      reason: 'failed and passed on one commit',
      owner: '@owner',
      since: TODAY,
      expires: addDays(TODAY, FLAKE_LIMITS.mergeQuarantineMaxAgeDays),
      evidence: 'run 41',
    };
    const s = scenario({ entries: [entry] });
    const { history, current } = flakyWebkit();
    await s.store.append(ENV, history);
    s.write('reports/flake/run.json', runFile(current[0] as FlakeRun));
    expect(await gateCommand(s.argv(), s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('quarantined until');
  });

  it('fails on an expired quarantine, and on a quarantine list that is not valid', async () => {
    const expired = {
      id: 'PB-VOD-008',
      reason: 'x',
      owner: '@owner',
      since: addDays(TODAY, -9),
      expires: addDays(TODAY, -2),
      evidence: 'run 1',
    };
    const s = scenario({ entries: [expired] });
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(s.argv(), s.io)).toBe(1);
    expect(s.out.join('\n')).toContain('[quarantine-expired] The quarantine of PB-VOD-008 expired on');

    const broken = scenario({
      quarantineText: '{ "schemaVersion": 1, "entries": [ {"id": "PB-VOD-001"} ] }',
    });
    broken.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(broken.argv(), broken.io)).toBe(1);
    expect(broken.out.join('\n')).toContain(
      '[quarantine-invalid] The quarantine list is not valid: PB-VOD-001: "reason" is missing',
    );
  });

  it('fails when the quarantine file is missing: it is the list of record', async () => {
    const s = scenario();
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    rmSync(join(s.dir, 'quarantine.json'));
    expect(await gateCommand(s.argv(), s.io)).toBe(1);
    expect(s.out.join('\n')).toContain('the file is missing');
  });

  it('judges the run files of several engine jobs found in directories of their own', async () => {
    const s = scenario();
    const chromium = builds(1, { project: 'chromium' })[0] as FlakeRun;
    const firefox = builds(1, { project: 'firefox' })[0] as FlakeRun;
    s.write('reports/flake/chromium/run.json', runFile(chromium));
    s.write('reports/flake/firefox/run.json', runFile(firefox));
    s.write(
      'reports/flake/firefox/run-quarantined.json',
      runFile({ ...firefox, invocationId: 'quarantined-1', tests: [] }),
    );
    // Files that are not run files are left alone.
    s.write('reports/flake/chromium/gate.json', '{"not":"a run"}');
    s.write('reports/flake/report.json', 'not even json');
    expect(await gateCommand(s.argv(), s.io)).toBe(0);
    expect(s.out[0]).toContain('3 runs in this build');
    const decision = JSON.parse(readFileSync(join(s.dir, 'reports/flake/gate.json'), 'utf8'));
    expect(decision.suites.map((x: { project: string }) => x.project)).toEqual(['chromium', 'firefox']);
  });
});

describe('PB-LAB-004 flake gate command: recording', () => {
  it('records the runs of the build in the history, once, when asked', async () => {
    const s = scenario();
    const run = builds(1, { project: 'chromium' })[0] as FlakeRun;
    s.write('reports/flake/run.json', runFile(run));
    expect(await gateCommand(s.argv('--record'), s.io)).toBe(0);
    expect(s.out.join('\n')).toContain(
      `recorded in the history (${s.store.description}): 1 new run, 0 trimmed`,
    );
    expect(await s.store.load(ENV)).toEqual([run]);
    // The same build again: judged again, not counted again.
    s.out.length = 0;
    expect(await gateCommand(s.argv('--record'), s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('0 new runs');
    expect(await s.store.load(ENV)).toEqual([run]);
  });

  it('does not record without --record: a pull request is judged and forgotten', async () => {
    const s = scenario();
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(s.argv(), s.io)).toBe(0);
    expect(existsSync(join(s.dir, 'history'))).toBe(false);
  });

  it('records a build that failed the gate too: the history is not only the good builds', async () => {
    const s = scenario();
    const { history, current } = flakyWebkit();
    await s.store.append(ENV, history);
    s.write('reports/flake/run.json', runFile(current[0] as FlakeRun));
    expect(await gateCommand(s.argv('--record'), s.io)).toBe(1);
    expect((await s.store.load(ENV)).length).toBe(W);
  });

  it('reports a failure to record: exit 2 when the build passed, and the verdict (1) when it did not', async () => {
    const failing: FlakeStore = {
      description: 'a store that cannot write',
      load: async () => [],
      append: async (): Promise<AppendResult> => {
        throw new Error('disk full');
      },
    };
    const green = scenario();
    green.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(green.argv('--record'), { ...green.io, store: failing })).toBe(2);
    expect(green.err.join('\n')).toContain(
      'cannot record the runs in the history (a store that cannot write): disk full',
    );
    expect(green.out[0]).toContain('PASS');

    const red = scenario({
      entries: [
        {
          id: 'PB-VOD-008',
          reason: 'x',
          owner: 'o',
          since: addDays(TODAY, -9),
          expires: addDays(TODAY, -2),
          evidence: 'e',
        },
      ],
    });
    red.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(red.argv('--record'), { ...red.io, store: failing })).toBe(1);
  });

  it('records into the ci-data branch of a real (temporary) bare repository, and pushes only when told to', async () => {
    const root = makeScratch('flake-gate-git-');
    scratches.push(root);
    const world = makeWorld(root);
    const checkout = world.writer('job');
    const s = scenario();
    const run = builds(1, { project: 'chromium' })[0] as FlakeRun;
    s.write('reports/flake/run.json', runFile(run));
    const git_ = [
      '--store',
      'git',
      '--git-repo',
      checkout,
      '--git-identity',
      'playback-proof ci <ci@example.invalid>',
    ];

    // A pull request: the history is read (there is none yet), the run is judged, nothing is written anywhere.
    expect(await gateCommand(s.argv(...git_), s.io)).toBe(0);
    expect(git(world.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');

    // A build of main: recorded and pushed.
    expect(await gateCommand(s.argv(...git_, '--record', '--push'), s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('1 new run, 0 trimmed, pushed (1 try)');
    expect(git(world.bare, 'ls-tree', '-r', '--name-only', 'ci-data')).toBe(`history/${ENV}.jsonl`);
    expect(
      await new GitStore({
        repoDir: world.writer('reader'),
        identity: { name: 'x', email: 'x@example.invalid' },
      }).load(ENV),
    ).toEqual([run]);
  });
});

describe('PB-LAB-004 flake gate command: when it cannot judge (exit 2)', () => {
  it('has no run file', async () => {
    const s = scenario();
    expect(await gateCommand(s.argv(), s.io)).toBe(2);
    expect(s.err.join('\n')).toMatch(
      /flake gate: no run file found \(reports\/flake\/run\*\.json\): the tests did not run with the flake reporter/,
    );
    expect(await gateCommand(s.argv('--runs', 'nowhere'), s.io)).toBe(2);
    expect(s.err.join('\n')).toContain('nowhere: no such file or directory');
  });

  it('is given a run file that is not one, naming the file and the field', async () => {
    const s = scenario();
    const run = builds(1)[0] as FlakeRun;
    const file = s.write('reports/flake/run.json', JSON.stringify({ ...run, status: 'green' }));
    expect(await gateCommand(s.argv(), s.io)).toBe(2);
    expect(s.err.join('\n')).toContain(
      `${file}: $.status: expected one of passed, failed, timedout, interrupted`,
    );
    s.err.length = 0;
    s.write('reports/flake/run.json', '{ truncated');
    expect(await gateCommand(s.argv(), s.io)).toBe(2);
    expect(s.err.join('\n')).toMatch(/run\.json: not JSON/);
  });

  it('cannot read the history', async () => {
    const s = scenario();
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    s.write(`history/${ENV}.jsonl`, 'garbage\n');
    expect(await gateCommand(s.argv(), s.io)).toBe(2);
    expect(s.err.join('\n')).toMatch(
      new RegExp(`cannot read the history \\(file store .*history\\): .*${ENV}\\.jsonl:1: not JSON`),
    );
  });

  it('is given run files of several environments, or of another one than it was told', async () => {
    const s = scenario();
    s.write('reports/flake/a/run.json', runFile({ ...(builds(1)[0] as FlakeRun), envId: 'gha-linux-x64' }));
    s.write('reports/flake/b/run.json', runFile({ ...(builds(1)[0] as FlakeRun), envId: 'gha-macos-arm64' }));
    expect(await gateCommand(s.argv(), s.io)).toBe(2);
    expect(s.err.join('\n')).toContain(
      'the run files are from 2 environments (gha-linux-x64, gha-macos-arm64)',
    );
    s.err.length = 0;
    expect(await gateCommand(s.argv('--runs', 'reports/flake/a', '--env', 'gha-macos-arm64'), s.io)).toBe(2);
    expect(s.err.join('\n')).toContain('--env gha-macos-arm64, but the run files are from gha-linux-x64');
  });

  it('cannot read the catalog of the strategy document', async () => {
    const s = scenario();
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    s.write('STRATEGY.md', '# no catalog here\n');
    expect(await gateCommand(s.argv('--strategy', 'STRATEGY.md'), s.io)).toBe(2);
    expect(s.err.join('\n')).toContain('cannot read the catalog of the strategy document');
  });

  it('is given arguments it does not understand', async () => {
    const s = scenario();
    s.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    for (const [argv, message] of [
      [['--bogus'], 'unknown argument --bogus'],
      [['--store', 'cloud'], '--store must be file or git, not "cloud"'],
      [['--today', 'tomorrow'], '--today must be a day written YYYY-MM-DD'],
      [['--runs'], '--runs needs a value'],
      [['--push'], '--push publishes what --record records: give both, or neither'],
      [['--record', '--push'], '--push is for the git store'],
      [['--store', 'git', '--record'], 'commits as the CI identity'],
    ] as Array<[string[], string]>) {
      s.err.length = 0;
      expect(await gateCommand(s.argv(...argv), s.io), argv.join(' ')).toBe(2);
      expect(s.err.join('\n'), argv.join(' ')).toContain(message);
    }
    expect(await gateCommand(['--help'], s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('Usage: tsx flake/gate.ts');
  });
});

describe('PB-LAB-004 flake gate command: the job summary of GitHub Actions', () => {
  it('adds the verdict to $GITHUB_STEP_SUMMARY when there is one, and only then', async () => {
    const withSummary = scenario();
    const summary = join(withSummary.dir, 'summary.md');
    const { history, current } = flakyWebkit();
    await withSummary.store.append(ENV, history);
    withSummary.write('reports/flake/run.json', runFile(current[0] as FlakeRun));
    expect(
      await gateCommand(withSummary.argv(), { ...withSummary.io, env: { GITHUB_STEP_SUMMARY: summary } }),
    ).toBe(1);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('### Flake gate: FAIL (1 failure)');
    expect(text).toContain('```text\nflake gate: FAIL');
    expect(text).toContain('Decision: Fix PB-VOD-007 on webkit today');

    const without = scenario();
    without.write('reports/flake/run.json', runFile(builds(1)[0] as FlakeRun));
    expect(await gateCommand(without.argv(), without.io)).toBe(0);
    expect(existsSync(join(without.dir, 'summary.md'))).toBe(false);
  });
});
