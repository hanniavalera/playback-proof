import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import playwrightConfig from '../../../playwright.config.ts';
import { defaultCacheDir } from '../../../src/server/media/cache.ts';
import {
  ROOT,
  WORKFLOW_DIR,
  allFiles,
  code,
  jobsOf,
  legsOf,
  read,
  workflowFiles,
  type Leg,
} from '../support/ci-files.ts';

// The workflows cannot run here, so these tests check what can be checked without GitHub: the policies the documentation states
// (docs/CI.md, ADR-110 to ADR-114), and the places where two files must agree and a typo would only show up as a red run
// (the legs against the Playwright config, the cache key against what the generator imports, the artifact names, the npm scripts).
// The files are read as text: the repository has no YAML parser, and the formats here are the ones Prettier writes.

const ci = read(`${WORKFLOW_DIR}/ci.yml`);
const nightly = read(`${WORKFLOW_DIR}/nightly.yml`);
const streamsWorkflow = read(`${WORKFLOW_DIR}/streams.yml`);
const setupAction = read('.github/actions/setup/action.yml');
const mergeGate = jobsOf(ci).get('merge-gate') ?? '';
const release = jobsOf(nightly).get('release') ?? '';

describe('the policies of every workflow', () => {
  it('uses only GitHub-owned actions pinned to a major tag, or a local file that exists', () => {
    const refs = allFiles.flatMap((file) =>
      [...code(read(file)).matchAll(/^\s*(?:- )?uses:\s*(\S+)\s*$/gm)].map((m) => ({
        file,
        ref: m[1] ?? '',
      })),
    );
    expect(refs.length).toBeGreaterThan(10);
    for (const { file, ref } of refs) {
      if (ref.startsWith('./')) {
        expect(
          existsSync(join(ROOT, ref)) || existsSync(join(ROOT, ref, 'action.yml')),
          `${file}: ${ref}`,
        ).toBe(true);
      } else {
        expect(ref, `${file}: third-party or unpinned action`).toMatch(/^actions\/[a-z-]+(\/[a-z-]+)?@v\d+$/);
      }
    }
  });

  it('gives every job that runs steps a timeout, and lets no job fail quietly', () => {
    for (const name of workflowFiles) {
      const text = read(`${WORKFLOW_DIR}/${name}`);
      const jobs = jobsOf(text);
      expect(jobs.size, `${name}: no jobs found`).toBeGreaterThan(0);
      for (const [id, job] of jobs) {
        if (/^ {4}uses:/m.test(job)) continue; // a call of a reusable workflow: its own file has the timeout
        expect(job, `${name}: job ${id} has no timeout`).toMatch(/^ {4}timeout-minutes: \S+/m);
      }
    }
    for (const file of allFiles) {
      expect(code(read(file)), `${file}: continue-on-error`).not.toContain('continue-on-error');
    }
  });

  it('asks for read access to the contents at the top, for write access in no job but flake-record, and never as pull_request_target', () => {
    for (const name of workflowFiles) {
      const text = code(read(`${WORKFLOW_DIR}/${name}`));
      expect(text, `${name}: top-level permissions`).toMatch(/^permissions:\n {2}contents: read\n/m);
      expect(
        text.slice(0, text.indexOf('\njobs:\n')),
        `${name}: a write permission above the jobs`,
      ).not.toMatch(/:\s*write\b/);
      for (const [id, job] of jobsOf(text)) {
        const writes = (job.match(/^\s*[\w-]+:\s*write\b.*$/gm) ?? []).map((line) => line.trim());
        expect(writes, `${name}: job ${id}`).toEqual(id === 'flake-record' ? ['contents: write'] : []);
      }
      expect(text, `${name}: pull_request_target runs untrusted code with a token`).not.toContain(
        'pull_request_target',
      );
      expect(text, `${name}: the lab needs no secret`).not.toMatch(/secrets\./);
    }
  });

  it('cancels a superseded pull request run, and nothing else, in the gate and in the nightly alike', () => {
    for (const workflow of [ci, nightly]) {
      expect(workflow).toMatch(
        /^concurrency:\n {2}group: [a-z]+-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m,
      );
    }
  });

  it('runs the nightly on a pull request only when the pull request changes the nightly itself', () => {
    expect(nightly).toMatch(/^ {2}pull_request:\n {4}paths:\n {6}- \.github\/workflows\/nightly\.yml\n/m);
  });
});

