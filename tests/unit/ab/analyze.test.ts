import { describe, expect, it } from 'vitest';
import { analyzeCondition, analyzeResult, planOf } from '../../../ab/analyze.ts';
import { RESULT_SCHEMA_VERSION, ResultFileError, parseRawResult } from '../../../ab/results.ts';
import type { RawResult } from '../../../ab/results.ts';
import { PreregistrationError, sha256Hex, validatePreregistration } from '../../../ab/prereg.ts';
import type { Preregistration } from '../../../ab/prereg.ts';
import { cliffsDelta } from '../../../ab/stats/cliffs-delta.ts';
import { fisherExact } from '../../../ab/stats/fisher.ts';
import { mannWhitneyU } from '../../../ab/stats/mann-whitney.ts';
import { holmAdjust } from '../../../ab/stats/holm.ts';
import { gaussian, generator } from './helpers.ts';
import { startupPrereg } from './fixtures.ts';
import { interleaved, makeSession, plan, shareMetric, startupMetric, startupOnly } from './synthetic.ts';

// The pipeline from sessions to tables and verdict, on synthetic experiments whose answer is known.

const normal = (seed: number, n: number, mean: number, sd: number): number[] =>
  gaussian(generator(seed), n, mean, sd).map((x) => Math.round(x));

describe('PB-AB analysis of one condition: a clear improvement', () => {
  const a = normal(1, 30, 1000, 80);
  const b = normal(2, 30, 800, 80);
  const sessions = interleaved(startupOnly(a), startupOnly(b));
  const analysis = analyzeCondition(plan([startupMetric()]), sessions);
  const startup = analysis.metrics[0];

  it('computes the same numbers as the statistics it is built from', () => {
    const mw = mannWhitneyU(a, b);
    expect(startup?.test).toMatchObject({ name: 'mann-whitney', p: mw.p });
    expect(startup?.cliffs).toStrictEqual(cliffsDelta(a, b));
    expect(startup?.nA).toBe(30);
    expect(startup?.nB).toBe(30);
    expect(startup?.effect?.estimate).toBeGreaterThan(-260);
    expect(startup?.effect?.estimate).toBeLessThan(-140);
    expect(startup?.effect?.kind).toBe('hodges-lehmann');
    expect(startup?.effect?.level).toBe(0.95);
  });

  it('reports the median and the p90 of each arm, and a quantile table from p10 to p90', () => {
    expect(startup?.summaryA?.n).toBe(30);
    expect(startup?.summaryA?.median).toBeGreaterThan(900);
    expect(startup?.summaryB?.median).toBeLessThan(900);
    expect(startup?.summaryA?.p90).toBeGreaterThan(startup?.summaryA?.median ?? 0);
    expect(startup?.ecdf?.probabilities).toStrictEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(startup?.ecdf?.a).toHaveLength(9);
    const [a50, b50] = [startup?.ecdf?.a[4], startup?.ecdf?.b[4]];
    expect(a50).toBe(startup?.summaryA?.median);
    expect(b50).toBe(startup?.summaryB?.median);
  });

  it('is its own Holm family of one: the adjusted p is the raw p, and the verdict is ship B', () => {
    expect(analysis.family).toStrictEqual(['startupMs']);
    expect(startup?.pAdjusted).toBe(startup?.test?.p);
    expect(startup?.significant).toBe(true);
    expect(analysis.decision?.outcome).toBe('ship-b');
    expect(analysis.decisionNote).toBeNull();
  });

  it('says that the arms started on different rungs, and that nothing here separates the first rung from the rest', () => {
    expect(analysis.startRungs).toMatchObject({
      A: { '720': 30 },
      B: { '240': 30 },
      shared: [],
      disjoint: true,
      differs: true,
    });
    expect(analysis.startRungs.note).toContain('never started on the same rung');
    expect(analysis.startRungs.note).toContain('cannot be told apart');
  });

  it('is reproducible: the same sessions and seed give the same analysis, another seed moves only the interval', () => {
    expect(analyzeCondition(plan([startupMetric()]), sessions)).toStrictEqual(analysis);
    const reseeded = analyzeCondition(plan([startupMetric()], { seed: 7 }), sessions);
    expect(reseeded.metrics[0]?.test).toStrictEqual(startup?.test);
    expect(reseeded.metrics[0]?.effect?.estimate).toBe(startup?.effect?.estimate);
    expect(reseeded.metrics[0]?.effect?.low).not.toBe(startup?.effect?.low);
  });
});

