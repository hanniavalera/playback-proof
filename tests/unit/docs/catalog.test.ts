import { describe, expect, it } from 'vitest';
import {
  CATALOG_AREAS,
  CATALOG_COLUMNS,
  CatalogError,
  RANKING_COLUMNS,
  checkBudgets,
  checkCatalog,
  checkCatalogPolicy,
  checkIdCitations,
  checkRiskRanking,
  estimateJobs,
  expandEngines,
  formatRisk,
  parseCatalog,
  parseRiskRanking,
  readRiskRanking,
  splitCells,
} from '../../../tools/catalog.ts';
import type { BudgetModel, CatalogRow } from '../../../tools/catalog.ts';

// ---- fixtures -------------------------------------------------------------------------------------------------------

interface Cells {
  id: string;
  area: string;
  scenario: string;
  risk: string;
  tier: string;
  engines: string;
  runsIn: string;
  failure: string;
}
const BASE: Cells = {
  id: 'PB-VOD-001',
  area: 'VOD',
  scenario: 'Starts and reaches 3 s of media time',
  risk: '3x5=15',
  tier: 'merge',
  engines: 'all',
  runsIn: 'e2e',
  failure: 'Members cannot start a title. Block the merge.',
};
const row = (overrides: Partial<Cells> = {}): string => {
  const c = { ...BASE, ...overrides };
  return `| ${c.id} | ${c.area} | ${c.scenario} | ${c.risk} | ${c.tier} | ${c.engines} | ${c.runsIn} | ${c.failure} |`;
};
const HEADER = `| ${CATALOG_COLUMNS.join(' | ')} |`;
const SEPARATOR = `| ${CATALOG_COLUMNS.map(() => '---').join(' | ')} |`;
const catalogDoc = (rows: string[], extra: string[] = []): string =>
  [
    '# Strategy',
    '',
    'Some prose.',
    '',
    '<!-- BEGIN:TEST_CATALOG -->',
    HEADER,
    SEPARATOR,
    ...rows,
    '<!-- END:TEST_CATALOG -->',
    ...extra,
    '',
  ].join('\n');

/** One valid row per area: the smallest catalog that satisfies every policy check. */
const oneRowPerArea = (): string[] => [
  row(),
  row({ id: 'PB-ABR-001', area: 'ABR', risk: '4x4=16' }),
  row({ id: 'PB-LIVE-001', area: 'LIVE', risk: '4x5=20' }),
  row({ id: 'PB-REC-001', area: 'REC', risk: '4x4=16' }),
  row({ id: 'PB-RDY-001', area: 'RDY', risk: '4x5=20', tier: 'release', runsIn: 'live' }),
  row({ id: 'PB-PERF-001', area: 'PERF', risk: '4x4=16', runsIn: 'perf' }),
  row({ id: 'PB-AB-001', area: 'AB', risk: '3x4=12', tier: 'release', engines: 'chromium', runsIn: 'ab' }),
  row({ id: 'PB-ENV-001', area: 'ENV', risk: '3x5=15' }),
  row({
    id: 'PB-EME-001',
    area: 'EME',
    risk: '2x5=10',
    tier: 'release',
    scenario: 'ClearKey playback (stretch goal)',
  }),
  row({ id: 'PB-LAB-001', area: 'LAB', risk: '3x5=15', engines: 'none', runsIn: 'unit' }),
];

function problemsOf(doc: string): string[] {
  try {
    parseCatalog(doc);
  } catch (error) {
    if (error instanceof CatalogError) return error.problems;
    throw error;
  }
  return [];
}

// ---- parseCatalog ---------------------------------------------------------------------------------------------------

