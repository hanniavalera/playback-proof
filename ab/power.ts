import { analyzeCondition } from './analyze.ts';
import type { AnalysisPlan } from './analyze.ts';
import type { Outcome } from './decision.ts';
import type { MetricId } from './metrics.ts';
import { METRICS } from './metrics.ts';
import { AB_POLICY } from './policy.ts';
import type { MetricPlan } from './prereg.ts';
import { clopperPearson } from './stats/binomial.ts';
import { fisherExact } from './stats/fisher.ts';
import { mannWhitneyU } from './stats/mann-whitney.ts';
import { mulberry32, randomInt, seedFrom } from './stats/random.ts';
import type { Random } from './stats/random.ts';
import type { ArmId, SessionRecord } from './types.ts';

// POWER BY SIMULATION. How large a difference can this design tell from noise? Not a formula that assumes a shape for the data: the answer is
// taken from the data the pilot measured (sessions of configuration A under the condition, ab/aa.ts):
//
//   one simulated experiment  = draw `sessionsPerArm` sessions of arm A from the pilot with replacement; draw `sessionsPerArm` more for
//                               arm B and shift them by `shift` (continuous metric: added to every value; a share: B's share is moved to
//                               p0 + shift by flipping sessions, see `shiftedShare`); run the test of the harness on the two arms.
//   power(shift)              = the share of `simulations` simulated experiments in which the test finds a difference (p < alpha).
//   minimum detectable effect = the smallest |shift| whose power reaches the target (80 %), found by doubling and then bisection.
//
// Every simulated experiment uses its own seeded stream, the SAME for every shift (common random numbers): the power curve is then smooth in
// the shift, and the search for the minimum has a well-defined answer. The test is the one the experiment uses (Mann-Whitney, exact or by
// the normal approximation as the sample size dictates; Fisher for a share): `verdictRates` goes further and runs the WHOLE pipeline of
// ab/analyze.ts on each simulated experiment, the bootstrap interval and the decision rule included.
//
// WHAT IT MEANS. Detecting is not deciding: a difference at the minimum detectable effect is found 80 % of the time, but the decision rule
// also needs the whole interval beyond the practical threshold, which at a true shift equal to the threshold happens about one time in forty
// (the far end of a 95 % interval lies beyond the true value only that often; ADR-147). `verdictRates` says how often each verdict comes out
// at a given true shift, which is the number that tells whether a design can ever say "ship B" or "no difference".

export type MetricKind = 'continuous' | 'binary';

export interface DesignOptions {
  sessionsPerArm: number;
  /** Simulated experiments per estimate. Default 1000. */
  simulations?: number;
  alpha?: number;
  seed: number;
}

export interface PowerEstimate {
  shift: number;
  /** The share of simulated experiments that found a difference. */
  power: number;
  /** The exact binomial interval of that share (the Monte Carlo error of the estimate), at 95 %. */
  lower: number;
  upper: number;
  simulations: number;
}

export const DEFAULT_SIMULATIONS = 1000;

function assertPilot(pilot: readonly number[], kind: MetricKind): void {
  if (pilot.length < 10)
    throw new RangeError(`the pilot needs at least 10 sessions to be resampled, got ${pilot.length}`);
  for (const [index, value] of pilot.entries()) {
    if (!Number.isFinite(value))
      throw new RangeError(`pilot value ${index} is not a finite number (${String(value)})`);
    if (kind === 'binary' && value !== 0 && value !== 1)
      throw new RangeError(`pilot value ${index} of a share must be 0 or 1, got ${value}`);
  }
}

function assertDesign(design: DesignOptions): { n: number; simulations: number; alpha: number } {
  const simulations = design.simulations ?? DEFAULT_SIMULATIONS;
  if (!Number.isInteger(design.sessionsPerArm) || design.sessionsPerArm < 2)
    throw new RangeError(`sessionsPerArm must be an integer >= 2, got ${String(design.sessionsPerArm)}`);
  if (!Number.isInteger(simulations) || simulations < 10)
    throw new RangeError(`simulations must be an integer >= 10, got ${String(simulations)}`);
  return { n: design.sessionsPerArm, simulations, alpha: design.alpha ?? AB_POLICY.alpha };
}

