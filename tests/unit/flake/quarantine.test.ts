import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAKE_LIMITS } from '../../../src/shared/criteria.ts';
import {
  catalogFacts,
  dayNumber,
  expiredEntries,
  findQuarantine,
  isQuarantined,
  loadQuarantine,
  parseQuarantineText,
  QUARANTINE_FILE,
  readQuarantine,
  utcDay,
  validateQuarantine,
} from '../../../flake/quarantine.ts';
import type { QuarantineEntry } from '../../../flake/quarantine.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { makeScratch } from '../support/scratch.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const facts = catalogFacts(parseCatalog(readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8')));
const TODAY = '2026-11-03';

function addDays(day: string, n: number): string {
  const base = dayNumber(day) as number;
  return new Date((base + n) * 86_400_000).toISOString().slice(0, 10);
}

/** PB-VOD-007 is a merge-tier test that runs in every engine and the throttled project; PB-VOD-008 is release-tier. */
const MERGE_ID = 'PB-VOD-007';
const RELEASE_ID = 'PB-VOD-008';

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    id: MERGE_ID,
    reason: 'failed and passed on the same commit in run 123 and run 124',
    owner: '@hanniavalera',
    since: TODAY,
    expires: addDays(TODAY, FLAKE_LIMITS.mergeQuarantineMaxAgeDays),
    evidence: 'https://example.invalid/issues/42',
    ...overrides,
  };
}

const problemsOf = (entries: QuarantineEntry[], today = TODAY): string[] =>
  validateQuarantine(entries, { catalog: facts, today });

