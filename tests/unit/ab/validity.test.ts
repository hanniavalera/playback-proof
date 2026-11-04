import { describe, expect, it } from 'vitest';
import { analyzeResult } from '../../../ab/analyze.ts';
import { validatePreregistration } from '../../../ab/prereg.ts';
import type { Preregistration } from '../../../ab/prereg.ts';
import type { RawResult } from '../../../ab/results.ts';
import { assessValidity, checkAaReport } from '../../../ab/validity.ts';
import type { Validity } from '../../../ab/validity.ts';
import { AA_SOURCE, passingAaReport, startupPrereg } from './fixtures.ts';
import type { Json } from './fixtures.ts';
import { gaussian, generator } from './helpers.ts';
import { buildRaw, scheduled, startupOnly } from './synthetic.ts';

// Validity: what makes a run valid evidence apart from the direction of its result. Each gate is made to fail on its own, and a run of
// every verdict is shown to be valid, because the lab passes an experiment when it is valid, not when B wins.

const normal = (seed: number, n: number, mean: number, sd: number): number[] =>
  gaussian(generator(seed), n, mean, sd).map((x) => Math.round(x));

function run(
  planJson: Json = startupPrereg(),
  a = normal(1, 30, 1000, 80),
  b = normal(2, 30, 800, 80),
  extra?: NonNullable<Parameters<typeof scheduled>[2]>['extra'],
  over: Parameters<typeof buildRaw>[2] = {},
): { raw: RawResult; plan: Preregistration } {
  const text = `${JSON.stringify(planJson, null, 2)}\n`;
  const checked = validatePreregistration(JSON.parse(text));
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  const condition = checked.prereg.conditions[0] as Preregistration['conditions'][number];
  const raw = buildRaw(
    { text, conditionId: condition.id, rules: condition.rules },
    scheduled(startupOnly(a), startupOnly(b), {
      warmup: checked.prereg.warmupSessionsPerArm,
      ...(extra === undefined ? {} : { extra }),
    }),
    over,
  );
  return { raw, plan: checked.prereg };
}

const reader =
  (files: Record<string, string>) =>
  (path: string): string | null =>
    files[path] ?? null;

function assess(
  raw: RawResult,
  files: Record<string, string> = { [AA_SOURCE]: passingAaReport() },
): Validity {
  return assessValidity(raw, analyzeResult(raw, { exploratory: false }), { readReference: reader(files) });
}

const gate = (validity: Validity, id: string) => validity.gates.find((candidate) => candidate.id === id);

describe('PB-AB validity: a run that did what it said', () => {
  const { raw } = run();
  const validity = assess(raw);

  it('passes every gate: the plan was committed first, the design followed, the configurations and the condition proved, the failures few, the machine quiet, the A/A passed', () => {
    expect(validity.gates.map((g) => g.id)).toStrictEqual([
      'preregistration',
      'design',
      'configuration',
      'condition',
      'failures',
      'machine',
      'aa-check',
    ]);
    expect(validity.gates.every((g) => g.passed)).toBe(true);
    expect(validity).toMatchObject({ valid: true, evidence: true });
    expect(validity.summary).toMatch(
      /^VALID: the experiment was run as pre-registered, on data that pass all 7 gates/,
    );
    expect(validity.summary).toContain('The direction of the result does not enter');
  });

  it('says in each gate what was checked, with the numbers', () => {
    expect(gate(validity, 'preregistration')?.detail).toContain(raw.preregistration.sha256);
    expect(gate(validity, 'preregistration')?.detail).toContain('committed unmodified in abc1234');
    expect(gate(validity, 'design')?.detail).toContain('64 sessions in 1 condition');
    expect(gate(validity, 'design')?.detail).toContain('2 warm-up blocks first, 30 measured per arm');
    expect(gate(validity, 'configuration')?.detail).toContain('64 finished sessions');
    expect(gate(validity, 'condition')?.detail).toContain(
      '64 finished sessions: the service held exactly the registered rules',
    );
    expect(gate(validity, 'condition')?.detail).toContain('12 to 12 requests per session');
    expect(gate(validity, 'failures')?.detail).toContain('0 of 60 measured sessions failed');
    expect(gate(validity, 'machine')?.detail).toContain(
      'load average was 1.1 before the first session, on 12 CPUs',
    );
    expect(gate(validity, 'aa-check')?.detail).toContain(
      'passed for high-latency on chromium in local-darwin-arm64',
    );
  });

  it('is valid whichever way the result points: B better, A better, equivalent and inconclusive are all results', () => {
    const cases: Array<[string, number[], number[]]> = [
      ['B better', normal(1, 30, 1000, 80), normal(2, 30, 800, 80)],
      ['A better', normal(3, 30, 800, 80), normal(4, 30, 1000, 80)],
      ['equivalent', normal(5, 30, 1000, 20), normal(6, 30, 1000, 20)],
      ['inconclusive', normal(7, 30, 1000, 150), normal(8, 30, 930, 150)],
    ];
    const verdicts: string[] = [];
    for (const [name, a, b] of cases) {
      const { raw: result } = run(startupPrereg(), a, b);
      const analysis = analyzeResult(result, { exploratory: false });
      verdicts.push(analysis.conditions[0]?.analysis.decision?.verdict ?? 'none');
      expect(assess(result).valid, name).toBe(true);
    }
    expect(verdicts).toStrictEqual(['b-better', 'a-better', 'equivalent', 'inconclusive']);
  });
});

