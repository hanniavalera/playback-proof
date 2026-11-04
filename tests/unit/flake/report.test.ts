import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FLAKE_LIMITS } from '../../../src/shared/criteria.ts';
import { addDays, catalogFacts } from '../../../flake/quarantine.ts';
import type { QuarantineEntry } from '../../../flake/quarantine.ts';
import { renderRunFile } from '../../../flake/reporter.ts';
import { buildReport, cell, defaultReportIo, renderMarkdown, reportCommand } from '../../../flake/report.ts';
import type { ReportInput, ReportIo } from '../../../flake/report.ts';
import type { FlakeRun } from '../../../flake/run.ts';
import { FileStore } from '../../../flake/store.ts';
import { percent } from '../../../flake/stats.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { makeScratch } from '../support/scratch.ts';
import { builds, record, run } from './fixtures.ts';
import { INVALID_REASON, pattern } from './invalid-fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const facts = catalogFacts(parseCatalog(readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8')));
const TODAY = '2026-11-03';
const W = FLAKE_LIMITS.windowRuns;
const ENV = 'gha-linux-x64';

const scratches: string[] = [];
afterEach(() => {
  while (scratches.length > 0) rmSync(scratches.pop() as string, { recursive: true, force: true });
});

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    id: 'PB-VOD-007',
    project: 'chromium',
    reason: 'failed and passed on the same commit | twice',
    owner: '@owner',
    since: addDays(TODAY, -1),
    expires: addDays(TODAY, 3),
    evidence: 'run 41',
    ...overrides,
  };
}

/** A history with a test above the trigger (PB-VOD-007), one with a single flaky outcome (PB-VOD-003), skips, and a fifteen-test engine job. */
function history(): FlakeRun[] {
  const all = builds(W, {
    project: 'chromium',
    flaky: (build, test) => (test === 6 && (build === 3 || build === 20)) || (test === 2 && build === 10),
  });
  const skips = [
    run([
      record({
        id: 'PB-VOD-004',
        project: 'webkit',
        outcome: 'skipped',
        skipReason: 'documented gap in local-darwin-arm64: nothing plays',
      }),
    ]),
    run([record({ id: 'PB-VOD-005', project: 'webkit', outcome: 'skipped' })]),
  ];
  return [...all, ...skips];
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    runs: history(),
    envId: ENV,
    today: TODAY,
    generatedAt: '2026-11-03T22:19:10.045Z',
    quarantine: { entries: [], problems: [] },
    catalog: facts,
    ...overrides,
  };
}

