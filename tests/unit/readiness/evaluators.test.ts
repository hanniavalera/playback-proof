import { describe, expect, it } from 'vitest';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import {
  MIN_CADENCE_GAPS,
  MIN_LATENCY_SAMPLES,
  RELATIVE_TOLERANCE_MS,
  RESTORE_HOLD_MS,
  evaluateLatencyWindow,
  evaluateManifestCadence,
  evaluateStallRecovery,
  evaluateStart,
  gapsOf,
  restoreOf,
  restoreRelativeOf,
} from '../../../src/lab/readiness/evaluators.ts';
import type {
  JoinSample,
  LatencyPoint,
  RestoreSample,
  StallRun,
} from '../../../src/lab/readiness/evaluators.ts';
import { aggregate, judge } from '../../../src/lab/readiness/verdict.ts';
import type { Evaluation } from '../../../src/lab/readiness/verdict.ts';

// The evaluators decide GO or NO-GO, so every one is checked at its limit (the limit itself is within it, a step over is not), with the
// series a real run produces (the recovery numbers are those of docs/decisions/e2e-rec.md) and with the inputs that must not pass:
// nothing measured, too little measured, and a fault that never reached the player.

const byId = (evaluations: readonly Evaluation[], id: string): Evaluation => {
  const found = evaluations.find((evaluation) => evaluation.id === id);
  if (!found) throw new Error(`no evaluation ${id} in ${evaluations.map((e) => e.id).join(', ')}`);
  return found;
};

describe('judge and aggregate', () => {
  it('holds a value exactly at the limit within it, and one step beyond it outside', () => {
    expect(judge(5000, 5000, 'at-most')).toBe('GO');
    expect(judge(5001, 5000, 'at-most')).toBe('NO-GO');
    expect(judge(1000, 1000, 'at-least')).toBe('GO');
    expect(judge(999, 1000, 'at-least')).toBe('NO-GO');
  });

  it('lets a NO-GO win over an INCONCLUSIVE, an INCONCLUSIVE over a GO, and ignores advisory lines', () => {
    const line = (verdict: Evaluation['verdict'], scope: Evaluation['scope'] = 'criterion'): Evaluation => ({
      id: 'x',
      check: 'PB-RDY-001',
      label: 'x',
      value: 1,
      unit: 'ms',
      limit: 1,
      bound: 'at-most',
      limitKey: 'startMaxMs',
      verdict,
      sentence: '',
      scope,
    });
    expect(aggregate([line('GO'), line('NO-GO'), line('INCONCLUSIVE')])).toBe('NO-GO');
    expect(aggregate([line('GO'), line('INCONCLUSIVE')])).toBe('INCONCLUSIVE');
    expect(aggregate([line('GO'), line('N/A')])).toBe('GO');
    expect(aggregate([line('GO'), line('NO-GO', 'advisory')])).toBe('GO');
    expect(aggregate([])).toBe('INCONCLUSIVE');
    expect(aggregate([line('N/A')])).toBe('INCONCLUSIVE');
  });
});

