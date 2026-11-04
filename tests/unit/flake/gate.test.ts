import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAKE_LIMITS } from '../../../src/shared/criteria.ts';
import { evaluateGate, exitCode, interestingTests, renderGate } from '../../../flake/gate.ts';
import type { GateFailure, GateInput } from '../../../flake/gate.ts';
import { addDays, catalogFacts } from '../../../flake/quarantine.ts';
import type { QuarantineEntry } from '../../../flake/quarantine.ts';
import { percent } from '../../../flake/stats.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { builds, record, run, SIGNATURE_FLAKE } from './fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const facts = catalogFacts(parseCatalog(readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8')));
const TODAY = '2026-11-03';
const W = FLAKE_LIMITS.windowRuns;
const MIN = FLAKE_LIMITS.minRunsToJudge;
const MERGE_DAYS = FLAKE_LIMITS.mergeQuarantineMaxAgeDays;
const RELEASE_DAYS = FLAKE_LIMITS.quarantineMaxAgeDays;

/** PB-VOD-007 is the seventh test of `builds()` (index 6): merge-tier in the catalog. PB-VOD-008 is release-tier there. */
const VOD_007 = 6;

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    id: 'PB-VOD-007',
    reason: 'failed and passed on the same commit in runs 41 and 42',
    owner: '@hanniavalera',
    since: addDays(TODAY, -1),
    expires: addDays(TODAY, MERGE_DAYS - 1),
    evidence: 'https://example.invalid/issues/7',
    ...overrides,
  };
}

function gate(input: Partial<GateInput> & { entries?: QuarantineEntry[] } = {}) {
  const { entries, ...rest } = input;
  return evaluateGate({
    history: [],
    current: [],
    today: TODAY,
    quarantine: { entries: entries ?? [], problems: [] },
    catalog: facts,
    ...rest,
  });
}

/** `count` builds of the webkit job in which PB-VOD-007 flakes in the builds `flakyBuilds` lists; the last build is the current one. */
function webkit(count: number, flakyBuilds: number[], options: { tier?: 'merge' | 'release' } = {}) {
  const all = builds(count, {
    project: 'webkit',
    ...(options.tier ? { tier: options.tier } : {}),
    flaky: (build, test) => test === VOD_007 && flakyBuilds.includes(build),
  });
  return { history: all.slice(0, -1), current: all.slice(-1) };
}

const only = (failures: GateFailure[]): GateFailure => {
  expect(failures).toHaveLength(1);
  return failures[0] as GateFailure;
};

