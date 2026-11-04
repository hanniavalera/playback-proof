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

/** `v720 #9, v240 #11`: video segment requests as a line of a failure message. */
export function describeSegments(entries: readonly RequestLogEntry[], last = 12): string {
  if (entries.length === 0) return 'none';
  const shown = entries.slice(-last).map((entry) => `${entry.rep} #${entry.number}`);
  return `${entries.length > last ? `... ${shown.join(', ')}` : shown.join(', ')}`;
}
