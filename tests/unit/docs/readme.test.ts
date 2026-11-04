import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReadmeFile } from '../../../tools/check-docs.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { RESULT_BLOCKS, loadResultFiles } from '../../../tools/results-tables.ts';
import { readCollections } from '../../../tools/results/flake.ts';
import { fixed as digits } from '../../../tools/results/format.ts';
import { parseLegs, parsePerfLegs } from '../../../tools/results/suites.ts';
import { configFor, flattenPatch } from '../../../src/player/configs.ts';
import { parseResultFile } from '../../../src/lab/probe/report.ts';
import type { Loose } from '../support/results-files.ts';

// README.md is read by people who clone the repository and run what it says. These tests keep it from rotting: its structure, its links
// and anchors, the repository paths and npm scripts it names, the ADRs it cites, and the sentences of its prose that stand on a result
// file or on the state of the repository (each says which). A prose claim that the data no longer supports fails here, and the message
// says which sentence to change.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const readme = read('README.md');
const real = loadResultFiles(ROOT);
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The text of the README with its fenced code blocks taken out (they hold commands and diagrams, not prose). */
const prose = readme.replace(/```[\s\S]*?```/g, '');

/** GitHub's anchor for a heading: lower case, punctuation removed, spaces to hyphens. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

const headingsOf = (markdown: string): string[] =>
  [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1] ?? ''));

/** Paths that commands create: they exist after the steps of the quick start, not in a clone. */
const RUNTIME_PATHS = ['dist/player', '.cache/streams', 'reports/html', 'reports/playwright.json', '.cache'];

const REPO_PATH =
  /^(?:\.github|docs|src|tests|tools|perf|flake|triage|live|ab|jenkins|dist|reports|\.cache)(?:\/|$)/;
const ROOT_FILES = new Set([
  'package.json',
  'Jenkinsfile',
  'README.md',
  'TEST_STRATEGY.md',
  'playwright.config.ts',
  'docker-compose.yml',
  'LICENSE',
  '.nvmrc',
]);

