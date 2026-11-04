import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { CheckResult } from './checks.ts';
import { injectionPart, isBusy, loadPerCpu, soakVerdictToday } from './report.ts';
import type { ConfigurationResult, LoadReading, MachineLoad, ReadinessReport, SoakReport } from './report.ts';
import type { Engine } from './soak-evaluators.ts';
import { formatLimit, formatValue } from './verdict.ts';
import type { CheckId, Evaluation, Verdict } from './verdict.ts';

// What a person reads: the go/no-go sheet of TEST_STRATEGY.md section 8, with a measured value, a limit and a verdict on every line, and
// the ten-item checklist of the same section, with the items the lab can decide filled in from the evidence and the rest left to the owner.
// Pure functions of the result files, so the sheet of a run and the sheet rebuilt from the committed files are the same text.

const ENGINE_ORDER: readonly Engine[] = ['chromium', 'firefox', 'webkit'];
const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);
const padStart = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text;

function valueText(evaluation: Evaluation): string {
  if (evaluation.value === null) return evaluation.verdict === 'N/A' ? 'n/a' : 'not measured';
  return `${evaluation.censored ? '>= ' : ''}${formatValue(evaluation.value, evaluation.unit)}`;
}

/** One line of the sheet: verdict, what it is, the measured value, the limit. Advisory lines say so: they do not decide. */
export function evaluationLine(evaluation: Evaluation, indent = '    '): string {
  const label = evaluation.scope === 'advisory' ? `${evaluation.label} (advisory)` : evaluation.label;
  return `${indent}${pad(evaluation.verdict, 13)}${pad(label, 52)}${padStart(valueText(evaluation), 14)}   ${formatLimit(evaluation.limit, evaluation.unit, evaluation.bound)}`;
}

function checkBlock(check: CheckResult): string[] {
  const lines = [
    `  ${check.id}  ${check.title}${check.verdict === 'NO-GO' || check.verdict === 'INCONCLUSIVE' ? `    [${check.verdict}]` : ''}`,
  ];
  if (check.error)
    lines.push(`    ${pad('INCONCLUSIVE', 13)}the check could not run: ${firstLine(check.error)}`);
  for (const evaluation of check.evaluations) lines.push(evaluationLine(evaluation));
  if (check.failure) lines.push(`    ${pad('NO-GO', 13)}${check.failure}`);
  return lines;
}

const firstLine = (text: string): string => text.split('\n')[0] ?? '';

/** The findings: the sentence of every line that is not a GO, which is the part of the sheet that has to be read, and the notes of the lines. */
function findings(checks: readonly CheckResult[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    for (const evaluation of check.evaluations) {
      if (evaluation.verdict === 'GO' || evaluation.verdict === 'N/A') continue;
      lines.push(
        `  ${check.id} ${evaluation.verdict}${evaluation.scope === 'advisory' ? ' (advisory)' : ''}: ${evaluation.sentence}`,
      );
    }
    for (const evaluation of check.evaluations)
      if (evaluation.note) lines.push(`  ${check.id} note, ${evaluation.label}: ${evaluation.note}`);
    for (const note of check.notes) lines.push(`  ${check.id} note: ${note}`);
  }
  return lines;
}

/** The sheet of one configuration: every check with its lines, the verdict, and why wherever it is not a GO. */
export function renderConfiguration(configuration: ConfigurationResult): string {
  const title = `Configuration ${configuration.id}: ${configuration.label}`;
  const out = [`${pad(title, 100)}${configuration.verdict}`, ...configuration.checks.flatMap(checkBlock)];
  const why = findings(configuration.checks);
  if (why.length > 0) out.push('', '  Why:', ...why);
  return out.join('\n');
}

