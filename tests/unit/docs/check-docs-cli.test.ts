import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeScratch } from '../support/scratch.ts';

// The promise of the README's results tables is the exit code of `npm run docs:check`: 1 when a table differs from the files it quotes.
// The unit tests of the generator call its functions; this runs the real command, on a copy of the repository that has been broken the
// way a careless commit breaks it, and looks at what the command says and returns.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.cache', 'dist', 'reports', 'test-results', '.tmp']);
let copy = '';
let readme = '';

function docsCheck(...args: string[]): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'tools/check-docs.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, PB_DOCS_ROOT: copy },
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

/** Runs the command with one file of the copy replaced, and puts the file back. */
function withFile<T>(path: string, text: string | null, run: () => T): T {
  const full = join(copy, path);
  const original = readFileSync(full, 'utf8');
  try {
    if (text === null) rmSync(full);
    else writeFileSync(full, text);
    return run();
  } finally {
    writeFileSync(full, original);
  }
}

describe('PB-LAB-006 docs:check as a command, on a copy of the repository', () => {
  beforeAll(() => {
    copy = makeScratch('docs-check-cli-');
    // The copy lives inside the repository (under .cache), so the repository is copied entry by entry, not as a whole.
    for (const name of readdirSync(ROOT)) {
      if (!SKIP.has(name)) cpSync(join(ROOT, name), join(copy, name), { recursive: true });
    }
    readme = readFileSync(join(copy, 'README.md'), 'utf8');
  }, 60_000);

  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  it('passes on the repository as it is committed', () => {
    const run = docsCheck();
    expect(run.err).toBe('');
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/^docs:check ok /m);
  });

  it('fails, naming the block, when a number of a README table is changed by hand', () => {
    const edited = readme.replace(
      /(\| `local-darwin-arm64` \| `chromium` \| 10 \| )10 \/ 0 \/ 0/,
      '$19 / 0 / 1',
    );
    expect(edited).not.toBe(readme);
    const run = withFile('README.md', edited, () => docsCheck());
    expect(run.status).toBe(1);
    expect(run.err).toContain('README.md: generated block RESULTS_PERF is out of date');
    expect(run.err).toContain('docs:check FAILED (1 problem)');
  });

  it('fails when a committed result changes and the README is not regenerated, and --write repairs it', () => {
    const path = 'docs/results/perf/local-darwin-arm64/chromium-aa.json';
    const file = JSON.parse(readFileSync(join(copy, path), 'utf8')) as { falsePositives: number };
    file.falsePositives = 3;
    const broken = `${JSON.stringify(file, null, 2)}\n`;
    withFile(path, broken, () => {
      const run = docsCheck();
      expect(run.status).toBe(1);
      expect(run.err).toContain('README.md: generated block RESULTS_PERF is out of date');
      const written = docsCheck('--write');
      expect(written.status).toBe(0);
      expect(written.out).toContain('rewrote the generated blocks of README.md');
      expect(docsCheck().status).toBe(0);
      expect(readFileSync(join(copy, 'README.md'), 'utf8')).toContain(
        '| committed baseline, first run | 35 | 3 | one machine |',
      );
      writeFileSync(join(copy, 'README.md'), readme);
    });
  });

  it('checks the generated tables of docs/READINESS.md with the same command, and --write repairs them', () => {
    const path = 'docs/READINESS.md';
    const page = readFileSync(join(copy, path), 'utf8');
    const edited = page.replace(
      '| webkit 27.2 | A | GO | GO | NO-GO | GO | NO-GO |',
      '| webkit 27.2 | A | GO | GO | GO | GO | GO |',
    );
    expect(edited).not.toBe(page);
    withFile(path, edited, () => {
      const run = docsCheck();
      expect(run.status).toBe(1);
      expect(run.err).toContain('docs/READINESS.md: block READINESS_VERDICTS is');
      expect(run.err).toContain('docs:check FAILED (1 problem)');
      const written = docsCheck('--write');
      expect(written.status).toBe(0);
      expect(readFileSync(join(copy, path), 'utf8')).toBe(page);
    });
  });

  it('refuses a readiness result that was edited by hand, in the README and in docs/READINESS.md alike', () => {
    const path = 'docs/results/soak/gha-linux-x64-webkit-5m.json';
    const original = readFileSync(join(copy, path), 'utf8');
    const edited = original.replace('"GO"', '"NO-GO"');
    expect(edited).not.toBe(original);
    const run = withFile(path, edited, () => docsCheck());
    expect(run.status).toBe(1);
    expect(run.err).toMatch(
      /README\.md: generated block RESULTS_SOAK cannot be rendered: .*is not what the job uploaded/,
    );
    expect(run.err).toMatch(
      /docs\/READINESS\.md: the readiness tables cannot be generated \(.*is not what the job uploaded/,
    );
    expect(run.err).not.toMatch(/\n\s+at /);
  });

  it('fails with the name of the file, and no stack trace, when a result file is gone or damaged', () => {
    const missing = withFile('docs/results/perf/threshold-derivation.json', null, () => docsCheck());
    expect(missing.status).toBe(1);
    expect(missing.err).toContain(
      'README.md: generated block RESULTS_PERF cannot be rendered: docs/results/perf/threshold-derivation.json: the file is missing',
    );
    expect(missing.err).not.toMatch(/\n\s+at /);
    const path = 'docs/results/jenkins/build-3.json';
    const damaged = withFile(path, readFileSync(join(copy, path), 'utf8').slice(0, 300), () => docsCheck());
    expect(damaged.status).toBe(1);
    expect(damaged.err).toContain(
      `generated block RESULTS_JENKINS cannot be rendered: ${path}: not valid JSON`,
    );
    expect(damaged.err).not.toMatch(/\n\s+at /);
  });

  it('fails when a required block is taken out of the README', () => {
    const without = readme.replace(/<!-- BEGIN:RESULTS_JENKINS -->[\s\S]*<!-- END:RESULTS_JENKINS -->\n/, '');
    expect(without).not.toBe(readme);
    const run = withFile('README.md', without, () => docsCheck());
    expect(run.status).toBe(1);
    expect(run.err).toMatch(
      /README\.md: generated block RESULTS_JENKINS: markers .* not found; the README must hold it/,
    );
  });

  it('prints one block with --print, and writes nothing', () => {
    const run = docsCheck('--print', 'RESULTS_CODEC');
    expect(run.status).toBe(0);
    expect(run.out).toContain('| Environment | OS | Engine |');
    expect(run.out).not.toContain('RESULTS_PERF');
    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toBe(readme);
  });
});