describe('PB-RDY-001: the start of fresh joins', () => {
  const joins = (...startups: Array<number | null>): JoinSample[] =>
    startups.map((startupMs, i) => ({
      join: i + 1,
      startupMs,
      ...(startupMs === null ? { failure: 'qa.waitFor(firstframe) timed out after 15000 ms' } : {}),
    }));

  it('judges the worst join against the start limit, and names it', () => {
    const [worst, p95] = evaluateStart(joins(640, 700, 655, 1280, 702));
    expect(worst?.value).toBe(1280);
    expect(worst?.limit).toBe(LIVE_LIMITS.startMaxMs);
    expect(worst?.verdict).toBe('GO');
    expect(worst?.sentence).toContain('join 4');
    expect(worst?.sentence).toContain('1.28 s');
    expect(p95?.scope).toBe('advisory');
    expect(p95?.value).toBeGreaterThan(702);
    expect(p95?.value).toBeLessThanOrEqual(1280);
  });

  it('accepts a join at the limit and refuses one a millisecond over it', () => {
    const limit = LIVE_LIMITS.startMaxMs;
    expect(byId(evaluateStart(joins(100, 100, 100, 100, limit)), 'start.worst').verdict).toBe('GO');
    expect(byId(evaluateStart(joins(100, 100, 100, 100, limit + 1)), 'start.worst').verdict).toBe('NO-GO');
  });

  it('is a NO-GO when any join never presented a frame, whatever the others did, and says why', () => {
    const lines = evaluateStart(joins(500, 500, null, 500, 500));
    const worst = byId(lines, 'start.worst');
    expect(worst.verdict).toBe('NO-GO');
    expect(worst.sentence).toContain('join 3');
    expect(worst.sentence).toContain('timed out');
    expect(aggregate(lines)).toBe('NO-GO');
  });

  it('cannot judge with fewer joins than the criterion asks for, or with none', () => {
    expect(byId(evaluateStart(joins(500, 500, 500)), 'start.worst').verdict).toBe('INCONCLUSIVE');
    expect(byId(evaluateStart([]), 'start.worst').verdict).toBe('INCONCLUSIVE');
    expect(aggregate(evaluateStart(joins(500, 500, 500)))).toBe('INCONCLUSIVE');
  });

  it('reads its limits from the limits it is given, not from a number of its own', () => {
    const strict = { ...LIVE_LIMITS, startMaxMs: 700 };
    expect(byId(evaluateStart(joins(640, 700, 655, 701, 702), strict), 'start.worst').verdict).toBe('NO-GO');
    expect(byId(evaluateStart(joins(640, 700, 655, 690, 650), strict), 'start.worst').verdict).toBe('GO');
  });
});

describe('PB-RDY-002: latency over a window', () => {
  const reads = (n: number, latency: (i: number) => number | null): LatencyPoint[] =>
    Array.from({ length: n }, (_, i) => ({ mediaTime: 10 + i, latencyMs: latency(i) }));

  it('is GO for a steady 6.2 s with both limits quoted', () => {
    const lines = evaluateLatencyWindow({ samples: reads(60, () => 6200), playerMaxMs: 6310 });
    expect(byId(lines, 'latency.p95').value).toBe(6200);
    expect(byId(lines, 'latency.p95').limit).toBe(LIVE_LIMITS.latencyP95MaxMs);
    expect(byId(lines, 'latency.max').value).toBe(6310);
    expect(aggregate(lines)).toBe('GO');
  });

  it('holds the p95 and the maximum to their own limits, each at the boundary', () => {
    const p95Limit = LIVE_LIMITS.latencyP95MaxMs;
    const maxLimit = LIVE_LIMITS.latencyMaxMs;
    const at = evaluateLatencyWindow({ samples: reads(60, () => p95Limit) });
    expect(byId(at, 'latency.p95').verdict).toBe('GO');
    const over = evaluateLatencyWindow({ samples: reads(60, () => p95Limit + 1) });
    expect(byId(over, 'latency.p95').verdict).toBe('NO-GO');
    expect(byId(over, 'latency.max').verdict).toBe('GO');
    const maxAt = evaluateLatencyWindow({ samples: reads(60, (i) => (i === 59 ? maxLimit : 6200)) });
    expect(byId(maxAt, 'latency.max').verdict).toBe('GO');
    const maxOver = evaluateLatencyWindow({ samples: reads(60, (i) => (i === 59 ? maxLimit + 1 : 6200)) });
    expect(byId(maxOver, 'latency.max').verdict).toBe('NO-GO');
    expect(byId(maxOver, 'latency.p95').verdict).toBe('GO');
  });

  it('does not let one read hide a slow tail: a tenth of the window at 8.5 s fails the p95 though the maximum is fine', () => {
    const lines = evaluateLatencyWindow({ samples: reads(60, (i) => (i % 10 === 9 ? 8500 : 6200)) });
    expect(byId(lines, 'latency.p95').verdict).toBe('NO-GO');
    expect(byId(lines, 'latency.max').verdict).toBe('GO');
  });

  it("takes the player's own maximum into account: a spike between two reads is still a maximum", () => {
    const lines = evaluateLatencyWindow({ samples: reads(60, () => 6200), playerMaxMs: 10_400 });
    expect(byId(lines, 'latency.max').value).toBe(10_400);
    expect(byId(lines, 'latency.max').verdict).toBe('NO-GO');
    expect(byId(lines, 'latency.p95').verdict).toBe('GO');
  });

  it('cannot judge a percentile from a handful of reads, nor from reads that measured nothing', () => {
    const few = evaluateLatencyWindow({ samples: reads(MIN_LATENCY_SAMPLES - 1, () => 6200) });
    expect(aggregate(few)).toBe('INCONCLUSIVE');
    expect(byId(few, 'latency.p95').sentence).toContain('needed to judge');
    const nothing = evaluateLatencyWindow({ samples: reads(60, () => null) });
    expect(aggregate(nothing)).toBe('INCONCLUSIVE');
    expect(byId(nothing, 'latency.p95').value).toBeNull();
    const some = evaluateLatencyWindow({ samples: reads(60, (i) => (i < 30 ? null : 6200)) });
    expect(byId(some, 'latency.p95').detail?.unreadSamples).toBe(30);
    expect(aggregate(some)).toBe('GO');
  });
});

