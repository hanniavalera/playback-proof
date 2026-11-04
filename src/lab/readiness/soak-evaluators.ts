import { LIVE_LIMITS } from '../../shared/criteria.ts';
import { median, percentile } from '../measure/stats.ts';
import { evaluateManifestCadence } from './evaluators.ts';
import type { TimeWindow } from './evaluators.ts';
import { fitLine, perHour, pooledSlope, quartileShift } from './regression.ts';
import type { Point } from './regression.ts';
import { aggregate, evaluation, formatMs, plural } from './verdict.ts';
import type { Evaluation, Limits, Verdict } from './verdict.ts';

// The evaluators of PB-RDY-005, the soak (docs/decisions/readiness.md, ADR-155 to ADR-157): pure functions from what a soak recorded to
// evaluations. Every time is epoch milliseconds, so that the player's samples (its page clock plus `performance.timeOrigin`), the
// server's request log (ISO times) and the origin's injected faults (the publication instant of a segment) are on one axis.

export type Engine = 'chromium' | 'firefox' | 'webkit';

/** One read of the player, taken by the in-page sampler at its own cadence. */
export interface SoakSample {
  atMs: number;
  /** `video.currentTime`, seconds. */
  mediaTime: number;
  latencyMs: number | null;
  /** `QAState` at the read. */
  state: string;
  playbackRate: number;
  bufferedAheadSec: number;
  decodedFrames: number;
  droppedFrames: number;
  rebufferCount: number;
  rebufferMs: number;
  edgeSeeks: number;
  /** Errors recorded so far, of any severity. */
  errors: number;
}

/** A stall (`buffering` episode) as the hook reports it, with its start on the epoch axis. */
export interface SoakEpisode {
  startMs: number;
  durationMs: number;
  /** Still open when it was read: it had not ended. */
  ongoing: boolean;
  mediaTime: number;
}

export interface SoakError {
  atMs: number;
  /** 1 recoverable, 2 critical (Shaka's severity). The harness records a crashed page as 2. */
  severity: number;
  code: number;
  codeName?: string;
  source?: string;
  message: string;
}

/** The JS heap of the page after a forced collection (Chromium), with two cheap companions that tell what grew. */
export interface HeapSample {
  atMs: number;
  usedMb: number;
  nodes?: number;
  listeners?: number;
}

/** A condition injected into the origin on purpose, on the epoch axis: the outage itself, not the player's recovery from it. */
export interface FaultWindow {
  kind: 'origin-stall' | 'stale-manifest';
  startMs: number;
  endMs: number;
}

export interface SoakInput {
  engine: Engine;
  /** The first frame of the load, and the end of the observation. */
  firstFrameMs: number;
  endMs: number;
  /** What was asked for, in minutes: the length the policy names. The observation can end sooner (a crash). */
  requestedMinutes: number;
  /** Excluded from the drift, the ratio and the heap baseline. */
  warmupMs: number;
  samples: readonly SoakSample[];
  episodes: readonly SoakEpisode[];
  errors: readonly SoakError[];
  /** The counters at the end of the soak; null when the page could not be read. */
  frames: { decoded: number; dropped: number } | null;
  /** The forced-collection heap series; null where the engine has none (Firefox, WebKit). */
  heap: readonly HeapSample[] | null;
  faults: readonly FaultWindow[];
  /** When the player asked the origin for its manifest (or playlist), epoch ms. */
  manifestArrivalsMs: readonly number[];
}

export type SoakKind = 'release' | 'ci' | 'short';

/** Which policy length a run of `minutes` meets: the release soak, the CI soak, or neither (a harness check, not a verdict). */
export function soakKind(minutes: number, limits: Limits = LIVE_LIMITS): SoakKind {
  if (minutes >= limits.soakMinutesRelease) return 'release';
  if (minutes >= limits.soakMinutesCi) return 'ci';
  return 'short';
}

// ---------------------------------------------------------------------------------------------------------------------
// Fault windows

