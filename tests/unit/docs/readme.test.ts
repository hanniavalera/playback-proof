import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReadmeFile } from '../../../tools/check-docs.ts';
import { parseCatalog } from '../../../tools/catalog.ts';
import { RESULT_BLOCKS, loadResultFiles } from '../../../tools/results-tables.ts';
import { parseLegs } from '../../../tools/results/suites.ts';
import { parseResultFile } from '../../../src/lab/probe/report.ts';

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

/** Paths that appear in the README for results that are measured by changes that have not landed. Each must still be absent. */
const PENDING_PATHS = [
  'docs/results/ab',
  'docs/results/readiness',
  'docs/results/soak',
  'docs/results/flake',
  'ab',
];

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

  it('names only paths that exist, apart from those a command creates and the results that are pending', () => {
    const missing = repoPaths(prose).filter(
      (path) =>
        !existsSync(join(ROOT, path)) && !RUNTIME_PATHS.includes(path) && !PENDING_PATHS.includes(path),
    );
    expect(missing).toStrictEqual([]);
  });

  it('keeps its list of pending results honest: each one is named in the README, and none exists yet', () => {
    for (const path of PENDING_PATHS) {
      expect(prose, path).toContain(path);
      expect(
        existsSync(join(ROOT, path)),
        `${path} exists now: the README says it does not (What this proves, Results that are not committed yet); add its block and update the sentence, then remove it from PENDING_PATHS`,
      ).toBe(false);
    }
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

  it('says Linux WebKit decodes only some attempts of the lab flavours where macOS WebKit decodes all, and that isTypeSupported says yes (Findings)', () => {
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

  it('says the committed Jenkins builds predate the Flake and Triage stages (What this proves)', () => {
    const ran = real
      .list('docs/results/jenkins', /^build-\d+\.json$/)
      .flatMap((path) =>
        (JSON.parse(real.text(path)) as { stages: Array<{ name: string; status: string }> }).stages
          .filter((s) => s.status !== 'NOT_EXECUTED')
          .map((s) => s.name),
      );
    expect(ran).not.toContain('Flake');
    expect(ran).not.toContain('Triage');
    expect(real.text('Jenkinsfile')).toContain("stage('Flake')");
    expect(real.text('Jenkinsfile')).toContain("stage('Triage')");
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

  it('says the performance gate is not run by CI, and that no A/B, readiness, soak or flake result is committed (What this proves)', () => {
    const message = (what: string): string =>
      `${what}: the README says otherwise (What this proves, Real results): update its rows`;
    expect(real.text('.github/workflows/ci.yml'), message('ci.yml runs gate:perf')).not.toContain(
      'gate:perf',
    );
    expect(real.text('Jenkinsfile'), message('the Jenkinsfile runs gate:perf')).not.toContain('gate:perf');
    for (const path of [
      'ab',
      'docs/results/ab',
      'docs/results/readiness',
      'docs/results/soak',
      'docs/results/flake',
    ]) {
      expect(existsSync(resolve(ROOT, path)), message(`${path} exists`)).toBe(false);
    }
  });
});