describe('PB-LAB-004 flake gate: a test above the trigger that is not quarantined', () => {
  it('fails, says why with the numbers, and says what to decide, who decides and by when', () => {
    // One flaky outcome in the history and one in the build just recorded: two in a full window.
    const { history, current } = webkit(W, [3, W - 1]);
    const report = gate({ history, current });

    expect(report.pass).toBe(false);
    expect(exitCode(report)).toBe(1);
    const failure = only(report.failures);
    expect(failure.kind).toBe('over-trigger');
    expect(failure.subject).toBe('PB-VOD-007 on webkit');
    expect(failure.message).toContain(
      `PB-VOD-007 on webkit is above the quarantine trigger: 2 flaky of ${W} executions (${percent(2 / W)})`,
    );
    expect(failure.message).toContain(`the trigger is ${percent(FLAKE_LIMITS.quarantineTriggerRate)}`);
    // The last flake, with the cause that the reporter recorded and the run it was in.
    expect(failure.message).toContain(`Last flake: ${SIGNATURE_FLAKE}`);
    expect(failure.message).toContain(`run build-webkit-${W - 1}`);

    expect(failure.decision).toContain('Fix PB-VOD-007 on webkit today, or quarantine it today');
    expect(failure.decision).toContain('the owner of the VOD playback (VOD) area');
    expect(failure.decision).toContain(
      `since ${TODAY} and an expiry no later than ${addDays(TODAY, MERGE_DAYS)}`,
    );
    expect(failure.decision).toContain(`a merge-tier test: at most ${MERGE_DAYS} days`);
    expect(failure.decision).toContain(
      'The gate stays red until one of the two has happened. Do not rerun the job',
    );
  });

  it('gives a release-tier test the longer quarantine in the decision', () => {
    const { history, current } = webkit(W, [3, W - 1], { tier: 'release' });
    const failure = only(gate({ history, current }).failures);
    expect(failure.decision).toContain(
      `no later than ${addDays(TODAY, RELEASE_DAYS)} (a release-tier test: at most ${RELEASE_DAYS} days)`,
    );
  });

  it('counts the build just recorded: one flaky outcome in the history and one now is over the trigger, and the run in the history is not counted twice', () => {
    const { history, current } = webkit(W, [W - 1]);
    expect(gate({ history, current }).failures).toEqual([]);
    const withOld = webkit(W, [2, W - 1]);
    expect(gate(withOld).failures).toHaveLength(1);
    // The same build already recorded in the history: still two flaky outcomes, not three.
    const again = gate({ history: [...withOld.history, ...withOld.current], current: withOld.current });
    expect(again.failures).toHaveLength(1);
    expect(again.tests.find((t) => t.stats.id === 'PB-VOD-007')?.stats.flaky).toBe(2);
    expect(again.runsJudged).toBe(W);
  });

  it('is strict about "above": exactly the trigger passes, one more flaky outcome fails', () => {
    // MIN executions with one flaky outcome is exactly the trigger rate; the precondition says so if the policy moves.
    expect(1 / MIN).toBe(FLAKE_LIMITS.quarantineTriggerRate);
    const at = webkit(MIN, [MIN - 1]);
    const atTrigger = gate(at);
    expect(atTrigger.pass).toBe(true);
    expect(atTrigger.tests.find((t) => t.stats.id === 'PB-VOD-007')?.stats.verdict).toBe('watch');
    const above = webkit(MIN, [4, MIN - 1]);
    expect(only(gate(above).failures).kind).toBe('over-trigger');
  });

  it('judges only what this build ran, and only the history of this environment', () => {
    const old = webkit(W, [3, W - 1]);
    // A build that ran another engine does not fail on the webkit history.
    const chromium = builds(1, { project: 'chromium' });
    const elsewhere = gate({ history: [...old.history, ...old.current], current: chromium });
    expect(elsewhere.pass).toBe(true);
    expect(elsewhere.tests.every((t) => t.stats.project === 'chromium')).toBe(true);

    // A flaky history of another environment is not this environment's.
    const mac = builds(W, { project: 'webkit', envId: 'gha-macos-arm64', flaky: (_b, t) => t === VOD_007 });
    const linux = builds(1, { project: 'webkit', envId: 'gha-linux-x64' });
    const separate = gate({ history: mac, current: linux });
    expect(separate.pass).toBe(true);
    expect(separate.envId).toBe('gha-linux-x64');
    expect(separate.runsJudged).toBe(1);
  });

  it('does not judge a skipped test, and says nothing about a test with too few executions except that it has no verdict', () => {
    const skipped = run([
      record({ id: 'PB-VOD-007', project: 'webkit', outcome: 'skipped', skipReason: 'documented gap' }),
    ]);
    const flakyHistory = webkit(W, [1, 2]).history;
    expect(gate({ history: flakyHistory, current: [skipped] }).failures).toEqual([]);

    const fresh = gate({ current: builds(1, { project: 'webkit', tests: 2 }) });
    expect(fresh.pass).toBe(true);
    expect(fresh.notes).toContain(
      `2 tests of this build have fewer than ${MIN} executions in the window and no verdict yet.`,
    );
  });
});

