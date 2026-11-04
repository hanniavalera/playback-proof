import { describe, expect, it } from 'vitest';
import {
  FLAKE_POLICY,
  GATE_BUDGETS,
  LIVE_READINESS,
  PERF_POLICY,
  PERF_SECONDS_PER_RUN,
  TEST_SECONDS_BY_AREA,
} from '../../../src/shared/criteria.ts';
import type { Policy } from '../../../src/shared/criteria.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import { PROFILE_FACTORIES, PROFILE_NAMES } from '../../../src/shared/profiles.ts';
import { CATALOG_AREAS, CATALOG_COLUMNS, parseCatalog, splitCells } from '../../../tools/catalog.ts';
import type { BudgetModel } from '../../../tools/catalog.ts';
import {
  describeRule,
  formatLimit,
  formatNumber,
  renderAreaLegend,
  renderFaultProfiles,
  renderFlakePolicy,
  renderGateBudgets,
  renderLiveCriteria,
  renderMergeBudget,
  renderPerfPolicy,
  renderPolicyTable,
  renderRiskTiers,
} from '../../../tools/policy-tables.ts';

const policy = (over: Partial<Policy> = {}): Policy => ({
  label: 'Thing',
  value: 5,
  unit: 'count',
  measure: 'How it is measured.',
  basis: { kind: 'assumption', text: 'Because.' },
  ...over,
});

/** Every table in a rendering must be well formed: each row has as many cells as its header. */
function expectWellFormedTables(markdown: string): number {
  let tables = 0;
  for (const chunk of markdown.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.startsWith('|'));
    if (lines.length === 0) continue;
    tables++;
    const width = splitCells(lines[0] ?? '').length;
    expect(splitCells(lines[1] ?? '').every((c) => /^-+$/.test(c))).toBe(true);
    for (const line of lines) expect(splitCells(line), line).toHaveLength(width);
  }
  return tables;
}

describe('PB-LAB-006 formatting of policy numbers', () => {
  it('groups thousands and keeps decimals', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(formatNumber(0.25)).toBe('0.25');
  });

  it.each([
    [{ value: 8000, unit: 'ms' }, '8,000 ms (8 s)'],
    [{ value: 1500, unit: 'ms' }, '1,500 ms (1.5 s)'],
    [{ value: 500, unit: 'ms' }, '500 ms'],
    [{ value: 1234, unit: 'ms' }, '1,234 ms'],
    [{ value: 0.005, unit: 'ratio' }, '0.5 %'],
    // 0.07 x 100 is 7.000000000000001 in floating point; it must not leak into a document.
    [{ value: 0.07, unit: 'ratio' }, '7 %'],
    [{ value: 0.02, unit: 'ratio' }, '2 %'],
    [{ value: 1.5, unit: 'x' }, '1.5x'],
    [{ value: 5, unit: 'min' }, '5 min'],
    [{ value: 20, unit: 'MB' }, '20 MB'],
    [{ value: 14, unit: 'days' }, '14 days'],
    [{ value: 480, unit: 's' }, '480 s'],
    [{ value: 15, unit: 'score' }, '15'],
    [{ value: 30, unit: 'count' }, '30'],
  ] as const)('shows %j as %s', (partial, text) => {
    expect(formatLimit(policy(partial))).toBe(text);
  });
});

describe('PB-LAB-006 renderPolicyTable', () => {
  it('renders one row per entry with the kind of basis in front of the explanation', () => {
    const table = renderPolicyTable({
      a: policy({ label: 'A', basis: { kind: 'fact', text: 'Copied.' } }),
      b: policy({ label: 'B', basis: { kind: 'arithmetic', text: 'Computed.' } }),
      c: policy({ label: 'C', basis: { kind: 'assumption', text: 'Guessed.' } }),
      d: policy({ label: 'D', basis: { kind: 'measured', text: 'Measured.' } }),
    });
    const lines = table.split('\n');
    expect(lines[0]).toBe('| Criterion | Limit | How it is measured | Where the number comes from |');
    expect(lines[1]).toBe('| --- | --- | --- | --- |');
    expect(lines.slice(2).map((l) => splitCells(l)[3])).toStrictEqual([
      'Fact: Copied.',
      'Arithmetic: Computed.',
      'Assumption: Guessed.',
      'Measured: Measured.',
    ]);
  });

  it('escapes pipes and flattens line breaks so a cell cannot break the table', () => {
    const table = renderPolicyTable({
      a: policy({ measure: 'a | b\nc', basis: { kind: 'fact', text: 'x | y' } }),
    });
    expect(table).toContain('a \\| b c');
    expect(splitCells(table.split('\n')[2] ?? '')).toStrictEqual(['Thing', '5', 'a | b c', 'Fact: x | y']);
  });

  it('lets the caller name the first two columns', () => {
    expect(renderPolicyTable({ a: policy() }, { first: 'Area', value: 'Estimate' }).split('\n')[0]).toMatch(
      /^\| Area \| Estimate \|/,
    );
  });
});

