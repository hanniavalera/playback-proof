import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootstrapHodgesLehmann,
  cliffsDelta,
  clopperPearson,
  erfc,
  fisherExact,
  hodgesLehmann,
  mannWhitneyU,
  newcombeDifference,
  normalCdf,
  normalQuantile,
  normalSurvival,
  quantileSorted,
  twoSidedNormalP,
  wilsonInterval,
} from '../../../ab/stats/index.ts';
import type { Counts } from '../../../ab/stats/index.ts';

// The statistics of ab/stats against the answers of an independent implementation (scipy and numpy), on the same inputs.
//
// The vectors are committed data (ab/vectors/scipy-vectors.json), made by ab/vectors/generate.py with the versions written into the file
// itself. Python is not part of any gate or of CI: this test reads the JSON and nothing else. To make them again, see the header of the
// script.
//
// TOLERANCES. A figure agrees when |mine - scipy| <= abs + rel * |scipy|. Each is stated with what it is based on: the largest difference seen
// when the vectors were made (on scipy 1.17.1 and numpy 2.4.6, Node 22) and the room that leaves. They are tight enough that the mutations
// tried on this library fail them (a dropped continuity or tie correction, a Fisher or exact Mann-Whitney tail one step off, a wrong Wilson
// centre or Newcombe end, a Clopper-Pearson tail one event off, a flipped sign of the shift or of Cliff's delta, a quantile of type 6, a
// truncated continued fraction of erfc: ADR-141), and loose enough that another libm or another BLAS does not.

type Tolerance = { abs: number; rel: number };

const TOLERANCE = {
  // Seen: relative 5e-14 (erfc, by series and by continued fraction), 1.4e-14 (cdf), 3e-14 (survival), against scipy's cephes erfc.
  closedForm: { abs: 0, rel: 1e-12 },
  // Seen: 1.1e-11 absolute. The quantile is found by bisection on a cdf in doubles: out in the tails (p = 1e-10, 1 - 1e-6) the double
  // representation of p itself limits the answer to about 1e-11, whatever the method.
  quantile: { abs: 1e-10, rel: 0 },
  // The statistic U1 is a count of pairs (halves for ties): equal, with no tolerance at all.
  count: { abs: 0, rel: 0 },
  // Seen: 1.1e-16 absolute and 4.9e-14 relative (the asymptotic p, a tail of the normal), against exact enumeration and tie-corrected normal.
  pValue: { abs: 1e-13, rel: 1e-10 },
  // Seen: 2.2e-16 absolute. Fisher: scipy compares two table probabilities with a relative tolerance of 1e-7, this library exactly (BigInt);
  // they agree on all 54 tables, as they do unless two different tables have probabilities within 1e-7 of each other.
  fisher: { abs: 1e-13, rel: 1e-10 },
  // Seen: 1.1e-15 (Wilson, a closed form), 6.7e-16 (Newcombe, assembled from Wilson), against scipy.
  interval: { abs: 1e-12, rel: 0 },
  // Seen: 1.5e-12 (Clopper-Pearson: bisection on a binomial cdf summed from log-factorials, against scipy's beta quantile).
  exactInterval: { abs: 1e-10, rel: 0 },
  // Seen: 0 (the same differences, the same median) and 2e-16 (type 7 quantile).
  effect: { abs: 1e-12, rel: 1e-12 },
} as const satisfies Record<string, Tolerance>;

/**
 * The bootstrap interval of the shift is a Monte Carlo figure: a different generator gives a different interval. The two agree up to the
 * Monte Carlo error of a percentile of B resamples, which for a normal-ish distribution is sqrt(p (1 - p) / B) / f(q): about 0.7 % of the
 * width of the interval for scipy's 9999 resamples and 0.5 % for the 20000 used here, so 0.8 % for the difference of the two (one sd). The
 * largest difference seen was 1.1 % of the width (three data sets, two ends). The room allowed is 5 % of the width: six sd of the error of
 * the difference, and far less than a wrong procedure gives: resampling one arm only, or taking the 5th and 95th percentiles instead of
 * the 2.5th and 97.5th (a 90 % interval), each fail all three data sets.
 */
const BOOTSTRAP_ROOM_OF_THE_WIDTH = 0.05;

