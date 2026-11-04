import { describe, expect, it } from 'vitest';
import { FLAKE_LIMITS, INVALID_RUN_PREFIX } from '../../../src/shared/criteria.ts';
import { recordOf } from '../../../flake/reporter.ts';
import { isInvalidRun, scheduledOf } from '../../../flake/run.ts';
import type { FlakeRun, TestRecord } from '../../../flake/run.ts';
import { flakeStats, invalidRunStats, invalidRunsAllowed, testStats } from '../../../flake/stats.ts';
import {
  ABR002_FIX,
  ABR002_TRACEOFF,
  GAP_REASON,
  INVALID_REASON,
  OTHER_SKIP_REASON,
  pattern,
  realHistory,
} from './invalid-fixtures.ts';
import { record } from './fixtures.ts';

const W = FLAKE_LIMITS.windowRuns;
const MIN = FLAKE_LIMITS.minRunsToJudge;
const BUDGET = FLAKE_LIMITS.invalidRunBudgetRate;
/** The most invalid runs of a full window that are still within the budget (exactly the budget), and the same at the minimum. */
const AT_BUDGET = Math.round(BUDGET * W);
const AT_BUDGET_MIN = Math.round(BUDGET * MIN);

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

/** The invalid-run statistics of one test on one engine, from a pattern of executions (invalid-fixtures.ts). */
const stats = (chars: string, options: Parameters<typeof pattern>[2] = {}) =>
  only(invalidRunStats(pattern('PB-ABR-002', chars, options)));

/** `total` scheduled executions of which `invalid` are invalid runs, the invalid ones the newest. */
const share = (invalid: number, total: number): string => 'p'.repeat(total - invalid) + 'i'.repeat(invalid);