/**
 * Arm B of a simulated experiment for a share: a resample of the pilot's 0/1 values, with sessions flipped so that B's expected share is
 * p0 + shift. For a rise each 0 becomes 1 with probability shift / (1 - p0); for a fall each 1 becomes 0 with probability |shift| / p0. A
 * shift beyond what is possible (a share above 1 or below 0) is capped at the edge.
 */
function shiftedShare(drawn: number[], p0: number, shift: number, random: Random): number[] {
  if (shift === 0) return drawn;
  if (shift > 0) {
    const flip = p0 >= 1 ? 0 : Math.min(1, shift / (1 - p0));
    return drawn.map((value) => (value === 0 && random() < flip ? 1 : value));
  }
  const flip = p0 <= 0 ? 0 : Math.min(1, -shift / p0);
  return drawn.map((value) => (value === 1 && random() < flip ? 0 : value));
}

/** The two arms of simulated experiment number `run` for a given shift. The generator depends on the run and the seed, never on the shift. */
export function simulatedArms(
  pilot: readonly number[],
  kind: MetricKind,
  shift: number,
  n: number,
  seed: number,
  run: number,
): { a: number[]; b: number[] } {
  const random = mulberry32(seedFrom(seed, 'power', run));
  const draw = (): number[] =>
    Array.from({ length: n }, () => pilot[randomInt(random, pilot.length)] as number);
  const a = draw();
  const drawnB = draw();
  if (kind === 'binary') {
    const p0 = pilot.reduce((sum, value) => sum + value, 0) / pilot.length;
    return { a, b: shiftedShare(drawnB, p0, shift, random) };
  }
  return { a, b: drawnB.map((value) => value + shift) };
}

/** The p-value the experiment would report for these arms: Fisher for a share, Mann-Whitney (exact or approximate by size) otherwise. */
function pValue(kind: MetricKind, a: readonly number[], b: readonly number[]): number {
  if (kind === 'binary') {
    const count = (values: readonly number[]): { events: number; total: number } => ({
      events: values.filter((value) => value === 1).length,
      total: values.length,
    });
    return fisherExact(count(a), count(b)).p;
  }
  return mannWhitneyU(a, b).p;
}

/** The probability that the test of the harness finds a difference of `shift` between two arms of `sessionsPerArm` sessions drawn from the pilot. */
export function detectionPower(
  pilot: readonly number[],
  kind: MetricKind,
  shift: number,
  design: DesignOptions,
): PowerEstimate {
  assertPilot(pilot, kind);
  const { n, simulations, alpha } = assertDesign(design);
  let found = 0;
  for (let run = 0; run < simulations; run++) {
    const { a, b } = simulatedArms(pilot, kind, shift, n, design.seed, run);
    if (pValue(kind, a, b) < alpha) found += 1;
  }
  const interval = clopperPearson(found, simulations);
  return { shift, power: found / simulations, lower: interval.lower, upper: interval.upper, simulations };
}

export interface MdeSide {
  direction: 'increase' | 'decrease';
  /** The smallest shift (in magnitude) detected with the target power, or null when even the largest possible shift is not. */
  mde: number | null;
  /** The estimated power at that shift. */
  power: number | null;
  /** Why there is none, when there is none. */
  note: string | null;
}

export interface MdeEstimate {
  /** The larger of the two sides: the shift of either sign that the design detects with the target power. null when one side has none. */
  mde: number | null;
  targetPower: number;
  sessionsPerArm: number;
  simulations: number;
  sides: MdeSide[];
  /** The pilot has no variation at all, so any shift is detected and the minimum is meaningless. */
  degenerate: boolean;
}

function spreadOf(pilot: readonly number[]): number {
  const mean = pilot.reduce((sum, value) => sum + value, 0) / pilot.length;
  const sd = Math.sqrt(pilot.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pilot.length - 1));
  return sd;
}

