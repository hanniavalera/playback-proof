import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRunFile } from '../../../flake/reporter.ts';
import type { Outcome } from '../../../flake/run.ts';
import { FileStore } from '../../../flake/store.ts';
import {
  collect,
  CollectError,
  defaultOptions,
  FLAKE_REPORTER,
  invocationFor,
  parseArgs,
} from '../../../tools/flake-collect.ts';
import type { CollectOptions } from '../../../tools/flake-collect.ts';
import type { Invocation } from '../../../tools/gate-merge.ts';
import { makeScratch } from '../support/scratch.ts';
import { record, run } from './fixtures.ts';

const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = makeScratch('flake-collect-');
  scratches.push(dir);
  return dir;
};

interface Step {
  /** What `playwright` exits with; null means it was killed. */
  exit: number | null;
  /** The outcomes of the two tests of the fake suite in this repetition; no run file is written when absent. */
  outcomes?: [Outcome, Outcome];
  /** Writes something that is not a run file. */
  garbage?: boolean;
}

/** A stand-in for Playwright that does what the real reporter does: write the file the environment names. */
function fakePlaywright(steps: Step[]) {
  const seen: Invocation[] = [];
  return {
    seen,
    run: async (invocation: Invocation): Promise<number | null> => {
      const step = steps[seen.length] as Step;
      seen.push(invocation);
      const file = invocation.env.PB_FLAKE_RUN_FILE as string;
      if (step.garbage) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '{"not":"a run"}');
      } else if (step.outcomes) {
        writeRunFile(
          file,
          run(
            [
              record({ id: 'PB-VOD-001', outcome: step.outcomes[0] }),
              record({ id: 'PB-VOD-002', outcome: step.outcomes[1] }),
            ],
            { envId: 'fake-env', runId: invocation.env.PB_RUN_ID as string },
          ),
        );
      }
      return step.exit;
    },
  };
}

function options(dir: string, overrides: Partial<CollectOptions> = {}): CollectOptions {
  return {
    ...defaultOptions(dir),
    historyDir: join(dir, 'history'),
    runIdPrefix: 'collect-test',
    ...overrides,
  };
}

describe('PB-LAB-004 flake-collect: the invocation of a repetition', () => {
  it('asks for the tests, the engines, one retry and the flake reporter, and gives every repetition files of its own', () => {
    const o = options('/work', {
      runs: 3,
      projects: ['chromium', 'webkit'],
      playwrightArgs: ['--workers=1'],
    });
    expect(invocationFor(o, 2)).toEqual({
      label: 'repetition 2 of 3',
      args: [
        'test',
        '--project',
        'chromium',
        '--project',
        'webkit',
        '--grep',
        '@merge',
        '--retries',
        '1',
        '--reporter',
        `dot,${FLAKE_REPORTER}`,
        '--output',
        '/work/reports/flake/collect/test-results',
        '--workers=1',
      ],
      env: { PB_RUN_ID: 'collect-test-2', PB_FLAKE_RUN_FILE: '/work/reports/flake/collect/run-2.json' },
    });
    expect(FLAKE_REPORTER).toMatch(/\/flake\/reporter\.ts$/);
    expect(invocationFor(o, 3).env.PB_FLAKE_RUN_FILE).not.toBe(invocationFor(o, 2).env.PB_FLAKE_RUN_FILE);
  });

  it('runs every project of the configuration when none is named, and takes the retries and the reporters it is given', () => {
    const o = options('/work', { retries: 2, reporters: ['list', '/x/other.mjs'], grep: '@release' });
    const args = invocationFor(o, 1).args;
    expect(args).not.toContain('--project');
    expect(args.slice(1, 8)).toEqual([
      '--grep',
      '@release',
      '--retries',
      '2',
      '--reporter',
      `list,/x/other.mjs,${FLAKE_REPORTER}`,
      '--output',
    ]);
  });
});