describe('PB-LAB-004 flake gate: quarantine', () => {
  it('lets a quarantined test through, reports it, and leaves it out of the suite rate', () => {
    const { history, current } = webkit(W, [3, W - 1]);
    const report = gate({ history, current, entries: [entry({ project: 'webkit' })] });
    expect(report.pass).toBe(true);
    expect(report.notes).toContainEqual(
      expect.stringContaining(
        `PB-VOD-007 on webkit is above the trigger (2 flaky of ${W} executions (${percent(2 / W)})) and quarantined until ${addDays(TODAY, MERGE_DAYS - 1)} (owner @hanniavalera)`,
      ),
    );
    const suite = report.suites[0];
    expect(suite?.flaky).toBe(0);
    expect(suite?.quarantinedFlaky).toBe(2);
    expect(report.tests.find((t) => t.stats.id === 'PB-VOD-007')?.quarantine?.owner).toBe('@hanniavalera');
  });

  it('does not let a quarantine of another engine, or of another test, protect it', () => {
    const { history, current } = webkit(W, [3, W - 1]);
    expect(
      gate({ history, current, entries: [entry({ project: 'chromium' })] }).failures.map((f) => f.kind),
    ).toEqual(['over-trigger']);
    expect(
      gate({ history, current, entries: [entry({ id: 'PB-VOD-006' })] }).failures.map((f) => f.kind),
    ).toEqual(['over-trigger']);
  });

  it('counts the executions the quarantined invocation recorded, so the test`s own window is whole', () => {
    const { history, current } = webkit(W - 1, [2]);
    const quarantinedRun = run(
      [record({ id: 'PB-VOD-007', project: 'webkit', outcome: 'flaky', quarantined: true })],
      { runId: 'build-webkit-extra' },
    );
    const report = gate({
      history,
      current: [...current, quarantinedRun],
      entries: [entry({ project: 'webkit' })],
    });
    const t = report.tests.find((x) => x.stats.id === 'PB-VOD-007');
    expect(t?.stats.flaky).toBe(2);
    expect(t?.stats.quarantinedExecutions).toBe(1);
    expect(report.pass).toBe(true);
  });

  it('says that a quarantined test has had its clean window, so that its owner can take it back to the gate', () => {
    const clean = builds(W, { project: 'webkit', quarantined: (_b, t) => t === VOD_007 });
    const report = gate({
      history: clean.slice(0, -1),
      current: clean.slice(-1),
      entries: [entry({ project: 'webkit' })],
    });
    expect(report.pass).toBe(true);
    expect(report.notes.join('\n')).toContain('has had a full clean window');
    expect(report.notes.join('\n')).toContain('@hanniavalera can remove the entry');
  });

  it('fails on an expired quarantine of a release-tier test, with the owner and the decision', () => {
    const expired = entry({ id: 'PB-VOD-008', since: addDays(TODAY, -10), expires: addDays(TODAY, -1) });
    const failure = only(gate({ entries: [expired] }).failures);
    expect(failure.kind).toBe('quarantine-expired');
    expect(failure.subject).toBe('PB-VOD-008');
    expect(failure.message).toBe(
      `The quarantine of PB-VOD-008 expired on ${expired.expires} (1 day ago). Owner: @hanniavalera. Reason given: ${expired.reason}`,
    );
    expect(failure.decision).toContain(
      'Fix PB-VOD-008 and remove the entry from flake/quarantine.json (the test returns to its gate)',
    );
    expect(failure.decision).toContain(
      'retire it by removing its row from the catalog in a pull request that says why',
    );
    expect(failure.decision).toContain('Who: @hanniavalera. By when: now');
  });

  it('says apart that a merge-tier quarantine expired: a hole in the merge gate, fixed or replaced, never renewed', () => {
    const expired = entry({ since: addDays(TODAY, -8), expires: addDays(TODAY, -2) });
    const failure = only(gate({ entries: [expired] }).failures);
    expect(failure.kind).toBe('merge-quarantine-expired');
    expect(failure.message).toContain(
      `The quarantine of the merge-tier test PB-VOD-007 expired on ${expired.expires} (2 days ago)`,
    );
    expect(failure.message).toContain('a hole in the merge gate');
    expect(failure.decision).toContain(
      'replace it with a cheaper, deterministic test of the same risk (assert on the request log rather than on timing)',
    );
    expect(failure.decision).toContain('A merge-tier quarantine is not renewed');
  });

  it('keeps an entry valid through the whole day it expires, and fails from the next day', () => {
    const lastDay = entry({ since: addDays(TODAY, -3), expires: TODAY });
    expect(gate({ entries: [lastDay] }).pass).toBe(true);
    const dayAfter = gate({ entries: [lastDay], today: addDays(TODAY, 1) });
    expect(dayAfter.failures.map((f) => f.kind)).toEqual(['merge-quarantine-expired']);
  });

  it('puts a test back on the gate the day its quarantine expires: both findings are reported', () => {
    const { history, current } = webkit(W, [3, W - 1]);
    const expired = entry({ project: 'webkit', since: addDays(TODAY, -8), expires: addDays(TODAY, -1) });
    const report = gate({ history, current, entries: [expired] });
    expect(report.failures.map((f) => f.kind)).toEqual(['merge-quarantine-expired', 'over-trigger']);
    expect(report.failures[1]?.message).toContain(
      `Its quarantine expired on ${expired.expires}, so it is back on the gate.`,
    );
    // Not quarantined any more, so its flaky executions are in the suite rate again.
    expect(report.suites[0]?.flaky).toBe(2);
  });

  it('fails on a list that is not valid, naming every problem, and does not let an invalid entry protect anything', () => {
    const { history, current } = webkit(W, [3, W - 1]);
    const tooLong = entry({
      project: 'webkit',
      since: addDays(TODAY, -1),
      expires: addDays(TODAY, MERGE_DAYS + 2),
    });
    const report = gate({ history, current, entries: [tooLong, entry({ id: 'PB-VOD-999' })] });
    const kinds = report.failures.map((f) => f.kind);
    expect(kinds).toEqual(['quarantine-invalid', 'quarantine-invalid', 'over-trigger']);
    expect(report.failures[0]?.message).toMatch(
      /The quarantine list is not valid: PB-VOD-007: expires .* a merge-tier test may be quarantined for at most/,
    );
    expect(report.failures[1]?.message).toMatch(/PB-VOD-999: not a test of the catalog/);
    expect(report.failures[0]?.decision).toContain('git log flake/quarantine.json');
    expect(report.failures[0]?.decision).toContain('An entry with a problem quarantines nothing');
    // The over-trigger failure is still there: the invalid entry did not quarantine PB-VOD-007.
    expect(report.failures[2]?.subject).toBe('PB-VOD-007 on webkit');
  });

  it('fails on the problems of the file itself: the shape, a missing file', () => {
    const shape = evaluateGate({
      history: [],
      current: [],
      today: TODAY,
      quarantine: { entries: [], problems: ['PB-VOD-001: "owner" must be a non-empty string'] },
      catalog: facts,
    });
    expect(only(shape.failures).message).toBe(
      'The quarantine list is not valid: PB-VOD-001: "owner" must be a non-empty string',
    );
    const missing = evaluateGate({
      history: [],
      current: [],
      today: TODAY,
      quarantine: {
        entries: [],
        problems: [
          'flake/quarantine.json: the file is missing; it is the list of record, commit it (empty if nothing is quarantined)',
        ],
      },
      catalog: facts,
    });
    expect(only(missing.failures).kind).toBe('quarantine-invalid');
  });
});