/** A or a candidate, line by line: what the candidate changed, which is what a readiness run of a candidate is for. */
export function renderComparison(report: ReadinessReport): string | null {
  const [base, ...others] = report.configurations;
  if (!base || others.length === 0) return null;
  const cell = (evaluation: Evaluation | undefined): string =>
    evaluation ? `${evaluation.verdict} ${valueText(evaluation)}` : 'not run';
  const ids = base.checks.flatMap((check) =>
    check.evaluations.filter((e) => e.scope === 'criterion').map((e) => ({ check: check.id, evaluation: e })),
  );
  const lines = [
    `Comparison with ${base.id} (${report.engine})`,
    `  ${pad('Line', 64)}${pad(base.id, 26)}${others.map((other) => pad(other.id, 26)).join('')}`,
  ];
  for (const { check, evaluation } of ids) {
    const row = others.map((other) =>
      cell(other.checks.find((c) => c.id === check)?.evaluations.find((e) => e.id === evaluation.id)),
    );
    lines.push(
      `  ${pad(`${check} ${evaluation.label}`, 64)}${pad(cell(evaluation), 26)}${row.map((text) => pad(text, 26)).join('')}`,
    );
  }
  lines.push(
    `  ${pad('Verdict', 64)}${pad(base.verdict, 26)}${others.map((other) => pad(other.verdict, 26)).join('')}`,
    '',
    "  Start times differ by the path as well as by the configuration: A's page is given the manifest and loads by itself, a candidate's",
    '  page is opened idle and told to load (ADR-153). The control for the path is --config-json \'{"streaming":{"liveSync":{"enabled":false}}}\':',
    "  A's own default value, through the candidate's path.",
  );
  return lines.join('\n');
}

const describeBrowser = (report: { browser: { name: string; version: string }; envId: string }): string =>
  `${report.browser.name} ${report.browser.version} on ${report.envId}`;

const describeCommit = (commit: { hash: string | null; dirty: boolean | null }): string =>
  `${commit.hash ?? 'unknown commit'}${commit.dirty === null ? '' : commit.dirty ? ', modified' : ', clean'}`;

/**
 * `machine load average (1, 5, 15 min) before 4.89 3.43 2.29, after 5.12 3.9 2.6, on 12 CPUs`, or nothing for a file that has none; and a
 * line when the machine was busy at the start (a 1-minute load above the number of CPUs), because what is measured then is partly the
 * machine's. Only the start is judged: at the end the load includes the run's own browser, service and harness, which is no reason to doubt
 * the run. The harness records the load and says so; it does not wait for the machine to be quiet and no verdict depends on it (ADR-159e).
 */
function describeLoad(load: MachineLoad | undefined): string[] {
  if (!load) return [];
  const averages = (reading: LoadReading): string =>
    [reading.load1, reading.load5, reading.load15].map((value) => value.toFixed(2)).join(' ');
  return [
    `machine load average (1, 5, 15 min): ${averages(load.before)} before, ${averages(load.after)} after, on ${load.after.cpus} CPUs`,
    ...(isBusy(load.before)
      ? [
          `the machine was busy when the run started: a 1-minute load of ${load.before.load1.toFixed(1)} on ${load.before.cpus} CPUs (${loadPerCpu(load.before).toFixed(1)} per CPU), so what was measured in its first minutes was measured under load`,
        ]
      : []),
  ];
}

/** ` [busy at the start: load 66.4 on 3 CPUs]` for a result whose run started on a busy machine, for the lines of the checklist. */
const busyAtStart = (report: { load?: MachineLoad | undefined }): string =>
  report.load && isBusy(report.load.before)
    ? ` [busy at the start: load ${report.load.before.load1.toFixed(1)} on ${report.load.before.cpus} CPUs]`
    : '';

/** What a soak did to its origin, as the sheet and the checklist say it: `nothing`, or each fault with its length and its minute. */
const injectedFaults = (report: SoakReport): string =>
  report.faults.length === 0
    ? 'nothing'
    : report.faults
        .map(
          (fault) =>
            `${fault.kind} for ${Math.round((fault.endMs - fault.startMs) / 1000)} s at minute ${((fault.startMs - report.firstFrameMs) / 60_000).toFixed(1)}`,
        )
        .join('; ');

const injectedLine = (report: SoakReport): string => `injected: ${injectedFaults(report)}`;

/**
 * ` (not the policy's plan: stale-manifest for 10 s at minute 2.0)` for a soak that injected something else than the plan its length has, so
 * that the line of a soak with a stale manifest and no outage cannot be read as the CI soak of the policy.
 */
const planNote = (report: SoakReport): string =>
  injectionPart(report.options) === '' ? '' : ` (not the policy's plan: ${injectedFaults(report)})`;