describe('PB-AB validity: each gate fails on its own, and the run is then not valid whatever the verdict', () => {
  const failing = (raw: RawResult, id: string, pattern: RegExp, files?: Record<string, string>): Validity => {
    const validity = assess(raw, files);
    const failed = validity.gates.filter((g) => !g.passed);
    expect(
      failed.map((g) => g.id),
      id,
    ).toStrictEqual([id]);
    expect(gate(validity, id)?.detail).toMatch(pattern);
    expect(validity).toMatchObject({ valid: false, evidence: false });
    expect(validity.summary).toMatch(/^NOT VALID: /);
    expect(validity.summary).toContain('must not be acted on, whichever way it points');
    return validity;
  };

  it('pre-registration: a plan that was not committed unmodified before the run proves nothing', () => {
    const { raw } = run(startupPrereg(), undefined, undefined, undefined, {
      committed: { clean: false, commit: null, date: null },
    });
    failing(raw, 'preregistration', /does not prove the plan was fixed before the data/);
    const late = run(startupPrereg(), undefined, undefined, undefined, {
      committed: { clean: true, commit: 'abc1234', date: '2026-11-06T08:00:00Z' },
    });
    failing(late.raw, 'preregistration', /dated after the run started/);
    const unknown = run(startupPrereg(), undefined, undefined, undefined, { committed: null });
    failing(unknown.raw, 'preregistration', /Git could not say/);
  });

  it('design: a session missing, two swapped, a condition stopped early, other rules, another stream or a condition not run', () => {
    const missing = structuredClone(run().raw);
    missing.conditions[0]?.sessions.pop();
    failing(missing, 'design', /63 sessions recorded, the plan schedules 64/);

    const swapped = structuredClone(run().raw);
    const sessions = swapped.conditions[0]?.sessions ?? [];
    [sessions[10], sessions[11]] = [sessions[11] as never, sessions[10] as never];
    failing(swapped, 'design', /2 sessions are not where the plan puts them \(the first: position 11\)/);

    const stopped = structuredClone(run().raw);
    (stopped.conditions[0] as { aborted: string | null }).aborted = '5 sessions failed in a row';
    failing(stopped, 'design', /high-latency: stopped early \(5 sessions failed in a row\)/);

    const rules = structuredClone(run().raw);
    (rules.conditions[0] as { rules: unknown }).rules = [{ type: 'latency', ms: 100 }];
    failing(rules, 'design', /the rules that ran are not the registered ones/);

    const stream = structuredClone(run().raw);
    (stream.conditions[0] as { stream: string }).stream = 'vod-webm';
    failing(stream, 'design', /ran on stream vod-webm, the plan says vod-cmaf/);

    const other = structuredClone(run().raw);
    (other.conditions[0] as { id: string }).id = 'elsewhere';
    failing(other, 'design', /high-latency: not run/);

    const warmup = structuredClone(run().raw);
    (warmup.conditions[0]?.sessions[0] as { warmup: boolean }).warmup = false;
    failing(warmup, 'design', /1 sessions are not where the plan puts them \(the first: position 1\)/);
  });

  it('configuration: a page that ran another configuration, other overrides, no proof, or not Media Source Extensions', () => {
    const target = (raw: RawResult, i: number) =>
      raw.conditions[0]?.sessions[i] as RawResult['conditions'][number]['sessions'][number];
    const mismatch = structuredClone(run().raw);
    (target(mismatch, 4).info as { config: string }).config = 'B';
    failing(
      mismatch,
      'configuration',
      /high-latency session 5 \(arm A\): the page ran configuration B, the arm needs A/,
    );

    const overrides = structuredClone(run().raw);
    (target(overrides, 4).info as { configOverrides: Record<string, unknown> }).configOverrides = {
      abr: { switchInterval: 1 },
    };
    failing(overrides, 'configuration', /the overrides the page applied are not those of configuration A/);

    const silent = structuredClone(run().raw);
    (target(silent, 3) as { info: null }).info = null;
    failing(silent, 'configuration', /the page did not say which configuration it ran/);

    const native = structuredClone(run().raw);
    (target(native, 2).info as { loadMode: string }).loadMode = 'src=';
    failing(native, 'configuration', /did not play through Media Source Extensions \(src=\)/);
  });

  it('condition: no proof from the service, other rules held, a rule that never fired, the wrong number of rules', () => {
    const target = (raw: RawResult, i: number) => raw.conditions[0]?.sessions[i] as { applied?: unknown };
    const none = structuredClone(run().raw);
    delete target(none, 7).applied;
    failing(none, 'condition', /the service was not asked what it held for the session/);

    const other = structuredClone(run().raw);
    target(other, 7).applied = { rulesMatch: false, requests: 12, fired: [12] };
    failing(other, 'condition', /the service held other rules than the registered ones/);

    const silent = structuredClone(run().raw);
    target(silent, 9).applied = { rulesMatch: true, requests: 12, fired: [0] };
    failing(
      silent,
      'condition',
      /rule 1 of 1 never fired on any of 12 requests, so the condition was not applied/,
    );

    const count = structuredClone(run().raw);
    target(count, 9).applied = { rulesMatch: true, requests: 12, fired: [12, 12] };
    failing(count, 'condition', /the service reported 2 rules, the condition has 1/);
  });

  it('condition: a condition with no faults has nothing to prove', () => {
    const plan = startupPrereg();
    (plan.conditions as Json[])[0] = {
      id: 'no-faults',
      profile: null,
      rules: [],
      rationale: 'A condition with no fault at all, to show that there is nothing to apply.',
    };
    // No rule makes any download measurable, so this is a pipeline check: finite links only for an experiment.
    plan.kind = 'pipeline-check';
    plan.catalogId = null;
    delete plan.aaCheck;
    const { raw } = run(plan);
    expect(gate(assess(raw), 'condition')?.passed).toBe(true);
  });

  it('failures: the guard of the decision rule trips when the arms fail differently', () => {
    const { raw } = run(startupPrereg(), undefined, undefined, (arm, i) =>
      arm === 'B' && i < 7
        ? { status: 'failed', failure: { kind: 'critical-error', message: 'BAD_HTTP_STATUS/2' }, values: {} }
        : {},
    );
    failing(raw, 'failures', /high-latency: .*failed/);
  });

  it('machine: a machine that was busy when the run started, by half its CPUs', () => {
    const { raw } = run();
    (raw.conditions[0] as { loadAverage: { before: number; after: number } }).loadAverage = {
      before: 6.5,
      after: 6.9,
    };
    failing(
      raw,
      'machine',
      /load average was 6\.5 before the first session, on 12 CPUs, above 50 % of them \(6\.0\)/,
    );
    const edge = run().raw;
    (edge.conditions[0] as { loadAverage: { before: number; after: number } }).loadAverage = {
      before: 6,
      after: 9,
    };
    expect(assess(edge).valid).toBe(true);
  });

  it('A/A check: missing, from another environment or engine, not valid itself, or not passed (the real A/A or its calibration)', () => {
    const { raw } = run();
    failing(
      raw,
      'aa-check',
      /is not there: an experiment relies on the harness having passed its own check/,
      {},
    );
    const files = (report: string): Record<string, string> => ({ [AA_SOURCE]: report });
    failing(raw, 'aa-check', /not valid JSON/, files('{ "kind": '));
    failing(
      raw,
      'aa-check',
      /it is not the report of an A\/A run/,
      files(passingAaReport({ experiment: { kind: 'experiment' } })),
    );
    failing(
      raw,
      'aa-check',
      /it was measured in docker-linux-arm64, this run is in local-darwin-arm64: the check is per environment/,
      files(passingAaReport({ environment: { envId: 'docker-linux-arm64' } })),
    );
    failing(
      raw,
      'aa-check',
      /it checked the harness on firefox, this run uses chromium/,
      files(passingAaReport({ design: { engine: 'firefox' } })),
    );
    failing(
      raw,
      'aa-check',
      /the A\/A run itself was not valid/,
      files(passingAaReport({ validity: { valid: false } })),
    );
    failing(
      raw,
      'aa-check',
      /its real interleaved A\/A of high-latency did not pass/,
      files(passingAaReport({ conditions: [{ id: 'high-latency', aa: { acceptable: false } }] })),
    );
    failing(
      raw,
      'aa-check',
      /its A\/A calibration of high-latency did not pass/,
      files(passingAaReport({ calibrations: [{ condition: 'high-latency', result: { pass: false } }] })),
    );
    failing(
      raw,
      'aa-check',
      /it has no A\/A run of the condition high-latency; it has no A\/A calibration of high-latency/,
      files(passingAaReport({ conditions: [], calibrations: [] })),
    );
  });
});

