import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../../ab/cli.ts';
import type { StartMachine } from '../../../ab/cli.ts';
import { writeRawResult } from '../../../ab/files.ts';
import { aaPrereg, startupPrereg } from './fixtures.ts';
import { generator } from './helpers.ts';
import { machineOf, smallJson, world } from './fake-world.ts';
import type { Script } from './fake-world.ts';
import { scratchDirectory } from './scratch.ts';
import { aaPool, buildRaw, interleaved, startupOnly } from './synthetic.ts';

// The command with a fake machine in place of the service and the browser: what it refuses before anything starts, what it writes, what its
// exit code says, and the modes that need no browser at all.

const directory = scratchDirectory('ab-cli');

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

  it('refuses a valid plan that git does not hold committed and unmodified: the report would prove nothing', async () => {
    writePlan('uncommitted.json', startupPrereg());
    const run = capture();
    expect(await main(['--prereg', 'uncommitted.json'], run.io, neverStarted)).toBe(2);
    const text = run.err.join('\n');
    expect(text).toContain('uncommitted.json is not committed unmodified');
    expect(text).toContain('--allow-uncommitted-prereg');
  });

  it('says so when the machine cannot be started, and exits 2', async () => {
    writePlan('machine.json', smallJson());
    const run = capture();
    const failing: StartMachine = async () => {
      throw new Error('port 4720 is already in use');
    };
    expect(await main(['--prereg', 'machine.json', '--allow-uncommitted-prereg'], run.io, failing)).toBe(2);
    expect(run.err.join('\n')).toContain('could not be started: port 4720 is already in use');
  });
});

