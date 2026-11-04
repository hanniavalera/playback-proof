import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../../../tools/catalog.ts';
import { analyseSpecs, findSpecFiles } from '../../../tools/check-specs.ts';

// The readiness spec is traced to the catalog by the same checker the static gate runs (`npm run specs:check`): every id has a spec, once,
// under the lane its row names, with the tags its row asks for, plus the content tags the spec chose. Run here on the real catalog and the
// real file, so that a spec that would fail the gate fails this test first, without a browser.

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rows = parseCatalog(readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8'));
const files = findSpecFiles(ROOT).filter((file) => file.path.startsWith('tests/live/'));

describe('tests/live/readiness.spec.ts against the catalog', () => {
  const report = analyseSpecs(files, rows);

  it('has no traceability problem', () => {
    expect(report.problems).toEqual([]);
  });

  it('covers PB-RDY-001 to PB-RDY-005, one test each, tagged for the release tier and the live lane', () => {
    const readiness = report.tests.filter((test) => test.file === 'tests/live/readiness.spec.ts');
    expect(readiness.map((test) => test.id)).toEqual([
      'PB-RDY-001',
      'PB-RDY-002',
      'PB-RDY-003',
      'PB-RDY-004',
      'PB-RDY-005',
    ]);
    for (const test of readiness) {
      const name = test.id ?? test.title;
      expect(test.tags, name).toEqual(expect.arrayContaining(['@release', '@live']));
      expect(test.tags, name).not.toContain('@merge');
      expect(test.tags, name).not.toContain('@cpu');
    }
    expect(readiness.find((test) => test.id === 'PB-RDY-005')?.tags).toContain('@soak');
  });

  it('answers to the rows of the live lane that the catalog lists for the readiness area', () => {
    const rdy = rows.filter((row) => row.area === 'RDY');
    expect(rdy.map((row) => row.id)).toEqual([
      'PB-RDY-001',
      'PB-RDY-002',
      'PB-RDY-003',
      'PB-RDY-004',
      'PB-RDY-005',
    ]);
    expect(rdy.every((row) => row.runsIn === 'live' && row.tier === 'release')).toBe(true);
  });
});
