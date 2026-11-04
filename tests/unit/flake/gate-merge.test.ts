import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, utcDay } from '../../../flake/quarantine.ts';
import {
  parseArgs,
  patternFor,
  planGate,
  quarantineSelector,
  QUARANTINED_RUN_FILE,
  runGateMerge,
} from '../../../tools/gate-merge.ts';
import type { GatePlan, Invocation } from '../../../tools/gate-merge.ts';
import { makeScratch } from '../support/scratch.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The string Playwright 1.64 matches `--grep` and `--grep-invert` against (`_grepTitleWithTags` in its sources): the titles of the root
 * (empty), the project, the file, the describe blocks and the test, then the tags, joined with a space. The pattern is compiled with
 * the flags `gi` (`forceRegExp`) and tested from the start. The real runner agrees: reporter.test.ts runs the invert pattern through it.
 */
function grepTitle(test: {
  project: string;
  file?: string;
  describes?: string[];
  title: string;
  tags?: string[];
}): string {
  return [
    '',
    test.project,
    test.file ?? 'e2e/vod-seek.spec.ts',
    ...(test.describes ?? []),
    test.title,
    ...(test.tags ?? ['@merge']),
  ].join(' ');
}

function matches(pattern: string, title: string): boolean {
  const re = new RegExp(pattern, 'gi');
  re.lastIndex = 0;
  return re.test(title);
}

const ENGINES = ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'];