/**
 * The smallest shift of one sign whose power reaches `targetPower`: double the shift from the pilot's own standard deviation until it
 * does (or the cap is hit), then bisect 20 times (a millionth of the bracket) between the last shift that did not and the first that did. `limit` is the largest
 * shift that exists (a share cannot rise by more than 1 - p0).
 */
function searchSide(
  pilot: readonly number[],
  kind: MetricKind,
  direction: 'increase' | 'decrease',
  targetPower: number,
  design: DesignOptions,
  limit: number,
): MdeSide {
  const sign = direction === 'increase' ? 1 : -1;
  const powerAt = (magnitude: number): number => detectionPower(pilot, kind, sign * magnitude, design).power;
  if (!(limit > 0))
    return {
      direction,
      mde: null,
      power: null,
      note: 'a share cannot move in this direction: it is already at its limit',
    };
  let low = 0;
  let high = Math.min(limit, kind === 'binary' ? limit / 8 : Math.max(spreadOf(pilot), 1e-9) / 4);
  let powerHigh = powerAt(high);
  for (let step = 0; powerHigh < targetPower && high < limit && step < 40; step++) {
    low = high;
    high = Math.min(limit, high * 2);
    powerHigh = powerAt(high);
  }
  if (powerHigh < targetPower) {
    return {
      direction,
      mde: null,
      power: powerHigh,
      note: `even a shift of ${high} is detected only ${(powerHigh * 100).toFixed(0)} % of the time with ${design.sessionsPerArm} sessions per arm`,
    };
  }
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (powerAt(middle) >= targetPower) high = middle;
    else low = middle;
  }
  return { direction, mde: high, power: powerAt(high), note: null };
}

/**
 * The minimum detectable effect of the design for a metric: the smallest shift, in either direction, that the test detects with probability
 * `targetPower` (default 80 %). Both directions are searched because a skewed pilot is easier to move one way than the other; the answer is
 * the larger, so that "a difference this big is found" holds whichever way B moves.
 */
export function minimumDetectableEffect(
  pilot: readonly number[],
  kind: MetricKind,
  design: DesignOptions,
  targetPower: number = AB_POLICY.targetPower,
): MdeEstimate {
  assertPilot(pilot, kind);
  const { n, simulations } = assertDesign(design);
  if (!(targetPower > 0 && targetPower < 1))
    throw new RangeError(`the target power must be strictly between 0 and 1, got ${String(targetPower)}`);
  const p0 = pilot.reduce((sum, value) => sum + value, 0) / pilot.length;
  const degenerate = kind === 'continuous' && spreadOf(pilot) === 0;
  const upLimit = kind === 'binary' ? 1 - p0 : Number.POSITIVE_INFINITY;
  const downLimit = kind === 'binary' ? p0 : Number.POSITIVE_INFINITY;
  const cap = (limit: number): number =>
    Number.isFinite(limit) ? limit : Math.max(spreadOf(pilot), 1e-9) * 64;
  const sides = [
    searchSide(pilot, kind, 'increase', targetPower, design, cap(upLimit)),
    searchSide(pilot, kind, 'decrease', targetPower, design, cap(downLimit)),
  ];
  const usable = sides.filter((side) => !(side.mde === null && side.note?.startsWith('a share cannot')));
  const mde =
    usable.length === 0 || usable.some((side) => side.mde === null)
      ? null
      : Math.max(...usable.map((side) => side.mde as number));
  return { mde, targetPower, sessionsPerArm: n, simulations, sides, degenerate };
}

/** The power at each of several shifts: the table that goes with the minimum, for the pre-registration. */
export function powerCurve(
  pilot: readonly number[],
  kind: MetricKind,
  shifts: readonly number[],
  design: DesignOptions,
): PowerEstimate[] {
  return shifts.map((shift) => detectionPower(pilot, kind, shift, design));
}

/**
 * The smallest number of sessions per arm (an even number, from `from` up to `max`) at which a shift of `shift` is detected with the target
 * power: how far N would have to be raised to make a difference that size findable. null when `max` is not enough.
 */