describe('PB-AB analysis: two arms that are the same', () => {
  it('finds no difference between two draws from one distribution', () => {
    const a = normal(11, 30, 1000, 80);
    const b = normal(12, 30, 1000, 80);
    const analysis = analyzeCondition(
      plan([startupMetric({ practicalThreshold: 150 })]),
      interleaved(startupOnly(a), startupOnly(b)),
    );
    expect(analysis.metrics[0]?.test?.p).toBeGreaterThan(0.05);
    expect(analysis.metrics[0]?.significant).toBe(false);
    expect(['no-difference', 'inconclusive']).toContain(analysis.decision?.outcome);
    expect(analysis.decision?.outcome).not.toBe('ship-b');
    expect(analysis.decision?.outcome).not.toBe('do-not-ship-b');
  });

  it('says there is no difference, with its sentence, when the interval is inside the threshold', () => {
    const a = normal(13, 60, 1000, 40);
    const b = normal(14, 60, 1000, 40);
    const analysis = analyzeCondition(
      plan([startupMetric({ practicalThreshold: 150 })]),
      interleaved(startupOnly(a), startupOnly(b)),
    );
    expect(analysis.decision?.outcome).toBe('no-difference');
    expect(analysis.decision?.reason).toContain('every primary interval lies inside its threshold');
  });
});

describe('PB-AB analysis: the family of primary metrics and the secondary ones', () => {
  const random = generator(21);
  const rows = (n: number, stallShare: number, startup: number): Record<string, number | null>[] =>
    Array.from({ length: n }, () => {
      const stalled = random() < stallShare;
      return {
        startupMs: Math.round(startup + (random() - 0.5) * 200),
        rebufferCount: stalled ? 1 : 0,
        rebufferMs: stalled ? 1500 : 0,
        rebufferRatio: stalled ? 0.05 : 0,
      };
    });
  const a = rows(30, 0.6, 1000);
  const b = rows(30, 0.1, 1000);
  const sessions = interleaved(a, b);
  const metrics = [
    startupMetric({ practicalThreshold: 150 }),
    shareMetric(),
    { id: 'rebufferRatio' as const, role: 'secondary' as const, direction: 'lower-is-better' as const },
  ];
  const analysis = analyzeCondition(plan(metrics), sessions);
  const [startup, share, ratio] = analysis.metrics;

  it('adjusts the primary p-values with Holm over the family, in plan order, and leaves the secondary one alone', () => {
    expect(analysis.family).toStrictEqual(['startupMs', 'rebufferShare']);
    const raw = [startup?.test?.p as number, share?.test?.p as number];
    const adjusted = holmAdjust(raw);
    expect(startup?.pAdjusted).toBeCloseTo(adjusted[0] as number, 14);
    expect(share?.pAdjusted).toBeCloseTo(adjusted[1] as number, 14);
    expect(startup?.pAdjusted as number).toBeGreaterThanOrEqual(raw[0] as number);
    expect(ratio?.pAdjusted).toBeNull();
    expect(ratio?.role).toBe('secondary');
  });

  it('compares the share of sessions with a rebuffer with Fisher and a difference of shares, not with a shift', () => {
    const countsA = a.filter((row) => (row.rebufferCount as number) >= 1).length;
    const countsB = b.filter((row) => (row.rebufferCount as number) >= 1).length;
    expect(share?.kind).toBe('binary');
    expect(share?.countsA).toMatchObject({ events: countsA, total: 30 });
    expect(share?.countsB).toMatchObject({ events: countsB, total: 30 });
    expect(share?.test).toMatchObject({
      name: 'fisher',
      p: fisherExact({ events: countsA, total: 30 }, { events: countsB, total: 30 }).p,
    });
    expect(share?.effect?.kind).toBe('share-difference');
    expect(share?.effect?.estimate).toBeCloseTo(countsB / 30 - countsA / 30, 14);
    expect(share?.effect?.estimate).toBeLessThan(-0.3);
    expect(share?.cliffs).toBeNull();
    expect(share?.ecdf).toBeNull();
  });

  it('applies the rule to both primary metrics, and the verdict names the one that carries it', () => {
    expect(analysis.decision?.readings.map((reading) => reading.id)).toStrictEqual([
      'startupMs',
      'rebufferShare',
    ]);
    expect(analysis.decision?.outcome).toBe('ship-b');
    expect(analysis.decision?.reason).toContain('Share of sessions with a rebuffer');
  });

  it('warns when a count that is zero in most sessions gives an interval that collapses to a point', () => {
    const zeros = (n: number, ones: number): Record<string, number | null>[] =>
      Array.from({ length: n }, (_, i) => ({ startupMs: 1000, rebufferCount: i < ones ? 1 : 0 }));
    const sparse = analyzeCondition(
      plan([startupMetric(), { id: 'rebufferCount', role: 'secondary', direction: 'lower-is-better' }]),
      interleaved(zeros(30, 4), zeros(30, 11)),
    );
    const count = sparse.metrics[1];
    expect(count?.effect?.low).toBe(count?.effect?.high);
    expect(count?.warnings[0]).toContain('collapsed to one value');
    expect(count?.warnings[0]).toContain("Cliff's delta");
  });
});