describe('PB-LAB-004 gate:merge: the invocations', () => {
  it('is exactly `playwright test --grep @merge` when nothing is quarantined, whatever else is passed', () => {
    expect(planGate([], [], 'run-1')).toEqual({
      blocking: { label: 'merge gate', args: ['test', '--grep', '@merge'], env: { PB_RUN_ID: 'run-1' } },
      quarantined: null,
    });
    expect(planGate([], ['--project=chromium', '--workers=1'], 'run-1').blocking.args).toEqual([
      'test',
      '--grep',
      '@merge',
      '--project=chromium',
      '--workers=1',
    ]);
  });

  it('excludes the quarantined tests from the blocking run and runs only them in a second, with files of its own', () => {
    const plan = planGate(
      [{ id: 'PB-VOD-007' }, { id: 'PB-VOD-006', project: 'webkit' }],
      ['--project=webkit'],
      'run-2',
    );
    const selector = quarantineSelector([
      { id: 'PB-VOD-007' },
      { id: 'PB-VOD-006', project: 'webkit' },
    ]) as string;

    expect(plan.blocking.args).toEqual([
      'test',
      '--grep',
      '@merge',
      '--grep-invert',
      `^${selector}`,
      '--project=webkit',
    ]);
    expect(plan.blocking.env).toEqual({ PB_RUN_ID: 'run-2' });

    const second = plan.quarantined as Invocation;
    expect(second.label).toBe('quarantined tests (non-blocking)');
    expect(second.args.slice(0, 2)).toEqual(['test', '--grep']);
    expect(second.args).toContain('--pass-with-no-tests');
    expect(second.args.slice(-1)).toEqual(['--project=webkit']);
    expect(second.args[second.args.indexOf('--output') + 1]).toBe('reports/quarantined/test-results');
    // Same build, but its own run file, report and output folder: it must not overwrite what the first one wrote.
    expect(second.env).toEqual({
      PB_RUN_ID: 'run-2',
      PB_FLAKE_RUN_FILE: QUARANTINED_RUN_FILE,
      PLAYWRIGHT_JSON_OUTPUT_FILE: 'reports/quarantined/playwright.json',
      PLAYWRIGHT_HTML_OUTPUT_DIR: 'reports/quarantined/html',
      PLAYWRIGHT_HTML_OPEN: 'never',
    });
  });

  it('writes the outputs of the second run under reports/, which every tool already ignores', () => {
    const second = planGate([{ id: 'PB-VOD-007' }], [], 'r').quarantined as Invocation;
    for (const path of [
      second.env.PB_FLAKE_RUN_FILE,
      second.env.PLAYWRIGHT_JSON_OUTPUT_FILE,
      second.env.PLAYWRIGHT_HTML_OUTPUT_DIR,
      second.args[second.args.indexOf('--output') + 1],
    ]) {
      expect(path, String(path)).toMatch(/^reports\//);
    }
  });

  it('lists one alternative per entry, once', () => {
    expect(quarantineSelector([])).toBeNull();
    expect(quarantineSelector([{ id: 'PB-VOD-007' }, { id: 'PB-VOD-007' }])).toBe(
      `(?:${patternFor({ id: 'PB-VOD-007' })})`,
    );
    const webkit = { id: 'PB-VOD-007', project: 'webkit' };
    const firefox = { id: 'PB-VOD-007', project: 'firefox' };
    expect(quarantineSelector([webkit, firefox, webkit])).toBe(
      `(?:${patternFor(webkit)}|${patternFor(firefox)})`,
    );
  });
});

describe('PB-LAB-004 gate:merge: which tests the pattern excludes (against the title Playwright builds)', () => {
  const invert = (entries: Parameters<typeof quarantineSelector>[0]): string =>
    `^${quarantineSelector(entries)}`;

  it('excludes the test of an entry without an engine in every engine, and no other test', () => {
    const pattern = invert([{ id: 'PB-VOD-007' }]);
    for (const project of ENGINES) {
      expect(
        matches(pattern, grepTitle({ project, title: 'PB-VOD-007 seek to an unbuffered position' })),
        project,
      ).toBe(true);
    }
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-006 seek forward' }))).toBe(
      false,
    );
    // Ids that merely start like it.
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-070 other' }))).toBe(false);
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-0071 other' }))).toBe(false);
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-ABR-007 other area' }))).toBe(false);
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-007-b other' }))).toBe(false);
    // The id alone as the whole title.
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-007' }))).toBe(true);
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-007', tags: [] }))).toBe(true);
  });

  it('excludes an entry with an engine in that engine only, and not in an engine whose name begins with it', () => {
    const pattern = invert([{ id: 'PB-VOD-007', project: 'chromium' }]);
    expect(matches(pattern, grepTitle({ project: 'chromium', title: 'PB-VOD-007 seek' }))).toBe(true);
    expect(matches(pattern, grepTitle({ project: 'chromium-cpu4x', title: 'PB-VOD-007 seek' }))).toBe(false);
    expect(matches(pattern, grepTitle({ project: 'firefox', title: 'PB-VOD-007 seek' }))).toBe(false);
    expect(matches(pattern, grepTitle({ project: 'webkit', title: 'PB-VOD-007 seek' }))).toBe(false);
    const cpu = invert([{ id: 'PB-VOD-007', project: 'chromium-cpu4x' }]);
    expect(matches(cpu, grepTitle({ project: 'chromium-cpu4x', title: 'PB-VOD-007 seek' }))).toBe(true);
    expect(matches(cpu, grepTitle({ project: 'chromium', title: 'PB-VOD-007 seek' }))).toBe(false);
  });

  it('does not exclude a test that only mentions the id, or that has other words before it: a test must never leave the gate by accident', () => {
    for (const entries of [[{ id: 'PB-VOD-007' }], [{ id: 'PB-VOD-007', project: 'chromium' }]]) {
      const pattern = invert(entries);
      expect(
        matches(
          pattern,
          grepTitle({
            project: 'chromium',
            title: 'PB-VOD-009 rapid seeks (see PB-VOD-007 for the single seek)',
          }),
        ),
        'mention',
      ).toBe(false);
      expect(
        matches(pattern, grepTitle({ project: 'chromium', title: 'see PB-VOD-007 first' })),
        'not at the start',
      ).toBe(false);
      expect(
        matches(
          pattern,
          grepTitle({ project: 'chromium', file: 'e2e/PB-VOD-007.spec.ts', title: 'unrelated title' }),
        ),
        'in the file name',
      ).toBe(false);
      // Inside a describe block the id does not follow the file: the test keeps blocking (the safe direction).
      expect(
        matches(
          pattern,
          grepTitle({ project: 'chromium', describes: ['seeking'], title: 'PB-VOD-007 seek' }),
        ),
        'describe',
      ).toBe(false);
    }
  });

  it('escapes the name of an engine and reads the id literally', () => {
    const odd = invert([{ id: 'PB-VOD-007', project: 'chromium.x' }]);
    expect(matches(odd, grepTitle({ project: 'chromium.x', title: 'PB-VOD-007 a' }))).toBe(true);
    expect(matches(odd, grepTitle({ project: 'chromiumXx', title: 'PB-VOD-007 a' }))).toBe(false);
  });

  it('is exact over every id of the catalog and every engine: it excludes what the entries name, and nothing else', () => {
    const ids = [
      ...readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8').matchAll(/^\| (PB-[A-Z]+-\d{3}) \|/gm),
    ].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThan(50);
    const entries = [
      { id: 'PB-VOD-007' },
      { id: 'PB-LIVE-003', project: 'firefox' },
      { id: 'PB-REC-008', project: 'chromium-cpu4x' },
    ];
    const pattern = invert(entries);
    const named = (id: string, project: string): boolean =>
      entries.some((e) => e.id === id && (e.project === undefined || e.project === project));
    let excluded = 0;
    for (const id of ids) {
      for (const project of ENGINES) {
        const hit = matches(
          pattern,
          grepTitle({ project, title: `${id} the scenario of ${id}`, tags: ['@merge', '@dash'] }),
        );
        expect(hit, `${id} on ${project}`).toBe(named(id, project));
        if (hit) excluded += 1;
      }
    }
    expect(excluded).toBe(ENGINES.length + 1 + 1);
  });

  it('selects, for the non-blocking run, the quarantined tests of the merge tier and no others', () => {
    const plan = planGate([{ id: 'PB-VOD-007' }, { id: 'PB-LIVE-003', project: 'firefox' }], [], 'r');
    const grep = (plan.quarantined as Invocation).args[2] as string;
    const selected = (test: Parameters<typeof grepTitle>[0]): boolean => matches(grep, grepTitle(test));

    expect(selected({ project: 'webkit', title: 'PB-VOD-007 seek' })).toBe(true);
    expect(selected({ project: 'firefox', title: 'PB-LIVE-003 refresh', tags: ['@merge', '@live'] })).toBe(
      true,
    );
    // Tags may come from the describe blocks and sit before the title.
    expect(selected({ project: 'webkit', title: 'PB-VOD-007 seek', tags: ['@dash', '@merge', '@cpu'] })).toBe(
      true,
    );
    // A quarantined release-tier test is not part of the merge job's second run.
    expect(selected({ project: 'webkit', title: 'PB-VOD-007 seek', tags: ['@release'] })).toBe(false);
    expect(selected({ project: 'webkit', title: 'PB-VOD-007 seek', tags: ['@mergeable'] })).toBe(false);
    // Neither is a merge test that is not quarantined, nor a quarantined test in another engine.
    expect(selected({ project: 'webkit', title: 'PB-VOD-006 seek' })).toBe(false);
    expect(selected({ project: 'webkit', title: 'PB-LIVE-003 refresh' })).toBe(false);
    expect(selected({ project: 'chromium', title: 'PB-LIVE-003 refresh' })).toBe(false);
  });

  it('keeps every test of the merge tier in exactly one of the two runs', () => {
    const entries = [{ id: 'PB-VOD-007' }, { id: 'PB-REC-001', project: 'webkit' }];
    const plan = planGate(entries, [], 'r');
    const invertPattern = plan.blocking.args[plan.blocking.args.indexOf('--grep-invert') + 1] as string;
    const secondGrep = (plan.quarantined as Invocation).args[2] as string;
    const ids = ['PB-VOD-006', 'PB-VOD-007', 'PB-REC-001', 'PB-REC-002'];
    for (const id of ids) {
      for (const project of ENGINES) {
        const title = grepTitle({ project, title: `${id} a test` });
        const inBlocking = !matches(invertPattern, title);
        const inSecond = matches(secondGrep, title);
        expect(Number(inBlocking) + Number(inSecond), `${id} on ${project}`).toBe(1);
      }
    }
  });
});