/**
 * The stretch that an injected fault explains: from its start until the player has had the stall-recovery limit to get going again
 * after the origin returned. A stall or an error that begins in it is the fault's; one that begins outside it is not.
 */
export function explainedWindows(faults: readonly FaultWindow[], limits: Limits = LIVE_LIMITS): TimeWindow[] {
  return faults.map((fault) => ({ startMs: fault.startMs, endMs: fault.endMs + limits.stallRecoveryMaxMs }));
}

/**
 * The stretch the drift fit stays out of: the explained one plus the time the policy allows the player to get back to the live edge. A
 * player that catches up after an outage is not drifting, and its ramp must not be read as a slope.
 */
export function settlingWindows(faults: readonly FaultWindow[], limits: Limits = LIVE_LIMITS): TimeWindow[] {
  return faults.map((fault) => ({
    startMs: fault.startMs,
    endMs: fault.endMs + limits.stallRecoveryMaxMs + limits.latencyRestoreMaxMs,
  }));
}

const inside = (windows: readonly TimeWindow[], atMs: number): boolean =>
  windows.some((window) => atMs >= window.startMs && atMs < window.endMs);

// ---------------------------------------------------------------------------------------------------------------------
// Unrecovered stalls

/** A media clock that moved less than this between two reads has not moved (a decoder's rounding, not playback). */
export const FROZEN_EPSILON_SEC = 0.05;

interface Interval {
  startMs: number;
  endMs: number;
  /** Why it counts: what the reader should go and look at. */
  why: string;
}

/**
 * The stretches in which the player was stalled for longer than the stall-recovery limit, or is stalled still. Two witnesses, because
 * either can miss: the hook's `buffering` episodes (which leave out a stall that begins inside one of the player's own seeks, METRICS.md),
 * and the media clock itself, which a hung player stops moving whatever the hook thinks of it.
 */
