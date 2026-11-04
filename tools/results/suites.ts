// RESULTS_SUITES: the automated tests that exist, per area and tier, and which CI legs run which of them. It counts; it does not
// say that anything passed (a pass is the verdict of a CI run, linked from the README). The tests are the real `test(...)` calls of
// the Playwright specs (read with the TypeScript compiler API, as `npm run specs:check` does), joined with the catalog of
// TEST_STRATEGY.md, and the legs are parsed out of the workflow files, not written here.
import { CATALOG_AREAS, CatalogError, parseCatalog } from '../catalog.ts';
import type { CatalogRow } from '../catalog.ts';
import { CPU_TAG, SPEC_DIRECTORIES, analyseSpecs } from '../check-specs.ts';
import type { SpecFile } from '../check-specs.ts';
import { ResultsError, data } from './files.ts';
import type { FileSet, Rendered } from './files.ts';
import { code, link, listOf, mdTable, plural } from './format.ts';

export const STRATEGY = 'TEST_STRATEGY.md';
export const MERGE_WORKFLOW = '.github/workflows/ci.yml';
export const NIGHTLY_WORKFLOW = '.github/workflows/nightly.yml';
const MERGE_JOB = 'merge-gate';
const NIGHTLY_JOB = 'release';

/** A link whose text is the path it points at. */
const pathLink = (path: string): string => link(path, path);

export interface CiLeg {
  leg: string;
  /** The Playwright project the leg runs. */
  project: string;
  runner: string;
  experimental: boolean;
}