describe('PB-LAB-006 parseCatalog: a good catalog', () => {
  it('returns typed rows with their line numbers', () => {
    const doc = catalogDoc([row(), row({ id: 'PB-LAB-001', area: 'LAB', engines: 'none', runsIn: 'unit' })]);
    const rows = parseCatalog(doc);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'PB-VOD-001',
      area: 'VOD',
      scenario: 'Starts and reaches 3 s of media time',
      risk: { likelihood: 3, impact: 5, score: 15, text: '3x5=15' },
      tier: 'merge',
      engines: ['all'],
      runsIn: 'e2e',
      stretch: false,
    });
    // BEGIN is line 5, the header 6, the separator 7, so the first row is line 8.
    expect(rows.map((r) => r.line)).toStrictEqual([8, 9]);
    expect(rows[1]).toMatchObject({ engines: ['none'], runsIn: 'unit' });
  });

  it('accepts every way of writing the engines', () => {
    const engines = (text: string): string[] =>
      parseCatalog(catalogDoc([row({ engines: text })]))[0]?.engines ?? [];
    expect(engines('all')).toStrictEqual(['all']);
    expect(engines('all, chromium-cpu4x')).toStrictEqual(['all', 'chromium-cpu4x']);
    expect(engines('chromium,firefox')).toStrictEqual(['chromium', 'firefox']);
    expect(engines('  webkit  ')).toStrictEqual(['webkit']);
  });

  it('marks a stretch row', () => {
    const rows = parseCatalog(
      catalogDoc([row({ scenario: 'ClearKey playback (stretch goal)' }), row({ id: 'PB-VOD-002' })]),
    );
    expect(rows.map((r) => r.stretch)).toStrictEqual([true, false]);
  });

  it('keeps an escaped pipe inside a cell', () => {
    const rows = parseCatalog(catalogDoc([row({ scenario: 'Retries on 404 \\| 503' })]));
    expect(rows[0]?.scenario).toBe('Retries on 404 | 503');
  });

  it('is not bothered by padded tables, Windows line endings or prose around the block', () => {
    const padded = catalogDoc([row()], ['', 'More prose after.']).replace(/\|/g, ' |  ');
    expect(parseCatalog(padded)).toHaveLength(1);
    expect(parseCatalog(catalogDoc([row()]).replace(/\n/g, '\r\n'))).toHaveLength(1);
  });

  it('parses a catalog with one row per area', () => {
    const rows = parseCatalog(catalogDoc(oneRowPerArea()));
    expect(new Set(rows.map((r) => r.area))).toStrictEqual(new Set(Object.keys(CATALOG_AREAS)));
  });

  it('checkCatalog returns the problems instead of throwing', () => {
    expect(checkCatalog(catalogDoc([row()]))).toStrictEqual([]);
    expect(checkCatalog(catalogDoc([row({ risk: '3x5=14' })])).length).toBe(1);
  });
});