describe('PB-AB command: a run', () => {
  it('runs the plan on the machine it is given, writes the raw results and the report, and prints the verdict line', async () => {
    writePlan('small.json', smallJson());
    const machine = fakeMachine();
    const run = capture();
    const code = await main(
      ['--prereg', 'small.json', '--allow-uncommitted-prereg', '--port', '4723', '--out-dir', 'out-run'],
      run.io,
      machine.start,
    );
    expect(code).toBe(0);
    expect(machine.started).toStrictEqual([{ port: 4723, engine: 'chromium' }]);
    expect(machine.log.at(-1)).toBe('machine stopped');

    const written = filesIn(join(directory, 'out-run'));
    expect(written).toHaveLength(3);
    const pattern = /^PB-AB-002\.fixture-env\.20261105T0900\d\dZ\.(raw\.json|report\.json|report\.md)$/;
    expect(written.every((name) => pattern.test(name))).toBe(true);
    const report = readFileSync(
      join(directory, 'out-run', written.find((n) => n.endsWith('.report.md')) as string),
      'utf8',
    );
    expect(report).toContain('PB-AB-002');
    expect(report).toMatch(/was NOT committed, unmodified|Git could not say/);

    expect(run.out).toHaveLength(1);
    expect(run.out[0]).toContain('PB-AB-002 high-latency:');
    const progress = run.err.join('\n');
    expect(progress).toMatch(/\[PB-AB-002 high-latency\] 1\/10 warm-up A: startup/);
    expect(progress).toMatch(/\[PB-AB-002 high-latency\] 10\/10 [AB]: startup/);
  });

  it('runs only the condition it is told to, and stops the machine when it cannot', async () => {
    writePlan('one-condition.json', smallJson());
    const machine = fakeMachine();
    const run = capture();
    const code = await main(
      [
        '--prereg',
        'one-condition.json',
        '--allow-uncommitted-prereg',
        '--condition',
        'nope',
        '--out-dir',
        'out-none',
      ],
      run.io,
      machine.start,
    );
    expect(code).toBe(2);
    expect(run.err.join('\n')).toContain('no condition "nope"');
    expect(machine.log).toStrictEqual(['machine stopped']);
    expect(existsSync(join(directory, 'out-none'))).toBe(false);
  });

  it('exits 2 when a condition was stopped early, after writing what it has', async () => {
    writePlan('stopped.json', smallJson());
    const machine = fakeMachine(() => ({ fail: 'timeout' }));
    const run = capture();
    const code = await main(
      ['--prereg', 'stopped.json', '--allow-uncommitted-prereg', '--out-dir', 'out-stopped'],
      run.io,
      machine.start,
    );
    expect(code).toBe(2);
    expect(run.err.join('\n')).toMatch(/high-latency stopped early: 5 sessions failed in a row/);
    expect(filesIn(join(directory, 'out-stopped'))).toHaveLength(3);
  });

  it('exits 2 and writes nothing when the harness itself is broken (a configuration that is not the one asked for)', async () => {
    writePlan('broken.json', smallJson());
    const machine = fakeMachine(() => ({ fail: 'mismatch' }));
    const run = capture();
    const code = await main(
      ['--prereg', 'broken.json', '--allow-uncommitted-prereg', '--out-dir', 'out-broken'],
      run.io,
      machine.start,
    );
    expect(code).toBe(2);
    expect(run.err.join('\n')).toContain('PROBLEM');
    expect(existsSync(join(directory, 'out-broken'))).toBe(false);
    expect(machine.log.at(-1)).toBe('machine stopped');
  });

  it('appends the A/A calibration to the report of an A/A run, and exits 0 when the harness passes it', async () => {
    writePlan('aa.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    const machine = fakeMachine();
    const run = capture();
    const code = await main(
      ['--prereg', 'aa.json', '--allow-uncommitted-prereg', '--splits', '100', '--out-dir', 'out-aa'],
      run.io,
      machine.start,
    );
    expect(code).toBe(0);
    const markdown = filesIn(join(directory, 'out-aa')).find((name) => name.endsWith('.report.md')) as string;
    const report = readFileSync(join(directory, 'out-aa', markdown), 'utf8');
    expect(report).toContain('## A/A calibration (PB-AB-001)');
    expect(report).toContain('PASS');
    expect(run.err.join('\n')).toContain('A/A calibration of high-latency: 60 sessions, 100 splits');
  });

  it('refuses the options of an A/A run on a plan that is not one, instead of ignoring them', async () => {
    writePlan('not-aa.json', smallJson());
    const run = capture();
    expect(
      await main(
        ['--prereg', 'not-aa.json', '--allow-uncommitted-prereg', '--no-calibration'],
        run.io,
        neverStarted,
      ),
    ).toBe(2);
    expect(run.err.join('\n')).toContain('--no-calibration belongs to the run of an A/A pre-registration');
    expect(
      await main(
        ['--prereg', 'not-aa.json', '--allow-uncommitted-prereg', '--splits', '100'],
        run.io,
        neverStarted,
      ),
    ).toBe(2);
  });

  it('skips the calibration when told to', async () => {
    writePlan('aa-quick.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    const machine = fakeMachine();
    const run = capture();
    await main(
      [
        '--prereg',
        'aa-quick.json',
        '--allow-uncommitted-prereg',
        '--no-calibration',
        '--out-dir',
        'out-aa-quick',
      ],
      run.io,
      machine.start,
    );
    const markdown = filesIn(join(directory, 'out-aa-quick')).find((name) =>
      name.endsWith('.report.md'),
    ) as string;
    expect(readFileSync(join(directory, 'out-aa-quick', markdown), 'utf8')).not.toContain(
      '## A/A calibration',
    );
  });

  it('exits 1 when the A/A comparison of the harness declares a difference between two copies of A', async () => {
    writePlan('aa-bad.json', { ...aaPrereg(), bootstrapResamples: 1000 });
    // The player is slower by half a second in every session of the arm that runs second in a block: a harness bias.
    const biased: Script = (_arm, index) => ({
      startupMs: 800 + (index % 4 === 1 || index % 4 === 2 ? 900 : 0),
    });
    const machine = fakeMachine(biased);
    const run = capture();
    const code = await main(
      [
        '--prereg',
        'aa-bad.json',
        '--allow-uncommitted-prereg',
        '--no-calibration',
        '--out-dir',
        'out-aa-bad',
      ],
      run.io,
      machine.start,
    );
    expect(code).toBe(1);
    expect(run.err.join('\n')).toContain('the A/A check failed');
  });
});

describe('PB-AB command: the modes without a browser', () => {
  const rules = [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }] as never;
  const aaText = `${JSON.stringify(aaPrereg(), null, 2)}\n`;

  it('writes the report of a raw results file again, next to it', async () => {
    const sessions = interleaved(
      startupOnly(Array.from({ length: 30 }, (_, i) => 900 + 7 * i)),
      startupOnly(Array.from({ length: 30 }, (_, i) => 905 + 7 * i)),
      () => ({ config: 'A' }),
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
      'pool.env.20261105T090000Z.calibration.json',
      'pool.env.20261105T090000Z.calibration.md',
      'pool.env.20261105T090000Z.raw.json',
    ]);
    const saved = JSON.parse(
      readFileSync(join(directory, 'calibration', 'pool.env.20261105T090000Z.calibration.json'), 'utf8'),
    );
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