describe('the stages', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('are npm scripts that exist, and ci.yml calls the gate stages listed here (parity.test.ts compares them with the Jenkinsfile)', () => {
    const called = allFiles.flatMap((file) =>
      [...code(read(file)).matchAll(/npm run ([\w:.-]+)/g)].map((m) => ({ file, script: m[1] ?? '' })),
    );
    expect(called.length).toBeGreaterThan(5);
    for (const { file, script } of called)
      expect(scripts[script], `${file}: npm run ${script}`).toBeDefined();
    // Only the stages that exist: a stage whose script is not there yet (perf) is not a job yet.
    const stages = new Set([...code(ci).matchAll(/npm run (gate:[\w-]+)/g)].map((m) => m[1] ?? ''));
    expect(stages).toEqual(new Set(['gate:static', 'gate:unit', 'gate:merge', 'gate:flake', 'gate:triage']));
  });

  it('call gate:static, gate:unit and gate:merge from the merge gate, with the project of the leg and its time limit', () => {
    expect(ci).toContain('run: npm run gate:static');
    expect(ci).toContain('run: npm run gate:unit');
    expect(mergeGate).toContain(
      'run: npm run gate:merge -- --project=${{ matrix.project }} --global-timeout=${{ matrix.limit }}',
    );
  });

  it('give the nightly one run for both tiers, because two runs would overwrite each other’s report', () => {
    expect(release).toContain(
      '--grep "@merge|@release" --grep-invert "@readiness" --project=${{ matrix.project }} --global-timeout=${{ matrix.limit }}',
    );
    expect(release.match(/npm run test:e2e/g)).toHaveLength(1);
  });
});

describe('the browser matrix', () => {
  const projects = new Map((playwrightConfig.projects ?? []).map((p) => [p.name ?? '', p]));
  const mergeLegs = legsOf(mergeGate);
  const nightlyLegs = legsOf(release);

  it('has the five legs of the decision, in the merge gate and in the nightly alike', () => {
    expect(mergeLegs.map((l) => l.leg)).toEqual([
      'chromium',
      'firefox',
      'chromium-cpu4x',
      'webkit-linux',
      'webkit-macos',
    ]);
    const withoutTimes = (legs: Leg[]) => legs.map(({ timeout: _timeout, limit: _limit, ...rest }) => rest);
    expect(withoutTimes(nightlyLegs)).toEqual(withoutTimes(mergeLegs));
  });

  it('gives the three-CPU macOS runner one worker, in the merge gate and in the nightly alike', () => {
    for (const job of [mergeGate, release]) {
      expect(job).toMatch(/- leg: webkit-macos\n(?: {12}[a-z]+: .+\n)*? {12}workers: 1\n/);
      expect(job).toContain('PB_WORKERS: ${{ matrix.workers || 2 }}');
    }
  });

  it('marks Linux WebKit as the one experimental leg, in its name', () => {
    expect(mergeLegs.filter((l) => l.experimental).map((l) => l.leg)).toEqual(['webkit-linux']);
    for (const job of [mergeGate, release]) {
      expect(job).toContain("${{ matrix.experimental && ', experimental' || '' }}");
    }
  });

  it('runs every leg on a project of the Playwright config, with the browser that project drives', () => {
    for (const leg of mergeLegs) {
      const project = projects.get(leg.project);
      expect(project, `${leg.leg}: no Playwright project named ${leg.project}`).toBeDefined();
      expect(project?.use?.defaultBrowserType, `${leg.leg}: browser`).toBe(leg.browser);
    }
  });

  it('leaves no project of the config out of CI', () => {
    expect([...projects.keys()].sort()).toEqual([...new Set(mergeLegs.map((l) => l.project))].sort());
  });

  it('puts WebKit on a macOS runner and everything else on the Linux runner of the committed evidence', () => {
    for (const leg of mergeLegs) {
      expect(leg.runner, leg.leg).toBe(leg.leg === 'webkit-macos' ? 'macos-15' : 'ubuntu-24.04');
    }
  });

  it('gives the slower macOS runner a longer timeout than Linux, and the nightly longer than the merge gate', () => {
    const timeout = (legs: Leg[], name: string) => legs.find((l) => l.leg === name)?.timeout ?? 0;
    for (const leg of mergeLegs) {
      expect(leg.timeout, leg.leg).toBeGreaterThan(0);
      expect(timeout(nightlyLegs, leg.leg), leg.leg).toBeGreaterThan(leg.timeout);
    }
    expect(timeout(mergeLegs, 'webkit-macos')).toBeGreaterThan(timeout(mergeLegs, 'chromium'));
  });

  it('makes Playwright stop, and write its report, before the runner kills the job', () => {
    const SETUP_AND_UPLOAD_MINUTES = 3;
    for (const leg of [...mergeLegs, ...nightlyLegs]) {
      expect(leg.limit, `${leg.leg}: no limit`).toBeGreaterThan(0);
      expect(
        leg.limit,
        `${leg.leg}: the limit leaves no time for the setup and the upload`,
      ).toBeLessThanOrEqual((leg.timeout - SETUP_AND_UPLOAD_MINUTES) * 60_000);
    }
  });
});

