// RESULTS_FLAKE: what the flake collections of docs/results/flake measured, counted from their raw histories. A collection is one or
// more repetitions of a Playwright invocation (one retry, the flake reporter) on a runner; its raw file is the history the collector
// wrote, one FlakeRun per line (flake/run.ts), parsed by the tracker's own `parseHistory`, which refuses what it does not understand.
// The counts are the tracker's definitions: an EXECUTION is a test that ran to a verdict; it is FLAKY when it failed its first attempt
// and passed a retry, FAILED when it never passed, and an INVALID RUN is a skip whose reason starts with the prefix of ADR-106 (the
// attempt could not evaluate its claim), counted in no rate. The reports and the write-up beside the raw files are not read: the
// reports' windows can be shorter than the collection, and the prose is the author's.
import { HistoryError, parseHistory } from '../../flake/history.ts';
import { isExecuted, isInvalidRun } from '../../flake/run.ts';
import type { FlakeRun } from '../../flake/run.ts';
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Rendered } from './files.ts';
import { code, day, link, mdTable, percent, plural } from './format.ts';

export const FLAKE_DIR = 'docs/results/flake';
/** The raw histories: `<collection>/raw/[<engine job>/]<environment id>.jsonl`, tested against the whole path. */
export const FLAKE_RAW_PATTERN = /^docs\/results\/flake\/(?:.+\/)?raw\/(?:[^/]+\/)?[^/]+\.jsonl$/;
/** The same, against the part of the path under the flake directory. */
const RAW_UNDER_DIR = /^(?:.+\/)?raw\/(?:[^/]+\/)?[^/]+\.jsonl$/;

export interface Counts {
  executions: number;
  flaky: number;
  failed: number;
  /** Skipped, and the reason starts with the invalid-run prefix. */
  invalid: number;
  /** Skipped for another reason: a documented gap. */
  otherSkips: number;
}

export interface Collection {
  /** The directory of the collection under docs/results/flake, with the engine job when the collection has one per job. */
  name: string;
  path: string;
  envId: string;
  /** The Playwright project: `webkit` for both WebKit jobs. */
  project: string;
  repetitions: number;
  commits: string[];
  from: string;
  to: string;
  totals: Counts;
  perTest: Map<string, Counts>;
}

const COLLECTION_ORDER = ['collect-1', 'abr-002-macos-40', 'after-fix', 'demo-deliberate-flake'];

const empty = (): Counts => ({ executions: 0, flaky: 0, failed: 0, invalid: 0, otherSkips: 0 });

function add(counts: Counts, test: FlakeRun['tests'][number]): void {
  if (isExecuted(test.outcome)) {
    counts.executions += 1;
    if (test.outcome === 'flaky') counts.flaky += 1;
    if (test.outcome === 'failed' || test.outcome === 'timedOut') counts.failed += 1;
  } else if (test.outcome === 'skipped') {
    if (isInvalidRun(test)) counts.invalid += 1;
    else counts.otherSkips += 1;
  }
}

function readHistory(files: FileSet, path: string): FlakeRun[] {
  try {
    return parseHistory(files.text(path), path);
  } catch (error) {
    if (error instanceof HistoryError) throw new ResultsError(`${path}: ${error.message}`);
    throw error;
  }
}

interface Accumulator {
  runs: Set<string>;
  commits: Set<string>;
  dates: string[];
  totals: Counts;
  perTest: Map<string, Counts>;
}

