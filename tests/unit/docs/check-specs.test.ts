import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AreaCode, CatalogRow, EngineToken } from '../../../tools/catalog.ts';
import { analyseSpecs, findSpecFiles, parseSpecSource, renderReport } from '../../../tools/check-specs.ts';
import { makeScratch } from '../support/scratch.ts';

// The checker reads specs with the TypeScript compiler API; these are small invented specs, one thing wrong at a time.

let nextLine = 100;
function row(id: string, overrides: Partial<CatalogRow> = {}): CatalogRow {
  return {
    id,
    area: id.split('-')[1] as AreaCode,
    scenario: 'a scenario',
    risk: { likelihood: 3, impact: 5, score: 15, text: '3x5=15' },
    tier: 'merge',
    engines: ['all'] as EngineToken[],
    runsIn: 'e2e',
    failureMeans: 'x',
    stretch: false,
    line: (nextLine += 1),
    ...overrides,
  };
}

const CATALOG: CatalogRow[] = [
  row('PB-VOD-001', { engines: ['all', 'chromium-cpu4x'] }),
  row('PB-VOD-002'),
  row('PB-VOD-003', { tier: 'release' }),
  row('PB-ENV-001'),
  row('PB-ENV-002', { runsIn: 'unit', engines: ['none'] }),
  row('PB-PERF-001', { runsIn: 'perf' }),
  row('PB-EME-001', { tier: 'release', engines: ['chromium', 'firefox'], stretch: true }),
];

const spec = (body: string, path = 'tests/e2e/a.spec.ts') => ({
  path,
  source: `import { test } from './support/fixtures.ts';\n${body}\n`,
});
const analyse = (files: ReturnType<typeof spec>[], options: { complete?: boolean } = {}) =>
  analyseSpecs(files, CATALOG, options);