/** Inline code spans of the prose that name a path of the repository (a wildcard or a placeholder stands for "something in this directory"). */
function repoPaths(markdown: string): string[] {
  const spans = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');
  return [
    ...new Set(
      spans
        .filter((s) => !/\s/.test(s) && (REPO_PATH.test(s) || ROOT_FILES.has(s)))
        .map((s) => s.replace(/[*<{].*$/, '').replace(/\/+$/, ''))
        .filter((s) => s !== ''),
    ),
  ];
}

describe('PB-LAB-006 README: structure', () => {
  it('has the sections of the brief, in order', () => {
    const h2 = [...prose.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2).toStrictEqual([
      'What this proves',
      'Architecture',
      'Quick start',
      'How to run everything',
      'Real results',
      'Design decisions worth defending',
      'Limitations and honesty notes',
      'Repository layout',
      'Documentation index',
      'License',
    ]);
    expect(readme.startsWith('# Playback Proof\n')).toBe(true);
  });

  it('holds every required results block, once each, under "Real results"', () => {
    const start = readme.indexOf('\n## Real results\n');
    const end = readme.indexOf('\n## Design decisions worth defending\n');
    const section = readme.slice(start, end);
    for (const block of RESULT_BLOCKS.filter((b) => b.required)) {
      expect(readme.split(`<!-- BEGIN:${block.name} -->`)).toHaveLength(2);
      expect(section, block.name).toContain(`<!-- BEGIN:${block.name} -->`);
    }
  });

  it('is in step with the committed results: nothing generated is stale', () => {
    expect(checkReadmeFile(ROOT, false).problems).toStrictEqual([]);
  });

  it('uses no HTML beyond the markers of generated blocks, and leaves nothing to fill in', () => {
    // A placeholder such as `<project>` inside a code span is text, not a tag.
    const outsideCode = prose.replace(/`[^`\n]*`/g, '');
    const html = [...outsideCode.matchAll(/<\/?[A-Za-z][^>\n]*>/g)].map((m) => m[0]);
    expect(html).toStrictEqual([]);
    const comments = [...outsideCode.matchAll(/<!--(.*?)-->/g)].map((m) => (m[1] ?? '').trim());
    expect(comments.length).toBeGreaterThan(0);
    for (const comment of comments) expect(comment).toMatch(/^(BEGIN|END):RESULTS_[A-Z]+$/);
    expect(readme).not.toMatch(/\b(TODO|TBD|FIXME|XXX|BUILD_TIME|lorem)\b/i);
  });
});

describe('PB-LAB-006 README: links, paths and scripts', () => {
  it('has an anchor for every link inside the page, and for every link to a heading of another document', () => {
    const own = new Set(headingsOf(readme));
    const links = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');
    const checked: string[] = [];
    for (const link of links) {
      if (/^[a-z]+:/i.test(link) || !link.includes('#')) continue;
      const [file, fragment = ''] = link.split('#');
      const known = file === '' ? own : new Set(headingsOf(read(file ?? '')));
      expect(known.has(fragment), `${link}: no heading with this anchor`).toBe(true);
      checked.push(link);
    }
    expect(checked.length).toBeGreaterThan(5);
  });

  it('names only paths that exist, apart from those a command creates', () => {
    const missing = repoPaths(prose).filter(
      (path) => !existsSync(join(ROOT, path)) && !RUNTIME_PATHS.includes(path),
    );
    expect(missing).toStrictEqual([]);
  });

  it('runs only npm scripts that exist, and lists every script of package.json', () => {
    const named = new Set([...prose.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1] ?? ''));
    const scripts = Object.keys(pkg.scripts);
    expect([...named].filter((name) => !scripts.includes(name))).toStrictEqual([]);
    expect(scripts.filter((name) => !named.has(name))).toStrictEqual([]);
  });

  it('cites only ADRs that exist, and links each one to the file that holds it', () => {
    const decisions = readdirSync(join(ROOT, 'docs/decisions')).map((f) => `docs/decisions/${f}`);
    const headings = new Map<string, string>();
    for (const file of [...decisions, 'docs/DESIGN_DECISIONS.md']) {
      for (const m of read(file).matchAll(/^## ADR-(\d+[a-z]?):/gm)) headings.set(m[1] ?? '', file);
    }
    for (const m of prose.matchAll(/ADR-(\d+[a-z]?)/g)) {
      expect(headings.has(m[1] ?? ''), `ADR-${m[1]} is cited but no document has it`).toBe(true);
    }
    for (const m of prose.matchAll(/\[ADR-(\d+[a-z]?)\]\(([^)#\s]+)/g)) {
      expect(headings.get(m[1] ?? ''), `[ADR-${m[1]}] is linked to ${m[2]}`).toBe(m[2]);
    }
  });

  it('indexes every document of the repository: the root documents, docs/ and the decisions', () => {
    const documents = [
      'TEST_STRATEGY.md',
      'jenkins/README.md',
      'docs/results/triage/README.md',
      ...readdirSync(join(ROOT, 'docs'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => `docs/${f}`),
      ...readdirSync(join(ROOT, 'docs/decisions')).map((f) => `docs/decisions/${f}`),
    ];
    const index = readme.slice(readme.indexOf('\n## Documentation index\n'));
    for (const path of documents) expect(index, path).toContain(`(${path})`);
  });

  it('draws a diagram that is well formed: quoted labels, balanced subgraphs, edges between nodes that exist', () => {
    const diagram = (/```mermaid\n([\s\S]*?)```/.exec(readme)?.[1] ?? '').split('\n');
    expect(diagram[0]).toBe('flowchart LR');
    const subgraphs = diagram.filter((l) => /^\s*subgraph /.test(l)).length;
    expect(diagram.filter((l) => /^\s*end\s*$/.test(l)).length).toBe(subgraphs);
    const nodes = new Set<string>();
    for (const line of diagram) {
      for (const m of line.matchAll(/(?:^|[\s>-])([A-Za-z][A-Za-z0-9_]*)(\[\("|\["|\[\()/g))
        nodes.add(m[1] ?? '');
      const sub = /^\s*subgraph ([A-Za-z][A-Za-z0-9_]*)\[/.exec(line);
      if (sub) nodes.add(sub[1] ?? '');
      expect(line, 'a label is not quoted').not.toMatch(/\[(?!")(?!\()[^\]]*\]/);
    }
    for (const line of diagram) {
      const edge =
        /^\s*([A-Za-z][A-Za-z0-9_]*)(?:\[[^\n]*?\])?\s*(<?[-=.]+>?)(?:\|"[^"]*"\|)?\s*([A-Za-z][A-Za-z0-9_]*)/.exec(
          line,
        );
      if (!edge || !/[>]/.test(edge[2] ?? '')) continue;
      expect(nodes.has(edge[1] ?? ''), `${line}: ${edge[1]} is not declared`).toBe(true);
      expect(nodes.has(edge[3] ?? ''), `${line}: ${edge[3]} is not declared`).toBe(true);
    }
    expect(nodes.size).toBeGreaterThan(10);
  });
});

describe('PB-LAB-006 README: the prose against the files it stands on', () => {
  const matrix = real
    .list('docs/results/codec-matrix', /^[^/]+\.json$/)
    .map((path) => parseResultFile(real.text(path), path));
  const catalog = parseCatalog(real.text('TEST_STRATEGY.md'));

  it('states the stack the repository has (README, first lines)', () => {
    expect(pkg.dependencies['shaka-player']).toBe('5.3.3');
    expect(pkg.devDependencies['@playwright/test']).toBe('1.64.1');
    expect(pkg.devDependencies.vitest).toMatch(/^\^?5\./);
    expect(pkg.engines.node).toBe('>=22.13.0');
    expect(read('.nvmrc').trim()).toBe('22');
    expect(readme).toContain('Node.js 22.13 or newer');
  });

  it('is under the license it names', () => {
    expect(read('LICENSE')).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Hannia Valera/);
  });

  it('says Linux WebKit does not decode every attempt of the lab flavours where macOS WebKit decodes all, some in the Playwright image and none on the GitHub runner, and that isTypeSupported says yes (Findings)', () => {
    const primary = ['cmaf-vp9-aac', 'webm-vp9-opus'];
    const webkit = matrix.flatMap((file) => {
      const engine = file.engines.webkit;
      return engine && !('launchFailed' in engine) ? [{ file, engine }] : [];
    });
    const linux = webkit.filter(({ file }) => file.host.os.platform === 'linux');
    const mac = webkit.filter(({ file }) => file.host.os.platform === 'darwin');
    expect(linux.length).toBeGreaterThan(0);
    expect(mac.length).toBeGreaterThan(0);
    for (const { file, engine } of linux) {
      for (const id of primary) {
        expect(engine.cases[id]?.reliability, `${file.envId} ${id}`).not.toBe('ok');
        expect(engine.cases[id]?.typeSupportedClaim, `${file.envId} ${id}`).toBe(true);
        // "some attempts play" in the Playwright image, "none did" on the GitHub runner: the sentence is about these two rows.
        const expected = file.envId === 'docker-linux-arm64' ? 'intermittent' : 'fail';
        expect(engine.cases[id]?.reliability, `${file.envId} ${id}`).toBe(expected);
      }
    }
    for (const { file, engine } of mac) {
      for (const id of primary) expect(engine.cases[id]?.reliability, `${file.envId} ${id}`).toBe('ok');
    }
  });

  it('says the real player page passed all 100 recorded runs in Linux WebKit (Findings)', () => {
    const dir = 'docs/results/player-smoke/experiments';
    const files = readdirSync(join(ROOT, dir)).filter((f) => /^linux-webkit-(vod|live)-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const summary = files.flatMap(
      (f) =>
        (JSON.parse(read(`${dir}/${f}`)) as { summary: Array<{ runs: number; passes: number }> }).summary,
    );
    expect(summary.reduce((n, s) => n + s.runs, 0)).toBe(100);
    expect(summary.reduce((n, s) => n + s.passes, 0)).toBe(100);
  });

  it('says Firefox does not launch natively on the macOS development host (Limitations)', () => {
    const local = matrix.find((file) => file.envId === 'local-darwin-arm64');
    expect(local?.engines.firefox).toHaveProperty('launchFailed');
  });

  it('says the frame-rate, dropped-frame and rebuffering metrics did not vary in any baseline run (Performance)', () => {
    const derivation = JSON.parse(real.text('docs/results/perf/threshold-derivation.json')) as {
      budgets: Array<{ rule: string; nonZero: number }>;
      needs: Array<{ rule: string; share: { median: number; tail: number } }>;
    };
    expect(derivation.budgets.length).toBeGreaterThan(0);
    for (const budget of derivation.budgets) expect(budget.nonZero, budget.rule).toBe(0);
    const fps = derivation.needs.find((need) => need.rule === 'fps');
    expect(fps?.share.median).toBeLessThan(1e-4);
    expect(fps?.share.tail).toBeLessThan(1e-4);
  });

  it('says no model draft came from the live service (Failure triage)', () => {
    const mock = JSON.parse(real.text('docs/results/triage/summarize-with-mock/triage-report.json')) as {
      summaries: Array<{ text: string }>;
    };
    expect(mock.summaries.length).toBeGreaterThan(0);
    for (const draft of mock.summaries) expect(draft.text).toContain('[MOCK]');
  });

  it('says seven causes were induced, that none was merged with another, and that a slow origin became two root causes (Failure triage)', () => {
    const report = JSON.parse(real.text('docs/results/triage/triage-report.json')) as {
      sources: Array<{ path: string }>;
      clusters: Array<{ rootCause: string; members: Array<{ source: string }> }>;
    };
    const experiment = (source: string): string => source.split('/')[0] ?? source;
    expect(report.sources).toHaveLength(7);
    const byRoot = new Map<string, Set<string>>();
    for (const cluster of report.clusters) {
      const set = byRoot.get(cluster.rootCause) ?? new Set<string>();
      for (const member of cluster.members) set.add(experiment(member.source));
      byRoot.set(cluster.rootCause, set);
    }
    for (const [root, experiments] of byRoot) expect(experiments.size, root).toBe(1);
    const slow = new Set(
      report.clusters
        .filter((c) => c.members.some((m) => experiment(m.source) === 'origin-slow'))
        .map((c) => c.rootCause),
    );
    expect(slow.size).toBe(2);
  });

  it('says the committed Jenkins builds predate the Perf, Flake and Triage stages (What this proves)', () => {
    const ran = real
      .list('docs/results/jenkins', /^build-\d+\.json$/)
      .flatMap((path) =>
        (JSON.parse(real.text(path)) as { stages: Array<{ name: string; status: string }> }).stages
          .filter((s) => s.status !== 'NOT_EXECUTED')
          .map((s) => s.name),
      );
    for (const stage of ['Perf', 'Flake', 'Triage']) {
      expect(
        ran,
        `a committed Jenkins build ran ${stage}: the README says none did (What this proves, Jenkins)`,
      ).not.toContain(stage);
      expect(real.text('Jenkinsfile')).toContain(`stage('${stage}')`);
    }
  });

  it('says there are five merge-gate legs and that Linux WebKit is the experimental one (What this proves)', () => {
    const legs = parseLegs(real.text('.github/workflows/ci.yml'), 'ci.yml', 'merge-gate');
    expect(legs).toHaveLength(5);
    expect(legs.filter((l) => l.experimental).map((l) => l.leg)).toStrictEqual(['webkit-linux']);
    expect(read('TEST_STRATEGY.md')).toContain('(five: Linux and macOS WebKit are two of them)');
  });

  it('says the EME test is assigned to Chromium and Firefox (What this proves)', () => {
    const eme = catalog.find((row) => row.id === 'PB-EME-001');
    expect(eme?.engines).toStrictEqual(['chromium', 'firefox']);
  });

  it('says the performance gate runs in CI as a paired gate on both profiles, and in the Jenkinsfile (What this proves)', () => {
    const legs = parsePerfLegs(real.text('.github/workflows/ci.yml'), 'ci.yml', 'perf');
    expect(legs.map((l) => l.profile)).toStrictEqual(['chromium', 'chromium-cpu4x']);
    for (const leg of legs) expect(leg.command).toContain('--paired');
    expect(real.text('Jenkinsfile')).toMatch(/stage\('Perf'\)[\s\S]*gate:perf -- --paired/);
  });

  it('says the readiness, soak and flake results are committed, and the A/B ones too (What this proves)', () => {
    const message = (what: string): string =>
      `${what}: the README says otherwise (What this proves, Real results): update its rows`;
    for (const path of [
      'docs/results/readiness',
      'docs/results/soak',
      'docs/results/flake',
      'docs/results/ab',
      'ab',
    ]) {
      expect(existsSync(resolve(ROOT, path)), message(`${path} is gone`)).toBe(true);
    }
  });

  it('says ten checks are required, and they are the jobs of ci.yml (What this proves)', () => {
    const workflow = real.text('.github/workflows/ci.yml');
    const merge = parseLegs(workflow, 'ci.yml', 'merge-gate');
    const perf = parsePerfLegs(workflow, 'ci.yml', 'perf');
    const names = [
      'static',
      'unit',
      ...merge.map((l) => `merge-gate (${l.leg}${l.experimental ? ', experimental' : ''})`),
      'flake',
      ...perf.map((l) => l.leg),
    ];
    expect(names).toHaveLength(10);
    for (const job of ['static', 'unit', 'flake']) expect(workflow).toContain(`name: ${job}\n`);
    const paragraph = /\*\*Required checks\.\*\*[^\n]*/.exec(read('docs/CI.md'))?.[0] ?? '';
    expect(paragraph).toContain('requires these ten names');
    for (const name of names) expect(paragraph, name).toContain(`\`${name}\``);
    expect(readme).toContain('branch protection on `main` requires ten checks');
  });

  describe('the numbers it quotes about the performance gate on GitHub (Performance, Findings)', () => {
    type Summary = {
      passes: number;
      falsePositives: number;
      runs: Array<{ exitCode: number; file: string; cpuModel: string | null }>;
    };
    const summaries = (dir: string): Summary[] =>
      real
        .list(`docs/results/perf/${dir}`, /^[^/]+-aa\.json$/)
        .map((p) => JSON.parse(real.text(p)) as Summary);
    const total = (list: Summary[], key: 'passes' | 'falsePositives'): number =>
      list.reduce((n, s) => n + s[key], 0);

    it('the paired A/A: 36 passes on twelve machines, none a false positive, and a bound of about 8 % per pass', () => {
      const paired = summaries('paired-aa');
      expect(total(paired, 'passes')).toBe(36);
      expect(total(paired, 'falsePositives')).toBe(0);
      expect(real.list('docs/results/perf/paired-aa/raw', /^[^/]+\/machine\.txt$/)).toHaveLength(12);
      expect(1 - Math.pow(0.05, 1 / 36)).toBeCloseTo(0.08, 2);
      expect(readme).toContain('0 of 36 passes means, at 95 % confidence, a rate per pass below about 8 %');
      expect(readme).toContain('the independent samples are the twelve machines');
      expect(readme).toContain('no false positive in 36 passes, the 12 on that CPU model included');
    });

    it('the committed baselines on 13 VMs: 8 of 39 passes failed, all on one of five CPU models', () => {
      const cross = summaries('gha-cross-vm');
      expect(total(cross, 'passes')).toBe(39);
      expect(total(cross, 'falsePositives')).toBe(8);
      const cpuOf = (job: string): string =>
        /^cpu: (.+)$/m.exec(real.text(`docs/results/perf/gha-cross-vm/raw/${job}/machine.txt`))?.[1] ?? '';
      const jobs = real.list('docs/results/perf/gha-cross-vm/raw', /^[^/]+\/machine\.txt$/);
      expect(jobs).toHaveLength(13);
      expect(new Set(jobs.map((p) => cpuOf(p.split('/').slice(-2)[0] ?? '').toLowerCase())).size).toBe(5);
      const runs = cross
        .flatMap((s) => s.runs)
        .map((r) => ({
          failed: r.exitCode === 1,
          cpu: cpuOf(/raw\/([^/]+)\/pass-/.exec(r.file)?.[1] ?? ''),
        }));
      const epyc = runs.filter((r) => r.cpu.includes('EPYC 7763'));
      expect([epyc.length, epyc.filter((r) => r.failed).length]).toStrictEqual([12, 8]);
      expect(runs.filter((r) => !r.cpu.includes('EPYC 7763') && r.failed)).toHaveLength(0);
      expect(runs.length - epyc.length).toBe(27);
      expect(readme).toContain('the 13 jobs of one A/A landed on five CPU models');
      expect(readme).toContain(
        'an unchanged build failed 8 of 39 passes, all 8 on one CPU model, the AMD EPYC 7763 (8 of its 12 passes; none of the 27 passes on the other four)',
      );
    });

    it('the pull request that slowed startup by 150 ms: the numbers of its two gate reports and of its runs', () => {
      const sig4 = (value: number): string => String(Number(value.toPrecision(4)));
      const metric = (profile: string): { first: Loose; remeasure: Loose } => {
        const report = JSON.parse(real.text(`docs/results/perf/paired-sensitivity/${profile}.json`)) as Loose;
        return report.scenarios[0].metrics.find((m: Loose) => m.metric === 'startupMs');
      };
      const low = metric('chromium-cpu4x');
      expect(sig4(low.remeasure.median.worseBy)).toBe('80.65');
      expect(sig4(low.remeasure.median.allowed)).toBe('80');
      expect(readme).toContain('worse by 80.65 ms against 80 ms allowed');
      const percent = (m: { first: Loose }): number => Math.round(m.first.median.changeShare * 100);
      expect([percent(metric('chromium')), percent(low)]).toStrictEqual([240, 33]);
      expect(readme).toContain('+240 % of a Chromium startup and only +33 % of the throttled profile');
      const page = read('docs/results/perf/paired-sensitivity.md');
      expect(page).toContain('150 ms');
      expect(page).toContain('41887534070');
      expect(readme).toContain('slowed startup by 150 ms');
      expect(readme).toContain('actions/runs/41887534070');
      expect(read('docs/results/triage/ci-demo.md')).toContain('41887574166');
      expect(readme).toContain('actions/runs/41887574166');
    });
  });

  describe('the numbers it quotes about the flake collections (Flake tracking, Findings)', () => {
    const collections = readCollections(real);
    const find = (name: string, project = 'webkit') =>
      collections.find((c) => c.name === name && c.project === project);
    const own = (name: string, id: string) => find(name)?.perTest.get(id);

    it('the whole merge tier: 450 executions in each Linux engine, none flaky or failed', () => {
      for (const job of ['chromium', 'firefox', 'webkit-linux']) {
        const c = collections.find((x) => x.name === `collect-1 / ${job}`);
        expect([c?.repetitions, c?.totals.executions, c?.totals.flaky, c?.totals.failed]).toStrictEqual([
          30, 450, 0, 0,
        ]);
      }
      expect(find('collect-1 / webkit-macos')?.totals).toStrictEqual({
        executions: 300,
        flaky: 1,
        failed: 2,
        invalid: 0,
        otherSkips: 0,
      });
      expect(readme).toContain('no flaky and no failed execution in 450');
    });

    it('PB-ABR-002 on macOS: 7 first attempts failed in 60 before the fix; after it none of 121 failed and 29 of 150 were invalid', () => {
      const before = [own('collect-1 / webkit-macos', 'PB-ABR-002'), own('abr-002-macos-40', 'PB-ABR-002')];
      expect(before.reduce((n, c) => n + (c?.flaky ?? 0) + (c?.failed ?? 0), 0)).toBe(7);
      expect(before.reduce((n, c) => n + (c?.executions ?? 0), 0)).toBe(60);
      const after = [
        'after-fix/abr002-fix',
        'after-fix/abr002-traceoff',
        'after-fix/dpr1b',
        'after-fix/abr12-isolated',
      ].map((name) => own(name, 'PB-ABR-002'));
      const sum = (key: 'executions' | 'flaky' | 'failed' | 'invalid'): number =>
        after.reduce((n, c) => n + (c?.[key] ?? 0), 0);
      expect([sum('executions'), sum('flaky') + sum('failed'), sum('invalid')]).toStrictEqual([121, 0, 29]);
      expect(sum('executions') + sum('invalid')).toBe(150);
      expect(readme).toContain('**7 first attempts failed in 60**');
      expect(readme).toContain(
        'none of the 121 executions of the series with the default configuration failed or flaked',
      );
      expect(readme).toContain('**29 of 150 attempts were skipped as invalid runs**');
      expect(readme).toContain(
        '29 of 150 attempts of PB-ABR-002 on the macOS runner were skipped that way after the fix, and none of the 121',
      );
    });

    it('PB-ABR-001: both attempts failed in 45 of 70 repetitions, and the 100 failing attempts share one fingerprint', () => {
      const abr1 = [
        own('after-fix/abr001-main', 'PB-ABR-001'),
        own('after-fix/abr12-isolated', 'PB-ABR-001'),
      ];
      expect(abr1.reduce((n, c) => n + (c?.failed ?? 0), 0)).toBe(45);
      expect(abr1.reduce((n, c) => n + (c?.executions ?? 0), 0)).toBe(70);
      const attempts = read('docs/results/flake/after-fix/abr001-failing-attempts.jsonl')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { changes: string; dropped: number });
      expect(attempts).toHaveLength(100);
      const times = attempts.map((a) => Number(/360p abr at ([0-9.]+) s/.exec(a.changes)?.[1]));
      expect([Math.min(...times), Math.max(...times)]).toStrictEqual([9.88, 10.02]);
      expect(attempts.filter((a) => a.dropped === 2)).toHaveLength(7);
      expect(readme).toContain('failed both attempts in **45 of 70** repetitions');
      expect(readme).toContain('in all 100 failing attempts');
      expect(readme).toContain('9.88 to 10.02 s of media time');
      expect(readme).toContain('seven of the attempts dropped only 2 frames');
    });

    it('PB-ABR-001 with the classifier: 19 passed, 21 of 40 invalid, none failed, and the gate fails with over-invalid-budget', () => {
      const series = find('after-fix/abr001-invalid');
      expect([
        series?.repetitions,
        series?.totals.executions,
        series?.totals.flaky,
        series?.totals.failed,
        series?.totals.invalid,
      ]).toStrictEqual([40, 19, 0, 0, 21]);
      expect(own('after-fix/abr001-invalid', 'PB-ABR-001')?.invalid).toBe(21);
      const wilson = (k: number, n: number, z = 1.959964): [number, number] => {
        const p = k / n;
        const d = 1 + (z * z) / n;
        const centre = (p + (z * z) / (2 * n)) / d;
        const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
        return [centre - half, centre + half];
      };
      expect(digits((100 * 21) / 40, 1)).toBe('52.5');
      expect(wilson(21, 40).map((x) => Math.round(100 * x))).toStrictEqual([37, 67]);
      const before = ['after-fix/abr12-isolated', 'after-fix/abr001-main'].map((name) => {
        const t = own(name, 'PB-ABR-001');
        return Math.round((100 * ((t?.flaky ?? 0) + (t?.failed ?? 0))) / (t?.executions ?? 1));
      });
      expect(before).toStrictEqual([77, 80]);
      const gate = JSON.parse(read('docs/results/flake/after-fix/abr001-invalid/gate.json')) as Loose;
      expect(gate.decision).toBe('fail');
      expect(gate.failures[0].kind).toBe('over-invalid-budget');
      expect(gate.failures[0].message).toContain(
        'invalid run in 16 of 30 of its last scheduled executions (53.3%), the budget is 40.0%',
      );
      const page = read('docs/results/flake/README.md');
      expect(page).toContain('**After the classifier**');
      expect(page).toContain('21 of 40 (52.5 %, Wilson 37 to 67 %)');
      expect(page).toContain('the first time that verdict fired on real data');
      expect(page).toContain('where 77 to 80 % of the first attempts failed');
      expect(read('docs/FLAKE.md')).toContain('judged from 20');
      const linux = ['chromium', 'firefox', 'webkit-linux'].map((job) =>
        collections.find((x) => x.name === `collect-1 / ${job}`),
      );
      expect(linux.reduce((n, c) => n + (c?.totals.executions ?? 0), 0)).toBe(1350);
      expect(linux.reduce((n, c) => n + (c?.totals.invalid ?? 0), 0)).toBe(0);
      for (const quoted of [
        'ended **21 as an invalid run** and failed none (`after-fix/abr001-invalid`): 52.5 % invalid, above the budget',
        '`over-invalid-budget`, 16 of the last 30 scheduled executions (53.3 %)',
        'now ends 21 of 40 repetitions as an invalid run, above the invalid-run budget',
        'the test passed 19, ended 21 as an invalid run (52.5 %, Wilson 37 to 67 %) and failed none',
        'The share varies from job to job (77 to 80 % of the first attempts failed before the classifier in two collections, 52.5 % were invalid after it in a third) and the cause is not explained',
        'against a budget of 40 %), the first time that verdict fired on real data',
        '21 of 40 repetitions ended as an invalid run, 19 passed and none failed',
        '(16 of the last 30 scheduled executions, 53.3 %, against 40 %)',
        'once the nightly has 20 scheduled executions of the test on that leg (the gate judges from 20)',
        "is the owner's decision",
        'No invalid run was recorded on a Linux engine in the 1,350 executions of the merge tier (`collect-1`); PB-ABR-001 itself was collected on macOS only',
        '"After the classifier"',
      ]) {
        expect(readme, quoted).toContain(quoted);
      }
    });

    it('the demonstration is filed under its own environment, and its spec says it is not the player', () => {
      expect(find('demo-deliberate-flake', 'chromium')?.envId).toBe('demo-deliberate-flake');
      expect(read('docs/results/flake/demo-deliberate-flake/demo-flaky.spec.ts.txt')).toContain(
        'A demonstration, not a product test',
      );
      expect(readme).toContain('its environment is `demo-deliberate-flake`');
    });
  });

  it('quotes the readiness finding from docs/READINESS.md, and counts the soaks it speaks of (Readiness and soak)', () => {
    const page = read('docs/READINESS.md');
    for (const quoted of [
      '10.15 to 11.02 s behind on Linux (10.43 to 11.50 s on macOS)',
      'Every criterion but one is GO with a wide margin in all 14.',
      'The check stops the origin for 10 s',
    ]) {
      expect(page, quoted).toContain(quoted);
    }
    expect(readme).toContain(
      'stays 10.15 to 11.02 s behind the live edge on Linux (10.43 to 11.50 s on macOS)',
    );
    expect(readme).toContain(
      'in the 14 soaks of the first evidence every criterion but the latency level is GO with a wide margin',
    );
    const runs = (
      JSON.parse(real.text('docs/results/provenance/runs.json')) as {
        runs: Array<{ task: string; batch?: string }>;
      }
    ).runs;
    expect(runs.filter((r) => r.task === 'soak' && (r.batch ?? 'first') === 'first')).toHaveLength(14);
  });

  it('names the two unit flakes and the apt mirror check where the repository records them (Limitations)', () => {
    expect(read('docs/results/flake/README.md')).toContain('tests/unit/probe/media.test.ts');
    const label = (build: number): string =>
      (JSON.parse(real.text(`docs/results/jenkins/build-${build}.json`)) as { label: string }).label;
    expect(label(2)).toContain(
      'tests/unit/probe/media.test.ts, the probe media generated twice did not come out the same',
    );
    expect(label(5)).toContain(
      'tests/unit/server/static.test.ts (84 open descriptors where 120 were expected while 40 downloads stalled)',
    );
    expect(readme).toContain('84 open descriptors where 120 were expected while 40 downloads stalled');
    const hevc = read('docs/results/flake/README.md');
    expect(hevc).toContain('encoded the same clip 12 times idle and 12 times with eight busy loops');
    expect(hevc).toContain('every series produced one hash (the committed one) in 12 of 12');
    expect(readme).toContain(
      'encoded the clip 12 times idle and 12 times under load and got the committed hash every time',
    );
    expect(existsSync(join(ROOT, '.github/actions/setup/apt-mirror.sh'))).toBe(true);
    expect(read('docs/decisions/ci.md')).toContain(
      '## ADR-180: The setup action measures the apt mirror before it uses it',
    );
    expect(readme).toContain('is not a limit of the lab');
  });

  // The file-handle calibration (static.test.ts) was fixed in pull request #22: the helper that waits for pending file operations
  // names CloseReq next to FSReq.
  it('says the file-handle calibration flake was fixed in pull request #22, and the fix is in the repository (Limitations)', () => {
    expect(read('tests/unit/server/static.test.ts')).toContain('CloseReq');
    expect(readme).toContain('cause found and fixed in pull request #22');
    expect(readme).not.toContain('its fix is in review');
  });

  describe('A/B comparisons: the prose against the reports', () => {
    const reportOf = (prefix: string): Loose =>
      JSON.parse(
        real.text(real.list('docs/results/ab', new RegExp(`^${prefix}\\..*\\.report\\.json$`))[0] ?? ''),
      ) as Loose;
    const plan = (name: string): Loose => JSON.parse(real.text(`ab/prereg/${name}.json`)) as Loose;
    const outsideTheBlock = readme.replace(/<!-- BEGIN:RESULTS_AB -->[\s\S]*?<!-- END:RESULTS_AB -->/, '');
    const minutes = (r: Loose): string => {
      const seconds = Math.round((Date.parse(r.run.finishedAt) - Date.parse(r.run.startedAt)) / 1000);
      return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
    };

    it('quotes the verdict, the interval and the margin of PB-AB-002, and the condition it ran under', () => {
      const r = reportOf('PB-AB-002');
      expect(r.validity.valid).toBe(true);
      expect(r.validity.gates).toHaveLength(7);
      expect(r.conditions[0].analysis.decision).toMatchObject({ verdict: 'equivalent', action: 'keep-a' });
      const startup = r.conditions[0].analysis.metrics[0];
      expect([startup.id, startup.role, startup.threshold]).toStrictEqual(['startupMs', 'primary', 100]);
      expect(startup.effect.estimate).toBe(15);
      expect([digits(startup.effect.low, 1), digits(startup.effect.high, 1)]).toStrictEqual([
        '-19.2',
        '51.8',
      ]);
      expect(plan('PB-AB-002').conditions[0].rules).toMatchObject([{ type: 'latency', ms: 300 }]);
      expect(readme).toContain(
        'Under 300 ms of latency B starts 15 ms after A, and the interval of that difference, -19.2 to +51.8 ms, is inside the margin of 100 ms (PB-AB-002).',
      );
      expect(readme).toContain('startup under 300 ms of latency');
      expect(readme).toContain('both valid (7 of 7 gates) and both *equivalent within the margin* (keep A)');
    });

    it('quotes PB-AB-003 as a harm check, and what its report says about the sessions it left out', () => {
      const r = reportOf('PB-AB-003');
      const analysis = r.conditions[0].analysis;
      expect(r.validity.gates).toHaveLength(7);
      expect(r.validity.valid).toBe(true);
      expect(analysis.decision.verdict).toBe('equivalent');
      const share = analysis.metrics[0];
      expect([
        share.countsA.events,
        share.countsA.total,
        share.countsB.events,
        share.countsB.total,
      ]).toStrictEqual([0, 39, 0, 39]);
      expect([
        digits(share.effect.low * 100, 0),
        digits(share.effect.high * 100, 0),
        share.threshold,
      ]).toStrictEqual(['-9', '9', 0.2]);
      expect([analysis.attempted, analysis.analysed]).toStrictEqual([
        { A: 40, B: 40 },
        { A: 39, B: 39 },
      ]);
      const failed = analysis.failures.sessions.map((s: Loose) => [s.index + 1, s.arm, s.kind]);
      expect(failed).toStrictEqual([
        [73, 'A', 'page'],
        [74, 'B', 'timeout'],
      ]);
      expect(analysis.failures.sessions[0].message).toContain('did not boot');
      expect(analysis.failures.guardTripped).toBe(false);
      const gate = r.validity.gates.find((g: Loose) => g.id === 'failures');
      expect(gate.detail).toContain('2 of 80 measured sessions failed (reported, never dropped)');
      expect(gate.detail).toContain('maximum of 10 % of an arm');
      expect(analysis.startRungs).toMatchObject({ A: { '720': 39 }, B: { '240': 39 }, disjoint: true });
      for (const quoted of [
        'no session of either configuration stalled, 0 of 39 against 0 of 39, and the interval of the difference, -9 to +9 points, is inside the margin of 20 points (PB-AB-003)',
        'It attempted 40 sessions per arm and analysed 39: one session of each arm failed (session 73 of A, the player page did not boot; session 74 of B, a timeout)',
        'says that 2 of 80 sessions failed, under the maximum of 10 % of an arm, and the failure guard did not trip',
        '**PB-AB-003 is a harm check, not a comparison.**',
        'a share cannot fall below 0',
        'A on 720p, B on 240p',
      ]) {
        expect(readme, quoted).toContain(quoted);
      }
    });

    it('quotes the A/A pilots: two that could not fail and one that could, and the pilots windows', () => {
      const bandwidth = ['PB-AB-001-bandwidth-drop-finite', 'PB-AB-001-bandwidth-drop-finite-40s'].map(
        reportOf,
      );
      for (const r of bandwidth) {
        const share = r.conditions[0].analysis.metrics[0];
        expect(share.countsA.events + share.countsB.events).toBe(0);
        expect(share.countsA.total + share.countsB.total).toBe(60);
        expect(r.calibrations[0].result).toMatchObject({ splits: 2000, falsePositives: 0, pass: true });
      }
      const startup = reportOf('PB-AB-001-high-latency').calibrations[0].result;
      expect([startup.falsePositives, startup.splits, startup.rate]).toStrictEqual([100, 2000, 0.05]);
      expect([
        digits(startup.interval.lower * 100, 2),
        digits(startup.interval.upper * 100, 2),
      ]).toStrictEqual(['4.09', '6.05']);
      expect(plan('PB-AB-001-bandwidth-drop-finite').observation.mediaSecondsAfterFirstFrame).toBe(18);
      expect(plan('PB-AB-001-bandwidth-drop-finite-40s').observation.mediaSecondsAfterFirstFrame).toBe(40);
      expect(read('docs/results/ab/README.md')).toContain('1.4 s before the window ended');
      for (const quoted of [
        'No session of A rebuffered in the two A/A pilots of that condition (0 of 120)',
        'Nothing stalled in A (0 of 39 in the experiment, 0 of 120 in the two A/A pilots under that condition)',
        '(0 of 60 in each pilot)',
        '(100 of 2,000 splits significant, 5.00 %, interval 4.09 to 6.05 %)',
        "The pilots observed 18 s and 40 s of media after the first frame: in the first, the player's first change of rung after the drop came 1.4 s before the window ended",
        'Two of the three A/A pilots could not fail.',
      ]) {
        expect(readme, quoted).toContain(quoted);
      }
    });

    it('says where it was measured, how long a run took, and what the machine was doing', () => {
      const reports = real
        .list('docs/results/ab', /^[^/]+\.report\.json$/)
        .map((p) => JSON.parse(real.text(p)) as Loose);
      expect(reports).toHaveLength(6);
      for (const r of reports) {
        expect([
          r.environment.envId,
          r.environment.browser.name,
          r.environment.browser.version,
        ]).toStrictEqual(['local-darwin-arm64', 'chromium', '156.0.8078.4']);
        expect(r.environment.host.cpus).toBe(12);
      }
      expect(readme).toContain('Chromium 156.0.8078.4 on `local-darwin-arm64`');
      expect(readme).toContain('**Chromium on one workstation, not replicated on a runner.**');
      expect([minutes(reportOf('PB-AB-002')), minutes(reportOf('PB-AB-003'))]).toStrictEqual([
        '7 min 20 s',
        '63 min 28 s',
      ]);
      expect(readme).toContain('7 min 20 s for PB-AB-002 and 63 min 28 s for PB-AB-003');
      const narrative = read('docs/results/ab/README.md');
      expect(narrative).toContain('overloaded the machine for about nine minutes');
      expect(narrative).toContain('because its A/A check was measured elsewhere');
      const mdName = readdirSync(join(ROOT, 'docs/results/ab')).find((name) =>
        /^PB-AB-003\..*\.report\.md$/.test(name),
      );
      expect(mdName).toBeDefined();
      const md = read(`docs/results/ab/${mdName ?? ''}`);
      expect(md).toContain('bandwidth-drop-finite: 3.7 before, 17.0 after');
      expect(readme).toContain('the load average after PB-AB-003 was 17.0 on 12 CPUs, against 3.7 before');
    });

    it('says B differs from A in four settings, and quotes nothing of the exploratory run outside its labelled rows', () => {
      expect(flattenPatch(configFor('A'))).toHaveLength(0);
      expect(flattenPatch(configFor('B'))).toHaveLength(4);
      expect(read('docs/AB.md')).toContain('overrides **four settings at once**');
      expect(readme).toContain('configuration B differs from A in four settings together');
      expect(readme).toContain('**B differs from A in four settings together**');
      expect(readme).toContain('B (four overridden settings)');
      const exploratory = reportOf('exploratory-constrained-1500');
      expect(exploratory.experiment.kind).toBe('exploratory');
      expect(exploratory.conditions[0].analysis.decision).toBeNull();
      expect(readme).toContain('nothing from it is quoted here as a finding');
      const estimate = exploratory.conditions[0].analysis.metrics[0].effect.estimate as number;
      for (const quoted of [digits(-estimate, 0), digits(-estimate, 1), '1698', '1,698']) {
        expect(
          outsideTheBlock,
          `the exploratory estimate ${quoted} is quoted outside its labelled rows`,
        ).not.toContain(quoted);
      }
    });

    it('names the runner, its script, its plans and the decision records it cites', () => {
      expect(JSON.parse(read('package.json')).scripts.ab).toBe('tsx ab/run.ts');
      for (const path of [
        'ab/run.ts',
        'ab/prereg',
        'docs/AB.md',
        'docs/decisions/ab.md',
        'docs/results/ab/README.md',
      ]) {
        expect(existsSync(join(ROOT, path)), path).toBe(true);
      }
      const adrs = read('docs/decisions/ab.md');
      expect(adrs).toContain('## ADR-140:');
      expect(adrs).toContain('## ADR-149:');
      expect(readme).toContain('ADR-140 to ADR-149');
    });
  });
});
