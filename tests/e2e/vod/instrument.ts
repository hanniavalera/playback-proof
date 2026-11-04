import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import { requestsFor } from '../support/waiting.ts';
import { failure } from './fail.ts';
import { repsOfTrack } from './segments.ts';

// What PB-VOD-012 holds the hook's numbers against: things the browser and the origin say that do not come from the hook.

/**
 * How many frames the decoded and the presented counters of an uninterrupted play may differ by. The decoder runs ahead of the
 * presentation by the frames its output queue holds: measured at 3 to 5 frames in Chromium and WebKit (decoded 95 or 96 against 91
 * to 93 presented at about 3 s) and with the presented counter ahead by up to 3 in Firefox (ADR-065). Ten frames are a third of a
 * second of 30 fps video, and about 1.4 times the largest difference measured; a counter that doubles, repeats or restarts differs by
 * a second of video or more.
 */
export const FRAME_AGREEMENT_TOLERANCE = 10;

/** The effective frame rate of a window may be this share off the frame rate of the stream (27 to 33 fps for 30): 60 presented frames in 2.000 s were measured in every engine. */
export const FPS_TOLERANCE_SHARE = 0.1;

/** The media time `measureFrames` looks at: long enough to hold sixty frames, short enough for a test of a few seconds. */
export const FRAME_WINDOW_SEC = 2;

/** The resolution of the clocks compared across processes (the origin's milliseconds are integers or hundredths, the page's are fractions): two milliseconds. */
export const CLOCK_RESOLUTION_MS = 2;

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
