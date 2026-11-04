import { describe, expect, it } from 'vitest';
import { binomialCdf, describeEvidence, ruleOfThree, upperBound } from '../../../src/lab/smoke/stats.ts';

describe('binomialCdf', () => {
  it('adds up the binomial terms', () => {
    expect(binomialCdf(0, 2, 0.5)).toBeCloseTo(0.25, 12);
    expect(binomialCdf(1, 2, 0.5)).toBeCloseTo(0.75, 12);
    expect(binomialCdf(2, 2, 0.5)).toBe(1);
    expect(binomialCdf(3, 10, 0)).toBe(1);
    expect(binomialCdf(3, 10, 1)).toBe(0);
  });
});

describe('upperBound (Clopper-Pearson, one-sided)', () => {
  it('with no failure in n runs is 1 - alpha^(1/n): 13.9 % for 20 runs, and the rule of three is a good approximation', () => {
    expect(upperBound(0, 20)).toBeCloseTo(1 - 0.05 ** (1 / 20), 9);
    expect(upperBound(0, 20)).toBeCloseTo(0.1391, 4);
    expect(upperBound(0, 1)).toBeCloseTo(0.95, 9);
    expect(ruleOfThree(20)).toBe(0.15);
    expect(upperBound(0, 100)).toBeCloseTo(ruleOfThree(100), 2);
  });

  it('matches the published value for one failure in ten runs (39.4 %)', () => {
    expect(upperBound(1, 10)).toBeCloseTo(0.3942, 3);
  });

  it('is the rate at which k or fewer failures have probability 1 - confidence, and grows with the failures', () => {
    let previous = 0;
    for (const [failures, runs] of [
      [0, 20],
      [1, 20],
      [5, 20],
      [11, 20],
      [3, 50],
    ] as const) {
      const bound = upperBound(failures, runs);
      expect(binomialCdf(failures, runs, bound)).toBeCloseTo(0.05, 8);
      if (runs === 20) {
        expect(bound).toBeGreaterThan(previous);
        previous = bound;
      }
    }
  });

  it('is 1 when every run failed, and wider at higher confidence', () => {
    expect(upperBound(20, 20)).toBe(1);
    expect(upperBound(2, 40, 0.99)).toBeGreaterThan(upperBound(2, 40, 0.95));
  });

  it('refuses nonsense', () => {
    expect(() => upperBound(0, 0)).toThrow(RangeError);
    expect(() => upperBound(-1, 5)).toThrow(RangeError);
    expect(() => upperBound(6, 5)).toThrow(RangeError);
    expect(() => upperBound(1.5, 5)).toThrow(RangeError);
    expect(() => upperBound(1, 5, 1)).toThrow(RangeError);
    expect(() => ruleOfThree(0)).toThrow(RangeError);
  });
});

describe('describeEvidence', () => {
  it('states passes, the failure rate and its bound, and quotes the rule of three when nothing failed', () => {
    expect(describeEvidence(20, 20)).toBe(
      '20/20 passed (100.0 %); failure rate 0.0 %, 95 % upper bound 13.9 % (rule of three: 15.0 %)',
    );
    const mixed = describeEvidence(9, 20);
    expect(mixed).toMatch(/^9\/20 passed \(45\.0 %\); failure rate 55\.0 %, 95 % upper bound \d+\.\d %$/);
  });
});
