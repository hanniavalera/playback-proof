import { describe, expect, it } from 'vitest';
import { decide, failureGuard, readMetric, sessionsNeeded } from '../../../ab/decision.ts';
import type { DecisionInput, FailureEvidence, MetricEvidence } from '../../../ab/decision.ts';

// The decision rule over synthetic outcomes: every branch, and the edges of every strict inequality. The numbers are chosen so that each
// reading can be checked by eye against the rule at the top of ab/decision.ts.

const startup = (over: Partial<MetricEvidence> = {}): MetricEvidence => ({
  id: 'startupMs',
  label: 'Startup time',
  unit: 'ms',
  direction: 'lower-is-better',
  threshold: 100,
  effect: 0,
  ciLow: -50,
  ciHigh: 50,
  pAdjusted: 0.5,
  nA: 30,
  nB: 30,
  level: 0.95,
  ...over,
});

const share = (over: Partial<MetricEvidence> = {}): MetricEvidence => ({
  id: 'rebufferShare',
  label: 'Share of sessions with a rebuffer',
  unit: 'share',
  direction: 'lower-is-better',
  threshold: 0.2,
  effect: 0,
  ciLow: -0.1,
  ciHigh: 0.1,
  pAdjusted: 0.5,
  nA: 30,
  nB: 30,
  level: 0.95,
  ...over,
});

const noFailures: FailureEvidence = {
  attemptedA: 30,
  attemptedB: 30,
  failedA: 0,
  failedB: 0,
  fisherP: 1,
  maxShare: 0.1,
};

const run = (
  metrics: MetricEvidence[],
  failures: FailureEvidence = noFailures,
  alpha = 0.05,
): ReturnType<typeof decide> => decide({ alpha, metrics, failures } satisfies DecisionInput);

/** B clearly better: the whole interval is beyond -100 ms and the adjusted p is below alpha. */
const clearlyBetter = (): MetricEvidence =>
  startup({ effect: -150, ciLow: -220, ciHigh: -110, pAdjusted: 0.001 });
/** B clearly worse: beyond +100 ms with an interval that excludes zero. */
const clearlyWorse = (): MetricEvidence => startup({ effect: 150, ciLow: 60, ciHigh: 240, pAdjusted: 0.002 });

describe('PB-AB decision rule: each outcome', () => {
  it('ships B when it is better beyond the threshold, significantly, and not worse anywhere', () => {
    const decision = run([clearlyBetter()]);
    expect(decision.outcome).toBe('ship-b');
    expect(decision.headline).toBe('Ship B');
    expect(decision.reason).toMatch(
      /^Ship B: Startup time is -150 ms for B against A \(95 % interval -220 ms to -110 ms\)/,
    );
    expect(decision.reason).toContain('entirely beyond the 100 ms threshold');
    expect(decision.reason).toContain('adjusted p of 0.0010');
    expect(decision.moreSessions).toBeNull();
  });

  it('does not ship B when it is worse beyond the threshold with an interval that excludes zero', () => {
    const decision = run([clearlyWorse()]);
    expect(decision.outcome).toBe('do-not-ship-b');
    expect(decision.reason).toMatch(/^Do not ship B: Startup time is \+150 ms/);
    expect(decision.reason).toContain('worse than the 100 ms threshold, and the interval excludes zero');
  });

  it('says no difference when the whole interval lies inside the threshold: that is a finding, not a failure to find one', () => {
    const decision = run([startup({ effect: 12, ciLow: -40, ciHigh: 70, pAdjusted: 0.6 })]);
    expect(decision.outcome).toBe('no-difference');
    expect(decision.headline).toBe('No difference that matters (keep A)');
    expect(decision.reason).toContain('every primary interval lies inside its threshold');
    expect(decision.reason).toContain('-40 ms to +70 ms within ±100 ms');
  });

  it('says it cannot tell when the interval straddles the threshold, and how many sessions would settle it', () => {
    const decision = run([startup({ effect: -80, ciLow: -190, ciHigh: 30, pAdjusted: 0.2 })]);
    expect(decision.outcome).toBe('inconclusive');
    expect(decision.headline).toBe('Inconclusive: cannot tell (keep A)');
    expect(decision.reason).toContain('reaches the threshold of ±100 ms');
    expect(decision.reason).toContain('cannot rule out a difference that matters, and does not show one');
    // point -80 is inside the band: it needs the interval inside it, room = 100 - 80 = 20 ms, half-width 110 ms: 30 x (110 / 20)^2 = 907.5.
    expect(decision.moreSessions?.perMetric).toStrictEqual([
      { id: 'startupMs', needs: 'equivalent', resolved: false, perArm: 908 },
    ]);
    expect(decision.moreSessions?.perArm).toBe(908);
  });
});

