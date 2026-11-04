import { describe, expect, it } from 'vitest';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import {
  MIN_DRIFT_SPAN_MS,
  evaluateCriticalErrors,
  evaluateDroppedFrames,
  evaluateHeapGrowth,
  evaluateLatencyDrift,
  evaluateRebufferRatio,
  evaluateSoak,
  evaluateSoakLength,
  evaluateUnexplainedErrors,
  evaluateUnrecoveredStalls,
  soakKind,
  unrecoveredStalls,
} from '../../../src/lab/readiness/soak-evaluators.ts';
import { decimate } from '../../../src/lab/readiness/series.ts';
import { aggregate } from '../../../src/lab/readiness/verdict.ts';
import type { Evaluation } from '../../../src/lab/readiness/verdict.ts';
import { mulberry32, normal } from './random.ts';
import { at, episode, error, fault, heapSeries, soak } from './soak-fixtures.ts';

// The soak evaluators decide whether a build survives its own length. Each is checked against the series a defect makes (a leak, a drift,
// a hung player), against the series a healthy run makes (which must pass, noise included), and against the inputs that must not pass for
// the wrong reason: nothing measured, a run too short to judge, a step that an outage left, a high level that is not a trend.

const get = (evaluations: readonly Evaluation[], id: string): Evaluation => {
  const found = evaluations.find((evaluation) => evaluation.id === id);
  if (!found) throw new Error(`no evaluation ${id} in ${evaluations.map((e) => e.id).join(', ')}`);
  return found;
};

describe('a healthy soak', () => {
  it('is GO on every criterion of the row, in the CI length, with a heap that is flat', () => {
    const result = evaluateSoak(soak());
    expect(result.kind).toBe('ci');
    expect(result.verdict).toBe('GO');
    for (const id of [
      'soak.stalls',
      'soak.critical-errors',
      'soak.unexplained-errors',
      'soak.rebuffer-ratio',
      'soak.latency-drift',
      'soak.heap-growth',
      'soak.dropped-frames',
    ]) {
      expect(get(result.evaluations, id).verdict, id).toBe('GO');
    }
    expect(get(result.evaluations, 'soak.latency-drift').value).toBeCloseTo(0, 6);
    expect(get(result.evaluations, 'soak.dropped-frames').value).toBe(0);
  });

  it('is not made a NO-GO by scatter in the latency reads: 300 seeds, one verdict', () => {
    // 100 ms of noise on a flat 6.2 s, 5 minutes with a 60 s warm-up: the standard error of the fitted change is about 40 ms.
    const verdicts = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const noise = normal(mulberry32(seed), 100);
      const drift = evaluateLatencyDrift(soak({ latency: () => 6200 + noise() }));
      verdicts.add(drift.verdict);
      expect(drift.value).toBeLessThan(400);
    }
    expect([...verdicts]).toEqual(['GO']);
  });

  it('reports the advisory lines without letting them decide', () => {
    const result = evaluateSoak(soak({ latency: () => 10_100 }));
    // 10.1 s is above the latency maximum (an advisory here: PB-RDY-002 judges it), and it is flat: not a drift.
    expect(get(result.evaluations, 'soak.latency-max').verdict).toBe('NO-GO');
    expect(get(result.evaluations, 'soak.latency-max').scope).toBe('advisory');
    expect(get(result.evaluations, 'soak.latency-drift').verdict).toBe('GO');
    expect(result.verdict).toBe('GO');
  });
});