describe('PB-LAB-006 spec traceability: reading specs from the syntax tree', () => {
  it('finds a test, its id, its line and its tags, whatever the formatting', () => {
    const { tests, problems } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      [
        "import { test } from './support/fixtures.ts';",
        '',
        'test(',
        "  'PB-VOD-001 starts',",
        "  { tag: ['@merge', '@cpu', '@dash'] },",
        '  async ({ player }) => {},',
        ');',
        "test('PB-VOD-002 starts over HLS', { tag: '@merge' }, async () => {});",
        "test('PB-VOD-003 no options', async () => {});",
      ].join('\n'),
    );
    expect(problems).toStrictEqual([]);
    expect(tests.map((t) => [t.id, t.line, t.tags])).toStrictEqual([
      ['PB-VOD-001', 3, ['@merge', '@cpu', '@dash']],
      ['PB-VOD-002', 8, ['@merge']],
      ['PB-VOD-003', 9, []],
    ]);
  });

  it('is not fooled by comments or strings that look like tests, and ignores test.step, test.use and conditional skips', () => {
    const { tests } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      [
        "// test('PB-VOD-009 in a comment', { tag: '@merge' }, async () => {});",
        'const text = "test(\'PB-VOD-008 in a string\', async () => {})";',
        'test.use({ viewport: { width: 100, height: 100 } });',
        'test.beforeEach(async ({ browserName }) => {',
        "  test.skip(browserName === 'webkit', 'a reason');",
        "  test.skip(({ browserName }) => browserName === 'firefox', 'another');",
        "  await test.step('PB-VOD-007 a step is not a test', async () => {});",
        '});',
        "test('PB-VOD-001 real', { tag: '@merge' }, async () => {});",
      ].join('\n'),
    );
    expect(tests.map((t) => t.id)).toStrictEqual(['PB-VOD-001']);
  });

  it('inherits the tags of test.describe, nested, and reads the @words of a title', () => {
    const { tests } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      [
        "test.describe('group', { tag: '@merge' }, () => {",
        "  test.describe('inner', { tag: ['@hls'] }, () => {",
        "    test('PB-VOD-002 in a group', { tag: '@cpu' }, async () => {});",
        '  });',
        "  test('PB-VOD-001 @dash in the title', async () => {});",
        '});',
        "test.describe.serial('serial', () => { test('PB-ENV-001 serial', async () => {}); });",
      ].join('\n'),
    );
    expect(tests.map((t) => [t.id, t.tags])).toStrictEqual([
      ['PB-VOD-002', ['@merge', '@hls', '@cpu']],
      ['PB-VOD-001', ['@merge', '@dash']],
      ['PB-ENV-001', []],
    ]);
  });

  it('records skip, fixme and only as modifiers, and finds tests inside loops and helpers', () => {
    const { tests } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      [
        "test.skip('PB-VOD-001 skipped', async () => {});",
        "test.fixme('PB-VOD-002 broken', { tag: '@merge' }, async () => {});",
        "test.only('PB-VOD-003 only', async () => {});",
        "for (const x of [1]) { test('PB-ENV-001 in a loop', async () => {}); }",
        "function defineMore() { test('PB-EME-001 in a function', async () => {}); }",
      ].join('\n'),
    );
    expect(tests.map((t) => [t.id, t.modifier])).toStrictEqual([
      ['PB-VOD-001', 'skip'],
      ['PB-VOD-002', 'fixme'],
      ['PB-VOD-003', 'only'],
      ['PB-ENV-001', null],
      ['PB-EME-001', null],
    ]);
  });

  it('reads an id only at the start of the title, and never from the middle', () => {
    const { tests } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      [
        "test('starts like PB-VOD-001 but is not', async () => {});",
        "test('PB-VOD-0011 four digits', async () => {});",
        "test('PB-VOD-001: with a colon', async () => {});",
      ].join('\n'),
    );
    expect(tests.map((t) => t.id)).toStrictEqual([null, null, 'PB-VOD-001']);
  });

  it.each([
    [
      'a title that is computed',
      'const id = "PB-VOD-001"; test(`${id} starts`, async () => {});',
      /not a plain string/,
    ],
    [
      'a title with a substitution',
      'const n = 1; test(`PB-VOD-001 round ${n}`, async () => {});',
      /not a plain string/,
    ],
    [
      'tags in a variable',
      "const tags = ['@merge']; test('PB-VOD-001 x', { tag: tags }, async () => {});",
      /string literal or an array of string literals/,
    ],
    [
      'a spread in the options',
      "const base = {}; test('PB-VOD-001 x', { ...base, tag: '@merge' }, async () => {});",
      /contain a spread/,
    ],
    [
      'options that are not an object literal',
      "const options = { tag: '@merge' }; test('PB-VOD-001 x', options, async () => {});",
      /not an object literal/,
    ],
  ])('says so when it cannot read %s from source', (_label, body, message) => {
    const { problems } = parseSpecSource('tests/e2e/a.spec.ts', body);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^tests\/e2e\/a\.spec\.ts:1: /);
    expect(problems[0]).toMatch(message);
  });

  it('reports a file that does not parse instead of crashing', () => {
    const { tests, problems } = parseSpecSource(
      'tests/e2e/a.spec.ts',
      "test('PB-VOD-001 x', { tag: '@merge' }, async () => {",
    );
    expect(tests).toStrictEqual([]);
    expect(problems[0]).toMatch(/^tests\/e2e\/a\.spec\.ts: cannot be parsed/);
  });
});

