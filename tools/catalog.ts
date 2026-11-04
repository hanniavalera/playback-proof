// The test catalog and the risk ranking of TEST_STRATEGY.md, parsed and checked as data.
//
// The catalog is the list of record of the tests (docs/CONTRACTS.md section 7): later phases implement exactly these ids, and
// `npm run docs:check` compares the document with the specs. A table in a document only stays true if a tool refuses it when
// it is not, so everything here is strict: a malformed catalog is an error, not a guess.
import {
  GATE_LIMITS,
  LANE_TIER,
  PERF_SECONDS_PER_RUN,
  RISK_LIMITS,
  TEST_SECONDS_BY_AREA,
  tierFor,
} from '../src/shared/criteria.ts';
import type { GateTier, Lane, Policy } from '../src/shared/criteria.ts';
import { locateBlock } from './doc-blocks.ts';

export const CATALOG_BLOCK = 'TEST_CATALOG';
export const RANKING_BLOCK = 'RISK_RANKING';

export const CATALOG_COLUMNS = [
  'ID',
  'Area',
  'Scenario',
  'Risk',
  'Tier',
  'Engines',
  'Runs in',
  'A failure means',
] as const;

export const RANKING_COLUMNS = [
  'Rank',
  'Scenario area',
  'Top risk',
  'Gate',
  'Why it ranks here',
  'Catalog rows',
] as const;

export const ENGINES = ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'] as const;
export type Engine = (typeof ENGINES)[number];
/** What the Engines cell may say: engines, `all` (chromium, firefox and webkit) or `none` (a unit test, no browser). */
export type EngineToken = Engine | 'all' | 'none';
const BROWSER_ENGINES: readonly Engine[] = ['chromium', 'firefox', 'webkit'];
const LANES = Object.keys(LANE_TIER) as Lane[];

export interface AreaInfo {
  title: string;
  covers: string;
  livesIn: string;
  phase: string;
}

/** The catalog areas: the middle part of an id (`PB-VOD-001` is area `VOD`). An area is never dropped silently. */
export const CATALOG_AREAS = {
  VOD: {
    title: 'VOD playback',
    covers:
      'DASH and HLS video on demand: start, play to the end, pause and resume, every kind of seek, metrics integrity, the open-codec WebM path',
    livesIn: 'tests/e2e',
    phase: '3',
  },
  ABR: {
    title: 'Adaptive bitrate',
    covers:
      'Climbing, downshifting and upshifting with the network, manual and pinned rungs, startup on a weak link',
    livesIn: 'tests/e2e',
    phase: '3',
  },
  LIVE: {
    title: 'Live playback',
    covers:
      'Joining near the live edge, bounded latency, manifest refresh, HLS live, the DVR window, pause in live',
    livesIn: 'tests/e2e',
    phase: '3',
  },
  REC: {
    title: 'Recovery',
    covers:
      'Segment and manifest failures, a bad rung, slow and truncated segments, live origin stall, stale live manifest',
    livesIn: 'tests/e2e',
    phase: '3',
  },
  RDY: {
    title: 'Live readiness',
    covers:
      'Stream start, live-edge latency, stall recovery, manifest cadence and the soak, judged against the numeric criteria',
    livesIn: 'tests/live',
    phase: '7',
  },
  PERF: {
    title: 'Performance',
    covers:
      'Startup, frame rate, rebuffering and the low-end profile, repeated runs against committed baselines',
    livesIn: 'perf/',
    phase: '5',
  },
  AB: {
    title: 'Experiments',
    covers: 'A/A sanity run and A/B comparison of two player configurations on startup and rebuffering',
    livesIn: 'ab/',
    phase: '6',
  },
  ENV: {
    title: 'Environment',
    covers: 'Real-decode capability probe per engine, deterministic streams',
    livesIn: 'tests/e2e and tests/unit',
    phase: '2 and 3',
  },
  EME: {
    title: 'Encrypted media',
    covers: 'ClearKey playback (stretch goal)',
    livesIn: 'tests/e2e',
    phase: '3 (stretch)',
  },
  LAB: {
    title: 'The lab itself',
    covers:
      'Self-tests of the fault engine, live clock, manifests, statistics, flake math, triage and the docs tooling',
    livesIn: 'tests/unit',
    phase: 'with each component',
  },
} satisfies Record<string, AreaInfo>;
export type AreaCode = keyof typeof CATALOG_AREAS;
const AREA_CODES = Object.keys(CATALOG_AREAS) as AreaCode[];