describe('PB-AB decision rule: two primary metrics', () => {
  it('B better on one and worse on the other beyond its threshold: do not ship B, naming the benefit it does not buy', () => {
    const worseShare = share({ effect: 0.3, ciLow: 0.05, ciHigh: 0.5, pAdjusted: 0.03 });
    const decision = run([clearlyBetter(), worseShare]);
    expect(decision.outcome).toBe('do-not-ship-b');
    expect(decision.reason).toContain('Share of sessions with a rebuffer is +30 pp');
    expect(decision.reason).toContain('although B is better on startupMs');
  });

  it('B better on one and equivalent on the other: ship B', () => {
    const equivalentShare = share({ effect: 0.02, ciLow: -0.08, ciHigh: 0.12 });
    expect(run([clearlyBetter(), equivalentShare]).outcome).toBe('ship-b');
  });

  it('B better on one and not shown harmless on the other (interval reaches past its threshold): inconclusive, not ship', () => {
    const unknownShare = share({ effect: 0.05, ciLow: -0.1, ciHigh: 0.25, pAdjusted: 0.5 });
    const decision = run([clearlyBetter(), unknownShare]);
    expect(decision.outcome).toBe('inconclusive');
    expect(decision.reason).toContain('B is better on startupMs');
    expect(decision.reason).toContain('does not rule out a harm beyond its 20 % threshold');
  });

  it('B worse than the threshold by its point estimate but with an interval that includes zero: not harmful, so inconclusive', () => {
    const decision = run([share({ effect: 0.25, ciLow: -0.05, ciHigh: 0.5, pAdjusted: 0.2 })]);
    expect(decision.outcome).toBe('inconclusive');
    expect(decision.readings[0]).toMatchObject({ harmful: false, harmless: false, equivalent: false });
  });

  it('every primary metric equivalent: no difference; one not equivalent: inconclusive', () => {
    const quietShare = share({ effect: 0, ciLow: -0.1, ciHigh: 0.1 });
    expect(run([startup(), quietShare]).outcome).toBe('no-difference');
    expect(run([startup(), share({ effect: 0.1, ciLow: -0.1, ciHigh: 0.3 })]).outcome).toBe('inconclusive');
  });

  it('a metric that is better and one that is equivalent can sit beside a harmful third: harm wins', () => {
    const longRebuffer = startup({
      id: 'rebufferMs',
      label: 'Rebuffer duration',
      effect: 400,
      ciLow: 150,
      ciHigh: 700,
    });
    const decision = run([clearlyBetter(), longRebuffer, share()]);
    expect(decision.outcome).toBe('do-not-ship-b');
    expect(decision.reason).toContain('Rebuffer duration');
  });
});