export function sessionsForPower(
  pilot: readonly number[],
  kind: MetricKind,
  shift: number,
  design: Omit<DesignOptions, 'sessionsPerArm'>,
  options: { targetPower?: number; from?: number; max?: number } = {},
): number | null {
  const target = options.targetPower ?? AB_POLICY.targetPower;
  const from = options.from ?? AB_POLICY.minSessionsPerArm;
  const max = options.max ?? 1000;
  const at = (n: number): number =>
    detectionPower(pilot, kind, shift, { ...design, sessionsPerArm: n }).power;
  let low = from % 2 === 0 ? from : from + 1;
  if (at(low) >= target) return low;
  let high = low;
  while (high < max) {
    high = Math.min(max, high * 2);
    if (at(high) >= target) break;
  }
  if (at(high) < target) return null;
  while (high - low > 2) {
    const middle = 2 * Math.round((low + high) / 4);
    if (middle <= low || middle >= high) break;
    if (at(middle) >= target) high = middle;
    else low = middle;
  }
  return high;
}

export type VerdictRates = Record<Outcome, number>;

/**
 * How often each verdict of the decision rule comes out at a given TRUE shift, running the full pipeline (the test, the bootstrap
 * interval, Holm over a family of one, the rule) on every simulated experiment. At a shift of 0 the share of `no-difference` is the
 * chance the design can say "nothing that matters" about two configurations that are the same; at a shift equal to the threshold the
 * share of `ship-b` shows that the rule, which wants the whole interval beyond the threshold, ships a real improvement of exactly the
 * smallest size worth having rarely (about one time in forty for a symmetric estimate: the far end of the interval is beyond the true value
 * that often).
 */
export function verdictRates(
  pilot: readonly number[],
  metric: MetricPlan,
  shift: number,
  design: DesignOptions,
  options: { resamples?: number } = {},
): VerdictRates {
  const kind = METRICS[metric.id].kind;
  assertPilot(pilot, kind);
  const { n, simulations, alpha } = assertDesign(design);
  const plan: AnalysisPlan = {
    kind: 'experiment',
    alpha,
    confidenceLevel: 1 - alpha,
    bootstrapResamples: options.resamples ?? 400,
    seed: design.seed,
    metrics: [{ ...metric, role: 'primary' }],
    maxFailedShare: AB_POLICY.defaultMaxFailedShare,
  };
  const counts: VerdictRates = { 'ship-b': 0, 'do-not-ship-b': 0, 'no-difference': 0, inconclusive: 0 };
  for (let run = 0; run < simulations; run++) {
    const { a, b } = simulatedArms(pilot, kind, shift, n, design.seed, run);
    const analysis = analyzeCondition(plan, sessionsOf(metric.id, a, b), { exploratory: false });
    counts[(analysis.decision as { outcome: Outcome }).outcome] += 1;
  }
  return {
    'ship-b': counts['ship-b'] / simulations,
    'do-not-ship-b': counts['do-not-ship-b'] / simulations,
    'no-difference': counts['no-difference'] / simulations,
    inconclusive: counts.inconclusive / simulations,
  };
}

/** The sessions of two simulated arms as the analysis reads them: a share is carried as a rebuffer count of 0 or 1. */
function sessionsOf(metric: MetricId, a: readonly number[], b: readonly number[]): SessionRecord[] {
  const key = metric === 'rebufferShare' ? 'rebufferCount' : metric;
  const record = (arm: ArmId, value: number, index: number): SessionRecord => ({
    index,
    block: Math.floor(index / 2),
    arm,
    config: arm,
    condition: 'simulated',
    warmup: false,
    status: 'ok',
    values: { [key]: value },
    startRungHeight: null,
    rungs: [],
    errors: [],
    info: null,
    sessionId: null,
    startedAt: '',
    durationMs: 0,
  });
  return [
    ...a.map((value, i) => record('A', value, i)),
    ...b.map((value, i) => record('B', value, a.length + i)),
  ];
}
