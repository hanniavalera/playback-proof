import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReadmeFile } from '../../../tools/check-docs.ts';
import { RESULT_BLOCKS, checkResultBlocks, loadResultFiles } from '../../../tools/results-tables.ts';
import type { FileSet } from '../../../tools/results/files.ts';
import { makeScratch } from '../support/scratch.ts';
import { changed } from '../support/results-files.ts';

// What a careless commit does to the README's results blocks, done to a copy of the real files (or of the README) in memory: a number
// changed, a file deleted or corrupted, a result added that nobody wrote into the README. Each must fail `docs:check`, with a message that
// names the block, the file or the line, and none may crash it.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const real = loadResultFiles(ROOT);
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const failing = (files: FileSet): string => checkResultBlocks(readme, files).problems.join('\n');

describe('PB-LAB-006 results tables: the README and the real files', () => {
  it('are in step: the check finds nothing to fix', () => {
    expect(checkResultBlocks(readme, real).problems).toStrictEqual([]);
  });

  it('keep the blocks that wait for data optional, and the ones the README shows required', () => {
    const required = RESULT_BLOCKS.filter((b) => b.required).map((b) => b.name);
    expect(required).toStrictEqual([
      'RESULTS_CODEC',
      'RESULTS_SUITES',
      'RESULTS_PERF',
      'RESULTS_TRIAGE',
      'RESULTS_JENKINS',
    ]);
    for (const name of required) expect(readme).toContain(`<!-- BEGIN:${name} -->`);
    expect(new Set(RESULT_BLOCKS.map((b) => b.name)).size).toBe(RESULT_BLOCKS.length);
  });
});

describe('PB-LAB-006 results tables: mutation checks on a copy of the real files', () => {
  it('catches a number of the README block changed by hand, and says which line', () => {
    const edited = readme.replace(
      /(\| `local-darwin-arm64` \| `chromium` \| 10 \| )10 \/ 0 \/ 0/,
      '$19 / 0 / 1',
    );
    expect(edited).not.toBe(readme);
    const { problems } = checkResultBlocks(edited, real);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^generated block RESULTS_PERF is out of date \(line \d+ of the block: expected .*10 \/ 0 \/ 0.* but found .*9 \/ 0 \/ 1/,
    );
    expect(problems[0]).toContain('npm run docs:check -- --write');
  });

  it('catches a false-positive count changed in an A/A result', () => {
    const edited = changed(real, 'docs/results/perf/local-darwin-arm64/chromium-aa.json', (r) => {
      r.falsePositives = 1;
    });
    expect(failing(edited)).toMatch(/generated block RESULTS_PERF is out of date/);
  });

  it('catches an attempt that decoded in the probe results and no longer does', () => {
    const edited = changed(real, 'docs/results/codec-matrix/gha-macos-arm64.json', (r) => {
      const result = r.engines.webkit.cases['cmaf-vp9-aac'];
      result.runs[0] = { ok: false, stage: 'play', error: 'Error: invented' };
      result.passes = 4;
      result.reliability = 'intermittent';
      result.failure = { stage: 'play', error: 'Error: invented', count: 1 };
    });
    expect(failing(edited)).toMatch(/generated block RESULTS_CODEC is out of date/);
    expect(failing(edited)).not.toMatch(/RESULTS_(PERF|TRIAGE|JENKINS|SUITES)/);
  });

  it('catches a number of the threshold derivation changed', () => {
    const edited = changed(real, 'docs/results/perf/threshold-derivation.json', (r) => {
      r.needs[0].share.median = 0.5;
    });
    expect(failing(edited)).toMatch(/generated block RESULTS_PERF is out of date/);
  });

  it('catches a baseline recorded again without deriving the thresholds again', () => {
    const edited = changed(real, 'perf/baselines/local-darwin-arm64/chromium.json', (r) => {
      r.generatedAt = '2026-12-01T00:00:00.000Z';
    });
    expect(failing(edited)).toMatch(
      /RESULTS_PERF cannot be rendered: .*threshold-derivation\.json: was derived from perf\/baselines\/local-darwin-arm64\/chromium\.json .*run `npx tsx perf\/derive\.ts`/,
    );
  });

  it('catches a number of a triage source changed, and a Jenkins stage duration changed', () => {
    const triage = changed(real, 'docs/results/triage/triage-report.json', (r) => {
      r.sources[0].failed += 1;
    });
    expect(failing(triage)).toMatch(/generated block RESULTS_TRIAGE is out of date/);
    const jenkins = changed(real, 'docs/results/jenkins/build-3.json', (r) => {
      r.stages[0].durationMs += 60_000;
    });
    expect(failing(jenkins)).toMatch(/generated block RESULTS_JENKINS is out of date/);
  });

  it('catches a new build, a leg taken out of a workflow, and a test that no catalog row names', () => {
    const build = real.with(
      'docs/results/jenkins/build-7.json',
      JSON.stringify({ ...(JSON.parse(real.text('docs/results/jenkins/build-3.json')) as object), build: 7 }),
    );
    expect(failing(build)).toMatch(/generated block RESULTS_JENKINS is out of date/);
    const workflow = real.text('.github/workflows/ci.yml');
    const leg = workflow.indexOf('          - leg: firefox');
    const next = workflow.indexOf('          - leg: chromium-cpu4x');
    expect(leg).toBeGreaterThan(0);
    expect(next).toBeGreaterThan(leg);
    const fewer = real.with('.github/workflows/ci.yml', workflow.slice(0, leg) + workflow.slice(next));
    expect(failing(fewer)).toMatch(/generated block RESULTS_SUITES is out of date/);
    const spec = real.text('tests/e2e/vod-start.spec.ts');
    const extra = real.with(
      'tests/e2e/vod-start.spec.ts',
      `${spec}\ntest('PB-VOD-099 invented', async () => {});\n`,
    );
    expect(failing(extra)).toMatch(/RESULTS_SUITES cannot be rendered: the specs and the catalog disagree/);
  });

  it.each([
    ['RESULTS_SUITES', 'TEST_STRATEGY.md'],
    ['RESULTS_PERF', 'docs/results/perf/threshold-derivation.json'],
    ['RESULTS_TRIAGE', 'docs/results/triage/triage-report.json'],
    ['RESULTS_JENKINS', 'Jenkinsfile'],
  ])('says which file is missing when %s loses %s, and does not crash', (name, path) => {
    const message = failing(real.without(path));
    expect(message).toContain(`generated block ${name} cannot be rendered: ${path}: the file is missing`);
  });

  it('says that the derivation covers a baseline that is no longer committed', () => {
    const message = failing(real.without('perf/baselines/local-darwin-arm64/webkit.json'));
    expect(message).toContain(
      'threshold-derivation.json: covers perf/baselines/local-darwin-arm64/webkit.json, which is not committed',
    );
  });

  it('shows a stale table, and no crash, when one probe result is deleted', () => {
    const message = failing(real.without('docs/results/codec-matrix/gha-linux-x64.json'));
    expect(message).toMatch(/^generated block RESULTS_CODEC is out of date/);
    expect(message).not.toMatch(/cannot be rendered/);
  });

  it.each([
    ['RESULTS_CODEC', 'docs/results/codec-matrix/gha-linux-x64.json'],
    ['RESULTS_PERF', 'perf/baselines/docker-linux-arm64/firefox.json'],
    ['RESULTS_PERF', 'docs/results/perf/threshold-derivation.json'],
    ['RESULTS_TRIAGE', 'docs/results/triage/triage-report.json'],
    ['RESULTS_JENKINS', 'docs/results/jenkins/build-4.json'],
  ])('says which file is not JSON when %s reads a truncated %s', (name, path) => {
    const message = failing(real.with(path, real.text(path).slice(0, 200)));
    expect(message).toContain(`generated block ${name} cannot be rendered: ${path}: not valid JSON`);
  });

  it('says which schema it cannot read', () => {
    const edited = changed(real, 'docs/results/jenkins/build-2.json', (r) => {
      r.schemaVersion = 2;
    });
    expect(failing(edited)).toMatch(/build-2\.json: \$\.schemaVersion: this renderer reads schema version 1/);
  });

  it('insists on a required block that was taken out of the README, and on one that is duplicated', () => {
    const without = readme.replace(/<!-- BEGIN:RESULTS_TRIAGE -->[\s\S]*<!-- END:RESULTS_TRIAGE -->\n/, '');
    expect(without).not.toBe(readme);
    const missing = checkResultBlocks(without, real).problems;
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(
      /generated block RESULTS_TRIAGE: markers .* not found; the README must hold it/,
    );
    const twice = checkResultBlocks(
      `${readme}\n<!-- BEGIN:RESULTS_TRIAGE -->\n<!-- END:RESULTS_TRIAGE -->\n`,
      real,
    ).problems;
    expect(twice.join('\n')).toMatch(/RESULTS_TRIAGE: expected exactly one .* found 2 and 2/);
  });
});