describe('PB-LAB-006 parseCatalog: malformed catalogs are refused', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['no markers', '# Strategy\n\n| a | b |\n', /markers .*TEST_CATALOG.* not found/],
    [
      'two BEGIN markers',
      catalogDoc([row()]).replace('# Strategy', '<!-- BEGIN:TEST_CATALOG -->'),
      /exactly one/,
    ],
    ['END before BEGIN', '<!-- END:TEST_CATALOG -->\n<!-- BEGIN:TEST_CATALOG -->\n', /comes before/],
    ['an empty block', '<!-- BEGIN:TEST_CATALOG -->\n<!-- END:TEST_CATALOG -->\n', /no table found/],
    [
      'columns in the wrong order',
      catalogDoc([row()]).replace(
        HEADER,
        '| Area | ID | Scenario | Risk | Tier | Engines | Runs in | A failure means |',
      ),
      /columns must be exactly/,
    ],
    [
      'a missing column',
      catalogDoc([]).replace(HEADER, '| ID | Area | Scenario | Risk | Tier | Engines | Runs in |'),
      /columns must be exactly/,
    ],
    [
      'an extra column',
      catalogDoc([]).replace(HEADER, `${HEADER.slice(0, -1)}| Owner |`),
      /columns must be exactly/,
    ],
    ['a missing separator row', catalogDoc([row()]).replace(`${SEPARATOR}\n`, ''), /separator/],
    ['a table with no rows', catalogDoc([]), /no rows/],
    [
      'a row with too few cells',
      catalogDoc([row().replace(/ \| [^|]*\|$/, ' |')]),
      /7 cells, the catalog has 8/,
    ],
    ['a row with too many cells', catalogDoc([`${row()} extra |`]), /9 cells/],
    ['an empty cell', catalogDoc([row({ scenario: '' })]), /empty cell in column "Scenario"/],
    [
      'a whitespace-only cell',
      catalogDoc([row({ failure: '   ' })]),
      /empty cell in column "A failure means"/,
    ],
    [
      'a second table in the block',
      catalogDoc([row(), '', HEADER, SEPARATOR, row({ id: 'PB-VOD-002' })]),
      /second table/,
    ],
  ];
  it.each(cases)('refuses %s', (_label, doc, expected) => {
    expect(problemsOf(doc).join('\n')).toMatch(expected);
  });

  const cellCases: Array<[string, Partial<Cells>, RegExp]> = [
    ['an id without the PB prefix', { id: 'VOD-001' }, /id "VOD-001" must look like PB-VOD-001/],
    ['a lower-case id', { id: 'PB-vod-001', area: 'vod' }, /must look like PB-VOD-001/],
    ['an id with two digits', { id: 'PB-VOD-01' }, /must look like PB-VOD-001/],
    ['an id with four digits', { id: 'PB-VOD-0001' }, /must look like PB-VOD-001/],
    ['an area that disagrees with the id', { area: 'ABR' }, /area "ABR" does not match the id \(area VOD\)/],
    ['an unknown area', { id: 'PB-XYZ-001', area: 'XYZ' }, /unknown area "XYZ"/],
    ['a risk with the wrong separator', { risk: '3*5=15' }, /risk "3\*5=15" must look like 4x5=20/],
    ['a risk without a score', { risk: '3x5' }, /must look like 4x5=20/],
    ['a likelihood of zero', { risk: '0x5=0' }, /must look like 4x5=20/],
    ['an impact above five', { risk: '3x6=18' }, /must look like 4x5=20/],
    ['a score that does not multiply out', { risk: '4x5=19' }, /does not multiply out: 4 x 5 is 20, not 19/],
    ['an unknown tier', { tier: 'gate' }, /tier "gate" must be merge or release/],
    ['an unknown lane', { runsIn: 'manual' }, /runs in "manual" must be one of/],
    ['an unknown engine', { engines: 'safari' }, /engines: unknown "safari"/],
    ['an engine listed twice', { engines: 'chromium, chromium' }, /lists an engine twice/],
    ['all combined with an engine it includes', { engines: 'all, chromium' }, /"all" already includes/],
    [
      'none combined with another engine',
      { engines: 'none, chromium', runsIn: 'unit' },
      /cannot be combined/,
    ],
    ['a unit test with browsers', { runsIn: 'unit', engines: 'all' }, /unit test uses no browser/],
    ['a browser test with none', { engines: 'none' }, /"none" is for unit tests/],
    [
      'the CPU-throttled profile on a live row',
      { runsIn: 'live', engines: 'chromium-cpu4x' },
      /chromium-cpu4x applies to e2e and perf/,
    ],
  ];
  it.each(cellCases)('refuses %s', (_label, overrides, expected) => {
    expect(problemsOf(catalogDoc([row(overrides)])).join('\n')).toMatch(expected);
  });

  it('refuses a duplicate id and says where the first one is', () => {
    const problems = problemsOf(catalogDoc([row(), row({ scenario: 'Another' })]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/line 9 \(PB-VOD-001\): duplicate id, first used on line 8/);
  });

  it('reports every problem, not just the first, and names the line and the id', () => {
    const doc = catalogDoc([
      row({ risk: '4x5=19' }),
      row({ id: 'PB-VOD-002', tier: 'gate' }),
      row({ id: 'PB-VOD-003', engines: 'ie6' }),
    ]);
    const problems = problemsOf(doc);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^line 8 \(PB-VOD-001\)/);
    expect(problems[1]).toMatch(/^line 9 \(PB-VOD-002\)/);
    expect(problems[2]).toMatch(/^line 10 \(PB-VOD-003\)/);
    expect(() => parseCatalog(doc)).toThrow(/3 problems in the test catalog/);
  });
});