describe('latency drift', () => {
  const ramp = (changeMsOverAfterWarmup: number) => (sec: number) =>
    6200 + (changeMsOverAfterWarmup * Math.max(0, sec - 60)) / 240;

  it('reads a flat series at any level as no drift: the level is the intercept, not the trend', () => {
    for (const level of [6200, 10_100, 14_000]) {
      const drift = evaluateLatencyDrift(soak({ latency: () => level }));
      expect(drift.value).toBeCloseTo(0, 6);
      expect(drift.verdict).toBe('GO');
      const stretch = (drift.detail?.stretches as Array<{ levelAtStartMs: number }>)[0];
      expect(stretch?.levelAtStartMs).toBeCloseTo(level, 6);
    }
  });

  it('calls a climb a drift, with the slope in ms per hour and the sign of the trend', () => {
    const up = evaluateLatencyDrift(soak({ latency: ramp(3000) }));
    expect(up.verdict).toBe('NO-GO');
    expect(up.value).toBeCloseTo(3000, 3);
    // 3 s over 240 s is 45,000 ms per hour.
    expect(up.detail?.slopeMsPerHour).toBeCloseTo(45_000, 0);
    expect(up.sentence).toContain('+45,000 ms/h');
    const down = evaluateLatencyDrift(soak({ latency: ramp(-3000) }));
    expect(down.verdict).toBe('NO-GO');
    expect(down.detail?.slopeMsPerHour).toBeCloseTo(-45_000, 0);
  });

  it('holds the fitted change to the limit exactly: at it is within, a little over it is not', () => {
    const limit = LIVE_LIMITS.maxLatencyDriftMs;
    expect(evaluateLatencyDrift(soak({ latency: ramp(limit - 1) })).verdict).toBe('GO');
    expect(evaluateLatencyDrift(soak({ latency: ramp(limit + 20) })).verdict).toBe('NO-GO');
  });

  it('is not moved by one wild read: a 30 s spike in a 5-minute soak does not make a drift', () => {
    const drift = evaluateLatencyDrift(soak({ latency: (sec) => (sec === 200 ? 30_000 : 6200) }));
    expect(drift.verdict).toBe('GO');
  });

  it('does not read the step an injected outage leaves as a slope, and would if the fault were not declared', () => {
    const stalled = (sec: number): number => (sec < 120 ? 6200 : 10_100);
    const declared = evaluateLatencyDrift(soak({ minutes: 8, latency: stalled, faults: [fault(120, 10)] }));
    expect(declared.verdict).toBe('GO');
    expect(declared.value).toBeCloseTo(0, 6);
    const stretches = declared.detail?.stretches as Array<{ levelAtStartMs: number }>;
    expect(stretches).toHaveLength(2);
    expect(stretches[0]?.levelAtStartMs).toBeCloseTo(6200, 6);
    expect(stretches[1]?.levelAtStartMs).toBeCloseTo(10_100, 6);
    const hidden = evaluateLatencyDrift(soak({ minutes: 8, latency: stalled }));
    expect(hidden.verdict).toBe('NO-GO');
  });

  it("keeps the player's catch-up after an outage out of the fit: the ramp back to the edge is the settling the policy allows", () => {
    // Back at 10.6 s when the origin returns at 130 s, then 0.1 s of latency per second down to 7 s (live sync at a rate of 1.1).
    const catchUp = (sec: number): number =>
      sec < 120 ? 6200 : sec < 130 ? 8000 : Math.max(7000, 10_600 - (sec - 130) * 100);
    const drift = evaluateLatencyDrift(soak({ minutes: 8, latency: catchUp, faults: [fault(120, 10)] }));
    expect(drift.verdict).toBe('GO');
  });

  it('still sees a drift that goes on after an outage', () => {
    const slow = (sec: number): number => (sec < 120 ? 6200 : 10_100 + (sec - 120) * 20);
    const drift = evaluateLatencyDrift(soak({ minutes: 12, latency: slow, faults: [fault(120, 10)] }));
    expect(drift.verdict).toBe('NO-GO');
    // 20 ms per second is 72,000 ms/h.
    expect(drift.detail?.slopeMsPerHour as number).toBeGreaterThan(60_000);
  });

  it('cannot judge from too little: a soak with no samples, no latency, or less than two fault-free minutes after the warm-up', () => {
    expect(evaluateLatencyDrift(soak({ latency: () => null })).verdict).toBe('INCONCLUSIVE');
    expect(evaluateLatencyDrift({ ...soak(), samples: [] }).verdict).toBe('INCONCLUSIVE');
    const short = evaluateLatencyDrift(soak({ minutes: 1, warmupSec: 15, latency: ramp(0) }));
    expect(short.verdict).toBe('INCONCLUSIVE');
    expect(short.sentence).toContain('cannot be judged');
    expect(MIN_DRIFT_SPAN_MS).toBe(120_000);
    const justEnough = evaluateLatencyDrift(soak({ minutes: 3.5, warmupSec: 60 }));
    expect(justEnough.verdict).toBe('GO');
  });
});

