// Catalog-to-spec traceability (`npm run specs:check`, TEST_STRATEGY.md section 14): the Playwright specs are read with the
// TypeScript compiler API and compared with the test catalog. A traceability tool that reads source with regular expressions is
// fooled by comments, strings and formatting; this one sees only real `test(...)` calls.
//
//   npm run specs:check                 every spec id is in the catalog, once, with the tags its row asks for
//   npm run specs:check -- --complete   and every catalog row of lane e2e (stretch rows excepted) has a spec
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { CatalogError, expandEngines, parseCatalog } from './catalog.ts';
import type { AreaCode, CatalogRow } from './catalog.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const STRATEGY_FILE = 'TEST_STRATEGY.md';

/** The directories Playwright runs (`testMatch` of playwright.config.ts), and the lane of the catalog each one stands for. */
export const SPEC_DIRECTORIES = { 'tests/e2e': 'e2e', 'tests/live': 'live' } as const;

export const TIER_TAGS = ['@merge', '@release'] as const;
export const CPU_TAG = '@cpu';
/** What a test plays (docs/CONTRACTS.md section 7): chosen by the spec, not decided by the catalog. */
export const CONTENT_TAGS = ['@live', '@hls', '@dash', '@eme', '@soak'] as const;
export const KNOWN_TAGS: readonly string[] = [...TIER_TAGS, CPU_TAG, ...CONTENT_TAGS];

const TEST_MODIFIERS = new Set(['skip', 'fixme', 'fail', 'slow', 'only']);
const ID_AT_START = /^(PB-[A-Z]+-\d{3})(?![\dA-Za-z-])/;

export interface FoundTest {
  /** `PB-VOD-001`, or null when the title does not start with an id. */
  id: string | null;
  title: string;
  file: string;
  line: number;
  /** The `tag` option of the test and of every `test.describe` around it, plus the `@words` of the title. */
  tags: string[];
  /** `skip`, `fixme`, `fail`, `slow` or `only` for `test.skip(...)` and friends. */
  modifier: string | null;
}

export interface SpecFile {
  /** Relative to the repository root, with `/`: decides the lane. */
  path: string;
  source: string;
}

export interface ParsedSpec {
  tests: FoundTest[];
  problems: string[];
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

const isFunctionLike = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

type Callee = { kind: 'test'; modifier: string | null } | { kind: 'describe' } | null;

/** `test(...)`, `test.skip(...)`, `test.describe(...)`, `test.describe.serial(...)`; not `test.step`, `test.use`, `test.beforeEach`. */
function classify(expression: ts.Expression): Callee {
  if (ts.isIdentifier(expression))
    return expression.text === 'test' ? { kind: 'test', modifier: null } : null;
  const names: string[] = [];
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || current.text !== 'test' || names.length === 0) return null;
  if (names[0] === 'describe') return { kind: 'describe' };
  const [only] = names;
  if (names.length === 1 && only !== undefined && TEST_MODIFIERS.has(only))
    return { kind: 'test', modifier: only };
  return null;
}

const plainString = (node: ts.Node): string | null =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

/** The `tag` of a details object (`{ tag: '@merge' }` or `{ tag: ['@merge', '@cpu'] }`), or a problem when it cannot be read from source. */
function readTagOption(details: ts.Expression | undefined): { tags: string[] } | { problem: string } {
  if (details === undefined) return { tags: [] };
  if (!ts.isObjectLiteralExpression(details)) {
    return {
      problem: 'the options of the test are not an object literal, so its tags cannot be read from source',
    };
  }
  for (const property of details.properties) {
    if (ts.isSpreadAssignment(property)) {
      return { problem: 'the options of the test contain a spread, so its tags cannot be read from source' };
    }
    const name =
      property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : null;
    if (name !== 'tag') continue;
    if (!ts.isPropertyAssignment(property)) return { problem: 'the tag option must be a literal' };
    const single = plainString(property.initializer);
    if (single !== null) return { tags: [single] };
    if (ts.isArrayLiteralExpression(property.initializer)) {
      const values = property.initializer.elements.map(plainString);
      if (values.every((value): value is string => value !== null)) return { tags: values };
    }
    return { problem: 'the tag option must be a string literal or an array of string literals' };
  }
  return { tags: [] };
}