describe('PB-LAB-004 flake gate: the suite budget of an engine job', () => {
  /** Three tests that flake in a tenth or more of the window each, in a job of fifteen: three offenders and a suite over its budget. */
  const offenders = builds(W, {
    project: 'chromium',
    flaky: (build, test) => test < 3 && build < 4,
  });
  const split = { history: offenders.slice(0, -1), current: offenders.slice(-1) };

  it('fails when the suite is over the budget, names the tests behind it and says where to look first', () => {
    const report = gate({ ...split });
    const suite = report.failures.find((f) => f.kind === 'suite-budget');
    expect(suite).toBeDefined();
    const flaky = 3 * 4;
    expect(suite?.message).toContain(
      `The suite flake rate of the chromium engine job is above its budget: ${flaky} flaky of ${W * 15} executions (${percent(flaky / (W * 15))}) over the last ${W} builds, the budget is ${percent(FLAKE_LIMITS.suiteBudgetRate)}`,
    );
    expect(suite?.message).toContain('PB-VOD-001 (4 of 30), PB-VOD-002 (4 of 30), PB-VOD-003 (4 of 30)');
    expect(suite?.decision).toContain('Look at the environment first');
    expect(suite?.decision).toContain('a quarantined test leaves the suite rate, the old executions with it');
    expect(suite?.decision).toContain('The gate stays red until the rate is within the budget');
    // The three offenders are over the trigger on their own, too.
    expect(report.failures.filter((f) => f.kind === 'over-trigger').map((f) => f.subject)).toEqual([
      'PB-VOD-001 on chromium',
      'PB-VOD-002 on chromium',
      'PB-VOD-003 on chromium',
    ]);
  });

  it('is green again when the offenders are quarantined: the way out the policy promises', () => {
    const entries = ['PB-VOD-001', 'PB-VOD-002', 'PB-VOD-003'].map((id) =>
      entry({ id, project: 'chromium', expires: addDays(TODAY, 3) }),
    );
    const report = gate({ ...split, entries });
    expect(report.failures).toEqual([]);
    expect(report.suites[0]).toMatchObject({
      flaky: 0,
      executions: W * 12,
      quarantinedExecutions: W * 3,
      verdict: 'ok',
    });
    expect(report.suites[0]?.quarantinedFlaky).toBe(12);
  });

  it('fails on flakiness spread thin over many tests, which no test`s own rate shows', () => {
    const spread = builds(W, { project: 'chromium', flaky: (build, test) => build === test && test < 14 });
    const report = gate({ history: spread.slice(0, -1), current: spread.slice(-1) });
    expect(report.failures.map((f) => f.kind)).toEqual(['suite-budget']);
    expect(report.tests.every((t) => t.stats.verdict !== 'over-trigger')).toBe(true);
  });

  it('does not judge an engine job that has fewer builds than the minimum, and says so', () => {
    const young = builds(MIN - 1, { project: 'chromium', flaky: (_b, test) => test < 3 });
    const report = gate({ history: young.slice(0, -1), current: young.slice(-1) });
    expect(report.failures).toEqual([]);
    expect(report.notes.join('\n')).toContain(
      `chromium: the suite flake rate is not judged yet: ${MIN - 1} of the ${MIN} builds it needs`,
    );
  });

  it('is judged per engine job: a flaky firefox does not fail a green chromium build', () => {
    const firefox = builds(W, { project: 'firefox', flaky: (_b, test) => test < 5 });
    const chromium = builds(1, { project: 'chromium' });
    const report = gate({ history: firefox, current: chromium });
    expect(report.pass).toBe(true);
    expect(report.suites.map((s) => s.project)).toEqual(['chromium']);
  });
});

