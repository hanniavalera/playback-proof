import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  isBusy,
  parseReadinessReport,
  parseSoakReport,
  readinessFileNameOf,
  soakFileNameOf,
  soakVerdictToday,
} from './report.ts';
import type { ReadinessReport, SoakReport } from './report.ts';
import { formatValue } from './verdict.ts';
import type { Evaluation, ValueUnit } from './verdict.ts';

// The provenance of the committed result files and the tables that are generated from them (docs/decisions/readiness-evidence.md,
// ADR-159a and ADR-159c; docs/results/readiness/README.md and docs/READINESS.md hold the output). A result file says what was measured and
// on which commit; it does not say which run of which workflow made it, on which runner and CPU, or how busy that machine was when the job
// began, and it must not: those are facts of a job on GitHub, and a stray key in a result file is a key every reader has to know. They are
// kept apart in docs/results/provenance (`runs.json`, written by hand from the dispatch, and one `machines/<label>.txt` per job, as the
// workflow printed it), and this module joins them to the files and REFUSES a join that does not hold: a file that is not what the job
// uploaded, a name that is not the one its content gets, a machine record of another commit or another environment.
//
// Everything is a function of text and bytes, so the tables are tested without the disk (tests/unit/readiness/evidence.test.ts); the
// command that writes them is tools/results-docs.ts.

export class EvidenceError extends Error {
  override name = 'EvidenceError';
}

// ---------------------------------------------------------------------------------------------------------------------
// runs.json

export type EvidenceTask = 'readiness' | 'soak';

export interface RunRecord {
  /** What the run was dispatched with: the name of its artifact on GitHub. */
  label: string;
  /** The id of the workflow run (its URL is `https://github.com/<repository>/actions/runs/<runId>`). */
  runId: number;
  task: EvidenceTask;
  /** Where the file is committed, from the repository root. */
  file: string;
  /** The path inside the artifact: the name the job gave the file, which two jobs of one engine and length shared. */
  uploadedAs: string;
  /** SHA-256 of the file as the job uploaded it. */
  sha256: string;
}

export interface RunsFile {
  schemaVersion: 1;
  repository: string;
  workflow: string;
  runs: RunRecord[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '')
    throw new EvidenceError(`${where}: "${key}" must be a non-empty string`);
  return value;
}

export function parseRunsFile(source: string, file = 'runs.json'): RunsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new EvidenceError(`${file}: not JSON (${(error as Error).message})`, { cause: error });
  }
  if (!isRecord(raw) || raw['schemaVersion'] !== 1)
    throw new EvidenceError(`${file}: schemaVersion must be 1`);
  const repository = text(raw, 'repository', file);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new EvidenceError(`${file}: repository must be owner/name`);
  const workflow = text(raw, 'workflow', file);
  if (!Array.isArray(raw['runs']) || raw['runs'].length === 0)
    throw new EvidenceError(`${file}: runs must be a non-empty array`);
  const labels = new Set<string>();
  const files = new Set<string>();
  const runs = raw['runs'].map((entry: unknown, index): RunRecord => {
    const where = `${file}: runs[${index}]`;
    if (!isRecord(entry)) throw new EvidenceError(`${where} is not an object`);
    const label = text(entry, 'label', where);
    const task = entry['task'];
    if (task !== 'readiness' && task !== 'soak')
      throw new EvidenceError(`${where}: task must be "readiness" or "soak"`);
    const runId = entry['runId'];
    if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0)
      throw new EvidenceError(`${where}: runId must be a positive integer`);
    const path = text(entry, 'file', where);
    if (!new RegExp(`^docs/results/${task}/[^/]+\\.json$`).test(path))
      throw new EvidenceError(`${where}: file must be docs/results/${task}/<name>.json`);
    const sha256 = text(entry, 'sha256', where);
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new EvidenceError(`${where}: sha256 must be 64 lower-case hex digits`);
    if (labels.has(label)) throw new EvidenceError(`${where}: the label ${label} is used twice`);
    if (files.has(path)) throw new EvidenceError(`${where}: the file ${path} is used twice`);
    labels.add(label);
    files.add(path);
    return { label, runId, task, file: path, uploadedAs: text(entry, 'uploadedAs', where), sha256 };
  });
  return { schemaVersion: 1, repository, workflow, runs };
}

