import type { FaultRule } from '../src/shared/faults.ts';
import { LADDER, SEGMENT_DURATION_SEC } from '../src/server/media/specs.ts';

// What makes a condition of an experiment MEASURABLE by the player under test, derived from the ladder and not typed (ADR-095 in
// docs/decisions/e2e-abr.md; the same finding, made for the ABR specs, applies to every experiment that lets Shaka adapt).
//
// Shaka 5.3.3's bandwidth estimator ignores a download that took less than `abr.cacheLoadThreshold` (5 ms by default) and treats it as a
// cache hit: no sample reaches the estimate. On the lab's origin, with no rule, a 75 kB segment arrives in a fraction of a millisecond, so
// whether an engine's estimate hears of the network at all depends on how slow its fetch path is: a property of the machine, not of the
// configuration under test. A condition must therefore make every download last long enough to be measured, for the whole session: either
// a FINITE link (a throttle at a rate the smallest segment cannot beat) or a delay of the first byte.

/** Shaka 5.3.3's `abr.cacheLoadThreshold`: a download faster than this is ignored by the estimator. */
export const SHAKA_CACHE_LOAD_THRESHOLD_MS = 5;

/** A download counts as measurable when it lasts at least this many times the threshold: 6 x 5 ms = 30 ms. */
export const MEASURABLE_MARGIN = 6;

/** The smallest video segment the origin sends, bytes: the lowest rung's bitrate times the segment duration (300 kbps x 2 s = 75 kB). */
export function smallestVideoSegmentBytes(): number {
  const lowest = Math.min(...LADDER.map((rung) => rung.bitrateKbps));
  return (lowest * 1000 * SEGMENT_DURATION_SEC) / 8;
}

/**
 * The fastest link, kbps, on which the smallest video segment still lasts `MEASURABLE_MARGIN` x the threshold: bytes x 8 bits over 30 ms.
 * With the ladder of the lab it is 20,000 kbps, the figure ADR-095 settled on for "unconstrained". Faster than this the estimator may not
 * hear the download; slower is measurable.
 */
export function measurableCeilingKbps(): number {
  return (smallestVideoSegmentBytes() * 8) / (MEASURABLE_MARGIN * SHAKA_CACHE_LOAD_THRESHOLD_MS);
}

/** The shortest first-byte delay, ms, that makes any download measurable on its own: the same 30 ms. */
export function measurableLatencyMs(): number {
  return MEASURABLE_MARGIN * SHAKA_CACHE_LOAD_THRESHOLD_MS;
}

export interface UnmeasuredWindow {
  /** ms from the session's first media request. */
  fromMs: number;
  /** null: until the end of the session. */
  toMs: number | null;
}

/** A rule that applies to every media request (no restriction by track, rung, number or count): the only kind that can make a window measurable. */
function appliesToAllMedia(rule: FaultRule): boolean {
  if (rule.times !== undefined) return false;
  const match = rule.match;
  if (match === undefined) return true;
  const kindOk = match.kind === undefined || match.kind === 'media' || match.kind === 'any';
  return kindOk && match.track === undefined && match.rep === undefined && match.number === undefined;
}

function makesMeasurable(rule: FaultRule): boolean {
  if (!appliesToAllMedia(rule)) return false;
  if (rule.type === 'throttle') return rule.kbps <= measurableCeilingKbps();
  if (rule.type === 'latency') return rule.ms - (rule.jitterMs ?? 0) >= measurableLatencyMs();
  return false;
}

/**
 * The stretches of a session, from its first media request, in which NO rule of the condition makes a download measurable: downloads there
 * may be shorter than the 5 ms Shaka ignores, so what the player knows about the network in that window depends on the speed of the machine.
 * `bandwidth-drop` has one, [0 ms, 8000 ms): its link is unthrottled until the drop. An empty list means the whole session is measurable.
 */
export function unmeasuredWindows(rules: readonly FaultRule[]): UnmeasuredWindow[] {
  const covering = rules
    .filter(makesMeasurable)
    .map((rule) => ({
      from: rule.afterMs ?? 0,
      to: rule.forMs === undefined ? Infinity : (rule.afterMs ?? 0) + rule.forMs,
    }))
    .sort((a, b) => a.from - b.from);
  const windows: UnmeasuredWindow[] = [];
  let reached = 0;
  for (const { from, to } of covering) {
    if (from > reached) windows.push({ fromMs: reached, toMs: from });
    reached = Math.max(reached, to);
    if (reached === Infinity) return windows;
  }
  windows.push({ fromMs: reached, toMs: null });
  return windows;
}

/** One sentence per unmeasured window, for the pre-registration's warnings and the report's limitations. */
export function describeUnmeasured(windows: readonly UnmeasuredWindow[]): string[] {
  return windows.map(({ fromMs, toMs }) => {
    const span = toMs === null ? `from ${fromMs} ms on` : `between ${fromMs} ms and ${toMs} ms`;
    return (
      `media requests are neither throttled to a measurable link (at most ${measurableCeilingKbps()} kbps) nor delayed by ` +
      `${measurableLatencyMs()} ms or more ${span} after the first media request: Shaka ignores downloads under ` +
      `${SHAKA_CACHE_LOAD_THRESHOLD_MS} ms, so what the player learns about the network then depends on how fast this machine serves localhost`
    );
  });
}
