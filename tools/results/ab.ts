// RESULTS_AB: the A/B comparisons of the two player configurations as the harness reported them (docs/results/ab/*.report.json).
// The verdict, the validity, the sessions and every number come from the reports; the plans in ab/prereg say what each condition was.
// A report of an exploratory run has no verdict and the block prints none: a report whose kind and verdict disagree is refused, so
// that an exploratory estimate cannot be quoted as a finding by accident. The plumbing-only pipeline check of Part 1 is not evidence
// and is not tabulated.
import { formatNumber } from '../policy-tables.ts';
import { ResultsError, data, emptyState } from './files.ts';
import type { FileSet, Node, Rendered } from './files.ts';
import { code, fixed, link, listOf, mdTable, percent, plural } from './format.ts';

export const AB_DIR = 'docs/results/ab';
export const AB_PLAN_DIR = 'ab/prereg';
/** The reports, relative to AB_DIR: the runs, and the pipeline check of Part 1 in its own folder. */
export const AB_REPORT = /^(?:pipeline-check\/)?[^/]+\.report\.json$/;

type Kind = 'experiment' | 'aa' | 'exploratory' | 'pipeline-check';
const KINDS: readonly Kind[] = ['experiment', 'aa', 'exploratory', 'pipeline-check'];

interface Pair<T> {
  a: T;
  b: T;
}

type ArmFigures =
  | { form: 'counts'; events: number; total: number }
  | { form: 'summary'; n: number; median: number; p90: number; min: number; max: number };

interface Metric {
  label: string;
  unit: string;
  role: string;
  threshold: number | null;
  a: ArmFigures;
  b: ArmFigures;
  estimate: number;
  low: number;
  high: number;
}

interface FailedSession {
  index: number;
  arm: string;
  kind: string;
  message: string;
}

interface Condition {
  id: string;
  rules: string;
  attempted: Pair<number>;
  analysed: Pair<number>;
  failed: Pair<number>;
  guardTripped: boolean;
  guardWhy: string | null;
  failedSessions: FailedSession[];
  startRungs: { a: Array<[string, number]>; b: Array<[string, number]>; disjoint: boolean };
  metrics: Metric[];
  /** The report's headline, null for a run that decides nothing. */
  headline: string | null;
  /** What a run that decides nothing says of itself. */
  note: string | null;
}

interface Calibration {
  condition: string;
  splits: number;
  falsePositives: number;
  rate: number;
  lower: number;
  upper: number;
  pass: boolean;
}

interface Gate {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
}