describe('PB-LAB-004 invalid-run budget: the arithmetic of the policy', () => {
  it('reads invalid runs over scheduled executions of a full window, and exactly the budget as within it', () => {
    // The preconditions that make these the boundary cases: if the policy changes, this test says so instead of passing by accident.
    expect(AT_BUDGET / W).toBe(BUDGET);
    expect(AT_BUDGET_MIN / MIN).toBe(BUDGET);

    const at = stats(share(AT_BUDGET, W));
    expect([at.scheduled, at.invalid, at.share, at.budget]).toEqual([W, AT_BUDGET, BUDGET, BUDGET]);
    expect(at.verdict).toBe('ok');

    const above = stats(share(AT_BUDGET + 1, W));
    expect([above.scheduled, above.invalid]).toEqual([W, AT_BUDGET + 1]);
    expect(above.share).toBeCloseTo((AT_BUDGET + 1) / W, 12);
    expect(above.verdict).toBe('over-invalid-budget');

    expect(stats('p'.repeat(W)).verdict).toBe('ok');
    expect(stats('p'.repeat(W)).share).toBe(0);
    expect(stats('i'.repeat(W)).verdict).toBe('over-invalid-budget');
  });

  it('is judged from the minimum number of scheduled executions: below it there is no verdict, however bad the share', () => {
    const short = stats('i'.repeat(MIN - 1));
    expect([short.scheduled, short.invalid, short.share]).toEqual([MIN - 1, MIN - 1, 1]);
    expect(short.verdict).toBe('not-enough-data');

    // At the minimum the verdict is there, and the boundary is the same: 8 of 20 is exactly the budget, 9 of 20 is above it.
    expect(stats(share(AT_BUDGET_MIN, MIN)).verdict).toBe('ok');
    expect(stats(share(AT_BUDGET_MIN + 1, MIN)).verdict).toBe('over-invalid-budget');
  });

  it('keeps only the last window of scheduled executions: the invalid runs older than it are ignored', () => {
    // 31 scheduled executions: one invalid run just outside the window, and the budget exactly in the window.
    const edge = stats(`i${share(AT_BUDGET, W)}`);
    expect([edge.scheduled, edge.invalid]).toEqual([W, AT_BUDGET]);
    expect(edge.verdict).toBe('ok');

    // One more inside the window and it is over: the window is not too short either.
    const inside = stats(`i${share(AT_BUDGET + 1, W)}`);
    expect([inside.scheduled, inside.invalid]).toEqual([W, AT_BUDGET + 1]);
    expect(inside.verdict).toBe('over-invalid-budget');

    // A leg that was all invalid runs, and is now valid: its past leaves the window with its 30 newer executions.
    const recovered = stats(`${'i'.repeat(50)}${'p'.repeat(W)}`);
    expect([recovered.scheduled, recovered.invalid, recovered.verdict]).toEqual([W, 0, 'ok']);
    expect(recovered.lastInvalid).toBeNull();

    // And it takes the whole window to clear a bad one: with the window full of invalid runs, the budget is met again only after
    // `W - AT_BUDGET` valid executions have pushed the old ones out (the gate decision quotes this number).
    const clearing = (valid: number) => stats(`${'i'.repeat(W)}${'p'.repeat(valid)}`).verdict;
    expect(clearing(W - AT_BUDGET - 1)).toBe('over-invalid-budget');
    expect(clearing(W - AT_BUDGET)).toBe('ok');
    expect(invalidRunsAllowed()).toBe(AT_BUDGET);
  });

  it('gives the most invalid runs a window can hold by the limits it is given, the budget itself included', () => {
    expect(invalidRunsAllowed({ ...FLAKE_LIMITS, windowRuns: 10, invalidRunBudgetRate: 0.25 })).toBe(2);
    expect(invalidRunsAllowed({ ...FLAKE_LIMITS, windowRuns: 20, invalidRunBudgetRate: 0.4 })).toBe(8);
    expect(invalidRunsAllowed({ ...FLAKE_LIMITS, windowRuns: 30, invalidRunBudgetRate: 0 })).toBe(0);
  });

  it('judges by the limits it is given, not by the policy constant', () => {
    const history = pattern('PB-ABR-002', share(AT_BUDGET, W));
    expect(only(invalidRunStats(history)).verdict).toBe('ok');
    const tight = { ...FLAKE_LIMITS, invalidRunBudgetRate: BUDGET / 2 };
    expect(only(invalidRunStats(history, tight)).verdict).toBe('over-invalid-budget');
    expect(only(invalidRunStats(history, tight)).budget).toBe(BUDGET / 2);
    const shortMinimum = { ...FLAKE_LIMITS, minRunsToJudge: 5 };
    expect(only(invalidRunStats(pattern('PB-ABR-002', 'iiiii'), shortMinimum)).verdict).toBe(
      'over-invalid-budget',
    );
    const smallWindow = { ...FLAKE_LIMITS, windowRuns: 10, minRunsToJudge: 5 };
    expect(only(invalidRunStats(pattern('PB-ABR-002', `iiiiii${'p'.repeat(10)}`), smallWindow)).invalid).toBe(
      0,
    );
  });
});