describe('PB-AB analysis: warm-up, failed and incomplete sessions', () => {
  const a = normal(31, 30, 1000, 80);
  const b = normal(32, 30, 1000, 80);

  it('leaves the warm-up sessions out of every statistic and counts them', () => {
    const real = interleaved(startupOnly(a), startupOnly(b));
    const warm = [
      makeSession(100, 'A', { startupMs: 99999 }, { warmup: true }),
      makeSession(101, 'B', { startupMs: 99999 }, { warmup: true }),
    ];
    const withWarm = analyzeCondition(plan([startupMetric()]), [...warm, ...real]);
    const without = analyzeCondition(plan([startupMetric()]), real);
    expect(withWarm.warmup).toStrictEqual({ A: 1, B: 1 });
    expect(withWarm.metrics).toStrictEqual(without.metrics);
    expect(withWarm.attempted).toStrictEqual({ A: 30, B: 30 });
  });

  it('counts a failed session, lists it with the reason, and keeps its (absent) numbers out of the comparison', () => {
    const sessions = interleaved(startupOnly(a), startupOnly(b), (arm, block) =>
      arm === 'B' && block === 3
        ? {
            status: 'failed',
            failure: { kind: 'timeout', message: 'no first frame within 30000 ms' },
            values: {},
          }
        : {},
    );
    const analysis = analyzeCondition(plan([startupMetric()]), sessions);
    expect(analysis.attempted).toStrictEqual({ A: 30, B: 30 });
    expect(analysis.analysed).toStrictEqual({ A: 30, B: 29 });
    expect(analysis.metrics[0]?.nB).toBe(29);
    expect(analysis.failures).toMatchObject({
      attemptedA: 30,
      attemptedB: 30,
      failedA: 0,
      failedB: 1,
      guardTripped: false,
    });
    expect(analysis.failures.sessions).toStrictEqual([
      {
        index: expect.any(Number),
        block: 3,
        arm: 'B',
        kind: 'timeout',
        message: 'no first frame within 30000 ms',
      },
    ]);
    expect(analysis.failures.fisherP).toBe(fisherExact({ events: 0, total: 30 }, { events: 1, total: 30 }).p);
  });

  it('trips the failure guard when the arms fail differently, and then neither ships B nor says no difference', () => {
    const sessions = interleaved(
      startupOnly(normal(33, 30, 1000, 40)),
      startupOnly(normal(34, 30, 700, 40)),
      (arm, block) =>
        arm === 'B' && block < 7
          ? {
              status: 'failed',
              failure: { kind: 'critical-error', message: 'BAD_HTTP_STATUS/2' },
              values: {},
            }
          : {},
    );
    const analysis = analyzeCondition(plan([startupMetric()]), sessions);
    expect(analysis.failures.failedB).toBe(7);
    expect(analysis.failures.guardTripped).toBe(true);
    expect(analysis.decision?.outcome).toBe('inconclusive');
    expect(analysis.decision?.reason).toContain('failed');
  });

  it('a primary metric with fewer than two analysed sessions in an arm gives no comparison and an inconclusive verdict', () => {
    const sessions = [
      makeSession(0, 'A', { startupMs: 900 }),
      makeSession(1, 'B', { startupMs: 800 }),
      makeSession(2, 'A', { startupMs: 950 }),
    ];
    const analysis = analyzeCondition(plan([startupMetric()]), sessions);
    expect(analysis.metrics[0]).toMatchObject({
      nA: 2,
      nB: 1,
      effect: null,
      test: null,
      cliffs: null,
      pAdjusted: 1,
    });
    expect(analysis.decision?.outcome).toBe('inconclusive');
  });

  it('counts the sessions that had a recoverable Shaka error, and does not drop them', () => {
    const sessions = interleaved(startupOnly(a), startupOnly(b), (arm, block) =>
      arm === 'A' && block < 4
        ? { errors: ['1001 BAD_HTTP_STATUS/1'] }
        : arm === 'B' && block === 0
          ? { errors: ['3016 X/2'] }
          : {},
    );
    const analysis = analyzeCondition(plan([startupMetric()]), sessions);
    expect(analysis.recoverableErrors).toStrictEqual({ A: 4, B: 0 });
    expect(analysis.analysed).toStrictEqual({ A: 30, B: 30 });
  });

  it('a metric that a session could not measure (null) is left out of that metric only', () => {
    const sessions = interleaved(
      a.map((startupMs, i) => ({ startupMs, rebufferCount: i === 0 ? null : 0 })),
      b.map((startupMs) => ({ startupMs, rebufferCount: 0 })),
    );
    const analysis = analyzeCondition(
      plan([startupMetric(), { id: 'rebufferCount', role: 'secondary', direction: 'lower-is-better' }]),
      sessions,
    );
    expect(analysis.metrics[0]?.nA).toBe(30);
    expect(analysis.metrics[1]?.nA).toBe(29);
  });
});