describe('PB-LAB-004 flake gate: what it prints', () => {
  it('prints the verdict, the engine job table, the tests that matter and each failure with its decision', () => {
    const { history, current } = webkit(W, [3, W - 1]);
    const text = renderGate(gate({ history, current }));
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      `flake gate: FAIL (1 failure)  [gha-linux-x64, ${TODAY}, 1 run in this build, ${W} runs judged]`,
    );
    expect(text).toContain(
      '| engine job | builds | executions | flaky | rate | budget | verdict | left out (quarantined) |',
    );
    expect(text).toContain(
      `| webkit | ${W} | ${W * 15} | 2 | ${percent(2 / (W * 15))} | ${percent(FLAKE_LIMITS.suiteBudgetRate)} | ok | 0 |`,
    );
    expect(text).toContain(`| PB-VOD-007 | webkit | ${W} | 2 | 0 | ${percent(2 / W)} | over-trigger | no |`);
    expect(text).toContain('Failures, and the decision each one drives');
    expect(text).toContain('1. [over-trigger] PB-VOD-007 on webkit is above the quarantine trigger');
    expect(text).toContain('   Decision: Fix PB-VOD-007 on webkit today, or quarantine it today.');
    // Fourteen healthy tests are counted, not listed.
    expect(text).toContain('14 with no flaky outcome are not listed');
  });

  it('prints a pass in one line and the table of a quarantined test with its owner and expiry', () => {
    expect(renderGate(gate({ current: builds(1, { project: 'chromium' }) })).split('\n')[0]).toBe(
      `flake gate: PASS  [gha-linux-x64, ${TODAY}, 1 run in this build, 1 run judged]`,
    );
    const { history, current } = webkit(W, [3, W - 1]);
    const text = renderGate(gate({ history, current, entries: [entry({ project: 'webkit' })] }));
    expect(text).toContain(`| over-trigger | until ${addDays(TODAY, MERGE_DAYS - 1)} (@hanniavalera) |`);
    expect(text).toContain('Notes');
  });

  it('lists as interesting the tests that are not plainly ok, quarantined ones included', () => {
    const { history, current } = webkit(W, [3]);
    const report = gate({ history, current });
    expect(interestingTests(report).map((t) => `${t.stats.id}:${t.stats.verdict}`)).toEqual([
      'PB-VOD-007:watch',
    ]);
  });

  it('marks an experimental engine job', () => {
    const experimental = builds(1, { project: 'webkit' }).map((r) => ({
      ...r,
      tests: r.tests.map((t) => ({ ...t, experimental: true as const })),
    }));
    expect(renderGate(gate({ current: experimental }))).toContain('| webkit (experimental) |');
  });
});