describe('PB-LAB-004 gate:merge: the arguments and the run', () => {
  const scratches: string[] = [];
  afterEach(() => {
    while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
  });

  const listFile = (entries: unknown[]): string => {
    const dir = makeScratch('gate-merge-');
    scratches.push(dir);
    const file = join(dir, 'quarantine.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries }));
    return file;
  };
  const valid = (overrides: Record<string, unknown> = {}) => ({
    id: 'PB-VOD-007',
    reason: 'failed and passed on the same commit',
    owner: '@owner',
    since: addDays(utcDay(), -1),
    expires: addDays(utcDay(), 3),
    evidence: 'run 12',
    ...overrides,
  });
  const options = (file: string, extraArgs: string[] = ['--project=chromium']) => ({
    extraArgs,
    quarantineFile: file,
    strategyFile: join(ROOT, 'TEST_STRATEGY.md'),
    today: utcDay(),
    dryRun: false,
  });
  const recorder = (codes: Array<number | null>) => {
    const calls: Invocation[] = [];
    return {
      calls,
      run: (invocation: Invocation): Promise<number | null> => {
        calls.push(invocation);
        return Promise.resolve(calls.length <= codes.length ? (codes[calls.length - 1] as number | null) : 0);
      },
    };
  };

  it('takes its own options out of the arguments and passes the rest to Playwright, in order', () => {
    const parsed = parseArgs(
      [
        '--project=webkit',
        '--flake-today=2026-11-03',
        '--workers',
        '1',
        '--flake-quarantine=/x/q.json',
        '--flake-dry-run',
        '--flake-strategy=/x/S.md',
      ],
      '/repo',
    );
    expect(parsed).toEqual({
      extraArgs: ['--project=webkit', '--workers', '1'],
      quarantineFile: '/x/q.json',
      strategyFile: '/x/S.md',
      today: '2026-11-03',
      dryRun: true,
    });
    const defaults = parseArgs([], '/repo', new Date('2026-11-03T23:59:00Z'));
    expect(defaults).toEqual({
      extraArgs: [],
      quarantineFile: '/repo/flake/quarantine.json',
      strategyFile: '/repo/TEST_STRATEGY.md',
      today: '2026-11-03',
      dryRun: false,
    });
  });

  it('runs once, exactly like `playwright test --grep @merge`, with an empty list, and exits with its code', async () => {
    const fake = recorder([1]);
    const lines: string[] = [];
    const result = await runGateMerge(options(listFile([])), fake.run, (l) => lines.push(l), 'run-9');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(['test', '--grep', '@merge', '--project=chromium']);
    expect(result).toMatchObject({ exitCode: 1, quarantinedExitCode: null, warnings: [] });
    expect(lines).toEqual(['nothing is quarantined: the merge gate runs every @merge test']);
  });

  it('runs the quarantined tests second, and never lets them change the exit code: a failing second run with a green first is green', async () => {
    const fake = recorder([0, 1]);
    const lines: string[] = [];
    const result = await runGateMerge(options(listFile([valid()])), fake.run, (l) => lines.push(l), 'run-9');
    expect(fake.calls.map((c) => c.label)).toEqual(['merge gate', 'quarantined tests (non-blocking)']);
    expect(result.exitCode).toBe(0);
    expect(result.quarantinedExitCode).toBe(1);
    expect(fake.calls.every((c) => c.env.PB_RUN_ID === 'run-9')).toBe(true);
    expect(lines.join('\n')).toContain(
      `quarantined (non-blocking, still running): PB-VOD-007 until ${addDays(utcDay(), 3)} (@owner)`,
    );
    expect(lines.at(-1)).toContain(
      'playwright exited with 1; it does not change the result of the gate (exit 0)',
    );
  });

  it('exits with the first run`s code when it fails, and still runs the quarantined tests', async () => {
    const fake = recorder([1, 0]);
    const result = await runGateMerge(options(listFile([valid()])), fake.run, () => {}, 'run-9');
    expect(result.exitCode).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  it('stops when the first run was killed: there is no result to report, and a second run nobody asked for', async () => {
    const fake = recorder([null, 0]);
    const result = await runGateMerge(options(listFile([valid()])), fake.run, () => {}, 'run-9');
    expect(result.exitCode).toBe(130);
    expect(fake.calls).toHaveLength(1);
  });

  it('does not exclude a test whose entry has expired or is not valid, and says so: the safe direction', async () => {
    const expired = valid({ since: addDays(utcDay(), -9), expires: addDays(utcDay(), -2) });
    const tooLong = valid({ id: 'PB-VOD-006', since: addDays(utcDay(), -1), expires: addDays(utcDay(), 40) });
    const fake = recorder([0]);
    const lines: string[] = [];
    const result = await runGateMerge(
      options(listFile([expired, tooLong])),
      fake.run,
      (l) => lines.push(l),
      'r',
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(['test', '--grep', '@merge', '--project=chromium']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('PB-VOD-006: expires');
    expect(result.warnings[0]).toContain('an entry with a problem quarantines nothing');
  });

  it('runs every @merge test, with a warning, when the list or the catalog cannot be read', async () => {
    const fake = recorder([0]);
    const lines: string[] = [];
    const broken = { ...options(listFile([valid()])), strategyFile: join(ROOT, 'does-not-exist.md') };
    const result = await runGateMerge(broken, fake.run, (l) => lines.push(l), 'r');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(['test', '--grep', '@merge', '--project=chromium']);
    expect(result.warnings[0]).toMatch(/^quarantine list not applied, every @merge test blocks: /);
  });

  it('prints the plan and runs nothing with --flake-dry-run', async () => {
    const fake = recorder([1, 1]);
    const lines: string[] = [];
    const result = await runGateMerge(
      { ...options(listFile([valid()])), dryRun: true },
      fake.run,
      (l) => lines.push(l),
      'r',
    );
    expect(fake.calls).toEqual([]);
    expect(result.exitCode).toBe(0);
    const plan: GatePlan = result.plan;
    expect(plan.quarantined).not.toBeNull();
    expect(
      lines.filter((l) => l.startsWith('merge gate: playwright "test" "--grep" "@merge" "--grep-invert"')),
    ).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('quarantined tests (non-blocking): playwright'))).toHaveLength(1);
  });
});