describe('PB-LAB-004 the quarantine file: its shape', () => {
  it('reads an entry with every field, with and without a project', () => {
    const read = readQuarantine({
      schemaVersion: 1,
      entries: [entry(), entry({ id: RELEASE_ID, project: 'webkit' })],
    });
    expect(read.problems).toEqual([]);
    expect(read.entries.map((e) => [e.id, e.project])).toEqual([
      [MERGE_ID, undefined],
      [RELEASE_ID, 'webkit'],
    ]);
  });

  it('accepts the empty list: nothing quarantined is the honest state', () => {
    expect(readQuarantine({ schemaVersion: 1, entries: [] })).toEqual({ entries: [], problems: [] });
  });

  it.each(['id', 'reason', 'owner', 'since', 'expires', 'evidence'] as const)(
    'refuses an entry without %s, and one where it is empty',
    (field) => {
      const missing: Record<string, unknown> = { ...entry() };
      delete missing[field];
      expect(readQuarantine({ schemaVersion: 1, entries: [missing] }).problems.join('\n')).toMatch(
        new RegExp(`"${field}" is missing`),
      );
      for (const empty of ['', '   ', 7, null]) {
        const read = readQuarantine({ schemaVersion: 1, entries: [{ ...entry(), [field]: empty }] });
        expect(read.problems.join('\n'), `${field}=${String(empty)}`).toMatch(new RegExp(`"${field}"`));
        expect(read.entries).toEqual([]);
      }
    },
  );

  it('refuses keys it does not know, because a misspelt "project" would quarantine a test in every engine', () => {
    const read = readQuarantine({
      schemaVersion: 1,
      entries: [{ ...entry(), projects: 'webkit', expiry: 'x' }],
    });
    expect(read.problems).toEqual([
      `${MERGE_ID}: unknown key "projects" (the keys are id, project, reason, owner, since, expires, evidence)`,
      `${MERGE_ID}: unknown key "expiry" (the keys are id, project, reason, owner, since, expires, evidence)`,
    ]);
    expect(read.entries).toEqual([]);
  });

  it('refuses days that are not real days or not written YYYY-MM-DD', () => {
    for (const day of ['2026-02-30', '2026-2-3', '03/11/2026', '2026-11-03T00:00:00Z', 'tomorrow']) {
      const read = readQuarantine({ schemaVersion: 1, entries: [{ ...entry(), expires: day }] });
      expect(read.problems.join('\n'), day).toMatch(/"expires" must be a real day written YYYY-MM-DD/);
    }
    expect(dayNumber('2028-02-29')).not.toBeNull();
    expect(dayNumber('2027-02-29')).toBeNull();
  });

  it('refuses a file of the wrong shape, a version it does not know and keys at the top that it does not know', () => {
    expect(readQuarantine([]).problems[0]).toMatch(/expected an object with "schemaVersion" and "entries"/);
    expect(readQuarantine({ schemaVersion: 2, entries: [] }).problems[0]).toMatch(
      /"schemaVersion" must be 1, found 2/,
    );
    expect(readQuarantine({ schemaVersion: 1 }).problems[0]).toMatch(/"entries" must be a list/);
    expect(readQuarantine({ schemaVersion: 1, entries: [], note: 'x' }).problems).toEqual([
      'flake/quarantine.json: unknown key "note"',
    ]);
    expect(readQuarantine({ schemaVersion: 1, entries: ['PB-VOD-001'] }).problems[0]).toMatch(
      /entries\[0\] must be an object/,
    );
  });

  it('reports every bad entry, keeps the good ones, and names each entry by its id', () => {
    const read = readQuarantine({
      schemaVersion: 1,
      entries: [entry({ owner: '' }), entry({ id: RELEASE_ID }), { id: 'PB-VOD-001' }],
    });
    expect(read.entries.map((e) => e.id)).toEqual([RELEASE_ID]);
    expect(read.problems.filter((p) => p.startsWith(`${MERGE_ID}:`))).toHaveLength(1);
    expect(read.problems.filter((p) => p.startsWith('PB-VOD-001:')).length).toBeGreaterThanOrEqual(5);
  });

  it('says what is wrong with a file that is not JSON, and with one that does not exist', () => {
    expect(parseQuarantineText('{ "entries": [', 'q.json').problems[0]).toMatch(/^q\.json: not JSON: /);
    const scratch = makeScratch('flake-quarantine-');
    try {
      const missing = loadQuarantine(join(scratch, 'nope.json'), 'nope.json');
      expect(missing.found).toBe(false);
      expect(missing.problems[0]).toMatch(/nope\.json: the file is missing/);
      const present = join(scratch, 'q.json');
      writeFileSync(present, JSON.stringify({ schemaVersion: 1, entries: [entry()] }));
      expect(loadQuarantine(present)).toMatchObject({ found: true, problems: [], entries: [entry()] });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('PB-LAB-004 the quarantine file: the policy', () => {
  it('knows the catalog: an id that is not a row is refused', () => {
    expect(problemsOf([entry({ id: 'PB-VOD-999' })])).toEqual([
      'PB-VOD-999: not a test of the catalog (TEST_STRATEGY.md section 9); a quarantine names the id of a catalog row',
    ]);
    expect(problemsOf([entry()])).toEqual([]);
  });

  it('allows a project only where the test runs', () => {
    expect(problemsOf([entry({ project: 'chromium-cpu4x' })])).toEqual([]);
    expect(problemsOf([entry({ id: 'PB-VOD-002', project: 'chromium-cpu4x' })])[0]).toMatch(
      /PB-VOD-002: project "chromium-cpu4x" is not an engine this test runs in \(chromium, firefox, webkit\)/,
    );
    expect(problemsOf([entry({ id: 'PB-ENV-002', project: 'chromium' })])[0]).toMatch(/runs in \(none\)/);
    expect(problemsOf([entry({ project: 'webkit-linux' })])[0]).toMatch(
      /project "webkit-linux" is not an engine/,
    );
  });

  it('does not allow a quarantine to start in the future, or to end before it starts', () => {
    expect(problemsOf([entry({ since: addDays(TODAY, 1), expires: addDays(TODAY, 3) })])).toEqual([
      `${MERGE_ID}: since ${addDays(TODAY, 1)} is in the future (today is ${TODAY})`,
    ]);
    expect(problemsOf([entry({ since: TODAY })])).toEqual([]);
    expect(problemsOf([entry({ since: TODAY, expires: addDays(TODAY, -1) })])[0]).toMatch(
      /expires .* is before since/,
    );
    expect(problemsOf([entry({ since: TODAY, expires: TODAY })])).toEqual([]);
  });

  it('limits the age of a merge-tier test to the short maximum and of a release-tier test to the long one', () => {
    const mergeMax = FLAKE_LIMITS.mergeQuarantineMaxAgeDays;
    const releaseMax = FLAKE_LIMITS.quarantineMaxAgeDays;
    expect(mergeMax).toBeLessThan(releaseMax);
    const since = addDays(TODAY, -3);

    expect(problemsOf([entry({ since, expires: addDays(since, mergeMax) })])).toEqual([]);
    expect(problemsOf([entry({ since, expires: addDays(since, mergeMax + 1) })])).toEqual([
      `${MERGE_ID}: expires ${addDays(since, mergeMax + 1)} is ${mergeMax + 1} days after since ${since}; a merge-tier test may be quarantined for at most ${mergeMax} days`,
    ]);

    // The same age that a release-tier test may have is too long for a merge-tier one.
    expect(problemsOf([entry({ id: RELEASE_ID, since, expires: addDays(since, releaseMax) })])).toEqual([]);
    expect(
      problemsOf([entry({ id: RELEASE_ID, since, expires: addDays(since, releaseMax + 1) })])[0],
    ).toMatch(new RegExp(`a release-tier test may be quarantined for at most ${releaseMax} days`));
    expect(problemsOf([entry({ since, expires: addDays(since, releaseMax) })])[0]).toMatch(/merge-tier/);
  });

  it('does not call an expired entry invalid: expiry is the gate`s finding, and it has its own message', () => {
    const old = entry({ since: addDays(TODAY, -30), expires: addDays(TODAY, -23) });
    expect(problemsOf([old])).toEqual([]);
  });

  it('refuses the same test quarantined twice, and an entry for every engine next to one for a single engine', () => {
    expect(problemsOf([entry(), entry()])[0]).toMatch(
      /PB-VOD-007: quarantined twice; one entry per test and engine/,
    );
    expect(problemsOf([entry({ project: 'webkit' }), entry({ project: 'webkit' })])[0]).toMatch(
      /quarantined twice in webkit/,
    );
    expect(problemsOf([entry({ project: 'webkit' }), entry({ project: 'firefox' })])).toEqual([]);
    expect(problemsOf([entry({ project: 'webkit' }), entry()])[0]).toMatch(
      /already quarantined in one engine/,
    );
    expect(problemsOf([entry(), entry({ project: 'webkit' })])[0]).toMatch(
      /already quarantined in every engine/,
    );
  });

  it('refuses a `today` that is not a day, rather than judging against nothing', () => {
    expect(problemsOf([entry()], 'soon')).toEqual(['today "soon" is not a day written YYYY-MM-DD']);
  });

  it('reads the real catalog: tier and engines of the rows the tests use', () => {
    expect(facts.get(MERGE_ID)).toEqual({
      tier: 'merge',
      engines: ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'],
    });
    expect(facts.get(RELEASE_ID)?.tier).toBe('release');
    expect(facts.get('PB-ENV-002')).toEqual({ tier: 'merge', engines: [] });
  });
});

describe('PB-LAB-004 the quarantine list: who is quarantined today, and what has expired', () => {
  const e = entry({ since: '2026-11-03', expires: '2026-11-10', project: 'webkit' });

  it('is valid from the day it starts through the end of the day it expires, and not outside', () => {
    expect(isQuarantined([e], MERGE_ID, 'webkit', '2026-11-02')).toBe(false);
    expect(isQuarantined([e], MERGE_ID, 'webkit', '2026-11-03')).toBe(true);
    expect(isQuarantined([e], MERGE_ID, 'webkit', '2026-11-10')).toBe(true);
    expect(isQuarantined([e], MERGE_ID, 'webkit', '2026-11-11')).toBe(false);
    expect(findQuarantine([e], MERGE_ID, 'webkit', '2026-11-05')).toBe(e);
    expect(findQuarantine([e], MERGE_ID, 'webkit', '2026-11-11')).toBeNull();
  });

  it('applies to the engine of the entry, or to every engine when it names none, and to its test only', () => {
    expect(isQuarantined([e], MERGE_ID, 'chromium', '2026-11-05')).toBe(false);
    expect(isQuarantined([e], 'PB-VOD-006', 'webkit', '2026-11-05')).toBe(false);
    const all = entry({ since: '2026-11-03', expires: '2026-11-10' });
    for (const project of ['chromium', 'firefox', 'webkit', 'chromium-cpu4x']) {
      expect(isQuarantined([all], MERGE_ID, project, '2026-11-05'), project).toBe(true);
    }
    expect(isQuarantined([], MERGE_ID, 'webkit', '2026-11-05')).toBe(false);
  });

  it('says nothing is quarantined on a day that is not a day', () => {
    expect(isQuarantined([e], MERGE_ID, 'webkit', 'soon')).toBe(false);
    expect(expiredEntries([e], 'soon', facts)).toEqual([]);
  });

  it('lists the entries past their expiry from the next day on, with the tier and the days over', () => {
    const release = entry({ id: RELEASE_ID, since: '2026-10-20', expires: '2026-11-02' });
    expect(expiredEntries([e, release], '2026-11-02', facts)).toEqual([]);
    expect(expiredEntries([e, release], '2026-11-03', facts)).toEqual([
      { entry: release, tier: 'release', daysOver: 1 },
    ]);
    // The merge-tier entry is valid through its last day, 2026-11-10, and expired on the 11th.
    expect(expiredEntries([e, release], '2026-11-10', facts).map((x) => x.entry.id)).toEqual([RELEASE_ID]);
    const later = expiredEntries([e, release], '2026-11-14', facts);
    expect(later.map((x) => [x.entry.id, x.tier, x.daysOver])).toEqual([
      [MERGE_ID, 'merge', 4],
      [RELEASE_ID, 'release', 12],
    ]);
    const unknown = entry({ id: 'PB-VOD-999', since: '2026-10-20', expires: '2026-10-21' });
    expect(expiredEntries([unknown], '2026-11-03', facts)[0]?.tier).toBeNull();
  });

  it('takes the day from the clock in UTC', () => {
    expect(utcDay(new Date('2026-11-03T23:59:59.999Z'))).toBe('2026-11-03');
    expect(utcDay(new Date('2026-11-04T00:00:00.000Z'))).toBe('2026-11-04');
    expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('PB-LAB-004 the committed quarantine list', () => {
  it('is well formed and every entry in it is a real test, within its age', () => {
    const loaded = loadQuarantine(join(ROOT, QUARANTINE_FILE));
    expect(loaded.found).toBe(true);
    expect(loaded.problems).toEqual([]);
    expect(validateQuarantine(loaded.entries, { catalog: facts, today: utcDay() })).toEqual([]);
  });
});