/** Every test declared in one spec file, with its tags: read from the syntax tree, never run. */
export function parseSpecSource(path: string, source: string): ParsedSpec {
  const tests: FoundTest[] = [];
  const problems: string[] = [];
  const syntax = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (syntax && syntax.length > 0) {
    const first = syntax[0];
    const message = first ? ts.flattenDiagnosticMessageText(first.messageText, ' ') : 'unknown error';
    return { tests, problems: [`${path}: cannot be parsed (${message})`] };
  }

  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const visit = (node: ts.Node, inherited: readonly string[]): void => {
    if (ts.isCallExpression(node)) {
      const callee = classify(node.expression);
      const args = node.arguments;
      const last = args[args.length - 1];
      const callback = last !== undefined && isFunctionLike(last) ? last : null;
      const first = args[0];
      if (callee?.kind === 'describe' && callback) {
        const own = readTagOption(args.length >= 3 ? args[1] : undefined);
        if ('problem' in own) problems.push(`${path}:${lineOf(file, node)}: ${own.problem}`);
        visit(callback.body, 'tags' in own ? [...inherited, ...own.tags] : inherited);
        return;
      }
      // A declaration has a body to run: `test.skip(condition, 'reason')` inside a test is not one.
      if (callee?.kind === 'test' && callback && args.length >= 2 && first && !isFunctionLike(first)) {
        const line = lineOf(file, node);
        const title = plainString(first);
        if (title === null) {
          problems.push(
            `${path}:${line}: the title of this test is not a plain string, so it cannot be traced to the catalog (one id is one test() call: write the title out)`,
          );
          return;
        }
        const own = readTagOption(args.length >= 3 ? args[1] : undefined);
        if ('problem' in own) problems.push(`${path}:${line}: ${own.problem}`);
        const titleTags = title.match(/@[A-Za-z][\w-]*/g) ?? [];
        const tags = [...new Set([...inherited, ...('tags' in own ? own.tags : []), ...titleTags])];
        tests.push({
          id: ID_AT_START.exec(title)?.[1] ?? null,
          title,
          file: path,
          line,
          tags,
          modifier: callee.modifier,
        });
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inherited));
  };
  visit(file, []);
  return { tests, problems };
}

export interface AreaSummary {
  area: AreaCode;
  /** Catalog rows of the area, whatever their lane. */
  rows: number;
  /** Rows whose lane is e2e: the ones this check can find a spec for. */
  e2eRows: number;
  /** Distinct catalog ids found in specs. */
  specs: number;
  /** Rows of lane e2e without a spec, stretch rows included. */
  missing: string[];
}

export interface SpecReport {
  files: number;
  tests: FoundTest[];
  areas: AreaSummary[];
  /** Everything that makes the check fail. */
  problems: string[];
  /** Rows of lane e2e without a spec that are not stretch: a problem only with `--complete`. */
  missing: string[];
  /** Rows of lane e2e without a spec that are marked stretch: never a problem. */
  missingStretch: string[];
  /** `test.skip` / `test.fixme` declarations: counted as specs, listed so that nobody forgets them. */
  disabled: string[];
}

function expectedTags(row: CatalogRow): {
  required: string[];
  forbidden: string[];
  reason: Record<string, string>;
} {
  const required: string[] = [];
  const forbidden: string[] = [];
  const reason: Record<string, string> = {};
  const cpu = expandEngines(row.engines).includes('chromium-cpu4x');
  const tierTag = row.tier === 'merge' ? '@merge' : '@release';
  const otherTier = row.tier === 'merge' ? '@release' : '@merge';
  required.push(tierTag);
  reason[tierTag] = `tier ${row.tier}`;
  forbidden.push(otherTier);
  reason[otherTier] = `tier ${row.tier} is not ${otherTier.slice(1)}`;
  (cpu ? required : forbidden).push(CPU_TAG);
  reason[CPU_TAG] = cpu
    ? 'the engines include chromium-cpu4x'
    : `the engines (${row.engines.join(', ')}) do not include chromium-cpu4x`;
  return { required, forbidden, reason };
}

