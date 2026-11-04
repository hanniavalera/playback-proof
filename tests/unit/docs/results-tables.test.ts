import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RESULT_BLOCKS,
  checkResultBlocks,
  loadResultFiles,
  printResultBlocks,
  renderBlock,
  writeResultBlocks,
} from '../../../tools/results-tables.ts';
import type { ResultsBlock } from '../../../tools/results-tables.ts';
import { FileSet, ResultsError, data, emptyState, loadFileSet } from '../../../tools/results/files.ts';
import { renderFlake } from '../../../tools/results/flake.ts';
import {
  cell,
  code,
  fixed,
  listOf,
  mdTable,
  percent,
  plural,
  shorten,
} from '../../../tools/results/format.ts';
import { describeStages, renderJenkins } from '../../../tools/results/jenkins.ts';
import { margin, parseSensitivity, renderPerf } from '../../../tools/results/perf.ts';
import { parseLegs, renderSuites } from '../../../tools/results/suites.ts';
import { renderTriage } from '../../../tools/results/triage.ts';
import { waiting } from '../../../tools/results/waiting.ts';
import type { FlakeReport, ReportTest } from '../../../flake/report.ts';
import type { SuiteStats } from '../../../flake/stats.ts';
import { makeScratch } from '../support/scratch.ts';
import { changed, expectWellFormedTables } from '../support/results-files.ts';
import type { Loose } from '../support/results-files.ts';

// The README's results blocks are rendered from committed files and `docs:check` fails when one differs. These tests run every renderer
// on the real committed files and on small invented ones; results-mutations.test.ts then does to a copy of the real files what a careless
// commit would do (change a number, delete a file, corrupt one, forget to regenerate).

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const real = loadResultFiles(ROOT);

const doc = (inner: string, name = 'T'): string =>
  `# Title\n\nBefore.\n\n<!-- BEGIN:${name} -->\n${inner}\n<!-- END:${name} -->\n\nAfter.\n`;

const block = (over: Partial<ResultsBlock> = {}): ResultsBlock => ({
  name: 'T',
  title: 'a test table',
  reads: [],
  required: true,
  render: () => data('fresh'),
  ...over,
});

describe('PB-LAB-006 results tables: the helpers', () => {
  it('writes a table whose cells cannot break it, and refuses a row of the wrong width', () => {
    expect(cell('a | b\nc')).toBe('a \\| b c');
    expect(mdTable(['x', 'y'], [['1', 'a|b']])).toBe('| x | y |\n| --- | --- |\n| 1 | a\\|b |');
    expect(() => mdTable(['x', 'y'], [['only one']])).toThrow(/1 cells under 2 headings/);
  });

  it('formats numbers the same way everywhere', () => {
    expect(fixed(37.05)).toBe('37.05');
    expect(fixed(111.4999)).toBe('111.5');
    expect(fixed(30)).toBe('30');
    expect(fixed(-0.001)).toBe('0');
    expect(fixed(1234.5)).toBe('1,234.5');
    expect(percent(0.1326)).toBe('13.3 %');
    expect(percent(null)).toBe('n/a');
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(2, 'pass', 'passes')).toBe('2 passes');
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    expect(shorten('a  long\nline of text', 10)).toBe('a long...');
    expect(code('a`b')).toBe('``a`b``');
  });

  it('turns a margin that is astronomical because the noise is nothing into words', () => {
    expect(margin(1.2933)).toBe('1.3x');
    expect(margin(564916.4)).toBe('over 1,000x');
  });
});