describe('JS heap growth', () => {
  const climbing = (mbPerSec: number) => heapSeries(5, 30, (sec) => 14 + mbPerSec * Math.max(0, sec - 60));

  it('is N/A where the engine cannot force a collection, and says so', () => {
    const line = evaluateHeapGrowth(soak({ engine: 'firefox' }));
    expect(line.verdict).toBe('N/A');
    expect(line.sentence).toContain('only Chromium');
    expect(aggregate([line])).toBe('INCONCLUSIVE');
    expect(evaluateSoak(soak({ engine: 'webkit' })).verdict).toBe('GO');
  });

  it('is GO for a heap that sawtooths around a level, and NO-GO for one that climbs', () => {
    const saw = heapSeries(5, 30, (sec) => 14 + ((sec / 30) % 2 === 0 ? 1.5 : -1.5));
    expect(evaluateHeapGrowth(soak({ heap: saw })).verdict).toBe('GO');
    const leak = evaluateHeapGrowth(soak({ heap: climbing(0.2) }));
    expect(leak.verdict).toBe('NO-GO');
    expect(leak.value).toBeGreaterThan(30);
    // The trend of the series, in MB per hour, is in the evidence so that a steady climb can be told from one step.
    expect(leak.detail?.trendMbPerHour as number).toBeGreaterThan(500);
  });

  it('holds the growth to its limit exactly', () => {
    const limit = LIVE_LIMITS.maxHeapGrowthMb;
    const held = (extra: number) => heapSeries(5, 30, (sec) => (sec < 150 ? 14 : 14 + extra));
    expect(evaluateHeapGrowth(soak({ heap: held(limit) })).verdict).toBe('GO');
    expect(evaluateHeapGrowth(soak({ heap: held(limit + 0.5) })).verdict).toBe('NO-GO');
  });

  it('does not take one reading for the end: the median of the last readings is the end, so a single peak is not a leak', () => {
    const peak = heapSeries(5, 30, (sec) => (sec < 300 ? 14 : 14 + LIVE_LIMITS.maxHeapGrowthMb + 15));
    expect(evaluateHeapGrowth(soak({ heap: peak })).verdict).toBe('GO');
  });

  it('measures from the end of the warm-up, not from the start: what the player allocates while it starts is not a leak', () => {
    const startup = heapSeries(5, 30, (sec) => (sec < 60 ? 5 + sec / 3 : 25));
    expect(evaluateHeapGrowth(soak({ heap: startup })).verdict).toBe('GO');
  });

  it('needs enough readings after the warm-up to say anything', () => {
    const few = heapSeries(5, 30, () => 14).filter((read) => read.atMs < at(60 + 60));
    expect(evaluateHeapGrowth(soak({ heap: few })).verdict).toBe('INCONCLUSIVE');
  });
});

describe('unrecovered stalls', () => {
  it('lets the injected outage stall the player for the 4 s it really costs, and counts nothing', () => {
    const lines = evaluateUnrecoveredStalls(soak({ episodes: [episode(130, 4)], faults: [fault(120, 10)] }));
    expect(lines.verdict).toBe('GO');
    expect(lines.value).toBe(0);
    expect(lines.sentence).toContain('1 stall');
  });

  it('holds a stall to the recovery limit exactly', () => {
    const limit = LIVE_LIMITS.stallRecoveryMaxMs / 1000;
    expect(evaluateUnrecoveredStalls(soak({ episodes: [episode(150, limit)] })).verdict).toBe('GO');
    expect(evaluateUnrecoveredStalls(soak({ episodes: [episode(150, limit + 0.001)] })).verdict).toBe(
      'NO-GO',
    );
  });

  it('counts a stall that never ended, whatever its length so far', () => {
    const lines = evaluateUnrecoveredStalls(soak({ episodes: [episode(295, 5, true)] }));
    expect(lines.verdict).toBe('NO-GO');
    expect(lines.sentence).toContain('never ended');
  });

  it("sees a hung player that the hook's episodes miss, from the media clock that stopped", () => {
    const base = soak();
    // The clock stands at 150 s from t = 150 to t = 180 and the hook recorded no episode (a stall that began inside the player's own seek).
    const frozen = {
      ...base,
      samples: base.samples.map((sample) =>
        sample.atMs >= at(150) && sample.atMs <= at(180) ? { ...sample, mediaTime: 150 } : sample,
      ),
    };
    const lines = evaluateUnrecoveredStalls(frozen);
    expect(lines.verdict).toBe('NO-GO');
    expect(lines.sentence).toContain('media clock that stood at 150.0 s for 30.00 s');
  });

  it('merges the two witnesses of one stall into one, and does not mistake a paused player for a hung one', () => {
    const base = soak();
    const stalled = base.samples.map((sample) =>
      sample.atMs >= at(150) && sample.atMs <= at(180)
        ? { ...sample, mediaTime: 150, state: 'buffering' }
        : sample,
    );
    expect(unrecoveredStalls([episode(150, 30)], stalled)).toHaveLength(1);
    const paused = base.samples.map((sample) =>
      sample.atMs >= at(150) && sample.atMs <= at(200)
        ? { ...sample, mediaTime: 150, state: 'paused' }
        : sample,
    );
    expect(unrecoveredStalls([], paused)).toHaveLength(0);
  });
});