describe('PB-AB decision rule: the edges of every inequality (all of them strict)', () => {
  it('adjusted p just below alpha ships B, exactly alpha or just above it does not', () => {
    expect(run([startup({ effect: -150, ciLow: -220, ciHigh: -110, pAdjusted: 0.0499 })]).outcome).toBe(
      'ship-b',
    );
    const atAlpha = run([startup({ effect: -150, ciLow: -220, ciHigh: -110, pAdjusted: 0.05 })]);
    expect(atAlpha.outcome).toBe('inconclusive');
    expect(atAlpha.reason).toContain(
      "beyond the threshold in B's favour, but the adjusted p of 0.050 is not below 0.05",
    );
    expect(run([startup({ effect: -150, ciLow: -220, ciHigh: -110, pAdjusted: 0.0501 })]).outcome).toBe(
      'inconclusive',
    );
  });

  it('an interval whose worse end is exactly the threshold is not beyond it', () => {
    expect(run([startup({ effect: -150, ciLow: -220, ciHigh: -100, pAdjusted: 0.001 })]).outcome).toBe(
      'inconclusive',
    );
    expect(run([startup({ effect: -150, ciLow: -220, ciHigh: -100.0001, pAdjusted: 0.001 })]).outcome).toBe(
      'ship-b',
    );
  });

  it('a point estimate exactly on the threshold is not worse than it; one hair above, with the interval above zero, is', () => {
    expect(run([startup({ effect: 100, ciLow: 20, ciHigh: 180 })]).outcome).toBe('inconclusive');
    expect(run([startup({ effect: 100.0001, ciLow: 20, ciHigh: 180 })]).outcome).toBe('do-not-ship-b');
  });

  it('an interval that just touches zero does not exclude it, so a point beyond the threshold is not yet a harm', () => {
    expect(run([startup({ effect: 150, ciLow: 0, ciHigh: 300 })]).readings[0]?.harmful).toBe(false);
    expect(run([startup({ effect: 150, ciLow: 0.001, ciHigh: 300 })]).readings[0]?.harmful).toBe(true);
  });

  it('an interval ending exactly on the threshold is not inside it: not equivalent', () => {
    expect(run([startup({ effect: 0, ciLow: -100, ciHigh: 50 })]).outcome).toBe('inconclusive');
    expect(run([startup({ effect: 0, ciLow: -99.9, ciHigh: 99.9 })]).outcome).toBe('no-difference');
    expect(run([startup({ effect: 0, ciLow: -50, ciHigh: 100 })]).readings[0]?.harmless).toBe(false);
  });

  it('an interval that straddles the threshold from inside is inconclusive whichever end it crosses', () => {
    expect(run([startup({ effect: 60, ciLow: -10, ciHigh: 130 })]).outcome).toBe('inconclusive');
    expect(run([startup({ effect: -60, ciLow: -130, ciHigh: 10 })]).outcome).toBe('inconclusive');
  });
});

describe('PB-AB decision rule: direction, failed sessions and missing data', () => {
  it('reads a higher-is-better metric the other way round: a rise is the benefit', () => {
    const better = decide({
      alpha: 0.05,
      failures: noFailures,
      metrics: [
        startup({ direction: 'higher-is-better', effect: 150, ciLow: 110, ciHigh: 220, pAdjusted: 0.001 }),
      ],
    });
    expect(better.outcome).toBe('ship-b');
    const worse = decide({
      alpha: 0.05,
      failures: noFailures,
      metrics: [
        startup({ direction: 'higher-is-better', effect: -150, ciLow: -240, ciHigh: -60, pAdjusted: 0.001 }),
      ],
    });
    expect(worse.outcome).toBe('do-not-ship-b');
  });

  it('a failure guard stops ship B and no difference, but not do not ship B', () => {
    const tooMany: FailureEvidence = {
      attemptedA: 30,
      attemptedB: 30,
      failedA: 1,
      failedB: 4,
      fisherP: 0.35,
      maxShare: 0.1,
    };
    const stopped = run([clearlyBetter()], tooMany);
    expect(stopped.outcome).toBe('inconclusive');
    expect(stopped.failureGuardTripped).toBe(true);
    expect(stopped.reason).toContain(
      '4 of 30 of B failed, above the pre-registered maximum of 10 % of an arm',
    );
    expect(run([startup()], tooMany).outcome).toBe('inconclusive');
    expect(run([clearlyWorse()], tooMany).outcome).toBe('do-not-ship-b');
  });

  it('the arms failing differently trips the guard even when each is under the maximum', () => {
    const uneven: FailureEvidence = {
      attemptedA: 100,
      attemptedB: 100,
      failedA: 0,
      failedB: 8,
      fisherP: 0.007,
      maxShare: 0.1,
    };
    const decision = run([clearlyBetter()], uneven);
    expect(decision.failureGuardTripped).toBe(true);
    expect(decision.reason).toContain('the arms failed differently');
    expect(failureGuard({ ...uneven, fisherP: 0.05 }, 0.05).tripped).toBe(false);
    expect(failureGuard({ ...uneven, fisherP: 0.0499 }, 0.05).tripped).toBe(true);
    expect(failureGuard({ ...uneven, failedB: 10, fisherP: 1 }, 0.05).tripped).toBe(false);
    expect(failureGuard({ ...uneven, failedB: 11, fisherP: 1 }, 0.05).tripped).toBe(true);
  });

  it('with fewer than two analysed sessions in an arm nothing can be said', () => {
    const decision = run([startup({ nA: 1 })]);
    expect(decision.outcome).toBe('inconclusive');
    expect(decision.reason).toContain('startupMs has fewer than two analysed sessions in an arm');
    expect(decision.moreSessions).toBeNull();
    expect(readMetric(startup({ nB: 0 }), 0.05)).toMatchObject({
      available: false,
      better: false,
      harmful: false,
      equivalent: false,
    });
  });
});