export function unrecoveredStalls(
  episodes: readonly SoakEpisode[],
  samples: readonly SoakSample[],
  limits: Limits = LIVE_LIMITS,
): Interval[] {
  const found: Interval[] = [];
  for (const episode of episodes) {
    if (episode.ongoing || episode.durationMs > limits.stallRecoveryMaxMs) {
      found.push({
        startMs: episode.startMs,
        endMs: episode.startMs + episode.durationMs,
        why: episode.ongoing
          ? `a stall at media time ${episode.mediaTime.toFixed(1)} s that never ended (${formatMs(episode.durationMs)} when it was last read)`
          : `a stall of ${formatMs(episode.durationMs)} at media time ${episode.mediaTime.toFixed(1)} s`,
      });
    }
  }
  let runStart: SoakSample | null = null;
  const closeRun = (last: SoakSample): void => {
    if (runStart && last.atMs - runStart.atMs > limits.stallRecoveryMaxMs) {
      found.push({
        startMs: runStart.atMs,
        endMs: last.atMs,
        why: `a media clock that stood at ${runStart.mediaTime.toFixed(1)} s for ${formatMs(last.atMs - runStart.atMs)}`,
      });
    }
  };
  let previous: SoakSample | null = null;
  for (const sample of samples) {
    const playing = sample.state !== 'paused' && sample.state !== 'ended' && sample.state !== 'idle';
    if (!playing) {
      if (previous) closeRun(previous);
      runStart = null;
    } else if (runStart && Math.abs(sample.mediaTime - runStart.mediaTime) <= FROZEN_EPSILON_SEC) {
      // still frozen: the run goes on
    } else {
      if (previous && runStart) closeRun(previous);
      runStart = sample;
    }
    previous = sample;
  }
  if (previous) closeRun(previous);

  found.sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [];
  for (const interval of found) {
    const last = merged.at(-1);
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
      last.why = `${last.why}; ${interval.why}`;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function evaluateUnrecoveredStalls(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const stalls = unrecoveredStalls(input.episodes, input.samples, limits);
  const count = stalls.length;
  const all = input.episodes.length;
  return evaluation({
    id: 'soak.stalls',
    check: 'PB-RDY-005',
    label: 'Unrecovered stalls',
    value: count,
    unit: 'count',
    limitKey: 'maxUnrecoveredStalls',
    bound: 'at-most',
    limits,
    detail: {
      stallRecoveryMaxMs: limits.stallRecoveryMaxMs,
      episodes: all,
      longestEpisodeMs: all === 0 ? 0 : Math.max(...input.episodes.map((episode) => episode.durationMs)),
      unrecovered: stalls.map((stall) => ({ startMs: stall.startMs, endMs: stall.endMs, why: stall.why })),
    },
    sentence: ({ verdict, limit }) =>
      verdict === 'GO'
        ? `${plural(all, 'stall')} in the soak, none longer than the ${formatMs(limits.stallRecoveryMaxMs)} the player is allowed to take to get going again, none still open at the end (${count} unrecovered; the limit is ${limit}).`
        : `The player was stalled and did not get going within ${formatMs(limits.stallRecoveryMaxMs)} ${plural(count, 'time')}: ${stalls.map((stall) => stall.why).join('; ')}. A stall that outlasts the limit is a hung player.`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors

const describeError = (error: SoakError): string =>
  `${error.codeName ?? 'error'} (code ${error.code}, severity ${error.severity}${error.source ? `, ${error.source}` : ''})`;

export function evaluateCriticalErrors(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const critical = input.errors.filter((error) => error.severity >= 2);
  return evaluation({
    id: 'soak.critical-errors',
    check: 'PB-RDY-005',
    label: 'Critical errors',
    value: critical.length,
    unit: 'count',
    limitKey: 'maxCriticalErrors',
    bound: 'at-most',
    limits,
    detail: {
      critical: critical.map((error) => ({
        atMs: error.atMs,
        error: describeError(error),
        message: error.message,
      })),
    },
    sentence: ({ verdict, limit }) =>
      verdict === 'GO'
        ? `No critical error in the soak (the limit is ${limit}): nothing ended a viewing session.`
        : `${plural(critical.length, 'critical error')}, each of which ends a viewing session: ${critical.map(describeError).join('; ')}. The first: ${critical[0]?.message ?? ''}`,
  });
}

/**
 * Errors of any severity that no injected fault explains. TEST_STRATEGY.md section 8 says that anything outside an injected fault window
 * fails the soak, and `LIVE_LIMITS` has no number for it: zero tolerance is its own, so it is judged against the critical-error limit,
 * which is also zero. A recoverable error is a signal the soak exists to find (a retried segment, a manifest that did not arrive).
 */
export function evaluateUnexplainedErrors(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const windows = explainedWindows(input.faults, limits);
  const unexplained = input.errors.filter((error) => !inside(windows, error.atMs));
  return evaluation({
    id: 'soak.unexplained-errors',
    check: 'PB-RDY-005',
    label: 'Errors outside injected faults',
    value: unexplained.length,
    unit: 'count',
    limitKey: 'maxCriticalErrors',
    bound: 'at-most',
    limits,
    detail: {
      total: input.errors.length,
      explainedByFaults: input.errors.length - unexplained.length,
      unexplained: unexplained.map((error) => ({
        atMs: error.atMs,
        error: describeError(error),
        message: error.message,
      })),
    },
    sentence: ({ verdict }) =>
      verdict === 'GO'
        ? `${plural(input.errors.length, 'error')} in the soak, ${input.errors.length === 0 ? 'none to explain' : 'all inside an injected fault'}.`
        : `${plural(unexplained.length, 'error')} that no injected fault explains: ${unexplained.map(describeError).join('; ')}. The first: ${unexplained[0]?.message ?? ''}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Rebuffer ratio

function overlapMs(window: TimeWindow, from: number, to: number): number {
  return Math.max(0, Math.min(window.endMs, to) - Math.max(window.startMs, from));
}

/**
 * Stall time outside the injected faults over the time observed outside them, after the warm-up. METRICS.md defines the ratio as stall
 * time over stall time plus time playing; a soak never pauses or seeks, so what is not stalled is playing and the two denominators
 * are the same time.
 */
export function evaluateRebufferRatio(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const from = input.firstFrameMs + input.warmupMs;
  const faults = explainedWindows(input.faults, limits);
  const faultMs = faults.reduce((sum, window) => sum + overlapMs(window, from, input.endMs), 0);
  const observedMs = input.endMs - from - faultMs;
  const counted = input.episodes.filter(
    (episode) => episode.startMs >= from && !inside(faults, episode.startMs),
  );
  const stalledMs = counted.reduce((sum, episode) => sum + episode.durationMs, 0);
  const ratio = observedMs > 0 ? stalledMs / observedMs : null;
  return evaluation({
    id: 'soak.rebuffer-ratio',
    check: 'PB-RDY-005',
    label: 'Rebuffer ratio',
    value: ratio,
    unit: 'ratio',
    limitKey: 'maxRebufferRatio',
    bound: 'at-most',
    limits,
    detail: {
      observedMs,
      stalledMs,
      episodesCounted: counted.length,
      episodesInWarmupOrExplained: input.episodes.length - counted.length,
      warmupMs: input.warmupMs,
    },
    sentence: ({ verdict, value, limit }) =>
      ratio === null
        ? `No time was observed after the ${formatMs(input.warmupMs)} warm-up: the ratio cannot be judged.`
        : `${plural(counted.length, 'stall')} outside the injected faults, ${formatMs(stalledMs)} in ${formatMs(observedMs)} observed after the warm-up: a rebuffer ratio of ${value}; the limit is ${limit}${verdict === 'GO' ? '.' : ': viewers lost more of the event to stalls than the criterion allows.'}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Latency drift

/** Two minutes of fault-free samples are the least from which the fitted slope is small against the limit (ADR-156). */
export const MIN_DRIFT_SPAN_MS = 120_000;
/** A stretch with fewer reads than this cannot say which way latency was going. */
export const MIN_SEGMENT_SAMPLES = 3;
export const MIN_DRIFT_SAMPLES = 12;

/**
 * The fault-free stretches of the series after the warm-up: the samples outside the settling window of every injected fault, split where a
 * fault was, each with its latency. A sample without a latency (no live edge) is not a point of the series.
 */
export function driftSegments(input: SoakInput, limits: Limits = LIVE_LIMITS): Point[][] {
  const from = input.firstFrameMs + input.warmupMs;
  const cuts = settlingWindows(input.faults, limits).sort((a, b) => a.startMs - b.startMs);
  const segments: Point[][] = [[]];
  for (const sample of input.samples) {
    if (sample.atMs < from || sample.latencyMs === null) continue;
    if (inside(cuts, sample.atMs)) {
      if ((segments.at(-1)?.length ?? 0) > 0) segments.push([]);
      continue;
    }
    segments.at(-1)?.push({ x: sample.atMs, y: sample.latencyMs });
  }
  return segments.filter((segment) => segment.length >= MIN_SEGMENT_SAMPLES);
}

/**
 * The drift: the slope of the least-squares line through the latency reads, in ms per hour, with the level it starts from, judged as the
 * change that slope makes over the length of the soak after the warm-up. A flat series at any level has a slope of zero, so a player
 * that sits steadily 10 s behind is not "drifting" (that is a finding of PB-RDY-003); a series that climbs is, whatever it started at.
 * With an injected fault the series is fitted in stretches that share one slope and have a level each, so the step an outage leaves is
 * not read as a slope. Both signs count: a latency that falls steadily is a media clock running fast, which ends at the edge.
 */
export function evaluateLatencyDrift(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const segments = driftSegments(input, limits);
  const points = segments.reduce((sum, segment) => sum + segment.length, 0);
  const evidenceMs = segments.reduce(
    (sum, segment) => sum + ((segment.at(-1)?.x ?? 0) - (segment[0]?.x ?? 0)),
    0,
  );
  const spanMs = input.endMs - (input.firstFrameMs + input.warmupMs);
  const enough = points >= MIN_DRIFT_SAMPLES && evidenceMs >= MIN_DRIFT_SPAN_MS;
  const fit = segments.length === 1 ? fitLine(segments[0] as Point[]) : null;
  const pooled = pooledSlope(segments);
  const slopePerMs = pooled?.slope ?? null;
  const driftMs = slopePerMs === null ? null : Math.abs(slopePerMs * spanMs);
  const latencies = segments.flat().map((point) => point.y);
  return evaluation({
    id: 'soak.latency-drift',
    check: 'PB-RDY-005',
    label: 'Latency drift',
    value: enough ? driftMs : null,
    unit: 'ms',
    limitKey: 'maxLatencyDriftMs',
    bound: 'at-most',
    limits,
    detail: {
      slopeMsPerHour: slopePerMs === null ? null : perHour(slopePerMs),
      fittedChangeMs: slopePerMs === null ? null : slopePerMs * spanMs,
      spanMs,
      evidenceMs,
      samples: points,
      minimumSamples: MIN_DRIFT_SAMPLES,
      minimumEvidenceMs: MIN_DRIFT_SPAN_MS,
      stretches:
        pooled?.segments.map((segment) => ({
          fromMs: segment.firstX,
          toMs: segment.lastX,
          samples: segment.n,
          levelAtStartMs: segment.intercept,
          meanMs: segment.meanY,
          residualSdMs: segment.residualSd,
          ownSlopeMsPerHour: perHour(segment.ownSlope),
        })) ?? [],
      quartileShiftMs: segments.length === 1 ? quartileShift(latencies) : null,
      rSquared: fit?.r2 ?? null,
    },
    ...(enough ? {} : { verdict: 'INCONCLUSIVE' as const }),
    sentence: ({ verdict, value, limit }) => {
      if (!enough || slopePerMs === null)
        return `Only ${plural(points, 'latency read')} over ${formatMs(evidenceMs)} of fault-free soak after the warm-up (at least ${MIN_DRIFT_SAMPLES} reads over ${formatMs(MIN_DRIFT_SPAN_MS)} are needed): the drift cannot be judged.`;
      const level = pooled?.segments[0]?.intercept ?? 0;
      return `Latency changed by ${value} over the ${formatMs(spanMs)} after the warm-up (a slope of ${perHour(slopePerMs) >= 0 ? '+' : ''}${Math.round(perHour(slopePerMs)).toLocaleString('en-US')} ms/h from a level of ${formatMs(level)}); the limit is ${limit}${verdict === 'GO' ? '.' : ': the playhead is slipping away from the live edge.'}`;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Heap

/** Readings at each end of the series that are averaged, so that one reading cannot be the baseline or the end. At most this many. */
const HEAP_EDGE_READS = 3;
const MIN_HEAP_READS = 4;

/**
 * The growth of the JS heap after a forced collection, from the end of the warm-up to the end of the soak: the median of the first
 * readings after the warm-up against the median of the last ones (a collection can land on a trough or a peak, one reading is not a
 * level). The trend of the whole series is next to it, so that a steady climb can be told from one step. Chromium only; elsewhere the
 * criterion does not apply.
 */
export function evaluateHeapGrowth(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  if (input.heap === null) {
    return evaluation({
      id: 'soak.heap-growth',
      check: 'PB-RDY-005',
      label: 'JS heap growth',
      value: null,
      unit: 'MB',
      limitKey: 'maxHeapGrowthMb',
      bound: 'at-most',
      limits,
      verdict: 'N/A',
      detail: { engine: input.engine },
      sentence: () =>
        `Not measured in ${input.engine}: only Chromium can force a collection and read the JS heap (DevTools protocol). The soak is judged on the other signals here.`,
    });
  }
  const from = input.firstFrameMs + input.warmupMs;
  const reads = input.heap.filter((read) => read.atMs >= from).sort((a, b) => a.atMs - b.atMs);
  if (reads.length < MIN_HEAP_READS) {
    return evaluation({
      id: 'soak.heap-growth',
      check: 'PB-RDY-005',
      label: 'JS heap growth',
      value: null,
      unit: 'MB',
      limitKey: 'maxHeapGrowthMb',
      bound: 'at-most',
      limits,
      verdict: 'INCONCLUSIVE',
      detail: { reads: reads.length, minimumReads: MIN_HEAP_READS },
      sentence: () =>
        `Only ${plural(reads.length, 'heap reading')} after the warm-up (at least ${MIN_HEAP_READS} are needed): the growth cannot be judged.`,
    });
  }
  const edge = Math.min(HEAP_EDGE_READS, Math.floor(reads.length / 3));
  const baseline = median(reads.slice(0, edge).map((read) => read.usedMb));
  const final = median(reads.slice(-edge).map((read) => read.usedMb));
  const trend = fitLine(reads.map((read) => ({ x: read.atMs, y: read.usedMb })));
  const growth = final - baseline;
  const first = reads[0];
  const last = reads.at(-1);
  return evaluation({
    id: 'soak.heap-growth',
    check: 'PB-RDY-005',
    label: 'JS heap growth',
    value: growth,
    unit: 'MB',
    limitKey: 'maxHeapGrowthMb',
    bound: 'at-most',
    limits,
    detail: {
      baselineMb: baseline,
      finalMb: final,
      reads: reads.length,
      edgeReads: edge,
      minMb: Math.min(...reads.map((read) => read.usedMb)),
      maxMb: Math.max(...reads.map((read) => read.usedMb)),
      trendMbPerHour: trend === null ? null : perHour(trend.slope),
      levelAtStartMb: trend?.intercept ?? null,
      nodesFirst: first?.nodes ?? null,
      nodesLast: last?.nodes ?? null,
      listenersFirst: first?.listeners ?? null,
      listenersLast: last?.listeners ?? null,
    },
    sentence: ({ verdict, limit }) =>
      `The JS heap after a forced collection went from ${baseline.toFixed(1)} MB after the warm-up to ${final.toFixed(1)} MB at the end (${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB over ${plural(reads.length, 'reading')}${trend ? `, a trend of ${perHour(trend.slope) >= 0 ? '+' : ''}${perHour(trend.slope).toFixed(1)} MB/h` : ''}); the limit is ${limit}${verdict === 'GO' ? '.' : ': memory the player keeps and does not give back.'}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Dropped frames

export function evaluateDroppedFrames(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const frames = input.frames;
  const ratio = frames !== null && frames.decoded > 0 ? frames.dropped / frames.decoded : null;
  return evaluation({
    id: 'soak.dropped-frames',
    check: 'PB-RDY-005',
    label: 'Dropped frame ratio',
    value: ratio,
    unit: 'ratio',
    limitKey: 'maxDroppedFrameRatio',
    bound: 'at-most',
    limits,
    detail: { decoded: frames?.decoded ?? null, dropped: frames?.dropped ?? null },
    sentence: ({ verdict, value, limit }) =>
      ratio === null
        ? 'The page decoded no frames, or could not be read at the end: the dropped-frame ratio cannot be judged.'
        : `${plural(frames?.dropped ?? 0, 'frame')} dropped of ${(frames?.decoded ?? 0).toLocaleString('en-US')} decoded, a ratio of ${value}; the limit is ${limit}${verdict === 'GO' ? '.' : ': the picture stuttered more than the criterion allows.'}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Length

/**
 * Whether the soak lasted as long as a policy soak: the observation, from the first frame to its end, against the CI soak's length.
 * Shorter is not a defect of the build, it is a run that cannot certify one, so the verdict is INCONCLUSIVE and never NO-GO.
 */
export function evaluateSoakLength(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation {
  const minutes = (input.endMs - input.firstFrameMs) / 60_000;
  const kind = soakKind(minutes, limits);
  return evaluation({
    id: 'soak.length',
    check: 'PB-RDY-005',
    label: 'Soak length',
    value: minutes,
    unit: 'min',
    limitKey: 'soakMinutesCi',
    bound: 'at-least',
    limits,
    verdict: kind === 'short' ? 'INCONCLUSIVE' : 'GO',
    detail: { kind, requestedMinutes: input.requestedMinutes, releaseMinutes: limits.soakMinutesRelease },
    sentence: ({ value }) =>
      kind === 'short'
        ? `The soak watched ${value}, shorter than the ${limits.soakMinutesCi} min CI soak: its numbers are reported and it is not a verdict.`
        : kind === 'ci'
          ? `The soak watched ${value}: a CI soak (${limits.soakMinutesCi} min). It is not the release soak (${limits.soakMinutesRelease} min).`
          : `The soak watched ${value}: a release soak (${limits.soakMinutesRelease} min or more).`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything about a soak

/** Latency p95 and maximum after the warm-up and outside the injected faults: the numbers of PB-RDY-002, for a reader of the soak. */
export function advisoryLatency(input: SoakInput, limits: Limits = LIVE_LIMITS): Evaluation[] {
  const from = input.firstFrameMs + input.warmupMs;
  const windows = settlingWindows(input.faults, limits);
  const reads = input.samples.flatMap((sample) =>
    sample.atMs >= from && !inside(windows, sample.atMs) && sample.latencyMs !== null
      ? [sample.latencyMs]
      : [],
  );
  const p95 = reads.length === 0 ? null : percentile(reads, 0.95);
  const max = reads.length === 0 ? null : Math.max(...reads);
  const detail = {
    reads: reads.length,
    note: 'after the warm-up, outside the injected faults and the time the player is given to settle after them',
  };
  const lacking = reads.length === 0 ? { verdict: 'INCONCLUSIVE' as const } : {};
  return [
    evaluation({
      id: 'soak.latency-p95',
      check: 'PB-RDY-005',
      label: 'Latency, p95',
      value: p95,
      unit: 'ms',
      limitKey: 'latencyP95MaxMs',
      bound: 'at-most',
      limits,
      scope: 'advisory',
      detail,
      ...lacking,
      sentence: ({ value, limit }) =>
        `Latency at the 95th percentile over the soak: ${value} (${limit}). Judged by PB-RDY-002; here as evidence.`,
    }),
    evaluation({
      id: 'soak.latency-max',
      check: 'PB-RDY-005',
      label: 'Latency, maximum',
      value: max,
      unit: 'ms',
      limitKey: 'latencyMaxMs',
      bound: 'at-most',
      limits,
      scope: 'advisory',
      detail,
      ...lacking,
      sentence: ({ value, limit }) =>
        `The largest latency outside the faults: ${value} (${limit}). Judged by PB-RDY-002; here as evidence.`,
    }),
  ];
}

export interface SoakEvaluation {
  kind: SoakKind;
  verdict: Verdict;
  evaluations: Evaluation[];
}

/**
 * The verdict of the soak and every line behind it. The criteria are those of the PB-RDY-005 row (stalls, critical errors, rebuffer ratio,
 * drift, heap, dropped frames) plus the errors no fault explains and the length; the advisory lines (latency, the manifest cadence over the
 * soak) are evidence and decide nothing.
 */
export function evaluateSoak(input: SoakInput, limits: Limits = LIVE_LIMITS): SoakEvaluation {
  const evaluations = [
    evaluateSoakLength(input, limits),
    evaluateUnrecoveredStalls(input, limits),
    evaluateCriticalErrors(input, limits),
    evaluateUnexplainedErrors(input, limits),
    evaluateRebufferRatio(input, limits),
    evaluateLatencyDrift(input, limits),
    evaluateHeapGrowth(input, limits),
    evaluateDroppedFrames(input, limits),
    ...advisoryLatency(input, limits),
    ...evaluateManifestCadence(input.manifestArrivalsMs, explainedWindows(input.faults, limits), limits, {
      check: 'PB-RDY-005',
      scope: 'advisory',
      what: 'manifest',
    }),
  ];
  return {
    kind: soakKind((input.endMs - input.firstFrameMs) / 60_000, limits),
    verdict: aggregate(evaluations),
    evaluations,
  };
}