describe('errors', () => {
  it('fails the soak on a critical error, inside an injected fault or not', () => {
    expect(evaluateCriticalErrors(soak({ errors: [error(130, 2)], faults: [fault(120, 10)] })).verdict).toBe(
      'NO-GO',
    );
    expect(evaluateCriticalErrors(soak({ errors: [error(130, 1)] })).verdict).toBe('GO');
  });

  it('fails the soak on an error that no injected fault explains, and accepts one inside the stall it belongs to', () => {
    const faults = [fault(120, 10)];
    expect(evaluateUnexplainedErrors(soak({ errors: [error(100, 1)], faults })).verdict).toBe('NO-GO');
    expect(evaluateUnexplainedErrors(soak({ errors: [error(125, 1)], faults })).verdict).toBe('GO');
    // The player is given the stall-recovery limit after the origin returns to get going again: an error in that tail is the fault's.
    const tail = 130 + LIVE_LIMITS.stallRecoveryMaxMs / 1000;
    expect(evaluateUnexplainedErrors(soak({ errors: [error(tail - 1, 1)], faults })).verdict).toBe('GO');
    expect(evaluateUnexplainedErrors(soak({ errors: [error(tail + 1, 1)], faults })).verdict).toBe('NO-GO');
    expect(evaluateUnexplainedErrors(soak({ errors: [error(100, 1, 'HTTP_ERROR')] })).sentence).toContain(
      'HTTP_ERROR',
    );
  });
});

describe('rebuffer ratio', () => {
  it('is the stall time outside the faults over the time observed outside them, after the warm-up', () => {
    // 2.4 s of stall in the 240 s after the warm-up is exactly 1 %: above the 0.5 % limit.
    const line = evaluateRebufferRatio(soak({ episodes: [episode(100, 2.4)] }));
    expect(line.value).toBeCloseTo(0.01, 9);
    expect(line.verdict).toBe('NO-GO');
  });

  it('holds the ratio to the limit exactly', () => {
    const stalledSec = 240 * LIVE_LIMITS.maxRebufferRatio;
    expect(evaluateRebufferRatio(soak({ episodes: [episode(100, stalledSec)] })).verdict).toBe('GO');
    expect(evaluateRebufferRatio(soak({ episodes: [episode(100, stalledSec + 0.1)] })).verdict).toBe('NO-GO');
  });

  it('leaves out the injected outage, its recovery, and whatever happened during the warm-up', () => {
    const line = evaluateRebufferRatio(
      soak({ episodes: [episode(30, 8), episode(130, 4)], faults: [fault(120, 10)] }),
    );
    expect(line.value).toBe(0);
    expect(line.verdict).toBe('GO');
    expect(line.detail?.episodesInWarmupOrExplained).toBe(2);
    // The time of the fault is taken out of what was observed, too.
    expect(line.detail?.observedMs).toBe(240_000 - (10_000 + LIVE_LIMITS.stallRecoveryMaxMs));
  });

  it('counts a stall that began outside every fault even if it lasted into one', () => {
    const line = evaluateRebufferRatio(soak({ episodes: [episode(110, 12)], faults: [fault(120, 10)] }));
    expect(line.detail?.episodesCounted).toBe(1);
    expect(line.verdict).toBe('NO-GO');
  });

  it('cannot judge when nothing was observed after the warm-up', () => {
    expect(evaluateRebufferRatio(soak({ minutes: 1, warmupSec: 60 })).verdict).toBe('INCONCLUSIVE');
  });
});