export const runUrl = (repository: string, runId: number): string =>
  `https://github.com/${repository}/actions/runs/${runId}`;

// ---------------------------------------------------------------------------------------------------------------------
// machines/<label>.txt

export interface UptimeReading {
  /** The line as the workflow printed it. */
  line: string;
  /** How long the runner had been up. */
  up: string;
  load1: number;
  load5: number;
  load15: number;
}

export interface MachineRecord {
  label: string;
  /** `readiness, engine chromium, runner ubuntu-24.04`. */
  measure: string;
  started: string;
  finished: string;
  /** The commit the job checked out, in full. */
  commit: string;
  environmentId: string;
  /** `Linux X64, github-hosted, image ubuntu24 20261026.354.1`. */
  runner: string;
  /** `ubuntu24 20261026.354.1`. */
  image: string;
  cpus: number;
  cpu: string;
  memoryMiB: number;
  os: string;
  node: string;
  playwright: string;
  uptimeAtStart: UptimeReading;
  uptimeAtEnd: UptimeReading;
}

const UPTIME = /\bup\s+(.+?),\s+\d+\s+users?,\s+load averages?:\s+([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/;

function parseUptime(line: string, where: string): UptimeReading {
  const found = UPTIME.exec(line);
  if (!found) throw new EvidenceError(`${where}: cannot read the uptime line "${line}"`);
  const [, up, one, five, fifteen] = found;
  return {
    line: line.replace(/^uptime:\s*/, '').trim(),
    up: up ?? '',
    load1: Number(one),
    load5: Number(five),
    load15: Number(fifteen),
  };
}

export function parseMachineRecord(source: string, label: string): MachineRecord {
  const where = `machines/${label}.txt`;
  const lines = source.split(/\r?\n/);
  const field = (key: string): string => {
    const prefix = `${key}: `;
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) throw new EvidenceError(`${where}: no "${key}" line`);
    return line.slice(prefix.length).trim();
  };
  const uptimes = lines.filter((line) => line.startsWith('uptime:'));
  if (uptimes.length !== 2)
    throw new EvidenceError(
      `${where}: expected the uptime at the start and at the end, found ${uptimes.length} lines`,
    );
  if (field('label') !== label)
    throw new EvidenceError(`${where}: the record says it is for "${field('label')}"`);
  const runner = field('runner');
  const image = /image (\S+ \S+)\s*$/.exec(runner)?.[1];
  if (image === undefined) throw new EvidenceError(`${where}: no image in "${runner}"`);
  const commit = /^([0-9a-f]{40})\b/.exec(field('commit'))?.[1];
  if (commit === undefined) throw new EvidenceError(`${where}: no full commit hash in "${field('commit')}"`);
  const memory = /^(\d+) MiB$/.exec(field('memory'))?.[1];
  const cpus = /^\d+$/.test(field('cpus')) ? Number(field('cpus')) : null;
  if (memory === undefined || cpus === null)
    throw new EvidenceError(`${where}: cpus and memory must be numbers`);
  const [start, end] = uptimes as [string, string];
  return {
    label,
    measure: field('measure'),
    started: field('started'),
    finished: field('finished'),
    commit,
    environmentId: field('environment id'),
    runner,
    image,
    cpus,
    cpu: field('cpu'),
    memoryMiB: Number(memory),
    os: field('os'),
    node: /^(v[\d.]+)/.exec(field('node'))?.[1] ?? field('node'),
    playwright: field('playwright').replace(/^Version\s+/, ''),
    uptimeAtStart: parseUptime(start, where),
    uptimeAtEnd: parseUptime(end, where),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The join

export interface EvidenceEntry {
  run: RunRecord;
  machine: MachineRecord;
  report: ReadinessReport | SoakReport;
  /** SHA-256 of the bytes that were read, which `buildEvidence` has checked against the provenance. */
  sha256: string;
}

export interface EvidenceSource {
  runs: string;
  /** The bytes of a committed result file, from the repository root. */
  result(file: string): Buffer;
  machine(label: string): string;
}

const ENGINES = ['chromium', 'firefox', 'webkit'];
const engineRank = (engine: string): number => {
  const at = ENGINES.indexOf(engine);
  return at === -1 ? ENGINES.length : at;
};

/** Environments alphabetically; in one, the readiness runs before the soaks, then by engine, protocol, length, A before its candidates. */
function orderOf(a: EvidenceEntry, b: EvidenceEntry): number {
  const key = (entry: EvidenceEntry): Array<string | number> => {
    const report = entry.report;
    const soak = report.kind === 'soak' ? report : null;
    return [
      report.envId,
      soak === null ? 0 : 1,
      engineRank(report.engine),
      report.stream.protocol,
      soak?.options.minutes ?? 0,
      soak === null || soak.configuration.id === 'A' ? '' : soak.configuration.id,
      entry.run.file,
    ];
  };
  const left = key(a);
  const right = key(b);
  for (let i = 0; i < left.length; i++) {
    const x = left[i] as string | number;
    const y = right[i] as string | number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function buildEvidence(source: EvidenceSource): { runs: RunsFile; entries: EvidenceEntry[] } {
  const runs = parseRunsFile(source.runs);
  const entries = runs.runs.map((run): EvidenceEntry => {
    const bytes = source.result(run.file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== run.sha256)
      throw new EvidenceError(
        `${run.file}: the file is not what the job uploaded (SHA-256 ${sha256}, the provenance says ${run.sha256}). A result file is never edited: restore it, or re-measure and replace the provenance with the new run.`,
      );
    const decoded = bytes.toString('utf8');
    const report =
      run.task === 'readiness' ? parseReadinessReport(decoded, run.file) : parseSoakReport(decoded, run.file);
    const expectedName = report.kind === 'readiness' ? readinessFileNameOf(report) : soakFileNameOf(report);
    if (basename(run.file) !== expectedName)
      throw new EvidenceError(
        `${run.file}: the name is not the one its content gets (${expectedName}): two runs would be taken for one`,
      );
    const machine = parseMachineRecord(source.machine(run.label), run.label);
    if (machine.environmentId !== report.envId)
      throw new EvidenceError(
        `${run.file}: the file says it was measured on ${report.envId} and the machine record of ${run.label} says ${machine.environmentId}`,
      );
    if (report.commit.hash === null || !machine.commit.startsWith(report.commit.hash))
      throw new EvidenceError(
        `${run.file}: the file says commit ${report.commit.hash} and the job checked out ${machine.commit}`,
      );
    return { run, machine, report, sha256 };
  });
  return { runs, entries: entries.sort(orderOf) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words and numbers

const quantity = (value: number, unit: ValueUnit): string =>
  unit === 'MB' ? `${value.toFixed(2)} MB` : formatValue(value, unit);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

/** `6.07 s`, or `6.07 to 6.18 s` when the runs differ at the digits shown. */
function secondsRange(values: readonly number[]): string {
  const rounded = values.map((value) => Number((value / 1000).toFixed(2)));
  const low = Math.min(...rounded);
  const high = Math.max(...rounded);
  return low === high ? `${low.toFixed(2)} s` : `${low.toFixed(2)} to ${high.toFixed(2)} s`;
}

const clock = (ms: number): string => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** The margin: how much room the value had under (at-most) or over (at-least) the limit; negative when the limit was not met. */
export function marginOf(evaluation: Pick<Evaluation, 'value' | 'limit' | 'bound'>): number | null {
  if (evaluation.value === null) return null;
  return evaluation.bound === 'at-most'
    ? evaluation.limit - evaluation.value
    : evaluation.value - evaluation.limit;
}

function valueWithMargin(evaluation: Evaluation | undefined): string {
  if (evaluation === undefined) return 'not run';
  if (evaluation.value === null || evaluation.verdict === 'N/A') return 'not measured';
  const margin = marginOf(evaluation);
  const value = `${evaluation.censored ? 'at least ' : ''}${quantity(evaluation.value, evaluation.unit)}`;
  if (margin === null) return value;
  if (margin >= 0) return `${value} (margin ${quantity(margin, evaluation.unit)})`;
  return `${value} (over by ${evaluation.censored ? 'at least ' : ''}${quantity(-margin, evaluation.unit)})`;
}

const line = (evaluations: readonly Evaluation[], id: string): Evaluation | undefined =>
  evaluations.find((evaluation) => evaluation.id === id);

function loadCell(report: ReadinessReport | SoakReport): string {
  const load = report.load;
  if (load === undefined) return 'not recorded';
  const busy = isBusy(load.before) ? ', busy at the start' : '';
  return `${load.before.load1.toFixed(2)} to ${load.after.load1.toFixed(2)} (${load.before.cpus} CPUs${busy})`;
}

const engineText = (report: ReadinessReport | SoakReport): string =>
  `${report.browser.name} ${report.browser.version}${report.stream.protocol === 'dash' ? '' : ` (${report.stream.protocol})`}`;

const link = (repository: string, runId: number): string => `[${runId}](${runUrl(repository, runId)})`;

function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** One block per environment, in the order of the entries: a result of one environment is never in a table of another (ADR-159a). */
function perEnvironment(
  entries: readonly EvidenceEntry[],
  render: (environment: string, mine: EvidenceEntry[], runner: string) => string | null,
): string {
  const ids = [...new Set(entries.map((entry) => entry.report.envId))];
  const blocks = ids.flatMap((id) => {
    const mine = entries.filter((entry) => entry.report.envId === id);
    const runner = mine[0]?.machine.runner.replace(/, image .*$/, '') ?? '';
    const block = render(id, mine, runner);
    return block === null ? [] : [`**${id}** (${runner}):\n\n${block}`];
  });
  return blocks.join('\n\n');
}

const readinessOf = (entries: readonly EvidenceEntry[]): Array<EvidenceEntry & { report: ReadinessReport }> =>
  entries.filter(
    (entry): entry is EvidenceEntry & { report: ReadinessReport } => entry.report.kind === 'readiness',
  );
const soaksOf = (entries: readonly EvidenceEntry[]): Array<EvidenceEntry & { report: SoakReport }> =>
  entries.filter((entry): entry is EvidenceEntry & { report: SoakReport } => entry.report.kind === 'soak');

function soakVerdictText(report: SoakReport): string {
  const today = soakVerdictToday(report).verdict;
  return today === report.verdict
    ? report.verdict
    : `${report.verdict} as measured, ${today} by today's criteria`;
}

const commitText = (report: ReadinessReport | SoakReport): string =>
  `${report.commit.hash ?? 'unknown'}${report.commit.dirty ? ' (dirty)' : ''}`;

// ---------------------------------------------------------------------------------------------------------------------
// The manifest of docs/results/readiness/README.md

export function renderManifest(entries: readonly EvidenceEntry[], repository: string): string {
  const results = perEnvironment(entries, (_id, mine) =>
    table(
      [
        'File',
        'Run',
        'Commit',
        'Task',
        'Engine',
        'Configuration',
        'Length',
        'Verdict',
        'Duration',
        'Runner image',
        'CPU',
        'Load before to after (1 min)',
      ],
      mine.map((entry) => {
        const { report, run, machine } = entry;
        const common = [link(repository, run.runId), commitText(report)];
        const where = [machine.image, `${machine.cpu}, ${machine.cpus} CPUs`, loadCell(report)];
        return report.kind === 'readiness'
          ? [
              `\`${basename(run.file)}\``,
              ...common,
              'readiness',
              engineText(report),
              report.configurations.map((configuration) => configuration.id).join(', '),
              `${report.options.joins} joins, ${report.options.stallRuns} outages`,
              report.configurations
                .map((configuration) => `${configuration.id} ${configuration.verdict}`)
                .join('; '),
              clock(report.durationMs),
              ...where,
            ]
          : [
              `\`${basename(run.file)}\``,
              ...common,
              'soak',
              engineText(report),
              report.configuration.id,
              `${report.options.minutes} min (${report.length})`,
              soakVerdictText(report),
              clock(report.durationMs),
              ...where,
            ];
      }),
    ),
  );
  const machines = perEnvironment(entries, (_id, mine) =>
    table(
      [
        'File',
        'Started to finished (UTC)',
        'OS',
        'Memory',
        'Runner up at the start',
        'Runner up at the end',
        'Node',
        'Playwright',
      ],
      mine.map(({ run, machine }) => [
        `\`${basename(run.file)}\``,
        `${machine.started} to ${machine.finished}`,
        machine.os,
        `${machine.memoryMiB} MiB`,
        `${machine.uptimeAtStart.up}, load ${machine.uptimeAtStart.load1.toFixed(2)} ${machine.uptimeAtStart.load5.toFixed(2)} ${machine.uptimeAtStart.load15.toFixed(2)}`,
        `${machine.uptimeAtEnd.up}, load ${machine.uptimeAtEnd.load1.toFixed(2)} ${machine.uptimeAtEnd.load5.toFixed(2)} ${machine.uptimeAtEnd.load15.toFixed(2)}`,
        machine.node,
        machine.playwright,
      ]),
    ),
  );
  const names = table(
    ['File', 'Uploaded as', 'SHA-256 of the file as the job uploaded it'],
    entries.map(({ run }) => [
      `\`${basename(run.file)}\``,
      basename(run.file) === basename(run.uploadedAs)
        ? 'the same name'
        : `\`${run.uploadedAs}\` (renamed when it was copied)`,
      `\`${run.sha256}\``,
    ]),
  );
  return [
    'Results, one table per environment (a row is one file; the machine is the runner of the job that wrote it):',
    results,
    "The machines (the first line of the uptime is the one the workflow printed when the job began, before the dependencies were installed; the load in the results above is the harness's own reading just before and just after its run):",
    machines,
    'Names and digests:',
    names,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The tables of docs/READINESS.md

const CHECKS = ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'] as const;

export function renderVerdicts(entries: readonly EvidenceEntry[]): string {
  return perEnvironment(entries, (_id, mine) => {
    const rows = readinessOf(mine).flatMap(({ report }) =>
      report.configurations.map((configuration) => [
        engineText(report),
        configuration.id,
        ...CHECKS.map((id) => configuration.checks.find((check) => check.id === id)?.verdict ?? 'not run'),
        configuration.verdict,
      ]),
    );
    return rows.length === 0 ? null : table(['Engine', 'Configuration', ...CHECKS, 'Verdict'], rows);
  });
}

/** What PB-RDY-003 measured, per engine and configuration, as the range over the outages of the run. */
export function renderRestore(entries: readonly EvidenceEntry[]): string {
  return perEnvironment(entries, (_id, mine) => {
    const rows = readinessOf(mine).flatMap(({ report }) =>
      report.configurations.flatMap((configuration) => {
        const check = configuration.checks.find((candidate) => candidate.id === 'PB-RDY-003');
        const absolute = line(check?.evaluations ?? [], 'stall.restore');
        const relative = line(check?.evaluations ?? [], 'stall.restore-relative');
        const recovery = line(check?.evaluations ?? [], 'stall.recovery');
        const runs = (absolute?.detail?.['runs'] ?? []) as Array<{
          latencyBeforeMs: number;
          finalLatencyMs: number;
          restoredAtMs: number | null;
          observedMs: number;
        }>;
        const relativeRuns = (relative?.detail?.['runs'] ?? []) as Array<{ restoredAtMs: number | null }>;
        const stalls = ((recovery?.detail?.['runs'] ?? []) as Array<{ recoveryMs: number | null }>).flatMap(
          (run) => (run.recoveryMs === null ? [] : [run.recoveryMs]),
        );
        if (runs.length === 0) return [];
        const back = (values: ReadonlyArray<number | null>): string => {
          const reached = values.flatMap((value) => (value === null ? [] : [value]));
          if (reached.length === 0) return `no run of ${values.length}`;
          return reached.length === values.length
            ? secondsRange(reached)
            : `${secondsRange(reached)} in ${reached.length} of ${values.length} runs`;
        };
        return [
          [
            engineText(report),
            configuration.id,
            secondsRange(runs.map((run) => run.latencyBeforeMs)),
            stalls.length === 0 ? 'no stall' : secondsRange(stalls),
            secondsRange(runs.map((run) => run.finalLatencyMs)),
            secondsRange(runs.map((run) => run.observedMs)),
            back(runs.map((run) => run.restoredAtMs)),
            back(relativeRuns.map((run) => run.restoredAtMs)),
            String(absolute?.detail?.['maxPlaybackRate'] ?? 'not recorded'),
            absolute?.verdict ?? 'not run',
          ],
        ];
      }),
    );
    return rows.length === 0
      ? null
      : table(
          [
            'Engine',
            'Configuration',
            'Latency before the outage',
            'Stall after the outage',
            'Latency when the observation ended',
            'Observed',
            'Back under the maximum after',
            'Back at its own level after',
            'Highest playback rate',
            'Verdict (the limit is the absolute reading)',
          ],
          rows,
        );
  });
}

const percent = (ratio: number): string => `${(ratio * 100).toFixed(2)} %`;

/** `toFixed`, without the `-0.0` that a value that rounds to zero would print. */
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** The soaks, with the value of every criterion as stored, and the verdict by the criteria of today next to the one measured. */
export function renderSoaks(entries: readonly EvidenceEntry[]): string {
  return perEnvironment(entries, (_id, mine) => {
    const rows = soaksOf(mine).map(({ report }) => {
      const lines = report.evaluations;
      const value = (id: string, render: (amount: number, evaluation: Evaluation) => string): string => {
        const found = line(lines, id);
        return found === undefined || found.value === null || found.verdict === 'N/A'
          ? 'not measured'
          : render(found.value, found);
      };
      const drift = line(lines, 'soak.latency-drift');
      return [
        engineText(report),
        report.configuration.id,
        `${report.options.minutes} min`,
        report.verdict,
        soakVerdictToday(report).verdict,
        value('soak.rebuffer-ratio', percent),
        value(
          'soak.latency-drift',
          (change) =>
            `${fixed(change, 1)} ms (slope ${fixed(Number(drift?.detail?.['slopeMsPerHour'] ?? 0), 0)} ms/h)`,
        ),
        `${value('soak.latency-p95', (amount) => seconds(amount))} / ${value('soak.latency-max', (amount) => seconds(amount))}`,
        value('soak.heap-growth', (amount) => `${amount.toFixed(2)} MB`),
        value('soak.dropped-frames', percent),
        `${line(lines, 'soak.unexplained-critical-errors')?.value ?? 'not measured'} / ${line(lines, 'soak.unexplained-recoverable-errors')?.value ?? 'not measured'}`,
        String(line(lines, 'soak.stalls')?.value ?? 'not measured'),
      ];
    });
    return rows.length === 0
      ? null
      : table(
          [
            'Engine',
            'Configuration',
            'Length',
            'Verdict as measured',
            "Verdict by today's criteria",
            'Rebuffer ratio',
            'Latency drift over the soak',
            'Latency p95 / maximum after the faults',
            'JS heap growth',
            'Dropped frames',
            'Unexplained errors, critical / recoverable',
            'Unrecovered stalls',
          ],
          rows,
        );
  });
}

const READINESS_LINES: ReadonlyArray<readonly [string, string]> = [
  ['start.worst', 'PB-RDY-001 start time, worst of the joins'],
  ['latency.p95', 'PB-RDY-002 latency, p95'],
  ['latency.max', 'PB-RDY-002 latency, maximum'],
  ['stall.recovery', 'PB-RDY-003 stall after the outage, worst run'],
  ['stall.restore', 'PB-RDY-003 time to restore the latency, worst run'],
  ['cadence.median', 'PB-RDY-004 manifest refresh, median gap'],
  ['cadence.longest', 'PB-RDY-004 manifest refresh, longest gap'],
];

const SOAK_LINES: ReadonlyArray<readonly [string, string]> = [
  ['soak.rebuffer-ratio', 'Rebuffer ratio'],
  ['soak.latency-drift', 'Latency drift'],
  ['soak.latency-p95', 'Latency p95'],
  ['soak.latency-max', 'Latency maximum'],
  ['soak.heap-growth', 'JS heap growth'],
  ['soak.dropped-frames', 'Dropped frames'],
];

/** The room each line had, per engine and configuration, from the value and the limit of the file: a margin is a measurement (ADR-159b). */
function finalLatencyCell(report: ReadinessReport, configurationId: string): string {
  const configuration = report.configurations.find((candidate) => candidate.id === configurationId);
  const restore = line(configuration?.checks.flatMap((check) => check.evaluations) ?? [], 'stall.restore');
  const maximum = restore?.detail?.['maxLatencyMs'];
  const runs = (restore?.detail?.['runs'] ?? []) as Array<{ finalLatencyMs: number }>;
  if (typeof maximum !== 'number' || runs.length === 0) return 'not run';
  const finals = runs.map((run) => run.finalLatencyMs);
  const margins = finals.map((final) => maximum - final);
  const over = margins.every((margin) => margin < 0);
  return `${secondsRange(finals)} (${over ? `over by ${secondsRange(margins.map((margin) => -margin))}` : `margin ${secondsRange(margins)}`})`;
}

export function renderMargins(entries: readonly EvidenceEntry[]): string {
  const readiness = perEnvironment(entries, (_id, mine) => {
    const reports = readinessOf(mine).map(({ report }) => report);
    if (reports.length === 0) return null;
    const configurations = [
      ...new Set(reports.flatMap((report) => report.configurations.map((configuration) => configuration.id))),
    ];
    const rows = READINESS_LINES.flatMap(([id, label]) => [
      ...configurations.map((configurationId) => [
        label,
        configurationId,
        ...reports.map((report) => {
          const configuration = report.configurations.find((candidate) => candidate.id === configurationId);
          const evaluations = configuration?.checks.flatMap((check) => check.evaluations) ?? [];
          return valueWithMargin(line(evaluations, id));
        }),
      ]),
      // Where the player stood when the observation ended, run by run: the one number that says how thin the margin of a NO-GO of the
      // absolute reading is (the defaults end 0.15 s above the maximum on one engine).
      ...(id === 'stall.restore'
        ? configurations.map((configurationId) => [
            'PB-RDY-003 latency when the observation ended, each run against the maximum',
            configurationId,
            ...reports.map((report) => finalLatencyCell(report, configurationId)),
          ])
        : []),
    ]);
    return table(['Line', 'Configuration', ...reports.map(engineText)], rows);
  });
  const soak = perEnvironment(entries, (_id, mine) => {
    const reports = soaksOf(mine).map(({ report }) => report);
    if (reports.length === 0) return null;
    const rows = reports.map((report) => [
      engineText(report),
      report.configuration.id,
      `${report.options.minutes} min`,
      ...SOAK_LINES.map(([id]) => valueWithMargin(line(report.evaluations, id))),
    ]);
    return table(['Engine', 'Configuration', 'Length', ...SOAK_LINES.map(([, label]) => label)], rows);
  });
  return [readiness, soak].filter((part) => part !== '').join('\n\n');
}

export type EvidenceBlock =
  'EVIDENCE_MANIFEST' | 'READINESS_VERDICTS' | 'READINESS_RESTORE' | 'READINESS_SOAKS' | 'READINESS_MARGINS';

/** Every generated block, by the name of its markers: `tools/results-docs.ts` puts each between its `<!-- BEGIN:NAME -->` and `<!-- END:NAME -->`. */
export function renderEvidenceBlocks(
  entries: readonly EvidenceEntry[],
  repository: string,
): Record<EvidenceBlock, string> {
  return {
    EVIDENCE_MANIFEST: renderManifest(entries, repository),
    READINESS_VERDICTS: renderVerdicts(entries),
    READINESS_RESTORE: renderRestore(entries),
    READINESS_SOAKS: renderSoaks(entries),
    READINESS_MARGINS: renderMargins(entries),
  };
}
