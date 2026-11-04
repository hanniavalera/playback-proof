// RESULTS_READINESS and RESULTS_SOAK: the readiness checks and the soaks of docs/results/readiness and docs/results/soak, as the README
// shows them. The numbers are not computed here: they come through `src/lab/readiness/evidence.ts`, the join that docs/READINESS.md's own
// generator (`npm run results:docs`, tools/results-docs.ts) uses, which REFUSES a result file that is not the one its job uploaded
// (SHA-256 against docs/results/provenance), a name that is not the one its content gets, and a machine record of another commit or
// environment. One data path, two documents: the README shows the verdicts and counts, docs/READINESS.md the whole analysis.
import { EvidenceError, buildEvidence, renderVerdicts } from '../../src/lab/readiness/evidence.ts';
import type { EvidenceEntry } from '../../src/lab/readiness/evidence.ts';
import { soakVerdictToday } from '../../src/lab/readiness/report.ts';
import type { ReadinessReport, SoakReport } from '../../src/lab/readiness/report.ts';
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Rendered } from './files.ts';
import { code, link, listOf, mdTable, plural } from './format.ts';

export const READINESS_DIR = 'docs/results/readiness';
export const SOAK_DIR = 'docs/results/soak';
export const PROVENANCE_DIR = 'docs/results/provenance';
export const PROVENANCE_RUNS = `${PROVENANCE_DIR}/runs.json`;
const READINESS_PAGE = 'docs/READINESS.md';
const MANIFEST = `${READINESS_DIR}/README.md`;

/** The evidence, joined and verified; null when no result file is committed at all. */
function evidenceOf(files: FileSet): EvidenceEntry[] | null {
  const committed = [...files.list(READINESS_DIR, /\.json$/), ...files.list(SOAK_DIR, /\.json$/)];
  if (committed.length === 0) return null;
  if (!files.has(PROVENANCE_RUNS)) {
    throw new ResultsError(
      `${PROVENANCE_RUNS}: the file is missing (the provenance that every readiness and soak result is joined to)`,
    );
  }
  try {
    const { runs, entries } = buildEvidence({
      runs: files.text(PROVENANCE_RUNS),
      result: (file) => Buffer.from(files.text(file), 'utf8'),
      machine: (label) => files.text(`${PROVENANCE_DIR}/machines/${label}.txt`),
    });
    const joined = new Set(runs.runs.map((run) => run.file));
    const stray = committed.filter((path) => !joined.has(path));
    if (stray.length > 0) {
      throw new ResultsError(
        `${stray[0]}: a result file that no entry of ${PROVENANCE_RUNS} names (${plural(stray.length, 'file')}): the README would not show it`,
      );
    }
    return entries;
  } catch (error) {
    if (error instanceof EvidenceError) throw new ResultsError(error.message);
    throw error;
  }
}

const readinessOf = (entries: readonly EvidenceEntry[]): Array<EvidenceEntry & { report: ReadinessReport }> =>
  entries.filter(
    (entry): entry is EvidenceEntry & { report: ReadinessReport } => entry.report.kind === 'readiness',
  );

const soaksOf = (entries: readonly EvidenceEntry[]): Array<EvidenceEntry & { report: SoakReport }> =>
  entries.filter((entry): entry is EvidenceEntry & { report: SoakReport } => entry.report.kind === 'soak');

const commitsOf = (entries: readonly EvidenceEntry[]): string =>
  listOf(
    [...new Set(entries.map((entry) => entry.report.commit.hash ?? 'no commit'))].map((hash) =>
      code(hash.slice(0, 7)),
    ),
  );

const BATCHES: Record<string, string> = { first: 'the first evidence', extra: 'the extra runs' };
const batchName = (batch: string): string => BATCHES[batch] ?? `the runs of batch ${batch}`;