describe('PB-AB decision rule: how many more sessions', () => {
  it('extrapolates from the half-width: the harm to be confirmed, the benefit to be shown, the equivalence to be shown', () => {
    // harmful needs the better end above 0: point 150, half-width 170, 30 x (170 / 150)^2 = 38.5.
    const harmful = startup({ effect: 150, ciLow: -20, ciHigh: 320, pAdjusted: 0.2 });
    expect(sessionsNeeded(harmful, readMetric(harmful, 0.05))).toStrictEqual({
      id: 'startupMs',
      needs: 'harmful',
      resolved: false,
      perArm: 39,
    });
    // better needs the worse end below -d: point -150, room 50, half-width 120: 30 x (120 / 50)^2 = 172.8.
    const better = startup({ effect: -150, ciLow: -260, ciHigh: -20, pAdjusted: 0.04 });
    expect(sessionsNeeded(better, readMetric(better, 0.05))).toStrictEqual({
      id: 'startupMs',
      needs: 'better',
      resolved: false,
      perArm: 173,
    });
  });

  it('is the largest of the unresolved metrics, and null when an estimate sits on the edge where no number of sessions helps', () => {
    const slow = startup({ effect: -80, ciLow: -190, ciHigh: 30 });
    // Numbers that are exact in binary (multiples of 1/8), so that the arithmetic of the extrapolation has no rounding to argue about:
    // point 0.125 inside a band of 0.25 leaves room 0.125; half-width 0.25; 30 x (0.25 / 0.125)^2 = 120.
    const quick = share({ threshold: 0.25, effect: 0.125, ciLow: -0.125, ciHigh: 0.375 });
    const both = run([slow, quick]).moreSessions;
    expect(both?.perMetric.map((entry) => entry.perArm)).toStrictEqual([908, 120]);
    expect(both?.perArm).toBe(908);
    const onTheEdge = run([startup({ effect: 100, ciLow: -40, ciHigh: 240 })]).moreSessions;
    expect(onTheEdge?.perMetric[0]).toMatchObject({ needs: 'equivalent', perArm: null });
    expect(onTheEdge?.perArm).toBeNull();
  });

  it('a metric that is already resolved asks for nothing more', () => {
    const resolved = sessionsNeeded(clearlyBetter(), readMetric(clearlyBetter(), 0.05));
    expect(resolved).toMatchObject({ needs: 'better', resolved: true, perArm: 30 });
  });
});

describe('PB-AB decision rule: what the report is given to print', () => {
  it('lists the rule step by step with the numbers of this run, and one sentence per metric', () => {
    const decision = run([clearlyBetter(), share()]);
    expect(decision.steps).toHaveLength(4);
    expect(decision.steps[0]).toBe(
      '1. Harm (worse than the threshold with an interval that excludes zero): none.',
    );
    expect(decision.steps[1]).toContain('Benefit (adjusted p < 0.05');
    expect(decision.steps[1]).toContain('startupMs');
    expect(decision.steps[3]).toBe('4. Failed sessions: 0 of 60 failed, guard not tripped.');
    expect(decision.readings.map((reading) => reading.sentence)).toStrictEqual([
      expect.stringContaining(
        'Startup time: B minus A is -150 ms (95 % interval -220 ms to -110 ms), threshold 100 ms, adjusted p = 0.0010: better',
      ),
      expect.stringContaining(
        'Share of sessions with a rebuffer: B minus A is 0 pp (95 % interval -10 pp to +10 pp), threshold 20 %',
      ),
    ]);
  });

  it('puts every metric on one scale: a better metric has a negative point, a worse one a positive point', () => {
    const [reading] = run([clearlyWorse()]).readings;
    expect(reading).toMatchObject({
      point: 150,
      best: 60,
      worst: 240,
      threshold: 100,
      harmful: true,
      better: false,
    });
  });
});