interface Pair {
  x: number[];
  y: number[];
  u1: number;
  p: number;
}
interface IntervalVector {
  events: number;
  total: number;
  level: number;
  lower: number;
  upper: number;
}
interface Vectors {
  generatedBy: {
    script: string;
    command: string;
    python: string;
    numpy: string;
    scipy: string;
    seeds: Record<string, number>;
  };
  normal: {
    erfc: Array<{ x: number; value: number }>;
    cdf: Array<{ z: number; cdf: number; survival: number; twoSided: number }>;
    quantile: Array<{ p: number; z: number }>;
  };
  mannWhitney: { exactUntied: Pair[]; asymptoticUntied: Pair[]; asymptoticTied: Pair[]; exactTied: Pair[] };
  fisher: Array<{ a: Counts; b: Counts; p: number }>;
  wilson: IntervalVector[];
  clopperPearson: IntervalVector[];
  newcombe: Array<{ a: Counts; b: Counts; level: number; difference: number; lower: number; upper: number }>;
  effects: Array<{ a: number[]; b: number[]; hodgesLehmann: number; cliffsDelta: number }>;
  quantile: Array<{ sorted: number[]; quantiles: Array<{ p: number; value: number }> }>;
  bootstrap: Array<{
    a: number[];
    b: number[];
    level: number;
    scipyResamples: number;
    estimate: number;
    lower: number;
    upper: number;
  }>;
}

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../ab/vectors/scipy-vectors.json'), 'utf8'),
) as Vectors;

function expectAgrees(mine: number, scipy: number, tolerance: Tolerance, what: string): void {
  const limit = tolerance.abs + tolerance.rel * Math.abs(scipy);
  expect(
    Math.abs(mine - scipy),
    `${what}: this library ${mine}, scipy ${scipy}, allowed ${limit}`,
  ).toBeLessThanOrEqual(limit);
}

describe('PB-AB statistics against scipy: the fixture itself', () => {
  it('says how it was made: the script, the command, the versions and the seeds', () => {
    const made = vectors.generatedBy;
    expect(made.script).toBe('ab/vectors/generate.py');
    expect(made.command).toContain('ab/vectors/generate.py');
    for (const version of [made.python, made.numpy, made.scipy]) expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(made.seeds).length).toBeGreaterThanOrEqual(9);
    for (const seed of Object.values(made.seeds)) expect(Number.isInteger(seed)).toBe(true);
  });

  it('is not empty: a test that compares nothing proves nothing', () => {
    const counts = {
      erfc: vectors.normal.erfc.length,
      cdf: vectors.normal.cdf.length,
      quantile: vectors.normal.quantile.length,
      exactUntied: vectors.mannWhitney.exactUntied.length,
      asymptoticUntied: vectors.mannWhitney.asymptoticUntied.length,
      asymptoticTied: vectors.mannWhitney.asymptoticTied.length,
      exactTied: vectors.mannWhitney.exactTied.length,
      fisher: vectors.fisher.length,
      wilson: vectors.wilson.length,
      clopperPearson: vectors.clopperPearson.length,
      newcombe: vectors.newcombe.length,
      effects: vectors.effects.length,
      quantileSamples: vectors.quantile.length,
      bootstrap: vectors.bootstrap.length,
    };
    expect(counts).toStrictEqual({
      erfc: 21,
      cdf: 14,
      quantile: 13,
      exactUntied: 10,
      asymptoticUntied: 6,
      asymptoticTied: 7,
      exactTied: 7,
      fisher: 54,
      wilson: 57,
      clopperPearson: 57,
      newcombe: 36,
      effects: 10,
      quantileSamples: 8,
      bootstrap: 3,
    });
  });
});

describe('PB-AB statistics against scipy: the normal distribution', () => {
  it('erfc, from x = -5 to x = 26 (the series below 2, the continued fraction from 2 up)', () => {
    for (const { x, value } of vectors.normal.erfc)
      expectAgrees(erfc(x), value, TOLERANCE.closedForm, `erfc(${x})`);
  });

  it('the cdf, the survival function and the two-sided tail, down to 6e-16', () => {
    for (const row of vectors.normal.cdf) {
      expectAgrees(normalCdf(row.z), row.cdf, TOLERANCE.closedForm, `Phi(${row.z})`);
      expectAgrees(normalSurvival(row.z), row.survival, TOLERANCE.closedForm, `1 - Phi(${row.z})`);
      expectAgrees(twoSidedNormalP(row.z), row.twoSided, TOLERANCE.closedForm, `two-sided p of z = ${row.z}`);
    }
  });

  it('the quantile, from p = 1e-10 to p = 1 - 1e-6', () => {
    for (const { p, z } of vectors.normal.quantile)
      expectAgrees(normalQuantile(p), z, TOLERANCE.quantile, `quantile(${p})`);
  });
});