describe('PB-LAB-004 flake-collect: the repetitions', () => {
  it('records every repetition in the history, one line each, and says what it saw', async () => {
    const dir = scratch();
    const fake = fakePlaywright([
      { exit: 0, outcomes: ['passed', 'passed'] },
      { exit: 0, outcomes: ['passed', 'flaky'] },
      { exit: 1, outcomes: ['failed', 'passed'] },
    ]);
    const lines: string[] = [];
    const result = await collect(options(dir, { runs: 3 }), { run: fake.run, log: (l) => lines.push(l) });

    expect(fake.seen.map((i) => i.env.PB_RUN_ID)).toEqual([
      'collect-test-1',
      'collect-test-2',
      'collect-test-3',
    ]);
    expect(result).toMatchObject({ executions: 6, flakyOutcomes: 1, failedOutcomes: 1, interrupted: false });
    expect(result.repetitions.map((r) => [r.index, r.exitCode, r.added])).toEqual([
      [1, 0, true],
      [2, 0, true],
      [3, 1, true],
    ]);
    expect(lines[0]).toBe('repetition 1 of 3: exit 0, 2 tests executed, 0 flaky, 0 failed');
    expect(lines[1]).toBe(
      'repetition 2 of 3: exit 0, 2 tests executed, 1 flaky [PB-VOD-002 (chromium)], 0 failed',
    );
    expect(lines[2]).toBe(
      'repetition 3 of 3: exit 1, 2 tests executed, 0 flaky, 1 failed [PB-VOD-001 (chromium)]',
    );
    expect(lines.at(-1)).toBe(
      `collected 3 of 3 runs into ${join(dir, 'history')}: 6 executions, 1 flaky, 1 failed. Next: npm run flake:report`,
    );

    const history = await new FileStore({ dir: join(dir, 'history') }).load('fake-env');
    expect(history.map((r) => r.runId)).toEqual(['collect-test-1', 'collect-test-2', 'collect-test-3']);
    expect(readdirSync(join(dir, 'history'))).toEqual(['fake-env.jsonl']);
  });

  it('keeps going after a failing run (a failure is data), and stops when Playwright was killed, keeping what it has', async () => {
    const dir = scratch();
    const killed = fakePlaywright([
      { exit: 1, outcomes: ['failed', 'failed'] },
      { exit: null },
      { exit: 0, outcomes: ['passed', 'passed'] },
    ]);
    const lines: string[] = [];
    const result = await collect(options(dir, { runs: 3 }), { run: killed.run, log: (l) => lines.push(l) });
    expect(killed.seen).toHaveLength(2);
    expect(result.interrupted).toBe(true);
    expect(result.repetitions).toHaveLength(1);
    expect(lines).toContain('repetition 2 of 3: playwright was killed; stopping with 1 recorded');
    expect((await new FileStore({ dir: join(dir, 'history') }).load('fake-env')).length).toBe(1);
  });

  it('keeps the repetitions it recorded when a later one cannot be read, and says which file and why', async () => {
    const dir = scratch();
    const noFile = fakePlaywright([{ exit: 0, outcomes: ['passed', 'passed'] }, { exit: 2 }]);
    await expect(
      collect(options(dir, { runs: 3, grep: '@nothing' }), { run: noFile.run, log: () => {} }),
    ).rejects.toThrow(
      new RegExp(
        `repetition 2 of 3: playwright exited with 2 and wrote no run file \\(${resolve(dir, 'reports/flake/collect/run-2.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\).*no test matched --grep @nothing`,
      ),
    );
    expect((await new FileStore({ dir: join(dir, 'history') }).load('fake-env')).length).toBe(1);

    const failure = (await collect(options(scratch(), { runs: 1 }), {
      run: fakePlaywright([{ exit: 0, garbage: true }]).run,
      log: () => {},
    }).catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(CollectError);
    expect(failure.message).toMatch(/is not a run file: .*schemaVersion/);
  });

  it('warns when there is no retry to see a flake with', async () => {
    const dir = scratch();
    const lines: string[] = [];
    const o = options(dir, { runs: 1, retries: 0 });
    await collect(o, {
      run: fakePlaywright([{ exit: 0, outcomes: ['passed', 'passed'] }]).run,
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe(
      'retries is 0: a flaky test cannot show as flaky without a retry, so these runs say nothing about flakiness (use --retries 1)',
    );
  });
});

describe('PB-LAB-004 flake-collect: the command line', () => {
  it('reads the options of the brief: --project, --runs, --grep, and what follows -- goes to Playwright', () => {
    const o = parseArgs(
      [
        '--project',
        'chromium',
        '--runs',
        '30',
        '--grep',
        '@merge',
        '--',
        '--workers=1',
        '--timeout',
        '60000',
      ],
      '/work',
    ) as CollectOptions;
    expect(o).toMatchObject({
      runs: 30,
      projects: ['chromium'],
      grep: '@merge',
      retries: 1,
      reporters: ['dot'],
      playwrightArgs: ['--workers=1', '--timeout', '60000'],
      cwd: '/work',
    });
    expect(o.historyDir).toBeUndefined();
  });

  it('reads the forms with =, several projects and reporters, a history directory and the retries', () => {
    const o = parseArgs(
      [
        '--project=chromium',
        '--project=firefox',
        '--runs=5',
        '--retries=2',
        '--history-dir=out/h',
        '--reporter=list',
        '--reporter',
        'line',
      ],
      '/work',
    ) as CollectOptions;
    expect(o).toMatchObject({
      runs: 5,
      projects: ['chromium', 'firefox'],
      retries: 2,
      reporters: ['list', 'line'],
      historyDir: '/work/out/h',
    });
  });

  it('prints the usage for --help, and refuses what it does not understand', () => {
    expect(parseArgs(['--help'], '/work')).toBe('help');
    expect(() => parseArgs(['--runs', '0'], '/work')).toThrow(/--runs must be a whole number of at least 1/);
    expect(() => parseArgs(['--runs', 'many'], '/work')).toThrow(/--runs must be a whole number/);
    expect(() => parseArgs(['--retries', '-1'], '/work')).toThrow(
      /--retries must be a whole number of at least 0/,
    );
    expect(() => parseArgs(['--project'], '/work')).toThrow(/--project needs a value/);
    expect(() => parseArgs(['--grep', '--runs', '3'], '/work')).toThrow(/--grep needs a value/);
    expect(() => parseArgs(['--bogus'], '/work')).toThrow(
      /unknown option --bogus\n\nUsage: tsx tools\/flake-collect.ts/,
    );
  });
});
