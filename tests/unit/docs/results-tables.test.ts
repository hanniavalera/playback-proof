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
import { renderAb } from '../../../tools/results/ab.ts';
import { FileSet, ResultsError, data, emptyState, loadFileSet } from '../../../tools/results/files.ts';
import { readCollections, renderFlake } from '../../../tools/results/flake.ts';
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
import { renderReadiness, renderSoak } from '../../../tools/results/readiness.ts';
import { parseLegs, parsePerfLegs, parseSelection, renderSuites } from '../../../tools/results/suites.ts';
import { renderTriage } from '../../../tools/results/triage.ts';
import { serializeHistory } from '../../../flake/history.ts';
import { makeScratch } from '../support/scratch.ts';
import { record, run } from '../flake/fixtures.ts';
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

  it('says in the same way that results exist which cannot be rendered yet', () => {
    const files = new FileSet({ 'docs/results/x/one.json': '{}' });
    const pending = block({
      name: 'RESULTS_X',
      required: false,
      render: () => {
        throw new ResultsError('docs/results/x holds 1 result file(s) but no renderer reads them yet');
      },
    });
    const { problems, notes } = checkResultBlocks('# none\n', files, [pending]);
    expect(problems).toStrictEqual([]);
    expect(notes[0]).toMatch(
      /RESULTS_X: the README has no such block, and the results cannot be rendered yet: .*no renderer/,
    );
    // Once the README holds the block, the same state is a problem: the README claims something nothing can render.
    expect(checkResultBlocks(doc('x', 'RESULTS_X'), files, [pending]).problems[0]).toMatch(
      /generated block RESULTS_X cannot be rendered: .*no renderer reads them yet/,
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
    const sum = (dir: string, key: 'passes' | 'falsePositives'): number =>
      real
        .list(`docs/results/perf/${dir}`, /^[^/]+-aa\.json$/)
        .map((path) => JSON.parse(real.text(path)) as Loose)
        .reduce((n, f) => n + f[key], 0);
    const perf = markdown('RESULTS_PERF');
    for (const [set, dir] of [
      ['committed baseline, GitHub VMs', 'gha-cross-vm'],
      ['paired control, GitHub VMs', 'paired-aa'],
    ] as const) {
      expect(perf).toContain(`| ${set} | ${sum(dir, 'passes')} | ${sum(dir, 'falsePositives')} | `);
    }
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
  const workflow = (job: string, legs: string, run = 'echo'): string =>
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
      `      - run: ${run}`,
    ].join('\n');
  const perfJob = [
    '  perf:',
    '    name: perf (${{ matrix.profile }})',
    '    runs-on: ubuntu-24.04',
    '    strategy:',
    '      matrix:',
    '        profile: [chromium, chromium-cpu4x]',
    '    env:',
    "      CONTROL_REF: ${{ github.event_name == 'workflow_dispatch' && inputs.control_ref || 'HEAD^1' }}",
    '    steps:',
    '      - name: Performance gate (${{ matrix.profile }}, paired with its control)',
    '        run: npm run gate:perf -- --paired --control-ref "$CONTROL_REF" --profile ${{ matrix.profile }}',
  ].join('\n');
  const NIGHTLY_RUN =
    'npm run test:e2e -- --grep "@merge|@release" --grep-invert "@readiness" --project=${{ matrix.project }}';
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
    'tools/gate-merge.ts': "export const MERGE_TAG = '@merge';\n",
    'tests/e2e/a.spec.ts': spec(
      [
        "test('PB-VOD-001 plays', { tag: ['@merge', '@cpu'] }, async () => {});",
        "test('PB-VOD-002 plays HLS', { tag: ['@merge'] }, async () => {});",
        "test('PB-VOD-003 seeks', { tag: ['@release'] }, async () => {});",
      ].join('\n'),
    ),
    'tests/live/r.spec.ts': spec(
      "test('PB-RDY-001 joins', { tag: ['@release', '@readiness', '@live'] }, async () => {});",
    ),
    '.github/workflows/ci.yml': `${workflow(
      'merge-gate',
      [
        leg('chromium', 'chromium'),
        leg('cpu', 'chromium-cpu4x'),
        leg('webkit-linux', 'webkit', 'experimental: true'),
      ].join('\n'),
    )}\n${perfJob}\n`,
    '.github/workflows/nightly.yml': workflow(
      'release',
      [leg('chromium', 'chromium'), leg('webkit-linux', 'webkit', 'experimental: true')].join('\n'),
      NIGHTLY_RUN,
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

  it('counts the tests per area and tier from the catalog, and per leg from the workflow and the tags of the specs', () => {
    const outcome = renderSuites(files);
    expect(outcome.kind).toBe('data');
    const lines = outcome.markdown.split('\n');
    const row = (start: string): string[] =>
      (lines.find((l) => l.startsWith(start)) ?? '').split('|').map((c) => c.trim());
    expect(outcome.markdown).toContain('has 5 rows; 4 Playwright tests exist in 2 spec files');
    expect(row('| `VOD`').slice(1, 7)).toStrictEqual(['`VOD` VOD playback', '`e2e`', '3', '2', '1', '3']);
    expect(row('| `RDY`').slice(2, 7)).toStrictEqual(['`live`', '1', '0', '1', '1']);
    expect(row('| `LAB`').slice(2, 7)).toStrictEqual(['`unit`', '1', '1', '0', '-']);
    expect(row('| `chromium` |').slice(2, 6)).toStrictEqual(['`chromium`', '`ubuntu-24.04`', '2', '3']);
    expect(row('| `cpu`').slice(4, 6)).toStrictEqual(['1', 'not run']);
    // PB-VOD-003 is a release test of Chromium and Firefox in the catalog, yet WebKit's grep selects it: it is listed and skipped there.
    expect(row('| `webkit-linux`').slice(1, 6)).toStrictEqual([
      '`webkit-linux` (experimental)',
      '`webkit`',
      '`ubuntu-24.04`',
      '2',
      '3',
    ]);
    // The nightly's `--grep-invert "@readiness"` leaves PB-RDY-001 out: 4 tests are tagged @merge or @release, 3 are selected.
    expect(outcome.markdown).toContain('Nightly: `--grep "@merge\\|@release" --grep-invert "@readiness"`');
  });

  it('follows the grep of the workflow: a pattern that no longer leaves the readiness tests out counts them', () => {
    const widened = files.with(
      '.github/workflows/nightly.yml',
      files.text('.github/workflows/nightly.yml').replace(' --grep-invert "@readiness"', ''),
    );
    const lines = renderSuites(widened).markdown.split('\n');
    const chromium = (lines.find((l) => l.startsWith('| `chromium` |')) ?? '')
      .split('|')
      .map((c) => c.trim());
    expect(chromium.slice(4, 6)).toStrictEqual(['2', '4']);
    // The merge gate's tag is the one the script says it selects.
    const retagged = renderSuites(
      files.with('tools/gate-merge.ts', "export const MERGE_TAG = '@release';\n"),
    );
    const merged = retagged.markdown.split('\n').find((l) => l.startsWith('| `chromium` |')) ?? '';
    expect(
      merged
        .split('|')
        .map((c) => c.trim())
        .slice(4, 5),
    ).toStrictEqual(['2']);
    expect(() => renderSuites(files.with('tools/gate-merge.ts', '// nothing\n'))).toThrow(
      /tools\/gate-merge\.ts: no "export const MERGE_TAG = '\.\.\.'"/,
    );
  });

  it('reads what a job selects with --grep and --grep-invert, and says when there is no such line', () => {
    const text = files.text('.github/workflows/nightly.yml');
    expect(parseSelection(text, 'nightly.yml', 'release')).toStrictEqual({
      grep: '@merge|@release',
      invert: '@readiness',
    });
    const plain = text.replace(' --grep-invert "@readiness"', '');
    expect(parseSelection(plain, 'nightly.yml', 'release').invert).toBeNull();
    expect(() =>
      parseSelection(text.replace('--grep "@merge|@release"', ''), 'nightly.yml', 'release'),
    ).toThrow('nightly.yml: job "release" has no line that runs Playwright with --grep "<pattern>"');
    expect(() =>
      renderSuites(
        files.with('.github/workflows/nightly.yml', text.replace('--grep "@merge|@release"', '--grep "("')),
      ),
    ).toThrow(/not a regular expression this renderer can read/);
  });

  it('lists the performance legs of a workflow, one per profile, and notices a job that is not one', () => {
    const ci = files.text('.github/workflows/ci.yml');
    expect(parsePerfLegs(ci, 'ci.yml', 'perf')).toStrictEqual([
      {
        leg: 'perf (chromium)',
        profile: 'chromium',
        runner: 'ubuntu-24.04',
        control: 'HEAD^1',
        command: 'npm run gate:perf -- --paired --control-ref "$CONTROL_REF" --profile chromium',
      },
      {
        leg: 'perf (chromium-cpu4x)',
        profile: 'chromium-cpu4x',
        runner: 'ubuntu-24.04',
        control: 'HEAD^1',
        command: 'npm run gate:perf -- --paired --control-ref "$CONTROL_REF" --profile chromium-cpu4x',
      },
    ]);
    expect(() => parsePerfLegs(ci, 'ci.yml', 'streams')).toThrow(
      'ci.yml: job "streams" has no "profile: [...]" matrix',
    );
    expect(() =>
      parsePerfLegs(ci.replace('npm run gate:perf', 'npm run something'), 'ci.yml', 'perf'),
    ).toThrow(/needs a name, a runs-on and a line "run: npm run gate:perf/);
    const outcome = renderSuites(files).markdown;
    expect(outcome).toContain('| `perf (chromium-cpu4x)` | `chromium-cpu4x` | `ubuntu-24.04` | `HEAD^1` |');
    // A workflow without the job has no table of performance legs, which makes the README's block stale and docs:check say so.
    expect(
      renderSuites(files.with('.github/workflows/ci.yml', ci.slice(0, ci.indexOf('  perf:')))).markdown,
    ).not.toContain('Performance leg');
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
    expect(
      lines.filter(
        (l) => /^\| (committed baseline|paired control), /.test(l) && /\| `[a-z0-9-]+` \| `/.test(l),
      ),
    ).toHaveLength(aa.length);
  });

  it('treats the two sets measured on GitHub on their own: passes, false positives and VMs per set, and the CPU model of each pass', () => {
    const perf = renderPerf(real).markdown;
    expect(perf).toContain('| committed baseline, GitHub VMs | 39 | 8 | 13 VMs on 5 CPU models |');
    expect(perf).toContain('| paired control, GitHub VMs | 36 | 0 | 12 VMs on 5 CPU models |');
    // The CPU model of the committed-baseline passes is in the machine record of each job, not in the summary that pre-dates it.
    expect(perf).toContain(
      '| AMD EPYC 7763 | 4 VMs, 12 passes, 8 reproduced regressions | 4 VMs, 12 passes, 0 reproduced regressions |',
    );
    expect(perf).toContain(
      '| Intel Xeon Platinum 8573C | 1 VM, 3 passes, 0 reproduced regressions | 1 VM, 3 passes, 0 reproduced regressions |',
    );
  });

  it('refuses a GitHub set whose summary is not of its kind, and a machine record that names no CPU', () => {
    expect(() =>
      renderPerf(changed(real, 'docs/results/perf/paired-aa/chromium-aa.json', (r) => (r.paired = null))),
    ).toThrow(/paired control, GitHub VMs: a paired set whose summary is not paired/);
    expect(() =>
      renderPerf(
        real.with('docs/results/perf/gha-cross-vm/raw/chromium-1/machine.txt', 'measure: perf-aa\nruns: 3\n'),
      ),
    ).toThrow(/gha-cross-vm\/raw\/chromium-1\/machine\.txt: the machine record has no "cpu:" line/);
  });

  it('shows a real regression on a pull request as its two gate reports said it, and notices a number that was changed', () => {
    const perf = renderPerf(real).markdown;
    expect(perf).toContain(
      '| `chromium` | PB-PERF-001 `startupMs` | 58.95 ms | 200.6 ms (+240.3 %; p90 +220.2 %) | 192.3 ms (+226.1 %), worse by 133.3 ms | 17.69 ms (30 % of the control, floor 5 ms) | regression | Intel Xeon 6973P-C for both |',
    );
    expect(perf).toContain(
      '| `chromium-cpu4x` | PB-PERF-004 `startupMs` | 266.7 ms | 354.9 ms (+33.1 %; p90 +32.2 %) | 347.3 ms (+30.2 %), worse by 80.65 ms | 80 ms (30 % of the control, floor 20 ms) | regression | AMD EPYC 7763 for both |',
    );
    const path = 'docs/results/perf/paired-sensitivity/chromium.json';
    const edited = renderPerf(
      changed(real, path, (r) => {
        r.scenarios[0].metrics[0].first.median.current = 300;
      }),
    ).markdown;
    expect(edited).not.toBe(perf);
    expect(edited).toContain('300 ms');
    expect(() => renderPerf(changed(real, path, (r) => (r.paired.aa = true)))).toThrow(
      /a paired sensitivity report that is an A\/A by construction/,
    );
    expect(() => renderPerf(changed(real, path, (r) => (r.kind = 'other')))).toThrow(
      /\$\.kind: expected "perf-gate-report"/,
    );
  });

  it('links the write-ups that are committed next to the data, and says nothing of one that is not', () => {
    const perf = renderPerf(real).markdown;
    expect(perf).toContain('[gha-cross-vm.md](docs/results/perf/gha-cross-vm.md)');
    expect(perf).toContain('[paired-aa/README.md](docs/results/perf/paired-aa/README.md)');
    const without = renderPerf(real.without('docs/results/perf/gha-cross-vm.md')).markdown;
    expect(without).not.toContain('gha-cross-vm.md');
    expect(without).toContain('paired-aa/README.md');
  });

  it('refuses a derivation that is not of the schema it reads, and one that is not a derivation', () => {
    const path = 'docs/results/perf/threshold-derivation.json';
    expect(() => renderPerf(changed(real, path, (r) => (r.schemaVersion = 2)))).toThrow(
      /threshold-derivation\.json: \$\.schemaVersion: this renderer reads schema version 1/,
    );
    expect(() => renderPerf(changed(real, path, (r) => (r.kind = 'other')))).toThrow(
      /\$\.kind: expected "perf-threshold-derivation"/,
    );
  });

  it('refuses a baseline filed under the wrong environment (a copied file)', () => {
    const copied = real.with(
      'perf/baselines/docker-linux-arm64/chromium.json',
      real.text('perf/baselines/local-darwin-arm64/chromium.json'),
    );
    expect(() => renderPerf(copied)).toThrow(
      /records chromium of local-darwin-arm64, so it must be perf\/baselines\/local-darwin-arm64\/chromium\.json \(was the file copied\?\)/,
    );
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

  it('shows the triage job on a red pull request: the failures, the clusters, and the evidence for one root cause', () => {
    const markdown = renderTriage(real).markdown;
    expect(markdown).toContain('63 failed tests in 5 reports became 3 clusters of 1 root cause');
    expect(markdown).toContain(
      '| 59 | `chromium`, `chromium-cpu4x`, `firefox` and `webkit` | 14 | `page-boot-failure` / `page-did-not-boot` | Functional regression |',
    );
    expect(markdown).toContain(
      'the player page did not boot: a Content Security Policy blocked its scripts (63 failures, 3 clusters)',
    );
    expect(markdown).toContain('(`unknown` / `no-rule-matched`) and the report says so instead of guessing');
    expect(
      renderTriage(real.without('docs/results/triage/ci-demo/triage-report.json')).markdown,
    ).not.toContain('On a red pull request in GitHub Actions');
  });

  it('refuses a CI report whose totals disagree with its lists, and notices a number that was changed', () => {
    const demo = 'docs/results/triage/ci-demo/triage-report.json';
    expect(() => renderTriage(changed(real, demo, (r) => (r.totals.failures += 1)))).toThrow(
      /ci-demo\/triage-report\.json: \$\.totals\.failures: says 64 but the report lists 63/,
    );
    expect(() => renderTriage(changed(real, demo, (r) => (r.schemaVersion = 2)))).toThrow(
      /this renderer reads schema version 1/,
    );
    expect(
      renderTriage(changed(real, demo, (r) => ((r.clusters[0].size = 58), (r.totals.failures = 62))))
        .markdown,
    ).toContain('62 failed tests');
  });
});

describe('PB-LAB-006 results tables: the flake block on invented histories', () => {
  const INVALID = 'invalid run: forced climb to 360p 5.9 s after the step down, 10 of 974 frames dropped.';
  /** One repetition of a collection: the outcomes of the tests it ran, in one Playwright invocation. */
  const repetition = (
    n: number,
    tests: Array<Parameters<typeof record>[0]>,
    options: Parameters<typeof run>[1] = {},
  ) =>
    run(
      tests.map((t) => record(t)),
      {
        invocationId: `inv-${n}`,
        date: `2026-11-04T10:0${n % 10}:00.000Z`,
        commit: 'abcdef1234567',
        ...options,
      },
    );
  const raw = (path: string, runs: ReturnType<typeof run>[]): Record<string, string> => ({
    [`docs/results/flake/${path}`]: serializeHistory(runs),
  });
  const histories = new FileSet({
    ...raw('collect-1/raw/chromium/gha-linux-x64.jsonl', [
      repetition(1, [{ id: 'PB-VOD-001' }, { id: 'PB-VOD-002' }]),
      repetition(2, [{ id: 'PB-VOD-001' }, { id: 'PB-VOD-002', outcome: 'flaky' }]),
      repetition(3, [{ id: 'PB-VOD-001', outcome: 'failed' }, { id: 'PB-VOD-002' }]),
    ]),
    ...raw('after-fix/series/raw/gha-macos-arm64.jsonl', [
      repetition(1, [{ id: 'PB-ABR-002', project: 'webkit', outcome: 'skipped', skipReason: INVALID }], {
        envId: 'gha-macos-arm64',
      }),
      repetition(2, [{ id: 'PB-ABR-002', project: 'webkit' }], { envId: 'gha-macos-arm64' }),
      repetition(
        3,
        [
          {
            id: 'PB-ABR-002',
            project: 'webkit',
            outcome: 'skipped',
            skipReason: 'documented gap in x: no EME',
          },
          { id: 'PB-ABR-002', project: 'webkit-dpr1' },
        ],
        { envId: 'gha-macos-arm64' },
      ),
    ]),
  });

  it('counts each collection and engine project: repetitions, executions, flaky, failed, invalid runs and other skips', () => {
    const [first, second, third] = readCollections(histories);
    expect(readCollections(histories)).toHaveLength(3);
    // The order is the one of the write-up: the whole tier first, then the series of the fix.
    expect([first?.name, second?.name, third?.name]).toStrictEqual([
      'collect-1 / chromium',
      'after-fix/series',
      'after-fix/series',
    ]);
    expect(first?.totals).toStrictEqual({ executions: 6, flaky: 1, failed: 1, invalid: 0, otherSkips: 0 });
    expect(first?.repetitions).toBe(3);
    expect(second?.project).toBe('webkit');
    expect(second?.totals).toStrictEqual({ executions: 1, flaky: 0, failed: 0, invalid: 1, otherSkips: 1 });
    expect(second?.repetitions).toBe(3);
    expect(third?.project).toBe('webkit-dpr1');
    expect(third?.repetitions).toBe(1);
  });

  it('shows a row for each collection and one for each test that flaked, failed or was skipped as invalid', () => {
    const outcome = renderFlake(histories);
    expect(outcome.kind).toBe('data');
    expect(outcome.markdown).toContain(
      '| [collect-1 / chromium](docs/results/flake/collect-1/raw/chromium/gha-linux-x64.jsonl) | `gha-linux-x64` | `chromium` | 3 | 6 | 1 | 1 | 0 | 0 | `abcdef1` | 2026-11-04 |',
    );
    expect(outcome.markdown).toContain(
      '| collect-1 / chromium | `gha-linux-x64` | `PB-VOD-001` | `chromium` | 3 | 1 of 3 (33.3 %) | 0 | 1 | 0 of 3 (0.0 %) |',
    );
    expect(outcome.markdown).toContain(
      '| after-fix/series | `gha-macos-arm64` | `PB-ABR-002` | `webkit` | 1 | 0 of 1 (0.0 %) | 0 | 0 | 1 of 2 (50.0 %) |',
    );
    // A test that only ever passed is not listed.
    expect(outcome.markdown).not.toContain('`webkit-dpr1` | 1 | 0 of 1');
    expectWellFormedTables(outcome.markdown);
  });

  it('says so when nothing flaked, failed or was skipped as invalid', () => {
    const clean = new FileSet(
      raw('collect-1/raw/chromium/gha-linux-x64.jsonl', [repetition(1, [{ id: 'PB-VOD-001' }])]),
    );
    expect(renderFlake(clean).markdown).toContain(
      'No test flaked, failed or was skipped as an invalid run in these collections.',
    );
  });

  it('has an empty state, and says what is wrong with a history that is not one', () => {
    expect(renderFlake(new FileSet())).toStrictEqual(emptyState('flake collections', 'docs/results/flake'));
    const bad = new FileSet({ 'docs/results/flake/x/raw/a.jsonl': '{"runId":"a"}\n' });
    expect(() => renderFlake(bad)).toThrow(/docs\/results\/flake\/x\/raw\/a\.jsonl: /);
    const none = new FileSet({ 'docs/results/flake/x/raw/a.jsonl': '' });
    expect(() => renderFlake(none)).toThrow(/the history holds no run/);
  });

  it('counts the real collections the way the write-up beside them does, and notices a line that was taken out', () => {
    const collections = readCollections(real);
    const find = (name: string, project = 'webkit') =>
      collections.find((c) => c.name === name && c.project === project);
    expect(find('collect-1 / chromium', 'chromium')?.totals.executions).toBe(450);
    expect(find('collect-1 / webkit-macos')?.totals).toStrictEqual({
      executions: 300,
      flaky: 1,
      failed: 2,
      invalid: 0,
      otherSkips: 0,
    });
    const markdown = renderFlake(real).markdown;
    const path = 'docs/results/flake/after-fix/abr002-fix/raw/gha-macos-arm64.jsonl';
    const lines = real.text(path).trimEnd().split('\n');
    const fewer = renderFlake(real.with(path, `${lines.slice(1).join('\n')}\n`)).markdown;
    expect(fewer).not.toBe(markdown);
  });
});

describe('PB-LAB-006 results tables: the readiness and soak blocks, through the evidence module', () => {
  it('shows each engine and configuration with its verdict per check, by batch and protocol', () => {
    const markdown = renderReadiness(real).markdown;
    expect(markdown).toContain('**DASH, the first evidence** (4 runs of commit `0d62c1d`)');
    expect(markdown).toContain('**HLS, the extra runs** (2 runs of commit `e0a5be3`)');
    expect(markdown).toContain('| webkit 27.2 | A | GO | GO | NO-GO | GO | NO-GO |');
    expect(markdown).toContain('| webkit 27.2 | live-sync | GO | GO | GO | GO | GO |');
    expect(markdown).toContain('| chromium 156.0.8078.4 (hls) | A | GO | GO | NO-GO | GO | NO-GO |');
    expectWellFormedTables(markdown);
  });

  it('shows the soaks grouped, as measured and judged again by the criteria of today', () => {
    const markdown = renderSoak(real).markdown;
    expect(markdown).toContain(
      '| the first evidence | `gha-linux-x64` | A | 3 | 5 min | `origin-stall` | 3 of 3 | 0 of 3 | 10.62 to 11.13 s |',
    );
    expect(markdown).toContain(
      '| the first evidence | `gha-linux-x64` | live-sync | 3 | 30 min | `origin-stall` and `stale-manifest` | 3 of 3 | 2 of 3 | 6.99 to 12.49 s |',
    );
    expect(markdown).toContain('18 soaks in all');
    expectWellFormedTables(markdown);
  });

  it('refuses a result file that is not what its job uploaded, before it shows anything', () => {
    const path = 'docs/results/readiness/gha-linux-x64-webkit.json';
    const edited = real.with(path, real.text(path).replace('"NO-GO"', '"GO"'));
    expect(edited.text(path)).not.toBe(real.text(path));
    expect(() => renderReadiness(edited)).toThrow(
      /gha-linux-x64-webkit\.json: the file is not what the job uploaded/,
    );
    expect(() => renderSoak(edited)).toThrow(/is not what the job uploaded/);
  });

  it('refuses a result file that no entry of the provenance names, and a provenance that is not there', () => {
    expect(() => renderSoak(real.with('docs/results/soak/stray.json', '{}'))).toThrow(
      /docs\/results\/soak\/stray\.json: a result file that no entry of docs\/results\/provenance\/runs\.json names/,
    );
    expect(() => renderReadiness(real.without('docs/results/provenance/runs.json'))).toThrow(
      /runs\.json: the file is missing/,
    );
  });

  it('has an empty state while no result is committed', () => {
    expect(renderReadiness(new FileSet())).toStrictEqual(
      emptyState('readiness results', 'docs/results/readiness'),
    );
    expect(renderSoak(new FileSet())).toStrictEqual(emptyState('soak results', 'docs/results/soak'));
  });
});

describe('PB-LAB-006 results tables: the A/B block', () => {
  const reportPath = (prefix: string): string =>
    real.list('docs/results/ab', new RegExp(`^${prefix}\\..*\\.report\\.json$`))[0] ?? '';
  const report = (prefix: string): Loose => JSON.parse(real.text(reportPath(prefix))) as Loose;
  const render = (files: FileSet = real): string => {
    const outcome = renderAb(files);
    if (outcome.kind !== 'data') throw new Error(outcome.markdown);
    return outcome.markdown;
  };
  const rows = (markdown: string, start: string): string[] =>
    markdown.split('\n').filter((line) => line.startsWith(start));
  const primary = (prefix: string): Loose =>
    report(prefix).conditions[0].analysis.metrics.find((m: Loose) => m.role === 'primary');

  it('counts the reports by kind, says where they were measured, and leaves the pipeline check out', () => {
    const markdown = render();
    const reports = real.list('docs/results/ab', /^[^/]+\.report\.json$/);
    expect(reports).toHaveLength(6);
    expect(markdown).toContain(
      `Counted from the ${reports.length} reports under [\`docs/results/ab\`](docs/results/ab): 2 pre-registered experiments, 3 A/A pilots of the harness itself and 1 exploratory run.`,
    );
    expect(markdown).toContain(
      'Every report was measured in Chromium 156.0.8078.4 on `local-darwin-arm64`, a local workstation (macOS 27.2, 12 CPUs, 16 GiB): one engine on one machine, not replicated on a GitHub runner.',
    );
    expect(markdown).toContain('The pipeline check of Part 1 (2 measured sessions per arm, plumbing only');
    expect(markdown).not.toContain('pipeline-check.local-darwin-arm64');
  });

  it('tabulates the two experiments with the numbers of their reports', () => {
    const markdown = render();
    const startup = primary('PB-AB-002');
    const [row = ''] = rows(markdown, '| [`PB-AB-002`]');
    expect(row).toContain(
      `${fixed(startup.summaryA.median, 1)} ms median (p90 ${fixed(startup.summaryA.p90, 1)}), 30 sessions`,
    );
    expect(row).toContain(
      `${fixed(startup.summaryB.median, 1)} ms median (p90 ${fixed(startup.summaryB.p90, 1)}), 30 sessions`,
    );
    expect(row).toContain(
      `+${fixed(startup.effect.estimate, 1)} ms (${fixed(startup.effect.low, 1)} to +${fixed(startup.effect.high, 1)})`,
    );
    expect(row).toContain('Startup time (margin ±100 ms)');
    expect(row).toContain('`high-latency`: 300 ms of latency (jitter 100 ms)');
    expect(row).toContain('**Equivalent within the margin (keep A)** | Yes, 7 of 7 gates |');
    const [harm = ''] = rows(markdown, '| [`PB-AB-003`]');
    expect(harm).toContain('0 of 39 sessions | 0 of 39 sessions | 0 points (-9 to +9) |');
    expect(harm).toContain('Share of sessions with a rebuffer (margin ±20 points)');
    expect(harm).toContain('`bandwidth-drop-finite`: link of 20,000 kbps, then 600 kbps from 8 s');
  });

  it('prints no verdict for the exploratory run, labels it, and says what the report says of itself', () => {
    const markdown = render();
    const exploratory = rows(markdown, '| **Exploratory**');
    expect(exploratory).toHaveLength(2);
    for (const row of exploratory) {
      expect(row).toContain('None: exploratory, estimates only');
      expect(row).not.toMatch(/Equivalent|better|Inconclusive/);
    }
    expect(markdown).toContain(
      'The exploratory run says of itself: “This is an exploratory comparison: it estimates and decides nothing.”',
    );
    expect(exploratory[1]).toContain('`constrained-1500`: link of 1,500 kbps');
  });

  it('says what the PB-AB-003 report says about the sessions it left out', () => {
    const markdown = render();
    const [row = ''] = rows(markdown, '| [`PB-AB-003`]').slice(-1);
    expect(row).toContain('| 40 | 40 / 40 | 1 / 1 | 39 / 39 | Not tripped |');
    const [note = ''] = rows(markdown, '- **PB-AB-003**: 2 of 80');
    expect(note).toContain(
      '2 of 80 measured sessions failed (reported, never dropped): under the pre-registered maximum of 10 % of an arm, and the arms failed alike.',
    );
    expect(note).toContain(
      'session 73 of arm A (`page`: the player page did not boot: ReferenceError: shaka is not defined)',
    );
    expect(note).toContain(
      'session 74 of arm B (`timeout`: PB-AB-003 bandwidth-drop-finite B #74 did not finish within 180000 ms)',
    );
    expect(note).not.toContain('http://');
  });

  it('says that PB-AB-003 can only show harm, and that the arms started on different rungs', () => {
    const markdown = render();
    expect(markdown).toContain(
      '- **PB-AB-003** can only show harm: A has 0 of 39 sessions with a rebuffer, and a share cannot fall below 0, so B could be shown worse than A and never better.',
    );
    expect(markdown).not.toContain('**PB-AB-002** can only show harm');
    expect(markdown).toContain(
      '- **PB-AB-003** (`bandwidth-drop-finite`): A started on 720p in 39 sessions, B on 240p in 39 sessions: the arms never started on the same rung, so a startup difference includes the first rung.',
    );
  });

  it('shows each A/A pilot with its splits, and says which could not fail', () => {
    const markdown = render();
    const [startup = ''] = rows(markdown, '| [`PB-AB-001-high-latency`]').slice(-1);
    const calibration = report('PB-AB-001-high-latency').calibrations[0].result;
    expect(startup).toContain(
      `${calibration.falsePositives} of 2,000 (5.00 %); the rate's 95 % interval is 4.09 to 6.05 %`,
    );
    expect(startup).toContain('Pass; the real A/A: Equivalent within the margin (keep A)');
    expect(startup).toContain('Yes: the sessions vary (504 to 806 ms)');
    for (const name of ['PB-AB-001-bandwidth-drop-finite', 'PB-AB-001-bandwidth-drop-finite-40s']) {
      const [row = ''] = rows(markdown, `| [\`${name}\`]`).slice(-1);
      expect(row).toContain("0 of 2,000 (0.00 %); the rate's 95 % interval is 0.00 to 0.18 %");
      expect(row).toContain('No: 0 of 60 sessions with a rebuffer, so no split can be significant');
    }
  });

  it('shows an empty state with no number when there is no report, and when there is only the pipeline check', () => {
    expect(renderAb(new FileSet())).toStrictEqual(emptyState('A/B reports', 'docs/results/ab'));
    expect(emptyState('A/B reports', 'docs/results/ab').markdown).not.toMatch(/\d/);
    const pipeline = real.list('docs/results/ab/pipeline-check', /\.report\.json$/);
    expect(pipeline).toHaveLength(1);
    const only = new FileSet(
      [...pipeline, 'ab/prereg/pipeline-check.json'].map((path) => [path, real.text(path)] as const),
    );
    expect(renderAb(only)).toStrictEqual(emptyState('A/B reports', 'docs/results/ab'));
  });

  it('does not act on the verdict of a run that is not valid', () => {
    const edited = changed(real, reportPath('PB-AB-002'), (r) => {
      r.validity.valid = false;
      r.validity.gates[3].passed = false;
    });
    const [row = ''] = rows(render(edited), '| [`PB-AB-002`]');
    expect(row).toContain('Not acted on: the run is not valid (Equivalent within the margin (keep A))');
    expect(row).toContain('**No**: Condition applied, the same in both arms');
    expect(row).not.toContain('**Equivalent');
  });

  it('refuses what would let an estimate pass for a finding', () => {
    const [check = ''] = real.list('docs/results/ab/pipeline-check', /\.report\.json$/);
    const evidence = changed(real, check, (r) => {
      r.validity.evidence = true;
    });
    expect(() => renderAb(evidence)).toThrow(
      /a run of this kind is evidence and this report says it is not|plumbing only/,
    );
    const unknown = changed(real, reportPath('PB-AB-002'), (r) => {
      r.experiment.kind = 'confirmation';
    });
    expect(() => renderAb(unknown)).toThrow(/\$\.experiment\.kind: unknown kind "confirmation"/);
    const contradicted = changed(real, reportPath('PB-AB-002'), (r) => {
      r.validity.gates[0].passed = false;
    });
    expect(() => renderAb(contradicted)).toThrow(/the report says valid and its gates say otherwise/);
    const wider = changed(real, reportPath('PB-AB-002'), (r) => {
      r.conditions[0].analysis.metrics[0].effect.level = 0.9;
    });
    expect(() => renderAb(wider)).toThrow(
      /expected the 95 % interval that the tables are headed with but found 0.9/,
    );
    const undecided = changed(real, reportPath('PB-AB-003'), (r) => {
      r.conditions[0].analysis.decision = null;
    });
    expect(() => renderAb(undecided)).toThrow(/a pre-registered run has a verdict, and this report has none/);
  });

  it('shows a rule of a plan that it does not know as it is written, and refuses a condition the plan lacks', () => {
    const plan = 'ab/prereg/PB-AB-002.json';
    const edited = changed(real, plan, (r) => {
      r.conditions[0].rules = [{ type: 'status', code: 503 }];
    });
    expect(render(edited)).toContain('`high-latency`: `{"type":"status","code":503}`');
    const renamed = changed(real, plan, (r) => {
      r.conditions[0].id = 'another';
    });
    expect(() => renderAb(renamed)).toThrow(/the plan has no condition "high-latency", which its report ran/);
  });
});