describe('PB-LAB-006 the generated policy tables', () => {
  it('renders every live readiness criterion, with its number and its kind of basis', () => {
    const table = renderLiveCriteria();
    expect(expectWellFormedTables(table)).toBe(1);
    for (const p of Object.values(LIVE_READINESS)) {
      expect(table).toContain(`| ${p.label} | ${formatLimit(p)} |`);
    }
    expect(table.split('\n')).toHaveLength(2 + Object.keys(LIVE_READINESS).length);
    expect(table).toContain('| Latency, p95 | 8,000 ms (8 s) |');
    expect(table).toContain('| Rebuffer ratio | 0.5 % |');
    expect(table).toMatch(/Arithmetic: Target plus one segment/);
    expect(table).toMatch(/Assumption: .*a margin is a measurement \(ADR-159b/);
  });

  it('is deterministic', () => {
    expect(renderLiveCriteria()).toBe(renderLiveCriteria());
    expect(renderGateBudgets()).toBe(renderGateBudgets());
    expect(renderFaultProfiles()).toBe(renderFaultProfiles());
  });

  it('renders the flake policy', () => {
    const table = renderFlakePolicy();
    expect(expectWellFormedTables(table)).toBe(1);
    for (const p of Object.values(FLAKE_POLICY))
      expect(table).toContain(`| ${p.label} | ${formatLimit(p)} |`);
    expect(table).toContain('| Quarantine trigger, per test | 5 % |');
  });

  it('renders the budgets and both estimate tables', () => {
    const text = renderGateBudgets();
    expect(expectWellFormedTables(text)).toBe(3);
    for (const set of [GATE_BUDGETS, TEST_SECONDS_BY_AREA, PERF_SECONDS_PER_RUN]) {
      for (const p of Object.values(set)) expect(text).toContain(`| ${p.label} | ${formatLimit(p)} |`);
    }
    expect(text).toContain('| Ceiling: merge-tier browser tests per engine | 30 |');
  });

  it('renders every performance threshold with its number and the kind of its basis', () => {
    const text = renderPerfPolicy();
    expect(expectWellFormedTables(text)).toBe(1);
    for (const p of Object.values(PERF_POLICY)) expect(text).toContain(`| ${p.label} | ${formatLimit(p)} |`);
    expect(text).toContain('| Frame rate (PB-PERF-002): floor | 1 fps |');
    expect(text).toContain('| Stability limit: baseline CV | 15 % |');
  });

  it('renders the thresholds and a rule for every lane', () => {
    const text = renderRiskTiers();
    expect(expectWellFormedTables(text)).toBe(2);
    expect(text).toContain('| Merge threshold | 15 |');
    expect(text).toContain('| Release threshold | 8 |');
    for (const lane of ['e2e', 'perf', 'unit', 'live', 'ab']) expect(text).toContain(`| \`${lane}\` |`);
    expect(text).toMatch(/\| `unit` .* always merge/);
    expect(text).toMatch(/\| `ab` .* always release/);
    expect(text).toMatch(
      /\| `e2e` .* score 15 or more: merge; 8 to 14: release; below 8: not an automated test/,
    );
  });

  it('renders one legend row per catalog area and splits paths into code spans', () => {
    const text = renderAreaLegend();
    expectWellFormedTables(text);
    for (const code of Object.keys(CATALOG_AREAS)) expect(text).toContain(`| \`${code}\` |`);
    expect(text).toContain('`tests/e2e` and `tests/unit`');
  });

  it('renders the fault profiles and factories', () => {
    const text = renderFaultProfiles();
    expect(expectWellFormedTables(text)).toBe(2);
    for (const name of PROFILE_NAMES) expect(text).toContain(`| \`${name}\` |`);
    for (const f of PROFILE_FACTORIES) expect(text).toContain(`| \`${f.signature}\` |`);
    expect(text).toContain(
      '| `bandwidth-drop` | throttle 600 kbps on media requests, from 8 s after the first media request |',
    );
    expect(text).toContain('| `clean` | none |');
  });
});

describe('PB-LAB-006 describeRule', () => {
  const cases: Array<[FaultRule, string]> = [
    [{ type: 'throttle', kbps: 1500 }, 'throttle 1,500 kbps on media requests'],
    [
      { type: 'throttle', kbps: 600, afterMs: 8000 },
      'throttle 600 kbps on media requests, from 8 s after the first media request',
    ],
    [
      { type: 'throttle', kbps: 600, afterMs: 8000, forMs: 12000 },
      'throttle 600 kbps on media requests, from 8 s after the first media request, for 12 s',
    ],
    [
      { type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } },
      'latency 300 ms (jitter 100 ms) on all requests',
    ],
    [
      { type: 'latency', ms: 8000, match: { kind: 'segment', track: 'video', number: 3 }, times: 1 },
      'latency 8,000 ms on video segment 3, first request only',
    ],
    [
      { type: 'status', status: 503, match: { kind: 'segment', track: 'video', number: 3 }, times: 3 },
      '503 on video segment 3, first 3 requests',
    ],
    [{ type: 'status', status: 503, match: { kind: 'media', rep: 'v720' } }, '503 on v720 media requests'],
    [{ type: 'status', status: 503, match: { kind: 'manifest' } }, '503 on manifest requests'],
    [
      { type: 'status', status: 404, match: { kind: 'init', track: 'audio' } },
      '404 on audio initialization segment requests',
    ],
    [
      { type: 'status', status: 500, match: { kind: 'segment', number: { from: 4, to: 6 } } },
      '500 on segments 4 to 6',
    ],
    [{ type: 'status', status: 500, match: { kind: 'any', track: 'any' } }, '500 on all requests'],
    [{ type: 'stall', afterBytes: 1000, ms: 2500 }, 'pause 2,500 ms after 1,000 bytes on media requests'],
    [
      { type: 'abort', afterBytes: 20000, match: { kind: 'segment', track: 'video', number: 3 }, times: 1 },
      'connection cut after 20,000 bytes on video segment 3, first request only',
    ],
    [{ type: 'abort' }, 'connection cut after 0 bytes on media requests'],
    [{ type: 'live-stall', atNumber: 40, ms: 10_000 }, 'origin stops publishing at segment 40 for 10 s'],
    [{ type: 'manifest-stale', ms: 8000 }, 'manifest frozen for 8 s'],
    [
      { type: 'manifest-stale', ms: 1500, afterMs: 3000 },
      'manifest frozen for 1,500 ms, from 3 s after the first media request',
    ],
  ];
  it.each(cases)('describes %j', (rule, text) => {
    expect(describeRule(rule)).toBe(text);
  });
});