/** Every collection and engine project of the raw histories, counted. */
export function readCollections(files: FileSet): Collection[] {
  const found: Collection[] = [];
  for (const path of files.list(FLAKE_DIR, RAW_UNDER_DIR)) {
    const relative = path.slice(FLAKE_DIR.length + 1);
    const [, head = '', job = ''] = /^(.+?)\/raw(?:\/([^/]+))?\/[^/]+\.jsonl$/.exec(relative) ?? [];
    const runs = readHistory(files, path);
    if (runs.length === 0) throw new ResultsError(`${path}: the history holds no run`);
    const projects = new Map<string, Accumulator>();
    for (const run of runs) {
      for (const test of run.tests) {
        const mine = projects.get(test.project) ?? {
          runs: new Set<string>(),
          commits: new Set<string>(),
          dates: [],
          totals: empty(),
          perTest: new Map<string, Counts>(),
        };
        projects.set(test.project, mine);
        if (!mine.runs.has(run.invocationId)) {
          mine.runs.add(run.invocationId);
          mine.commits.add(run.commit);
          mine.dates.push(run.date);
        }
        const own = mine.perTest.get(test.id) ?? empty();
        mine.perTest.set(test.id, own);
        add(mine.totals, test);
        add(own, test);
      }
    }
    for (const [project, mine] of projects) {
      const dates = [...mine.dates].sort();
      found.push({
        name: job === '' ? head : `${head} / ${job}`,
        path,
        envId: runs[0]?.envId ?? '',
        project,
        repetitions: mine.runs.size,
        commits: [...mine.commits].sort(),
        from: dates[0] ?? '',
        to: dates[dates.length - 1] ?? '',
        totals: mine.totals,
        perTest: mine.perTest,
      });
    }
  }
  const rank = (name: string): number => {
    const head = name.split(' / ')[0] ?? name;
    const at = COLLECTION_ORDER.findIndex((prefix) => head === prefix || head.startsWith(`${prefix}/`));
    return at === -1 ? COLLECTION_ORDER.length : at;
  };
  return found.sort(
    (a, b) =>
      rank(a.name) - rank(b.name) || a.name.localeCompare(b.name) || a.project.localeCompare(b.project),
  );
}

const share = (part: number, whole: number): string => (whole === 0 ? 'n/a' : percent(part / whole));

export function renderFlake(files: FileSet): Rendered {
  if (files.list(FLAKE_DIR, RAW_UNDER_DIR).length === 0) return emptyState('flake collections', FLAKE_DIR);
  const collections = readCollections(files);

  const commitText = (commits: readonly string[]): string =>
    commits.length === 1 ? code((commits[0] ?? '').slice(0, 7)) : plural(commits.length, 'commit');
  const dateText = (c: Collection): string =>
    day(c.from) === day(c.to) ? day(c.from) : `${day(c.from)} to ${day(c.to)}`;
  const perCollection = mdTable(
    [
      'Collection',
      'Environment',
      'Engine project',
      'Repetitions',
      'Executions',
      'Flaky',
      'Failed (both attempts)',
      'Skipped as invalid run',
      'Other skips',
      'Commit',
      'Date (UTC)',
    ],
    collections.map((c) => [
      link(c.name, c.path),
      code(c.envId),
      code(c.project),
      String(c.repetitions),
      String(c.totals.executions),
      String(c.totals.flaky),
      String(c.totals.failed),
      String(c.totals.invalid),
      String(c.totals.otherSkips),
      commitText(c.commits),
      dateText(c),
    ]),
  );

  const notable = collections.flatMap((c) =>
    [...c.perTest.entries()]
      .filter(([, n]) => n.flaky > 0 || n.failed > 0 || n.invalid > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => [
        c.name,
        code(c.envId),
        code(id),
        code(c.project),
        String(n.executions),
        `${n.flaky + n.failed} of ${n.executions} (${share(n.flaky + n.failed, n.executions)})`,
        String(n.flaky),
        String(n.failed),
        `${n.invalid} of ${n.executions + n.invalid} (${share(n.invalid, n.executions + n.invalid)})`,
      ]),
  );

  const lines = [
    `Counted from the raw histories of ${plural(collections.length, 'collection')} under ${link(FLAKE_DIR, FLAKE_DIR)}, one line per repetition (a Playwright invocation with one retry and the flake reporter). An execution is a test that ran to a verdict; it is flaky when it failed its first attempt and passed its retry, and failed when both attempts failed. An invalid run is a skip whose reason starts with \`invalid run:\`: the attempt could not evaluate its claim, and no rate counts it (\`docs/FLAKE.md\`, "Invalid runs").`,
    '',
    perCollection,
    '',
    notable.length === 0
      ? 'No test flaked, failed or was skipped as an invalid run in these collections.'
      : [
          'The tests that flaked, failed or were skipped as invalid runs:',
          '',
          mdTable(
            [
              'Collection',
              'Environment',
              'Test',
              'Engine project',
              'Executions',
              'First attempt failed',
              'Flaky',
              'Failed (both attempts)',
              'Invalid runs, of the scheduled attempts',
            ],
            notable,
          ),
        ].join('\n'),
  ];
  return data(lines.join('\n'));
}
