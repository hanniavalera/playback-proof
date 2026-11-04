import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FLAKE_LIMITS,
  FLAKE_POLICY,
  GATE_BUDGETS,
  GATE_LIMITS,
  LANE_TIER,
  LIVE_FACTS,
  LIVE_LIMITS,
  LIVE_READINESS,
  PERF_POLICY,
  PERF_SECONDS_PER_RUN,
  RISK_LIMITS,
  RISK_TIERING,
  TEST_SECONDS_BY_AREA,
  limitsOf,
  riskBand,
  tierFor,
} from '../../../src/shared/criteria.ts';
import type { Lane, Policy } from '../../../src/shared/criteria.ts';

const policies: Record<string, Record<string, Policy>> = {
  LIVE_READINESS,
  GATE_BUDGETS,
  TEST_SECONDS_BY_AREA,
  PERF_SECONDS_PER_RUN,
  PERF_POLICY,
  FLAKE_POLICY,
  RISK_TIERING,
};
const everyEntry = Object.entries(policies).flatMap(([set, entries]) =>
  Object.entries(entries).map(([key, policy]) => ({ id: `${set}.${key}`, policy })),
);

/** P(X >= k) for X ~ Binomial(n, p). */
function atLeast(k: number, n: number, p: number): number {
  let below = 0;
  let coefficient = 1;
  for (let i = 0; i < k; i++) {
    below += coefficient * p ** i * (1 - p) ** (n - i);
    coefficient = (coefficient * (n - i)) / (i + 1);
  }
  return 1 - below;
}
const percent = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;