export interface Risk {
  likelihood: number;
  impact: number;
  score: number;
  /** `LxI=score`, as written in the documents. */
  text: string;
}

export interface CatalogRow {
  id: string;
  area: AreaCode;
  scenario: string;
  risk: Risk;
  tier: GateTier;
  /** As written; `expandEngines` turns it into concrete engines. */
  engines: EngineToken[];
  runsIn: Lane;
  failureMeans: string;
  /** The scenario says "(stretch": the row may legitimately have no implementation yet. */
  stretch: boolean;
  /** 1-based line in the document. */
  line: number;
}

/** A document table that is malformed. `problems` lists every one of them, not only the first. */
export class CatalogError extends Error {
  readonly problems: string[];
  constructor(what: string, problems: string[]) {
    super(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} in the ${what}:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
    this.name = 'CatalogError';
    this.problems = problems;
  }
}

export function formatRisk(likelihood: number, impact: number): string {
  return `${likelihood}x${impact}=${likelihood * impact}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown tables

interface RawRow {
  cells: string[];
  line: number;
}
interface RawTable {
  header: string[];
  headerLine: number;
  rows: RawRow[];
}

/** Splits a table line into trimmed cells. `\|` is a literal pipe inside a cell. */
export function splitCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function readTable(markdown: string, block: string): { table?: RawTable; problems: string[] } {
  const located = locateBlock(markdown, block);
  if (!located.found) return { problems: [`block ${block}: ${located.reason}`] };

  const lines = located.inner.replace(/\r\n/g, '\n').split('\n');
  // lines[0] is the rest of the BEGIN marker's own line.
  const lineNumber = (i: number): number => located.firstLine - 1 + i;
  const problems: string[] = [];
  const run: Array<{ text: string; line: number }> = [];
  let ended = false;
  for (const [i, raw] of lines.entries()) {
    if (raw.trim().startsWith('|')) {
      if (ended) {
        problems.push(
          `block ${block}, line ${lineNumber(i)}: a second table, or a gap inside the table; the block holds exactly one table`,
        );
        break;
      }
      run.push({ text: raw, line: lineNumber(i) });
    } else if (run.length > 0) {
      ended = true;
    }
  }
  const [head, separator, ...rest] = run;
  if (!head || !separator) {
    return {
      problems: [...problems, `block ${block}: no table found (a header row and a separator row are needed)`],
    };
  }
  const header = splitCells(head.text);
  const separatorCells = splitCells(separator.text);
  if (separatorCells.length !== header.length || !separatorCells.every((c) => /^:?-+:?$/.test(c))) {
    problems.push(
      `block ${block}, line ${separator.line}: the second row must be the separator (| --- | --- |)`,
    );
  }
  return {
    table: {
      header,
      headerLine: head.line,
      rows: rest.map((r) => ({ cells: splitCells(r.text), line: r.line })),
    },
    problems,
  };
}

function checkHeader(table: RawTable, expected: readonly string[], block: string): string[] {
  const same = table.header.length === expected.length && table.header.every((h, i) => h === expected[i]);
  return same
    ? []
    : [
        `block ${block}, line ${table.headerLine}: the columns must be exactly "${expected.join(' | ')}" in this order, found "${table.header.join(' | ')}"`,
      ];
}

function parseRisk(text: string): Risk | string {
  const m = /^([1-5])x([1-5])=(\d+)$/.exec(text);
  if (!m) return `risk "${text}" must look like 4x5=20 (likelihood x impact = score, each 1 to 5)`;
  const likelihood = Number(m[1]);
  const impact = Number(m[2]);
  const score = Number(m[3]);
  if (likelihood * impact !== score) {
    return `risk "${text}" does not multiply out: ${likelihood} x ${impact} is ${likelihood * impact}, not ${score}`;
  }
  return { likelihood, impact, score, text };
}

// ---------------------------------------------------------------------------------------------------------------------
// The catalog

function parseEngines(text: string): { value: EngineToken[] } | { error: string } {
  const tokens = text.split(',').map((t) => t.trim());
  const allowed = new Set<string>([...ENGINES, 'all', 'none']);
  const bad = tokens.filter((t) => !allowed.has(t));
  if (bad.length > 0) {
    return {
      error: `engines: unknown ${bad.map((t) => `"${t}"`).join(', ')}; use ${[...allowed].join(', ')}`,
    };
  }
  if (new Set(tokens).size !== tokens.length) return { error: `engines: "${text}" lists an engine twice` };
  if (tokens.includes('none') && tokens.length > 1)
    return { error: 'engines: "none" cannot be combined with others' };
  if (tokens.includes('all') && tokens.some((t) => (BROWSER_ENGINES as readonly string[]).includes(t))) {
    return { error: 'engines: "all" already includes chromium, firefox and webkit; do not list them again' };
  }
  return { value: tokens as EngineToken[] };
}

function readCatalog(markdown: string): { rows: CatalogRow[]; problems: string[] } {
  const { table, problems } = readTable(markdown, CATALOG_BLOCK);
  if (!table) return { rows: [], problems };
  const headerProblems = checkHeader(table, CATALOG_COLUMNS, CATALOG_BLOCK);
  if (headerProblems.length > 0) return { rows: [], problems: [...problems, ...headerProblems] };

  const rows: CatalogRow[] = [];
  const firstLineOf = new Map<string, number>();
  for (const raw of table.rows) {
    const { cells, line } = raw;
    if (cells.length !== CATALOG_COLUMNS.length) {
      problems.push(`line ${line}: ${cells.length} cells, the catalog has ${CATALOG_COLUMNS.length} columns`);
      continue;
    }
    const [
      id = '',
      area = '',
      scenario = '',
      riskText = '',
      tier = '',
      engines = '',
      runsIn = '',
      failureMeans = '',
    ] = cells;
    const at = `line ${line}${id ? ` (${id})` : ''}`;
    const before = problems.length;

    CATALOG_COLUMNS.forEach((column, i) => {
      if ((cells[i] ?? '') === '') problems.push(`${at}: empty cell in column "${column}"`);
    });
    if (problems.length > before) continue;

    const idMatch = /^PB-([A-Z]+)-\d{3}$/.exec(id);
    if (!idMatch)
      problems.push(`${at}: id "${id}" must look like PB-VOD-001 (PB-, capital letters, three digits)`);
    const first = firstLineOf.get(id);
    if (first !== undefined) problems.push(`${at}: duplicate id, first used on line ${first}`);
    else firstLineOf.set(id, line);

    const areaCode = idMatch?.[1];
    if (areaCode && area !== areaCode)
      problems.push(`${at}: area "${area}" does not match the id (area ${areaCode})`);
    if (!AREA_CODES.includes(area as AreaCode)) {
      problems.push(
        `${at}: unknown area "${area}"; known areas: ${AREA_CODES.join(', ')} (tools/catalog.ts)`,
      );
    }

    const risk = parseRisk(riskText);
    if (typeof risk === 'string') problems.push(`${at}: ${risk}`);

    if (tier !== 'merge' && tier !== 'release')
      problems.push(`${at}: tier "${tier}" must be merge or release`);
    if (!LANES.includes(runsIn as Lane))
      problems.push(`${at}: runs in "${runsIn}" must be one of ${LANES.join(', ')}`);

    const parsedEngines = parseEngines(engines);
    if ('error' in parsedEngines) {
      problems.push(`${at}: ${parsedEngines.error}`);
    } else if (LANES.includes(runsIn as Lane)) {
      const tokens = parsedEngines.value;
      if (runsIn === 'unit' && !(tokens.length === 1 && tokens[0] === 'none')) {
        problems.push(`${at}: a unit test uses no browser, so its engines must be "none"`);
      }
      if (runsIn !== 'unit' && tokens.includes('none')) {
        problems.push(`${at}: "none" is for unit tests; a ${runsIn} test needs at least one engine`);
      }
      if (tokens.includes('chromium-cpu4x') && runsIn !== 'e2e' && runsIn !== 'perf') {
        problems.push(`${at}: chromium-cpu4x applies to e2e and perf rows only`);
      }
    }

    if (problems.length > before) continue;
    rows.push({
      id,
      area: area as AreaCode,
      scenario,
      risk: risk as Risk,
      tier: tier as GateTier,
      engines: (parsedEngines as { value: EngineToken[] }).value,
      runsIn: runsIn as Lane,
      failureMeans,
      stretch: /\(stretch/i.test(scenario),
      line,
    });
  }
  if (table.rows.length === 0) problems.push(`block ${CATALOG_BLOCK}: the table has no rows`);
  return { rows, problems };
}

/** The catalog rows of a document, or a `CatalogError` listing every problem. */
export function parseCatalog(markdown: string): CatalogRow[] {
  const { rows, problems } = readCatalog(markdown);
  if (problems.length > 0) throw new CatalogError('test catalog', problems);
  return rows;
}

/** Like `parseCatalog`, but returns the problems instead of throwing. */
export function checkCatalog(markdown: string): string[] {
  return readCatalog(markdown).problems;
}

/** The concrete engines an Engines cell stands for, in a stable order. */
export function expandEngines(tokens: readonly EngineToken[]): Engine[] {
  const wanted = new Set<Engine>();
  for (const token of tokens) {
    if (token === 'all') BROWSER_ENGINES.forEach((e) => wanted.add(e));
    else if (token !== 'none') wanted.add(token);
  }
  return ENGINES.filter((e) => wanted.has(e));
}

/** Tier against risk score and lane (src/shared/criteria.ts), and every area still having a row. */
export function checkCatalogPolicy(rows: readonly CatalogRow[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const at = `line ${row.line} (${row.id})`;
    const expected = tierFor(row.risk.score, row.runsIn);
    if (expected === null) {
      problems.push(
        `${at}: risk ${row.risk.text} is below the release threshold (${RISK_LIMITS.releaseMinScore}); a scenario that low is exploratory, not an automated test: list it in the risk ranking instead`,
      );
    } else if (expected !== row.tier) {
      const rule = LANE_TIER[row.runsIn];
      const why =
        rule === 'by-score'
          ? `score ${row.risk.score}: ${RISK_LIMITS.mergeMinScore} and above gates a merge, ${RISK_LIMITS.releaseMinScore} to ${RISK_LIMITS.mergeMinScore - 1} a release`
          : `the ${row.runsIn} lane is always ${rule} (decided by cost, not by score)`;
      problems.push(`${at}: tier ${row.tier} contradicts the tiering rule, which gives ${expected} (${why})`);
    }
  }
  for (const code of AREA_CODES) {
    if (!rows.some((r) => r.area === code)) {
      problems.push(
        `area ${code} has no catalog row: an area is never dropped silently (retire it on purpose by removing it from CATALOG_AREAS in tools/catalog.ts)`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// The risk ranking

export type AreaGate = GateTier | 'merge+release' | 'exploratory';
const AREA_GATES: readonly string[] = ['merge', 'release', 'merge+release', 'exploratory'];

export interface RankedArea {
  rank: number;
  area: string;
  top: Risk;
  gate: AreaGate;
  why: string;
  rows: Array<{ id: string; risk: Risk }>;
  line: number;
}

function parseRankingRows(cell: string): { rows: RankedArea['rows'] } | { error: string } {
  if (cell === '-') return { rows: [] };
  const rows: RankedArea['rows'] = [];
  for (const part of cell.split(',').map((p) => p.trim())) {
    const m = /^(PB-[A-Z]+-\d{3}) \(([^)]*)\)$/.exec(part);
    if (!m) return { error: `catalog rows: "${part}" must look like PB-VOD-001 (3x5=15)` };
    const risk = parseRisk(m[2] ?? '');
    if (typeof risk === 'string') return { error: `catalog rows: ${m[1]}: ${risk}` };
    rows.push({ id: m[1] ?? '', risk });
  }
  return { rows };
}

export function readRiskRanking(markdown: string): { areas: RankedArea[]; problems: string[] } {
  const { table, problems } = readTable(markdown, RANKING_BLOCK);
  if (!table) return { areas: [], problems };
  const headerProblems = checkHeader(table, RANKING_COLUMNS, RANKING_BLOCK);
  if (headerProblems.length > 0) return { areas: [], problems: [...problems, ...headerProblems] };

  const areas: RankedArea[] = [];
  for (const { cells, line } of table.rows) {
    if (cells.length !== RANKING_COLUMNS.length) {
      problems.push(`line ${line}: ${cells.length} cells, the ranking has ${RANKING_COLUMNS.length} columns`);
      continue;
    }
    const [rank = '', area = '', topText = '', gate = '', why = '', rowsText = ''] = cells;
    const at = `line ${line} (${area || 'unnamed area'})`;
    const before = problems.length;
    RANKING_COLUMNS.forEach((column, i) => {
      if ((cells[i] ?? '') === '') problems.push(`${at}: empty cell in column "${column}"`);
    });
    if (problems.length > before) continue;
    if (!/^\d+$/.test(rank)) problems.push(`${at}: rank "${rank}" must be a number`);
    const top = parseRisk(topText);
    if (typeof top === 'string') problems.push(`${at}: ${top}`);
    if (!AREA_GATES.includes(gate))
      problems.push(`${at}: gate "${gate}" must be one of ${AREA_GATES.join(', ')}`);
    const cited = parseRankingRows(rowsText);
    if ('error' in cited) problems.push(`${at}: ${cited.error}`);
    if (problems.length > before) continue;
    areas.push({
      rank: Number(rank),
      area,
      top: top as Risk,
      gate: gate as AreaGate,
      why,
      rows: (cited as { rows: RankedArea['rows'] }).rows,
      line,
    });
  }
  if (table.rows.length === 0) problems.push(`block ${RANKING_BLOCK}: the table has no rows`);
  return { areas, problems };
}

/** The ranking of a document, or a `CatalogError` listing every problem. */
export function parseRiskRanking(markdown: string): RankedArea[] {
  const { areas, problems } = readRiskRanking(markdown);
  if (problems.length > 0) throw new CatalogError('risk ranking', problems);
  return areas;
}

function gateOf(tiers: ReadonlySet<GateTier>): AreaGate {
  if (tiers.has('merge') && tiers.has('release')) return 'merge+release';
  return tiers.has('merge') ? 'merge' : 'release';
}

/**
 * The ranking must be the thing that drives the catalog: ranked by score, every catalog row in exactly one area with the same
 * risk the catalog states, and each area's gate what its rows really are. Below-the-line areas have no rows.
 */
export function checkRiskRanking(areas: readonly RankedArea[], rows: readonly CatalogRow[]): string[] {
  const problems: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cited = new Map<string, string>();

  areas.forEach((area, i) => {
    const at = `line ${area.line} (${area.area})`;
    if (area.rank !== i + 1)
      problems.push(`${at}: rank ${area.rank} where ${i + 1} is expected; ranks run 1, 2, 3...`);
    const previous = areas[i - 1];
    if (previous && area.top.score > previous.top.score) {
      problems.push(
        `${at}: top risk ${area.top.text} ranks below ${previous.top.text} (${previous.area}); the list is ordered by score, highest first`,
      );
    }

    if (area.rows.length === 0) {
      if (area.gate !== 'exploratory')
        problems.push(`${at}: an area without catalog rows must have gate "exploratory"`);
      if (area.top.score >= RISK_LIMITS.releaseMinScore) {
        problems.push(
          `${at}: risk ${area.top.text} is at or above the release threshold (${RISK_LIMITS.releaseMinScore}), so the area needs catalog rows`,
        );
      }
      return;
    }
    if (area.gate === 'exploratory')
      problems.push(`${at}: gate "exploratory" is for areas without catalog rows`);

    const tiers = new Set<GateTier>();
    let highest = 0;
    for (const ref of area.rows) {
      const row = byId.get(ref.id);
      if (!row) {
        problems.push(`${at}: ${ref.id} is not in the test catalog`);
        continue;
      }
      if (row.risk.text !== ref.risk.text) {
        problems.push(`${at}: ${ref.id} is cited as ${ref.risk.text} but the catalog says ${row.risk.text}`);
      }
      const earlier = cited.get(ref.id);
      if (earlier)
        problems.push(`${at}: ${ref.id} is already listed under "${earlier}"; a row belongs to one area`);
      else cited.set(ref.id, area.area);
      tiers.add(row.tier);
      highest = Math.max(highest, row.risk.score);
    }
    if (tiers.size > 0) {
      if (highest !== area.top.score) {
        problems.push(`${at}: top risk ${area.top.text} but its highest row scores ${highest}`);
      }
      const expected = gateOf(tiers);
      if (expected !== area.gate) {
        problems.push(
          `${at}: gate "${area.gate}" but its rows are ${[...tiers].sort().join(' and ')}: it should say "${expected}"`,
        );
      }
    }
  });

  for (const row of rows) {
    if (!cited.has(row.id)) {
      problems.push(
        `${row.id} (catalog line ${row.line}) appears in no area of the risk ranking: every test answers to a ranked risk`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Time budgets: the merge tier has to fit its job

export interface BudgetModel {
  workers: number;
  setupSec: number;
  failureAllowanceSec: number;
  mergeJobSec: number;
  releaseE2eJobSec: number;
  perfJobSec: number;
  maxMergeTestsPerEngine: number;
  cpuSlowdown: number;
  perfRuns: number;
  testSecondsByArea: Readonly<Record<string, number>>;
  perfSecondsPerRun: Readonly<Record<string, number>>;
}

const valuesOf = (policy: Readonly<Record<string, Policy>>): Record<string, number> =>
  Object.fromEntries(Object.entries(policy).map(([key, p]) => [key, p.value]));

/** The budget model of src/shared/criteria.ts. */
export function defaultBudgetModel(): BudgetModel {
  return {
    workers: GATE_LIMITS.ciWorkers,
    setupSec: GATE_LIMITS.jobSetupSec,
    failureAllowanceSec: GATE_LIMITS.failureAllowanceSec,
    mergeJobSec: GATE_LIMITS.mergeJobSec,
    releaseE2eJobSec: GATE_LIMITS.releaseE2eJobSec,
    perfJobSec: GATE_LIMITS.perfJobSec,
    maxMergeTestsPerEngine: GATE_LIMITS.maxMergeTestsPerEngine,
    cpuSlowdown: GATE_LIMITS.cpuSlowdown,
    perfRuns: GATE_LIMITS.perfRunsPerScenario,
    testSecondsByArea: valuesOf(TEST_SECONDS_BY_AREA),
    perfSecondsPerRun: valuesOf(PERF_SECONDS_PER_RUN),
  };
}

export interface JobEstimate {
  job: string;
  gate: 'merge' | 'release' | 'perf';
  /** Browser tests (merge, release) or scenarios (perf). */
  tests: number;
  /** Test-seconds summed over the tests (merge, release) or serial seconds (perf). */
  workSeconds: number;
  /** work / workers + setup + failure allowance (browser jobs), or setup + serial seconds (perf). */
  wallSeconds: number;
  budgetSeconds: number;
}

const PERF_JOBS: ReadonlyArray<{ name: string; engines: readonly Engine[] }> = [
  { name: 'chromium + chromium-cpu4x', engines: ['chromium', 'chromium-cpu4x'] },
  { name: 'firefox', engines: ['firefox'] },
  { name: 'webkit', engines: ['webkit'] },
];

/**
 * The estimated wall-clock of every CI job the catalog implies, for the design-target runner. Browser jobs run their tests in
 * parallel on `workers`; the merge job holds the merge-tier e2e rows of one engine, the release job every e2e row of it.
 * Performance jobs are serial: runs x seconds per run. `problems` lists estimates the model lacks.
 */
export function estimateJobs(
  rows: readonly CatalogRow[],
  model: BudgetModel = defaultBudgetModel(),
): { jobs: JobEstimate[]; problems: string[] } {
  const jobs: JobEstimate[] = [];
  const problems: string[] = [];
  const reported = new Set<string>();
  const missing = (key: string, what: string, where: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    problems.push(`no expected-seconds estimate for ${what} (${where}, in src/shared/criteria.ts)`);
  };

  const e2e = rows.filter((r) => r.runsIn === 'e2e');
  for (const engine of ENGINES) {
    const secondsOf = (row: CatalogRow): number => {
      const seconds = model.testSecondsByArea[row.area];
      if (seconds === undefined) {
        missing(`area:${row.area}`, `area ${row.area}`, 'TEST_SECONDS_BY_AREA');
        return 0;
      }
      return seconds * (engine === 'chromium-cpu4x' ? model.cpuSlowdown : 1);
    };
    const onEngine = e2e.filter((r) => expandEngines(r.engines).includes(engine));
    for (const [gate, selected, budget] of [
      ['merge', onEngine.filter((r) => r.tier === 'merge'), model.mergeJobSec],
      ['release', onEngine, model.releaseE2eJobSec],
    ] as const) {
      if (selected.length === 0) continue;
      const work = selected.reduce((sum, r) => sum + secondsOf(r), 0);
      jobs.push({
        job: `${gate} ${engine}`,
        gate,
        tests: selected.length,
        workSeconds: work,
        wallSeconds: Math.ceil(work / model.workers) + model.setupSec + model.failureAllowanceSec,
        budgetSeconds: budget,
      });
    }
  }

  for (const { name, engines } of PERF_JOBS) {
    let scenarios = 0;
    let serial = 0;
    for (const row of rows) {
      if (row.runsIn !== 'perf' || row.tier !== 'merge') continue;
      const onJob = expandEngines(row.engines).filter((e) => engines.includes(e)).length;
      if (onJob === 0) continue;
      const perRun = model.perfSecondsPerRun[row.id];
      if (perRun === undefined) {
        missing(`perf:${row.id}`, row.id, 'PERF_SECONDS_PER_RUN');
        continue;
      }
      scenarios += onJob;
      serial += onJob * model.perfRuns * perRun;
    }
    if (scenarios === 0) continue;
    jobs.push({
      job: `perf ${name}`,
      gate: 'perf',
      tests: scenarios,
      workSeconds: serial,
      wallSeconds: serial + model.setupSec,
      budgetSeconds: model.perfJobSec,
    });
  }
  return { jobs, problems };
}

/** The catalog against the time budgets: every job within its budget, no engine above the merge-tier ceiling. */
export function checkBudgets(
  rows: readonly CatalogRow[],
  model: BudgetModel = defaultBudgetModel(),
): string[] {
  const { jobs, problems } = estimateJobs(rows, model);
  for (const job of jobs) {
    if (job.wallSeconds > job.budgetSeconds) {
      problems.push(
        `${job.job}: estimated ${job.wallSeconds} s is over its budget of ${job.budgetSeconds} s (${job.tests} ${job.gate === 'perf' ? 'scenarios' : 'tests'}); move tests to the release tier, make them cheaper, or change the budget with an ADR`,
      );
    }
    if (job.gate === 'merge' && job.tests > model.maxMergeTestsPerEngine) {
      problems.push(
        `${job.job}: ${job.tests} merge-tier browser tests is over the ceiling of ${model.maxMergeTestsPerEngine} per engine`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ids cited in prose

/**
 * Every catalog id mentioned in a document must exist, and a risk written after it, `PB-VOD-001 (3x5=15)`, must be the
 * catalog's. Fenced code blocks are examples and are skipped.
 */
export function checkIdCitations(markdown: string, rows: readonly CatalogRow[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems: string[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const m of text.matchAll(/\b(PB-[A-Z]+-\d{3})\b(?: \((\d)x(\d)=(\d+)\))?/g)) {
      const id = m[1] ?? '';
      const row = byId.get(id);
      if (!row) {
        problems.push(`line ${i + 1}: ${id} is not in the test catalog`);
      } else if (m[2] !== undefined) {
        const cited = `${m[2]}x${m[3]}=${m[4]}`;
        if (cited !== row.risk.text) {
          problems.push(`line ${i + 1}: ${id} is cited as ${cited} but the catalog says ${row.risk.text}`);
        }
      }
    }
  });
  return problems;
}
