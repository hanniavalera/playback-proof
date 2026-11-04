import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorSignature } from '../../../src/lab/signature.ts';
import {
  buildRun,
  ciRunId,
  generatedRunId,
  gitCommit,
  idOf,
  newInvocationId,
  outcomeOf,
  recordOf,
  renderRunFile,
  runFilePath,
  separateSharedIds,
  writeRunFile,
} from '../../../flake/reporter.ts';
import type { AttemptObservation, TestObservation } from '../../../flake/reporter.ts';
import { addDays, utcDay } from '../../../flake/quarantine.ts';
import { parseRun } from '../../../flake/run.ts';
import type { AttemptStatus, FlakeRun, Outcome, TestRecord } from '../../../flake/run.ts';
import { planGate } from '../../../tools/gate-merge.ts';
import { makeScratch } from '../support/scratch.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function attempt(status: AttemptStatus, message?: string, durationMs = 100): AttemptObservation {
  return { status, durationMs, errors: message === undefined ? [] : [{ message }] };
}

function observation(overrides: Partial<TestObservation> = {}): TestObservation {
  return {
    title: 'PB-VOD-001 starts',
    describes: [],
    file: 'tests/e2e/vod-start.spec.ts',
    project: 'chromium',
    tags: ['@merge', '@dash'],
    annotations: [],
    expectedStatus: 'passed',
    retries: 1,
    attempts: [attempt('passed')],
    ...overrides,
  };
}

const never = () => false;

describe('PB-LAB-004 reporter: what a test came to, from its attempts', () => {
  const cases: Array<[string, AttemptStatus[], AttemptStatus, Outcome]> = [
    ['passes the first time', ['passed'], 'passed', 'passed'],
    ['fails, then passes on the retry', ['failed', 'passed'], 'passed', 'flaky'],
    ['times out, then passes on the retry', ['timedOut', 'passed'], 'passed', 'flaky'],
    ['fails twice', ['failed', 'failed'], 'passed', 'failed'],
    ['fails once and has no retry', ['failed'], 'passed', 'failed'],
    ['times out twice', ['timedOut', 'timedOut'], 'passed', 'timedOut'],
    ['fails, then times out', ['failed', 'timedOut'], 'passed', 'timedOut'],
    ['times out, then fails', ['timedOut', 'failed'], 'passed', 'failed'],
    ['is skipped', ['skipped'], 'passed', 'skipped'],
    ['is skipped on the declaration', ['skipped'], 'skipped', 'skipped'],
    ['fails as test.fail() expects', ['failed'], 'failed', 'passed'],
    ['passes although test.fail() expects a failure', ['passed'], 'failed', 'failed'],
    ['is stopped before it ends', ['interrupted'], 'passed', 'interrupted'],
    ['fails, and the run is stopped before the retry', ['failed', 'interrupted'], 'passed', 'interrupted'],
    ['fails, passes on the retry, and nothing else', ['failed', 'passed'], 'passed', 'flaky'],
  ];
  it.each(cases)('a test that %s is %s', (_name, statuses, expected, outcome) => {
    expect(outcomeOf(statuses, expected)).toBe(outcome);
  });
});