describe('PB-LAB-004 invalid-run budget: what is an invalid run, and what is not', () => {
  const skipped = (skipReason: string | undefined, outcome: TestRecord['outcome'] = 'skipped') => ({
    outcome,
    ...(skipReason === undefined ? {} : { skipReason }),
  });

  it('recognises an invalid run by the start of the reason of the skip, and by nothing else', () => {
    expect(isInvalidRun(skipped(INVALID_REASON))).toBe(true);
    expect(isInvalidRun(skipped(`${INVALID_RUN_PREFIX} forced climb to 360p`))).toBe(true);

    // The text must start with the prefix: contained is not enough, and the case matters (the spec-side classifier writes it as is).
    expect(isInvalidRun(skipped(`this is not an ${INVALID_REASON}`))).toBe(false);
    expect(isInvalidRun(skipped(INVALID_REASON.replace('invalid', 'Invalid')))).toBe(false);
    expect(isInvalidRun(skipped('invalid runs are skipped on this leg'))).toBe(false);
    expect(isInvalidRun(skipped(undefined))).toBe(false);
    expect(isInvalidRun(skipped(OTHER_SKIP_REASON))).toBe(false);
    expect(isInvalidRun(skipped(GAP_REASON))).toBe(false);

    // And it is a skip: a reason on a record that ran says nothing.
    for (const outcome of ['passed', 'flaky', 'failed', 'timedOut', 'interrupted'] as const) {
      expect(isInvalidRun(skipped(INVALID_REASON, outcome))).toBe(false);
    }
  });

  it('counts the invalid runs of a history and none of the other skips', () => {
    // 20 executions that ran, then four kinds of skip that are not invalid runs, then 4 invalid runs: 4 of the 24 scheduled.
    const history = pattern(
      'PB-ABR-002',
      `${'p'.repeat(MIN)}${'g'.repeat(5)}${'s'.repeat(5)}${'n'.repeat(5)}iiii`,
    );
    const result = only(invalidRunStats(history));
    expect([result.scheduled, result.invalid]).toEqual([MIN + 4, 4]);
    expect(scheduledOf(history).filter((s) => s.invalid)).toHaveLength(4);
  });

  it('does not count a documented gap, however many there are: it is neither an invalid run nor a scheduled execution', () => {
    expect(GAP_REASON).toMatch(/^documented gap in /);
    expect(GAP_REASON.startsWith(INVALID_RUN_PREFIX)).toBe(false);

    const gaps = stats(`${'g'.repeat(40)}${'p'.repeat(MIN)}`);
    expect([gaps.scheduled, gaps.invalid, gaps.verdict]).toEqual([MIN, 0, 'ok']);

    // A gap declared after a bad stretch does not dilute it: the 40 skips push nothing out of the window of scheduled executions.
    const diluted = stats(`${share(AT_BUDGET_MIN + 1, MIN)}${'g'.repeat(40)}`);
    expect([diluted.scheduled, diluted.invalid, diluted.verdict]).toEqual([
      MIN,
      AT_BUDGET_MIN + 1,
      'over-invalid-budget',
    ]);

    // A history of nothing but gaps has no scheduled execution at all.
    expect(invalidRunStats(pattern('PB-ABR-002', 'g'.repeat(40)))).toEqual([]);
  });

  it('does not count an interrupted test, and counts a test that failed as an execution that ran', () => {
    const result = stats(`${'x'.repeat(10)}${'F'.repeat(MIN)}`);
    expect([result.scheduled, result.invalid, result.verdict]).toEqual([MIN, 0, 'ok']);
  });

  it('reads a failed attempt followed by an invalid-run skip of its retry as a failure, not as an invalid run', () => {
    const failedThenInvalid = recordOf(
      {
        title: 'PB-ABR-002 downshifts',
        describes: [],
        file: 'tests/e2e/abr.spec.ts',
        project: 'webkit',
        tags: ['@merge'],
        annotations: [
          { type: 'invalid-run', description: INVALID_REASON },
          { type: 'skip', description: INVALID_REASON },
        ],
        expectedStatus: 'passed',
        retries: 1,
        attempts: [
          { status: 'failed', durationMs: 3000, errors: [{ message: 'rung changes in the 12 s' }] },
          { status: 'skipped', durationMs: 40_000, errors: [] },
        ],
      },
      () => false,
    ) as TestRecord;
    expect(failedThenInvalid.outcome).toBe('failed');
    expect(isInvalidRun(failedThenInvalid)).toBe(false);
  });

  it('reads a skip the way the reporter records it: the `skip` annotation of the classifier is the reason', () => {
    const skippedAsInvalid = recordOf(
      {
        title: 'PB-ABR-002 downshifts',
        describes: [],
        file: 'tests/e2e/abr.spec.ts',
        project: 'webkit',
        tags: ['@merge'],
        annotations: [
          { type: 'invalid-run', description: INVALID_REASON },
          { type: 'skip', description: INVALID_REASON },
        ],
        expectedStatus: 'passed',
        retries: 1,
        attempts: [{ status: 'skipped', durationMs: 40_000, errors: [] }],
      },
      () => false,
    ) as TestRecord;
    expect(skippedAsInvalid.outcome).toBe('skipped');
    expect(isInvalidRun(skippedAsInvalid)).toBe(true);
  });

  it('counts executions without a retry, which the flake rate leaves out: whether the claim was evaluated does not need one', () => {
    const noRetry = pattern('PB-ABR-002', share(AT_BUDGET + 1, W), { retries: 0 });
    const result = only(invalidRunStats(noRetry));
    expect([result.scheduled, result.invalid, result.verdict]).toEqual([
      W,
      AT_BUDGET + 1,
      'over-invalid-budget',
    ]);
    // The same history in the flake statistics: the executions that ran are not observations of flakiness, so they are in no rate.
    const flake = only(testStats(noRetry));
    expect([flake.executions, flake.unobserved]).toEqual([0, W - AT_BUDGET - 1]);
  });
});