interface Report {
  path: string;
  id: string;
  kind: Kind;
  valid: boolean;
  gates: Gate[];
  envId: string;
  browser: string;
  machine: string;
  startedAt: string;
  sessionsPerArm: number;
  conditions: Condition[];
  calibrations: Calibration[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a report

function readArm(counts: Node | undefined, summary: Node | undefined, where: Node): ArmFigures {
  if (counts !== undefined) {
    return { form: 'counts', events: counts.at('events').int(), total: counts.at('total').int() };
  }
  if (summary !== undefined) {
    return {
      form: 'summary',
      n: summary.at('n').int(),
      median: summary.at('median').num(),
      p90: summary.at('p90').num(),
      min: summary.at('min').num(),
      max: summary.at('max').num(),
    };
  }
  return where.fail('the metric has neither counts nor a summary for this arm');
}

function readMetric(node: Node): Metric {
  const effect = node.at('effect');
  const level = effect.at('level').num();
  if (level !== 0.95) {
    effect.at('level').fail(`expected the 95 % interval that the tables are headed with but found ${level}`);
  }
  return {
    label: node.at('label').str(),
    unit: node.at('unit').str(),
    role: node.at('role').str(),
    threshold: node.opt('threshold')?.num() ?? null,
    a: readArm(node.opt('countsA'), node.opt('summaryA'), node),
    b: readArm(node.opt('countsB'), node.opt('summaryB'), node),
    estimate: effect.at('estimate').num(),
    low: effect.at('low').num(),
    high: effect.at('high').num(),
  };
}

/** What a rule of a plan does, in a few words; a kind this renderer does not know is shown as it is written. */
function ruleText(rule: Node): { throttle: boolean; text: string } {
  const type = rule.at('type').str();
  if (type === 'latency') {
    const jitter = rule.opt('jitterMs');
    const extra = jitter === undefined ? '' : ` (jitter ${formatNumber(jitter.num())} ms)`;
    return { throttle: false, text: `${formatNumber(rule.at('ms').num())} ms of latency${extra}` };
  }
  if (type === 'throttle') {
    const after = rule.opt('afterMs');
    const from = after === undefined ? '' : ` from ${fixed(after.num() / 1000, 1)} s`;
    return { throttle: true, text: `${formatNumber(rule.at('kbps').num())} kbps${from}` };
  }
  return { throttle: false, text: code(JSON.stringify(rule.value)) };
}

function conditionRules(files: FileSet, planPath: string, id: string): string {
  const plan = files.json(planPath);
  const found = plan
    .at('conditions')
    .list()
    .find((condition) => condition.at('id').str() === id);
  if (found === undefined)
    return plan.at('conditions').fail(`the plan has no condition "${id}", which its report ran`);
  const texts = found.at('rules').list().map(ruleText);
  return texts.every((t) => t.throttle)
    ? `link of ${texts.map((t) => t.text).join(', then ')}`
    : texts.map((t) => t.text).join('; ');
}

function readCondition(files: FileSet, planPath: string, kind: Kind, node: Node): Condition {
  const analysis = node.at('analysis');
  const failures = analysis.at('failures');
  const pair = (n: Node): Pair<number> => ({ a: n.at('A').int(), b: n.at('B').int() });
  const attempted = pair(analysis.at('attempted'));
  const analysed = pair(analysis.at('analysed'));
  const failed = { a: failures.at('failedA').int(), b: failures.at('failedB').int() };
  if (analysed.a !== attempted.a - failed.a || analysed.b !== attempted.b - failed.b) {
    analysis
      .at('analysed')
      .fail(
        `the sessions do not add up: ${attempted.a} and ${attempted.b} attempted, ${failed.a} and ${failed.b} failed, ${analysed.a} and ${analysed.b} analysed`,
      );
  }
  const decision = analysis.opt('decision');
  if (kind === 'exploratory' && decision !== undefined) {
    analysis
      .at('decision')
      .fail('an exploratory run has no verdict, and this report prints one: the README must not quote it');
  }
  if ((kind === 'experiment' || kind === 'aa') && decision === undefined) {
    analysis.fail('a pre-registered run has a verdict, and this report has none');
  }
  const rungs = analysis.at('startRungs');
  const rungList = (arm: Node): Array<[string, number]> =>
    arm.entries().map(([rung, count]) => [rung, count.int()]);
  const id = node.at('id').str();
  return {
    id,
    rules: conditionRules(files, planPath, id),
    attempted,
    analysed,
    failed,
    guardTripped: failures.at('guardTripped').bool(),
    guardWhy: failures.opt('guardWhy')?.str() ?? null,
    failedSessions: failures
      .at('sessions')
      .list()
      .map((session) => ({
        index: session.at('index').int(),
        arm: session.at('arm').str(),
        kind: session.at('kind').str(),
        message: session.at('message').str(),
      })),
    startRungs: {
      a: rungList(rungs.at('A')),
      b: rungList(rungs.at('B')),
      disjoint: rungs.at('disjoint').bool(),
    },
    metrics: analysis.at('metrics').list().map(readMetric),
    headline: decision?.at('headline').str() ?? null,
    note: analysis.opt('decisionNote')?.str() ?? null,
  };
}

function readCalibration(node: Node): Calibration {
  const result = node.at('result');
  const interval = result.at('interval');
  return {
    condition: node.at('condition').str(),
    splits: result.at('splits').int(),
    falsePositives: result.at('falsePositives').int(),
    rate: result.at('rate').num(),
    lower: interval.at('lower').num(),
    upper: interval.at('upper').num(),
    pass: result.at('pass').bool(),
  };
}

function readReport(files: FileSet, path: string): Report {
  const root = files.json(path);
  if (root.at('schemaVersion').int() !== 1) root.at('schemaVersion').fail('expected schema version 1');
  if (root.at('kind').str() !== 'ab-report') root.at('kind').fail('expected an "ab-report"');
  const experiment = root.at('experiment');
  const kind = experiment.at('kind').str() as Kind;
  if (!KINDS.includes(kind)) experiment.at('kind').fail(`unknown kind "${kind}" (${KINDS.join(', ')})`);
  const validity = root.at('validity');
  if (validity.at('evidence').bool() !== (kind !== 'pipeline-check')) {
    validity
      .at('evidence')
      .fail(
        kind === 'pipeline-check'
          ? 'a pipeline check is plumbing only and cannot be evidence'
          : 'a run of this kind is evidence and this report says it is not',
      );
  }
  const gates = validity
    .at('gates')
    .list()
    .map((gate) => ({
      id: gate.at('id').str(),
      title: gate.at('title').str(),
      passed: gate.at('passed').bool(),
      detail: gate.at('detail').str(),
    }));
  const valid = validity.at('valid').bool();
  if (valid !== gates.every((gate) => gate.passed)) {
    validity.at('valid').fail('the report says valid and its gates say otherwise (or the other way round)');
  }
  const environment = root.at('environment');
  const host = environment.at('host');
  const browser = environment.at('browser');
  const planPath = root.at('preregistration').at('path').str();
  return {
    path,
    id: experiment.at('id').str(),
    kind,
    valid,
    gates,
    envId: environment.at('envId').str(),
    browser: `${browser
      .at('name')
      .str()
      .replace(/^./, (c) => c.toUpperCase())} ${browser.at('version').str()}`,
    machine: `${host.at('os').at('name').str()}, ${plural(host.at('cpus').int(), 'CPU')}, ${formatNumber(host.at('memoryGiB').num())} GiB`,
    startedAt: root.at('run').at('startedAt').str(),
    sessionsPerArm: root.at('design').at('sessionsPerArm').int(),
    conditions: root
      .at('conditions')
      .list()
      .map((condition) => readCondition(files, planPath, kind, condition)),
    calibrations: root.at('calibrations').list().map(readCalibration),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words and numbers

const signed = (value: number, digits: number): string => {
  const text = fixed(value, digits);
  return value > 0 && text !== '0' ? `+${text}` : text;
};

const isShare = (unit: string): boolean => unit === 'share' || unit === 'ratio';

function figures(metric: Metric, arm: ArmFigures): string {
  return arm.form === 'counts'
    ? `${arm.events} of ${arm.total} sessions`
    : `${fixed(arm.median, 1)} ${metric.unit} median (p90 ${fixed(arm.p90, 1)}), ${plural(arm.n, 'session')}`;
}

function effectText(metric: Metric): string {
  const scale = isShare(metric.unit) ? 100 : 1;
  const unit = scale === 100 ? 'points' : metric.unit;
  const [estimate, low, high] = [metric.estimate, metric.low, metric.high].map((v) => signed(v * scale, 1));
  return `${estimate} ${unit} (${low} to ${high})`;
}

function marginText(metric: Metric): string {
  if (metric.threshold === null) return '';
  return isShare(metric.unit)
    ? ` (margin ±${fixed(metric.threshold * 100, 0)} points)`
    : ` (margin ±${fixed(metric.threshold, 0)} ${metric.unit})`;
}

/** "Equivalent within the margin: no meaningful difference (keep A)" as "Equivalent within the margin (keep A)". */
function shortVerdict(headline: string): string {
  const parts = /^([^:]+):.*\(([^)]*)\)\s*$/.exec(headline);
  return parts === null ? headline : `${parts[1]} (${parts[2]})`;
}

/** "Share of sessions with a rebuffer" as "sessions with a rebuffer". */
const sessionNoun = (label: string): string => label.replace(/^Share of /i, '');

const reportLink = (report: Report): string => link(code(report.id), report.path.replace(/\.json$/, '.md'));

const KIND_WORDS: Record<Kind, [singular: string, plural: string]> = {
  experiment: ['pre-registered experiment', 'pre-registered experiments'],
  aa: ['A/A pilot of the harness itself', 'A/A pilots of the harness itself'],
  exploratory: ['exploratory run', 'exploratory runs'],
  'pipeline-check': ['pipeline check', 'pipeline checks'],
};

function validCell(report: Report): string {
  const passed = report.gates.filter((gate) => gate.passed).length;
  return report.valid
    ? `Yes, ${passed} of ${report.gates.length} gates`
    : `**No**: ${listOf(report.gates.filter((gate) => !gate.passed).map((gate) => gate.title))}`;
}

function verdictCell(report: Report, condition: Condition): string {
  if (condition.headline === null) return 'None: exploratory, estimates only';
  return report.valid
    ? `**${shortVerdict(condition.headline)}**`
    : `Not acted on: the run is not valid (${shortVerdict(condition.headline)})`;
}

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

function environmentSentence(reports: readonly Report[]): string {
  const envs = distinct(reports.map((report) => report.envId));
  const browsers = distinct(reports.map((report) => report.browser));
  const where = (id: string): string => {
    const first = reports.find((report) => report.envId === id);
    const kind = id.startsWith('local-')
      ? 'a local workstation'
      : id.startsWith('gha-')
        ? 'a GitHub-hosted runner'
        : id.startsWith('docker-')
          ? 'a container'
          : 'an environment';
    return `${code(id)}, ${kind} (${first?.machine ?? ''})`;
  };
  const single = envs.length === 1 && browsers.length === 1;
  const replicated = envs.some((id) => id.startsWith('gha-'));
  return (
    `Every report was measured in ${listOf(browsers)} on ${listOf(envs.map(where))}: ` +
    `${single ? 'one engine on one machine' : 'several engines or machines'}` +
    `${replicated ? '' : ', not replicated on a GitHub runner'}.`
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The tables

function verdictTable(reports: readonly Report[]): string {
  const rows: string[][] = [];
  for (const report of reports) {
    if (report.kind !== 'experiment' && report.kind !== 'exploratory') continue;
    const exploratory = report.kind === 'exploratory';
    for (const condition of report.conditions) {
      for (const metric of condition.metrics.filter((m) => m.role === 'primary')) {
        rows.push([
          exploratory ? `**Exploratory** ${reportLink(report)}` : reportLink(report),
          `${code(condition.id)}: ${condition.rules}`,
          `${metric.label}${exploratory ? '' : marginText(metric)}`,
          figures(metric, metric.a),
          figures(metric, metric.b),
          effectText(metric),
          verdictCell(report, condition),
          validCell(report),
        ]);
      }
    }
  }
  return mdTable(
    ['Run', 'Condition', 'Primary metric', 'A', 'B', 'B minus A (95 % interval)', 'Verdict', 'Valid'],
    rows,
  );
}

function sessionsTable(reports: readonly Report[]): string {
  const rows = reports.flatMap((report) =>
    report.conditions.map((condition) => [
      reportLink(report),
      code(condition.id),
      String(report.sessionsPerArm),
      `${condition.attempted.a} / ${condition.attempted.b}`,
      `${condition.failed.a} / ${condition.failed.b}`,
      `${condition.analysed.a} / ${condition.analysed.b}`,
      condition.guardTripped ? `**Tripped**: ${condition.guardWhy ?? 'no reason given'}` : 'Not tripped',
    ]),
  );
  return mdTable(
    [
      'Run',
      'Condition',
      'Planned per arm',
      'Attempted (A / B)',
      'Failed (A / B)',
      'Analysed (A / B)',
      'Failure guard',
    ],
    rows,
  );
}

/** The first line of a failure's message, without the address of the page. */
const reason = (message: string): string =>
  (message.split('\n')[0] ?? message).replace(/\s*\(https?:\/\/[^)]*\)/, '').trim();

function failedSessionNotes(reports: readonly Report[]): string[] {
  const notes: string[] = [];
  for (const report of reports) {
    const sessions = report.conditions.flatMap((condition) => condition.failedSessions);
    if (sessions.length === 0) continue;
    const list = sessions.map(
      (s) => `session ${s.index + 1} of arm ${s.arm} (${code(s.kind)}: ${reason(s.message)})`,
    );
    const said = report.gates.find((gate) => gate.id === 'failures')?.detail;
    notes.push(
      `- **${report.id}**: ${said ?? `${plural(sessions.length, 'measured session')} failed.`} Left out of the comparison, and listed in the report: ${listOf(list)}.`,
    );
  }
  return notes;
}

const rungText = (rungs: Array<[string, number]>): string =>
  listOf(rungs.map(([rung, count]) => `${rung}p in ${plural(count, 'session')}`));

function rungNotes(reports: readonly Report[]): string[] {
  const notes: string[] = [];
  for (const report of reports) {
    if (report.kind !== 'experiment' && report.kind !== 'exploratory') continue;
    for (const condition of report.conditions) {
      const { a, b, disjoint } = condition.startRungs;
      notes.push(
        `- **${report.id}** (${code(condition.id)}): A started on ${rungText(a)}, B on ${rungText(b)}` +
          `${disjoint ? ': the arms never started on the same rung, so a startup difference includes the first rung' : ''}.`,
      );
    }
  }
  return notes;
}

function harmChecks(reports: readonly Report[]): string[] {
  const notes: string[] = [];
  for (const report of reports) {
    if (report.kind !== 'experiment') continue;
    for (const condition of report.conditions) {
      for (const metric of condition.metrics) {
        if (metric.role !== 'primary' || metric.a.form !== 'counts' || metric.a.events !== 0) continue;
        notes.push(
          `- **${report.id}** can only show harm: A has ${metric.a.events} of ${metric.a.total} ${sessionNoun(metric.label)}, ` +
            `and a share cannot fall below 0, so B could be shown worse than A and never better.`,
        );
      }
    }
  }
  return notes;
}

function couldItFail(metric: Metric): string {
  if (metric.a.form === 'counts' && metric.b.form === 'counts') {
    const events = metric.a.events + metric.b.events;
    const total = metric.a.total + metric.b.total;
    return events === 0 || events === total
      ? `No: ${events} of ${total} ${sessionNoun(metric.label)}, so no split can be significant`
      : `Yes: ${events} of ${total} ${sessionNoun(metric.label)}`;
  }
  if (metric.a.form === 'summary' && metric.b.form === 'summary') {
    const low = Math.min(metric.a.min, metric.b.min);
    const high = Math.max(metric.a.max, metric.b.max);
    return `Yes: the sessions vary (${fixed(low, 0)} to ${fixed(high, 0)} ${metric.unit})`;
  }
  return 'Unknown';
}

function aaTable(reports: readonly Report[]): string {
  const rows: string[][] = [];
  for (const report of reports) {
    if (report.kind !== 'aa') continue;
    for (const condition of report.conditions) {
      const calibration = report.calibrations.find((c) => c.condition === condition.id);
      if (calibration === undefined) {
        throw new ResultsError(
          `${report.path}: the A/A pilot has no calibration for the condition "${condition.id}": the check it exists for is missing`,
        );
      }
      for (const metric of condition.metrics.filter((m) => m.role === 'primary')) {
        rows.push([
          reportLink(report),
          code(condition.id),
          metric.label,
          figures(metric, metric.a),
          figures(metric, metric.b),
          effectText(metric),
          `${calibration.falsePositives} of ${formatNumber(calibration.splits)} (${percent(calibration.rate, 2)}); the rate's 95 % interval is ${(calibration.lower * 100).toFixed(2)} to ${percent(calibration.upper, 2)}`,
          `${calibration.pass ? 'Pass' : '**FAIL**'}; the real A/A: ${shortVerdict(condition.headline ?? 'no verdict')}`,
          couldItFail(metric),
        ]);
      }
    }
  }
  return mdTable(
    [
      'Run',
      'Condition',
      'Primary metric',
      'Arm 1',
      'Arm 2',
      'Difference (95 % interval)',
      'Splits declared significant',
      'Calibration',
      'Could the check fail?',
    ],
    rows,
  );
}

// ---------------------------------------------------------------------------------------------------------------------

export function renderAb(files: FileSet): Rendered {
  const all = files
    .list(AB_DIR, AB_REPORT)
    .map((path) => readReport(files, path))
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt) || x.path.localeCompare(y.path));
  const reports = all.filter((report) => report.kind !== 'pipeline-check');
  if (reports.length === 0) return emptyState('A/B reports', AB_DIR);
  const checks = all.filter((report) => report.kind === 'pipeline-check');

  const counted = (['experiment', 'aa', 'exploratory'] as const)
    .map((kind) => ({ kind, n: reports.filter((report) => report.kind === kind).length }))
    .filter(({ n }) => n > 0)
    .map(({ kind, n }) => `${n} ${KIND_WORDS[kind][n === 1 ? 0 : 1]}`);
  const pipeline = checks[0];
  const pipelineSentence =
    pipeline === undefined
      ? ''
      : ` The pipeline check of Part 1 (${plural(pipeline.sessionsPerArm, 'measured session')} per arm, plumbing only: its report says it is not evidence and prints no verdict) is not in these tables.`;
  const exploratoryNote = reports
    .filter((report) => report.kind === 'exploratory')
    .flatMap((report) => report.conditions.map((condition) => condition.note))
    .find((note): note is string => note !== null);
  const exploratorySentence =
    exploratoryNote === undefined
      ? ''
      : ` The exploratory run says of itself: “${exploratoryNote.split('. ')[0]?.replace(/\.$/, '')}.”`;

  const splitCounts = distinct(all.flatMap((report) => report.calibrations.map((c) => String(c.splits))));
  const splitsText =
    splitCounts.length === 1 ? `${formatNumber(Number(splitCounts[0]))} random splits` : 'random splits';

  const parts: string[] = [
    `Counted from the ${reports.length} reports under ${link(code(AB_DIR), AB_DIR)}: ${listOf(counted)}. ${environmentSentence(reports)}${pipelineSentence}`,
    `**Verdicts**: the decision rule of each plan applied to its primary metric. A run that decides nothing prints none.${exploratorySentence}`,
    verdictTable(reports),
  ];
  const notes = [...harmChecks(reports), ...rungNotes(reports)];
  if (notes.length > 0) parts.push(notes.join('\n'));
  parts.push(
    '**Sessions**: every attempted session is in its report, and a failed one is reported and left out of the comparison.',
    sessionsTable(reports),
  );
  const failed = failedSessionNotes(reports);
  if (failed.length > 0) parts.push(failed.join('\n'));
  parts.push(
    `**The A/A pilots**: both arms run configuration A, so any difference between them is one that is not there. The harness is also run on ${splitsText} of the pilot's own sessions, and the share it declares significant should not be above the significance level.`,
    aaTable(reports),
  );
  return data(parts.join('\n\n'));
}
