import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAEvent } from '../../../src/shared/qa.ts';
import { variantChanges } from '../../../tests/e2e/abr/variants.ts';
import type { VariantChange } from '../../../tests/e2e/abr/variants.ts';

// Timelines of the ABR specs as the unit tests need them: the hook's `variant-changed` events built from rows of numbers read off real
// runs, and the four real attempts of PB-ABR-002 that ADR-106 is about.

export type Row = readonly [
  pageSeconds: number,
  mediaSeconds: number,
  height: 240 | 360 | 720,
  reason: 'start' | 'abr' | 'manual',
];

const VARIANT_ID = { 240: 0, 360: 1, 720: 2 } as const;
const VARIANT_BANDWIDTH = { 240: 342376, 360: 746360, 720: 1844448 } as const;

/** The hook's `variant-changed` events for rows of (page clock, media time, rung entered, reason), read the way the specs read them. */
export function timeline(rows: readonly Row[]): VariantChange[] {
  let left: number | null = null;
  const events = rows.map(([page, media, height, reason], index): QAEvent => {
    const event: QAEvent = {
      index,
      t: page * 1000,
      name: 'variant-changed',
      mediaTime: media,
      detail: { from: left, to: VARIANT_ID[height], bandwidth: VARIANT_BANDWIDTH[height], height, reason },
    };
    left = VARIANT_ID[height];
    return event;
  });
  return variantChanges(events);
}

// The four attempts of PB-ABR-002 that failed in the 40 repetitions on the GitHub macOS runner (collection abr002-macos, commit 1234a5c,
// 2026-11-04): the rung changes of the load as the hook recorded them (page clock, media time, rung entered, reason), the frames of the
// load and the number of the first 240p segment of the request log. In each the player stepped down to 240p, and 4.0 to 6.0 s later it
// climbed to 360p, a rung that the 600 kbps link cannot carry.
export interface ForcedClimbRun {
  rows: readonly Row[];
  frames: { decoded: number; dropped: number };
  /** The gap the error message of the run printed: seconds from the step down to the climb. */
  gap: number;
  /** The number of the first 240p segment the origin was asked for: the playhead entered the rung at (n - 1) x 2 s of media time. */
  firstV240Segment: number;
}

export const FORCED_CLIMB_RUNS: Record<string, ForcedClimbRun> = {
  'run 6': {
    rows: [
      [0.208, 0, 360, 'start'],
      [0.918, 0.308, 720, 'abr'],
      [12.516, 11.906, 360, 'abr'],
      [28.537, 27.926, 240, 'abr'],
      [32.53, 31.92, 360, 'abr'],
    ],
    frames: { decoded: 1218, dropped: 55 },
    gap: 3.993,
    firstV240Segment: 16,
  },
  'run 13': {
    rows: [
      [0.23, 0, 360, 'start'],
      [1.341, 0.696, 720, 'abr'],
      [10.535, 9.89, 360, 'abr'],
      [28.593, 27.948, 240, 'abr'],
      [34.552, 33.907, 360, 'abr'],
    ],
    frames: { decoded: 1210, dropped: 17 },
    gap: 5.959,
    firstV240Segment: 17,
  },
  'run 20': {
    rows: [
      [0.206, 0, 360, 'start'],
      [0.878, 0.269, 720, 'abr'],
      [12.503, 11.894, 360, 'abr'],
      [20.636, 20.027, 240, 'abr'],
      [26.497, 25.888, 360, 'abr'],
    ],
    frames: { decoded: 974, dropped: 10 },
    gap: 5.861,
    firstV240Segment: 13,
  },
  'run 34': {
    rows: [
      [0.24, 0, 360, 'start'],
      [0.895, 0.265, 720, 'abr'],
      [12.52, 11.89, 360, 'abr'],
      [20.52, 19.89, 240, 'abr'],
      [26.534, 25.904, 360, 'abr'],
    ],
    frames: { decoded: 968, dropped: 16 },
    gap: 6.014,
    firstV240Segment: 13,
  },
};

/** A video segment of the origin's request log. */
export function segmentEntry(
  seq: number,
  rep: string,
  number: number,
  extra: Partial<RequestLogEntry> = {},
): RequestLogEntry {
  return {
    seq,
    t: '2026-11-04T15:53:00.000Z',
    msSinceStart: seq * 100,
    method: 'GET',
    path: `/s/x/vod-cmaf/seg/${rep}/${number}.m4s`,
    kind: 'segment',
    rep,
    number,
    status: 200,
    bytes: 75_000,
    ttfbMs: 1,
    totalMs: 80,
    faults: [],
    ...extra,
  };
}

/** The video segments a run's player asked for: 360p to #5, 720p from #6 to #10, 360p to #12, then 240p from the run's first. */
export function logOf(run: ForcedClimbRun): RequestLogEntry[] {
  const entries: RequestLogEntry[] = [];
  const add = (rep: string, from: number, to: number) => {
    for (let n = from; n <= to; n++) entries.push(segmentEntry(entries.length + 1, rep, n));
  };
  add('v360', 1, 5);
  add('v720', 6, 10);
  add('v360', 10, run.firstV240Segment - 1);
  add('v240', run.firstV240Segment, run.firstV240Segment + 4);
  return entries;
}
