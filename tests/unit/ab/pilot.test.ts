import { describe, expect, it } from 'vitest';
import { analyzePilot, renderPilot } from '../../../ab/pilot.ts';
import { aaPrereg, rebufferPrereg } from './fixtures.ts';
import { generator } from './helpers.ts';
import { aaPool, buildRaw, interleaved, startupOnly } from './synthetic.ts';

// The power analysis of a pilot, end to end on a synthetic pool of A: that it asks the right questions of the right sessions, and that what it
// reports is on the scale of the metric. The estimates themselves are checked against theory in power.test.ts.

const textOf = (plan: object): string => `${JSON.stringify(plan, null, 2)}\n`;
const rules = [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }] as never;
const SMALL = { simulations: 40, seed: 11 };

describe('PB-AB pilot analysis', () => {
  const aa = buildRaw(
    { text: textOf(aaPrereg()), conditionId: 'high-latency', rules },
    aaPool(generator(7), 40),
  );

  it('reports, for the primary metric, what the pilot looked like and what the design can find', () => {
    const analysis = analyzePilot(aa, SMALL);
    expect(analysis).toMatchObject({
      experiment: 'PB-AB-001-high-latency',
      condition: 'high-latency',
      sessionsPerArm: 30,
      pilotSessions: 40,
    });
    const [startup, ...rest] = analysis.metrics;
    expect(rest).toStrictEqual([]);
    expect(startup).toMatchObject({ id: 'startupMs', pilotSessions: 40, threshold: 100, pilotShare: null });
    // Right-skewed startup around 900 ms with a spread of about a quarter of it.
    expect(startup?.pilotMedian).toBeGreaterThan(700);
    expect(startup?.pilotMedian).toBeLessThan(1100);
    expect(startup?.mde.mde).toBeGreaterThan(80);
    expect(startup?.mde.mde).toBeLessThan(300);
    // The threshold of 100 ms is below what 30 per arm can find with this spread, so more sessions are needed.
    expect(startup?.sessionsForThreshold).toBeGreaterThan(30);
    expect(startup?.curve.map((point) => point.shift)).toStrictEqual([0, 100, 200]);
    expect(startup?.verdicts).not.toBeNull();
  });

  it('describes a share of sessions as a share, and asks for a metric by name', () => {
    const plan = rebufferPrereg();
    const raw = buildRaw(
      {
        text: textOf(plan),
        conditionId: 'bandwidth-drop',
        rules: [{ type: 'throttle', kbps: 600, afterMs: 8000 }],
      },
      aaPool(generator(8), 40),
    );
    const analysis = analyzePilot(raw, { ...SMALL, metrics: ['rebufferShare'] });
    const [share] = analysis.metrics;
    expect(share?.id).toBe('rebufferShare');
    expect(share?.pilotShare).toBeGreaterThan(0.1);
    expect(share?.pilotShare).toBeLessThan(0.5);
    expect(share?.pilotMedian).toBeNull();
    // Both directions are searched; the share can rise by 0.2 to 0.7 and be found with 30 sessions per arm.
    expect(share?.mde.sides.map((side) => side.direction)).toStrictEqual(['increase', 'decrease']);
    const rise = share?.mde.sides[0]?.mde as number;
    expect(rise).toBeGreaterThan(0.15);
    expect(rise).toBeLessThan(0.7);
    expect(share?.threshold).toBe(0.2);
  });

  it('renders a table in the units of the metric, with what the design can say about the three situations that matter', () => {
    const text = renderPilot(analyzePilot(aa, SMALL));
    expect(text).toContain('# Power of PB-AB-001-high-latency under high-latency');
    expect(text).toContain('Minimum detectable effect (30 per arm, 80 % power)');
    expect(text).toMatch(/\| Startup time \| 40 \|/);
    expect(text).toContain('100 ms');
    expect(text).toContain('Refuses B when B is worse by the threshold');
  });

  it('refuses what cannot be a pilot: sessions of configuration B, an unknown metric, a condition that was not run, a handful of sessions', () => {
    const experiment = buildRaw(
      { text: textOf(aaPrereg()), conditionId: 'high-latency', rules },
      interleaved(startupOnly([900, 950, 1000, 1050]), startupOnly([850, 900, 930, 980])),
    );
    expect(() => analyzePilot(experiment, SMALL)).toThrow(/a pilot is made of configuration A/);
    expect(() => analyzePilot(aa, { ...SMALL, metrics: ['bogus'] })).toThrow(/unknown metric bogus/);
    expect(() => analyzePilot(aa, { ...SMALL, condition: 'elsewhere' })).toThrow(/no condition "elsewhere"/);
    const few = buildRaw(
      { text: textOf(aaPrereg()), conditionId: 'high-latency', rules },
      aaPool(generator(9), 8),
    );
    expect(() => analyzePilot(few, SMALL)).toThrow(/at least 10 are needed/);
  });

  it('takes the sessions of A out of a file that holds both arms when it is told to', () => {
    const mixed = buildRaw(
      { text: textOf(aaPrereg()), conditionId: 'high-latency', rules },
      interleaved(
        Array.from({ length: 20 }, (_, i) => ({ startupMs: 900 + 13 * i })),
        Array.from({ length: 20 }, (_, i) => ({ startupMs: 1400 + 13 * i })),
      ),
    );
    const analysis = analyzePilot(mixed, { ...SMALL, onlyA: true });
    expect(analysis.pilotSessions).toBe(20);
    expect(analysis.metrics[0]?.pilotMedian).toBeLessThan(1100);
  });
});