/** The text of one job of a workflow: from its `  id:` line to the next job. The files are in the shape Prettier writes. */
function jobBody(workflow: string, file: string, jobId: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) throw new ResultsError(`${file}: there is no job "${jobId}"`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The `strategy.matrix.include` entries of a job, each a list item of `key: value` lines. */
export function parseLegs(workflow: string, file: string, jobId: string): CiLeg[] {
  const body = jobBody(workflow, file, jobId).filter((line) => !line.trimStart().startsWith('#'));
  const head = body.findIndex((line) => line.trim() === 'include:');
  if (head < 0) throw new ResultsError(`${file}: job "${jobId}" has no matrix "include:" list`);
  const headIndent = indentOf(body[head] ?? '');
  const items: Array<Map<string, string>> = [];
  for (const line of body.slice(head + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= headIndent) break;
    const start = /^\s*- ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const field = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (start) items.push(new Map([[start[1] ?? '', (start[2] ?? '').trim()]]));
    else if (field && items.length > 0) items[items.length - 1]?.set(field[1] ?? '', (field[2] ?? '').trim());
  }
  if (items.length === 0) throw new ResultsError(`${file}: the matrix of job "${jobId}" has no legs`);
  return items.map((item, i) => {
    const need = (key: string): string => {
      const value = item.get(key);
      if (value === undefined || value === '') {
        throw new ResultsError(`${file}: leg ${i + 1} of job "${jobId}" has no "${key}"`);
      }
      return value;
    };
    return {
      leg: need('leg'),
      project: need('project'),
      runner: need('runner'),
      experimental: item.get('experimental') === 'true',
    };
  });
}

function readCatalog(files: FileSet): CatalogRow[] {
  try {
    return parseCatalog(files.text(STRATEGY));
  } catch (error) {
    if (error instanceof CatalogError) {
      throw new ResultsError(
        `${STRATEGY}: the catalog does not parse (${error.problems.length} problems; run npm run docs:check)`,
      );
    }
    throw error;
  }
}

function readSpecs(files: FileSet): SpecFile[] {
  return Object.keys(SPEC_DIRECTORIES).flatMap((dir) =>
    files.list(dir, /\.spec\.ts$/).map((path) => ({ path, source: files.text(path) })),
  );
}

export function renderSuites(files: FileSet): Rendered {
  const rows = readCatalog(files);
  const specFiles = readSpecs(files);
  if (specFiles.length === 0)
    throw new ResultsError(`no spec files under ${Object.keys(SPEC_DIRECTORIES).join(' or ')}`);
  const report = analyseSpecs(specFiles, rows);
  if (report.problems.length > 0) {
    throw new ResultsError(
      `the specs and the catalog disagree (${report.problems.length} problems; run npm run specs:check), so their counts would not be true`,
    );
  }
  const withSpec = new Set(report.tests.flatMap((test) => (test.id === null ? [] : [test.id])));

  const areas = Object.entries(CATALOG_AREAS).map(([area, info]) => {
    const inArea = rows.filter((row) => row.area === area);
    return {
      area,
      title: info.title,
      lanes: [...new Set(inArea.map((row) => row.runsIn))],
      rows: inArea.length,
      merge: inArea.filter((row) => row.tier === 'merge').length,
      release: inArea.filter((row) => row.tier === 'release').length,
      specs: inArea.filter((row) => withSpec.has(row.id)).length,
    };
  });
  const sum = (pick: (a: (typeof areas)[number]) => number): number => areas.reduce((n, a) => n + pick(a), 0);
  const areaTable = mdTable(
    ['Area', 'Runs in', 'Catalog rows', 'Merge tier', 'Release tier', 'Playwright tests'],
    [
      ...areas.map((a) => [
        `${code(a.area)} ${a.title}`,
        a.lanes.map(code).join(' and '),
        String(a.rows),
        String(a.merge),
        String(a.release),
        a.specs === 0 ? '-' : String(a.specs),
      ]),
      [
        '**All**',
        '',
        String(sum((a) => a.rows)),
        String(sum((a) => a.merge)),
        String(sum((a) => a.release)),
        String(sum((a) => a.specs)),
      ],
    ],
  );

  // What the leg's `--grep` selects, as Playwright lists it: the tier tags of the spec, and for the throttled project only the `@cpu`
  // ones (its `grep` in playwright.config.ts). A test an engine cannot run is selected too and skipped with its reason at run time.
  const testsFor = (project: string, tiers: readonly string[]): number =>
    report.tests.filter(
      (test) =>
        tiers.some((tier) => test.tags.includes(tier)) &&
        (project !== 'chromium-cpu4x' || test.tags.includes(CPU_TAG)),
    ).length;
  const merge = parseLegs(files.text(MERGE_WORKFLOW), MERGE_WORKFLOW, MERGE_JOB);
  const nightly = parseLegs(files.text(NIGHTLY_WORKFLOW), NIGHTLY_WORKFLOW, NIGHTLY_JOB);
  const legNames = [...new Set([...merge, ...nightly].map((l) => l.leg))];
  const legTable = mdTable(
    [
      'CI leg',
      'Playwright project',
      'Runner',
      'Merge gate: `@merge` tests',
      'Nightly: `@merge` and `@release` tests',
    ],
    legNames.map((name) => {
      const inMerge = merge.find((l) => l.leg === name);
      const inNightly = nightly.find((l) => l.leg === name);
      const leg = (inMerge ?? inNightly) as CiLeg;
      return [
        `${code(leg.leg)}${leg.experimental ? ' (experimental)' : ''}`,
        code(leg.project),
        code(leg.runner),
        inMerge ? String(testsFor(inMerge.project, ['@merge'])) : 'not run',
        inNightly ? String(testsFor(inNightly.project, ['@merge', '@release'])) : 'not run',
      ];
    }),
  );

  const perDirectory = Object.keys(SPEC_DIRECTORIES).map((dir) => {
    const inDir = new Set(specFiles.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path));
    return `${code(dir)}: ${plural(report.tests.filter((t) => inDir.has(t.file)).length, 'test')}`;
  });
  const lines = [
    `The catalog of ${pathLink(STRATEGY)} has ${plural(rows.length, 'row')}; ${plural(report.tests.length, 'Playwright test')} exist in ${plural(report.files, 'spec file')} (${listOf(perDirectory)}), counted from the \`test(...)\` calls of the specs.`,
    '',
    areaTable,
    '',
    legTable,
    '',
    `A leg runs the tests its \`--grep\` selects: the \`@merge\` tag in the merge gate, \`@merge\` or \`@release\` in the nightly, and in the throttled project only the \`@cpu\` ones; a test an engine cannot run is skipped with its reason, not left out. A leg's runner and project are read from ${pathLink(MERGE_WORKFLOW)} and ${pathLink(NIGHTLY_WORKFLOW)}.`,
  ];
  return data(lines.join('\n'));
}