describe('PB-LAB-004 reporter: the record of a test', () => {
  it('takes the catalog id from the start of the title, and the title with its describes when there is none', () => {
    expect(idOf('PB-VOD-001 starts', [])).toBe('PB-VOD-001');
    expect(idOf('PB-ENV-001', ['group'])).toBe('PB-ENV-001');
    expect(idOf('has no id', [])).toBe('has no id');
    expect(idOf('has no id', ['a', 'b'])).toBe('a › b › has no id');
    // An id inside the title is a mention; an id that is longer than three digits or has a suffix is not an id.
    expect(idOf('see PB-VOD-001', [])).toBe('see PB-VOD-001');
    expect(idOf('PB-VOD-0011 starts', [])).toBe('PB-VOD-0011 starts');
    expect(idOf('PB-VOD-001-b starts', [])).toBe('PB-VOD-001-b starts');
    expect(idOf('pb-vod-001 starts', [])).toBe('pb-vod-001 starts');
  });

  it('records a pass: id, engine, tags (sorted), tier, retries and one attempt without a signature', () => {
    const record = recordOf(observation({ tags: ['@dash', '@merge', '@cpu', '@merge'] }), never);
    expect(record).toEqual({
      id: 'PB-VOD-001',
      title: 'PB-VOD-001 starts',
      file: 'tests/e2e/vod-start.spec.ts',
      project: 'chromium',
      tags: ['@cpu', '@dash', '@merge'],
      tier: 'merge',
      outcome: 'passed',
      quarantined: false,
      retries: 1,
      attempts: [{ status: 'passed', durationMs: 100 }],
    });
  });

  it('records every attempt of a flaky test, with the signature of the failed one and not of the pass', () => {
    const record = recordOf(
      observation({
        attempts: [
          attempt(
            'failed',
            'Error: waited 15000 ms for a request of session 1a2b3c4d5e6f\n\nTimeline...',
            4100.4,
          ),
          attempt('passed', undefined, 1200.6),
        ],
      }),
      never,
    );
    expect(record?.outcome).toBe('flaky');
    expect(record?.attempts).toEqual([
      { status: 'failed', durationMs: 4100, signature: 'Error: waited <n> ms for a request of session <id>' },
      { status: 'passed', durationMs: 1201 },
    ]);
  });

  it('records a timeout, a test with no retry, and a test.fail() that fails as it should (no signature: nothing went wrong)', () => {
    const timedOut = recordOf(
      observation({
        retries: 0,
        attempts: [attempt('timedOut', 'Test timeout of 45000ms exceeded.', 45000)],
      }),
      never,
    );
    expect(timedOut).toMatchObject({ outcome: 'timedOut', retries: 0 });
    expect(timedOut?.attempts[0]?.signature).toBe('Test timeout of <n>ms exceeded.');

    const expectedFailure = recordOf(
      observation({ expectedStatus: 'failed', attempts: [attempt('failed', 'Error: expected failure')] }),
      never,
    );
    expect(expectedFailure?.outcome).toBe('passed');
    expect(expectedFailure?.attempts[0]).toEqual({ status: 'failed', durationMs: 100 });
  });

  it('names an attempt that failed without a message, and keeps the signature of the first error only', () => {
    const two = recordOf(
      observation({
        attempts: [
          { status: 'failed', durationMs: 5, errors: [{ message: 'first 1' }, { message: 'second 2' }] },
        ],
      }),
      never,
    );
    expect(two?.attempts[0]?.signature).toBe('first <n>');
    const none = recordOf(
      observation({ attempts: [{ status: 'failed', durationMs: 5, errors: [] }] }),
      never,
    );
    expect(none?.attempts[0]).toEqual({ status: 'failed', durationMs: 5 });
  });

  it('records the reason a test was skipped with, and says nothing about one that was skipped without', () => {
    const reason = 'documented gap in docker-linux-arm64: webkit plays nothing (see docs/CODEC_MATRIX.md)';
    const withReason = recordOf(
      observation({
        attempts: [attempt('skipped')],
        annotations: [{ type: 'skip', description: reason }],
      }),
      never,
    );
    expect(withReason).toMatchObject({ outcome: 'skipped', skipReason: reason });
    const silent = recordOf(
      observation({ attempts: [attempt('skipped')], annotations: [{ type: 'skip' }] }),
      never,
    );
    expect(silent?.outcome).toBe('skipped');
    expect(silent).not.toHaveProperty('skipReason');
    // A reason belongs to a skipped test only.
    expect(
      recordOf(observation({ annotations: [{ type: 'skip', description: 'x' }] }), never),
    ).not.toHaveProperty('skipReason');
    const fixme = recordOf(
      observation({
        attempts: [attempt('skipped')],
        annotations: [{ type: 'fixme', description: ' broken, see #4 ' }],
      }),
      never,
    );
    expect(fixme?.skipReason).toBe('broken, see #4');
  });

  it('flags an experimental engine and a quarantined test, and asks the list about this id and this engine', () => {
    const asked: string[] = [];
    const record = recordOf(
      observation({
        annotations: [{ type: 'experimental-engine', description: 'Linux WebKit runs the specs...' }],
      }),
      (id, project) => {
        asked.push(`${id}/${project}`);
        return true;
      },
    );
    expect(record).toMatchObject({ experimental: true, quarantined: true });
    expect(asked).toEqual(['PB-VOD-001/chromium']);
    expect(recordOf(observation(), never)).not.toHaveProperty('experimental');
  });

  it('gives the tier of the tags: @merge wins over @release, and a test with neither has none', () => {
    expect(recordOf(observation({ tags: ['@release'] }), never)?.tier).toBe('release');
    expect(recordOf(observation({ tags: ['@release', '@merge'] }), never)?.tier).toBe('merge');
    expect(recordOf(observation({ tags: [] }), never)?.tier).toBeNull();
  });

  it('drops a test that never started, and keeps a describe-wrapped title whole', () => {
    expect(recordOf(observation({ attempts: [] }), never)).toBeNull();
    const grouped = recordOf(observation({ title: 'works', describes: ['seeking', 'forward'] }), never);
    expect(grouped).toMatchObject({ id: 'seeking › forward › works', title: 'seeking › forward › works' });
  });

  it('tells two tests of one engine with the same title apart by their file', () => {
    const a = recordOf(observation({ title: 'same', file: 'a.spec.ts' }), never) as TestRecord;
    const b = recordOf(observation({ title: 'same', file: 'b.spec.ts' }), never) as TestRecord;
    const other = recordOf(
      observation({ title: 'same', file: 'a.spec.ts', project: 'firefox' }),
      never,
    ) as TestRecord;
    expect(separateSharedIds([a, b, other]).map((r) => r.id)).toEqual([
      'same [a.spec.ts]',
      'same [b.spec.ts]',
      'same',
    ]);
  });
});