describe('PB-RDY-003: stall recovery', () => {
  const OBSERVED_MS = LIVE_LIMITS.latencyRestoreMaxMs + RESTORE_HOLD_MS;
  const reads = (
    latency: (sinceResumeMs: number) => number,
    rate = (_: number): number => 1,
  ): RestoreSample[] =>
    Array.from({ length: OBSERVED_MS / 1000 + 1 }, (_, second) => {
      const sinceResumeMs = second * 1000;
      return { sinceResumeMs, latencyMs: latency(sinceResumeMs), playbackRate: rate(sinceResumeMs) };
    });
  const run = (overrides: Partial<StallRun> = {}): StallRun => ({
    run: 1,
    stalled: true,
    recoveryMs: 3900,
    waitedMs: null,
    latencyBeforeMs: 6200,
    after: reads(() => 10_120),
    observedMs: OBSERVED_MS,
    ...overrides,
  });

  it('is the finding of docs/decisions/e2e-rec.md: the defaults recover, in 3.9 s, and latency never comes back', () => {
    const lines = evaluateStallRecovery([
      run(),
      run({ run: 2, recoveryMs: 4400 }),
      run({ run: 3, recoveryMs: 3600 }),
    ]);
    const recovery = byId(lines, 'stall.recovery');
    expect(recovery.verdict).toBe('GO');
    expect(recovery.value).toBe(4400);
    const restore = byId(lines, 'stall.restore');
    expect(restore.verdict).toBe('NO-GO');
    expect(restore.censored).toBe(true);
    expect(restore.value).toBe(OBSERVED_MS);
    expect(restore.sentence).toContain('not back within 10.00 s');
    expect(restore.sentence).toContain('10.12 s');
    expect(restore.sentence).toContain('3.92 s further behind');
    expect(aggregate(lines)).toBe('NO-GO');
  });

  it('shows GO for a candidate that really catches up, and says it raised its playback rate to do it', () => {
    // Latency falls 0.1 s each second at rate 1.1 (live sync) from 10.6 s: back under 10 s after 6 s, and it stays.
    const catchUp = reads(
      (t) => Math.max(7000, 10_600 - t / 10),
      (t) => (10_600 - t / 10 > 7000 ? 1.1 : 1),
    );
    const lines = evaluateStallRecovery([
      run({ after: catchUp, recoveryMs: 4000 }),
      run({ run: 2, after: catchUp }),
    ]);
    const restore = byId(lines, 'stall.restore');
    expect(restore.verdict).toBe('GO');
    expect(restore.value).toBe(6000);
    expect(restore.sentence).toContain('playback rate to 1.10');
    expect(aggregate(lines)).toBe('GO');
  });

  it('holds recovery to the stall limit and restoration to its own limit, each exactly at the boundary', () => {
    expect(
      byId(evaluateStallRecovery([run({ recoveryMs: LIVE_LIMITS.stallRecoveryMaxMs })]), 'stall.recovery')
        .verdict,
    ).toBe('GO');
    expect(
      byId(evaluateStallRecovery([run({ recoveryMs: LIVE_LIMITS.stallRecoveryMaxMs + 1 })]), 'stall.recovery')
        .verdict,
    ).toBe('NO-GO');
    const restoredAt = (ms: number): StallRun => run({ after: reads((t) => (t >= ms ? 7000 : 10_500)) });
    expect(
      byId(evaluateStallRecovery([restoredAt(LIVE_LIMITS.latencyRestoreMaxMs)]), 'stall.restore').verdict,
    ).toBe('GO');
    expect(
      byId(evaluateStallRecovery([restoredAt(LIVE_LIMITS.latencyRestoreMaxMs + 1000)]), 'stall.restore')
        .verdict,
    ).toBe('NO-GO');
  });

  it('judges the worst of the runs, not their mean', () => {
    const lines = evaluateStallRecovery([
      run({ recoveryMs: 3600 }),
      run({ run: 2, recoveryMs: 3800 }),
      run({ run: 3, recoveryMs: 15_200 }),
    ]);
    const recovery = byId(lines, 'stall.recovery');
    expect(recovery.value).toBe(15_200);
    expect(recovery.verdict).toBe('NO-GO');
  });

  it('does not call a single dip under the maximum a restoration, nor one that did not last the hold', () => {
    const dipped = run({ after: reads((t) => (t === 20_000 ? 9000 : 10_400)) });
    expect(restoreOf(dipped).restored).toBe(false);
    const lastMoment = run({ after: reads((t) => (t >= OBSERVED_MS - 3000 ? 9000 : 10_400)) });
    expect(restoreOf(lastMoment).restored).toBe(false);
    const held = run({ after: reads((t) => (t >= 30_000 ? 9000 : 10_400)) });
    expect(restoreOf(held)).toEqual({ restored: true, atMs: 30_000 });
  });

  it('counts a player whose latency never left the maximum as restored at the first read', () => {
    expect(restoreOf(run({ after: reads(() => 9500) }))).toEqual({ restored: true, atMs: 0 });
  });

  it('holds the latency to the maximum with the limit itself inside it: exactly 10 s is restored, a millisecond over is not', () => {
    const limit = LIVE_LIMITS.latencyMaxMs;
    expect(restoreOf(run({ after: reads(() => limit) })).restored).toBe(true);
    expect(restoreOf(run({ after: reads(() => limit + 1) })).restored).toBe(false);
  });

  it('refuses to judge a recovery that was never exercised: the outage did not stall the player', () => {
    const lines = evaluateStallRecovery([run({ stalled: false, recoveryMs: null, after: [] })]);
    expect(byId(lines, 'stall.recovery').verdict).toBe('INCONCLUSIVE');
    expect(byId(lines, 'stall.restore').verdict).toBe('INCONCLUSIVE');
    expect(byId(lines, 'stall.restore').sentence).toContain('did not make the player stall');
    expect(aggregate(lines)).toBe('INCONCLUSIVE');
    expect(aggregate(evaluateStallRecovery([]))).toBe('INCONCLUSIVE');
  });

  it('is a NO-GO when the player stalled and never resumed, and INCONCLUSIVE when it was not given the time the limit allows', () => {
    const hung = run({ recoveryMs: null, waitedMs: 30_000, after: [], observedMs: 0 });
    const lines = evaluateStallRecovery([hung]);
    expect(byId(lines, 'stall.recovery').verdict).toBe('NO-GO');
    expect(byId(lines, 'stall.recovery').censored).toBe(true);
    expect(byId(lines, 'stall.recovery').sentence).toContain('did not resume');
    const early = evaluateStallRecovery([
      run({ recoveryMs: null, waitedMs: 5000, after: [], observedMs: 0 }),
    ]);
    expect(byId(early, 'stall.recovery').verdict).toBe('INCONCLUSIVE');
  });

  it('does not call latency unrestored on an observation shorter than the time the limit allows', () => {
    const shortWatch = run({ after: reads(() => 10_400).slice(0, 21), observedMs: 20_000 });
    const lines = evaluateStallRecovery([shortWatch]);
    expect(byId(lines, 'stall.restore').verdict).toBe('INCONCLUSIVE');
  });

  describe('the relative reading, next to the absolute one', () => {
    it('is the same finding for the defaults, as an advisory line that does not decide: 4 s behind where it was, for good', () => {
      const lines = evaluateStallRecovery([run()]);
      const relative = byId(lines, 'stall.restore-relative');
      expect(relative.scope).toBe('advisory');
      expect(relative.verdict).toBe('NO-GO');
      expect(relative.censored).toBe(true);
      expect(relative.value).toBe(OBSERVED_MS);
      expect(relative.limitKey).toBe('latencyRestoreMaxMs');
      expect(relative.sentence).toContain('not back within 2.00 s of its own level before the outage');
      expect(relative.sentence).toContain('3.92 s further behind than before the outage (6.20 s)');
      expect(relative.note).toBeUndefined();
      expect(relative.detail).toMatchObject({ toleranceMs: RELATIVE_TOLERANCE_MS, holdMs: RESTORE_HOLD_MS });
    });

    it('is GO for a candidate that catches up, later than the absolute reading because it asks for more', () => {
      const catchUp = reads(
        (t) => Math.max(7000, 10_600 - t / 10),
        (t) => (10_600 - t / 10 > 7000 ? 1.1 : 1),
      );
      const lines = evaluateStallRecovery([run({ after: catchUp, recoveryMs: 4000 })]);
      expect(byId(lines, 'stall.restore').value).toBe(6000);
      // From 10.6 s at 0.1 s per second to 8.2 s (6.2 s and one segment): 24 s.
      const relative = byId(lines, 'stall.restore-relative');
      expect(relative.verdict).toBe('GO');
      expect(relative.value).toBe(24_000);
    });

    it('lets the verdict be the absolute one where the two readings disagree, and says so: 9.5 s is under the maximum and 3.5 s above where it was', () => {
      const lines = evaluateStallRecovery([run({ latencyBeforeMs: 6000, after: reads(() => 9500) })]);
      expect(byId(lines, 'stall.restore').verdict).toBe('GO');
      const relative = byId(lines, 'stall.restore-relative');
      expect(relative.verdict).toBe('NO-GO');
      expect(relative.note).toContain(
        'run 1 was back within the 10.00 s of the policy and not back within 2.00 s of its own level of 6.00 s',
      );
      expect(relative.note).toContain('the verdict is the absolute one');
      expect(aggregate(lines)).toBe('GO');
    });

    it('says so the other way round too: a session that sat high is within a segment of itself and still above the maximum', () => {
      const lines = evaluateStallRecovery([run({ latencyBeforeMs: 8500, after: reads(() => 10_400) })]);
      expect(byId(lines, 'stall.restore').verdict).toBe('NO-GO');
      const relative = byId(lines, 'stall.restore-relative');
      expect(relative.verdict).toBe('GO');
      expect(relative.note).toContain(
        'not back within the 10.00 s of the policy and back within 2.00 s of its own level of 8.50 s',
      );
      expect(aggregate(lines)).toBe('NO-GO');
    });

    it('holds its tolerance inclusive: exactly a segment above the level is back, a millisecond more is not', () => {
      const level = 6200;
      expect(
        restoreRelativeOf(run({ latencyBeforeMs: level, after: reads(() => level + RELATIVE_TOLERANCE_MS) }))
          ?.restored,
      ).toBe(true);
      expect(
        restoreRelativeOf(
          run({ latencyBeforeMs: level, after: reads(() => level + RELATIVE_TOLERANCE_MS + 1) }),
        )?.restored,
      ).toBe(false);
      expect(RELATIVE_TOLERANCE_MS).toBe(2000);
    });

    it('uses the tolerance it is given, and asks for the same hold as the absolute reading', () => {
      const lines = evaluateStallRecovery([run({ after: reads(() => 9000) })], LIVE_LIMITS, 3000);
      expect(byId(lines, 'stall.restore-relative').verdict).toBe('GO');
      const dipped = run({ after: reads((t) => (t === 20_000 ? 6500 : 10_100)) });
      expect(restoreRelativeOf(dipped)?.restored).toBe(false);
    });

    it('cannot hold a player to a level it was not seen at, and says so without touching the criterion', () => {
      const lines = evaluateStallRecovery([run({ latencyBeforeMs: null, after: reads(() => 7000) })]);
      const relative = byId(lines, 'stall.restore-relative');
      expect(relative.verdict).toBe('INCONCLUSIVE');
      expect(relative.value).toBeNull();
      expect(relative.sentence).toContain('was not read');
      expect(byId(lines, 'stall.restore').verdict).toBe('GO');
      expect(restoreRelativeOf(run({ latencyBeforeMs: null }))).toBeNull();
    });

    it('judges nothing when the outage never stalled the player, like the lines it sits next to', () => {
      const lines = evaluateStallRecovery([run({ stalled: false, recoveryMs: null, after: [] })]);
      expect(byId(lines, 'stall.restore-relative').verdict).toBe('INCONCLUSIVE');
    });
  });
});

