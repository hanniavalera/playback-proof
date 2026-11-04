import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import { requestsFor } from '../support/waiting.ts';
import { failure } from './fail.ts';
import { repsOfTrack } from './segments.ts';

// What PB-VOD-012 holds the hook's numbers against: things the browser and the origin say that do not come from the hook.

/** The frame rate of the title's video, from the catalog: the lab's streams are 30 fps on every rung. */
export function videoFrameRate(info: StreamInfo): number {
  const rates = new Set(
    repsOfTrack(info, 'video').map((id) => info.reps.find((rep) => rep.id === id)?.frameRate),
  );
  const [rate] = [...rates];
  if (rates.size !== 1 || rate === undefined) {
    throw failure(
      `the catalog of ${info.id} does not give its video one frame rate (the representations say: ${[...rates].join(', ')})`,
    );
  }
  return rate;
}

/**
 * The shortest the startup can have been, by the origin's clock: from the arrival of the manifest request to the end of the delivery of
 * the first video segment. The player asked for the manifest after its startup clock started and cannot present a frame before the
 * first segment has arrived, so `startupMs` is at least this (the two clocks are different but both count elapsed milliseconds).
 */
export function originStartupSpanMs(log: readonly RequestLogEntry[], info: StreamInfo): number {
  const manifest = requestsFor(log, { kind: 'manifest' }).find((entry) => entry.rep === undefined);
  const firstSegments = requestsFor(log, {
    kind: 'segment',
    rep: repsOfTrack(info, 'video'),
    number: 1,
    status: 'ok',
  });
  if (!manifest || firstSegments.length === 0) {
    throw failure(
      `the request log has no manifest request or no delivered first video segment to measure the startup against (${log.length} entries)`,
    );
  }
  const firstDelivered = Math.min(...firstSegments.map((entry) => entry.msSinceStart + entry.totalMs));
  return firstDelivered - manifest.msSinceStart;
}

/** The milliseconds from the `load-requested` event to the first event called `name`, recomputed from the raw timeline; null when there is none. */
export function sinceLoadRequested(
  events: ReadonlyArray<{ name: string; t: number }>,
  name: string,
): number | null {
  const start = events.find((event) => event.name === 'load-requested');
  const end = events.find((event) => event.name === name);
  return start && end ? end.t - start.t : null;
}