describe('PB-LAB-004 reporter: the record of a run', () => {
  const context = {
    runId: 'gha-1-1',
    invocationId: 'abc123',
    date: '2026-11-03T22:19:10.045Z',
    commit: 'a'.repeat(40),
    envId: 'gha-linux-x64',
    playwrightVersion: '1.64.1',
  };

  it('builds a run that reads back, with the shard when there is one', () => {
    const observations = [
      observation(),
      observation({
        title: 'PB-VOD-002 hls',
        attempts: [attempt('failed', 'Error: boom 1'), attempt('passed')],
      }),
      observation({ title: 'PB-VOD-003 never started', attempts: [] }),
    ];
    const run = buildRun(
      { ...context, shard: { current: 2, total: 3 } },
      observations,
      { status: 'passed', durationMs: 12345.6 },
      never,
    );
    expect(run).toMatchObject({
      schemaVersion: 1,
      runId: 'gha-1-1',
      invocationId: 'abc123',
      status: 'passed',
      durationMs: 12346,
      shard: { current: 2, total: 3 },
    });
    expect(run.tests.map((t) => `${t.id}:${t.outcome}`)).toEqual(['PB-VOD-001:passed', 'PB-VOD-002:flaky']);
    expect(parseRun(JSON.parse(renderRunFile(run)))).toEqual(run);
    expect(
      buildRun({ ...context, shard: null }, [], { status: 'passed', durationMs: 0 }, never),
    ).not.toHaveProperty('shard');
  });

  it('works with retries 0 and with retries 1', () => {
    const noRetry = buildRun(
      context,
      [observation({ retries: 0, attempts: [attempt('failed', 'Error: x')] })],
      { status: 'failed', durationMs: 5 },
      never,
    );
    expect(noRetry.tests[0]).toMatchObject({ outcome: 'failed', retries: 0 });
    const oneRetry = buildRun(
      context,
      [observation({ retries: 1, attempts: [attempt('failed', 'Error: x'), attempt('passed')] })],
      { status: 'passed', durationMs: 5 },
      never,
    );
    expect(oneRetry.tests[0]).toMatchObject({ outcome: 'flaky', retries: 1 });
  });
});