describe('PB-AB analysis: what an exploratory run and a pipeline check do not do', () => {
  const sessions = interleaved(startupOnly(normal(41, 8, 1000, 50)), startupOnly(normal(42, 8, 900, 50)));

  it('an exploratory comparison estimates and decides nothing, and says so', () => {
    const analysis = analyzeCondition(plan([startupMetric()], { kind: 'exploratory' }), sessions);
    expect(analysis.decision).toBeNull();
    expect(analysis.decisionNote).toContain('exploratory comparison');
    expect(analysis.metrics[0]?.effect).not.toBeNull();
  });

  it('a pipeline check decides nothing either', () => {
    const analysis = analyzeCondition(plan([startupMetric()], { kind: 'pipeline-check' }), sessions);
    expect(analysis.decision).toBeNull();
    expect(analysis.decisionNote).toContain('pipeline check');
  });

  it('refuses to apply the rule to a primary metric that has no practical threshold', () => {
    expect(() =>
      analyzeCondition(plan([startupMetric({ practicalThreshold: undefined })]), sessions),
    ).toThrow(/no practical threshold/);
  });
});

describe('PB-AB analysis: the exploratory section (not pre-registered, outside the Holm family)', () => {
  it('lists the metrics that were not pre-registered with raw p-values, and never the ones that were', () => {
    const rows = (n: number, switches: number): Record<string, number | null>[] =>
      Array.from({ length: n }, (_, i) => ({
        startupMs: 1000 + i,
        switches: switches + (i % 2),
        droppedRatio: 0,
      }));
    const analysis = analyzeCondition(plan([startupMetric()]), interleaved(rows(30, 1), rows(30, 3)));
    const [block] = analysis.exploratory;
    expect(block?.title).toBe('Metrics that were not pre-registered');
    expect(block?.rows.map((row) => row.label)).toStrictEqual(['Rung switches', 'Dropped-frame ratio']);
    expect(block?.note).toContain('no adjustment');
    expect(block?.rows[0]?.p).toBeLessThan(0.001);
  });

  it('compares startup within a start rung only where both arms have sessions on it, and says when none does', () => {
    const disjoint = analyzeCondition(
      plan([startupMetric()]),
      interleaved(startupOnly(normal(51, 10, 1000, 50)), startupOnly(normal(52, 10, 900, 50))),
    );
    const strata = disjoint.exploratory.find((block) => block.title.startsWith('Startup within'));
    expect(strata?.rows).toStrictEqual([]);
    expect(strata?.note).toContain('a rung-matched comparison is not possible with these data');

    const mixed = interleaved(
      startupOnly(normal(53, 20, 1000, 50)),
      startupOnly(normal(54, 20, 900, 50)),
      (arm, block) => ({
        startRungHeight: block % 2 === 0 ? 360 : arm === 'A' ? 720 : 240,
      }),
    );
    const analysis = analyzeCondition(plan([startupMetric()]), mixed);
    const matched = analysis.exploratory.find((block) => block.title.startsWith('Startup within'));
    expect(matched?.rows).toHaveLength(1);
    expect(matched?.rows[0]).toMatchObject({
      label: 'Startup time of the sessions that started on 360p',
      nA: 10,
      nB: 10,
    });
    expect(analysis.startRungs.shared).toStrictEqual(['360']);
    expect(analysis.startRungs.disjoint).toBe(false);
  });

  it('is left out when the caller only needs the verdict (the calibration and the power simulations)', () => {
    const analysis = analyzeCondition(
      plan([startupMetric()]),
      interleaved(startupOnly([1, 2, 3, 4]), startupOnly([2, 3, 4, 5])),
      { exploratory: false },
    );
    expect(analysis.exploratory).toStrictEqual([]);
  });

  it('says that the arms started alike when they did', () => {
    const same = interleaved(
      startupOnly(normal(55, 10, 1000, 50)),
      startupOnly(normal(56, 10, 1000, 50)),
      () => ({ startRungHeight: 720 }),
    );
    const analysis = analyzeCondition(plan([startupMetric()]), same);
    expect(analysis.startRungs).toMatchObject({ shared: ['720'], disjoint: false, differs: false });
    expect(analysis.startRungs.note).toContain('started on the same rungs in about the same proportions');
  });
});