const laneOf = (path: string): string | null => {
  for (const [directory, lane] of Object.entries(SPEC_DIRECTORIES)) {
    if (path.startsWith(`${directory}/`)) return lane;
  }
  return null;
};

/** Compares parsed specs with the catalog. Pure: the CLI reads the files, the unit tests hand in fixtures. */
export function analyseSpecs(
  files: readonly SpecFile[],
  rows: readonly CatalogRow[],
  options: { complete?: boolean } = {},
): SpecReport {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const problems: string[] = [];
  const tests: FoundTest[] = [];
  for (const file of files) {
    const parsed = parseSpecSource(file.path, file.source);
    problems.push(...parsed.problems);
    tests.push(...parsed.tests);
  }

  const firstUse = new Map<string, FoundTest>();
  const disabled: string[] = [];
  for (const test of tests) {
    const at = `${test.file}:${test.line}`;
    if (test.modifier === 'only') {
      problems.push(`${at}: test.only must not be committed: it silently drops every other test of the run`);
    }
    if (test.modifier === 'skip' || test.modifier === 'fixme') {
      disabled.push(`${at}: ${test.id ?? test.title} is declared with test.${test.modifier}`);
    }
    if (test.id === null) {
      problems.push(`${at}: the title "${test.title}" does not start with a catalog id (PB-AREA-NNN)`);
      continue;
    }
    const row = byId.get(test.id);
    if (!row) {
      problems.push(`${at}: ${test.id} is not in the catalog (${STRATEGY_FILE} section 9)`);
      continue;
    }
    const first = firstUse.get(test.id);
    if (first) {
      problems.push(
        `${at}: ${test.id} is declared again; its first declaration is at ${first.file}:${first.line}`,
      );
      continue;
    }
    firstUse.set(test.id, test);

    const lane = laneOf(test.file);
    if (lane !== null && row.runsIn !== lane) {
      problems.push(
        `${at}: ${test.id} runs in lane "${row.runsIn}" (${STRATEGY_FILE} line ${row.line}) but its spec is under tests/${lane}`,
      );
    }

    const unknown = test.tags.filter((tag) => !KNOWN_TAGS.includes(tag));
    for (const tag of unknown)
      problems.push(`${at}: ${test.id}: unknown tag ${tag} (known: ${KNOWN_TAGS.join(', ')})`);

    const { required, forbidden, reason } = expectedTags(row);
    const complaints = [
      ...required.filter((tag) => !test.tags.includes(tag)).map((tag) => `missing ${tag} (${reason[tag]})`),
      ...forbidden
        .filter((tag) => test.tags.includes(tag))
        .map((tag) => `unexpected ${tag} (${reason[tag]})`),
    ];
    if (complaints.length > 0) {
      problems.push(
        `${at}: ${test.id} tags disagree with the catalog: ${complaints.join('; ')}; the spec has [${test.tags.join(', ') || 'no tags'}]`,
      );
    }
  }

  const missing: string[] = [];
  const missingStretch: string[] = [];
  const areaCodes = [...new Set(rows.map((row) => row.area))];
  const areas: AreaSummary[] = areaCodes.map((area) => {
    const inArea = rows.filter((row) => row.area === area);
    const e2e = inArea.filter((row) => row.runsIn === 'e2e');
    const absent = e2e.filter((row) => !firstUse.has(row.id));
    for (const row of absent) (row.stretch ? missingStretch : missing).push(row.id);
    return {
      area,
      rows: inArea.length,
      e2eRows: e2e.length,
      specs: inArea.filter((row) => firstUse.has(row.id)).length,
      missing: absent.map((row) => row.id),
    };
  });
  if (options.complete) {
    for (const id of missing) {
      const row = byId.get(id);
      problems.push(
        `${STRATEGY_FILE} line ${row?.line ?? '?'}: ${id} (lane e2e) has no spec under tests/e2e`,
      );
    }
  }
  return { files: files.length, tests, areas, problems, missing, missingStretch, disabled };
}

