import { describe, expect, it } from 'vitest';
import {
  erfc,
  erfcParts,
  normalCdf,
  normalQuantile,
  normalSurvival,
  twoSidedNormalP,
} from '../../../ab/stats/normal.ts';
import { mulberry32, randomInt, seedFrom, shuffleInPlace } from '../../../ab/stats/random.ts';

// The generator and the normal distribution are what every other statistic stands on, so each is checked against published values
// and against an independent form of itself.

/** Tommy Ettinger's mulberry32 exactly as published (the state is a plain double: identical for the first few million draws). */
function publishedMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('PB-AB seeded generator', () => {
  it.each([0, 1, 42, 20261104, 4294967295])('reproduces the published mulberry32 for seed %i', (seed) => {
    const ours = mulberry32(seed);
    const published = publishedMulberry32(seed);
    for (let i = 0; i < 5000; i++) expect(ours()).toBe(published());
  });

  it('gives the same sequence for the same seed and a different one for another', () => {
    const first = Array.from({ length: 10 }, mulberry32(7));
    expect(Array.from({ length: 10 }, mulberry32(7))).toStrictEqual(first);
    expect(Array.from({ length: 10 }, mulberry32(8))).not.toStrictEqual(first);
  });

  it('draws floats in [0, 1) whose mean and spread are those of a uniform variable', () => {
    const random = mulberry32(99);
    const draws = Array.from({ length: 20000 }, random);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    const mean = draws.reduce((sum, x) => sum + x, 0) / draws.length;
    const variance = draws.reduce((sum, x) => sum + (x - mean) ** 2, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    expect(variance).toBeGreaterThan(1 / 12 - 0.004);
    expect(variance).toBeLessThan(1 / 12 + 0.004);
  });

  it('derives seeds that are stable, distinct per use, and not fooled by where a word ends', () => {
    expect(seedFrom(20261104, 'bootstrap', 'startupMs')).toBe(seedFrom(20261104, 'bootstrap', 'startupMs'));
    expect(seedFrom(1, 'bootstrap', 'startupMs')).not.toBe(seedFrom(1, 'bootstrap', 'rebufferCount'));
    expect(seedFrom(1, 'x')).not.toBe(seedFrom(2, 'x'));
    expect(seedFrom('ab', 'c')).not.toBe(seedFrom('a', 'bc'));
    expect(Number.isInteger(seedFrom('anything'))).toBe(true);
    expect(seedFrom('anything')).toBeLessThan(2 ** 32);
  });

  it('draws integers over the whole range and shuffles into every order about equally often', () => {
    const random = mulberry32(5);
    const seen = new Set(Array.from({ length: 500 }, () => randomInt(random, 7)));
    expect([...seen].sort()).toStrictEqual([0, 1, 2, 3, 4, 5, 6]);

    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const key = shuffleInPlace([1, 2, 3], random).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});

describe('PB-AB normal distribution: erfc against published values', () => {
  // The digits of the table are those of the standard references (Abramowitz and Stegun table 7.1, and every computer algebra system).
  it.each([
    [0, 1],
    [0.5, 0.4795001221869535],
    [1, 0.15729920705028513],
    [1.5, 0.033894853524689274],
    [2, 0.004677734981047266],
    [2.5, 4.069520174449589e-4],
    [3, 2.209049699858544e-5],
    [4, 1.541725790028002e-8],
    [5, 1.5374597944280347e-12],
    [6, 2.1519736712498913e-17],
    [-1, 1.8427007929497148],
  ])('erfc(%d) = %d', (x, expected) => {
    expect(Math.abs(erfc(x) / expected - 1)).toBeLessThan(1e-12);
  });

  it('the series and the continued fraction agree where both are valid, so neither hides an error of the other', () => {
    for (let x = 1.5; x <= 3; x += 0.05) {
      const series = erfcParts.series(x);
      const fraction = erfcParts.fraction(x);
      expect(Math.abs(series / fraction - 1)).toBeLessThan(1e-10);
    }
  });

  it('is monotone decreasing, symmetric (erfc(x) + erfc(-x) = 2) and handles the extremes', () => {
    let previous = Infinity;
    for (let x = -6; x <= 8; x += 0.125) {
      const value = erfc(x);
      // Strict where a double can tell neighbours apart; erfc(-6) and erfc(-5.875) are both 2 to the last bit.
      if (x > -2) expect(value).toBeLessThan(previous);
      else expect(value).toBeLessThanOrEqual(previous);
      previous = value;
      expect(Math.abs(erfc(x) + erfc(-x) - 2)).toBeLessThan(1e-14);
    }
    expect(erfc(Infinity)).toBe(0);
    expect(erfc(-Infinity)).toBe(2);
    expect(erfc(30)).toBe(0);
    expect(Number.isNaN(erfc(Number.NaN))).toBe(true);
  });
});

describe('PB-AB normal distribution: the CDF, the tail and the quantile', () => {
  it.each([
    [1.96, 0.9750021048517795],
    [-1.96, 0.024997895148220435],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145707],
    [3, 0.9986501019683699],
    [-3, 0.0013498980316300946],
    [-5, 2.866515718791939e-7],
    [0, 0.5],
  ])('Phi(%d) = %d', (z, expected) => {
    expect(Math.abs(normalCdf(z) / expected - 1)).toBeLessThan(1e-12);
  });

  it('keeps the upper tail without cancellation and the two-sided tail consistent', () => {
    expect(Math.abs(normalSurvival(5) / 2.866515718791939e-7 - 1)).toBeLessThan(1e-12);
    expect(normalSurvival(2)).toBeCloseTo(1 - normalCdf(2), 14);
    expect(twoSidedNormalP(1.96)).toBeCloseTo(0.04999579029644087, 13);
    expect(twoSidedNormalP(-1.96)).toBe(twoSidedNormalP(1.96));
    expect(twoSidedNormalP(0)).toBe(1);
  });

  it.each([
    [0.975, 1.959963984540054],
    [0.995, 2.5758293035489004],
    [0.9, 1.2815515655446004],
    [0.5, 0],
    [0.025, -1.959963984540054],
  ])('the quantile of %d is %d', (p, expected) => {
    expect(normalQuantile(p)).toBeCloseTo(expected, 12);
  });

  it('is the inverse of the CDF and refuses a probability outside (0, 1)', () => {
    for (const p of [0.001, 0.05, 0.3, 0.77, 0.999]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 13);
    for (const bad of [0, 1, -0.1, 1.5, Number.NaN]) expect(() => normalQuantile(bad)).toThrow(RangeError);
  });
});
