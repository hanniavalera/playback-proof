import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../../ab/cli.ts';
import type { StartMachine } from '../../../ab/cli.ts';
import { writeRawResult } from '../../../ab/files.ts';
import { AA_SOURCE, aaPrereg, passingAaReport, startupPrereg } from './fixtures.ts';
import { generator } from './helpers.ts';
import { machineOf, smallJson, world } from './fake-world.ts';
import type { Script } from './fake-world.ts';
import { scratchDirectory } from './scratch.ts';
import { aaPool, buildRaw, interleaved, scheduled, startupOnly } from './synthetic.ts';

// The command with a fake machine in place of the service and the browser: what it refuses before anything starts, what it writes, what its
// exit code says (0 for a valid run whatever its verdict, 1 for an A/A check the harness failed, 2 for a run that cannot be trusted), and the
// modes that need no browser at all. The scratch directory is a git repository of its own, so that a plan is really committed, or not, and
// the provenance is read from git and not from a stand-in.

const directory = scratchDirectory('ab-cli');

const git = (...args: string[]): void => {
  execFileSync(
    'git',
    ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: directory, stdio: 'ignore' },
  );
};
git('init', '-q');

interface Captured {
  io: { root: string; out(text: string): void; err(text: string): void };
  out: string[];
  err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { root: directory, out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

const writePlan = (name: string, plan: object): string => {
  writeFileSync(join(directory, name), `${JSON.stringify(plan, null, 2)}\n`);
  return name;
};

/** Writes the plan and commits it, as the orchestrator does before a data run. */
const commitPlan = (name: string, plan: object): string => {
  writePlan(name, plan);
  git('add', name);
  git('commit', '-q', '-m', `register ${name}`);
  return name;
};

/** The committed report of the A/A run an experiment relies on, in the environment of the fake machine. */
const commitAaReport = (over: Record<string, unknown> = {}): void => {
  const file = join(directory, AA_SOURCE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, passingAaReport({ environment: { envId: 'fixture-env' }, ...over }));
};

/** A machine that records how it was started. */
function fakeMachine(script?: Script): {
  start: StartMachine;
  started: Array<{ port: number; engine: string }>;
  log: string[];
} {
  const fake = world(script);
  const started: Array<{ port: number; engine: string }> = [];
  return {
    started,
    log: fake.log,
    start: async (options) => {
      started.push(options);
      return machineOf(fake);
    },
  };
}

const neverStarted: StartMachine = async () => {
  throw new Error('the machine must not be started');
};

const filesIn = (path: string): string[] => readdirSync(path).sort();
const read = (...path: string[]): string => readFileSync(join(directory, ...path), 'utf8');

/** An experiment small enough to run in a moment: 1000 resamples, as the validator allows. */
const experimentPlan = (): Record<string, unknown> => ({ ...startupPrereg(), bootstrapResamples: 1000 });

/** B much faster than A in every session (200 ms: beyond the threshold of 100 ms), with a little spread. */
const bFaster: Script = (arm, index) => ({ startupMs: (arm === 'A' ? 1000 : 800) + (index % 10) });
/** B much slower than A. */
const bSlower: Script = (arm, index) => ({ startupMs: (arm === 'A' ? 800 : 1000) + (index % 10) });

describe('PB-AB command: the refusals before anything starts', () => {
  it('prints the usage and exits 0 for --help, and exits 2 with the usage for a mistake', async () => {
    const help = capture();
    expect(await main(['--help'], help.io, neverStarted)).toBe(0);
    expect(help.out.join('')).toContain('npm run ab -- --prereg');

    const wrong = capture();
    expect(await main(['--prereg'], wrong.io, neverStarted)).toBe(2);
    expect(wrong.err.join('\n')).toContain('npm run ab -- --prereg');
    expect(await main(['--report', 'a', '--splits', '5'], capture().io, neverStarted)).toBe(2);
  });

  it('refuses a plan that is not valid, naming the problems, and starts nothing', async () => {
    const plan = { ...startupPrereg(), sessionsPerArm: 3, seed: -1 };
    writePlan('invalid.json', plan);
    const run = capture();
    expect(await main(['--prereg', 'invalid.json'], run.io, neverStarted)).toBe(2);
    const text = run.err.join('\n');
    expect(text).toContain('PROBLEM');
    expect(text).toContain('invalid.json is not a valid pre-registration');
    expect(text).toContain('refuses to run without a valid pre-registration');
  });

  it('refuses a plan that is missing', async () => {
    const run = capture();
    expect(await main(['--prereg', 'absent.json'], run.io, neverStarted)).toBe(2);
    expect(run.err.join('\n')).toContain('cannot be read');
  });

  it('refuses a plan that git does not track, and one that has changed since it was committed: the report would prove nothing', async () => {
    writePlan('untracked.json', startupPrereg());
    const untracked = capture();
    expect(await main(['--prereg', 'untracked.json'], untracked.io, neverStarted)).toBe(2);
    expect(untracked.err.join('\n')).toContain(
      'untracked.json is not committed unmodified (git does not track it)',
    );
    expect(untracked.err.join('\n')).toContain('--allow-uncommitted-prereg');

    commitPlan('changed.json', startupPrereg());
    writePlan('changed.json', { ...startupPrereg(), seed: 1 });
    const changed = capture();
    expect(await main(['--prereg', 'changed.json'], changed.io, neverStarted)).toBe(2);
    expect(changed.err.join('\n')).toContain(
      'changed.json is not committed unmodified (it has changes against HEAD)',
    );
  });

  it('says so when the machine cannot be started, and exits 2', async () => {
    commitPlan('machine.json', smallJson());
    const run = capture();
    const failing: StartMachine = async () => {
      throw new Error('port 4720 is already in use');
    };
    expect(await main(['--prereg', 'machine.json'], run.io, failing)).toBe(2);
    expect(run.err.join('\n')).toContain('could not be started: port 4720 is already in use');
  });

  it('refuses an experiment whose A/A check is missing, before a single session', async () => {
    commitPlan('no-aa.json', experimentPlan());
    const machine = fakeMachine();
    const run = capture();
    expect(await main(['--prereg', 'no-aa.json', '--out-dir', 'out-no-aa'], run.io, machine.start)).toBe(2);
    const text = run.err.join('\n');
    expect(text).toContain(`The A/A report ${AA_SOURCE} is not there`);
    expect(text).toContain('No A/B verdict is published until the harness has passed its own check');
    expect(machine.log).toStrictEqual(['machine stopped']);
    expect(existsSync(join(directory, 'out-no-aa'))).toBe(false);
  });

  it('refuses an experiment when the A/A report is from another environment, or its calibration did not pass', async () => {
    commitPlan('wrong-aa.json', experimentPlan());
    commitAaReport({ environment: { envId: 'docker-linux-arm64' } });
    const elsewhere = capture();
    expect(await main(['--prereg', 'wrong-aa.json'], elsewhere.io, fakeMachine().start)).toBe(2);
    expect(elsewhere.err.join('\n')).toContain(
      'it was measured in docker-linux-arm64, this run is in fixture-env: the check is per environment',
    );

    commitAaReport({ calibrations: [{ condition: 'high-latency', result: { pass: false } }] });
    const failed = capture();
    expect(await main(['--prereg', 'wrong-aa.json'], failed.io, fakeMachine().start)).toBe(2);
    expect(failed.err.join('\n')).toContain('its A/A calibration of high-latency did not pass');
  });
});

describe('PB-AB command: a pipeline check', () => {
  it('runs the plan on the machine it is given, writes the files, and says in every line that it is plumbing only, not evidence', async () => {
    commitPlan('small.json', smallJson());
    const machine = fakeMachine();
    const run = capture();
    const code = await main(
      ['--prereg', 'small.json', '--port', '4723', '--out-dir', 'out-run'],
      run.io,
      machine.start,
    );
    expect(code).toBe(0);
    expect(machine.started).toStrictEqual([{ port: 4723, engine: 'chromium' }]);
    expect(machine.log.at(-1)).toBe('machine stopped');

    const written = filesIn(join(directory, 'out-run'));
    expect(written).toHaveLength(3);
    const pattern = /^PB-AB-002\.fixture-env\.20991105T0900\d\dZ\.(raw\.json|report\.json|report\.md)$/;
    expect(written.every((name) => pattern.test(name))).toBe(true);
    const report = read('out-run', written.find((n) => n.endsWith('.report.md')) as string);
    expect(report).toContain('PIPELINE CHECK, PLUMBING ONLY, NOT EVIDENCE');
    expect(report).toContain('## Plumbing checks (pipeline check, plumbing only, not evidence)');
    expect(report).toContain('committed unmodified in');

    expect(run.out).toHaveLength(2);
    expect(run.out[0]).toBe(
      'PB-AB-002 high-latency: no verdict (pipeline check, plumbing only, not evidence).',
    );
    expect(run.out[1]).toContain(
      'PB-AB-002 validity: Plumbing checks passed (6 of 6). This is a pipeline check, plumbing only, not evidence.',
    );
    const progress = run.err.join('\n');
    expect(progress).toMatch(/\[PB-AB-002 high-latency\] 1\/10 warm-up A: startup/);
    expect(progress).toMatch(/\[PB-AB-002 high-latency\] 10\/10 [AB]: startup/);
  });

  it('writes a report that --report reproduces byte for byte from the raw results', async () => {
    commitPlan('again.json', smallJson());
    expect(
      await main(['--prereg', 'again.json', '--out-dir', 'out-again'], capture().io, fakeMachine().start),
    ).toBe(0);
    const folder = join(directory, 'out-again');
    const files = filesIn(folder);
    const raw = files.find((name) => name.endsWith('.raw.json')) as string;
    const reports = files.filter((name) => name.includes('.report.'));
    const before = reports.map((name) => readFileSync(join(folder, name), 'utf8'));

    expect(await main(['--report', join('out-again', raw)], capture().io, neverStarted)).toBe(0);
    expect(filesIn(folder)).toStrictEqual(files);
    expect(reports.map((name) => readFileSync(join(folder, name), 'utf8'))).toStrictEqual(before);
  });

  it('is not valid when its plan was not committed: the report is still written, and the exit code says the run cannot be trusted', async () => {
    writePlan('loose.json', smallJson());
    const run = capture();
    const code = await main(
      ['--prereg', 'loose.json', '--allow-uncommitted-prereg', '--out-dir', 'out-loose'],
      run.io,
      fakeMachine().start,
    );
    expect(code).toBe(2);
    expect(run.err.join('\n')).toContain('PROBLEM: Plumbing checks FAILED: Pre-registration fixed first');
    const report = read(
      'out-loose',
      filesIn(join(directory, 'out-loose')).find((n) => n.endsWith('.report.md')) as string,
    );
    expect(report).toContain('| Pre-registration fixed first | FAIL |');
    expect(report).toContain('does not prove the plan was fixed before the data');
  });

  it('runs only the condition it is told to, and stops the machine when it cannot', async () => {
    commitPlan('one-condition.json', smallJson());
    const machine = fakeMachine();
    const run = capture();
    const code = await main(
      ['--prereg', 'one-condition.json', '--condition', 'nope', '--out-dir', 'out-none'],
      run.io,
      machine.start,
    );
    expect(code).toBe(2);
    expect(run.err.join('\n')).toContain('no condition "nope"');
    expect(machine.log).toStrictEqual(['machine stopped']);
    expect(existsSync(join(directory, 'out-none'))).toBe(false);
  });

  it('exits 2 when a condition was stopped early, after writing what it has', async () => {
    commitPlan('stopped.json', smallJson());
    const machine = fakeMachine(() => ({ fail: 'timeout' }));
    const run = capture();
    const code = await main(['--prereg', 'stopped.json', '--out-dir', 'out-stopped'], run.io, machine.start);
    expect(code).toBe(2);
    expect(run.err.join('\n')).toMatch(/high-latency stopped early: 5 sessions failed in a row/);
    expect(run.err.join('\n')).toContain('Plumbing checks FAILED: Design followed');
    expect(filesIn(join(directory, 'out-stopped'))).toHaveLength(3);
  });

  it('exits 2 and writes nothing when the harness itself is broken (a configuration that is not the one asked for)', async () => {
    commitPlan('broken.json', smallJson());
    const machine = fakeMachine(() => ({ fail: 'mismatch' }));
    const run = capture();
    const code = await main(['--prereg', 'broken.json', '--out-dir', 'out-broken'], run.io, machine.start);
    expect(code).toBe(2);
    expect(run.err.join('\n')).toContain('PROBLEM');
    expect(existsSync(join(directory, 'out-broken'))).toBe(false);
    expect(machine.log.at(-1)).toBe('machine stopped');
  });
});

describe('PB-AB command: the lab passes an experiment when it is valid, not by the direction of its result', () => {
  it('exits 0 for a valid experiment in which B is better, and prints the verdict and the validity', async () => {
    commitPlan('b-better.json', experimentPlan());
    commitAaReport();
    const run = capture();
    const code = await main(
      ['--prereg', 'b-better.json', '--out-dir', 'out-b-better'],
      run.io,
      fakeMachine(bFaster).start,
    );
    expect(code).toBe(0);
    expect(run.out).toHaveLength(2);
    expect(run.out[0]).toContain('PB-AB-002 high-latency: B better (ship B).');
    expect(run.out[1]).toContain('PB-AB-002 validity: VALID: the experiment was run as pre-registered');
    const md = filesIn(join(directory, 'out-b-better')).find((n) => n.endsWith('.report.md')) as string;
    const report = read('out-b-better', md);
    expect(report).toContain('**Validity:** VALID');
    expect(report).toContain('| A/A check passed (PB-AB-001) | PASS |');
  });

  it('exits 0 for a valid experiment in which A is better: the direction drives the decision, not the exit code', async () => {
    commitPlan('a-better.json', experimentPlan());
    commitAaReport();
    const run = capture();
    const code = await main(
      ['--prereg', 'a-better.json', '--out-dir', 'out-a-better'],
      run.io,
      fakeMachine(bSlower).start,
    );
    expect(code).toBe(0);
    expect(run.out[0]).toContain('PB-AB-002 high-latency: A better (do not ship B).');
    expect(run.out[1]).toContain('VALID');
    expect(run.err.join('\n')).not.toContain('PROBLEM');
  });

  it('exits 0 for a valid experiment that cannot tell, and for one that finds the arms equivalent', async () => {
    commitPlan('quiet.json', experimentPlan());
    commitAaReport();
    const equivalent = capture();
    expect(
      await main(['--prereg', 'quiet.json', '--out-dir', 'out-quiet'], equivalent.io, fakeMachine().start),
    ).toBe(0);
    expect(equivalent.out[0]).toMatch(/PB-AB-002 high-latency: (Equivalent within the margin|Inconclusive)/);
    expect(equivalent.out[1]).toContain('VALID');
  });

  it('exits 2 when the condition was not applied in a session, whatever the verdict: the result must not be acted on', async () => {
    commitPlan('not-applied.json', experimentPlan());
    commitAaReport();
    const run = capture();
    const script: Script = (arm, index) => ({
      ...bFaster(arm, index),
      ...(index === 5 ? { fail: 'not-applied' as const } : {}),
    });
    const code = await main(
      ['--prereg', 'not-applied.json', '--out-dir', 'out-not-applied'],
      run.io,
      fakeMachine(script).start,
    );
    expect(code).toBe(2);
    expect(run.out[0]).toContain('B better (ship B)');
    expect(run.out[1]).toContain('NOT VALID: Condition applied, the same in both arms');
    expect(run.err.join('\n')).toContain('PROBLEM: NOT VALID');
    const md = filesIn(join(directory, 'out-not-applied')).find((n) => n.endsWith('.report.md')) as string;
    expect(read('out-not-applied', md)).toContain('| Condition applied, the same in both arms | FAIL |');
  });

  it('exits 2 for an experiment whose plan was run uncommitted, however clean the data', async () => {
    writePlan('uncommitted-experiment.json', experimentPlan());
    commitAaReport();
    const run = capture();
    const code = await main(
      [
        '--prereg',
        'uncommitted-experiment.json',
        '--allow-uncommitted-prereg',
        '--out-dir',
        'out-uncommitted',
      ],
      run.io,
      fakeMachine(bFaster).start,
    );
    expect(code).toBe(2);
    expect(run.out[1]).toContain('NOT VALID: Pre-registration fixed first');
  });
});

describe('PB-AB command: an A/A run', () => {
  it('appends the A/A calibration to the report of an A/A run, and exits 0 when the harness passes it', async () => {
    commitPlan('aa.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    const run = capture();
    const code = await main(
      ['--prereg', 'aa.json', '--splits', '100', '--out-dir', 'out-aa'],
      run.io,
      fakeMachine().start,
    );
    expect(code).toBe(0);
    const folder = join(directory, 'out-aa');
    const files = filesIn(folder);
    const markdown = files.find((name) => name.endsWith('.report.md')) as string;
    const report = read('out-aa', markdown);
    expect(report).toContain('## A/A calibration (PB-AB-001)');
    expect(report).toContain('PASS');
    expect(report).toContain('**Validity:** VALID');
    expect(run.err.join('\n')).toContain('A/A calibration of high-latency: 60 sessions, 100 splits');
    expect(files.filter((name) => name.includes('.calibration.'))).toStrictEqual([
      expect.stringMatching(/\.calibration\.high-latency\.json$/),
      expect.stringMatching(/\.calibration\.high-latency\.md$/),
    ]);

    // The calibration was written next to the raw results, so the report that is made again has it too.
    const raw = files.find((name) => name.endsWith('.raw.json')) as string;
    const reports = files.filter((name) => name.includes('.report.'));
    const before = reports.map((name) => readFileSync(join(folder, name), 'utf8'));
    expect(await main(['--report', join('out-aa', raw)], capture().io, neverStarted)).toBe(0);
    expect(reports.map((name) => readFileSync(join(folder, name), 'utf8'))).toStrictEqual(before);
  });

  it('refuses the options of an A/A run on a plan that is not one, instead of ignoring them', async () => {
    commitPlan('not-aa.json', smallJson());
    const run = capture();
    expect(await main(['--prereg', 'not-aa.json', '--no-calibration'], run.io, neverStarted)).toBe(2);
    expect(run.err.join('\n')).toContain('--no-calibration belongs to the run of an A/A pre-registration');
    expect(await main(['--prereg', 'not-aa.json', '--splits', '100'], run.io, neverStarted)).toBe(2);
  });

  it('skips the calibration when told to', async () => {
    commitPlan('aa-quick.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    await main(
      ['--prereg', 'aa-quick.json', '--no-calibration', '--out-dir', 'out-aa-quick'],
      capture().io,
      fakeMachine().start,
    );
    const markdown = filesIn(join(directory, 'out-aa-quick')).find((name) =>
      name.endsWith('.report.md'),
    ) as string;
    expect(read('out-aa-quick', markdown)).not.toContain('## A/A calibration');
  });

  it('exits 1, not 2, when the run is valid but the harness declares a difference between two copies of A', async () => {
    commitPlan('aa-bad.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    // The player is slower by 900 ms in every session of the arm that runs second in a block: a harness bias.
    const biased: Script = (_arm, index) => ({
      startupMs: 800 + (index % 4 === 1 || index % 4 === 2 ? 900 : 0),
    });
    const run = capture();
    const code = await main(
      ['--prereg', 'aa-bad.json', '--no-calibration', '--out-dir', 'out-aa-bad'],
      run.io,
      fakeMachine(biased).start,
    );
    expect(code).toBe(1);
    expect(run.err.join('\n')).toContain('the A/A check failed');
    expect(run.out[1]).toContain('VALID');
  });
});

describe('PB-AB command: the modes without a browser', () => {
  const rules = [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }] as never;
  const aaText = `${JSON.stringify(aaPrereg(), null, 2)}\n`;

  it('writes the report of a raw results file again, next to it, with its validity', async () => {
    const sessions = scheduled(
      startupOnly(Array.from({ length: 30 }, (_, i) => 900 + 7 * i)),
      startupOnly(Array.from({ length: 30 }, (_, i) => 905 + 7 * i)),
      { config: 'A' },
    );
    const raw = buildRaw({ text: aaText, conditionId: 'high-latency', rules }, sessions);
    writeRawResult(join(directory, 'results'), 'again.env.20261105T090000Z', raw);
    const run = capture();
    expect(
      await main(['--report', 'results/again.env.20261105T090000Z.raw.json'], run.io, neverStarted),
    ).toBe(0);
    expect(filesIn(join(directory, 'results'))).toStrictEqual([
      'again.env.20261105T090000Z.raw.json',
      'again.env.20261105T090000Z.report.json',
      'again.env.20261105T090000Z.report.md',
    ]);
    expect(run.out.join('\n')).toContain('PB-AB-001-high-latency high-latency:');
    expect(run.out.at(-1)).toContain('PB-AB-001-high-latency validity: VALID');
  });

  it('exits 2 when the report it regenerates is of a run that was not valid', async () => {
    const raw = buildRaw(
      { text: aaText, conditionId: 'high-latency', rules },
      interleaved(startupOnly([900, 950, 1000, 1050]), startupOnly([850, 900, 930, 980])),
    );
    writeRawResult(join(directory, 'invalid-results'), 'short.env.20261105T090000Z', raw);
    const run = capture();
    expect(
      await main(['--report', 'invalid-results/short.env.20261105T090000Z.raw.json'], run.io, neverStarted),
    ).toBe(2);
    expect(run.err.join('\n')).toContain('PROBLEM: NOT VALID: Design followed');
  });

  it('calibrates the pool of a results file, writes the calibration next to it and exits 0 when it passes', async () => {
    const raw = buildRaw({ text: aaText, conditionId: 'high-latency', rules }, aaPool(generator(21), 60));
    writeRawResult(join(directory, 'calibration'), 'pool.env.20261105T090000Z', raw);
    const run = capture();
    const code = await main(
      ['--calibrate', 'calibration/pool.env.20261105T090000Z.raw.json', '--splits', '100'],
      run.io,
      neverStarted,
    );
    expect(code).toBe(0);
    expect(filesIn(join(directory, 'calibration'))).toStrictEqual([
      'pool.env.20261105T090000Z.calibration.high-latency.json',
      'pool.env.20261105T090000Z.calibration.high-latency.md',
      'pool.env.20261105T090000Z.raw.json',
    ]);
    const saved = JSON.parse(read('calibration', 'pool.env.20261105T090000Z.calibration.high-latency.json'));
    expect(saved).toMatchObject({ condition: 'high-latency', splits: 100, alpha: 0.05, poolSessions: 60 });
    expect(run.out.join('\n')).toContain('A/A calibration (PB-AB-001)');
  });

  it('writes the power analysis of a pilot', async () => {
    const raw = buildRaw({ text: aaText, conditionId: 'high-latency', rules }, aaPool(generator(22), 40));
    writeRawResult(join(directory, 'power'), 'pilot.env.20261105T090000Z', raw);
    const run = capture();
    const code = await main(
      ['--power', 'power/pilot.env.20261105T090000Z.raw.json', '--simulations', '30', '--seed', '3'],
      run.io,
      neverStarted,
    );
    expect(code).toBe(0);
    expect(filesIn(join(directory, 'power'))).toStrictEqual([
      'pilot.env.20261105T090000Z.power-30.json',
      'pilot.env.20261105T090000Z.power-30.md',
      'pilot.env.20261105T090000Z.raw.json',
    ]);
    expect(run.out.join('\n')).toContain('# Power of PB-AB-001-high-latency under high-latency');
  });

  it('refuses a results file that is missing, broken, or not a pilot, with exit 2 and a problem', async () => {
    const missing = capture();
    expect(await main(['--report', 'results/missing.raw.json'], missing.io, neverStarted)).toBe(2);
    expect(missing.err.join('\n')).toContain('PROBLEM');

    writeFileSync(join(directory, 'broken.raw.json'), '{ "kind": ');
    const broken = capture();
    expect(await main(['--calibrate', 'broken.raw.json'], broken.io, neverStarted)).toBe(2);
    expect(broken.err.join('\n')).toContain('not valid JSON');

    const experiment = buildRaw(
      { text: aaText, conditionId: 'high-latency', rules },
      interleaved(startupOnly([900, 950, 1000, 1050]), startupOnly([850, 900, 930, 980])),
    );
    writeRawResult(join(directory, 'mixed'), 'both.env.20261105T090000Z', experiment);
    const mixed = capture();
    expect(await main(['--power', 'mixed/both.env.20261105T090000Z.raw.json'], mixed.io, neverStarted)).toBe(
      2,
    );
    expect(mixed.err.join('\n')).toContain('a pilot is made of configuration A');
  });
});
