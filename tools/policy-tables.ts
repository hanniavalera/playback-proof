// Renders the policy tables of TEST_STRATEGY.md from the code that enforces them (src/shared/criteria.ts, src/shared/profiles.ts,
// tools/catalog.ts). The document holds the output between BEGIN/END markers; `npm run docs:check` fails when it is stale and
// `npm run docs:check -- --write` rewrites it. Nothing here reads the disk: the functions are pure and unit-tested.
import {
  FLAKE_POLICY,
  GATE_BUDGETS,
  LANE_TIER,
  LIVE_READINESS,
  PERF_POLICY,
  PERF_SECONDS_PER_RUN,
  RISK_LIMITS,
  RISK_TIERING,
  TEST_SECONDS_BY_AREA,
} from '../src/shared/criteria.ts';
import type { BasisKind, Lane, Policy } from '../src/shared/criteria.ts';
import type { FaultRule } from '../src/shared/faults.ts';
import { PROFILE_DEFINITIONS, PROFILE_FACTORIES, PROFILE_NAMES } from '../src/shared/profiles.ts';
import { CATALOG_AREAS, defaultBudgetModel, estimateJobs } from './catalog.ts';
import type { BudgetModel, CatalogRow } from './catalog.ts';

const cell = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

function table(header: readonly string[], rows: readonly string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

export function formatNumber(value: number): string {
  const [whole = '', fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** A policy value with its unit, the way the tables show it: ratios as percentages, long millisecond values with seconds. */
export function formatLimit(policy: Policy): string {
  const { value, unit } = policy;
  switch (unit) {
    case 'ratio':
      return `${formatNumber(Number((value * 100).toPrecision(12)))} %`;
    case 'ms':
      return value >= 1000 && value % 100 === 0
        ? `${formatNumber(value)} ms (${formatNumber(value / 1000)} s)`
        : `${formatNumber(value)} ms`;
    case 'x':
      return `${value}x`;
    case 'fps':
      return `${formatNumber(value)} fps`;
    case 'count':
    case 'score':
      return formatNumber(value);
    case 's':
    case 'min':
    case 'days':
    case 'MB':
      return `${formatNumber(value)} ${unit}`;
  }
}

const KIND_LABEL: Record<BasisKind, string> = {
  fact: 'Fact',
  arithmetic: 'Arithmetic',
  assumption: 'Assumption',
  measured: 'Measured',
};

export function renderPolicyTable(
  policy: Readonly<Record<string, Policy>>,
  columns: { first: string; value: string } = { first: 'Criterion', value: 'Limit' },
): string {
  return table(
    [columns.first, columns.value, 'How it is measured', 'Where the number comes from'],
    Object.values(policy).map((p) => [
      p.label,
      formatLimit(p),
      p.measure,
      `${KIND_LABEL[p.basis.kind]}: ${p.basis.text}`,
    ]),
  );
}

export function renderLiveCriteria(): string {
  return renderPolicyTable(LIVE_READINESS);
}

export function renderFlakePolicy(): string {
  return renderPolicyTable(FLAKE_POLICY, { first: 'Policy number', value: 'Value' });
}

export function renderPerfPolicy(): string {
  return renderPolicyTable(PERF_POLICY, { first: 'Threshold or parameter', value: 'Value' });
}

export function renderRiskTiers(): string {
  const laneText: Record<'by-score' | 'merge' | 'release', string> = {
    'by-score': `score ${RISK_LIMITS.mergeMinScore} or more: merge; ${RISK_LIMITS.releaseMinScore} to ${RISK_LIMITS.mergeMinScore - 1}: release; below ${RISK_LIMITS.releaseMinScore}: not an automated test`,
    merge: 'always merge: it costs milliseconds, so it gates every merge whatever its score',
    release:
      'always release: it needs minutes of wall-clock on a quiet machine, so it cannot gate a pull request',
  };
  const laneWhat: Record<Lane, string> = {
    e2e: 'Playwright browser tests (`tests/e2e`)',
    perf: 'The performance harness (`perf/`): repeated runs against baselines',
    unit: 'Vitest, including the service tests that run real ffmpeg (`tests/unit`)',
    live: 'Readiness checks and the soak (`tests/live`)',
    ab: 'The A/B runner (`ab/`)',
  };
  const lanes = (Object.keys(LANE_TIER) as Lane[]).map((lane) => [
    `\`${lane}\``,
    laneWhat[lane],
    laneText[LANE_TIER[lane]],
  ]);
  return [
    renderPolicyTable(RISK_TIERING, { first: 'Threshold', value: 'Score' }),
    '',
    table(['Runs in', 'What runs there', 'Tier rule'], lanes),
  ].join('\n');
}

export function renderAreaLegend(): string {
  return table(
    ['Area', 'Title', 'Covers', 'Lives in', 'Phase'],
    Object.entries(CATALOG_AREAS).map(([code, a]) => [
      `\`${code}\``,
      a.title,
      a.covers,
      a.livesIn
        .split(' and ')
        .map((path) => `\`${path}\``)
        .join(' and '),
      a.phase,
    ]),
  );
}

export function renderGateBudgets(): string {
  return [
    renderPolicyTable(GATE_BUDGETS, { first: 'Budget or parameter', value: 'Value' }),
    '',
    '**Expected wall-clock of one browser test, by area** (design estimates, replaced by measured durations in Phase 3)',
    '',
    renderPolicyTable(TEST_SECONDS_BY_AREA, { first: 'Area', value: 'Estimate' }),
    '',
    '**Expected wall-clock of one run of a performance scenario** (design estimates, replaced by measured durations in Phase 5)',
    '',
    renderPolicyTable(PERF_SECONDS_PER_RUN, { first: 'Scenario', value: 'Estimate' }),
  ].join('\n');
}

const minutes = (seconds: number): string => `${(seconds / 60).toFixed(1)} min`;

/** The budget arithmetic for the catalog: tests, test-seconds, estimated wall-clock, budget and headroom of every job. */
export function renderMergeBudget(
  rows: readonly CatalogRow[],
  model: BudgetModel = defaultBudgetModel(),
): string {
  const { jobs } = estimateJobs(rows, model);
  const body = jobs.map((job) => {
    const headroom = job.budgetSeconds - job.wallSeconds;
    const pct = Math.round((Math.abs(headroom) / job.budgetSeconds) * 100);
    return [
      job.job,
      String(job.tests),
      `${formatNumber(Math.round(job.workSeconds))} s`,
      `${formatNumber(job.wallSeconds)} s (${minutes(job.wallSeconds)})`,
      `${formatNumber(job.budgetSeconds)} s (${minutes(job.budgetSeconds)})`,
      headroom >= 0 ? `${formatNumber(headroom)} s (${pct} %)` : `over by ${formatNumber(-headroom)} s`,
    ];
  });
  const mergeJobs = jobs.filter((j) => j.gate === 'merge');
  const busiest = Math.max(0, ...mergeJobs.map((j) => j.tests));
  return [
    table(['Job', 'Tests', 'Test-seconds', 'Estimated wall-clock', 'Budget', 'Headroom'], body),
    '',
    `Browser jobs: wall-clock = test-seconds / ${model.workers} workers + ${model.setupSec} s setup + ${model.failureAllowanceSec} s failure allowance. ` +
      `Performance jobs: serial, runs x seconds per run + ${model.setupSec} s setup. ` +
      `Ceiling: ${model.maxMergeTestsPerEngine} merge-tier browser tests per engine; the most loaded engine carries ${busiest}.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Fault profiles

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${formatNumber(ms)} ms`;
}

function describeTarget(rule: FaultRule): string {
  const match = rule.match ?? {};
  const kind = match.kind ?? (rule.type === 'status' ? 'any' : 'media');
  const qualifier = match.rep ?? (match.track && match.track !== 'any' ? match.track : undefined);
  const prefix = qualifier ? `${qualifier} ` : '';
  if (match.number !== undefined && kind === 'segment') {
    const n = match.number;
    return typeof n === 'number' ? `${prefix}segment ${n}` : `${prefix}segments ${n.from} to ${n.to}`;
  }
  const noun = {
    manifest: 'manifest requests',
    init: 'initialization segment requests',
    segment: 'segment requests',
    media: 'media requests',
    any: 'requests',
  }[kind];
  return kind === 'any' && !qualifier ? 'all requests' : `${prefix}${noun}`;
}

/** A rule in words, for the generated table. */
export function describeRule(rule: FaultRule): string {
  const target = describeTarget(rule);
  let text: string;
  switch (rule.type) {
    case 'throttle':
      text = `throttle ${formatNumber(rule.kbps)} kbps on ${target}`;
      break;
    case 'latency':
      text = `latency ${formatNumber(rule.ms)} ms${rule.jitterMs ? ` (jitter ${formatNumber(rule.jitterMs)} ms)` : ''} on ${target}`;
      break;
    case 'status':
      text = `${rule.status} on ${target}`;
      break;
    case 'stall':
      text = `pause ${seconds(rule.ms)} after ${formatNumber(rule.afterBytes)} bytes on ${target}`;
      break;
    case 'abort':
      text = `connection cut after ${formatNumber(rule.afterBytes ?? 0)} bytes on ${target}`;
      break;
    case 'live-stall':
      return `origin stops publishing at segment ${rule.atNumber} for ${seconds(rule.ms)}`;
    case 'manifest-stale':
      text = `manifest frozen for ${seconds(rule.ms)}`;
      break;
  }
  const modifiers: string[] = [];
  if (rule.times !== undefined)
    modifiers.push(rule.times === 1 ? 'first request only' : `first ${rule.times} requests`);
  if (rule.afterMs !== undefined)
    modifiers.push(`from ${seconds(rule.afterMs)} after the first media request`);
  if (rule.forMs !== undefined) modifiers.push(`for ${seconds(rule.forMs)}`);
  return modifiers.length > 0 ? `${text}, ${modifiers.join(', ')}` : text;
}

export function renderFaultProfiles(): string {
  const profiles = PROFILE_NAMES.map((name) => {
    const def = PROFILE_DEFINITIONS[name];
    return [
      `\`${name}\``,
      def.rules.length === 0 ? 'none' : def.rules.map(describeRule).join('; '),
      def.purpose,
      def.usedBy.join(', '),
    ];
  });
  const factories = PROFILE_FACTORIES.map((f) => [
    `\`${f.signature}\``,
    f.condition,
    f.purpose,
    f.usedBy.join(', '),
  ]);
  return [
    table(['Profile', 'Rules sent to the service', 'What it is for', 'Used by'], profiles),
    '',
    table(['Factory', 'Condition', 'What it is for', 'Used by'], factories),
  ].join('\n');
}