/** The whole sheet of a readiness run: where and when it was measured, every configuration, and the comparison when a candidate was evaluated. */
export function renderReadinessReport(report: ReadinessReport): string {
  const head = [
    `Live-event readiness: ${describeBrowser(report)}`,
    `commit ${describeCommit(report.commit)}, stream ${report.stream.id} over ${report.stream.protocol}, measured ${report.generatedAt}, ${Math.round(report.durationMs / 1000)} s`,
    ...describeLoad(report.load),
    `limits: LIVE_LIMITS of src/shared/criteria.ts (start ${formatValue(report.limits.startMaxMs ?? LIVE_LIMITS.startMaxMs, 'ms')}, latency p95 ${formatValue(report.limits.latencyP95MaxMs ?? LIVE_LIMITS.latencyP95MaxMs, 'ms')}, maximum ${formatValue(report.limits.latencyMaxMs ?? LIVE_LIMITS.latencyMaxMs, 'ms')})`,
  ];
  const sections = report.configurations.map(renderConfiguration);
  const comparison = renderComparison(report);
  return [...head, '', sections.join('\n\n'), ...(comparison ? ['', comparison] : [])].join('\n');
}

/** The summary of a soak: the verdict lines, then the observations that decide nothing, then what the harness did to its own machine. */
export function renderSoakReport(report: SoakReport): string {
  const criteria = report.evaluations.filter((evaluation) => evaluation.scope === 'criterion');
  const advisory = report.evaluations.filter((evaluation) => evaluation.scope === 'advisory');
  const today = soakVerdictToday(report);
  const lengthText =
    report.length === 'release'
      ? 'release soak'
      : report.length === 'ci'
        ? 'CI soak'
        : 'short run: not a verdict';
  const out = [
    `Soak (PB-RDY-005): ${describeBrowser(report)}, ${report.configuration.id}`,
    `commit ${describeCommit(report.commit)}, stream ${report.stream.id} over ${report.stream.protocol}, ${Number(report.options.minutes.toFixed(2))} min (${lengthText}), warm-up ${report.options.warmupSec} s, measured ${report.generatedAt}`,
    ...describeLoad(report.load),
    injectedLine(report),
    '',
    `${pad('Soak verdict', 64)}${report.verdict}`,
    ...(today.verdict === report.verdict
      ? []
      : [
          `${pad("Judged by today's criteria (ADR-159c)", 64)}${today.verdict}`,
          `  This file was measured when the latency of the soak after the faults was evidence and decided nothing; it is a criterion now, and ${today.changedBy.map((line) => `${line.label} ${valueText(line)} against ${formatLimit(line.limit, line.unit, line.bound)}`).join(', ')} decide${today.changedBy.length === 1 ? 's' : ''} it.`,
        ]),
    ...criteria.map((evaluation) => evaluationLine(evaluation, '  ')),
    ...(advisory.length > 0
      ? [
          '',
          'Evidence that decides nothing here:',
          ...advisory.map((evaluation) => evaluationLine(evaluation, '  ')),
        ]
      : []),
  ];
  const why = report.evaluations.filter(
    (evaluation) => evaluation.verdict !== 'GO' && evaluation.verdict !== 'N/A',
  );
  if (why.length > 0)
    out.push(
      '',
      '  Why:',
      ...why.map(
        (evaluation) =>
          `  ${evaluation.verdict}${evaluation.scope === 'advisory' ? ' (advisory)' : ''}: ${evaluation.sentence}`,
      ),
    );
  const noted = report.evaluations.filter((evaluation) => evaluation.note);
  if (noted.length > 0)
    out.push('', '  Notes:', ...noted.map((evaluation) => `  ${evaluation.label}: ${evaluation.note}`));
  const { harness } = report;
  if (harness.firstHeapMb !== null && harness.lastHeapMb !== null) {
    out.push(
      '',
      `The harness itself: heap ${harness.firstHeapMb.toFixed(1)} MB at the first reading, ${harness.lastHeapMb.toFixed(1)} MB at the last` +
        (harness.firstServiceRssMb !== null && harness.lastServiceRssMb !== null
          ? `; the service ${harness.firstServiceRssMb.toFixed(0)} MB, then ${harness.lastServiceRssMb.toFixed(0)} MB resident`
          : ''),
    );
  }
  if (report.consoleProblems.length > 0)
    out.push(
      `The browser console said ${report.consoleProblems.length} problem(s); the first: ${report.consoleProblems[0]}`,
    );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The checklist of TEST_STRATEGY.md section 8

/** `done`: the evidence says GO. `blocked`: the evidence says NO-GO. `open`: not decided (missing evidence, not run, or not the lab's to decide). */
export type ItemStatus = 'done' | 'blocked' | 'open';

export interface ChecklistItem {
  number: number;
  text: string;
  status: ItemStatus;
  /** Why the item has that status: the evidence, line by line. */
  evidence: string[];
  /** The lab cannot decide it: the owner records it. */
  owner: boolean;
}

export interface ChecklistInput {
  readiness: readonly ReadinessReport[];
  soaks: readonly SoakReport[];
}

/** The configuration that ships: A, the library defaults. The checklist judges it; a candidate is evidence for a decision, not the build. */
const shipped = (report: ReadinessReport): ConfigurationResult | undefined =>
  report.configurations.find((configuration) => configuration.id === 'A');

const statusOf = (verdicts: readonly Verdict[]): ItemStatus =>
  verdicts.includes('NO-GO')
    ? 'blocked'
    : verdicts.length === 0 || verdicts.some((verdict) => verdict !== 'GO' && verdict !== 'N/A')
      ? 'open'
      : 'done';

const label = (report: { engine: Engine; envId: string; stream: { protocol: string } }): string =>
  `${report.engine} (${report.envId}${report.stream.protocol === 'dash' ? '' : `, ${report.stream.protocol}`})`;

function engineCoverage(have: readonly Engine[]): string[] {
  const missing = ENGINE_ORDER.filter((engine) => !have.includes(engine));
  return missing.length === 0 ? [] : [`not run for ${missing.join(', ')}`];
}

export function checklist(input: ChecklistInput): ChecklistItem[] {
  const owner = (number: number, text: string, hint: string): ChecklistItem => ({
    number,
    text,
    status: 'open',
    evidence: [hint],
    owner: true,
  });
  const items: ChecklistItem[] = [];

  // 1. The build is identified. A line says what each result was measured on, and with which configuration: a candidate's soak is not A's,
  // and the same line from two results (the CI soak and the release soak of one engine) is said once.
  const builds = [
    ...input.readiness.map((report) => ({
      report,
      shaka: report.configurations.flatMap((c) => c.checks).find((c) => c.player)?.player?.shakaVersion,
      configuration: 'A',
    })),
    ...input.soaks.map((report) => ({
      report,
      shaka: report.player?.shakaVersion,
      configuration: report.configuration.id,
    })),
  ];
  const commits = [...new Set(builds.map(({ report }) => report.commit.hash ?? 'unknown'))];
  const buildLines = [
    ...new Set(
      builds.map(
        ({ report, shaka, configuration }) =>
          `${label(report)}: commit ${describeCommit(report.commit)}, Shaka Player ${shaka ?? 'unknown'}, configuration ${configuration}, ${report.stream.id} over ${report.stream.protocol}`,
      ),
    ),
  ];
  items.push({
    number: 1,
    text: 'The build is identified: commit, Shaka Player version, player configuration (A or B), and the stream flavour each engine plays.',
    status: builds.length > 0 && commits.length === 1 && commits[0] !== 'unknown' ? 'done' : 'open',
    evidence:
      builds.length === 0
        ? ['no result files']
        : [
            ...buildLines,
            ...(commits.length > 1
              ? [
                  `the results are from ${commits.length} different commits (${commits.join(', ')}): they are not one build`,
                ]
              : []),
          ],
    owner: false,
  });

  items.push(
    owner(
      2,
      'The merge gate was green on that commit in every engine, and the release browser tests are green: no `@release` failure and no merge-tier quarantine.',
      'not decided by the lab: attach the CI run of this commit (npm run gate:merge, npm run test:release)',
    ),
  );

  // 3. PB-RDY-001 to PB-RDY-004 pass in every engine.
  const four: CheckId[] = ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'];
  const verdictsOf = (report: ReadinessReport, id: CheckId): Verdict => {
    const check = shipped(report)?.checks.find((c) => c.id === id);
    return check ? check.verdict : 'INCONCLUSIVE';
  };
  const lines3 = input.readiness.map(
    (report) =>
      `${label(report)}: ${four.map((id) => `${id.slice(-3)} ${shipped(report)?.checks.some((c) => c.id === id) ? verdictsOf(report, id) : 'not run'}`).join(', ')}${busyAtStart(report)}`,
  );
  const verdicts3 = input.readiness.flatMap((report) => four.map((id) => verdictsOf(report, id)));
  const covered = ENGINE_ORDER.every((engine) => input.readiness.some((report) => report.engine === engine));
  items.push({
    number: 3,
    text: 'PB-RDY-001 to PB-RDY-004 pass in every engine against the table above, with the artifacts attached.',
    status: statusOf(covered ? verdicts3 : [...verdicts3, 'INCONCLUSIVE']),
    evidence: [...lines3, ...engineCoverage(input.readiness.map((report) => report.engine))],
    owner: false,
  });

  // 4. The release soak passed in every engine. A stored soak is judged by today's criteria (`soakVerdictToday`): the file keeps what it
  // measured, and when it says GO because the latency of the soak was only evidence then, the line says what it is judged as now.
  const todayOf = (report: SoakReport): Verdict => soakVerdictToday(report).verdict;
  const changedNote = (report: SoakReport): string => {
    const { verdict, changedBy } = soakVerdictToday(report);
    return verdict === report.verdict
      ? ''
      : ` (measured ${report.verdict}, when the latency of the soak was evidence and not a criterion; ${changedBy.map((line) => `${line.label} ${valueText(line)} against ${formatLimit(line.limit, line.unit, line.bound)}`).join(', ')} decide it now, ADR-159c)`;
  };
  const kindOf = (report: SoakReport, ci: string): string =>
    report.length === 'release' ? 'release soak' : report.length === 'ci' ? ci : 'short run';
  const releaseSoaks = input.soaks.filter((report) => report.configuration.id === 'A');
  const soakLines = releaseSoaks.map(
    (report) =>
      `${label(report)}: ${kindOf(report, 'CI soak only')} of ${Number(report.options.minutes.toFixed(2))} min${planNote(report)}: ${todayOf(report)}${changedNote(report)}${busyAtStart(report)}`,
  );
  // A candidate's soak is evidence for a decision about the candidate, never for the build as it ships: it is listed and does not count.
  const candidateLines = input.soaks
    .filter((report) => report.configuration.id !== 'A')
    .map(
      (report) =>
        `${label(report)}: ${kindOf(report, 'CI soak')} of ${Number(report.options.minutes.toFixed(2))} min${planNote(report)} of the candidate ${report.configuration.id}: ${todayOf(report)} (evidence for a decision about the candidate, not about the build)${changedNote(report)}${busyAtStart(report)}`,
    );
  const releaseVerdicts = ENGINE_ORDER.map((engine): Verdict => {
    const forEngine = releaseSoaks.filter((report) => report.engine === engine);
    const release = forEngine.filter((report) => report.length === 'release');
    if (release.some((report) => todayOf(report) === 'NO-GO')) return 'NO-GO';
    if (forEngine.some((report) => todayOf(report) === 'NO-GO')) return 'NO-GO';
    return release.length > 0 && release.every((report) => todayOf(report) === 'GO') ? 'GO' : 'INCONCLUSIVE';
  });
  items.push({
    number: 4,
    text: 'The release soak passed in every engine: no unrecovered stall, no critical error and none that no injected fault explains, rebuffer ratio, latency drift, the latency level after the faults and dropped frames within their limits, and heap growth within its limit in Chromium.',
    status: statusOf(releaseVerdicts),
    evidence: [
      ...soakLines,
      ...ENGINE_ORDER.filter(
        (engine) => !releaseSoaks.some((report) => report.engine === engine && report.length === 'release'),
      ).map((engine) => `no release soak (${LIVE_LIMITS.soakMinutesRelease} min) on record for ${engine}`),
      ...candidateLines,
    ],
    owner: false,
  });

  // 5. Origin-stall recovery was demonstrated, and latency restored.
  const stall = input.readiness.map((report) => ({
    report,
    check: shipped(report)?.checks.find((c) => c.id === 'PB-RDY-003'),
  }));
  items.push({
    number: 5,
    text: 'Origin-stall recovery was demonstrated on this build (PB-REC-008 and PB-RDY-003), and latency was restored within its limit.',
    status: statusOf(stall.length === 0 ? [] : stall.map(({ check }) => check?.verdict ?? 'INCONCLUSIVE')),
    evidence:
      stall.length === 0
        ? ['PB-RDY-003 was not run']
        : [
            ...stall.map(({ report, check }) => {
              const restore = check?.evaluations.find((e) => e.id === 'stall.restore');
              return `${label(report)}: PB-RDY-003 ${check?.verdict ?? 'not run'}${restore ? ` (${restore.sentence})` : ''}`;
            }),
            'PB-REC-008 is a merge-gate spec: attach its result from CI',
          ],
    owner: false,
  });

  items.push(
    owner(
      6,
      'Every configuration change since the last event has an A/B decision on record: ship, or keep A (an inconclusive result means keep A).',
      'not decided by the lab: attach the A/B report of each change',
    ),
  );
  items.push(
    owner(
      7,
      'No quarantined test in the live, recovery or readiness areas. The known-gaps list was read, and every gap that touches a device class the event targets is accepted in writing by the event owner.',
      'not decided by the lab: npm run flake:report, and TEST_STRATEGY.md section 13',
    ),
  );
  items.push(
    owner(
      8,
      'Rollback is ready: the previous known-good build and configuration A (the library defaults) can be deployed within minutes, and who decides and who executes is named.',
      'not decided by the lab',
    ),
  );
  items.push(
    owner(
      9,
      'Outside the lab: production monitoring and alerting for the event exist. The lab cannot tell what real members experience; what pages someone is latency, rebuffering and start failures.',
      'not decided by the lab',
    ),
  );

  const decided = items.filter((item) => !item.owner);
  const blocked = decided.filter((item) => item.status === 'blocked');
  const open = decided.filter((item) => item.status === 'open');
  items.push({
    number: 10,
    text: 'The decision and the evidence links are recorded: Go, or No-go with the criterion or gap that decided it.',
    status: blocked.length > 0 ? 'blocked' : 'open',
    evidence:
      blocked.length > 0
        ? [
            `NO-GO: ${blocked.map((item) => `item ${item.number}`).join(', ')} (${blocked.flatMap((item) => item.evidence.filter((line) => line.includes('NO-GO'))).join(' | ')})`,
          ]
        : open.length > 0
          ? [
              `not yet: the lab's items ${open.map((item) => item.number).join(', ')} are open, and the owner's items need the owner`,
            ]
          : [
              "the lab's items are done; the owner's items (2, 6, 7, 8, 9) remain to be recorded, then the decision",
            ],
    owner: false,
  });
  return items;
}

const MARK: Record<ItemStatus, string> = { done: '[x]', blocked: '[!]', open: '[ ]' };

export function renderChecklist(input: ChecklistInput): string {
  const items = checklist(input);
  const lines = ['Go/no-go checklist (TEST_STRATEGY.md section 8): [x] done  [!] NO-GO  [ ] open', ''];
  for (const item of items) {
    lines.push(`${MARK[item.status]} ${item.number}. ${item.text}`);
    for (const line of item.evidence) lines.push(`      ${line}`);
  }
  const blocked = items.filter((item) => item.status === 'blocked' && item.number !== 10);
  lines.push(
    '',
    blocked.length > 0
      ? `LAB VERDICT: NO-GO (items ${blocked.map((item) => item.number).join(', ')})`
      : items.filter((item) => !item.owner && item.number !== 10).every((item) => item.status === 'done')
        ? "LAB VERDICT: GO on the lab's items; the owner's items remain"
        : 'LAB VERDICT: not yet decided: evidence is missing',
  );
  return lines.join('\n');
}

/** Everything a readiness run prints: the sheet of each report, then the checklist. */
export function renderRun(reports: readonly ReadinessReport[], soaks: readonly SoakReport[] = []): string {
  return [...reports.map(renderReadinessReport), renderChecklist({ readiness: reports, soaks })].join('\n\n');
}

/** The verdict of a whole run for the exit code: that of the build as shipped (A) in every report; NO-GO anywhere wins, then INCONCLUSIVE, then GO. A candidate is evidence, it never makes the build GO. */
export function runVerdict(reports: readonly ReadinessReport[]): Verdict {
  const verdicts = reports.flatMap((report) =>
    report.configurations.filter((c) => c.id === 'A').map((c) => c.verdict),
  );
  return verdicts.includes('NO-GO')
    ? 'NO-GO'
    : verdicts.includes('INCONCLUSIVE') || verdicts.length === 0
      ? 'INCONCLUSIVE'
      : 'GO';
}
