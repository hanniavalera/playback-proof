// RESULTS_TRIAGE: the failures of seven causes induced on purpose, as the triage tool clustered them (docs/results/triage). The
// clustering is deterministic and needs no key; the optional model draft was only ever run against a local mock, and the block counts
// the drafts and checks that each one says so.
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Node, Rendered } from './files.ts';
import { code, link, listOf, mdTable, plural } from './format.ts';

export const TRIAGE_DIR = 'docs/results/triage';
export const TRIAGE_REPORT = `${TRIAGE_DIR}/triage-report.json`;
export const TRIAGE_MOCK_REPORT = `${TRIAGE_DIR}/summarize-with-mock/triage-report.json`;

interface Cluster {
  key: string;
  size: number;
  category: string;
  rule: string;
  failureClass: string;
  rootCause: string;
  experiments: string[];
}

interface RootCause {
  key: string;
  rank: number;
  category: string;
  rule: string;
  cause: string | null;
  failureClass: string;
  size: number;
  clusters: string[];
}

const experimentOf = (source: string): string => source.split('/')[0] ?? source;

function readCluster(node: Node): Cluster {
  return {
    key: node.at('key').str(),
    size: node.at('size').int(),
    category: node.at('category').str(),
    rule: node.at('rule').at('rule').str(),
    failureClass: node.at('failureClass').str(),
    rootCause: node.at('rootCause').str(),
    experiments: [
      ...new Set(
        node
          .at('members')
          .list()
          .map((m) => experimentOf(m.at('source').str())),
      ),
    ],
  };
}

function readRootCause(node: Node): RootCause {
  return {
    key: node.at('key').str(),
    rank: node.at('rank').int(),
    category: node.at('category').str(),
    rule: node.at('rule').str(),
    cause: node.opt('cause')?.str() ?? null,
    failureClass: node.at('failureClass').str(),
    size: node.at('size').int(),
    clusters: node
      .at('clusters')
      .list()
      .map((c) => c.str()),
  };
}

const label = (category: string, rule: string): string => `${code(category)} / ${code(rule)}`;

export function renderTriage(files: FileSet): Rendered {
  if (!files.has(TRIAGE_REPORT)) {
    if (files.list(TRIAGE_DIR).length === 0) return emptyState('triage results', TRIAGE_DIR);
    throw new ResultsError(
      `${TRIAGE_REPORT}: the file is missing (the end-to-end report of the induced failures)`,
    );
  }
  const report = files.json(TRIAGE_REPORT);
  if (report.at('schemaVersion').int() !== 1)
    report.at('schemaVersion').fail('this renderer reads schema version 1');
  const clusters = report.at('clusters').list().map(readCluster);
  const rootCauses = report.at('rootCauses').list().map(readRootCause);
  const totals = report.at('totals');
  const sources = report
    .at('sources')
    .list()
    .map((s) => ({
      experiment: experimentOf(s.at('path').str()),
      failed: s.at('failed').int() + s.at('flaky').int(),
      runErrors: s.at('runErrors').int(),
    }));

  // The totals are the report's own counts; if they disagree with its lists, the file was edited by hand.
  const claimed = [
    ['clusters', totals.at('clusters').int(), clusters.length],
    ['rootCauses', totals.at('rootCauses').int(), rootCauses.length],
    ['failures', totals.at('failures').int(), clusters.reduce((n, c) => n + c.size, 0)],
  ] as const;
  for (const [name, said, counted] of claimed) {
    if (said !== counted) totals.at(name).fail(`says ${said} but the report lists ${counted}`);
  }
  const rootByKey = new Map(rootCauses.map((root) => [root.key, root]));
  for (const cluster of clusters) {
    if (!rootByKey.has(cluster.rootCause)) {
      throw new ResultsError(
        `${TRIAGE_REPORT}: cluster ${cluster.key} names root cause ${cluster.rootCause}, which the report does not list`,
      );
    }
  }

  const perExperiment = mdTable(
    ['Cause induced', 'Failed', 'Clusters', 'Root causes', 'Category / rule'],
    sources.map((source) => {
      const own = clusters.filter((c) => c.experiments.includes(source.experiment));
      const failed = [
        ...(source.failed > 0 ? [plural(source.failed, 'failed test')] : []),
        ...(source.runErrors > 0 ? [plural(source.runErrors, 'run failure')] : []),
      ];
      return [
        link(source.experiment, `${TRIAGE_DIR}/README.md`),
        failed.join(', ') || '0',
        String(own.length),
        String(new Set(own.map((c) => c.rootCause)).size),
        [...new Set(own.map((c) => label(c.category, c.rule)))].join('; '),
      ];
    }),
  );

  const perRootCause = mdTable(
    ['Root cause', 'What the rule says', 'Class', 'Failures', 'Clusters', 'Induced by'],
    rootCauses.map((root) => {
      const own = clusters.filter((c) => root.clusters.includes(c.key));
      return [
        label(root.category, root.rule),
        root.cause ?? 'no single cause named',
        root.failureClass,
        String(root.size),
        String(root.clusters.length),
        listOf([...new Set(own.flatMap((c) => c.experiments))].map(code)),
      ];
    }),
  );

  const lines = [
    `${plural(sources.length, 'cause')} induced on purpose, read as one directory: ${plural(totals.at('failures').int(), 'failure')} in ${plural(clusters.length, 'cluster')} of ${plural(rootCauses.length, 'root cause')}. Source: ${link('triage-report.json', TRIAGE_REPORT)} (${link('triage-report.md', `${TRIAGE_DIR}/triage-report.md`)}); how the failures were induced, and what the first runs got wrong: ${link('docs/results/triage/README.md', `${TRIAGE_DIR}/README.md`)}.`,
    '',
    perExperiment,
    '',
    perRootCause,
    '',
    ...mockSentence(files),
  ];
  return data(lines.join('\n'));
}

function mockSentence(files: FileSet): string[] {
  if (!files.has(TRIAGE_MOCK_REPORT)) {
    return [`_No run of the model summaries is committed (\`${TRIAGE_MOCK_REPORT}\`)._`];
  }
  const mock = files.json(TRIAGE_MOCK_REPORT);
  const drafts = mock.at('summaries').list();
  const unlabelled = drafts.filter((d) => !d.at('text').str().includes('[MOCK]'));
  const model = mock.opt('summaryRun')?.at('model').str();
  return [
    unlabelled.length === 0
      ? `Model summaries: ${plural(drafts.length, 'draft')} in ${link('summarize-with-mock/', `${TRIAGE_DIR}/summarize-with-mock`)}${model ? ` (model id ${code(model)})` : ''}, and every one says \`[MOCK]\`: they came from \`tools/triage-mock.ts\`, a local test double, and not from the service.`
      : `**${plural(unlabelled.length, 'draft')} of ${drafts.length} in ${link('summarize-with-mock/', `${TRIAGE_DIR}/summarize-with-mock`)} are not labelled as a mock: check that the live service was not called without saying so.**`,
  ];
}