describe('PB-AB analysis of a results file', () => {
  function rawResult(
    prereg: Preregistration,
    text: string,
    sessions = interleaved(startupOnly(normal(61, 30, 1000, 80)), startupOnly(normal(62, 30, 800, 80))),
  ): RawResult {
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      kind: 'ab-raw',
      preregistration: {
        path: 'ab/prereg/PB-AB-002.json',
        sha256: sha256Hex(text),
        text,
        committed: { clean: true, commit: 'abc1234', date: '2026-11-05T08:00:00Z' },
      },
      environment: {
        envId: 'local-darwin-arm64',
        host: {
          os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS' },
          cpus: 12,
          memoryGiB: 16,
          node: 'v22',
          playwright: '1.64.1',
          git: { commit: 'abc1234', dirty: false },
        },
        browser: { name: 'chromium', version: '156', userAgent: null },
        ffmpeg: '9',
        streams: { 'vod-cmaf': 'hash' },
      },
      run: { startedAt: '2026-11-05T09:00:00Z', finishedAt: '2026-11-05T09:30:00Z', command: 'npm run ab' },
      conditions: [
        {
          id: prereg.conditions[0]?.id ?? 'high-latency',
          rules: prereg.conditions[0]?.rules ?? [],
          stream: 'vod-cmaf',
          startedAt: '2026-11-05T09:00:00Z',
          finishedAt: '2026-11-05T09:30:00Z',
          loadAverage: { before: 1, after: 1.5 },
          sessions,
          aborted: null,
        },
      ],
    };
  }

  const text = `${JSON.stringify(startupPrereg(), null, 2)}\n`;
  const validated = validatePreregistration(JSON.parse(text));
  if (!validated.ok) throw new Error(validated.problems.join('; '));

  it('re-validates the plan inside the file, takes its seed, resamples and thresholds from it, and analyses every condition', () => {
    const result = analyzeResult(rawResult(validated.prereg, text));
    expect(result.prereg.id).toBe('PB-AB-002');
    expect(result.warnings).toStrictEqual([]);
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]?.analysis.decision?.outcome).toBe('ship-b');
    expect(planOf(result.prereg)).toMatchObject({
      seed: 20261104,
      bootstrapResamples: 5000,
      alpha: 0.05,
      confidenceLevel: 0.95,
      maxFailedShare: 0.1,
    });
    expect(result.conditions[0]?.analysis.metrics[0]?.effect?.method).toContain('5000 resamples');
  });

  it('refuses a file whose embedded plan no longer hashes to the recorded sha256: the plan was changed after the run', () => {
    const raw = rawResult(validated.prereg, text);
    raw.preregistration.text = text.replace('"practicalThreshold": 100', '"practicalThreshold": 10');
    expect(() => analyzeResult(raw)).toThrow(ResultFileError);
    expect(() => analyzeResult(raw)).toThrow(/was changed after the run/);
  });

  it('refuses a file whose embedded plan is not a valid pre-registration, even when the hash matches', () => {
    const broken = JSON.stringify({ ...startupPrereg(), sessionsPerArm: 3 });
    const raw = rawResult(validated.prereg, broken);
    expect(() => analyzeResult(raw)).toThrow(PreregistrationError);
  });

  it('parses a results file back from its JSON, and refuses one that is damaged, saying what is wrong', () => {
    const raw = rawResult(validated.prereg, text);
    expect(parseRawResult(JSON.stringify(raw)).conditions[0]?.sessions).toHaveLength(60);
    expect(() => parseRawResult('{ nope')).toThrow(/not valid JSON/);
    expect(() => parseRawResult('[]')).toThrow(/must be a JSON object/);
    const damaged = JSON.parse(JSON.stringify(raw)) as RawResult;
    (damaged as unknown as { schemaVersion: number }).schemaVersion = 9;
    damaged.conditions[0]!.sessions[0]!.arm = 'C' as 'A';
    expect(() => parseRawResult(JSON.stringify(damaged))).toThrow(
      /schemaVersion must be 1[\s\S]*arm must be "A" or "B"/,
    );
  });
});
