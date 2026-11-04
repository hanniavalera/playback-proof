import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { Ladder } from './ladder.ts';
import { rungOf } from './ladder.ts';
import { videoSegmentRequests } from './log.ts';

// PB-ABR-007: do the two accounts of the same session tell the same story? The player's (`qa.metrics().bitrate.history`: which rung it
// says it was on, and when it changed) and the origin's (`request log`: which rung's segments it was asked for, in which order).
// The comparison is a function of two lists, so that it can be tested without a browser, on stories that agree and on stories that do
// not (tests/unit/e2e-abr).

/** One entry of `metrics.bitrate.history`, with the rung's height. `t` is the page clock, ms. */
export interface HistoryEntry {
  t: number;
  height: number;
  reason: 'start' | 'abr' | 'manual';
}

/** A stretch of consecutive video segment requests for the same rung, in arrival order. */
export interface Run {
  rep: string;
  height: number;
  /** The first segment request of the stretch. */
  first: RequestLogEntry;
  requests: number;
}

/**
 * How the clock of the page and the clock of the origin are put side by side. Both tick at the same rate, they only disagree on the
 * origin of time: the manifest request is the one event both sides saw. The page's `load-requested` was recorded before the request
 * was made and the origin received it before the page's `manifest-loaded`, so the origin's arrival time of the manifest is
 * between the page's `load-requested` and `load-requested + manifestMs`: an uncertainty of `manifestMs`, which is a few ms.
 */
export interface Anchor {
  /** Page clock of `load-requested`, ms. */
  loadT: number;
  /** `msSinceStart` of the manifest request in the origin's log. */
  manifestAtMs: number;
  /** Page clock: `load-requested` to `manifest-loaded` (`metrics.startup.manifestMs`), ms. */
  manifestMs: number;
}

/**
 * Margin, ms, on each side of the alignment of the two clocks, for what the model does not capture: the page's timers are rounded to a
 * millisecond (a little more in some engines), the origin logs whole milliseconds, and the two processes read the system clock at
 * different moments. Those are a few ms; the effect looked for is a hook that stamps a change seconds late.
 */
export const CLOCK_SLACK_MS = 25;

/** The video segment requests as runs of one rung each (`v720 x 10, v360 x 3, v240 x 12`), in arrival order. */
export function rungRuns(log: readonly RequestLogEntry[], ladder: Ladder): Run[] {
  const runs: Run[] = [];
  for (const entry of videoSegmentRequests(log)) {
    const last = runs.at(-1);
    if (last && last.rep === entry.rep) {
      last.requests += 1;
    } else {
      runs.push({
        rep: entry.rep as string,
        height: rungOf(ladder, { rep: entry.rep as string }).height,
        first: entry,
        requests: 1,
      });
    }
  }
  return runs;
}

/**
 * Everything on which the two accounts disagree; an empty list when they agree. They agree when:
 *  1. The origin's rungs are the player's, in order. The player may name a rung the origin never saw a segment of, only when the
 *     player left it within one segment duration (it was chosen at the start and changed at once: no segment can have been asked
 *     for), and never the rung it ends on; the origin may not see a rung the player never named, or in another order.
 *  2. A change that the player made itself (`abr`, `manual`, not the initial selection, which the hook records once the load has
 *     resolved, a moment after the first requests) was not already acted on at the origin: the first request of the new rung is not
 *     earlier than the player says it switched (to within the alignment of the two clocks).
 *  3. ... and it was acted on within one segment: Shaka aborts the request in flight when the new segment is the smaller one, and
 *     otherwise lets it finish, which is less than one segment of the new rung; with a full buffer it waits for the next segment's turn,
 *     at most one segment of playback. So the first request of the new rung is at most `segmentDurationSec` after the change.
 */