describe('PB-LAB-007 policy constants: every number says where it comes from', () => {
  it.each(everyEntry.map((e) => [e.id, e.policy] as const))('%s is complete', (_id, policy) => {
    expect(policy.label.trim()).not.toBe('');
    expect(policy.measure.trim()).not.toBe('');
    expect(policy.basis.text.trim().length).toBeGreaterThan(20);
    expect(Number.isFinite(policy.value)).toBe(true);
    expect(policy.value).toBeGreaterThanOrEqual(0);
    // Facts and arithmetic are checked below; an assumption has to be labelled as one, not dressed up as a measurement.
    expect(['fact', 'arithmetic', 'assumption', 'measured']).toContain(policy.basis.kind);
    if (policy.basis.kind === 'measured') expect(policy.basis.text).toMatch(/docs\/results\//);
  });

  it('keeps the units in line with the values', () => {
    for (const { id, policy } of everyEntry) {
      if (policy.unit === 'ratio') expect(policy.value, id).toBeLessThanOrEqual(1);
      if (['ms', 's', 'min', 'days', 'count', 'score', 'MB'].includes(policy.unit)) {
        expect(Number.isInteger(policy.value), id).toBe(true);
      }
    }
  });

  it('exposes the plain numbers of a policy', () => {
    expect(limitsOf({ a: LIVE_READINESS.startMaxMs })).toStrictEqual({ a: 5000 });
    expect(LIVE_LIMITS.latencyMaxMs).toBe(LIVE_READINESS.latencyMaxMs.value);
    expect(GATE_LIMITS.mergeJobSec).toBe(480);
    expect(FLAKE_LIMITS.windowRuns).toBe(30);
    expect(RISK_LIMITS.mergeMinScore).toBe(15);
  });
});

describe('PB-LAB-007 policy facts mirror their sources', () => {
  const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

  it('copies the live simulation defaults of docs/CONTRACTS.md', () => {
    const contracts = read('docs/CONTRACTS.md');
    const defaults =
      /Defaults: (\d+) s segments, `windowSegments` (\d+) \((\d+) s DVR\), `presentationDelaySec` (\d+)/.exec(
        contracts,
      );
    expect(defaults, 'the "Live simulation" defaults line of CONTRACTS.md').not.toBeNull();
    expect(LIVE_FACTS.segmentSec).toBe(Number(defaults?.[1]));
    expect(LIVE_FACTS.windowSegments).toBe(Number(defaults?.[2]));
    expect(LIVE_FACTS.segmentSec * LIVE_FACTS.windowSegments).toBe(Number(defaults?.[3]));
    expect(LIVE_FACTS.presentationDelaySec).toBe(Number(defaults?.[4]));

    expect(LIVE_FACTS.manifestUpdatePeriodSec).toBe(
      Number(/minimumUpdatePeriod="PT(\d+)S"/.exec(contracts)?.[1]),
    );
    expect(LIVE_FACTS.sourceLoopSec).toBe(Number(/\| (\d+) s source looped forever/.exec(contracts)?.[1]));
  });

  it('copies the Playwright configuration the budgets are sized for', () => {
    const config = read('playwright.config.ts');
    expect(GATE_LIMITS.ciRetries).toBe(Number(/retries: process\.env\.CI \? (\d+) : \d+/.exec(config)?.[1]));
    expect(GATE_LIMITS.ciWorkers).toBe(
      Number(
        /workers: process\.env\.PB_WORKERS \? Number\(process\.env\.PB_WORKERS\) : process\.env\.CI \? (\d+) : \d+/.exec(
          config,
        )?.[1],
      ),
    );
    expect(GATE_LIMITS.testTimeoutSec * 1000).toBe(
      Number(/^ {2}timeout: ([\d_]+),/m.exec(config)?.[1]?.replaceAll('_', '')),
    );
  });

  it('copies the run count of ADR-004', () => {
    const adr = read('docs/DESIGN_DECISIONS.md');
    expect(GATE_LIMITS.perfRunsPerScenario).toBe(Number(/runs N times \(default (\d+)\)/.exec(adr)?.[1]));
  });
});

describe('PB-LAB-007 live readiness: the limits follow from the stream arithmetic', () => {
  const L = LIVE_LIMITS;
  const segmentMs = LIVE_FACTS.segmentSec * 1000;

  it('orders the latency limits as target < p95 < maximum, one segment apart', () => {
    expect(L.latencyTargetMs).toBe(LIVE_FACTS.presentationDelaySec * 1000);
    expect(L.latencyP95MaxMs - L.latencyTargetMs).toBe(segmentMs);
    expect(L.latencyMaxMs - L.latencyP95MaxMs).toBe(segmentMs);
  });

  it('injects a stall longer than the presentation delay, so the buffer must drain', () => {
    expect(L.injectedStallMs).toBeGreaterThan(LIVE_FACTS.presentationDelaySec * 1000);
    expect(L.stallRecoveryMaxMs).toBe(L.injectedStallMs + 2 * segmentMs);
    expect(L.latencyRestoreMaxMs).toBeGreaterThan(L.stallRecoveryMaxMs);
  });

  it('brackets the advertised manifest period between the median floor and the longest gap', () => {
    expect(L.manifestPeriodMs).toBe(LIVE_FACTS.manifestUpdatePeriodSec * 1000);
    expect(L.manifestMedianGapMinMs).toBeLessThan(L.manifestPeriodMs);
    expect(L.manifestMaxGapMs).toBeGreaterThan(L.manifestPeriodMs);
  });

  it('runs a soak long enough to turn the window over and loop the source several times', () => {
    const windowSec = LIVE_FACTS.segmentSec * LIVE_FACTS.windowSegments;
    for (const minutes of [L.soakMinutesCi, L.soakMinutesRelease]) {
      expect((minutes * 60) / windowSec).toBeGreaterThanOrEqual(5);
      expect((minutes * 60) / LIVE_FACTS.sourceLoopSec).toBeGreaterThanOrEqual(5);
    }
    expect(L.soakMinutesRelease).toBeGreaterThan(L.soakMinutesCi);
    // Drift and the rebuffer ratio are judged after the warm-up, so the warm-up must leave most of the shortest soak.
    expect(L.warmupSec).toBeLessThan((L.soakMinutesCi * 60) / 2);
  });

  it('keeps the soak limits sane: zero hangs, a small ratio, drift below one segment', () => {
    expect(L.maxUnrecoveredStalls).toBe(0);
    expect(L.maxCriticalErrors).toBe(0);
    expect(L.maxRebufferRatio).toBeGreaterThan(0);
    expect(L.maxRebufferRatio).toBeLessThan(0.05);
    expect(L.maxDroppedFrameRatio).toBeLessThan(0.1);
    expect(L.maxLatencyDriftMs).toBeLessThan(segmentMs);
  });

  it('quotes in its texts the numbers it computes', () => {
    const ci = LIVE_READINESS.soakMinutesCi.basis.text;
    expect(ci).toContain(`${L.soakMinutesCi * 60} s`);
    expect(LIVE_READINESS.soakMinutesRelease.basis.text).toContain(`${L.soakMinutesRelease * 60} s`);
    // 0.5%: 1.5 s of stall in the 5-minute soak, 9 s in the 30-minute one.
    expect(L.maxRebufferRatio * L.soakMinutesCi * 60).toBeCloseTo(1.5, 10);
    expect(L.maxRebufferRatio * L.soakMinutesRelease * 60).toBeCloseTo(9, 10);
  });
});

describe('PB-LAB-007 gate budgets: the arithmetic of the ceiling', () => {
  const G = GATE_LIMITS;

  it('adds a failure allowance of one timeout and its retry', () => {
    expect(G.failureAllowanceSec).toBe(G.testTimeoutSec * (1 + G.ciRetries));
  });

  it('derives the merge ceiling from the merge budget, as the text says', () => {
    const wall = G.mergeJobSec - G.jobSetupSec - G.failureAllowanceSec;
    expect(G.maxMergeTestsPerEngine).toBe(Math.floor((wall * G.ciWorkers) / G.averageTestSec));
    expect(G.maxMergeTestsPerEngine).toBe(30);
    expect(GATE_BUDGETS.maxMergeTestsPerEngine.basis.text).toContain(
      `(${G.mergeJobSec} - ${G.jobSetupSec} - ${G.failureAllowanceSec}) x ${G.ciWorkers} / ${G.averageTestSec}`,
    );
  });

  it('keeps the budgets in order: static and unit < merge < performance < release browser job', () => {
    expect(G.staticAndUnitSec).toBeLessThan(G.mergeJobSec);
    expect(G.mergeJobSec).toBeLessThan(G.perfJobSec);
    expect(G.perfJobSec).toBeLessThan(G.releaseE2eJobSec);
  });

  it('states the budgets of the strategy: 4 minutes, 8 minutes, 12 minutes', () => {
    expect(G.staticAndUnitSec).toBe(4 * 60);
    expect(G.mergeJobSec).toBe(8 * 60);
    expect(G.perfJobSec).toBe(12 * 60);
  });

  it('mirrors the Playwright configuration it copies', () => {
    expect(G.ciWorkers).toBe(2);
    expect(G.testTimeoutSec).toBe(45);
    expect(G.ciRetries).toBe(1);
  });

  it('allows a re-measure of one scenario: at least the slowest scenario of N runs', () => {
    const slowest =
      Math.max(...Object.values(PERF_SECONDS_PER_RUN).map((p) => p.value)) * G.perfRunsPerScenario;
    expect(G.perfRemeasureSec).toBeGreaterThanOrEqual(slowest);
    expect(GATE_BUDGETS.perfRemeasureSec.basis.text).toContain(`${slowest} s`);
  });

  it('gives every catalog area that runs browser tests an estimate', () => {
    for (const area of ['VOD', 'ABR', 'LIVE', 'REC', 'ENV', 'EME'])
      expect(TEST_SECONDS_BY_AREA).toHaveProperty(area);
    expect(G.cpuSlowdown).toBeGreaterThan(1);
    expect(G.cpuSlowdown).toBeLessThan(4);
  });
});

describe('PB-LAB-007 flake policy: the binomial arithmetic it quotes is right', () => {
  const F = FLAKE_LIMITS;

  it('puts the trigger between one and two flaky outcomes in a full window', () => {
    expect(1 / F.windowRuns).toBeLessThanOrEqual(F.quarantineTriggerRate);
    expect(2 / F.windowRuns).toBeGreaterThan(F.quarantineTriggerRate);
    // Below the minimum a single flaky outcome already exceeds the trigger or sits right on it.
    expect(1 / (F.minRunsToJudge - 1)).toBeGreaterThanOrEqual(F.quarantineTriggerRate);
    expect(F.minRunsToJudge).toBeLessThanOrEqual(F.windowRuns);
  });

  it('quotes the right chance that a healthy or a flaky test is caught in a window', () => {
    const windowText = FLAKE_POLICY.windowRuns.basis.text;
    expect(windowText).toContain(percent(atLeast(2, F.windowRuns, 0.01)));
    const triggerText = FLAKE_POLICY.quarantineTriggerRate.basis.text;
    for (const p of [0.05, 0.1, 0.2]) {
      expect(triggerText).toContain(`${Math.round(atLeast(2, F.windowRuns, p) * 100)}%`);
    }
  });

  it('quotes the right chance that a merge job needs a retry', () => {
    const jobText = FLAKE_POLICY.suiteBudgetRate.basis.text;
    for (const p of [0.01, 0.02]) expect(jobText).toContain(`${Math.round(atLeast(1, 15, p) * 100)}%`);
  });

  it('keeps the rates and ages in a sane order', () => {
    expect(F.suiteBudgetRate).toBeGreaterThan(0);
    expect(F.suiteBudgetRate).toBeLessThan(F.quarantineTriggerRate);
    expect(F.mergeQuarantineMaxAgeDays).toBeLessThan(F.quarantineMaxAgeDays);
  });
});

describe('PB-LAB-007 risk tiering: the rule that decides a tier', () => {
  it('has the thresholds the strategy states', () => {
    expect(RISK_LIMITS.mergeMinScore).toBe(15);
    expect(RISK_LIMITS.releaseMinScore).toBe(8);
    expect(RISK_TIERING.mergeMinScore.basis.text).toContain('15 = 3 x 5');
  });

  it.each([
    [25, 'merge'],
    [20, 'merge'],
    [16, 'merge'],
    [15, 'merge'],
    [14, 'release'],
    [12, 'release'],
    [8, 'release'],
    [7, 'exploratory'],
    [1, 'exploratory'],
  ] as const)('puts a score of %i in the %s band', (score, band) => {
    expect(riskBand(score)).toBe(band);
  });

  it('gives a tier to a score in each lane, by score or by cost', () => {
    const cases: Array<[number, Lane, 'merge' | 'release' | null]> = [
      [15, 'e2e', 'merge'],
      [14, 'e2e', 'release'],
      [8, 'e2e', 'release'],
      [7, 'e2e', null],
      [16, 'perf', 'merge'],
      [12, 'perf', 'release'],
      // Cost lanes: a unit test always gates a merge, a readiness or A/B run only a release, whatever the score.
      [8, 'unit', 'merge'],
      [25, 'unit', 'merge'],
      [20, 'live', 'release'],
      [8, 'live', 'release'],
      [16, 'ab', 'release'],
      // Below the line nothing is automated, in any lane.
      [4, 'unit', null],
      [7, 'live', null],
    ];
    for (const [score, lane, tier] of cases) expect(tierFor(score, lane), `${score} in ${lane}`).toBe(tier);
  });

  it('decides every lane', () => {
    expect(Object.keys(LANE_TIER).sort()).toStrictEqual(['ab', 'e2e', 'live', 'perf', 'unit']);
  });
});