describe('PB-LAB-006 renderMergeBudget', () => {
  const model: BudgetModel = {
    workers: 2,
    setupSec: 10,
    failureAllowanceSec: 10,
    mergeJobSec: 100,
    releaseE2eJobSec: 200,
    perfJobSec: 100,
    maxMergeTestsPerEngine: 3,
    cpuSlowdown: 2,
    perfRuns: 2,
    testSecondsByArea: { VOD: 20 },
    perfSecondsPerRun: { 'PB-PERF-001': 10 },
  };
  const rows = (...lines: string[]) =>
    parseCatalog(
      [
        '<!-- BEGIN:TEST_CATALOG -->',
        `| ${CATALOG_COLUMNS.join(' | ')} |`,
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...lines,
        '<!-- END:TEST_CATALOG -->',
      ].join('\n'),
    );
  const vod = (n: number, tier = 'merge', risk = '3x5=15') =>
    `| PB-VOD-00${n} | VOD | Plays | ${risk} | ${tier} | all | e2e | Block the merge. |`;

  it('shows the arithmetic of every job and the headroom', () => {
    const text = renderMergeBudget(rows(vod(1), vod(2)), model);
    expectWellFormedTables(text.split('\n\n')[0] ?? '');
    // 2 tests x 20 s = 40 test-seconds; / 2 workers = 20; + 10 + 10 = 40 s of 100 s: 60 s (60 %) of headroom.
    expect(text).toContain('| merge chromium | 2 | 40 s | 40 s (0.7 min) | 100 s (1.7 min) | 60 s (60 %) |');
    expect(text).toContain('| release webkit | 2 | 40 s | 40 s (0.7 min) | 200 s (3.3 min) | 160 s (80 %) |');
    expect(text).toContain('/ 2 workers + 10 s setup + 10 s failure allowance');
    expect(text).toContain(
      'Ceiling: 3 merge-tier browser tests per engine; the most loaded engine carries 2.',
    );
  });

  it('says by how much a job is over its budget', () => {
    expect(renderMergeBudget(rows(vod(1), vod(2)), { ...model, mergeJobSec: 30 })).toContain('over by 10 s');
  });
});
