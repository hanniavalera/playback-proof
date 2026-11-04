import { describe, expect, it } from 'vitest';
import { FLAKE_LIMITS, FLAKE_POLICY } from '../../../src/shared/criteria.ts';
import type { FlakeRun } from '../../../flake/run.ts';
import { flakeStats, percent, suiteStats, testStats } from '../../../flake/stats.ts';
import { builds, historyOf, record, run, sequence } from './fixtures.ts';

const W = FLAKE_LIMITS.windowRuns;
const MIN = FLAKE_LIMITS.minRunsToJudge;
const TRIGGER = FLAKE_LIMITS.quarantineTriggerRate;
const BUDGET = FLAKE_LIMITS.suiteBudgetRate;

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

describe('PB-LAB-004 flake rate per test: the arithmetic of the policy', () => {
  it('reads two flaky outcomes in a full window as the quoted 6.7 % and over the trigger, one as 3.3 % and not', () => {
    const two = only(testStats(historyOf('PB-VOD-001', sequence(W, { 3: 'flaky', 17: 'flaky' }))));
    const one = only(testStats(historyOf('PB-VOD-001', sequence(W, { 3: 'flaky' }))));
    const none = only(testStats(historyOf('PB-VOD-001', sequence(W))));

    expect([two.executions, two.flaky, two.failed]).toEqual([W, 2, 0]);
    expect(two.flakeRate).toBeCloseTo(2 / W, 12);
    expect(two.verdict).toBe('over-trigger');
    expect(one.verdict).toBe('watch');
    expect(none.verdict).toBe('ok');
    expect(none.flakeRate).toBe(0);

    // The figures criteria.ts quotes for its own numbers are the ones computed here.
    const quoted = FLAKE_POLICY.quarantineTriggerRate.basis.text;
    expect(quoted).toContain(`2/${W} = ${percent(two.flakeRate)}`);
    expect(quoted).toContain(`one is ${percent(one.flakeRate)}`);
    expect(two.flakeRate).toBeGreaterThan(TRIGGER);
    expect(one.flakeRate).toBeLessThanOrEqual(TRIGGER);
  });

  it('puts "above the trigger" strictly above: one flaky outcome in the minimum number of runs is exactly the trigger and is not above', () => {
    // The precondition that makes this the boundary case: if the policy changes, this test says so instead of passing by accident.
    expect(1 / MIN).toBe(TRIGGER);
    const atTrigger = only(testStats(historyOf('PB-VOD-001', sequence(MIN, { 0: 'flaky' }))));
    expect(atTrigger.flakeRate).toBe(TRIGGER);
    expect(atTrigger.verdict).toBe('watch');

    const above = only(testStats(historyOf('PB-VOD-001', sequence(MIN, { 0: 'flaky', 7: 'flaky' }))));
    expect(above.verdict).toBe('over-trigger');
  });

  it('gives no verdict below the minimum number of runs, however bad the rate looks', () => {
    // One flaky outcome of the minimum less one is above the trigger, and still there is no verdict.
    const short = only(testStats(historyOf('PB-VOD-001', sequence(MIN - 1, { 0: 'flaky' }))));
    expect(short.flakeRate).toBeGreaterThan(TRIGGER);
    expect(short.verdict).toBe('not-enough-data');

    const allFlaky = only(
      testStats(
        historyOf(
          'PB-VOD-001',
          sequence(MIN - 1).map(() => 'flaky' as const),
        ),
      ),
    );
    expect(allFlaky.flakeRate).toBe(1);
    expect(allFlaky.verdict).toBe('not-enough-data');

    const enough = only(testStats(historyOf('PB-VOD-001', sequence(MIN, { 0: 'flaky', 1: 'flaky' }))));
    expect(enough.verdict).toBe('over-trigger');
  });

  it('keeps only the last window of executions: a flaky outcome leaves the window when the window moves past it', () => {
    const verdictAfter = (passesAfter: number) =>
      only(testStats(historyOf('PB-VOD-001', ['flaky', 'flaky', ...sequence(passesAfter)])));

    // Both flaky outcomes are still in the window while the history fits it.
    const full = verdictAfter(W - 2);
    expect([full.executions, full.flaky, full.verdict]).toEqual([W, 2, 'over-trigger']);
    // One more execution pushes the oldest out.
    const oneLeft = verdictAfter(W - 1);
    expect([oneLeft.executions, oneLeft.flaky, oneLeft.verdict]).toEqual([W, 1, 'watch']);
    const bothLeft = verdictAfter(W);
    expect([bothLeft.executions, bothLeft.flaky, bothLeft.verdict]).toEqual([W, 0, 'ok']);
    expect(bothLeft.executionsInHistory).toBe(W + 2);
    expect(bothLeft.window).toHaveLength(W);
  });

  it('counts a failure after every attempt as a failure and not as a flake, and judges only flakes', () => {
    const history = historyOf(
      'PB-VOD-001',
      sequence(W, { 2: 'failed', 9: 'timedOut', 14: 'failed', 20: 'flaky' }),
    );
    const stats = only(testStats(history));
    expect(stats.flaky).toBe(1);
    expect(stats.failed).toBe(3);
    expect(stats.passed).toBe(W - 4);
    expect(stats.flakeRate).toBeCloseTo(1 / W, 12);
    expect(stats.failureRate).toBeCloseTo(3 / W, 12);
    // A failure already failed its own browser job; the flake gate is about what retries hide.
    expect(stats.verdict).toBe('watch');

    const alwaysRed = only(
      testStats(
        historyOf(
          'PB-VOD-001',
          sequence(W).map(() => 'failed' as const),
        ),
      ),
    );
    expect([alwaysRed.flakeRate, alwaysRed.failureRate, alwaysRed.verdict]).toEqual([0, 1, 'ok']);
  });

  it('does not count a skipped or an interrupted test as an execution', () => {
    const runs: FlakeRun[] = [
      ...historyOf('PB-VOD-001', sequence(MIN)),
      run([record({ id: 'PB-VOD-001', outcome: 'skipped', skipReason: 'documented gap in x' })]),
      run([record({ id: 'PB-VOD-001', outcome: 'interrupted' })]),
    ];
    const stats = only(testStats(runs));
    expect(stats.executions).toBe(MIN);
    expect(stats.executionsInHistory).toBe(MIN);
    expect(stats.verdict).toBe('ok');
  });

  it('leaves executions without a retry out of every rate, since a flake cannot show in them, and counts them apart', () => {
    const noRetry = historyOf('PB-VOD-001', sequence(25, { 3: 'failed', 11: 'failed', 12: 'failed' }), {
      retries: 0,
    });
    const withRetry = historyOf('PB-VOD-001', sequence(MIN, { 5: 'flaky' }));
    const stats = only(testStats([...noRetry, ...withRetry]));
    expect(stats.executions).toBe(MIN);
    expect(stats.failed).toBe(0);
    expect(stats.unobserved).toBe(25);
    expect(stats.executionsInHistory).toBe(25 + MIN);
    expect(stats.verdict).toBe('watch');

    // A history made only of such runs cannot be judged, and says why.
    const onlyNoRetry = only(testStats(noRetry));
    expect([onlyNoRetry.executions, onlyNoRetry.unobserved, onlyNoRetry.verdict]).toEqual([
      0,
      25,
      'not-enough-data',
    ]);
    expect(onlyNoRetry.flakeRate).toBe(0);
  });

  it('keeps quarantined executions in the test`s own window and reports them, so that a clean window is its own', () => {
    const before = historyOf('PB-VOD-001', ['passed', 'flaky', 'passed', 'flaky']);
    const quarantinedClean = (n: number) => historyOf('PB-VOD-001', sequence(n), { quarantined: true });

    // A full window of clean executions that all ran quarantined: back to a verdict of ok, a clean window, nothing hidden.
    const back = only(testStats([...before, ...quarantinedClean(W)]));
    expect([back.flaky, back.verdict, back.cleanWindow, back.quarantinedExecutions]).toEqual([
      0,
      'ok',
      true,
      W,
    ]);

    // One execution short of a full clean window the old flaky outcomes are still in it.
    const almost = only(testStats([...before, ...quarantinedClean(W - 1)]));
    expect(almost.flaky).toBe(1);
    expect(almost.cleanWindow).toBe(false);
    expect(almost.verdict).toBe('watch');

    // A window with a flaky outcome of its own is not clean, even if it is full; neither is a window with a failure.
    const dirty = only(testStats(historyOf('PB-VOD-001', sequence(W, { 10: 'flaky' }))));
    expect(dirty.cleanWindow).toBe(false);
    const failing = only(testStats(historyOf('PB-VOD-001', sequence(W, { 10: 'failed' }))));
    expect(failing.cleanWindow).toBe(false);
    // And a window that is not full is not a clean window, whatever it holds.
    expect(only(testStats(historyOf('PB-VOD-001', sequence(W - 1)))).cleanWindow).toBe(false);
  });

  it('reports the newest flaky or failed execution of the window with its signature, and null for a clean one', () => {
    const runs = [
      run([record({ id: 'PB-VOD-001', outcome: 'flaky', signature: 'old cause' })], {
        runId: 'r-old',
        commit: 'a'.repeat(40),
      }),
      ...historyOf('PB-VOD-001', sequence(5)),
      run([record({ id: 'PB-VOD-001', outcome: 'failed', signature: 'newer cause' })], {
        runId: 'r-new',
        commit: 'b'.repeat(40),
      }),
      ...historyOf('PB-VOD-001', sequence(3)),
    ];
    const stats = only(testStats(runs));
    expect(stats.lastFailure).toMatchObject({
      outcome: 'failed',
      signature: 'newer cause',
      runId: 'r-new',
      commit: 'b'.repeat(40),
    });
    expect(only(testStats(historyOf('PB-VOD-001', sequence(3)))).lastFailure).toBeNull();
  });

  it('keeps one test on two engines as two tests, in a stable order', () => {
    const runs = [
      ...historyOf('PB-VOD-002', sequence(MIN, { 2: 'flaky', 3: 'flaky' }), { project: 'firefox' }),
      ...historyOf('PB-VOD-002', sequence(MIN), { project: 'chromium' }),
      ...historyOf('PB-VOD-001', sequence(MIN), { project: 'firefox' }),
    ];
    const stats = testStats(runs);
    expect(stats.map((s) => `${s.id}/${s.project}/${s.verdict}`)).toEqual([
      'PB-VOD-001/firefox/ok',
      'PB-VOD-002/chromium/ok',
      'PB-VOD-002/firefox/over-trigger',
    ]);
  });

  it('takes the tier of the newest record and remembers an experimental engine', () => {
    const runs = [
      run([record({ id: 'PB-VOD-001', tier: 'release' })]),
      run([record({ id: 'PB-VOD-001', tier: 'merge', experimental: true })]),
    ];
    const stats = only(testStats(runs));
    expect(stats.tier).toBe('merge');
    expect(stats.experimental).toBe(true);
  });

  it('uses the limits it is given, so that a policy change moves the verdicts and nothing else', () => {
    const history = historyOf('PB-VOD-001', sequence(10, { 1: 'flaky' }));
    expect(only(testStats(history)).verdict).toBe('not-enough-data');
    const loose = { ...FLAKE_LIMITS, minRunsToJudge: 5, quarantineTriggerRate: 0.2 };
    expect(only(testStats(history, loose)).verdict).toBe('watch');
    const strict = { ...FLAKE_LIMITS, minRunsToJudge: 5, quarantineTriggerRate: 0.05 };
    expect(only(testStats(history, strict)).verdict).toBe('over-trigger');
    const small = { ...FLAKE_LIMITS, windowRuns: 4, minRunsToJudge: 4 };
    expect(only(testStats(history, small)).executions).toBe(4);
  });
});

