import { LIVE_FACTS, LIVE_LIMITS } from '../../shared/criteria.ts';
import { median, percentile } from '../measure/stats.ts';
import { evaluation, formatMs, plural } from './verdict.ts';
import type { Evaluation, Limits } from './verdict.ts';

// The evaluators of PB-RDY-001 to PB-RDY-004 (docs/decisions/readiness.md, ADR-151 to ADR-154): pure functions from what a check
// measured to evaluations. They read their limits from `LIVE_LIMITS` (src/shared/criteria.ts) and never carry a number of the policy;
// the numbers below are the evaluators' own, each with the reason it is that one.

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-001 Stream start

export interface JoinSample {
  /** 1-based, in the order the joins were made. */
  join: number;
  /** `load-requested` to `firstframe`, ms (docs/METRICS.md). null: the page never presented a first frame in the time the join was given. */
  startupMs: number | null;
  /** Why there is no number: the wait that ran out, with the player's own words. */
  failure?: string;
  /** Where inside the segment interval the join's first manifest request reached the origin, ms from the last publication: the "different positions" the criterion asks for. */
  phaseMs?: number | null;
}

/**
 * The worst of the sampled joins against `startMaxMs`. The criterion judges the worst join, because a member only ever has their own;
 * the p95 is reported next to it (an advisory line with the same limit) because the brief of the phase asked for it and because it shows
 * whether one join stood out. A join that never presented a frame is a NO-GO of its own, whatever the others did.
 */