describe('PB-LAB-004 flake report: what it builds', () => {
  it('lists every test with its window, the worst first, and the signature of its last failure', () => {
    const report = buildReport(input());
    const ids = report.tests.map((t) => `${t.id}/${t.project}:${t.verdict}`);
    expect(ids.slice(0, 2)).toEqual(['PB-VOD-007/chromium:over-trigger', 'PB-VOD-003/chromium:watch']);
    expect(ids.slice(2).every((x) => x.endsWith(':ok'))).toBe(true);
    expect(report.tests).toHaveLength(15);
    const worst = report.tests[0];
    expect(worst).toMatchObject({ executions: W, flaky: 2, failed: 0, title: 'PB-VOD-007 a scenario' });
    expect(worst?.flakeRate).toBeCloseTo(2 / W, 12);
    expect(worst?.lastFailure).toMatchObject({
      outcome: 'flaky',
      signature: 'the player page did not boot (<url>): Timeout <n>ms exceeded',
    });
    expect(report.history).toMatchObject({ runs: W + 2 });
    expect(report.suites[0]).toMatchObject({ project: 'chromium', builds: W, flaky: 3 });
  });

  it('shows each quarantine entry in the state it is in: in force, expired, or not valid', () => {
    const active = entry();
    const expired = entry({
      id: 'PB-VOD-008',
      project: undefined,
      since: addDays(TODAY, -9),
      expires: addDays(TODAY, -2),
    });
    const invalid = entry({ id: 'PB-VOD-006', expires: addDays(TODAY, 30) });
    const report = buildReport(input({ quarantine: { entries: [active, expired, invalid], problems: [] } }));
    expect(report.quarantine.map((q) => [q.entry.id, q.state, q.tier])).toEqual([
      ['PB-VOD-007', 'active', 'merge'],
      ['PB-VOD-008', 'expired', 'release'],
      ['PB-VOD-006', 'not-valid', 'merge'],
    ]);
    expect(report.quarantineProblems).toHaveLength(1);
    // The quarantined test is in the table with its entry, and is left out of the suite rate.
    expect(report.tests.find((t) => t.id === 'PB-VOD-007')?.quarantine?.owner).toBe('@owner');
    expect(report.suites[0]).toMatchObject({ flaky: 1, quarantinedFlaky: 2 });
  });

  it('lists what was skipped and says so when a skip has no reason', () => {
    const report = buildReport(input());
    expect(report.skips).toEqual([
      {
        id: 'PB-VOD-004',
        project: 'webkit',
        reason: 'documented gap in local-darwin-arm64: nothing plays',
        date: expect.any(String),
        times: 1,
        of: 1,
      },
      { id: 'PB-VOD-005', project: 'webkit', reason: null, date: expect.any(String), times: 1, of: 1 },
    ]);
    expect(report.notes).toContain(
      '1 skipped tests carry no reason: a skip without evidence is a bug (docs/CONTRACTS.md section 7.3).',
    );
  });

  it('counts the invalid runs of a test: how many of its runs were skipped, and the reason of the last, in the markdown', () => {
    const invalid = (n: number) =>
      record({
        id: 'PB-ABR-002',
        project: 'webkit',
        outcome: 'skipped',
        skipReason: `invalid run: forced climb to 360p 5.${n} s after the step down, 10 of 974 frames dropped. The 8 s switch interval allows no decision of the adaptation that soon after the step down`,
      });
    const runs = [
      ...Array.from({ length: 12 }, () => run([record({ id: 'PB-ABR-002', project: 'webkit' })])),
      run([invalid(9)]),
      run([record({ id: 'PB-ABR-002', project: 'webkit', outcome: 'flaky' })]),
      run([invalid(8)]),
      run([invalid(7)]),
    ];
    const report = buildReport(input({ runs }));
    expect(report.skips).toEqual([
      expect.objectContaining({ id: 'PB-ABR-002', project: 'webkit', times: 3, of: 16 }),
    ]);
    expect(report.skips[0]?.reason).toMatch(/^invalid run: forced climb to 360p 5\.7 s after the step down/);
    const text = renderMarkdown(report);
    expect(text).toContain(
      '| Test | Engine | Reason (the evidence a documented gap carries) | Last seen | Skipped |',
    );
    const line = text
      .split('\n')
      .find((l) => l.startsWith('| PB-ABR-002 | webkit | invalid run: forced climb to 360p 5.7 s'));
    expect(line).toMatch(/\| 3 of 16 runs \|$/);
  });

  it('says what it left out: executions without a retry, a young history, an empty one', () => {
    const noRetry = buildReport(input({ runs: builds(3, { retries: 0 }) }));
    expect(noRetry.notes).toContain(
      '45 executions had no retry in their configuration: a flake cannot show in them, so they are in no rate (docs/FLAKE.md, "What is excluded").',
    );
    const young = buildReport(input({ runs: builds(5) }));
    expect(young.notes).toContain(
      `chromium (5 builds): fewer than ${FLAKE_LIMITS.minRunsToJudge} builds, so the suite rate is shown and not judged.`,
    );
    const empty = buildReport(input({ runs: [] }));
    expect(empty.history).toEqual({ runs: 0, from: null, to: null });
    expect(empty.notes[0]).toContain('The history of this environment is empty');
  });

  it('uses only the runs of its environment', () => {
    const mixed = [
      ...history(),
      ...builds(W, { project: 'chromium', envId: 'gha-macos-arm64', flaky: () => true }),
    ];
    expect(buildReport(input({ runs: mixed })).history.runs).toBe(W + 2);
  });
});