describe('PB-LAB-004 reporter: where a run comes from', () => {
  it('uses the CI run id when there is one, and says which attempt of a re-run it is', () => {
    expect(ciRunId({ PB_RUN_ID: 'mine', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '9' })).toBe('mine');
    expect(ciRunId({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2' })).toBe(
      'gha-123456-2',
    );
    expect(ciRunId({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123456' })).toBe('gha-123456-1');
    expect(ciRunId({ BUILD_TAG: 'jenkins-flake-7' })).toBe('jenkins-flake-7');
    expect(ciRunId({ JENKINS_URL: 'http://j', JOB_NAME: 'playback/main', BUILD_NUMBER: '12' })).toBe(
      'jenkins-playback-main-12',
    );
    expect(ciRunId({})).toBeNull();
    // Not on GitHub Actions: a stray GITHUB_RUN_ID does not make a CI run.
    expect(ciRunId({ GITHUB_RUN_ID: '1' })).toBeNull();
  });

  it('generates an id for a local run: when it started and a few random digits', () => {
    const now = new Date('2026-11-03T22:19:10.045Z');
    expect(generatedRunId(now, 'a1b2c3')).toBe('local-20261103T221910Z-a1b2c3');
    expect(generatedRunId()).toMatch(/^local-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(newInvocationId()).toMatch(/^[0-9a-f]{12}$/);
    expect(newInvocationId()).not.toBe(newInvocationId());
  });

  it('takes the commit from the CI environment, else from git, else says it is unknown', () => {
    expect(gitCommit(ROOT, { GITHUB_SHA: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' })).toBe(
      'abcdef0123456789abcdef0123456789abcdef01',
    );
    expect(gitCommit(ROOT, { GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567' })).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(gitCommit(ROOT, {})).toMatch(/^[0-9a-f]{40}$/);
    // Not a checkout: the run is recorded all the same.
    expect(gitCommit('/', {})).toBe('unknown');
  });

  it('writes to the config directory by default, to the environment`s file when it says so', () => {
    expect(runFilePath('/repo', undefined, {}, '/elsewhere')).toBe('/repo/reports/flake/run.json');
    expect(runFilePath('/repo', 'out/run.json', {}, '/elsewhere')).toBe('/repo/out/run.json');
    expect(
      runFilePath('/repo', 'out/run.json', { PB_FLAKE_RUN_FILE: 'reports/flake/q.json' }, '/elsewhere'),
    ).toBe('/elsewhere/reports/flake/q.json');
  });

  it('writes the file whole: indented, in a directory it creates, with nothing left beside it', () => {
    const scratch = makeScratch('flake-write-');
    try {
      const run = buildRun(
        {
          runId: 'r',
          invocationId: 'i',
          date: '2026-11-03T22:19:10.045Z',
          commit: 'b'.repeat(40),
          envId: 'e',
          playwrightVersion: '1.64.1',
        },
        [observation()],
        { status: 'passed', durationMs: 1 },
        never,
      );
      const file = join(scratch, 'deep', 'er', 'run.json');
      writeRunFile(file, run);
      expect(readFileSync(file, 'utf8')).toBe(renderRunFile(run));
      expect(readFileSync(file, 'utf8')).toContain('\n  "tests": [');
      expect(readdirSync(join(scratch, 'deep', 'er'))).toEqual(['run.json']);
      writeRunFile(file, { ...run, status: 'failed' });
      expect((JSON.parse(readFileSync(file, 'utf8')) as FlakeRun).status).toBe('failed');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real runner, once: a scratch project with the kinds of tests the reporter has to tell apart, run through Playwright itself
// (no browser: none of these tests asks for a page). The same run proves two more things: the reporter agrees with Playwright's own
// `test.outcome()`, and the `--grep-invert` that `gate:merge` builds excludes exactly the quarantined test of its engine.

const REPORTER = join(ROOT, 'flake/reporter.ts');
const SPEC = `
import { expect, test } from '@playwright/test';

test('PB-FIX-001 passes', { tag: '@merge' }, async () => {});

test('PB-FIX-002 fails on the first attempt and passes on the retry', { tag: ['@merge', '@dash'] }, async ({}, testInfo) => {
  if (testInfo.retry === 0) throw new Error(\`the first attempt always fails (worker \${testInfo.workerIndex}, ts \${Date.now()})\`);
});

test('PB-FIX-003 fails on every attempt', { tag: '@merge' }, async () => {
  throw new Error('always red: 404 for http://127.0.0.1:4731/s/1a2b3c4d5e6f/seg-17.m4s\\nsecond line');
});

test('PB-FIX-004 is skipped by a documented gap', { tag: '@merge' }, async () => {
  test.skip(true, 'documented gap in the fixture: nothing plays here');
});

test('PB-FIX-005 runs into its timeout', { tag: '@merge' }, async () => {
  test.setTimeout(300);
  await new Promise(() => {});
});

test.describe('a group', () => {
  test('has no catalog id', { tag: '@merge' }, async () => {});
});

test('PB-FIX-006 is expected to fail', { tag: '@merge' }, async () => {
  test.fail();
  throw new Error('expected failure');
});

test('PB-FIX-007 is quarantined', { tag: '@merge' }, async () => {});

test('PB-FIX-008 is release-tier', { tag: '@release' }, async () => {});

test('PB-FIX-010 mentions PB-FIX-007 in its title', { tag: '@merge' }, async () => {
  expect(1).toBe(1);
});
`;

const OUTCOMES_REPORTER = `
import { writeFileSync } from 'node:fs';
export default class {
  printsToStdio() { return false; }
  onBegin(_config, suite) { this.suite = suite; }
  onEnd() {
    const out = this.suite.allTests().map((t) => {
      const describes = [];
      for (let s = t.parent; s; s = s.parent) if (s.type === 'describe') describes.unshift(s.title);
      return { project: t.parent.project().name, title: [...describes, t.title].join(' › '), outcome: t.outcome() };
    });
    writeFileSync('outcomes.json', JSON.stringify(out));
  }
}
`;

function entry(id: string, project?: string) {
  return {
    id,
    ...(project ? { project } : {}),
    reason: 'failed and passed on the same commit',
    owner: '@fixture-owner',
    since: addDays(utcDay(), -1),
    expires: addDays(utcDay(), 3),
    evidence: 'fixture',
  };
}

describe('PB-LAB-004 reporter: one run through the real Playwright runner', () => {
  let scratch = '';
  let run: FlakeRun;
  let exitStatus: number | null = null;
  let planned: ReturnType<typeof planGate>;
  let stdout = '';
  let outcomes: Array<{ project: string; title: string; outcome: string }> = [];

  beforeAll(() => {
    scratch = makeScratch('flake-reporter-');
    mkdirSync(join(scratch, 'e2e'), { recursive: true });
    writeFileSync(join(scratch, 'e2e/fixture.spec.ts'), SPEC);
    writeFileSync(join(scratch, 'outcomes-reporter.mjs'), OUTCOMES_REPORTER);
    // Two engines, one worker, one retry. The reporter is the real one, loaded from the repository.
    writeFileSync(
      join(scratch, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts'],
  retries: 1,
  workers: 1,
  timeout: 20000,
  reporter: [['${REPORTER}', { quarantineFile: 'quarantine.json' }], ['./outcomes-reporter.mjs']],
  projects: [{ name: 'alpha' }, { name: 'beta' }],
});
`,
    );
    // The list the reporter reads names the test for both engines; the plan the wrapper builds is made from the alpha entry alone,
    // so that beta's copy runs and is flagged, and alpha's is excluded by the grep.
    writeFileSync(
      join(scratch, 'quarantine.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [entry('PB-FIX-007', 'alpha'), entry('PB-FIX-007', 'beta')],
      }),
    );
    planned = planGate([{ id: 'PB-FIX-007', project: 'alpha' }], [], 'fixture-run');

    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    const env: NodeJS.ProcessEnv = { ...process.env, ...planned.blocking.env, PB_ENV_ID: 'fixture-env' };
    for (const name of [
      'CI',
      'GITHUB_ACTIONS',
      'GITHUB_SHA',
      'PB_FLAKE_RUN_FILE',
      'PB_FLAKE_QUARANTINE',
      'GIT_COMMIT',
      'BUILD_TAG',
      'JENKINS_URL',
    ]) {
      delete env[name];
    }
    const result = spawnSync(process.execPath, [cli, ...planned.blocking.args], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 90_000,
    });
    exitStatus = result.status;
    stdout = `${result.stdout}\n${result.stderr}`;
    const file = join(scratch, 'reports/flake/run.json');
    if (existsSync(file)) {
      run = parseRun(JSON.parse(readFileSync(file, 'utf8')), file);
      // Kept (in the git-ignored cache) so that the real shape can be looked at after the run.
      const kept = join(ROOT, '.cache/flake-reporter-fixture');
      mkdirSync(kept, { recursive: true });
      copyFileSync(file, join(kept, 'run.json'));
    }
    if (existsSync(join(scratch, 'outcomes.json')))
      outcomes = JSON.parse(readFileSync(join(scratch, 'outcomes.json'), 'utf8'));
  }, 120_000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const record = (project: string, id: string): TestRecord | undefined =>
    run.tests.find((t) => t.project === project && t.id === id);

  it('ran, with failures in it, and wrote the run file whole', () => {
    expect(run, stdout).toBeDefined();
    expect(exitStatus).toBe(1);
    const version = (createRequire(import.meta.url)('@playwright/test/package.json') as { version: string })
      .version;
    expect(run).toMatchObject({
      schemaVersion: 1,
      runId: 'fixture-run',
      envId: 'fixture-env',
      playwrightVersion: version,
      status: 'failed',
    });
    expect(run.invocationId).toMatch(/^[0-9a-f]{12}$/);
    expect(run.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(run.date).toISOString()).toBe(run.date);
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run).not.toHaveProperty('shard');
    expect(readdirSync(join(scratch, 'reports/flake'))).toEqual(['run.json']);
  });

  it('records a pass, a flake, a failure, a skip with its reason and a timeout, in each engine', () => {
    for (const project of ['alpha', 'beta']) {
      expect(record(project, 'PB-FIX-001')).toMatchObject({
        outcome: 'passed',
        tier: 'merge',
        tags: ['@merge'],
        retries: 1,
        quarantined: false,
      });
      expect(record(project, 'PB-FIX-001')?.attempts).toHaveLength(1);

      const flaky = record(project, 'PB-FIX-002');
      expect(flaky).toMatchObject({ outcome: 'flaky', tags: ['@dash', '@merge'] });
      expect(flaky?.attempts.map((a) => a.status)).toEqual(['failed', 'passed']);
      expect(flaky?.attempts[0]?.signature).toBe(
        'Error: the first attempt always fails (worker <n>, ts <n>)',
      );
      expect(flaky?.attempts[1]).not.toHaveProperty('signature');

      const failed = record(project, 'PB-FIX-003');
      expect(failed?.outcome).toBe('failed');
      expect(failed?.attempts.map((a) => a.status)).toEqual(['failed', 'failed']);
      const expectedSignature = errorSignature(
        'Error: always red: 404 for http://127.0.0.1:4731/s/1a2b3c4d5e6f/seg-17.m4s',
      );
      expect(failed?.attempts.map((a) => a.signature)).toEqual([expectedSignature, expectedSignature]);
      expect(expectedSignature).toBe('Error: always red: <n> for <url>');

      expect(record(project, 'PB-FIX-004')).toMatchObject({
        outcome: 'skipped',
        skipReason: 'documented gap in the fixture: nothing plays here',
      });

      const timedOut = record(project, 'PB-FIX-005');
      expect(timedOut?.outcome).toBe('timedOut');
      expect(timedOut?.attempts.map((a) => a.status)).toEqual(['timedOut', 'timedOut']);
      expect(timedOut?.attempts[0]?.signature).toBe('Test timeout of <n>ms exceeded.');
      expect(timedOut?.attempts[0]?.durationMs).toBeGreaterThanOrEqual(250);
    }
  });

  it('gives a test without an id its title with its describe, and an expected failure counts as a pass', () => {
    expect(record('alpha', 'a group › has no catalog id')).toMatchObject({
      outcome: 'passed',
      title: 'a group › has no catalog id',
    });
    const expectedFail = record('beta', 'PB-FIX-006');
    expect(expectedFail?.outcome).toBe('passed');
    expect(expectedFail?.attempts).toEqual([{ status: 'failed', durationMs: expect.any(Number) }]);
  });

  it('agrees with Playwright`s own outcome for every test', () => {
    expect(outcomes.length).toBe(run.tests.length);
    const mapped: Record<string, string[]> = {
      expected: ['passed'],
      flaky: ['flaky'],
      skipped: ['skipped'],
      unexpected: ['failed', 'timedOut'],
    };
    for (const test of run.tests) {
      const own = outcomes.find((o) => o.project === test.project && o.title === test.title);
      expect(own, `${test.project} ${test.id}`).toBeDefined();
      expect(
        mapped[own?.outcome ?? ''],
        `${test.project} ${test.id}: Playwright says ${own?.outcome}`,
      ).toContain(test.outcome);
    }
  });

  it('left out the release-tier test (--grep @merge) and the quarantined test of alpha (--grep-invert), and nothing else', () => {
    expect(planned.blocking.args.slice(0, 3)).toEqual(['test', '--grep', '@merge']);
    expect(planned.blocking.args).toContain('--grep-invert');
    expect(run.tests.some((t) => t.id === 'PB-FIX-008')).toBe(false);
    expect(record('alpha', 'PB-FIX-007')).toBeUndefined();
    // Beta's copy runs, and the reporter, reading the list, says it is quarantined there.
    expect(record('beta', 'PB-FIX-007')).toMatchObject({ outcome: 'passed', quarantined: true });
    // A test that only mentions the id in its title is not the test.
    expect(record('alpha', 'PB-FIX-010')).toMatchObject({ outcome: 'passed', quarantined: false });
    expect(record('beta', 'PB-FIX-010')).toBeDefined();
    expect(run.tests).toHaveLength(2 * 9 - 1);
  });
});