describe('PB-LAB-006 spec traceability: specs against the catalog', () => {
  const good = spec(
    [
      "test('PB-VOD-001 starts', { tag: ['@merge', '@cpu'] }, async () => {});",
      "test('PB-VOD-002 starts over HLS', { tag: ['@merge', '@hls'] }, async () => {});",
      "test('PB-VOD-003 plays to the end', { tag: '@release' }, async () => {});",
    ].join('\n'),
  );

  it('accepts specs whose ids and tags are what the catalog says, extra content tags included', () => {
    const report = analyse([good]);
    expect(report.problems).toStrictEqual([]);
    expect(report.tests).toHaveLength(3);
  });

  it('refuses an id that is not in the catalog', () => {
    const { problems } = analyse([spec("test('PB-VOD-099 invented', { tag: '@merge' }, async () => {});")]);
    expect(problems).toStrictEqual([
      'tests/e2e/a.spec.ts:2: PB-VOD-099 is not in the catalog (TEST_STRATEGY.md section 9)',
    ]);
  });

  it('refuses a title that does not start with an id', () => {
    const { problems } = analyse([spec("test('starts and plays', { tag: '@merge' }, async () => {});")]);
    expect(problems).toStrictEqual([
      'tests/e2e/a.spec.ts:2: the title "starts and plays" does not start with a catalog id (PB-AREA-NNN)',
    ]);
  });

  it('refuses an id declared twice, in one file or in two, and says where the first one is', () => {
    const twice = spec(
      [
        "test('PB-VOD-002 once', { tag: '@merge' }, async () => {});",
        "test('PB-VOD-002 twice', { tag: '@merge' }, async () => {});",
      ].join('\n'),
    );
    expect(analyse([twice]).problems).toStrictEqual([
      'tests/e2e/a.spec.ts:3: PB-VOD-002 is declared again; its first declaration is at tests/e2e/a.spec.ts:2',
    ]);
    const other = spec(
      "test('PB-VOD-002 elsewhere', { tag: '@merge' }, async () => {});",
      'tests/e2e/b.spec.ts',
    );
    const { problems } = analyse([good, other]);
    expect(problems).toStrictEqual([
      'tests/e2e/b.spec.ts:2: PB-VOD-002 is declared again; its first declaration is at tests/e2e/a.spec.ts:3',
    ]);
  });

  it.each([
    [
      'a merge test without @merge',
      "{ tag: '@release' }",
      'PB-VOD-002',
      ['missing @merge (tier merge)', 'unexpected @release (tier merge is not release)'],
    ],
    ['a merge test without any tag', '{}', 'PB-VOD-002', ['missing @merge (tier merge)']],
    [
      'a release test with @merge',
      "{ tag: ['@release', '@merge'] }",
      'PB-VOD-003',
      ['unexpected @merge (tier release is not merge)'],
    ],
    [
      'a release test without @release',
      "{ tag: '@cpu' }",
      'PB-VOD-003',
      ['missing @release (tier release)', 'unexpected @cpu'],
    ],
    [
      'a test that must run throttled but has no @cpu',
      "{ tag: '@merge' }",
      'PB-VOD-001',
      ['missing @cpu (the engines include chromium-cpu4x)'],
    ],
    [
      'a test that has @cpu but is not in the throttled project',
      "{ tag: ['@merge', '@cpu'] }",
      'PB-VOD-002',
      ['unexpected @cpu (the engines (all) do not include chromium-cpu4x)'],
    ],
  ])('refuses %s', (_label, options, id, complaints) => {
    const { problems } = analyse([spec(`test('${id} x', ${options}, async () => {});`)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${id} tags disagree with the catalog`);
    for (const complaint of complaints) expect(problems[0]).toContain(complaint);
  });

  it('refuses a tag nobody defined: a typo would otherwise drop the test out of every gate', () => {
    const { problems } = analyse([
      spec("test('PB-VOD-002 x', { tag: ['@merge', '@mrege'] }, async () => {});"),
    ]);
    expect(problems).toStrictEqual([expect.stringContaining('unknown tag @mrege')]);
  });

  it('refuses a spec for a row of another lane, and test.only', () => {
    const { problems } = analyse([
      spec("test('PB-PERF-001 not a browser test', { tag: '@merge' }, async () => {});"),
      spec("test.only('PB-VOD-002 focused', { tag: '@merge' }, async () => {});", 'tests/e2e/b.spec.ts'),
    ]);
    expect(problems).toStrictEqual([
      expect.stringContaining('PB-PERF-001 runs in lane "perf"'),
      expect.stringContaining('test.only must not be committed'),
    ]);
  });

  it('lists skipped and fixme tests, which still count as specs', () => {
    const report = analyse([spec("test.fixme('PB-VOD-002 later', { tag: '@merge' }, async () => {});")]);
    expect(report.problems).toStrictEqual([]);
    expect(report.disabled).toStrictEqual(['tests/e2e/a.spec.ts:2: PB-VOD-002 is declared with test.fixme']);
    expect(report.areas.find((a) => a.area === 'VOD')?.specs).toBe(1);
  });
});

describe('PB-LAB-006 spec traceability: which rows have no spec', () => {
  const some = spec("test('PB-VOD-002 starts over HLS', { tag: '@merge' }, async () => {});");

  it('lists the missing rows of lane e2e per area, and is not an error by default (specs arrive over several branches)', () => {
    const report = analyse([some]);
    expect(report.problems).toStrictEqual([]);
    expect(report.missing).toStrictEqual(['PB-VOD-001', 'PB-VOD-003', 'PB-ENV-001']);
    expect(report.missingStretch).toStrictEqual(['PB-EME-001']);
    expect(report.areas.find((a) => a.area === 'VOD')).toStrictEqual({
      area: 'VOD',
      rows: 3,
      e2eRows: 3,
      specs: 1,
      missing: ['PB-VOD-001', 'PB-VOD-003'],
    });
  });

  it('is an error with --complete, except for stretch rows and rows of another lane', () => {
    const { problems } = analyse([some], { complete: true });
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('PB-VOD-001 (lane e2e) has no spec under tests/e2e');
    expect(problems.join('\n')).not.toContain('PB-EME-001');
    expect(problems.join('\n')).not.toContain('PB-ENV-002');
    expect(problems.join('\n')).not.toContain('PB-PERF-001');
  });

  it('passes --complete when every row of lane e2e has its spec', () => {
    const all = spec(
      [
        "test('PB-VOD-001 a', { tag: ['@merge', '@cpu'] }, async () => {});",
        "test('PB-VOD-002 b', { tag: '@merge' }, async () => {});",
        "test('PB-VOD-003 c', { tag: '@release' }, async () => {});",
        "test('PB-ENV-001 d', { tag: '@merge' }, async () => {});",
      ].join('\n'),
    );
    expect(analyse([all], { complete: true }).problems).toStrictEqual([]);
  });

  it('prints the table the way a person reads it', () => {
    const text = renderReport(analyse([some]));
    expect(text).toBe(
      [
        'specs:check: 1 test in 1 spec file, 7 catalog rows (5 in lane e2e)',
        '',
        'Area  Rows  e2e rows  Specs  Missing',
        '----  ----  --------  -----  -------',
        'VOD      3         3      1        2',
        'ENV      2         1      0        1',
        'PERF     1         0      0        0',
        'EME      1         1      0        1',
        'all      7         5      1        4',
        '',
        'Not written yet (lane e2e; `--complete` makes this an error):',
        '  VOD: PB-VOD-001 PB-VOD-003',
        '  ENV: PB-ENV-001',
        '  EME: PB-EME-001',
        '  (stretch rows never fail the check: PB-EME-001)',
      ].join('\n'),
    );
  });
});

describe('PB-LAB-006 spec traceability: finding the spec files', () => {
  let root: string;
  beforeEach(() => {
    root = makeScratch('check-specs-');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads *.spec.ts under tests/e2e and tests/live only, with paths relative to the root', () => {
    for (const directory of ['tests/e2e/support', 'tests/live', 'tests/unit', 'perf'])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, 'tests/e2e/b.spec.ts'), "test('PB-VOD-001 x', async () => {});");
    writeFileSync(join(root, 'tests/e2e/a.spec.ts'), "test('PB-VOD-002 x', async () => {});");
    writeFileSync(
      join(root, 'tests/e2e/support/helper.ts'),
      "test('PB-VOD-003 not a spec', async () => {});",
    );
    writeFileSync(join(root, 'tests/live/soak.spec.ts'), "test('PB-RDY-005 x', async () => {});");
    writeFileSync(join(root, 'tests/unit/c.spec.ts'), "test('PB-VOD-004 x', async () => {});");
    expect(findSpecFiles(root).map((f) => f.path)).toStrictEqual([
      'tests/e2e/a.spec.ts',
      'tests/e2e/b.spec.ts',
      'tests/live/soak.spec.ts',
    ]);
  });

  it('finds nothing in a checkout that has no spec directories yet', () => {
    expect(findSpecFiles(root)).toStrictEqual([]);
  });
});