describe('dropped frames', () => {
  it('holds the ratio to the limit exactly and cannot judge a page that decoded nothing', () => {
    const limit = LIVE_LIMITS.maxDroppedFrameRatio;
    expect(
      evaluateDroppedFrames(soak({ frames: { decoded: 10_000, dropped: 10_000 * limit } })).verdict,
    ).toBe('GO');
    expect(
      evaluateDroppedFrames(soak({ frames: { decoded: 10_000, dropped: 10_000 * limit + 1 } })).verdict,
    ).toBe('NO-GO');
    expect(evaluateDroppedFrames(soak({ frames: { decoded: 0, dropped: 0 } })).verdict).toBe('INCONCLUSIVE');
    expect(evaluateDroppedFrames(soak({ frames: null })).verdict).toBe('INCONCLUSIVE');
  });
});

describe('the length of the soak', () => {
  it('names the policy length a run meets, and refuses to certify a shorter one', () => {
    expect(soakKind(LIVE_LIMITS.soakMinutesRelease)).toBe('release');
    expect(soakKind(LIVE_LIMITS.soakMinutesCi)).toBe('ci');
    expect(soakKind(LIVE_LIMITS.soakMinutesCi - 0.01)).toBe('short');
    const short = evaluateSoak(soak({ minutes: 1, warmupSec: 15 }));
    expect(short.kind).toBe('short');
    expect(short.verdict).toBe('INCONCLUSIVE');
    expect(evaluateSoakLength(soak({ minutes: 1 })).sentence).toContain('not a verdict');
    expect(evaluateSoakLength(soak({ minutes: 30 })).sentence).toContain('release soak');
  });

  it('is still a NO-GO when a short soak finds a defect: a defect found is a defect', () => {
    const result = evaluateSoak(soak({ minutes: 2, warmupSec: 15, errors: [error(60, 2)] }));
    expect(result.kind).toBe('short');
    expect(result.verdict).toBe('NO-GO');
  });
});

describe('an empty soak', () => {
  it('is INCONCLUSIVE and does not crash on any evaluator', () => {
    const empty = {
      ...soak({ minutes: 0 }),
      samples: [],
      episodes: [],
      errors: [],
      frames: null,
      heap: [],
      manifestArrivalsMs: [],
    };
    const result = evaluateSoak(empty);
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(get(result.evaluations, 'soak.latency-drift').verdict).toBe('INCONCLUSIVE');
    expect(get(result.evaluations, 'soak.heap-growth').verdict).toBe('INCONCLUSIVE');
  });
});

describe('decimate', () => {
  const points = Array.from({ length: 2000 }, (_, i) => ({
    i,
    v: i === 1234 ? 30_000 : i === 777 ? -5 : 6200 + (i % 7),
  }));

  it('keeps the first, the last and the spikes, in order, within the size asked for', () => {
    const kept = decimate(points, 300, (p) => p.v);
    expect(kept.length).toBeLessThanOrEqual(300);
    expect(kept[0]).toBe(points[0]);
    expect(kept.at(-1)).toBe(points.at(-1));
    expect(kept.some((p) => p.v === 30_000)).toBe(true);
    expect(kept.some((p) => p.v === -5)).toBe(true);
    expect(kept.map((p) => p.i)).toEqual([...kept.map((p) => p.i)].sort((a, b) => a - b));
  });

  it('returns a short series whole, and keeps a reading-less stretch visible', () => {
    expect(decimate(points.slice(0, 10), 300, (p) => p.v)).toHaveLength(10);
    const empty = Array.from({ length: 100 }, (_, i) => ({ i }));
    expect(decimate(empty, 20, () => null).length).toBeGreaterThanOrEqual(2);
    expect(() => decimate(points, 1, (p) => p.v)).toThrow(RangeError);
  });
});