describe('PB-AB statistics against scipy: the Mann-Whitney U test', () => {
  const label = (kind: string, index: number, pair: Pair): string =>
    `${kind} #${index} (${pair.x.length} against ${pair.y.length})`;

  it('exact, no ties: the U of A and the two-sided p, on 10 pairs of samples from 3 against 3 up to 25 against 15', () => {
    vectors.mannWhitney.exactUntied.forEach((pair, index) => {
      const mine = mannWhitneyU(pair.x, pair.y, { method: 'exact' });
      const what = label('exact', index, pair);
      expect(mine.method).toBe('exact');
      expectAgrees(mine.u1, pair.u1, TOLERANCE.count, `${what}: U1`);
      expectAgrees(mine.p, pair.p, TOLERANCE.pValue, `${what}: p`);
    });
  });

  it('exact is what the default picks for these samples when both arms have 12 sessions or fewer', () => {
    for (const pair of vectors.mannWhitney.exactUntied.filter((p) => p.x.length <= 12 && p.y.length <= 12)) {
      const mine = mannWhitneyU(pair.x, pair.y);
      expect(mine.method).toBe('exact');
      expectAgrees(mine.p, pair.p, TOLERANCE.pValue, 'default method');
    }
  });

  it('asymptotic, no ties: the continuity-corrected normal approximation, on 6 pairs up to 100 against 100', () => {
    vectors.mannWhitney.asymptoticUntied.forEach((pair, index) => {
      const mine = mannWhitneyU(pair.x, pair.y, { method: 'asymptotic' });
      const what = label('asymptotic', index, pair);
      expectAgrees(mine.u1, pair.u1, TOLERANCE.count, `${what}: U1`);
      expectAgrees(mine.p, pair.p, TOLERANCE.pValue, `${what}: p`);
      // Over 12 sessions in an arm and no ties: the default is the same approximation.
      expect(mannWhitneyU(pair.x, pair.y).method).toBe('asymptotic');
    });
  });

  it('asymptotic with ties: the variance corrected for ties, on 7 samples of rebuffer-like counts (mostly zero)', () => {
    vectors.mannWhitney.asymptoticTied.forEach((pair, index) => {
      const mine = mannWhitneyU(pair.x, pair.y, { method: 'asymptotic' });
      const what = label('asymptotic with ties', index, pair);
      expect(mine.ties).toBe(true);
      expectAgrees(mine.u1, pair.u1, TOLERANCE.count, `${what}: U1`);
      expectAgrees(mine.p, pair.p, TOLERANCE.pValue, `${what}: p`);
    });
  });

  it('exact with ties: the conditional distribution over every assignment, against scipy.stats.permutation_test', () => {
    vectors.mannWhitney.exactTied.forEach((pair, index) => {
      const mine = mannWhitneyU(pair.x, pair.y, { method: 'exact' });
      const what = label('exact with ties', index, pair);
      expect(mine.ties).toBe(true);
      expectAgrees(mine.u1, pair.u1, TOLERANCE.count, `${what}: U1`);
      expectAgrees(mine.p, pair.p, TOLERANCE.pValue, `${what}: p`);
      // Both arms have at most 9 sessions: the default is this exact test too.
      expectAgrees(mannWhitneyU(pair.x, pair.y).p, pair.p, TOLERANCE.pValue, `${what}: default method`);
    });
  });
});

describe("PB-AB statistics against scipy: Fisher's exact test", () => {
  it('two-sided p of 54 tables: the tea-tasting table first (3 of 4 against 1 of 4, 17/35), the extremes, the equal arms, 40 random ones', () => {
    for (const { a, b, p } of vectors.fisher)
      expectAgrees(
        fisherExact(a, b).p,
        p,
        TOLERANCE.fisher,
        `${a.events}/${a.total} against ${b.events}/${b.total}`,
      );
    expect(vectors.fisher[0]?.p).toBeCloseTo(17 / 35, 12);
  });
});