describe('PB-LAB-004 invalid-run budget: quarantine does not hide it', () => {
  it('counts a quarantined test exactly like any other: the quarantine is about flakiness', () => {
    const history = pattern('PB-ABR-002', share(AT_BUDGET + 1, W));
    const plain = invalidRunStats(history);
    // The list says so now (the option the suite rate uses to leave a quarantined test out)...
    expect(flakeStats(history, { quarantined: () => true }).invalidRuns).toEqual(plain);
    // ...and the record says so (the executions ran as quarantined, non-blocking).
    const flagged = only(
      invalidRunStats(pattern('PB-ABR-002', share(AT_BUDGET + 1, W), { quarantined: true })),
    );
    const numbers = (s: { invalid: number; scheduled: number; share: number; verdict: string }) => [
      s.invalid,
      s.scheduled,
      s.share,
      s.verdict,
    ];
    expect(numbers(flagged)).toEqual(numbers(only(plain)));
    expect(flagged.verdict).toBe('over-invalid-budget');
  });
});

describe('PB-LAB-004 invalid-run budget: per test and per engine', () => {
  it('keeps every test and engine apart, and finds a test that was only ever an invalid run', () => {
    const history = [
      ...pattern('PB-ABR-002', share(AT_BUDGET + 1, W), { project: 'webkit' }),
      ...pattern('PB-ABR-002', 'p'.repeat(W), { project: 'chromium' }),
      ...pattern('PB-ABR-006', 'i'.repeat(MIN), { project: 'webkit' }),
      ...pattern('PB-VOD-001', 'p'.repeat(W), { project: 'webkit' }),
    ];
    const verdicts = invalidRunStats(history).map(
      (s) => `${s.id} ${s.project} ${s.invalid}/${s.scheduled} ${s.verdict}`,
    );
    expect(verdicts).toEqual([
      `PB-ABR-002 chromium 0/${W} ok`,
      `PB-ABR-002 webkit ${AT_BUDGET + 1}/${W} over-invalid-budget`,
      `PB-ABR-006 webkit ${MIN}/${MIN} over-invalid-budget`,
      `PB-VOD-001 webkit 0/${W} ok`,
    ]);
    // PB-ABR-006 never executed: no flake statistic can see it, and this one can.
    expect(testStats(history).map((t) => t.id)).not.toContain('PB-ABR-006');
  });

  it('names the newest invalid run of the window: when, in which run, on which commit, and why', () => {
    const history = pattern('PB-ABR-002', `${share(3, 25)}ppp`, { runIdPrefix: 'collect-x' });
    const result = only(invalidRunStats(history));
    const newestInvalid = history[25 - 1] as FlakeRun;
    expect(result.lastInvalid).toEqual({
      date: newestInvalid.date,
      runId: 'collect-x-25',
      commit: newestInvalid.commit,
      reason: INVALID_REASON,
    });
    expect(stats('p'.repeat(MIN)).lastInvalid).toBeNull();
  });

  it('takes the tier and the experimental flag the way the flake statistics do', () => {
    const merge = stats('p'.repeat(MIN), { tier: 'merge' });
    expect(merge.tier).toBe('merge');
    expect(merge.experimental).toBe(false);
    const experimental = only(
      invalidRunStats([
        {
          ...(pattern('PB-ABR-002', 'p')[0] as FlakeRun),
          tests: [record({ id: 'PB-ABR-002', project: 'webkit', experimental: true })],
        },
      ]),
    );
    expect(experimental.experimental).toBe(true);
  });
});