describe('PB-LAB-006 splitCells', () => {
  it('trims cells, drops the outer pipes and honours escaped pipes', () => {
    expect(splitCells('| a |  b  | c \\| d |')).toStrictEqual(['a', 'b', 'c | d']);
    expect(splitCells('a | b')).toStrictEqual(['a', 'b']);
    expect(splitCells('|  |  |')).toStrictEqual(['', '']);
  });
});

describe('PB-LAB-006 expandEngines', () => {
  it('expands all to the three browsers, keeps the throttled profile apart, and gives none for a unit test', () => {
    expect(expandEngines(['all'])).toStrictEqual(['chromium', 'firefox', 'webkit']);
    expect(expandEngines(['all', 'chromium-cpu4x'])).toStrictEqual([
      'chromium',
      'firefox',
      'webkit',
      'chromium-cpu4x',
    ]);
    expect(expandEngines(['webkit', 'chromium'])).toStrictEqual(['chromium', 'webkit']);
    expect(expandEngines(['none'])).toStrictEqual([]);
  });
});

// ---- the tiering rule -----------------------------------------------------------------------------------------------

describe('PB-LAB-006 checkCatalogPolicy: the tier follows risk and lane', () => {
  const rowsOf = (...overrides: Array<Partial<Cells>>): CatalogRow[] =>
    parseCatalog(
      catalogDoc(overrides.map((o, i) => row({ id: `PB-VOD-${String(i + 1).padStart(3, '0')}`, ...o }))),
    );
  const tierProblems = (...overrides: Array<Partial<Cells>>): string[] =>
    checkCatalogPolicy(rowsOf(...overrides)).filter((p) => !p.startsWith('area '));

  it('accepts a catalog where every tier follows the rule', () => {
    expect(checkCatalogPolicy(parseCatalog(catalogDoc(oneRowPerArea())))).toStrictEqual([]);
  });

  it.each([
    ['merge at the threshold', { risk: '3x5=15', tier: 'merge' }],
    ['release just below it', { risk: '4x3=12', tier: 'release' }],
    ['release at the lower threshold', { risk: '2x4=8', tier: 'release' }],
    [
      'a unit test below the merge threshold is still merge',
      { risk: '2x4=8', tier: 'merge', runsIn: 'unit', engines: 'none' },
    ],
    ['a readiness run above the threshold is release', { risk: '4x5=20', tier: 'release', runsIn: 'live' }],
    [
      'an experiment above the threshold is release',
      { risk: '4x4=16', tier: 'release', runsIn: 'ab', engines: 'chromium' },
    ],
  ] as Array<[string, Partial<Cells>]>)('accepts %s', (_label, overrides) => {
    expect(tierProblems(overrides)).toStrictEqual([]);
  });

  it.each([
    [
      'release above the merge threshold',
      { risk: '4x4=16', tier: 'release' },
      /tier release contradicts the tiering rule, which gives merge \(score 16: 15 and above gates a merge/,
    ],
    [
      'merge below the merge threshold',
      { risk: '4x3=12', tier: 'merge' },
      /tier merge contradicts .* gives release/,
    ],
    [
      'a unit test marked release',
      { risk: '3x5=15', tier: 'release', runsIn: 'unit', engines: 'none' },
      /the unit lane is always merge/,
    ],
    [
      'a readiness run marked merge',
      { risk: '4x5=20', tier: 'merge', runsIn: 'live' },
      /the live lane is always release/,
    ],
    [
      'an experiment marked merge',
      { risk: '4x5=20', tier: 'merge', runsIn: 'ab', engines: 'chromium' },
      /the ab lane is always release/,
    ],
    [
      'a scenario below the release threshold',
      { risk: '2x3=6', tier: 'release' },
      /risk 2x3=6 is below the release threshold \(8\)/,
    ],
  ] as Array<[string, Partial<Cells>, RegExp]>)('refuses %s', (_label, overrides, expected) => {
    expect(tierProblems(overrides).join('\n')).toMatch(expected);
  });

  it('refuses a catalog that has dropped an area, and says how to retire one on purpose', () => {
    const problems = checkCatalogPolicy(parseCatalog(catalogDoc([row()])));
    expect(problems.some((p) => p.startsWith('area ABR has no catalog row'))).toBe(true);
    expect(problems.filter((p) => p.startsWith('area '))).toHaveLength(Object.keys(CATALOG_AREAS).length - 1);
    expect(problems[0]).toMatch(/removing it from CATALOG_AREAS/);
  });
});

// ---- the risk ranking -----------------------------------------------------------------------------------------------

const RANKING_HEADER = `| ${RANKING_COLUMNS.join(' | ')} |`;
const RANKING_SEPARATOR = `| ${RANKING_COLUMNS.map(() => '---').join(' | ')} |`;
const area = (
  rank: number,
  name: string,
  top: string,
  gate: string,
  rows: string,
  why = 'Because it matters.',
): string => `| ${rank} | ${name} | ${top} | ${gate} | ${why} | ${rows} |`;
const rankingDoc = (areas: string[]): string =>
  [
    '<!-- BEGIN:RISK_RANKING -->',
    RANKING_HEADER,
    RANKING_SEPARATOR,
    ...areas,
    '<!-- END:RISK_RANKING -->',
    '',
  ].join('\n');

const catalogRows = (): CatalogRow[] =>
  parseCatalog(
    catalogDoc([
      row({ id: 'PB-LIVE-001', area: 'LIVE', risk: '4x5=20' }),
      row({ id: 'PB-RDY-001', area: 'RDY', risk: '4x5=20', tier: 'release', runsIn: 'live' }),
      row({ id: 'PB-VOD-001', area: 'VOD', risk: '3x5=15' }),
      row({ id: 'PB-VOD-002', area: 'VOD', risk: '3x3=9', tier: 'release' }),
    ]),
  );
const goodRanking = (): string[] => [
  area(1, 'Live join', '4x5=20', 'merge+release', 'PB-LIVE-001 (4x5=20), PB-RDY-001 (4x5=20)'),
  area(2, 'Starting a title', '3x5=15', 'merge', 'PB-VOD-001 (3x5=15)'),
  area(3, 'Secondary paths', '3x3=9', 'release', 'PB-VOD-002 (3x3=9)'),
  area(4, 'Playback rate and volume', '2x2=4', 'exploratory', '-'),
];
const rankingProblems = (areas: string[], rows = catalogRows()): string[] => {
  const parsed = readRiskRanking(rankingDoc(areas));
  return [...parsed.problems, ...(parsed.problems.length === 0 ? checkRiskRanking(parsed.areas, rows) : [])];
};

describe('PB-LAB-006 risk ranking: the ranking drives the catalog', () => {
  it('accepts a ranking that agrees with the catalog', () => {
    expect(rankingProblems(goodRanking())).toStrictEqual([]);
    const areas = parseRiskRanking(rankingDoc(goodRanking()));
    expect(areas[0]).toMatchObject({
      rank: 1,
      area: 'Live join',
      top: { score: 20 },
      gate: 'merge+release',
      rows: [
        { id: 'PB-LIVE-001', risk: { text: '4x5=20' } },
        { id: 'PB-RDY-001', risk: { text: '4x5=20' } },
      ],
    });
    expect(areas[3]?.rows).toStrictEqual([]);
  });

  const refused: Array<[string, (a: string[]) => string[], RegExp]> = [
    [
      'a rank that skips a number',
      (a) => [a[0] ?? '', a[1]?.replace('| 2 |', '| 3 |') ?? ''],
      /rank 3 where 2 is expected/,
    ],
    [
      'areas out of order',
      (a) => [a[1] ?? '', a[0] ?? ''].map((l, i) => l.replace(/^\| \d+ \|/, `| ${i + 1} |`)),
      /ranks below/,
    ],
    [
      'a cited id that is not in the catalog',
      (a) => [a[0]?.replace('PB-RDY-001', 'PB-RDY-099') ?? ''],
      /PB-RDY-099 is not in the test catalog/,
    ],
    [
      'a cited risk that differs from the catalog',
      (a) => [a[1]?.replace('PB-VOD-001 (3x5=15)', 'PB-VOD-001 (4x4=16)') ?? ''],
      /cited as 4x4=16 but the catalog says 3x5=15/,
    ],
    [
      'a catalog row that is in no area',
      (a) => a.filter((l) => !l.includes('PB-VOD-002')),
      /PB-VOD-002 .* appears in no area/,
    ],
    [
      'a row listed under two areas',
      (a) => [...a, area(5, 'Again', '3x3=9', 'release', 'PB-VOD-002 (3x3=9)')],
      /already listed under "Secondary paths"/,
    ],
    [
      'a gate that does not match the rows',
      (a) => [a[0]?.replace('merge+release', 'merge') ?? '', ...a.slice(1)],
      /gate "merge" but its rows are merge and release: it should say "merge\+release"/,
    ],
    [
      'a top risk that is not the highest row',
      (a) => [a[0]?.replace('| 4x5=20 |', '| 4x4=16 |') ?? '', ...a.slice(1)],
      /top risk 4x4=16 but its highest row scores 20/,
    ],
    [
      'exploratory on an area with rows',
      (a) => [a[0]?.replace('merge+release', 'exploratory') ?? '', ...a.slice(1)],
      /"exploratory" is for areas without catalog rows/,
    ],
    [
      'an area without rows that is not exploratory',
      (a) => [...a.slice(0, 3), a[3]?.replace('exploratory', 'release') ?? ''],
      /without catalog rows must have gate "exploratory"/,
    ],
    [
      'an area without rows that is above the release threshold',
      (a) => [...a.slice(0, 3), a[3]?.replace('2x2=4', '3x4=12') ?? ''],
      /needs catalog rows/,
    ],
  ];
  it.each(refused)('refuses %s', (_label, mutate, expected) => {
    expect(rankingProblems(mutate(goodRanking())).join('\n')).toMatch(expected);
  });

  const malformed: Array<[string, string, RegExp]> = [
    ['a risk that does not multiply out', area(1, 'X', '4x5=19', 'merge', '-'), /does not multiply out/],
    ['an unknown gate', area(1, 'X', '4x5=20', 'always', '-'), /gate "always" must be one of/],
    [
      'a rank that is not a number',
      area(1, 'X', '4x5=20', 'merge', '-').replace('| 1 |', '| first |'),
      /rank "first" must be a number/,
    ],
    [
      'a cited row without its risk',
      area(1, 'X', '4x5=20', 'merge', 'PB-VOD-001'),
      /must look like PB-VOD-001 \(3x5=15\)/,
    ],
    ['an empty cell', area(1, 'X', '4x5=20', 'merge', '-', ''), /empty cell in column "Why it ranks here"/],
  ];
  it.each(malformed)('refuses a malformed row: %s', (_label, line, expected) => {
    expect(readRiskRanking(rankingDoc([line])).problems.join('\n')).toMatch(expected);
  });

  it('refuses the wrong columns and a missing block', () => {
    const wrong = rankingDoc([]).replace(RANKING_HEADER, '| Rank | Area | Risk |');
    expect(readRiskRanking(wrong).problems.join('\n')).toMatch(/columns must be exactly/);
    expect(() => parseRiskRanking('# nothing here')).toThrow(CatalogError);
    expect(() => parseRiskRanking('# nothing here')).toThrow(/risk ranking/);
  });
});

// ---- time budgets ---------------------------------------------------------------------------------------------------

const model: BudgetModel = {
  workers: 2,
  setupSec: 10,
  failureAllowanceSec: 10,
  mergeJobSec: 100,
  releaseE2eJobSec: 200,
  perfJobSec: 100,
  maxMergeTestsPerEngine: 3,
  cpuSlowdown: 2,
  perfRuns: 2,
  testSecondsByArea: { VOD: 20, LIVE: 40 },
  perfSecondsPerRun: { 'PB-PERF-001': 10 },
};
const budgetRows = (): CatalogRow[] =>
  parseCatalog(
    catalogDoc([
      row({ id: 'PB-VOD-001' }),
      row({ id: 'PB-VOD-002' }),
      row({ id: 'PB-LIVE-001', area: 'LIVE', risk: '4x5=20', engines: 'all, chromium-cpu4x' }),
      row({ id: 'PB-VOD-003', risk: '3x4=12', tier: 'release', engines: 'chromium' }),
      row({ id: 'PB-PERF-001', area: 'PERF', risk: '4x4=16', runsIn: 'perf' }),
      row({ id: 'PB-LAB-001', area: 'LAB', engines: 'none', runsIn: 'unit' }),
      row({ id: 'PB-RDY-001', area: 'RDY', tier: 'release', runsIn: 'live' }),
    ]),
  );

describe('PB-LAB-006 time budgets: tests x seconds / workers', () => {
  const find = (jobs: ReturnType<typeof estimateJobs>['jobs'], name: string) =>
    jobs.find((j) => j.job === name);

  it('estimates every job the catalog implies', () => {
    const { jobs, problems } = estimateJobs(budgetRows(), model);
    expect(problems).toStrictEqual([]);
    // merge chromium: VOD 20 + VOD 20 + LIVE 40 = 80 test-seconds, / 2 workers = 40, + 10 setup + 10 allowance.
    expect(find(jobs, 'merge chromium')).toMatchObject({
      tests: 3,
      workSeconds: 80,
      wallSeconds: 60,
      budgetSeconds: 100,
    });
    expect(find(jobs, 'merge firefox')).toMatchObject({ tests: 3, wallSeconds: 60 });
    // The throttled profile runs the LIVE row only, 40 s x 2 for the slowdown.
    expect(find(jobs, 'merge chromium-cpu4x')).toMatchObject({ tests: 1, workSeconds: 80, wallSeconds: 60 });
    // The release job adds the release-tier VOD row that runs in chromium only.
    expect(find(jobs, 'release chromium')).toMatchObject({
      tests: 4,
      workSeconds: 100,
      wallSeconds: 70,
      budgetSeconds: 200,
    });
    expect(find(jobs, 'release firefox')).toMatchObject({ tests: 3 });
    // Performance jobs are serial: 2 runs x 10 s + 10 s setup; the scenario runs in each of the three browsers.
    expect(find(jobs, 'perf chromium + chromium-cpu4x')).toMatchObject({
      tests: 1,
      workSeconds: 20,
      wallSeconds: 30,
      budgetSeconds: 100,
    });
    expect(find(jobs, 'perf webkit')).toMatchObject({ tests: 1, wallSeconds: 30 });
  });

  it('ignores unit, readiness and experiment rows: they are not browser jobs of the gates', () => {
    const { jobs } = estimateJobs(budgetRows(), model);
    expect(jobs.every((j) => ['merge', 'release', 'perf'].includes(j.gate))).toBe(true);
    expect(jobs.reduce((n, j) => n + (j.gate === 'merge' ? j.tests : 0), 0)).toBe(3 + 3 + 3 + 1);
  });

  it('passes a catalog that fits', () => {
    expect(checkBudgets(budgetRows(), model)).toStrictEqual([]);
  });

  it('refuses a job over its budget', () => {
    const problems = checkBudgets(budgetRows(), { ...model, mergeJobSec: 50 });
    expect(problems.join('\n')).toMatch(
      /merge chromium: estimated 60 s is over its budget of 50 s \(3 tests\)/,
    );
    expect(checkBudgets(budgetRows(), { ...model, perfJobSec: 20 }).join('\n')).toMatch(
      /perf webkit: estimated 30 s .* \(1 scenarios\)/,
    );
  });

  it('refuses an engine above the ceiling of merge-tier browser tests', () => {
    const problems = checkBudgets(budgetRows(), { ...model, maxMergeTestsPerEngine: 2 });
    expect(problems.join('\n')).toMatch(
      /merge chromium: 3 merge-tier browser tests is over the ceiling of 2 per engine/,
    );
  });

  it('says what is missing when an estimate does not exist, once per area', () => {
    const rows = parseCatalog(
      catalogDoc([
        row({ id: 'PB-REC-001', area: 'REC', risk: '4x4=16' }),
        row({ id: 'PB-REC-002', area: 'REC', risk: '4x4=16' }),
      ]),
    );
    const { problems } = estimateJobs(rows, model);
    expect(problems.filter((p) => p.includes('area REC'))).toHaveLength(1);
    expect(problems[0]).toMatch(
      /no expected-seconds estimate for area REC \(TEST_SECONDS_BY_AREA, in src\/shared\/criteria.ts\)/,
    );
    const perf = parseCatalog(
      catalogDoc([row({ id: 'PB-PERF-009', area: 'PERF', risk: '4x4=16', runsIn: 'perf' })]),
    );
    expect(estimateJobs(perf, model).problems[0]).toMatch(/PB-PERF-009 \(PERF_SECONDS_PER_RUN/);
  });
});

// ---- ids cited in prose -----------------------------------------------------------------------------------------------

describe('PB-LAB-006 checkIdCitations', () => {
  const rows = parseCatalog(catalogDoc([row(), row({ id: 'PB-ABR-001', area: 'ABR', risk: '4x4=16' })]));

  it('accepts known ids, with or without the risk', () => {
    const doc = 'See PB-VOD-001 and PB-ABR-001 (4x4=16), and `PB-VOD-001 (3x5=15)`.';
    expect(checkIdCitations(doc, rows)).toStrictEqual([]);
  });

  it('flags an id that is not in the catalog, with its line', () => {
    expect(checkIdCitations('ok\n\nsee PB-VOD-009 here', rows)).toStrictEqual([
      'line 3: PB-VOD-009 is not in the test catalog',
    ]);
  });

  it('flags a risk that differs from the catalog', () => {
    expect(checkIdCitations('PB-ABR-001 (3x5=15)', rows)).toStrictEqual([
      'line 1: PB-ABR-001 is cited as 3x5=15 but the catalog says 4x4=16',
    ]);
  });

  it('skips fenced code blocks, which hold examples', () => {
    expect(checkIdCitations('text\n```ts\ntest("PB-NOPE-123")\n```\nafter', rows)).toStrictEqual([]);
    expect(checkIdCitations('~~~\nPB-NOPE-123\n~~~\nPB-NOPE-124', rows)).toStrictEqual([
      'line 4: PB-NOPE-124 is not in the test catalog',
    ]);
  });

  it('does not mistake other tokens for ids', () => {
    expect(checkIdCitations('PB_ENV_ID, PB-BRIEF-p1, PB-VOD-0011, pb-vod-001', rows)).toStrictEqual([]);
  });
});

describe('PB-LAB-006 formatRisk', () => {
  it('writes likelihood x impact = score the way the documents do', () => {
    expect(formatRisk(4, 5)).toBe('4x5=20');
    expect(formatRisk(1, 1)).toBe('1x1=1');
  });
});
