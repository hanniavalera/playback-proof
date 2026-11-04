import { describe, expect, it } from 'vitest';
import {
  detectionPower,
  minimumDetectableEffect,
  powerCurve,
  sessionsForPower,
  simulatedArms,
  verdictRates,
} from '../../../ab/power.ts';
import { fisherExact } from '../../../ab/stats/fisher.ts';
import { gaussian, generator } from './helpers.ts';
import { shareMetric, startupMetric } from './synthetic.ts';

// Power by simulation, against what can be computed without simulating: the exact power of Fisher's test over two binomials, the known
// power of a two-sample test on normal data, and the properties that make the search for the minimum meaningful.

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

const binomialPmf = (k: number, n: number, p: number): number => choose(n, k) * p ** k * (1 - p) ** (n - k);

const fisherTable = new Map<string, number>();
function fisherP(n: number, x: number, y: number): number {
  const key = `${n}:${x}:${y}`;
  let p = fisherTable.get(key);
  if (p === undefined) {
    p = fisherExact({ events: x, total: n }, { events: y, total: n }).p;
    fisherTable.set(key, p);
  }
  return p;
}

/** The exact power of Fisher's test at alpha 0.05 for Bin(n, pA) against Bin(n, pB): every outcome, weighted by its probability. */
function exactFisherPower(n: number, pA: number, pB: number, alpha = 0.05): number {
  let power = 0;
  for (let x = 0; x <= n; x++) {
    for (let y = 0; y <= n; y++) {
      if (fisherP(n, x, y) < alpha) power += binomialPmf(x, n, pA) * binomialPmf(y, n, pB);
    }
  }
  return power;
}

const pilotShare = (ones: number, total: number): number[] => [
  ...Array<number>(ones).fill(1),
  ...Array<number>(total - ones).fill(0),
];
const pilotNormal = (seed: number, n: number, mean: number, sd: number): number[] =>
  gaussian(generator(seed), n, mean, sd);
const sd = (values: number[]): number => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
};

describe('PB-AB power: the simulated experiments', () => {
  const pilot = pilotNormal(1, 60, 1000, 100);

  it('draws arm A and the unshifted arm B from the pilot, and the shift only adds to B (the same draws for every shift)', () => {
    const none = simulatedArms(pilot, 'continuous', 0, 30, 5, 17);
    const shifted = simulatedArms(pilot, 'continuous', 80, 30, 5, 17);
    expect(shifted.a).toStrictEqual(none.a);
    shifted.b.forEach((value, i) => expect(value).toBeCloseTo((none.b[i] as number) + 80, 9));
    for (const value of none.a) expect(pilot).toContain(value);
    expect(simulatedArms(pilot, 'continuous', 0, 30, 5, 18).a).not.toStrictEqual(none.a);
    expect(simulatedArms(pilot, 'continuous', 0, 30, 6, 17).a).not.toStrictEqual(none.a);
  });

  it('for a share, moves B to p0 + shift by flipping sessions only in the direction of the shift', () => {
    const shares = pilotShare(12, 40); // p0 = 0.3
    const base = simulatedArms(shares, 'binary', 0, 200, 9, 1);
    const up = simulatedArms(shares, 'binary', 0.2, 200, 9, 1);
    const down = simulatedArms(shares, 'binary', -0.2, 200, 9, 1);
    expect(up.a).toStrictEqual(base.a);
    up.b.forEach((value, i) => expect(value).toBeGreaterThanOrEqual(base.b[i] as number));
    down.b.forEach((value, i) => expect(value).toBeLessThanOrEqual(base.b[i] as number));
    let ones = 0;
    let n = 0;
    for (let run = 0; run < 300; run++) {
      const { b } = simulatedArms(shares, 'binary', 0.2, 200, 9, run);
      ones += b.filter((value) => value === 1).length;
      n += b.length;
    }
    expect(ones / n).toBeGreaterThan(0.48);
    expect(ones / n).toBeLessThan(0.52);
  });
});

