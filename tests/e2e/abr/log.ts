import type { RequestLogEntry } from '../../../src/shared/api.ts';
import { requestsFor } from '../support/waiting.ts';

// Reading the request log the way the ABR specs need: the video segments the origin was asked for, in the order they arrived. The
// log is the independent truth about which rung was fetched (the player's own history is the other channel, PB-ABR-007).

const VIDEO_REP = /^v\d+$/;

export const isVideoRep = (rep: string | undefined): rep is string =>
  rep !== undefined && VIDEO_REP.test(rep);

/** The requests for video media segments (init segments excluded), in arrival order, whatever their outcome. */
export function videoSegmentRequests(log: readonly RequestLogEntry[]): RequestLogEntry[] {
  return requestsFor(log, { kind: 'segment' }).filter((entry) => isVideoRep(entry.rep));
}

/** The entries from the first one of `rep` on (empty when there is none): "from the first v240 segment on, nothing else was asked for". */
export function fromFirstOf(entries: readonly RequestLogEntry[], rep: string): RequestLogEntry[] {
  const first = entries.findIndex((entry) => entry.rep === rep);
  return first < 0 ? [] : entries.slice(first);
}

/** `v720 #9, v240 #11`: video segment requests as a line of a failure message. */
export function describeSegments(entries: readonly RequestLogEntry[], last = 12): string {
  if (entries.length === 0) return 'none';
  const shown = entries.slice(-last).map((entry) => `${entry.rep} #${entry.number}`);
  return `${entries.length > last ? `... ${shown.join(', ')}` : shown.join(', ')}`;
}

/**
 * The responses that are the origin's failure and not the player's doing: a status of 400 or more, or a response the origin cut or could
 * not write. A request the player cancelled (it does so whenever it switches rung: `abortReason` `client-closed`) is not one.
 */
export function originFailures(log: readonly RequestLogEntry[]): RequestLogEntry[] {
  return log.filter(
    (entry) => entry.status >= 400 || (entry.aborted === true && entry.abortReason !== 'client-closed'),
  );
}

/**
 * The media segments of the audio stream that the origin was asked for more than once, as `a-aac #10`. Shaka asks again for a segment
 * only when something cancelled it: a failed request, a seek, or a forced switch. `Player.disableStream` (which the dropped-frame
 * protection calls) switches with `force`, and `StreamingEngine.switchInternal_` then switches the audio stream again too, although it
 * does not change, and cancels the request in flight; the adaptation's own switch does not touch the audio stream. So in a load with no
 * failed request, no error and no seek, a repeated audio segment is the mark of a forced switch (ADR-106, amendment 3).
 */
export function repeatedAudioSegments(log: readonly RequestLogEntry[]): string[] {
  const asked = new Map<string, number>();
  for (const entry of requestsFor(log, { kind: 'segment' })) {
    if (entry.rep === undefined || entry.number === undefined || isVideoRep(entry.rep)) continue;
    const key = `${entry.rep} #${entry.number}`;
    asked.set(key, (asked.get(key) ?? 0) + 1);
  }
  return [...asked].filter(([, times]) => times > 1).map(([key]) => key);
}

/**
 * The media time at which the first segment of `rep` that was asked for starts, or null when none was: segment `n` of a stream of
 * segments of `segmentDurationSec` covers [(n - 1) d, n d), so the playhead enters the rung (the one the player stepped down to, or
 * the one it climbed to) at that time.
 */
export function firstSegmentStart(
  log: readonly RequestLogEntry[],
  rep: string,
  segmentDurationSec: number,
): number | null {
  const numbers = videoSegmentRequests(log)
    .filter((entry) => entry.rep === rep && entry.number !== undefined)
    .map((entry) => entry.number as number);
  if (numbers.length === 0) return null;
  return (Math.min(...numbers) - 1) * segmentDurationSec;
}