describe('PB-LAB-004 invalid-run budget: the two real collections of PB-ABR-002 on the macOS runner', () => {
  const fix = realHistory(ABR002_FIX);
  const traceOff = realHistory(ABR002_TRACEOFF);
  const wholeCollection = { ...FLAKE_LIMITS, windowRuns: 40 };

  it('has the fixtures it says it has: 40 repetitions each, 8 and 6 of them invalid runs, every reason the shared prefix', () => {
    for (const [collection, invalid] of [
      [ABR002_FIX, 8],
      [ABR002_TRACEOFF, 6],
    ] as const) {
      expect(collection.outcomes).toHaveLength(40);
      expect([...collection.outcomes].filter((c) => c === 's')).toHaveLength(invalid);
      expect(collection.heads).toHaveLength(invalid);
      for (const head of collection.heads) expect(head.startsWith(INVALID_RUN_PREFIX)).toBe(true);
      const recorded = scheduledOf(realHistory(collection));
      expect(recorded).toHaveLength(40);
      expect(recorded.filter((s) => s.invalid).map((s) => s.reason)).toEqual(collection.heads);
    }
  });

  it('measures the shares of the evidence: 8 of 40 (20 %) with tracing on, 6 of 40 (15 %) with tracing off', () => {
    const withTrace = only(invalidRunStats(fix, wholeCollection));
    expect([withTrace.invalid, withTrace.scheduled, withTrace.share]).toEqual([8, 40, 0.2]);
    const withoutTrace = only(invalidRunStats(traceOff, wholeCollection));
    expect([withoutTrace.invalid, withoutTrace.scheduled, withoutTrace.share]).toEqual([6, 40, 0.15]);
    expect(withTrace.verdict).toBe('ok');
    expect(withoutTrace.verdict).toBe('ok');
  });

  it('judges the last window of each collection: 6 of 30 and 3 of 30, within the budget', () => {
    const withTrace = only(invalidRunStats(fix));
    expect([withTrace.invalid, withTrace.scheduled, withTrace.verdict]).toEqual([6, W, 'ok']);
    const withoutTrace = only(invalidRunStats(traceOff));
    expect([withoutTrace.invalid, withoutTrace.scheduled, withoutTrace.verdict]).toEqual([3, W, 'ok']);
    expect(withTrace.lastInvalid?.reason).toBe(ABR002_FIX.heads[7]);
    expect(withoutTrace.lastInvalid?.reason).toBe(ABR002_TRACEOFF.heads[5]);
  });

  it('would have passed every build of both collections: a normal day on the runner that shows invalid runs is not red', () => {
    for (const [history, highest] of [
      [fix, 0.2],
      [traceOff, 0.25],
    ] as const) {
      const verdicts = Array.from({ length: history.length }, (_, n) =>
        only(invalidRunStats(history.slice(0, n + 1))),
      );
      // Below the minimum there is no verdict yet; from it on, never over the budget.
      expect(verdicts.slice(0, MIN - 1).every((v) => v.verdict === 'not-enough-data')).toBe(true);
      expect(verdicts.slice(MIN - 1).every((v) => v.verdict === 'ok')).toBe(true);
      // The highest share a judged build saw: the margin that the budget leaves, as numbers.
      const judged = verdicts.slice(MIN - 1).map((v) => v.share);
      expect(Math.max(...judged)).toBe(highest);
      expect(highest).toBeLessThan(BUDGET);
    }
  });

  it('follows the budget it is given: the same real window is over a budget of 15 % and within one of 20 %', () => {
    // Not a claim about the policy: it shows that the verdict is the share against the budget and nothing else. 6 of 30 is 20 %.
    const tight = { ...FLAKE_LIMITS, invalidRunBudgetRate: 0.15 };
    expect(only(invalidRunStats(fix, tight)).verdict).toBe('over-invalid-budget');
    expect(only(invalidRunStats(traceOff, tight)).verdict).toBe('ok');
    const exact = { ...FLAKE_LIMITS, invalidRunBudgetRate: 0.2 };
    expect(only(invalidRunStats(fix, exact)).verdict).toBe('ok');
  });

  it('is over the budget when the same runner skips more than the budget of its attempts, with the reasons it really gave', () => {
    // A degraded runner, labelled so: the real reasons of the first collection, on 13 of 30 scheduled executions (43 %).
    const reasons = ABR002_FIX.heads;
    const degraded = pattern('PB-ABR-002', share(AT_BUDGET + 1, W)).map((r, index) => {
      const test = r.tests[0] as TestRecord;
      return test.outcome === 'skipped'
        ? { ...r, tests: [{ ...test, skipReason: reasons[index % reasons.length] as string }] }
        : r;
    });
    const result = only(invalidRunStats(degraded));
    expect([result.invalid, result.scheduled, result.verdict]).toEqual([
      AT_BUDGET + 1,
      W,
      'over-invalid-budget',
    ]);
  });
});
