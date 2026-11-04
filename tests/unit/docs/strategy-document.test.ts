import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GATE_LIMITS } from '../../../src/shared/criteria.ts';
import { PROFILE_DEFINITIONS, PROFILE_FACTORIES, PROFILE_NAMES } from '../../../src/shared/profiles.ts';
import { CATALOG_AREAS, expandEngines, parseCatalog } from '../../../tools/catalog.ts';
import { checkStrategyDocument } from '../../../tools/check-docs.ts';

const STRATEGY = readFileSync(new URL('../../../TEST_STRATEGY.md', import.meta.url), 'utf8');
const rows = parseCatalog(STRATEGY);

/** The document with one catalog line changed. */
function withRow(id: string, change: (line: string) => string): string {
  const lines = STRATEGY.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  expect(at, `${id} is in the document`).toBeGreaterThan(-1);
  lines[at] = change(lines[at] ?? '');
  return lines.join('\n');
}
const problemsOf = (doc: string): string => checkStrategyDocument(doc).problems.join('\n');

describe('PB-LAB-006 the real TEST_STRATEGY.md passes every check', () => {
  it('has no problem: catalog, tier rule, ranking, budgets, generated blocks and cited ids', () => {
    expect(checkStrategyDocument(STRATEGY).problems).toStrictEqual([]);
  });

  it('has the fourteen sections of the brief, in order', () => {
    const numbers = [...STRATEGY.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toStrictEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('never silently drops an area: every area has rows and every area is in the legend', () => {
    for (const code of Object.keys(CATALOG_AREAS)) {
      expect(
        rows.some((r) => r.area === code),
        code,
      ).toBe(true);
      expect(STRATEGY).toContain(`| \`${code}\` |`);
    }
  });

  it('gives every row a concrete decision that agrees with its tier', () => {
    for (const row of rows) {
      expect(row.failureMeans.length, row.id).toBeGreaterThan(60);
      if (row.runsIn === 'live') expect(row.failureMeans, row.id).toMatch(/No-go/);
      else if (row.runsIn === 'ab')
        expect(row.failureMeans, row.id).toMatch(/No A\/B verdict is published|do not ship B/);
      else expect(row.failureMeans, row.id).toContain(`Blocks the ${row.tier}`);
    }
  });

  it('keeps the merge tier within the ceiling in every engine, and no engine without one', () => {
    for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
      const merge = rows.filter(
        (r) => r.runsIn === 'e2e' && r.tier === 'merge' && expandEngines(r.engines).includes(engine),
      );
      expect(merge.length, engine).toBeGreaterThan(0);
      expect(merge.length, engine).toBeLessThanOrEqual(GATE_LIMITS.maxMergeTestsPerEngine);
    }
  });

  it('marks as stretch only the encrypted-media row', () => {
    expect(rows.filter((r) => r.stretch).map((r) => r.id)).toStrictEqual(['PB-EME-001']);
  });

  it('ties every fault profile to catalog rows that exist and use a lane that runs against the service', () => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const users = [
      ...PROFILE_NAMES.map((n) => [n, PROFILE_DEFINITIONS[n].usedBy] as const),
      ...PROFILE_FACTORIES.map((f) => [f.signature, f.usedBy] as const),
    ];
    for (const [name, ids] of users) {
      for (const id of ids) {
        const row = byId.get(id);
        expect(row, `${name} is used by ${id}`).toBeDefined();
        expect(row?.runsIn, `${name} / ${id}`).not.toBe('unit');
      }
    }
  });

  it('names in the catalog only fault profiles that exist', () => {
    const profileLike =
      /`((?:clean|constrained-\d+|bandwidth-drop|high-latency|flaky-segments|transient-404|slow-segment|rung-outage|truncated-segment|manifest-down|segments-down))`/g;
    const known = new Set<string>(PROFILE_NAMES);
    for (const row of rows) {
      for (const m of row.scenario.matchAll(profileLike))
        expect(known.has(m[1] ?? ''), `${row.id}: ${m[1]}`).toBe(true);
    }
    // Conversely, a profile cited in a scenario is cited by the profile's own usedBy list.
    for (const row of rows) {
      for (const m of row.scenario.matchAll(profileLike)) {
        const name = m[1] as (typeof PROFILE_NAMES)[number];
        expect(PROFILE_DEFINITIONS[name].usedBy, `${row.id} cites ${name}`).toContain(row.id);
      }
    }
  });
});

describe('PB-LAB-006 the checks fire on the real document', () => {
  it('refuses a tier that contradicts the risk, in the catalog and in the ranking', () => {
    const doc = withRow('PB-VOD-001', (l) => l.replace('| merge |', '| release |'));
    const problems = problemsOf(doc);
    expect(problems).toMatch(/PB-VOD-001\): tier release contradicts the tiering rule, which gives merge/);
    // The area also holds PB-VOD-002, still merge, so it is now both.
    expect(problems).toMatch(
      /gate "merge" but its rows are merge and release: it should say "merge\+release"/,
    );
    // And the merge budget table, which is computed from the catalog, no longer matches the document.
    expect(problems).toMatch(/generated block MERGE_BUDGET is out of date/);
  });

  it('refuses a risk that does not multiply out', () => {
    expect(problemsOf(withRow('PB-VOD-001', (l) => l.replace('3x5=15', '3x5=14')))).toMatch(
      /does not multiply out: 3 x 5 is 15, not 14/,
    );
  });

  it('refuses to lose an area, and the ranking notices the id that disappeared', () => {
    const doc = STRATEGY.split('\n')
      .filter((l) => !l.startsWith('| PB-EME-001 |'))
      .join('\n');
    const problems = problemsOf(doc);
    expect(problems).toMatch(/area EME has no catalog row/);
    expect(problems).toMatch(/PB-EME-001 is not in the test catalog/);
  });

  it('refuses a catalog row that no ranked area explains', () => {
    const extra =
      '| PB-VOD-099 | VOD | A new scenario | 3x4=12 | release | all | e2e | Blocks the release: look at the trace first, then the log. |';
    const doc = STRATEGY.replace('<!-- END:TEST_CATALOG -->', `${extra}\n<!-- END:TEST_CATALOG -->`);
    expect(problemsOf(doc)).toMatch(/PB-VOD-099 \(catalog line \d+\) appears in no area of the risk ranking/);
  });

  it('refuses a merge tier that outgrows its ceiling', () => {
    const copies = Array.from({ length: 20 }, (_, i) => {
      const id = `PB-VOD-1${String(i).padStart(2, '0')}`;
      return `| ${id} | VOD | A merge-tier copy ${i} | 4x4=16 | merge | all | e2e | Blocks the merge: a copy used to stretch the ceiling in a test. |`;
    }).join('\n');
    const doc = STRATEGY.replace('<!-- END:TEST_CATALOG -->', `${copies}\n<!-- END:TEST_CATALOG -->`);
    // 20 cheap VOD tests fit the time budget, but 15 + 20 is over the ceiling of 30 per engine.
    const problems = problemsOf(doc);
    expect(problems).toMatch(
      /merge chromium: 35 merge-tier browser tests is over the ceiling of 30 per engine/,
    );
    expect(problems).not.toMatch(/over its budget/);
  });

  it('refuses a merge tier that outgrows its time budget', () => {
    // Fourteen slow adaptation tests (28 s each by the estimate) break the 480 s budget at 29 tests, below the ceiling of 30.
    const copies = Array.from({ length: 14 }, (_, i) => {
      const id = `PB-ABR-1${String(i).padStart(2, '0')}`;
      return `| ${id} | ABR | A slow merge-tier copy ${i} | 4x4=16 | merge | all | e2e | Blocks the merge: a copy used to stretch the budget in a test. |`;
    }).join('\n');
    const doc = STRATEGY.replace('<!-- END:TEST_CATALOG -->', `${copies}\n<!-- END:TEST_CATALOG -->`);
    const problems = problemsOf(doc);
    expect(problems).toMatch(/merge chromium: estimated 500 s is over its budget of 480 s \(29 tests\)/);
    expect(problems).not.toMatch(/over the ceiling/);
  });

  it('refuses a generated number that was edited by hand, and says where', () => {
    const doc = STRATEGY.replace('| Latency, p95 | 8,000 ms (8 s) |', '| Latency, p95 | 9,000 ms (9 s) |');
    expect(doc).not.toBe(STRATEGY);
    expect(problemsOf(doc)).toMatch(
      /generated block LIVE_CRITERIA is out of date \(line \d+ of the block: expected "\| Latency, p95 \| 8,000 ms \(8 s\)/,
    );
  });

  it('refuses a generated block whose markers were removed', () => {
    const doc = STRATEGY.replace('<!-- BEGIN:FLAKE_POLICY -->', '');
    expect(problemsOf(doc)).toMatch(/generated block FLAKE_POLICY: expected exactly one/);
  });

  it('refuses a cited test id that does not exist, and a cited risk that differs', () => {
    expect(problemsOf(`${STRATEGY}\nSee also PB-VOD-777.\n`)).toMatch(
      /PB-VOD-777 is not in the test catalog/,
    );
    const doc = STRATEGY.replace('PB-LIVE-001 (4x5=20), PB-RDY-001', 'PB-LIVE-001 (4x4=16), PB-RDY-001');
    expect(problemsOf(doc)).toMatch(/PB-LIVE-001 is cited as 4x4=16 but the catalog says 4x5=20/);
  });

  it('refuses a ranking out of order', () => {
    const doc = STRATEGY.replace(
      '| 4 | Seeking under stress | 5x4=20 |',
      '| 4 | Seeking under stress | 2x2=4 |',
    );
    expect(problemsOf(doc)).toMatch(/ranks below|top risk 2x2=4 but its highest row scores 20/);
  });
});