describe('PB-LAB-006 results tables: reading a file', () => {
  it('lists the files under a directory, sorted, matching on the part after it', () => {
    const files = new FileSet({ 'a/b.json': '1', 'a/c/d.json': '2', 'a/e.md': '3', 'ab/x.json': '4' });
    expect(files.list('a')).toStrictEqual(['a/b.json', 'a/c/d.json', 'a/e.md']);
    expect(files.list('a', /^[^/]+\.json$/)).toStrictEqual(['a/b.json']);
    expect(files.list('nothing')).toStrictEqual([]);
  });

  it('says which file is missing, and which one is not JSON', () => {
    const files = new FileSet({ 'x.json': '{ not json' });
    expect(() => files.text('y.json')).toThrow('y.json: the file is missing');
    expect(() => files.json('x.json')).toThrow(/x\.json: not valid JSON/);
  });

  it('names the file and the path of a wrong field', () => {
    const root = new FileSet({ 'r.json': '{"stages":[{"durationMs":"12"}],"n":1.5}' }).json('r.json');
    expect(() => root.at('stages').list()[0]?.at('durationMs').num()).toThrow(
      'r.json: $.stages[0].durationMs: expected a number but found the string "12"',
    );
    expect(() => root.at('missing')).toThrow('r.json: $: the field "missing" is missing');
    expect(() => root.at('n').int()).toThrow(/expected an integer but found number 1.5/);
    expect(() => root.at('stages').str()).toThrow(/expected a string but found a list/);
    expect(root.opt('absent')).toBeUndefined();
  });

  it('keeps a copy separate from the original', () => {
    const files = new FileSet({ 'a.json': '1' });
    const copy = files.with('b.json', '2').without('a.json');
    expect(files.has('a.json')).toBe(true);
    expect(copy.has('a.json')).toBe(false);
    expect(copy.has('b.json')).toBe(true);
  });

  it('loads only what a block asked for, and skips dependency and output directories', () => {
    const root = makeScratch('results-files-');
    try {
      const put = (path: string, text: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put('TOP.md', 'top');
      put('docs/a.json', '{}');
      put('docs/skip.txt', 'x');
      put('docs/sub/b.json', '{}');
      put('docs/node_modules/c.json', '{}');
      put('docs/reports/d.json', '{}');
      const loaded = loadFileSet(root, [
        { path: 'TOP.md' },
        { path: 'docs', match: /\.json$/ },
        { path: 'absent' },
      ]);
      expect(loaded.has('TOP.md')).toBe(true);
      expect(loaded.list('docs')).toStrictEqual(['docs/a.json', 'docs/sub/b.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PB-LAB-006 results tables: checking and writing the blocks of a document', () => {
  it('has nothing to say about a block that is fresh', () => {
    expect(checkResultBlocks(doc('fresh'), new FileSet(), [block()])).toStrictEqual({
      problems: [],
      notes: [],
    });
  });

  it('says where a stale block differs and which command fixes it', () => {
    const { problems } = checkResultBlocks(doc('old'), new FileSet(), [block()]);
    expect(problems).toStrictEqual([
      'generated block T is out of date (line 1 of the block: expected "fresh" but found "old"); run `npm run docs:check -- --write`',
    ]);
  });

  it('insists on a required block, and says what it holds', () => {
    const { problems } = checkResultBlocks('# no blocks here\n', new FileSet(), [block()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /generated block T: markers .* not found; the README must hold it \(a test table\)/,
    );
  });

  it('lets a block that waits for data be absent, and says nothing while it has no data', () => {
    const empty = block({ required: false, render: () => emptyState('things', 'docs/results/things') });
    expect(checkResultBlocks('# none\n', new FileSet(), [empty])).toStrictEqual({ problems: [], notes: [] });
  });

  it('says, in a note that does not fail the check, that results exist which the README does not show', () => {
    const withData = block({ required: false, title: 'flake rates' });
    const { problems, notes } = checkResultBlocks('# none\n', new FileSet(), [withData]);
    expect(problems).toStrictEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('T: results exist (flake rates) but the README has no block for them');
    expect(notes[0]).toContain('<!-- BEGIN:T -->');
  });

  it('says in the same way that results exist which no renderer reads yet', () => {
    const files = new FileSet({ 'docs/results/ab/one.json': '{}' });
    const ab = block({
      name: 'RESULTS_AB',
      required: false,
      render: waiting({ what: 'A/B results', dir: 'docs/results/ab', match: /\.json$/ }),
    });
    const { problems, notes } = checkResultBlocks('# none\n', files, [ab]);
    expect(problems).toStrictEqual([]);
    expect(notes[0]).toMatch(
      /RESULTS_AB: the README has no such block, and the results cannot be rendered yet: .*no renderer/,
    );
    // Once the README holds the block, the same state is a problem: the README claims something nothing can render.
    expect(checkResultBlocks(doc('x', 'RESULTS_AB'), files, [ab]).problems[0]).toMatch(
      /generated block RESULTS_AB cannot be rendered: .*no renderer reads them yet/,
    );
  });

  it('reports a block whose markers are broken, even when the block is optional', () => {
    const { problems } = checkResultBlocks('<!-- BEGIN:T -->\ntext\n', new FileSet(), [
      block({ required: false }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/generated block T: expected exactly one .* found 1 and 0/);
    const twice = checkResultBlocks(`${doc('fresh')}${doc('fresh')}`, new FileSet(), [block()]);
    expect(twice.problems[0]).toMatch(/found 2 and 2/);
  });

  it('says why a block cannot be rendered, and never throws', () => {
    const broken = block({
      render: () => {
        throw new ResultsError('docs/results/x.json: $.a: the field "a" is missing');
      },
    });
    expect(checkResultBlocks(doc('anything'), new FileSet(), [broken]).problems).toStrictEqual([
      'generated block T cannot be rendered: docs/results/x.json: $.a: the field "a" is missing',
    ]);
    const buggy = block({
      render: () => {
        throw new TypeError('boom');
      },
    });
    expect(renderBlock(buggy, new FileSet())).toStrictEqual({
      kind: 'problem',
      problem: 'the renderer failed (boom): this is a bug in tools/results/',
    });
  });

  it('writes the blocks it can, leaves the rest of the document alone, and reports the ones it cannot', () => {
    const fresh = block({ name: 'A', render: () => data('new a') });
    const broken = block({
      name: 'B',
      render: () => {
        throw new ResultsError('b.json: the file is missing');
      },
    });
    const text = `${doc('old a', 'A')}\n${doc('old b', 'B')}`;
    const written = writeResultBlocks(text, new FileSet(), [fresh, broken]);
    expect(written.text).toContain('<!-- BEGIN:A -->\nnew a\n<!-- END:A -->');
    expect(written.text).toContain('old b');
    expect(written.problems).toStrictEqual([
      'generated block B cannot be rendered: b.json: the file is missing',
    ]);
    expect(writeResultBlocks(written.text, new FileSet(), [fresh, broken]).text).toBe(written.text);
    expect(written.text.startsWith('# Title\n\nBefore.')).toBe(true);
  });

  it('prints the blocks asked for, or all of them, and the problem of one that cannot be rendered', () => {
    const a = block({ name: 'A', render: () => data('table a') });
    const b = block({
      name: 'B',
      render: () => {
        throw new ResultsError('gone');
      },
    });
    expect(printResultBlocks(new FileSet(), [], [a, b])).toStrictEqual(['table a', 'B: gone']);
    expect(printResultBlocks(new FileSet(), ['A'], [a, b])).toStrictEqual(['table a']);
  });
});

describe('PB-LAB-006 results tables: every block on the real committed files', () => {
  it.each(RESULT_BLOCKS.map((b) => [b.name, b] as const))(
    '%s renders, deterministically, into well-formed tables',
    (_name, b) => {
      const outcome = renderBlock(b, real);
      expect(outcome.kind === 'problem' ? outcome.problem : '').toBe('');
      expect(renderBlock(b, real)).toStrictEqual(outcome);
      if (outcome.kind !== 'problem') expectWellFormedTables(outcome.markdown);
    },
  );

  it('shows the committed numbers it was given, not others', () => {
    const jenkinsBuild = JSON.parse(real.text('docs/results/jenkins/build-3.json')) as Loose;
    const triage = JSON.parse(real.text('docs/results/triage/triage-report.json')) as Loose;
    const markdown = (name: string): string => {
      const outcome = renderBlock(RESULT_BLOCKS.find((b) => b.name === name) as ResultsBlock, real);
      if (outcome.kind === 'problem') throw new Error(outcome.problem);
      return outcome.markdown;
    };
    expect(markdown('RESULTS_JENKINS')).toContain(`${Math.round(jenkinsBuild.durationMs / 1000)} s`);
    expect(markdown('RESULTS_TRIAGE')).toContain(
      `${triage.totals.failures} failures in ${triage.totals.clusters} clusters of ${triage.totals.rootCauses} root causes`,
    );
    const aa = real
      .list('docs/results/perf', /-aa\.json$/)
      .map((path) => JSON.parse(real.text(path)) as Loose);
    const passes = aa.reduce((n, f) => n + f.passes, 0);
    const falsePositives = aa.reduce((n, f) => n + f.falsePositives, 0);
    expect(markdown('RESULTS_PERF')).toContain(`${passes} A/A passes, ${falsePositives} false positives`);
  });
});

describe('PB-LAB-006 results tables: the suites block on invented files', () => {
  const catalog = [
    '<!-- BEGIN:TEST_CATALOG -->',
    '| ID | Area | Scenario | Risk | Tier | Engines | Runs in | A failure means |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| PB-VOD-001 | VOD | Plays | 3x5=15 | merge | all, chromium-cpu4x | e2e | Block. |',
    '| PB-VOD-002 | VOD | Plays HLS | 3x5=15 | merge | all | e2e | Block. |',
    '| PB-VOD-003 | VOD | Seeks | 3x3=9 | release | chromium, firefox | e2e | Release. |',
    '| PB-RDY-001 | RDY | Live join | 3x3=9 | release | all | live | Release. |',
    '| PB-LAB-001 | LAB | Unit | 3x5=15 | merge | none | unit | Block. |',
    '<!-- END:TEST_CATALOG -->',
  ].join('\n');
  const spec = (body: string): string => `import { test } from './support/fixtures.ts';\n${body}\n`;
  const workflow = (job: string, legs: string): string =>
    [
      'name: x',
      '',
      '# a comment that is not a leg',
      'jobs:',
      '  streams:',
      '    name: streams',
      `  ${job}:`,
      '    strategy:',
      '      matrix:',
      '        include:',
      legs,
      '    steps:',
      '      - run: echo',
    ].join('\n');
  const leg = (name: string, project: string, extra = ''): string =>
    [
      `          - leg: ${name}`,
      `            project: ${project}`,
      '            browser: chromium',
      '            runner: ubuntu-24.04',
      ...(extra ? [`            ${extra}`] : []),
    ].join('\n');
  const files = new FileSet({
    'TEST_STRATEGY.md': catalog,
    'tests/e2e/a.spec.ts': spec(
      [
        "test('PB-VOD-001 plays', { tag: ['@merge', '@cpu'] }, async () => {});",
        "test('PB-VOD-002 plays HLS', { tag: ['@merge'] }, async () => {});",
        "test('PB-VOD-003 seeks', { tag: ['@release'] }, async () => {});",
      ].join('\n'),
    ),
    'tests/live/r.spec.ts': spec("test('PB-RDY-001 joins', { tag: ['@release', '@live'] }, async () => {});"),
    '.github/workflows/ci.yml': workflow(
      'merge-gate',
      [
        leg('chromium', 'chromium'),
        leg('cpu', 'chromium-cpu4x'),
        leg('webkit-linux', 'webkit', 'experimental: true'),
      ].join('\n'),
    ),
    '.github/workflows/nightly.yml': workflow(
      'release',
      [leg('chromium', 'chromium'), leg('webkit-linux', 'webkit', 'experimental: true')].join('\n'),
    ),
  });

  it('reads the legs of a matrix, skipping comments, and says what is wrong with one that is not there', () => {
    const text = files.text('.github/workflows/ci.yml');
    expect(parseLegs(text, 'ci.yml', 'merge-gate')).toStrictEqual([
      { leg: 'chromium', project: 'chromium', runner: 'ubuntu-24.04', experimental: false },
      { leg: 'cpu', project: 'chromium-cpu4x', runner: 'ubuntu-24.04', experimental: false },
      { leg: 'webkit-linux', project: 'webkit', runner: 'ubuntu-24.04', experimental: true },
    ]);
    expect(() => parseLegs(text, 'ci.yml', 'nope')).toThrow('ci.yml: there is no job "nope"');
    expect(() => parseLegs(text, 'ci.yml', 'streams')).toThrow(
      'ci.yml: job "streams" has no matrix "include:" list',
    );
    expect(() =>
      parseLegs(text.replace('            project: webkit\n', ''), 'ci.yml', 'merge-gate'),
    ).toThrow('ci.yml: leg 3 of job "merge-gate" has no "project"');
  });

  it('counts the tests per area and tier, and per leg from the catalog and the workflow, not from constants', () => {
    const outcome = renderSuites(files);
    expect(outcome.kind).toBe('data');
    const lines = outcome.markdown.split('\n');
    const row = (start: string): string[] =>
      (lines.find((l) => l.startsWith(start)) ?? '').split('|').map((c) => c.trim());
    expect(outcome.markdown).toContain('has 5 rows; 4 Playwright tests exist in 2 spec files');
    expect(row('| `VOD`').slice(1, 7)).toStrictEqual(['`VOD` VOD playback', '`e2e`', '3', '2', '1', '3']);
    expect(row('| `RDY`').slice(2, 7)).toStrictEqual(['`live`', '1', '0', '1', '1']);
    expect(row('| `LAB`').slice(2, 7)).toStrictEqual(['`unit`', '1', '1', '0', '-']);
    expect(row('| `chromium` |').slice(2, 6)).toStrictEqual(['`chromium`', '`ubuntu-24.04`', '2', '4']);
    expect(row('| `cpu`').slice(4, 6)).toStrictEqual(['1', 'not run']);
    expect(row('| `webkit-linux`').slice(1, 6)).toStrictEqual([
      '`webkit-linux` (experimental)',
      '`webkit`',
      '`ubuntu-24.04`',
      '2',
      '3',
    ]);
  });

  it('refuses to count when a spec and the catalog disagree', () => {
    const wrongTag = files.with(
      'tests/e2e/a.spec.ts',
      spec("test('PB-VOD-002 plays HLS', { tag: ['@release'] }, async () => {});"),
    );
    expect(() => renderSuites(wrongTag)).toThrow(/the specs and the catalog disagree/);
    expect(() => renderSuites(files.without('TEST_STRATEGY.md'))).toThrow(
      'TEST_STRATEGY.md: the file is missing',
    );
    expect(() => renderSuites(files.with('TEST_STRATEGY.md', '# no catalog'))).toThrow(
      /the catalog does not parse/,
    );
  });
});

describe('PB-LAB-006 results tables: the performance block', () => {
  const summary = (rows: string[]): string =>
    [
      '| run | injected | metric | exit | first batch: baseline to current median (change), verdict | fresh batch | final |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n');

  it('reads the table of sensitivity runs, and a "(same)" cell means what the row above injected', () => {
    const rows = parseSensitivity(
      summary([
        '| a-1 | +5 ms | chromium startupMs | 0 | x | - | pass |',
        '| b-1 | `{"type":"latency"}`, 5 runs | chromium rebufferCount | 1 | x | y | regression |',
        '| b-1 | (same) | chromium rebufferMs | 1 | x | y | not-reproduced |',
      ]),
      'summary.md',
    );
    expect(rows.map((r) => [r.injected, r.metric, r.final])).toStrictEqual([
      ['+5 ms', 'chromium startupMs', 'pass'],
      ['`{"type":"latency"}`, 5 runs', 'chromium rebufferCount', 'regression'],
      ['`{"type":"latency"}`, 5 runs', 'chromium rebufferMs', 'not-reproduced'],
    ]);
  });

  it('says what is wrong with a summary it cannot read', () => {
    expect(() => parseSensitivity('# nothing', 'summary.md')).toThrow(/the table of runs .* is not there/);
    expect(() => parseSensitivity(summary(['| a | b | c | 0 | x | - | maybe |']), 'summary.md')).toThrow(
      /line 3: the final verdict "maybe" is not one of regression, not-reproduced, pass, problem/,
    );
    expect(() => parseSensitivity(summary(['| a | b | c |']), 'summary.md')).toThrow(
      /line 3: 3 cells under 7 headings/,
    );
    expect(() => parseSensitivity(summary([]), 'summary.md')).toThrow(/has no rows/);
  });

  it('shows one row for each committed baseline and each A/A summary', () => {
    const outcome = renderPerf(real);
    const lines = outcome.markdown.split('\n');
    const baselines = real.list('perf/baselines', /\.json$/);
    const aa = real.list('docs/results/perf', /-aa\.json$/);
    expect(lines.filter((l) => /^\| `(local|docker)-/.test(l))).toHaveLength(baselines.length);
    expect(lines.filter((l) => /^\| (first run|after a harness fix) \|/.test(l))).toHaveLength(aa.length);
  });
});

describe('PB-LAB-006 results tables: the Jenkins block', () => {
  const stage = (name: string, group: string | null, status: string, durationMs: number) => ({
    name,
    group,
    status,
    durationMs,
  });

  it('writes the stages that ran with their members, and the ones that did not run together', () => {
    expect(
      describeStages([
        stage('Checks', null, 'SUCCESS', 128_000),
        stage('Install', 'Checks', 'SUCCESS', 9_000),
        stage('Unit', 'Checks', 'FAILED', 84_400),
        stage('Merge gate', null, 'NOT_EXECUTED', 0),
        stage('chromium', null, 'NOT_EXECUTED', 0),
      ]),
    ).toBe('Checks 128 s (Install 9 s, Unit FAILED 84 s); not run: Merge gate, chromium');
  });

  it('names the stages of the Jenkinsfile that no committed build ran, and notices when all of them did', () => {
    const jenkinsfile = "stage('Checks') {\n}\nstage('Flake') {\n}\n";
    const withFile = real.with('Jenkinsfile', jenkinsfile);
    const unseen = renderJenkins(withFile);
    expect(unseen.markdown).toContain('that no committed build ran: `Flake`.');
    const seen = renderJenkins(real.with('Jenkinsfile', "stage('Checks') {\n}\n"));
    expect(seen.markdown).toContain(
      'Every stage of the [Jenkinsfile](Jenkinsfile) ran in at least one committed build.',
    );
  });

  it('refuses a build file that is not named after its build', () => {
    const moved = real.with(
      'docs/results/jenkins/build-9.json',
      real.text('docs/results/jenkins/build-3.json'),
    );
    expect(() => renderJenkins(moved)).toThrow(
      /build-9\.json: \$\.build: says build 3, so the file must be build-3\.json/,
    );
  });

  it('shows nothing but its empty state when no build is committed', () => {
    const none = new FileSet();
    expect(renderJenkins(none)).toStrictEqual(emptyState('Jenkins builds', 'docs/results/jenkins'));
  });
});

describe('PB-LAB-006 results tables: the triage block', () => {
  const path = 'docs/results/triage/triage-report.json';

  it('refuses a report whose totals disagree with its own lists', () => {
    const edited = changed(real, path, (r) => {
      r.totals.clusters += 1;
    });
    expect(() => renderTriage(edited)).toThrow(/\$\.totals\.clusters: says 13 but the report lists 12/);
  });

  it('refuses a cluster that names a root cause the report does not list', () => {
    const edited = changed(real, path, (r) => {
      r.clusters[0].rootCause = 'nope';
    });
    expect(() => renderTriage(edited)).toThrow(/cluster .* names root cause nope/);
  });

  it('says when a model draft is not labelled as coming from the mock, and when none was run', () => {
    const mock = 'docs/results/triage/summarize-with-mock/triage-report.json';
    const honest = renderTriage(real).markdown;
    expect(honest).toMatch(/every one says `\[MOCK\]`/);
    const unlabelled = changed(real, mock, (r) => {
      r.summaries[0].text = 'Likely root cause: the origin.';
    });
    expect(renderTriage(unlabelled).markdown).toMatch(/\*\*1 draft of \d+ in .* not labelled as a mock/);
    expect(renderTriage(real.without(mock)).markdown).toContain('No run of the model summaries is committed');
  });
});

describe('PB-LAB-006 results tables: the flake block on an invented report', () => {
  const limits = { windowRuns: 30, minRunsToJudge: 20, quarantineTriggerRate: 0.05, suiteBudgetRate: 0.02 };
  const suite = (over: Partial<SuiteStats> = {}): SuiteStats => ({
    project: 'chromium',
    builds: 30,
    executions: 450,
    flaky: 3,
    failed: 0,
    flakeRate: 3 / 450,
    budget: 0.02,
    verdict: 'ok',
    quarantinedExecutions: 0,
    quarantinedFlaky: 0,
    unobserved: 0,
    contributors: [],
    experimental: false,
    ...over,
  });
  const test = (over: Partial<ReportTest> = {}): ReportTest => ({
    id: 'PB-VOD-007',
    project: 'chromium',
    tier: 'merge',
    executions: 30,
    passed: 28,
    flaky: 2,
    failed: 0,
    flakeRate: 2 / 30,
    failureRate: 0,
    verdict: 'over-trigger',
    window: [],
    quarantinedExecutions: 0,
    executionsInHistory: 30,
    unobserved: 0,
    lastFailure: {
      outcome: 'flaky',
      date: '2026-11-04',
      runId: 'r1',
      commit: 'abc1234',
      signature: 'Error: timed out waiting for seeked',
    },
    cleanWindow: false,
    experimental: false,
    title: 'PB-VOD-007 seek',
    quarantine: null,
    ...over,
  });
  const report = (over: Partial<FlakeReport> = {}): FlakeReport => ({
    generatedAt: '2026-11-04T12:00:00.000Z',
    envId: 'gha-linux-x64',
    today: '2026-11-04',
    history: { runs: 30, from: '2026-11-01', to: '2026-11-04' },
    limits,
    suites: [suite()],
    tests: [test()],
    quarantine: [],
    quarantineProblems: [],
    skips: [],
    notes: [],
    ...over,
  });
  const put = (name: string, value: FlakeReport): FileSet =>
    new FileSet({ [`docs/results/flake/${name}`]: JSON.stringify(value) });

  it('shows the engine jobs and the tests that flaked, with the rate and the last failure', () => {
    const outcome = renderFlake(put('collect-1/report-chromium.json', report()));
    expect(outcome.kind).toBe('data');
    expect(outcome.markdown).toContain(
      '| `gha-linux-x64` | [collect-1/report-chromium.json](docs/results/flake/collect-1/report-chromium.json) | `chromium` | 30 | 450 | 3 | 0 | 0.7 % | 2.0 % | ok |',
    );
    expect(outcome.markdown).toContain(
      '| `gha-linux-x64` | `PB-VOD-007` | `chromium` | 30 | 2 | 0 | 6.7 % | over-trigger | Error: timed out waiting for seeked |',
    );
    expect(outcome.markdown).toContain(
      'window of 30, judged from 20, test trigger 5.0 %, suite budget 2.0 %',
    );
    expectWellFormedTables(outcome.markdown);
  });

  it('marks an experimental engine job, and says so when nothing flaked', () => {
    const outcome = renderFlake(
      put(
        'collect-2/report-webkit.json',
        report({
          suites: [suite({ project: 'webkit', experimental: true })],
          tests: [test({ flaky: 0, flakeRate: 0 })],
        }),
      ),
    );
    expect(outcome.markdown).toContain('`webkit` (experimental)');
    expect(outcome.markdown).toContain('No test flaked or failed in the committed histories.');
  });

  it('has an empty state, and says what is wrong with a report that is not one', () => {
    expect(renderFlake(new FileSet())).toStrictEqual(emptyState('flake reports', 'docs/results/flake'));
    const bad = new FileSet({ 'docs/results/flake/x/report-a.json': '{"envId":"a"}' });
    expect(() => renderFlake(bad)).toThrow(
      'docs/results/flake/x/report-a.json: $: the field "history" is missing',
    );
    expect(() => renderFlake(put('x/report-a.json', report({ suites: [] })))).toThrow(/hold no engine job/);
  });
});

describe('PB-LAB-006 results tables: blocks that wait for data', () => {
  const render = waiting({ what: 'A/B results', dir: 'docs/results/ab', match: /\.json$/ });

  it('shows an empty state, with no number in it, while there are no files', () => {
    expect(render(new FileSet({ 'docs/results/ab/notes.md': 'x' }))).toStrictEqual(
      emptyState('A/B results', 'docs/results/ab'),
    );
    expect(emptyState('A/B results', 'docs/results/ab').markdown).not.toMatch(/\d/);
  });

  it('says that a renderer is missing the day files appear', () => {
    expect(() =>
      render(new FileSet({ 'docs/results/ab/one.json': '{}', 'docs/results/ab/two.json': '{}' })),
    ).toThrow(/docs\/results\/ab holds 2 result file\(s\) .* but no renderer reads them yet/);
  });
});