export function renderReport(report: SpecReport, options: { complete?: boolean } = {}): string {
  const head = ['Area', 'Rows', 'e2e rows', 'Specs', 'Missing'];
  const body = report.areas.map((a) => [
    a.area,
    String(a.rows),
    String(a.e2eRows),
    String(a.specs),
    String(a.missing.length),
  ]);
  const total = report.areas.reduce(
    (sum, a) => ({
      rows: sum.rows + a.rows,
      e2e: sum.e2e + a.e2eRows,
      specs: sum.specs + a.specs,
      missing: sum.missing + a.missing.length,
    }),
    { rows: 0, e2e: 0, specs: 0, missing: 0 },
  );
  const lines = [
    [...head],
    ...body,
    ['all', String(total.rows), String(total.e2e), String(total.specs), String(total.missing)],
  ];
  const widths = head.map((_, column) => Math.max(...lines.map((line) => (line[column] ?? '').length)));
  const format = (line: string[]): string =>
    line
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ');
  const out = [
    `specs:check: ${report.tests.length} test${report.tests.length === 1 ? '' : 's'} in ${report.files} spec file${report.files === 1 ? '' : 's'}, ${total.rows} catalog rows (${total.e2e} in lane e2e)`,
    '',
    format(lines[0] ?? []),
    format(widths.map((w) => '-'.repeat(w))),
    ...lines.slice(1).map(format),
  ];
  const withMissing = report.areas.filter((a) => a.missing.length > 0);
  if (withMissing.length > 0) {
    out.push(
      '',
      options.complete
        ? 'Missing specs (lane e2e):'
        : 'Not written yet (lane e2e; `--complete` makes this an error):',
    );
    for (const a of withMissing) out.push(`  ${a.area}: ${a.missing.join(' ')}`);
    if (report.missingStretch.length > 0)
      out.push(`  (stretch rows never fail the check: ${report.missingStretch.join(' ')})`);
  }
  if (report.disabled.length > 0)
    out.push('', 'Disabled in the source:', ...report.disabled.map((d) => `  ${d}`));
  return out.join('\n');
}

/** Every `*.spec.ts` under the directories Playwright runs, relative to `root` with `/`. */
export function findSpecFiles(root: string): SpecFile[] {
  const found: SpecFile[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.spec.ts')) {
        found.push({ path: relative(root, full).split('\\').join('/'), source: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const directory of Object.keys(SPEC_DIRECTORIES)) walk(join(root, directory));
  return found;
}

function main(): void {
  const complete = process.argv.slice(2).includes('--complete');
  const strategy = join(ROOT, STRATEGY_FILE);
  let rows: CatalogRow[];
  try {
    rows = parseCatalog(readFileSync(strategy, 'utf8'));
  } catch (error) {
    if (error instanceof CatalogError) {
      console.error(
        `${STRATEGY_FILE}: the catalog does not parse (run npm run docs:check):\n${error.problems.join('\n')}`,
      );
      process.exit(1);
    }
    throw error;
  }
  const report = analyseSpecs(findSpecFiles(ROOT), rows, { complete });
  console.log(renderReport(report, { complete }));
  if (report.problems.length > 0) {
    console.error(`\n${report.problems.join('\n')}`);
    console.error(
      `\nspecs:check FAILED (${report.problems.length} problem${report.problems.length === 1 ? '' : 's'})`,
    );
    process.exit(1);
  }
  console.log(`\nspecs:check ok${complete ? ' (complete)' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