describe("PB-AB power: against the exact power of Fisher's test", () => {
  it.each([
    [12, 40, 0.3],
    [12, 40, 0.15],
    [6, 40, 0.2],
    [20, 40, 0.25],
  ] as const)(
    'a pilot of %i rebuffers in %i, B moved by +%d: the simulation matches the exact power within Monte Carlo error',
    (ones, total, shift) => {
      const p0 = ones / total;
      const estimate = detectionPower(pilotShare(ones, total), 'binary', shift, {
        sessionsPerArm: 30,
        simulations: 4000,
        seed: 3,
      });
      const exact = exactFisherPower(30, p0, p0 + shift);
      expect(Math.abs(estimate.power - exact)).toBeLessThan(0.03);
      expect(estimate.lower).toBeLessThanOrEqual(estimate.power);
      expect(estimate.upper).toBeGreaterThanOrEqual(estimate.power);
      expect(estimate.upper - estimate.lower).toBeLessThan(0.05);
    },
  );

  it('finds the minimum detectable effect of a pilot with no rebuffers where the exact power says it is (about a quarter of the sessions)', () => {
    const none = pilotShare(0, 40);
    const estimate = minimumDetectableEffect(none, 'binary', {
      sessionsPerArm: 30,
      simulations: 2000,
      seed: 4,
    });
    let exactMde = 0;
    for (let d = 0.001; d < 1; d += 0.001) {
      if (exactFisherPower(30, 0, d) >= 0.8) {
        exactMde = d;
        break;
      }
    }
    expect(exactMde).toBeGreaterThan(0.2);
    expect(estimate.mde).not.toBeNull();
    expect(Math.abs((estimate.mde as number) - exactMde)).toBeLessThan(0.04);
    // A share that is zero cannot fall: that side has no minimum, and says why, and does not stop the other from giving one.
    expect(estimate.sides.find((side) => side.direction === 'decrease')?.note).toContain('cannot move');
    expect(estimate.sides.find((side) => side.direction === 'increase')?.power).toBeGreaterThanOrEqual(0.78);
  });
});

describe('PB-AB power: normal data, where the answer is known', () => {
  const pilot = pilotNormal(2, 3000, 1000, 100);
  const sigma = sd(pilot);
  const design = { sessionsPerArm: 30, simulations: 1000, seed: 7 };

  it('has the false-positive rate of the test at no shift, and about the power of a two-sample test at 0.8 sigma', () => {
    expect(detectionPower(pilot, 'continuous', 0, design).power).toBeGreaterThan(0.03);
    expect(detectionPower(pilot, 'continuous', 0, design).power).toBeLessThan(0.075);
    // The t-test with 30 per arm and d = 0.8 has power 0.86; the rank test loses about 5 % of its efficiency on normal data.
    const power = detectionPower(pilot, 'continuous', 0.8 * sigma, design).power;
    expect(power).toBeGreaterThan(0.78);
    expect(power).toBeLessThan(0.93);
    expect(detectionPower(pilot, 'continuous', 3 * sigma, design).power).toBe(1);
  });

  it('puts the minimum detectable effect of 30 sessions per arm near 0.74 sigma, in either direction', () => {
    const estimate = minimumDetectableEffect(pilot, 'continuous', design);
    expect(estimate.mde).not.toBeNull();
    expect((estimate.mde as number) / sigma).toBeGreaterThan(0.62);
    expect((estimate.mde as number) / sigma).toBeLessThan(0.88);
    expect(estimate.sides.map((side) => side.direction)).toStrictEqual(['increase', 'decrease']);
    for (const side of estimate.sides) expect(side.power).toBeGreaterThanOrEqual(0.8);
    expect(estimate.degenerate).toBe(false);
    expect(estimate.targetPower).toBe(0.8);
  });

  it('has a power curve that does not fall as the shift grows (within a point of Monte Carlo noise)', () => {
    const curve = powerCurve(
      pilot,
      'continuous',
      [0, 0.25, 0.5, 0.75, 1, 1.5, 2].map((x) => x * sigma),
      design,
    );
    for (let i = 1; i < curve.length; i++)
      expect((curve[i]?.power as number) + 0.01).toBeGreaterThanOrEqual(curve[i - 1]?.power as number);
    expect(curve[0]?.power as number).toBeLessThan(0.1);
    expect(curve[6]?.power).toBeGreaterThan(0.99);
  });

  it('is reproducible from the seed, and a larger design has a smaller minimum', () => {
    const first = minimumDetectableEffect(pilot, 'continuous', design);
    expect(minimumDetectableEffect(pilot, 'continuous', design)).toStrictEqual(first);
    const bigger = minimumDetectableEffect(pilot, 'continuous', {
      ...design,
      sessionsPerArm: 120,
      simulations: 300,
    });
    expect(bigger.mde as number).toBeLessThan(0.7 * (first.mde as number));
  });

  it('asks for more sessions to find a smaller shift, and says null when the cap is not enough', () => {
    const large = sessionsForPower(
      pilot,
      'continuous',
      1 * sigma,
      { simulations: 600, seed: 9 },
      { max: 400 },
    );
    const small = sessionsForPower(
      pilot,
      'continuous',
      0.5 * sigma,
      { simulations: 600, seed: 9 },
      { max: 400 },
    );
    expect(large).not.toBeNull();
    expect(small).not.toBeNull();
    expect(small as number).toBeGreaterThan(large as number);
    expect((large as number) % 2).toBe(0);
    // Two-sample theory: n = 2 (1.96 + 0.84)^2 / d^2 = 15.7 / d^2 per arm: 16 at d = 1 and 63 at d = 0.5.
    expect(large as number).toBeGreaterThanOrEqual(30);
    expect(small as number).toBeGreaterThan(50);
    expect(small as number).toBeLessThan(90);
    expect(
      sessionsForPower(pilot, 'continuous', 0.01 * sigma, { simulations: 100, seed: 9 }, { max: 60 }),
    ).toBeNull();
  });

  it('says so when the pilot has no variation at all: every shift is detected, the minimum means nothing', () => {
    const constant = Array<number>(30).fill(500);
    expect(
      minimumDetectableEffect(constant, 'continuous', { sessionsPerArm: 30, simulations: 100, seed: 1 })
        .degenerate,
    ).toBe(true);
  });
});