describe('PB-LAB-004 suite flake rate per engine job: the budget of the gate', () => {
  const TESTS = 15;

  it('is retried-then-passed over all executions of the merge-tier tests of the window', () => {
    const atBudget = Math.round(BUDGET * W * TESTS);
    const flakyOnly = (n: number) => (build: number, test: number) => test === 0 && build < n;
    const at = only(suiteStats(builds(W, { tests: TESTS, flaky: flakyOnly(atBudget) })));
    expect([at.builds, at.executions, at.flaky]).toEqual([W, W * TESTS, atBudget]);
    expect(at.flakeRate).toBeCloseTo(BUDGET, 12);
    expect(at.budget).toBe(BUDGET);
    // At the budget is within it; one more flaky outcome is above it.
    expect(at.verdict).toBe('ok');
    const above = only(suiteStats(builds(W, { tests: TESTS, flaky: flakyOnly(atBudget + 1) })));
    expect(above.flakeRate).toBeGreaterThan(BUDGET);
    expect(above.verdict).toBe('over-budget');
    expect(above.contributors).toEqual([{ id: 'PB-VOD-001', flaky: atBudget + 1, executions: W }]);
  });

  it('counts the merge tier only: a release-tier test that flakes is not in the suite rate', () => {
    const flakyAlways = () => true;
    const release = suiteStats(builds(W, { tests: TESTS, tier: 'release', flaky: flakyAlways }));
    expect(release).toEqual([]);

    const mixed = [
      ...builds(W, { tests: TESTS }),
      ...builds(W, { tests: TESTS, tier: 'release', flaky: flakyAlways }),
    ];
    const stats = only(suiteStats(mixed));
    expect([stats.executions, stats.flaky, stats.verdict]).toEqual([W * TESTS, 0, 'ok']);
  });

  it('keeps the engine jobs apart', () => {
    const runs = [
      ...builds(W, { tests: TESTS, project: 'chromium' }),
      ...builds(W, { tests: TESTS, project: 'firefox', flaky: (build) => build % 2 === 0 }),
    ];
    const [chromium, firefox] = suiteStats(runs);
    expect([chromium?.project, chromium?.flaky, chromium?.verdict]).toEqual(['chromium', 0, 'ok']);
    expect([firefox?.project, firefox?.verdict]).toEqual(['firefox', 'over-budget']);
    expect(firefox?.flaky).toBe(Math.ceil(W / 2) * TESTS);
  });

  it('looks at the last window of builds only: an old burst of flakes is forgotten', () => {
    const burst = builds(5, { tests: TESTS, flaky: () => true });
    const clean = builds(W, { tests: TESTS, firstBuild: 5 });
    const stats = only(suiteStats([...burst, ...clean]));
    expect([stats.builds, stats.flaky, stats.verdict]).toEqual([W, 0, 'ok']);

    // One build fewer of the clean ones, and the newest build of the burst is still inside the window.
    const stillIn = only(suiteStats([...burst, ...builds(W - 1, { tests: TESTS, firstBuild: 5 })]));
    expect(stillIn.builds).toBe(W);
    expect(stillIn.flaky).toBe(TESTS);
  });

  it('gives no verdict before the window holds the minimum number of builds, and still reports the rate', () => {
    const short = only(suiteStats(builds(MIN - 1, { tests: TESTS, flaky: () => true })));
    expect(short.flakeRate).toBe(1);
    expect(short.verdict).toBe('not-enough-data');
    const enough = only(suiteStats(builds(MIN, { tests: TESTS, flaky: () => true })));
    expect(enough.verdict).toBe('over-budget');
  });

  it('leaves quarantined executions out and reports them: those that ran quarantined, and the old ones of a test quarantined now', () => {
    const everyOther = (build: number, test: number) => test === 3 && build % 2 === 0;
    const noisy = builds(W, { tests: TESTS, flaky: everyOther });
    const base = only(suiteStats(noisy));
    expect(base.verdict).toBe('over-budget');

    // The way out the policy promises: quarantine the contributor, and its flakes, old ones included, leave the rate.
    const quarantinedNow = (id: string, project: string) => id === 'PB-VOD-004' && project === 'chromium';
    const out = only(suiteStats(noisy, { quarantined: quarantinedNow }));
    expect(out.flaky).toBe(0);
    expect(out.verdict).toBe('ok');
    expect(out.executions).toBe(W * (TESTS - 1));
    expect(out.quarantinedExecutions).toBe(W);
    expect(out.quarantinedFlaky).toBe(base.flaky);

    // Executions recorded as quarantined are left out whether or not the list still says so.
    const flagged = builds(W, {
      tests: TESTS,
      flaky: everyOther,
      quarantined: (_build, test) => test === 3,
    });
    const flaggedStats = only(suiteStats(flagged));
    expect([flaggedStats.flaky, flaggedStats.executions, flaggedStats.verdict]).toEqual([
      0,
      W * (TESTS - 1),
      'ok',
    ]);
    expect([flaggedStats.quarantinedExecutions, flaggedStats.quarantinedFlaky]).toEqual([W, base.flaky]);
  });

  it('does not take a run of quarantined executions for a build', () => {
    const real = builds(MIN - 1, { tests: TESTS });
    const quarantinedOnly = Array.from({ length: 5 }, () =>
      run([record({ id: 'PB-VOD-004', quarantined: true, outcome: 'flaky' })]),
    );
    const stats = only(suiteStats([...real, ...quarantinedOnly]));
    expect(stats.builds).toBe(MIN - 1);
    expect(stats.verdict).toBe('not-enough-data');
    expect(stats.flaky).toBe(0);
  });

  it('leaves executions without a retry out of the rate and says how many', () => {
    const runs = [...builds(W, { tests: TESTS }), ...builds(3, { tests: TESTS, retries: 0, firstBuild: W })];
    const stats = only(suiteStats(runs));
    expect(stats.builds).toBe(W);
    expect(stats.unobserved).toBe(3 * TESTS);
    expect(stats.executions).toBe(W * TESTS);
  });

  it('lists the tests that flaked, the worst first', () => {
    const flaky = (build: number, test: number) =>
      (test === 2 && build < 3) || (test === 5 && build < 1) || (test === 0 && build < 3);
    const stats = only(suiteStats(builds(W, { tests: TESTS, flaky })));
    expect(stats.contributors).toEqual([
      { id: 'PB-VOD-001', flaky: 3, executions: W },
      { id: 'PB-VOD-003', flaky: 3, executions: W },
      { id: 'PB-VOD-006', flaky: 1, executions: W },
    ]);
  });

  it('is part of flakeStats next to the per-test rows', () => {
    const stats = flakeStats(builds(MIN, { tests: 3, flaky: (build, test) => test === 1 && build < 2 }));
    expect(stats.tests.map((t) => `${t.id}:${t.flaky}:${t.verdict}`)).toEqual([
      'PB-VOD-001:0:ok',
      'PB-VOD-002:2:over-trigger',
      'PB-VOD-003:0:ok',
    ]);
    expect(only(stats.suites).flaky).toBe(2);
  });
});