describe('PB-LAB-004 flake report: the invalid runs against their budget', () => {
  const share = (invalid: number, total: number): string => 'p'.repeat(total - invalid) + 'i'.repeat(invalid);
  const BUDGET = FLAKE_LIMITS.invalidRunBudgetRate;
  const OVER = Math.round(BUDGET * W) + 1;

  /** PB-ABR-002 on webkit over its budget, PB-ABR-001 with too few runs, PB-ABR-006 within it, and two tests with no invalid run. */
  function invalidHistory(): FlakeRun[] {
    return [
      ...pattern('PB-ABR-002', share(OVER, W), { project: 'webkit' }),
      ...pattern('PB-ABR-001', share(3, 10), { project: 'webkit' }),
      ...pattern('PB-ABR-006', share(5, 25), { project: 'webkit' }),
      ...pattern('PB-ABR-002', share(0, W), { project: 'chromium' }),
      ...pattern('PB-VOD-001', share(0, W), { project: 'chromium' }),
    ];
  }

  it('lists every test and engine with its invalid runs, share, budget and verdict, the worst first', () => {
    const report = buildReport(input({ runs: invalidHistory() }));
    expect(
      report.invalidRuns.map((t) => `${t.id} ${t.project} ${t.invalid}/${t.scheduled} ${t.verdict}`),
    ).toEqual([
      `PB-ABR-002 webkit ${OVER}/${W} over-invalid-budget`,
      'PB-ABR-001 webkit 3/10 not-enough-data',
      'PB-ABR-006 webkit 5/25 ok',
      `PB-ABR-002 chromium 0/${W} ok`,
      `PB-VOD-001 chromium 0/${W} ok`,
    ]);
    expect(report.invalidRuns[0]).toMatchObject({ share: OVER / W, budget: BUDGET, quarantine: null });
    expect(report.limits.invalidRunBudgetRate).toBe(BUDGET);
  });

  it('prints them in a table of their own: N of M, the share, the budget, the verdict and the last invalid run, and counts the rest', () => {
    const report = buildReport(input({ runs: invalidHistory() }));
    const text = renderMarkdown(report);
    const section = text.slice(text.indexOf('## Invalid runs'), text.indexOf('## Quarantine'));
    expect(text).toContain(`the invalid-run budget ${percent(BUDGET)}.`);
    expect(section).toContain(
      '| Test | Engine | Tier | Invalid runs | Share | Budget | Verdict | Quarantine | Last invalid run |',
    );
    const lastDate = (report.invalidRuns[0]?.lastInvalid?.date ?? '').slice(0, 10);
    expect(section).toContain(
      `| PB-ABR-002 | webkit | merge | ${OVER} of ${W} | ${percent(OVER / W)} | ${percent(BUDGET)} | over-invalid-budget | - | ${lastDate}: forced climb to 360p 3.3 s after the step down, 13 of 1104 frames dropped |`,
    );
    expect(section).toContain(
      `| PB-ABR-001 | webkit | merge | 3 of 10 | ${percent(0.3)} | ${percent(BUDGET)} | not-enough-data |`,
    );
    expect(section).toContain(
      `| PB-ABR-006 | webkit | merge | 5 of 25 | ${percent(0.2)} | ${percent(BUDGET)} | ok |`,
    );
    // The two with no invalid run are counted, not listed.
    expect(section).not.toContain('PB-VOD-001');
    expect(section).toContain('2 tests and engines with no invalid run in their window are not listed.');
  });

  it('shows a quarantine next to the overrun, and does not take the overrun back', () => {
    const entries = [entry({ id: 'PB-ABR-002', project: 'webkit' })];
    const report = buildReport(input({ runs: invalidHistory(), quarantine: { entries, problems: [] } }));
    expect(report.invalidRuns[0]).toMatchObject({
      id: 'PB-ABR-002',
      project: 'webkit',
      verdict: 'over-invalid-budget',
      quarantine: expect.objectContaining({ owner: '@owner' }),
    });
    expect(renderMarkdown(report)).toContain(`| over-invalid-budget | until ${addDays(TODAY, 3)} (@owner) |`);
  });

  it('says plainly when no test has an invalid run, and when nothing was scheduled', () => {
    expect(renderMarkdown(buildReport(input()))).toContain('No test has an invalid run in its window.');
    expect(buildReport(input()).invalidRuns.every((t) => t.invalid === 0)).toBe(true);
    const empty = buildReport(input({ runs: [] }));
    expect(empty.invalidRuns).toEqual([]);
    expect(renderMarkdown(empty)).toContain('No test has been scheduled in the history.');
  });
});