describe('PB-AB power: the exact distribution is used for small designs', () => {
  it('runs 8 sessions per arm through the exact Mann-Whitney test, whose smallest p-value is 2 / C(16, 8)', () => {
    const pilot = pilotNormal(3, 200, 0, 1);
    expect(
      detectionPower(pilot, 'continuous', 0, { sessionsPerArm: 8, simulations: 500, seed: 2 }).power,
    ).toBeLessThan(0.08);
    expect(
      detectionPower(pilot, 'continuous', 10, { sessionsPerArm: 8, simulations: 200, seed: 2 }).power,
    ).toBe(1);
  });
});

describe('PB-AB power: what each verdict costs at a true shift (the full pipeline on simulated experiments)', () => {
  const pilot = pilotNormal(5, 400, 1000, 100);
  const sigma = sd(pilot);
  const design = { sessionsPerArm: 30, simulations: 150, seed: 11 };
  const metric = startupMetric({ practicalThreshold: 1.5 * sigma });
  const rates = (shift: number) => verdictRates(pilot, metric, shift, design, { resamples: 200 });

  it('adds up to one, and at no difference mostly says equivalent, almost never calls A or B better', () => {
    const none = rates(0);
    expect(Object.values(none).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(none.equivalent).toBeGreaterThan(0.8);
    expect(none['b-better'] + none['a-better']).toBeLessThan(0.03);
  });

  it('calls B better when it is much better and A better when B is much worse', () => {
    expect(rates(-4 * sigma)['b-better']).toBeGreaterThan(0.95);
    expect(rates(4 * sigma)['a-better']).toBeGreaterThan(0.95);
  });

  it('calls an improvement of exactly the threshold better only rarely: the rule wants the whole interval beyond it', () => {
    const atThreshold = rates(-1.5 * sigma);
    expect(atThreshold['b-better']).toBeLessThan(0.15);
    expect(atThreshold.inconclusive).toBeGreaterThan(0.5);
  });

  it('takes a share as 0 or 1 per session and applies the same rule', () => {
    const shares = pilotShare(20, 40);
    const quiet = verdictRates(shares, shareMetric({ practicalThreshold: 0.45 }), 0, {
      sessionsPerArm: 30,
      simulations: 100,
      seed: 12,
    });
    expect(Object.values(quiet).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(quiet['b-better']).toBeLessThan(0.05);
  });
});

describe('PB-AB power: what it refuses', () => {
  it('a pilot that is too short, not finite, or not 0/1 for a share, and a design that makes no sense', () => {
    const design = { sessionsPerArm: 30, seed: 1 };
    expect(() => detectionPower([1, 2, 3], 'continuous', 1, design)).toThrow(/at least 10 sessions/);
    expect(() => detectionPower([...Array<number>(10).fill(1), Number.NaN], 'continuous', 1, design)).toThrow(
      /not a finite number/,
    );
    expect(() => detectionPower([...pilotShare(3, 10), 2], 'binary', 0.1, design)).toThrow(/must be 0 or 1/);
    expect(() => detectionPower(pilotShare(3, 10), 'binary', 0.1, { sessionsPerArm: 1, seed: 1 })).toThrow(
      /sessionsPerArm/,
    );
    expect(() => detectionPower(pilotShare(3, 10), 'binary', 0.1, { ...design, simulations: 3 })).toThrow(
      /simulations/,
    );
    expect(() => minimumDetectableEffect(pilotShare(3, 10), 'binary', design, 1)).toThrow(/target power/);
  });
});
