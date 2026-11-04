import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import playwrightConfig from '../../../playwright.config.ts';
import { defaultCacheDir } from '../../../src/server/media/cache.ts';

// The workflows cannot run here, so these tests check what can be checked without GitHub: the policies the documentation states
// (docs/CI.md, ADR-110 to ADR-114), and the places where two files must agree and a typo would only show up as a red run
// (the legs against the Playwright config, the cache key against what the generator imports, the artifact names, the npm scripts).
// The files are read as text: the repository has no YAML parser, and the formats here are the ones Prettier writes.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const WORKFLOW_DIR = '.github/workflows';
const workflowFiles = readdirSync(join(ROOT, WORKFLOW_DIR))
  .filter((name) => name.endsWith('.yml'))
  .sort();
const actionFiles = readdirSync(join(ROOT, '.github/actions'))
  .map((name) => `.github/actions/${name}/action.yml`)
  .filter((path) => existsSync(join(ROOT, path)));
const allFiles = [...workflowFiles.map((name) => `${WORKFLOW_DIR}/${name}`), ...actionFiles];

/** The file without its comment lines: a rule must not trip over the sentence that explains it. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

/** The text of each job under `jobs:`, by job id (a job id is a key indented by two spaces). */
function jobsOf(workflow: string): Map<string, string> {
  const marker = '\njobs:\n';
  const start = workflow.indexOf(marker);
  if (start < 0) return new Map();
  const body = workflow.slice(start + marker.length);
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
  const jobs = new Map<string, string>();
  heads.forEach((head, i) => {
    jobs.set(head[1] ?? '', body.slice(head.index, heads[i + 1]?.index ?? body.length));
  });
  return jobs;
}

interface Leg {
  leg: string;
  project: string;
  browser: string;
  runner: string;
  experimental: boolean;
  timeout: number;
}

/** The `matrix.include` entries of a job: each starts with `- leg:` and its other keys are indented by twelve spaces. */
function legsOf(job: string): Leg[] {
  const include = job.slice(Math.max(job.indexOf('include:'), 0));
  return include
    .split(/^ {10}- leg: /m)
    .slice(1)
    .map((entry) => {
      const lines = entry.split('\n');
      const fields = new Map<string, string>([['leg', (lines[0] ?? '').trim()]]);
      for (const line of lines.slice(1)) {
        const field = /^ {12}([a-z]+): (.+)$/.exec(line);
        if (!field) break;
        fields.set(field[1] ?? '', (field[2] ?? '').trim());
      }
      return {
        leg: fields.get('leg') ?? '',
        project: fields.get('project') ?? '',
        browser: fields.get('browser') ?? '',
        runner: fields.get('runner') ?? '',
        experimental: fields.get('experimental') === 'true',
        timeout: Number(fields.get('timeout')),
      };
    });
}

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

  it('asks for read access to the contents and nothing else, runs pull requests without secrets, and never as pull_request_target', () => {
    for (const name of workflowFiles) {
      const text = code(read(`${WORKFLOW_DIR}/${name}`));
      expect(text, `${name}: top-level permissions`).toMatch(/^permissions:\n {2}contents: read\n/m);
      expect(text, `${name}: a write permission`).not.toMatch(/:\s*write\b/);
      expect(text, `${name}: pull_request_target runs untrusted code with a token`).not.toContain(
        'pull_request_target',
      );
      expect(text, `${name}: the lab needs no secret`).not.toMatch(/secrets\./);
    }
  });

  it('cancels a superseded pull request run, and nothing else', () => {
    expect(ci).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    expect(nightly).toMatch(/cancel-in-progress: false/);
  });
});

describe('the stages', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('are npm scripts that exist, and the gate stages are the ones the Jenkinsfile calls', () => {
    const called = allFiles.flatMap((file) =>
      [...code(read(file)).matchAll(/npm run ([\w:.-]+)/g)].map((m) => ({ file, script: m[1] ?? '' })),
    );
    expect(called.length).toBeGreaterThan(5);
    for (const { file, script } of called)
      expect(scripts[script], `${file}: npm run ${script}`).toBeDefined();
    // Only the stages that exist: a stage whose script is not there yet (perf, flake, triage) is not a job yet.
    const stages = new Set([...code(ci).matchAll(/npm run (gate:[\w-]+)/g)].map((m) => m[1] ?? ''));
    expect(stages).toEqual(new Set(['gate:static', 'gate:unit', 'gate:merge']));
  });

  it('call gate:static, gate:unit and gate:merge from the merge gate, with the project of the leg', () => {
    expect(ci).toContain('run: npm run gate:static');
    expect(ci).toContain('run: npm run gate:unit');
    expect(mergeGate).toContain('run: npm run gate:merge -- --project=${{ matrix.project }}');
  });

  it('give the nightly one run for both tiers, because two runs would overwrite each other’s report', () => {
    expect(release).toContain('--grep "@merge|@release" --project=${{ matrix.project }}');
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
    const withoutTimeout = (legs: Leg[]) => legs.map(({ timeout: _timeout, ...rest }) => rest);
    expect(withoutTimeout(nightlyLegs)).toEqual(withoutTimeout(mergeLegs));
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
});