describe('PB-LAB-004 flake report: the markdown', () => {
  it('has a section for the engine jobs, the tests, the invalid runs, the quarantine, the skips and what the numbers do not say', () => {
    const text = renderMarkdown(buildReport(input({ quarantine: { entries: [entry()], problems: [] } })));
    const headings = text.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toEqual([
      `# Flake report: ${ENV}`,
      '## Engine jobs: the suite flake rate',
      `## Tests: the last ${W} executions of each`,
      '## Invalid runs: the share of scheduled executions that could not evaluate their claim',
      '## Quarantine',
      '## Skipped',
      '## Notes',
      '## What this does not say',
    ]);
    expect(text).toContain(
      '| Engine job | Builds | Executions | Flaky | Failed | Flake rate | Budget | Verdict | Quarantined (left out) | Worst tests |',
    );
    expect(text).toContain(
      `| chromium | ${W} | ${W * 15 - W} | 1 | 0 | ${percent(1 / (W * 14))} | ${percent(FLAKE_LIMITS.suiteBudgetRate)} | ok | ${W} (2 flaky) | PB-VOD-003 1 |`,
    );
    expect(text).toContain(
      `| PB-VOD-007 | chromium | merge | ${W} | 2 | 0 | ${percent(2 / W)} | 0.0% | over-trigger | until ${addDays(TODAY, 3)} (@owner) |`,
    );
    expect(text).toContain(
      '| PB-VOD-003 | chromium | merge | 30 | 1 | 0 | 3.3% | 0.0% | watch | - | flaky, ',
    );
    expect(text).toContain('| PB-VOD-005 | webkit | NO REASON RECORDED |');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps a table a table: pipes and line breaks in a cell are escaped, and a long cell is cut', () => {
    expect(cell('a | b\nc   d')).toBe('a \\| b c d');
    expect(cell('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(cell(null)).toBe('');
    expect(cell(7)).toBe('7');
    const text = renderMarkdown(buildReport(input({ quarantine: { entries: [entry()], problems: [] } })));
    const reason = text.split('\n').find((l) => l.startsWith('| PB-VOD-007 | chromium | merge | @owner'));
    expect(reason).toContain('failed and passed on the same commit \\| twice');
    // Every table row has as many cells as its header, counting only unescaped pipes.
    for (const table of text.split('\n\n').filter((block) => block.startsWith('|'))) {
      const rows = table.split('\n');
      const cells = (line: string) => line.replace(/\\\|/g, '').split('|').length;
      expect(new Set(rows.map(cells)).size, rows[0]).toBe(1);
    }
  });

  it('says plainly that there is nothing to show', () => {
    const text = renderMarkdown(buildReport(input({ runs: [] })));
    expect(text).toContain('The history of this environment is empty.');
    expect(text).toContain('No merge-tier execution in the history.');
    expect(text).toContain('No test has been executed in the history.');
    expect(text).toContain('Nothing is quarantined: flake/quarantine.json is empty.');
    expect(text).toContain('No test was skipped in the history.');
  });
});

describe('PB-LAB-004 flake report command', () => {
  function setup(env: NodeJS.ProcessEnv = {}) {
    const dir = makeScratch('flake-report-');
    scratches.push(dir);
    const out: string[] = [];
    const err: string[] = [];
    const io: ReportIo = {
      ...defaultReportIo(),
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      env,
      cwd: dir,
      root: ROOT,
      now: () => new Date(`${TODAY}T22:00:00Z`),
    };
    writeFileSync(join(dir, 'quarantine.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
    const argv = (...more: string[]) => [
      '--history-dir',
      'history',
      '--quarantine',
      join(dir, 'quarantine.json'),
      ...more,
    ];
    return { dir, out, err, io, argv, store: new FileStore({ dir: join(dir, 'history') }) };
  }

  it('prints the report of the history, and writes it as markdown and as JSON', async () => {
    const s = setup();
    await s.store.append(ENV, history());
    expect(await reportCommand(s.argv('--env', ENV), s.io)).toBe(0);
    const text = s.out.join('\n');
    expect(text).toContain(`# Flake report: ${ENV}`);
    expect(text).toContain('| PB-VOD-007 | chromium | merge |');
    expect(readFileSync(join(s.dir, 'reports/flake/report.md'), 'utf8')).toBe(
      `${text}`.replace(/\n$/, '') + '\n',
    );
    const json = JSON.parse(readFileSync(join(s.dir, 'reports/flake/report.json'), 'utf8'));
    expect(json.envId).toBe(ENV);
    expect(json.tests[0]).toMatchObject({ id: 'PB-VOD-007', verdict: 'over-trigger' });
    expect(json.suites[0]).toMatchObject({ project: 'chromium', builds: W });
    expect(json.generatedAt).toBe(`${TODAY}T22:00:00.000Z`);
  });

  it('writes the invalid runs, their share and the budget in the JSON', async () => {
    const s = setup();
    const over = Math.round(FLAKE_LIMITS.invalidRunBudgetRate * W) + 1;
    await s.store.append(ENV, pattern('PB-ABR-002', 'p'.repeat(W - over) + 'i'.repeat(over)));
    expect(await reportCommand(s.argv('--env', ENV), s.io)).toBe(0);
    const json = JSON.parse(readFileSync(join(s.dir, 'reports/flake/report.json'), 'utf8'));
    expect(json.limits.invalidRunBudgetRate).toBe(FLAKE_LIMITS.invalidRunBudgetRate);
    expect(json.invalidRuns).toHaveLength(1);
    expect(json.invalidRuns[0]).toMatchObject({
      id: 'PB-ABR-002',
      project: 'webkit',
      invalid: over,
      scheduled: W,
      share: over / W,
      budget: FLAKE_LIMITS.invalidRunBudgetRate,
      verdict: 'over-invalid-budget',
      lastInvalid: { reason: INVALID_REASON },
      quarantine: null,
    });
    expect(s.out.join('\n')).toContain('| PB-ABR-002 | webkit | merge |');
  });

  it('adds to the job summary when there is one, and includes run files that are not recorded yet', async () => {
    const summary = join(scratchDir(), 'summary.md');
    const s = setup({ GITHUB_STEP_SUMMARY: summary });
    const recorded = history();
    await s.store.append(ENV, recorded);
    const extra = builds(1, { project: 'firefox', firstBuild: 900 })[0] as FlakeRun;
    mkdirSync(join(s.dir, 'reports/flake'), { recursive: true });
    writeFileSync(join(s.dir, 'reports/flake/run.json'), renderRunFile(extra));
    expect(await reportCommand(s.argv(), s.io)).toBe(0);
    expect(readFileSync(summary, 'utf8')).toContain('# Flake report');
    expect(
      JSON.parse(readFileSync(join(s.dir, 'reports/flake/report.json'), 'utf8')).suites.map(
        (x: { project: string }) => x.project,
      ),
    ).toEqual(['chromium', 'firefox']);
  });

  it('reports an empty history without failing, and fails (exit 2) when the history cannot be read', async () => {
    const empty = setup();
    expect(await reportCommand(empty.argv('--env', ENV), empty.io)).toBe(0);
    expect(empty.out.join('\n')).toContain('The history of this environment is empty.');
    expect(existsSync(join(empty.dir, 'reports/flake/report.json'))).toBe(true);

    const broken = setup();
    mkdirSync(join(broken.dir, 'history'), { recursive: true });
    writeFileSync(join(broken.dir, 'history', `${ENV}.jsonl`), 'garbage\n');
    expect(await reportCommand(broken.argv('--env', ENV), broken.io)).toBe(2);
    expect(broken.err.join('\n')).toContain('flake report: cannot read the history');
    expect(await reportCommand(['--bogus'], broken.io)).toBe(2);
    expect(await reportCommand(['--help'], broken.io)).toBe(0);
  });

  it('defaults to the environment of this machine', async () => {
    const s = setup();
    expect(await reportCommand(s.argv(), { ...s.io, env: { PB_ENV_ID: 'my-laptop' } })).toBe(0);
    expect(s.out.join('\n')).toContain('# Flake report: my-laptop');
  });
});

function scratchDir(): string {
  const dir = makeScratch('flake-report-aux-');
  scratches.push(dir);
  mkdirSync(dirname(join(dir, 'x')), { recursive: true });
  return dir;
}
