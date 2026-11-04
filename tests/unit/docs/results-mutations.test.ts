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

  it('keep every block the README shows required, and say which ones the README must hold', () => {
    const required = RESULT_BLOCKS.filter((b) => b.required).map((b) => b.name);
    expect(required).toStrictEqual([
      'RESULTS_CODEC',
      'RESULTS_SUITES',
      'RESULTS_PERF',
      'RESULTS_TRIAGE',
      'RESULTS_JENKINS',
      'RESULTS_FLAKE',
      'RESULTS_READINESS',
      'RESULTS_SOAK',
      'RESULTS_AB',
    ]);
    expect(RESULT_BLOCKS.filter((b) => !b.required)).toStrictEqual([]);
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
    expect(failing(edited)).not.toMatch(/RESULTS_(PERF|TRIAGE|JENKINS|SUITES|FLAKE|READINESS|SOAK)/);
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

  it('catches the paired A/A and the pull-request regression edited, and a triage report of GitHub edited', () => {
    const aa = changed(real, 'docs/results/perf/paired-aa/chromium-aa.json', (r) => {
      r.falsePositives = 1;
    });
    expect(failing(aa)).toMatch(/generated block RESULTS_PERF is out of date/);
    const gate = changed(real, 'docs/results/perf/paired-sensitivity/chromium-cpu4x.json', (r) => {
      r.scenarios[0].metrics[0].remeasure.median.current = 340;
    });
    expect(failing(gate)).toMatch(/generated block RESULTS_PERF is out of date/);
    const triage = changed(real, 'docs/results/triage/ci-demo/triage-report.json', (r) => {
      r.clusters[0].size += 1;
      r.totals.failures += 1;
    });
    expect(failing(triage)).toMatch(/generated block RESULTS_TRIAGE is out of date/);
  });

  it('catches a nightly that stops leaving the readiness tests out, and a performance leg that is gone', () => {
    const nightly = '.github/workflows/nightly.yml';
    const widened = real.with(nightly, real.text(nightly).replace(' --grep-invert "@readiness"', ''));
    expect(widened.text(nightly)).not.toBe(real.text(nightly));
    expect(failing(widened)).toMatch(/generated block RESULTS_SUITES is out of date/);
    const ci = real.text('.github/workflows/ci.yml');
    const wider = real.with(
      '.github/workflows/ci.yml',
      ci.replace('profile: [chromium, chromium-cpu4x]', 'profile: [chromium]'),
    );
    expect(wider.text('.github/workflows/ci.yml')).not.toBe(ci);
    expect(failing(wider)).toMatch(/generated block RESULTS_SUITES is out of date/);
  });

  it('catches a flake history with a repetition taken out, and a readiness result edited by hand', () => {
    const path = 'docs/results/flake/after-fix/abr002-fix/raw/gha-macos-arm64.jsonl';
    const lines = real.text(path).trimEnd().split('\n');
    const fewer = real.with(path, `${lines.slice(1).join('\n')}\n`);
    expect(failing(fewer)).toMatch(/generated block RESULTS_FLAKE is out of date/);
    const result = 'docs/results/soak/gha-linux-x64-webkit-5m.json';
    const edited = real.with(result, real.text(result).replace('"GO"', '"NO-GO"'));
    expect(edited.text(result)).not.toBe(real.text(result));
    expect(failing(edited)).toMatch(
      /generated block RESULTS_SOAK cannot be rendered: .*is not what the job uploaded/,
    );
    expect(failing(edited)).toMatch(
      /generated block RESULTS_READINESS cannot be rendered: .*is not what the job uploaded/,
    );
  });

  it('catches an A/B report edited, an exploratory run given a verdict, and a verdict changed', () => {
    const [experiment = ''] = real.list('docs/results/ab', /^PB-AB-002\..*\.report\.json$/);
    const [exploratory = ''] = real.list('docs/results/ab', /^exploratory-.*\.report\.json$/);
    const [pilot = ''] = real.list('docs/results/ab', /^PB-AB-001-high-latency\..*\.report\.json$/);
    expect(real.text(experiment)).toContain('"verdict": "equivalent"');
    const wider = changed(real, experiment, (r) => {
      r.conditions[0].analysis.metrics[0].effect.high = 60;
    });
    expect(failing(wider)).toMatch(/generated block RESULTS_AB is out of date/);
    const harmed = changed(real, experiment, (r) => {
      r.conditions[0].analysis.decision.headline = 'A better: B is worse than the margin (do not ship B)';
    });
    expect(failing(harmed)).toMatch(/generated block RESULTS_AB is out of date/);
    const decided = changed(real, exploratory, (r) => {
      r.conditions[0].analysis.decision = { headline: 'B better: ship B (ship B)' };
    });
    expect(failing(decided)).toMatch(
      /generated block RESULTS_AB cannot be rendered: .*an exploratory run has no verdict, and this report prints one/,
    );
    const significant = changed(real, pilot, (r) => {
      r.calibrations[0].result.falsePositives = 400;
      r.calibrations[0].result.rate = 0.2;
    });
    expect(failing(significant)).toMatch(/generated block RESULTS_AB is out of date/);
  });

  it('catches an A/B pilot that lost its calibration, sessions that do not add up, and a plan or a report that is gone', () => {
    const [experiment = ''] = real.list('docs/results/ab', /^PB-AB-003\..*\.report\.json$/);
    const [pilot = ''] = real.list('docs/results/ab', /^PB-AB-001-high-latency\..*\.report\.json$/);
    const uncalibrated = changed(real, pilot, (r) => {
      r.calibrations = [];
    });
    expect(failing(uncalibrated)).toMatch(
      /generated block RESULTS_AB cannot be rendered: .*the A\/A pilot has no calibration for the condition "high-latency"/,
    );
    const uneven = changed(real, experiment, (r) => {
      r.conditions[0].analysis.analysed.A = 40;
    });
    expect(failing(uneven)).toMatch(
      /generated block RESULTS_AB cannot be rendered: .*the sessions do not add up/,
    );
    expect(failing(real.without('ab/prereg/PB-AB-003.json'))).toContain(
      'generated block RESULTS_AB cannot be rendered: ab/prereg/PB-AB-003.json: the file is missing',
    );
    expect(failing(real.without(experiment))).toMatch(/generated block RESULTS_AB is out of date/);
  });

  it.each([
    ['RESULTS_SUITES', 'TEST_STRATEGY.md'],
    ['RESULTS_SUITES', 'tools/gate-merge.ts'],
    ['RESULTS_READINESS', 'docs/results/provenance/runs.json'],
    ['RESULTS_SOAK', 'docs/results/provenance/runs.json'],
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
    ['RESULTS_TRIAGE', 'docs/results/triage/ci-demo/triage-report.json'],
    ['RESULTS_PERF', 'docs/results/perf/paired-aa/chromium-aa.json'],
    ['RESULTS_PERF', 'docs/results/perf/paired-sensitivity/chromium.json'],
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