export function evaluateStart(joins: readonly JoinSample[], limits: Limits = LIVE_LIMITS): Evaluation[] {
  const failed = joins.filter((join) => join.startupMs === null);
  const times = joins.flatMap((join) => (join.startupMs === null ? [] : [join.startupMs]));
  const worst = times.length === 0 ? null : Math.max(...times);
  const worstJoin = worst === null ? null : joins.find((join) => join.startupMs === worst)?.join;
  const enough = joins.length >= limits.startSamples;
  const detail = {
    joins: joins.map((join) => ({
      join: join.join,
      startupMs: join.startupMs,
      phaseMs: join.phaseMs ?? null,
      ...(join.failure ? { failure: join.failure } : {}),
    })),
    requiredJoins: limits.startSamples,
  };

  const verdict =
    failed.length > 0
      ? ('NO-GO' as const)
      : !enough || worst === null
        ? ('INCONCLUSIVE' as const)
        : undefined;
  const worstLine = evaluation({
    id: 'start.worst',
    check: 'PB-RDY-001',
    label: `Start time, worst of ${joins.length} joins`,
    value: worst,
    unit: 'ms',
    limitKey: 'startMaxMs',
    bound: 'at-most',
    limits,
    detail,
    ...(verdict ? { verdict } : {}),
    sentence: ({ verdict: v, value, limit }) => {
      if (failed.length > 0) {
        const first = failed[0];
        return `${plural(failed.length, 'join')} of ${joins.length} never presented a first frame (join ${first?.join}: ${first?.failure ?? 'no reason recorded'}): a member who cannot start cannot be told to retry at kick-off.`;
      }
      if (!enough || worst === null)
        return `Only ${plural(joins.length, 'join')} of the ${limits.startSamples} the criterion asks for were sampled: the worst start is ${value}, which is not enough to judge.`;
      return `The slowest of ${joins.length} fresh joins (join ${worstJoin}) presented its first frame after ${value}; the limit is ${limit}${v === 'GO' ? '.' : ': a member would wait longer than the criterion allows.'}`;
    },
  });

  const p95 = times.length === 0 ? null : percentile(times, 0.95);
  const p95Line = evaluation({
    id: 'start.p95',
    check: 'PB-RDY-001',
    label: `Start time, p95 of ${joins.length} joins`,
    value: p95,
    unit: 'ms',
    limitKey: 'startMaxMs',
    bound: 'at-most',
    limits,
    scope: 'advisory',
    ...(failed.length > 0 || !enough ? { verdict: 'INCONCLUSIVE' as const } : {}),
    detail: { median: times.length === 0 ? null : median(times) },
    sentence: ({ value, limit }) =>
      `The 95th percentile of the join times is ${value} (the median is ${times.length === 0 ? 'not measured' : formatMs(median(times))}); the limit it is compared with is ${limit}. It does not decide: the worst join does.`,
  });
  return [worstLine, p95Line];
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-002 Live-edge latency over a window

export interface LatencyPoint {
  /** Media time of the read, seconds. */
  mediaTime: number;
  /** `metrics.live.latencyMs` at the read; null when the player had no live edge to measure against. */
  latencyMs: number | null;
}

export interface LatencyWindow {
  samples: readonly LatencyPoint[];
  /** The player's own maximum since the first frame (`metrics.live.latencyMaxMs`), updated at every `timeupdate`: it sees the spikes between two reads. */
  playerMaxMs?: number | null;
  /** Counted in the window, for the reader: a stall inside it explains a high maximum. */
  rebuffers?: number;
  edgeSeeks?: number;
}

/**
 * Twenty reads are the fewest from which a p95 is more than "the second largest of them": below it the percentile and the maximum are
 * the same claim twice. The window the check takes is three times that (`LATENCY_WINDOW_SEC` in checks.ts).
 */
export const MIN_LATENCY_SAMPLES = 20;

export function evaluateLatencyWindow(window: LatencyWindow, limits: Limits = LIVE_LIMITS): Evaluation[] {
  const values = window.samples.flatMap((sample) => (sample.latencyMs === null ? [] : [sample.latencyMs]));
  const enough = values.length >= MIN_LATENCY_SAMPLES;
  const p95 = values.length === 0 ? null : percentile(values, 0.95);
  const readMax = values.length === 0 ? null : Math.max(...values);
  const playerMax = window.playerMaxMs ?? null;
  const max = readMax === null ? null : Math.max(readMax, playerMax ?? readMax);
  const detail = {
    samples: values.length,
    unreadSamples: window.samples.length - values.length,
    minimumSamples: MIN_LATENCY_SAMPLES,
    medianMs: values.length === 0 ? null : median(values),
    targetMs: limits.latencyTargetMs,
    readMaxMs: readMax,
    playerMaxMs: playerMax,
    rebuffers: window.rebuffers ?? null,
    edgeSeeks: window.edgeSeeks ?? null,
  };
  const tooFew = enough ? {} : { verdict: 'INCONCLUSIVE' as const };
  const shortSentence = `Only ${plural(values.length, 'latency read')} of the ${MIN_LATENCY_SAMPLES} needed to judge a percentile.`;
  return [
    evaluation({
      id: 'latency.p95',
      check: 'PB-RDY-002',
      label: 'Latency, p95 over the window',
      value: p95,
      unit: 'ms',
      limitKey: 'latencyP95MaxMs',
      bound: 'at-most',
      limits,
      detail,
      ...tooFew,
      sentence: ({ verdict, value, limit }) =>
        !enough
          ? `${shortSentence} The p95 of what was read is ${value}.`
          : `The playhead sat ${value} behind the live edge at the 95th percentile of ${values.length} reads (the target is ${formatMs(limits.latencyTargetMs)}); the limit is ${limit}${verdict === 'GO' ? '.' : ': members would sit further behind the action than the criterion allows.'}`,
    }),
    evaluation({
      id: 'latency.max',
      check: 'PB-RDY-002',
      label: 'Latency, maximum over the window',
      value: max,
      unit: 'ms',
      limitKey: 'latencyMaxMs',
      bound: 'at-most',
      limits,
      detail,
      ...tooFew,
      sentence: ({ verdict, value, limit }) =>
        !enough
          ? `${shortSentence} The largest latency seen is ${value}.`
          : `The largest latency of the window (the player's own maximum or any read) was ${value}; the limit is ${limit}${verdict === 'GO' ? '.' : ': beyond it the player is further behind than the system can explain.'}`,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-003 Stall recovery

export interface RestoreSample {
  /** Wall-clock ms since the recovery (the first `playing` after the stall). */
  sinceResumeMs: number;
  latencyMs: number | null;
  /** The media element's playback rate: Shaka's live sync catches up by raising it, so a rate above 1 is the evidence that it did. */
  playbackRate: number;
}

export interface StallRun {
  /** 1-based. */
  run: number;
  /** The injected outage drained the buffer: the player stalled (`buffering-start`) after it began. A run in which it did not exercised no recovery. */
  stalled: boolean;
  /** `buffering-start` to the next `playing`, ms on the page's clock; null when the player did not resume in the time it was given. */
  recoveryMs: number | null;
  /** How long the harness waited for the `playing` that never came, ms. */
  waitedMs: number | null;
  /** Latency just before the outage, ms: the session's own steady level (the median of the reads taken in the seconds before it). */
  latencyBeforeMs: number | null;
  /** The reads that level is the median of, ms. */
  latencyBeforeReadsMs?: readonly number[];
  /** Latency from the recovery on, one read per second of media time. */
  after: readonly RestoreSample[];
  /** How long the player was watched after it resumed, ms. */
  observedMs: number;
}

/** How long latency must stay back within the maximum for it to count as restored: a read that dips under it once is not a player that came back. */
export const RESTORE_HOLD_MS = 5000;

/**
 * How far above its own steady level the latency may be for the relative reading to call the player back: one segment. An outage of
 * `injectedStallMs` leaves an unrestored player `injectedStallMs - presentationDelay` behind where it was (4 s for 10 s and the 6 s delay,
 * two segments), so one segment is half way between a player that came back and one that did not; the whole spread of healthy latencies
 * in the live specs was 6.06 to 7.17 s, about a second (ADR-100). It is the evaluator's own number and not a limit of the policy: Phase 7
 * part 2 chooses it, and whether the relative reading or the absolute limit separates the two better, from the values it measures
 * (ADR-153).
 */
export const RELATIVE_TOLERANCE_MS = LIVE_FACTS.segmentSec * 1000;

export type Restore =
  { restored: true; atMs: number } | { restored: false; observedMs: number; finalLatencyMs: number | null };

/**
 * When latency came back within `ceilingMs` for good: the start of the longest tail of the observation in which every read is within
 * it, provided that tail lasts `RESTORE_HOLD_MS`. A series that is within the ceiling from the first read is restored at that read;
 * one that never gets there, or that ends too soon after getting there to say it stayed, is not.
 */
export function restoreWithin(
  after: readonly RestoreSample[],
  observedMs: number,
  ceilingMs: number,
): Restore {
  const reads = after.filter((sample) => sample.latencyMs !== null);
  let start = reads.length;
  while (start > 0 && (reads[start - 1]?.latencyMs as number) <= ceilingMs) start -= 1;
  const first = reads[start];
  const last = reads.at(-1);
  const held =
    first !== undefined && last !== undefined && last.sinceResumeMs - first.sinceResumeMs >= RESTORE_HOLD_MS;
  if (first !== undefined && held) return { restored: true, atMs: first.sinceResumeMs };
  return { restored: false, observedMs, finalLatencyMs: last?.latencyMs ?? null };
}

/** The absolute reading: back within `latencyMaxMs`, the limit of the policy. */
export function restoreFrom(
  after: readonly RestoreSample[],
  observedMs: number,
  limits: Limits = LIVE_LIMITS,
): Restore {
  return restoreWithin(after, observedMs, limits.latencyMaxMs);
}

export function restoreOf(run: StallRun, limits: Limits = LIVE_LIMITS): Restore {
  return restoreFrom(run.after, run.observedMs, limits);
}

/** The relative reading: back within `toleranceMs` of the run's own steady level before the outage; null when that level was not measured. */
export function restoreRelativeOf(
  run: StallRun,
  toleranceMs: number = RELATIVE_TOLERANCE_MS,
): Restore | null {
  return run.latencyBeforeMs === null
    ? null
    : restoreWithin(run.after, run.observedMs, run.latencyBeforeMs + toleranceMs);
}

export function evaluateStallRecovery(
  runs: readonly StallRun[],
  limits: Limits = LIVE_LIMITS,
  toleranceMs: number = RELATIVE_TOLERANCE_MS,
): Evaluation[] {
  const judged = runs.filter((run) => run.stalled);
  const unexercised = runs.length - judged.length;
  const none = judged.length === 0;
  const noneSentence = `The injected ${formatMs(limits.injectedStallMs)} outage did not make the player stall in ${runs.length === 0 ? 'any run (none was made)' : plural(runs.length, 'run')}: no recovery was exercised, so there is nothing to judge.`;

  // The recovery: the worst `buffering-start` to `playing`. A run that never resumed has no number, only a wait that ran out.
  const resumed = judged.flatMap((run) => (run.recoveryMs === null ? [] : [run.recoveryMs]));
  const neverResumed = judged.filter((run) => run.recoveryMs === null);
  const waited = Math.max(0, ...neverResumed.map((run) => run.waitedMs ?? 0));
  const worstRecovery = none ? null : neverResumed.length > 0 ? waited : Math.max(...resumed);
  const recoveryVerdict = none
    ? ('INCONCLUSIVE' as const)
    : neverResumed.length > 0
      ? waited >= limits.stallRecoveryMaxMs
        ? ('NO-GO' as const)
        : ('INCONCLUSIVE' as const)
      : undefined;
  const recovery = evaluation({
    id: 'stall.recovery',
    check: 'PB-RDY-003',
    label: `Stall recovery, worst of ${judged.length}`,
    value: worstRecovery,
    unit: 'ms',
    limitKey: 'stallRecoveryMaxMs',
    bound: 'at-most',
    limits,
    ...(neverResumed.length > 0 ? { censored: true as const } : {}),
    ...(recoveryVerdict ? { verdict: recoveryVerdict } : {}),
    detail: {
      runs: runs.map((run) => ({
        run: run.run,
        stalled: run.stalled,
        recoveryMs: run.recoveryMs,
        waitedMs: run.waitedMs,
      })),
      outageMs: limits.injectedStallMs,
      runsWithoutStall: unexercised,
    },
    sentence: ({ verdict, value, limit }) => {
      if (none) return noneSentence;
      if (neverResumed.length > 0)
        return `The player did not resume in ${plural(neverResumed.length, 'run')} of ${judged.length}: it was still stalled after ${value}; the limit is ${limit}.`;
      return `After the ${formatMs(limits.injectedStallMs)} outage the player stalled for ${value} in its worst of ${plural(judged.length, 'run')}; the limit is ${limit}${verdict === 'GO' ? '' : ': the outage cost members more than the outage'}${unexercised > 0 ? ` (${plural(unexercised, 'run')} did not stall and are not counted)` : ''}.`;
    },
  });

  // The restoration: from the recovery until latency is back within the maximum, the worst run. A run that never got back is censored.
  const restores = judged.map((run) => ({ run, restore: restoreOf(run, limits) }));
  const never = restores.flatMap((entry) =>
    entry.restore.restored ? [] : [{ run: entry.run, restore: entry.restore }],
  );
  const restoredTimes = restores.flatMap((entry) => (entry.restore.restored ? [entry.restore.atMs] : []));
  const longestObserved = Math.max(0, ...never.map((entry) => entry.restore.observedMs));
  const worstRestore = none ? null : never.length > 0 ? longestObserved : Math.max(...restoredTimes);
  const restoreVerdict = none
    ? ('INCONCLUSIVE' as const)
    : never.length > 0
      ? longestObserved >= limits.latencyRestoreMaxMs
        ? ('NO-GO' as const)
        : ('INCONCLUSIVE' as const)
      : undefined;
  const lastRead = (run: StallRun): number | null =>
    run.after.filter((s) => s.latencyMs !== null).at(-1)?.latencyMs ?? null;
  const levelOf = (run: StallRun): number | null => {
    const tail = run.after.filter(
      (s) => s.latencyMs !== null && s.sinceResumeMs >= run.observedMs - RESTORE_HOLD_MS,
    );
    return tail.length === 0 ? null : median(tail.map((s) => s.latencyMs as number));
  };
  const maxRate = Math.max(1, ...judged.flatMap((run) => run.after.map((s) => s.playbackRate)));
  const restore = evaluation({
    id: 'stall.restore',
    check: 'PB-RDY-003',
    label: `Latency restored after the stall, worst of ${judged.length}`,
    value: worstRestore,
    unit: 'ms',
    limitKey: 'latencyRestoreMaxMs',
    bound: 'at-most',
    limits,
    ...(never.length > 0 ? { censored: true as const } : {}),
    ...(restoreVerdict ? { verdict: restoreVerdict } : {}),
    detail: {
      maxLatencyMs: limits.latencyMaxMs,
      holdMs: RESTORE_HOLD_MS,
      maxPlaybackRate: maxRate,
      runs: judged.map((run) => {
        const restoreOfRun = restoreOf(run, limits);
        const level = levelOf(run);
        return {
          run: run.run,
          latencyBeforeMs: run.latencyBeforeMs,
          restoredAtMs: restoreOfRun.restored ? restoreOfRun.atMs : null,
          finalLatencyMs: lastRead(run),
          sustainedLatencyMs: level,
          lostMs: level === null || run.latencyBeforeMs === null ? null : level - run.latencyBeforeMs,
          observedMs: run.observedMs,
        };
      }),
    },
    sentence: ({ verdict, value, limit }) => {
      if (none) return noneSentence;
      if (never.length > 0) {
        const worst = never[0];
        const final = worst ? lastRead(worst.run) : null;
        const before = worst?.run.latencyBeforeMs ?? null;
        const where =
          final === null
            ? ''
            : ` It stood at ${formatMs(final)} when the observation ended${before === null ? '' : `, ${formatMs(final - before)} further behind than before the outage (${formatMs(before)})`}, against a maximum of ${formatMs(limits.latencyMaxMs)}.`;
        return `Latency was not back within ${formatMs(limits.latencyMaxMs)} in ${plural(never.length, 'run')} of ${judged.length}, ${verdict === 'NO-GO' ? 'after' : 'in only'} ${value} of observation; the limit is ${limit}.${where}`;
      }
      return `Latency was back within ${formatMs(limits.latencyMaxMs)} ${value} after the recovery in the worst of ${plural(judged.length, 'run')}; the limit is ${limit}${maxRate > 1 ? `; the player raised its playback rate to ${maxRate.toFixed(2)} to catch up` : ''}.`;
    },
  });
  // The same restoration asked relative to each run's own steady level before the outage. An advisory line: the criterion of the strategy
  // is the absolute limit above, and which of the two separates a player that came back from one that did not is for part 2 to choose.
  const relatives = judged.map((run) => ({
    run,
    levelMs: run.latencyBeforeMs,
    restore: restoreRelativeOf(run, toleranceMs),
  }));
  const unmeasured = relatives.filter((entry) => entry.restore === null);
  const relativeNever = relatives.flatMap((entry) =>
    entry.restore !== null && !entry.restore.restored
      ? [{ ...entry, observedMs: entry.restore.observedMs }]
      : [],
  );
  const relativeTimes = relatives.flatMap((entry) =>
    entry.restore !== null && entry.restore.restored ? [entry.restore.atMs] : [],
  );
  const relativeLongest = Math.max(0, ...relativeNever.map((entry) => entry.observedMs));
  const cannotJudge = none || unmeasured.length > 0;
  const relativeWorst = cannotJudge
    ? null
    : relativeNever.length > 0
      ? relativeLongest
      : Math.max(...relativeTimes);
  const relativeVerdict = cannotJudge
    ? ('INCONCLUSIVE' as const)
    : relativeNever.length > 0
      ? relativeLongest >= limits.latencyRestoreMaxMs
        ? ('NO-GO' as const)
        : ('INCONCLUSIVE' as const)
      : undefined;
  const disagreements = relatives.flatMap((entry) => {
    if (entry.restore === null || entry.levelMs === null) return [];
    const absolute = restoreOf(entry.run, limits).restored;
    if (absolute === entry.restore.restored) return [];
    return [
      `run ${entry.run.run} was ${absolute ? '' : 'not '}back within the ${formatMs(limits.latencyMaxMs)} of the policy and ${entry.restore.restored ? '' : 'not '}back within ${formatMs(toleranceMs)} of its own level of ${formatMs(entry.levelMs)}`,
    ];
  });
  const relative = evaluation({
    id: 'stall.restore-relative',
    check: 'PB-RDY-003',
    label: `Latency back at its own level after the stall, worst of ${judged.length}`,
    value: relativeWorst,
    unit: 'ms',
    limitKey: 'latencyRestoreMaxMs',
    bound: 'at-most',
    limits,
    scope: 'advisory',
    ...(relativeNever.length > 0 && !cannotJudge ? { censored: true as const } : {}),
    ...(relativeVerdict ? { verdict: relativeVerdict } : {}),
    ...(disagreements.length > 0
      ? {
          note: `The absolute limit and the relative reading disagree: ${disagreements.join('; ')}. Which of the two separates a player that came back from one that did not is chosen from the measured values (docs/decisions/readiness.md, ADR-153); the verdict is the absolute one.`,
        }
      : {}),
    detail: {
      toleranceMs,
      holdMs: RESTORE_HOLD_MS,
      maxLatencyMs: limits.latencyMaxMs,
      runs: relatives.map((entry) => ({
        run: entry.run.run,
        levelBeforeMs: entry.levelMs,
        levelBeforeReadsMs: entry.run.latencyBeforeReadsMs ?? null,
        ceilingMs: entry.levelMs === null ? null : entry.levelMs + toleranceMs,
        restoredAtMs: entry.restore !== null && entry.restore.restored ? entry.restore.atMs : null,
        finalLatencyMs: lastRead(entry.run),
        sustainedLatencyMs: levelOf(entry.run),
        observedMs: entry.run.observedMs,
      })),
    },
    sentence: ({ verdict, value, limit }) => {
      if (none) return noneSentence;
      if (unmeasured.length > 0)
        return `The latency before the outage was not read in ${plural(unmeasured.length, 'run')} of ${judged.length}: there is no level of the player's own to hold it to.`;
      if (relativeNever.length > 0) {
        const worst = relativeNever[0];
        const final = worst ? lastRead(worst.run) : null;
        const where =
          final === null || worst === undefined || worst.levelMs === null
            ? ''
            : ` It stood at ${formatMs(final)} when the observation ended, ${formatMs(final - worst.levelMs)} further behind than before the outage (${formatMs(worst.levelMs)}).`;
        return `Latency was not back within ${formatMs(toleranceMs)} of its own level before the outage in ${plural(relativeNever.length, 'run')} of ${judged.length}, ${verdict === 'NO-GO' ? 'after' : 'in only'} ${value} of observation; the limit is ${limit}.${where}`;
      }
      return `Latency was back within ${formatMs(toleranceMs)} of its own level before the outage ${value} after the recovery in the worst of ${plural(judged.length, 'run')}; the limit is ${limit}.`;
    },
  });
  return [recovery, restore, relative];
}

// ---------------------------------------------------------------------------------------------------------------------
// PB-RDY-004 Manifest cadence

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** Ten gaps are twenty seconds of a two-second cadence: the fewest from which "the longest gap" says more than "the one gap there was". */
export const MIN_CADENCE_GAPS = 10;

/**
 * The gaps between consecutive requests, in order of arrival, leaving out every gap that overlaps an excluded window (an injected fault
 * changes the cadence on purpose: "outside injected faults", docs/CONTRACTS.md and the criterion).
 */
export function gapsOf(arrivalsMs: readonly number[], excluded: readonly TimeWindow[] = []): number[] {
  const sorted = [...arrivalsMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1] as number;
    const to = sorted[i] as number;
    if (excluded.some((window) => from < window.endMs && to > window.startMs)) continue;
    gaps.push(to - from);
  }
  return gaps;
}

export function evaluateManifestCadence(
  arrivalsMs: readonly number[],
  excluded: readonly TimeWindow[] = [],
  limits: Limits = LIVE_LIMITS,
  options: { check?: 'PB-RDY-004' | 'PB-RDY-005'; scope?: Evaluation['scope']; what?: string } = {},
): Evaluation[] {
  const gaps = gapsOf(arrivalsMs, excluded);
  const enough = gaps.length >= MIN_CADENCE_GAPS;
  const check = options.check ?? 'PB-RDY-004';
  const scope = options.scope ?? 'criterion';
  const what = options.what ?? 'manifest';
  const med = gaps.length === 0 ? null : median(gaps);
  const longest = gaps.length === 0 ? null : Math.max(...gaps);
  const detail = {
    requests: arrivalsMs.length,
    gaps: gaps.length,
    minimumGaps: MIN_CADENCE_GAPS,
    periodMs: limits.manifestPeriodMs,
    excludedWindows: excluded.length,
  };
  const tooFew = enough ? {} : { verdict: 'INCONCLUSIVE' as const };
  const fewSentence = `Only ${plural(gaps.length, 'gap')} between ${what} requests were seen (${MIN_CADENCE_GAPS} are needed to judge a cadence).`;
  return [
    evaluation({
      id: 'cadence.median',
      check,
      label: `${what[0]?.toUpperCase()}${what.slice(1)} refresh, median gap`,
      value: med,
      unit: 'ms',
      limitKey: 'manifestMedianGapMinMs',
      bound: 'at-least',
      limits,
      scope,
      detail,
      ...tooFew,
      sentence: ({ verdict, value, limit }) =>
        !enough
          ? `${fewSentence} The median is ${value}.`
          : `The player asked for the ${what} every ${value} at the median over ${plural(gaps.length, 'gap')} (the origin advertises ${formatMs(limits.manifestPeriodMs)}); the limit is ${limit}${verdict === 'GO' ? '.' : ': polling faster than advertised multiplies the load on the origin at the scale of an event.'}`,
    }),
    evaluation({
      id: 'cadence.longest',
      check,
      label: `${what[0]?.toUpperCase()}${what.slice(1)} refresh, longest gap`,
      value: longest,
      unit: 'ms',
      limitKey: 'manifestMaxGapMs',
      bound: 'at-most',
      limits,
      scope,
      detail,
      ...tooFew,
      sentence: ({ verdict, value, limit }) =>
        !enough
          ? `${fewSentence} The longest is ${value}.`
          : `The longest wait between two ${what} requests was ${value}; the limit is ${limit}${verdict === 'GO' ? '.' : ': the player stopped tracking the live window for longer than the criterion allows.'}`,
    }),
  ];
}