describe('PB-AB validity: a pipeline check is plumbing only and never evidence', () => {
  const pipeline = (): Json => {
    const plan = startupPrereg();
    plan.kind = 'pipeline-check';
    plan.catalogId = null;
    delete plan.aaCheck;
    plan.sessionsPerArm = 4;
    plan.warmupSessionsPerArm = 1;
    plan.bootstrapResamples = 100;
    return plan;
  };

  it('computes the gates, which show the plumbing works, and says in the same breath that it is not evidence', () => {
    const { raw } = run(pipeline(), normal(1, 4, 1000, 80), normal(2, 4, 800, 80));
    const validity = assess(raw, {});
    expect(validity.gates.map((g) => g.id)).not.toContain('aa-check');
    expect(validity).toMatchObject({ valid: true, evidence: false });
    expect(validity.summary).toBe(
      'Plumbing checks passed (6 of 6). This is a pipeline check, plumbing only, not evidence.',
    );
  });

  it('does not enforce the machine gate: a pipeline check runs on whatever machine there is, and says so', () => {
    const { raw } = run(pipeline(), normal(1, 4, 1000, 80), normal(2, 4, 800, 80));
    (raw.conditions[0] as { loadAverage: { before: number; after: number } }).loadAverage = {
      before: 9.9,
      after: 11,
    };
    const validity = assess(raw, {});
    expect(gate(validity, 'machine')).toMatchObject({ passed: false, enforced: false });
    expect(gate(validity, 'machine')?.detail).toContain('Not enforced for a pipeline check');
    expect(validity).toMatchObject({ valid: true, evidence: false });
    expect(validity.summary).toContain('not enforced for a pipeline check: Machine quiet at the start');
  });

  it('still fails when a gate of the plumbing fails', () => {
    const { raw } = run(pipeline(), normal(1, 4, 1000, 80), normal(2, 4, 800, 80));
    delete (raw.conditions[0]?.sessions[3] as { applied?: unknown }).applied;
    const validity = assess(raw, {});
    expect(validity.valid).toBe(false);
    expect(validity.summary).toBe(
      'Plumbing checks FAILED: Condition applied, the same in both arms. This is a pipeline check, plumbing only, not evidence.',
    );
  });
});

describe('PB-AB validity: reading the committed report of the A/A run', () => {
  const plan = { engine: 'chromium', conditions: [{ id: 'high-latency' }] } as unknown as Pick<
    Preregistration,
    'engine' | 'conditions'
  >;

  it('accepts a report of a valid A/A whose real run and calibration passed, in this environment, for this engine and condition', () => {
    expect(checkAaReport(passingAaReport(), AA_SOURCE, plan, 'local-darwin-arm64')).toStrictEqual({
      passed: true,
      detail: `${AA_SOURCE}: the real interleaved A/A and its calibration passed for high-latency on chromium in local-darwin-arm64.`,
    });
  });

  it('reads every condition of the plan, not only the first', () => {
    const two = {
      engine: 'chromium',
      conditions: [{ id: 'high-latency' }, { id: 'constrained-1500' }],
    } as unknown as Pick<Preregistration, 'engine' | 'conditions'>;
    const result = checkAaReport(passingAaReport(), AA_SOURCE, two, 'local-darwin-arm64');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('it has no A/A run of the condition constrained-1500');
    expect(result.detail).toContain('it has no A/A calibration of constrained-1500');
  });
});