describe('PB-LAB-006 results tables: docs:check on a README on disk', () => {
  it('fails when there is no README', () => {
    const root = makeScratch('results-readme-');
    try {
      expect(checkReadmeFile(root, false).problems).toStrictEqual(['README.md: the file is missing']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites the blocks it can render with --write, reports the ones it cannot, and leaves the rest of the file alone', () => {
    const root = makeScratch('results-readme-');
    try {
      const blocks = RESULT_BLOCKS.filter((b) => b.required).map(
        (b) => `<!-- BEGIN:${b.name} -->\nstale\n<!-- END:${b.name} -->`,
      );
      writeFileSync(join(root, 'README.md'), `# README\n\nintro\n\n${blocks.join('\n\n')}\n\noutro\n`);
      const before = readFileSync(join(root, 'README.md'), 'utf8');

      const checked = checkReadmeFile(root, false);
      expect(checked.problems.some((p) => p.includes('RESULTS_CODEC is out of date'))).toBe(true);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before);

      const written = checkReadmeFile(root, true);
      expect(written.rewrote).toBe(true);
      const after = readFileSync(join(root, 'README.md'), 'utf8');
      expect(after).toContain('_No codec probe results are committed yet (`docs/results/codec-matrix`)');
      expect(after.startsWith('# README\n\nintro\n')).toBe(true);
      expect(after.endsWith('\noutro\n')).toBe(true);
      // Nothing to read in an empty directory: the suites block says which file is missing and keeps its old text.
      expect(written.problems.join('\n')).toContain(
        'RESULTS_SUITES cannot be rendered: TEST_STRATEGY.md: the file is missing',
      );
      expect(after).toContain('<!-- BEGIN:RESULTS_SUITES -->\nstale\n');
      expect(checkReadmeFile(root, true).rewrote).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