describe('PB-AB statistics against scipy: intervals for proportions', () => {
  it('Wilson score interval, 19 counts (0 of 1 to 2000 of 2000) at levels 0.90, 0.95 and 0.99', () => {
    for (const row of vectors.wilson) {
      const mine = wilsonInterval({ events: row.events, total: row.total }, row.level);
      const what = `Wilson ${row.events}/${row.total} at ${row.level}`;
      expectAgrees(mine.lower, row.lower, TOLERANCE.interval, `${what}: lower`);
      expectAgrees(mine.upper, row.upper, TOLERANCE.interval, `${what}: upper`);
    }
  });

  it('Clopper-Pearson interval, the same 57 counts and levels: scipy takes the beta quantile, this library bisects the binomial cdf', () => {
    for (const row of vectors.clopperPearson) {
      const mine = clopperPearson(row.events, row.total, row.level);
      const what = `Clopper-Pearson ${row.events}/${row.total} at ${row.level}`;
      expectAgrees(mine.lower, row.lower, TOLERANCE.exactInterval, `${what}: lower`);
      expectAgrees(mine.upper, row.upper, TOLERANCE.exactInterval, `${what}: upper`);
    }
  });

  it("Newcombe's hybrid score interval of a difference: assembled from scipy's Wilson intervals (it is not in scipy), the published example first", () => {
    for (const row of vectors.newcombe) {
      const mine = newcombeDifference(row.a, row.b, row.level);
      const what = `Newcombe ${row.a.events}/${row.a.total} against ${row.b.events}/${row.b.total} at ${row.level}`;
      expectAgrees(mine.difference, row.difference, TOLERANCE.interval, `${what}: difference`);
      expectAgrees(mine.lower, row.lower, TOLERANCE.interval, `${what}: lower`);
      expectAgrees(mine.upper, row.upper, TOLERANCE.interval, `${what}: upper`);
    }
    const published = vectors.newcombe[0];
    expect(published).toMatchObject({ a: { events: 48, total: 80 }, b: { events: 56, total: 70 } });
    expect(published?.lower).toBeCloseTo(0.0524, 4);
    expect(published?.upper).toBeCloseTo(0.3339, 4);
  });
});

describe('PB-AB statistics against scipy: effect sizes and quantiles', () => {
  it('Hodges-Lehmann shift: the median of b - a, with and without ties, from 1 against 1 to 31 against 30', () => {
    vectors.effects.forEach((row, index) =>
      expectAgrees(hodgesLehmann(row.a, row.b), row.hodgesLehmann, TOLERANCE.effect, `shift #${index}`),
    );
  });

  it("Cliff's delta: the mean sign of b - a", () => {
    vectors.effects.forEach((row, index) =>
      expectAgrees(cliffsDelta(row.a, row.b).delta, row.cliffsDelta, TOLERANCE.effect, `delta #${index}`),
    );
  });

  it('quantile of type 7 (numpy linear), at 9 probabilities of 8 samples from 1 value to 100', () => {
    vectors.quantile.forEach((row, index) => {
      for (const { p, value } of row.quantiles)
        expectAgrees(
          quantileSorted(row.sorted, p),
          value,
          TOLERANCE.effect,
          `sample #${index} (${row.sorted.length} values), q = ${p}`,
        );
    });
  });
});

describe('PB-AB statistics against scipy: the bootstrap interval of the shift (Monte Carlo: agreement up to the sampling error)', () => {
  it.each(vectors.bootstrap.map((row, index) => [index, row] as const))(
    'data set #%i: the same estimate, and both ends of the interval within 5 % of its width of scipy.stats.bootstrap (percentile)',
    (_index, row) => {
      const mine = bootstrapHodgesLehmann(row.a, row.b, {
        seed: 20261110,
        resamples: 20000,
        level: row.level,
      });
      const width = row.upper - row.lower;
      expectAgrees(mine.estimate, row.estimate, TOLERANCE.effect, 'the estimate');
      expect(width).toBeGreaterThan(0);
      expect(
        Math.abs(mine.lower - row.lower) / width,
        `lower end: ${mine.lower} against ${row.lower}`,
      ).toBeLessThan(BOOTSTRAP_ROOM_OF_THE_WIDTH);
      expect(
        Math.abs(mine.upper - row.upper) / width,
        `upper end: ${mine.upper} against ${row.upper}`,
      ).toBeLessThan(BOOTSTRAP_ROOM_OF_THE_WIDTH);
    },
  );
});
