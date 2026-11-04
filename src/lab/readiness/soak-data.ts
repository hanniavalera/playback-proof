import type { RequestLogEntry } from '../../shared/api.ts';
import type { QAMetrics } from '../../shared/qa.ts';
import type { RequestDigest } from './report.ts';
import type { FaultWindow, SoakEpisode, SoakError } from './soak-evaluators.ts';

// The conversions between what the page and the service report and what the soak evaluators take: the epoch axis for every time, the
// origin's injected conditions as windows, and the digest of the request log that a soak keeps instead of the log itself (it holds the
// last 5,000 requests, and a long soak must not lose the early ones to the cap or keep them all).

/** The player's stalls on the epoch axis. `QAMetrics.rebuffer.events[].startMs` is the page's clock, whose zero is `timeOrigin`. */
export function episodesOf(metrics: QAMetrics, timeOrigin: number): SoakEpisode[] {
  return metrics.rebuffer.events.map((event) => ({
    startMs: timeOrigin + event.startMs,
    durationMs: event.durationMs,
    ongoing: event.ongoing,
    mediaTime: event.mediaTime,
  }));
}

/** Every error the hook recorded since the page booted, on the epoch axis. */
export function errorsOf(metrics: QAMetrics, timeOrigin: number): SoakError[] {
  return metrics.errors.map((error) => ({
    atMs: timeOrigin + error.t,
    severity: error.severity,
    code: error.code,
    ...(error.codeName ? { codeName: error.codeName } : {}),
    ...(error.source ? { source: error.source } : {}),
    message: error.message,
  }));
}

/**
 * The live segment number at which an outage that is to begin `atMinutes` after the session was created must be installed. A session is
 * created with the stream on air for a whole number of segments, so segment `edge + n` is published `n` segments after creation.
 */
export function outageSegment(edgeAtCreation: number, atMinutes: number, segmentSec: number): number {
  return edgeAtCreation + Math.max(1, Math.round((atMinutes * 60) / segmentSec));
}

/** An `originStall(atNumber, ms)` on the epoch axis: it begins when segment `atNumber` is published (`AST + atNumber * d`) and lasts `ms`. */
export function outageWindow(
  availabilityStartTime: string,
  atNumber: number,
  segmentSec: number,
  ms: number,
): FaultWindow {
  const startMs = Date.parse(availabilityStartTime) + atNumber * segmentSec * 1000;
  return { kind: 'origin-stall', startMs, endMs: startMs + ms };
}

/** A `staleManifest(ms, afterMs)` on the epoch axis: its clock starts at the session's first media request. */
export function staleWindow(firstMediaRequestAt: string, afterMs: number, ms: number): FaultWindow {
  const startMs = Date.parse(firstMediaRequestAt) + afterMs;
  return { kind: 'stale-manifest', startMs, endMs: startMs + ms };
}

const KEPT_REFUSALS = 50;

/**
 * Digests a request log as it is read in slices, `since` the last settled request. An entry is listed from its arrival and completed in
 * place (docs/CONTRACTS.md section 4), so a slice can hold requests whose answer is not known yet: their arrival counts when it is seen
 * (a manifest request is a refresh from the moment it reaches the origin), their answer when they have finished, and the cursor stops
 * before the first request still in flight so that the next slice sees it again.
 */
export class RequestLogDigester {
  /** The `since` of the next read: every request up to it is finished and digested. */
  cursor = 0;
  private readonly finished = new Set<number>();
  private readonly arrivalsSeen = new Set<number>();
  private readonly arrivals: number[] = [];
  private total = 0;
  private refusedCount = 0;
  private readonly byKind: Record<string, number> = {};
  private readonly refused: RequestDigest['refused'] = [];
  private readonly segmentRequests = new Map<string, number>();

  /** `isRefresh` picks the requests that make up the refresh series (every manifest request for DASH, the audio playlist for HLS). */
  constructor(private readonly isRefresh: (entry: RequestLogEntry) => boolean) {}

  absorb(entries: readonly RequestLogEntry[]): void {
    let settled = this.cursor;
    let inFlight = false;
    for (const entry of entries) {
      if (this.isRefresh(entry) && !this.arrivalsSeen.has(entry.seq)) {
        this.arrivalsSeen.add(entry.seq);
        this.arrivals.push(Date.parse(entry.t));
      }
      if (entry.pending) {
        inFlight = true;
        continue;
      }
      if (!this.finished.has(entry.seq)) {
        this.finished.add(entry.seq);
        this.count(entry);
      }
      if (!inFlight) settled = entry.seq;
    }
    this.cursor = settled;
  }

  private count(entry: RequestLogEntry): void {
    this.total += 1;
    this.byKind[entry.kind] = (this.byKind[entry.kind] ?? 0) + 1;
    // What the ORIGIN got wrong: an error status, or a response it cut. A client that hung up is the player's own business (CONTRACTS.md section 4).
    const originFailed =
      entry.status >= 400 || (entry.aborted === true && entry.abortReason !== 'client-closed');
    if (originFailed) {
      this.refusedCount += 1;
      if (this.refused.length < KEPT_REFUSALS) {
        this.refused.push({
          kind: entry.kind,
          status: entry.status,
          atMs: Date.parse(entry.t),
          ...(entry.rep === undefined ? {} : { rep: entry.rep }),
          ...(entry.number === undefined ? {} : { number: entry.number }),
        });
      }
    }
    if (entry.kind === 'segment' && entry.rep !== undefined && entry.number !== undefined) {
      const key = `${entry.rep}#${entry.number}`;
      this.segmentRequests.set(key, (this.segmentRequests.get(key) ?? 0) + 1);
    }
  }

  /** When the player asked for the manifest (or playlist), epoch ms, in the order they arrived. */
  manifestArrivalsMs(): number[] {
    return [...this.arrivals];
  }

  digest(): RequestDigest {
    const repeated = [...this.segmentRequests.entries()]
      .filter(([, times]) => times > 1)
      .map(([key, times]) => {
        const [rep = '', number = ''] = key.split('#');
        return { rep, number: Number(number), times };
      });
    return {
      total: this.total,
      refusedCount: this.refusedCount,
      byKind: { ...this.byKind },
      refused: [...this.refused],
      repeated,
    };
  }
}