describe('PB-RDY-004: the manifest cadence', () => {
  const every = (ms: number, n: number, from = 0): number[] =>
    Array.from({ length: n }, (_, i) => from + i * ms);

  it('is GO for the advertised two seconds', () => {
    const lines = evaluateManifestCadence(every(2000, 21));
    expect(byId(lines, 'cadence.median').value).toBe(2000);
    expect(byId(lines, 'cadence.longest').value).toBe(2000);
    expect(aggregate(lines)).toBe('GO');
    expect(byId(lines, 'cadence.median').limit).toBe(LIVE_LIMITS.manifestMedianGapMinMs);
    expect(byId(lines, 'cadence.longest').limit).toBe(LIVE_LIMITS.manifestMaxGapMs);
  });

  it('flags a player that polls twice as fast as advertised, and one that stopped tracking the window', () => {
    const hammering = evaluateManifestCadence(every(LIVE_LIMITS.manifestMedianGapMinMs - 1, 30));
    expect(byId(hammering, 'cadence.median').verdict).toBe('NO-GO');
    expect(byId(hammering, 'cadence.longest').verdict).toBe('GO');
    const gap = [...every(2000, 15), 28_000 + LIVE_LIMITS.manifestMaxGapMs + 1];
    const stopped = evaluateManifestCadence(gap);
    expect(byId(stopped, 'cadence.longest').verdict).toBe('NO-GO');
    expect(byId(stopped, 'cadence.median').verdict).toBe('GO');
  });

  it('holds both limits exactly at the boundary', () => {
    expect(
      byId(evaluateManifestCadence(every(LIVE_LIMITS.manifestMedianGapMinMs, 30)), 'cadence.median').verdict,
    ).toBe('GO');
    expect(
      byId(evaluateManifestCadence(every(LIVE_LIMITS.manifestMaxGapMs, 30)), 'cadence.longest').verdict,
    ).toBe('GO');
    expect(
      byId(evaluateManifestCadence(every(LIVE_LIMITS.manifestMaxGapMs + 1, 30)), 'cadence.longest').verdict,
    ).toBe('NO-GO');
  });

  it('leaves out the gaps that overlap an injected fault, also those that it only touches', () => {
    // Requests every 2 s up to 28 s, then nothing for 12 s (the origin was down), then every 2 s from 40 s.
    const arrivals = [...every(2000, 15), ...every(2000, 15, 40_000)];
    const withFault = evaluateManifestCadence(arrivals, []);
    expect(byId(withFault, 'cadence.longest').value).toBe(12_000);
    const excluded = evaluateManifestCadence(arrivals, [{ startMs: 29_000, endMs: 39_000 }]);
    expect(byId(excluded, 'cadence.longest').value).toBe(2000);
    expect(gapsOf(arrivals, [{ startMs: 29_000, endMs: 39_000 }])).not.toContain(12_000);
    // A window that covers only the end of the long gap and the start of the next one takes both gaps out: 12 s and 2 s, 27 left of 29.
    const touching = gapsOf(arrivals, [{ startMs: 35_000, endMs: 41_000 }]);
    expect(touching).not.toContain(12_000);
    expect(touching).toHaveLength(arrivals.length - 1 - 2);
    // A window in the middle of the regular requests takes out the gap around it and no other.
    expect(gapsOf(arrivals, [{ startMs: 9_000, endMs: 9_500 }])).toHaveLength(arrivals.length - 1 - 1);
    // A window that starts where the long gap ends does not take it: only the gaps after it are touched.
    const after = gapsOf(arrivals, [{ startMs: 40_000, endMs: 46_000 }]);
    expect(after).toContain(12_000);
    expect(after).toHaveLength(arrivals.length - 1 - 3);
    // A window that ends where the long gap starts does not take it either.
    expect(gapsOf(arrivals, [{ startMs: 20_000, endMs: 28_000 }])).toContain(12_000);
  });

  it('computes the gaps from requests in any order, by the time they arrived', () => {
    expect(gapsOf([6000, 0, 2000, 4000])).toEqual([2000, 2000, 2000]);
  });

  it('cannot judge a cadence from a few requests', () => {
    expect(aggregate(evaluateManifestCadence(every(2000, MIN_CADENCE_GAPS)))).toBe('INCONCLUSIVE');
    expect(aggregate(evaluateManifestCadence(every(2000, MIN_CADENCE_GAPS + 1)))).toBe('GO');
    expect(aggregate(evaluateManifestCadence([]))).toBe('INCONCLUSIVE');
  });
});
