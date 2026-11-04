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
export const GATE_MERGE = 'tools/gate-merge.ts';
const MERGE_JOB = 'merge-gate';
const NIGHTLY_JOB = 'release';
const PERF_JOB = 'perf';

/** A link whose text is the path it points at. */
const pathLink = (path: string): string => link(path, path);

export interface CiLeg {
  leg: string;
  /** The Playwright project the leg runs. */
  project: string;
  runner: string;
  experimental: boolean;
}

/** One leg of the performance job: the paired gate of one profile. */
export interface PerfLeg {
  leg: string;
  profile: string;
  runner: string;
  /** The ref of the control in a pull request or a push; a manual run takes it from an input. */
  control: string | null;
  command: string;
}

/** What a job's `--grep` and `--grep-invert` select among the tags of a test. */
export interface Selection {
  grep: string;
  invert: string | null;
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

/** The `--grep "<pattern>"` and `--grep-invert "<pattern>"` of the line of a job that runs Playwright. */
export function parseSelection(workflow: string, file: string, jobId: string): Selection {
  const body = jobBody(workflow, file, jobId).filter((line) => !line.trimStart().startsWith('#'));
  const run = body.find((line) => /--grep\s+"/.test(line));
  const grep = run === undefined ? undefined : /--grep\s+"([^"]*)"/.exec(run)?.[1];
  if (grep === undefined || grep === '') {
    throw new ResultsError(
      `${file}: job "${jobId}" has no line that runs Playwright with --grep "<pattern>"`,
    );
  }
  return { grep, invert: /--grep-invert\s+"([^"]*)"/.exec(run ?? '')?.[1] ?? null };
}

/** The legs of the performance job: one per entry of `matrix.profile: [a, b]`, each the paired gate of its profile. */
export function parsePerfLegs(workflow: string, file: string, jobId: string): PerfLeg[] {
  const body = jobBody(workflow, file, jobId).filter((line) => !line.trimStart().startsWith('#'));
  const profiles = body
    .map((line) => /^\s*profile:\s*\[([^\]]*)\]\s*$/.exec(line)?.[1])
    .find((list) => list !== undefined);
  if (profiles === undefined)
    throw new ResultsError(`${file}: job "${jobId}" has no "profile: [...]" matrix`);
  const names = profiles
    .split(',')
    .map((profile) => profile.trim())
    .filter((profile) => profile !== '');
  const field = (key: string): string | undefined =>
    body.map((line) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`).exec(line)?.[1]).find((v) => v !== undefined);
  const name = field('name');
  const runner = field('runs-on');
  const command = body.map((line) => /^\s*run:\s*(npm run gate:perf.*)$/.exec(line)?.[1]).find((v) => v);
  if (name === undefined || runner === undefined || command === undefined) {
    throw new ResultsError(
      `${file}: job "${jobId}" needs a name, a runs-on and a line "run: npm run gate:perf ..."`,
    );
  }
  const control = /\|\|\s*'([^']+)'/.exec(field('CONTROL_REF') ?? '')?.[1] ?? null;
  const fill = (text: string, profile: string): string => text.replaceAll('${{ matrix.profile }}', profile);
  return names.map((profile) => ({
    leg: fill(name, profile),
    profile,
    runner,
    control,
    command: fill(command, profile),
  }));
}

/** The tag the merge gate selects, read from the script that runs it. */
function mergeTag(files: FileSet): string {
  const tag = /export const MERGE_TAG = '([^']+)'/.exec(files.text(GATE_MERGE))?.[1];
  if (tag === undefined)
    throw new ResultsError(
      `${GATE_MERGE}: no "export const MERGE_TAG = '...'" (the tier tag of the merge gate)`,
    );
  return tag;
}

/** Playwright matches the patterns against the title it builds, tags included; the tags are what the specs put there. */
function selects(selection: Selection, tags: readonly string[]): boolean {
  const haystack = tags.join(' ');
  try {
    return (
      new RegExp(selection.grep).test(haystack) &&
      !(selection.invert !== null && new RegExp(selection.invert).test(haystack))
    );
  } catch {
    throw new ResultsError(
      `the workflow's grep (${JSON.stringify(selection)}) is not a regular expression this renderer can read`,
    );
  }
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

  // What the leg's `--grep` selects, as Playwright lists it: the patterns of the workflow over the tags of the spec, and for the
  // throttled project only the `@cpu` ones (its `grep` in playwright.config.ts). A test an engine cannot run is selected too and
  // skipped with its reason at run time.
  const testsFor = (project: string, selection: Selection): number =>
    report.tests.filter(
      (test) =>
        selects(selection, test.tags) && (project !== 'chromium-cpu4x' || test.tags.includes(CPU_TAG)),
    ).length;
  const mergeSelection: Selection = { grep: mergeTag(files), invert: null };
  const nightlySelection = parseSelection(files.text(NIGHTLY_WORKFLOW), NIGHTLY_WORKFLOW, NIGHTLY_JOB);
  const merge = parseLegs(files.text(MERGE_WORKFLOW), MERGE_WORKFLOW, MERGE_JOB);
  const nightly = parseLegs(files.text(NIGHTLY_WORKFLOW), NIGHTLY_WORKFLOW, NIGHTLY_JOB);
  const legNames = [...new Set([...merge, ...nightly].map((l) => l.leg))];
  const nightlyHead = `Nightly: \`--grep ${JSON.stringify(nightlySelection.grep)}${nightlySelection.invert === null ? '' : ` --grep-invert ${JSON.stringify(nightlySelection.invert)}`}\``;
  const legTable = mdTable(
    [
      'CI leg',
      'Playwright project',
      'Runner',
      `Merge gate: \`--grep ${JSON.stringify(mergeSelection.grep)}\``,
      nightlyHead,
    ],
    legNames.map((name) => {
      const inMerge = merge.find((l) => l.leg === name);
      const inNightly = nightly.find((l) => l.leg === name);
      const leg = (inMerge ?? inNightly) as CiLeg;
      return [
        `${code(leg.leg)}${leg.experimental ? ' (experimental)' : ''}`,
        code(leg.project),
        code(leg.runner),
        inMerge ? String(testsFor(inMerge.project, mergeSelection)) : 'not run',
        inNightly ? String(testsFor(inNightly.project, nightlySelection)) : 'not run',
      ];
    }),
  );

  const ciText = files.text(MERGE_WORKFLOW);
  const perfLegs = ciText.split('\n').includes(`  ${PERF_JOB}:`)
    ? parsePerfLegs(ciText, MERGE_WORKFLOW, PERF_JOB)
    : [];
  const perfTable =
    perfLegs.length === 0
      ? []
      : [
          mdTable(
            ['Performance leg', 'Profile', 'Runner', 'Control (pull request or push)', 'Command'],
            perfLegs.map((leg) => [
              code(leg.leg),
              code(leg.profile),
              code(leg.runner),
              leg.control === null ? 'not named' : code(leg.control),
              code(leg.command),
            ]),
          ),
          '',
        ];

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
    ...perfTable,
    `A leg runs the tests its \`--grep\` selects (the patterns are read from the workflow and the merge-gate script, and matched against the tags of the specs), and in the throttled project only the \`@cpu\` ones; a test an engine cannot run is skipped with its reason, not left out. A leg's runner and project are read from ${pathLink(MERGE_WORKFLOW)} and ${pathLink(NIGHTLY_WORKFLOW)}${perfLegs.length === 0 ? '' : `; a performance leg runs the paired performance gate of its profile (${pathLink('docs/PERF.md')}), not Playwright tests`}.`,
  ];
  return data(lines.join('\n'));
}