describe('the streams shared by the jobs', () => {
  /** Every file the stream generator reaches through its imports (the files, relative to the repository root). */
  function importClosure(entry: string): string[] {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gms)) {
        const spec = m[1] ?? '';
        if (spec.startsWith('.')) visit(relative(ROOT, join(ROOT, dirname(file), spec)));
      }
    };
    visit(entry);
    return [...seen].sort();
  }

  const hashed = [...(/hashFiles\(([^)]*)\)/.exec(streamsWorkflow)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1] ?? '',
  );
  const covered = (file: string): boolean =>
    hashed.some((pattern) =>
      pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern,
    );

  it('are cached under a key that hashes every file the generator imports', () => {
    const closure = importClosure('tools/generate-streams.ts');
    expect(closure).toContain('src/server/media/specs.ts');
    expect(closure).toContain('src/server/media/generate.ts');
    expect(hashed.length).toBeGreaterThan(0);
    const missed = closure.filter((file) => !covered(file));
    expect(
      missed,
      'a file the generator imports is not in the cache key: add it to hashFiles() in streams.yml',
    ).toEqual([]);
    for (const pattern of hashed) {
      const path = join(ROOT, pattern.replace(/\/\*\*$/, ''));
      expect(existsSync(path), `hashFiles('${pattern}') matches nothing`).toBe(true);
      expect(pattern.endsWith('/**') ? statSync(path).isDirectory() : statSync(path).isFile()).toBe(true);
    }
  });

  it('are cached under a key that names the ffmpeg major the job declares and the one it checks', () => {
    const declared = /FFMPEG_MAJOR: '(\d+)'/.exec(streamsWorkflow)?.[1];
    expect(declared).toBeDefined();
    expect(streamsWorkflow).toContain('ffmpeg${{ env.FFMPEG_MAJOR }}');
    expect(streamsWorkflow).toContain('"ffmpeg version ${FFMPEG_MAJOR}."*)');
  });

  it('are published and downloaded under one name, to where the service looks for them', () => {
    const published = /uses: actions\/upload-artifact@v\d+\n\s+with:\n\s+name: (\S+)\n\s+path: (\S+)/.exec(
      streamsWorkflow,
    );
    const downloaded = /uses: actions\/download-artifact@v\d+\n\s+with:\n\s+name: (\S+)\n\s+path: (\S+)/.exec(
      setupAction,
    );
    expect(published?.[1]).toBeDefined();
    expect(downloaded?.[1]).toBe(published?.[1]);
    expect(published?.[2]).toBe(relative(ROOT, defaultCacheDir()));
    expect(downloaded?.[2]).toBe(published?.[2]);
  });

  it('are built once: the browser jobs need the streams job and install no ffmpeg', () => {
    for (const job of [mergeGate, release]) {
      expect(job).toMatch(/^ {4}needs: streams$/m);
      expect(code(job)).not.toMatch(/ffmpeg: 'true'|apt-get|brew /);
    }
    expect(ci).toMatch(/^ {2}streams:\n {4}name: streams\n {4}uses: \.\/\.github\/workflows\/streams\.yml$/m);
    expect(nightly).toMatch(
      /^ {2}streams:\n {4}name: streams\n {4}uses: \.\/\.github\/workflows\/streams\.yml$/m,
    );
  });
});

describe('the reports that later phases read', () => {
  it('are uploaded from every browser job, also when a step failed, under the name reports-<leg>', () => {
    for (const job of [mergeGate, release]) {
      const upload =
        /- name: Upload the reports[^\n]*\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@v\d+\n\s+with:\n\s+name: (.+)\n\s+path: \|\n\s+reports\n\s+test-results\n/.exec(
          job,
        );
      expect(upload?.[1], 'the upload of reports/ and test-results/').toBe('reports-${{ matrix.leg }}');
    }
  });

  it('are summarised on the job page, also when the tests failed, and the summary names the artifact that is uploaded', () => {
    for (const job of [mergeGate, release]) {
      const summary =
        /- name: Summarise the run\n\s+if: \$\{\{ always\(\) && steps\.setup\.outcome == 'success' \}\}\n\s+run: npx tsx tools\/ci-summary\.ts (.+)\n/.exec(
          job,
        );
      expect(summary?.[1], 'the step that writes the summary').toContain(
        '--artifact reports-${{ matrix.leg }}',
      );
      expect(job).toMatch(/^ {6}- name: [^\n]+\n {8}id: setup\n {8}uses: \.\/\.github\/actions\/setup$/m);
    }
  });
});
