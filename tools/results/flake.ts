// RESULTS_FLAKE: the flake rate of every engine job, and the tests that flaked, from the committed `flake:report --json` files
// (docs/results/flake/**/report-*.json: one per history that was collected). The shape is flake/report.ts's FlakeReport: `suites` holds one
// record per engine job (builds, executions, flaky, failed, rate, budget, verdict) and `tests` one per test and engine.
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Node, Rendered } from './files.ts';
import { code, link, mdTable, percent, plural, shorten } from './format.ts';

export const FLAKE_DIR = 'docs/results/flake';
export const FLAKE_REPORT_PATTERN = /(?:^|\/)report-[^/]+\.json$/;

interface Report {
  path: string;
  envId: string;
  from: string | null;
  to: string | null;
  runs: number;
  limits: string;
  suites: Node[];
  tests: Node[];
}

function readReport(files: FileSet, path: string): Report {
  const root = files.json(path);
  const history = root.at('history');
  const limits = root.at('limits');
  return {
    path,
    envId: root.at('envId').str(),
    from: history.opt('from')?.str() ?? null,
    to: history.opt('to')?.str() ?? null,
    runs: history.at('runs').int(),
    limits: `window of ${limits.at('windowRuns').int()}, judged from ${limits.at('minRunsToJudge').int()}, test trigger ${percent(limits.at('quarantineTriggerRate').num())}, suite budget ${percent(limits.at('suiteBudgetRate').num())}`,
    suites: root.at('suites').list(),
    tests: root.at('tests').list(),
  };
}

export function renderFlake(files: FileSet): Rendered {
  const paths = files.list(FLAKE_DIR, FLAKE_REPORT_PATTERN);
  if (paths.length === 0) return emptyState('flake reports', FLAKE_DIR);
  const reports = paths.map((path) => readReport(files, path));

  const suiteRows = reports.flatMap((report) =>
    report.suites.map((suite) => {
      const experimental = suite.opt('experimental')?.bool() === true;
      return [
        code(report.envId),
        link(report.path.slice(FLAKE_DIR.length + 1), report.path),
        `${code(suite.at('project').str())}${experimental ? ' (experimental)' : ''}`,
        String(suite.at('builds').int()),
        String(suite.at('executions').int()),
        String(suite.at('flaky').int()),
        String(suite.at('failed').int()),
        percent(suite.at('flakeRate').num()),
        percent(suite.at('budget').num()),
        suite.at('verdict').str(),
      ];
    }),
  );
  if (suiteRows.length === 0)
    throw new ResultsError(`${FLAKE_DIR}: the reports hold no engine job (suites is empty in every file)`);

  const notable = reports.flatMap((report) =>
    report.tests
      .filter((test) => test.at('flaky').int() > 0 || test.at('failed').int() > 0)
      .map((test) => [
        code(report.envId),
        code(test.at('id').str()),
        code(test.at('project').str()),
        String(test.at('executions').int()),
        String(test.at('flaky').int()),
        String(test.at('failed').int()),
        percent(test.at('flakeRate').num()),
        test.at('verdict').str(),
        shorten(test.opt('lastFailure')?.opt('signature')?.str() ?? 'none recorded', 110),
      ]),
  );

  const lines = [
    mdTable(
      [
        'Environment',
        'Report',
        'Engine job',
        'Builds',
        'Executions',
        'Flaky',
        'Failed',
        'Flake rate',
        'Budget',
        'Verdict',
      ],
      suiteRows,
    ),
    '',
    `Merge-tier tests only, quarantined ones left out; a flaky execution is one that failed and then passed on its retry. ${[...new Set(reports.map((r) => r.limits))].map((l) => `Policy: ${l}.`).join(' ')} ${plural(reports.length, 'report')}: ${reports.map((r) => `${code(r.envId)} ${plural(r.runs, 'recorded run')}${r.from && r.to ? ` (${r.from} to ${r.to})` : ''}`).join('; ')}.`,
    '',
    notable.length === 0
      ? 'No test flaked or failed in the committed histories.'
      : mdTable(
          [
            'Environment',
            'Test',
            'Engine',
            'Executions',
            'Flaky',
            'Failed',
            'Rate',
            'Verdict',
            'Last failure',
          ],
          notable,
        ),
  ];
  return data(lines.join('\n'));
}