export interface HistoryComparison {
  /** Every disagreement, as a sentence; empty when the two accounts agree. */
  problems: string[];
  /** For each change the player made itself that the origin acted on: how long after the player's timestamp the first request of the new rung came (aligned by the manifest, so +- a few ms). */
  lags: Array<{ height: number; reason: string; lagMs: number }>;
}

export function compareHistoryWithLog(input: {
  history: readonly HistoryEntry[];
  runs: readonly Run[];
  anchor: Anchor;
  segmentDurationSec: number;
}): HistoryComparison {
  const { history, runs, anchor, segmentDurationSec } = input;
  const lagMs = segmentDurationSec * 1000;
  const problems: string[] = [];
  const lags: HistoryComparison['lags'] = [];
  const describeHistory = (): string => history.map((entry) => `${entry.height}p`).join(' > ') || 'empty';
  const describeRuns = (): string =>
    runs.map((run) => `${run.height}p x ${run.requests}`).join(' > ') || 'empty';

  // The player's time of an entry as a range of the origin's time: the uncertainty of the anchor is on the early side.
  const originTimeMs = (t: number): { earliest: number; latest: number } => {
    const latest = anchor.manifestAtMs + (t - anchor.loadT) + CLOCK_SLACK_MS;
    return { earliest: latest - anchor.manifestMs - 2 * CLOCK_SLACK_MS, latest };
  };

  let next = 0; // the first history entry that a run has not claimed yet
  const claimed: Array<{ entry: HistoryEntry; run: Run }> = [];
  for (const run of runs) {
    const at = history.findIndex((entry, index) => index >= next && entry.height === run.height);
    if (at < 0) {
      problems.push(
        `the origin was asked for ${run.rep} (${run.requests} segments from #${run.first.number}, request #${run.first.seq}) ` +
          `but the player's history has no ${run.height}p from there on: the player says ${describeHistory()}, the origin saw ${describeRuns()}`,
      );
      continue;
    }
    for (let skipped = next; skipped < at; skipped += 1) {
      const entry = history[skipped] as HistoryEntry;
      const left = (history[skipped + 1] as HistoryEntry).t;
      if (left - entry.t >= lagMs) {
        problems.push(
          `the player's history has ${entry.height}p for ${((left - entry.t) / 1000).toFixed(1)} s (a segment lasts ${segmentDurationSec} s) ` +
            `but the origin was never asked for a segment of it: the player says ${describeHistory()}, the origin saw ${describeRuns()}`,
        );
      }
    }
    claimed.push({ entry: history[at] as HistoryEntry, run });
    next = at + 1;
  }
  for (let rest = next; rest < history.length; rest += 1) {
    const entry = history[rest] as HistoryEntry;
    problems.push(
      `the player's history ends with ${entry.height}p (${entry.reason}) but the origin was not asked for a segment of it after ${runs.at(-1)?.height ?? 'any'}p: ` +
        `the player says ${describeHistory()}, the origin saw ${describeRuns()}`,
    );
  }

  for (const { entry, run } of claimed) {
    if (entry.reason === 'start') continue;
    const { earliest, latest } = originTimeMs(entry.t);
    const asked = run.first.msSinceStart;
    lags.push({
      height: entry.height,
      reason: entry.reason,
      lagMs: Math.round(asked - (latest - CLOCK_SLACK_MS)),
    });
    if (asked < earliest) {
      problems.push(
        `the origin was asked for ${run.rep} at ${asked} ms, ${Math.round(earliest - asked)} ms before the player says it switched to ${entry.height}p ` +
          `(${entry.reason}, not before ${Math.round(earliest)} ms of the origin's clock): the player's timestamp is late`,
      );
    } else if (asked > latest + lagMs) {
      problems.push(
        `the first ${run.rep} segment was requested ${Math.round(asked - latest)} ms after the player says it switched to ${entry.height}p ` +
          `(${entry.reason}), more than the ${lagMs} ms of one segment: the player's timestamp is early, or it kept fetching the old rung`,
      );
    }
  }
  return { problems, lags };
}