export function renderReadiness(files: FileSet): Rendered {
  const entries = evidenceOf(files);
  if (entries === null) return emptyState('readiness results', READINESS_DIR);
  const runs = readinessOf(entries);
  if (runs.length === 0)
    throw new ResultsError(`${READINESS_DIR}: no readiness result is committed (only soaks)`);
  const batches = [...new Set(runs.map((entry) => entry.run.batch))];
  const sections = batches.flatMap((batch) => {
    const mine = runs.filter((entry) => entry.run.batch === batch);
    const protocols = [...new Set(mine.map((entry) => entry.report.stream.protocol.toUpperCase()))];
    return [
      `**${listOf(protocols)}, ${batchName(batch)}** (${plural(mine.length, 'run')} of commit ${commitsOf(mine)})`,
      '',
      renderVerdicts(mine),
      '',
    ];
  });
  return data(
    [
      `Readiness checks PB-RDY-001 to PB-RDY-004 (TEST_STRATEGY.md section 8), run on GitHub-hosted runners through \`measure.yml\`. Each file is joined to the run, runner and machine record that made it, byte for byte (${link('manifest', MANIFEST)}); the analysis is ${link('docs/READINESS.md', READINESS_PAGE)}, and \`npm run results:docs\` keeps its tables in step with the same files.`,
      '',
      ...sections,
    ]
      .join('\n')
      .trimEnd(),
  );
}

const sorted = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

export function renderSoak(files: FileSet): Rendered {
  const entries = evidenceOf(files);
  if (entries === null) return emptyState('soak results', SOAK_DIR);
  const soaks = soaksOf(entries);
  if (soaks.length === 0)
    throw new ResultsError(`${SOAK_DIR}: no soak result is committed (only readiness runs)`);

  const groups = new Map<string, Array<EvidenceEntry & { report: SoakReport }>>();
  for (const entry of soaks) {
    const faults = [...new Set(entry.report.faults.map((fault) => fault.kind))].sort().join(', ');
    const key = [entry.run.batch, entry.report.envId, entry.report.configuration.id, faults].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const rows = [...groups.values()]
    .sort((a, b) => {
      const key = (group: Array<EvidenceEntry & { report: SoakReport }>): string[] => {
        const entry = group[0] as EvidenceEntry & { report: SoakReport };
        return [
          entry.report.envId,
          entry.run.batch === 'first' ? '' : entry.run.batch,
          entry.report.configuration.id === 'A' ? '' : entry.report.configuration.id,
          String(Math.min(...group.map((e) => e.report.options.minutes))).padStart(4, '0'),
        ];
      };
      return key(a).join('\u0000').localeCompare(key(b).join('\u0000'));
    })
    .map((group) => {
      const first = group[0] as EvidenceEntry & { report: SoakReport };
      const faults = [
        ...new Set(group.flatMap((entry) => entry.report.faults.map((fault) => fault.kind))),
      ].sort();
      const levels = group.flatMap((entry) => {
        const line = entry.report.evaluations.find((evaluation) => evaluation.id === 'soak.latency-p95');
        return line === undefined || line.value === null || line.verdict === 'N/A' ? [] : [line.value / 1000];
      });
      const go = (pick: (report: SoakReport) => string): number =>
        group.filter((entry) => pick(entry.report) === 'GO').length;
      return [
        batchName(first.run.batch),
        code(first.report.envId),
        first.report.configuration.id,
        String(group.length),
        `${listOf(sorted(group.map((entry) => entry.report.options.minutes)).map(String))} min`,
        faults.length === 0 ? 'nothing' : listOf(faults.map(code)),
        `${go((report) => report.verdict)} of ${group.length}`,
        `${go((report) => soakVerdictToday(report).verdict)} of ${group.length}`,
        levels.length === 0
          ? 'not measured'
          : Math.min(...levels) === Math.max(...levels)
            ? `${Math.min(...levels).toFixed(2)} s`
            : `${Math.min(...levels).toFixed(2)} to ${Math.max(...levels).toFixed(2)} s`,
      ];
    });
  return data(
    [
      `Soaks of PB-RDY-005 on GitHub-hosted runners, grouped by evidence, environment, configuration and what was injected (${plural(soaks.length, 'soak')} in all, joined to their runs like the readiness results above; ${link('docs/READINESS.md', READINESS_PAGE)} has a row for each soak). "As measured" is the verdict the file holds; "by today's criteria" judges the stored series again with the criteria now in the code, without a number in the file being touched.`,
      '',
      mdTable(
        [
          'Evidence',
          'Environment',
          'Configuration',
          'Soaks',
          'Lengths',
          'Injected',
          'GO as measured',
          "GO by today's criteria",
          'Latency p95 after the faults',
        ],
        rows,
      ),
    ].join('\n'),
  );
}
