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

// The attempts of PB-ABR-001 that failed on the GitHub macOS runner (macos-15, 3 vCPU, Playwright's WebKit; ADR-106, amendment 3):
// eleven of the 100 that failed in two collections of `flake-collect --grep PB-ABR-001` (`collection A`: the isolated job, GitHub run
// 41892727961, commit e0a5be3, 30 repetitions; `collection B`: the contended one, commit 30b7d6d, 40 repetitions) and the two that failed
// in the nightlies 41891341097 and 41799187688. The rows are the rung changes of the hook (page clock, media time, rung entered,
// reason) as the traces kept them. In each the player climbed to 720p and left it for 360p about 1.9 s after the playhead entered the
// first 720p segment, and the origin was asked twice for one audio segment.
export interface ForcedDownshiftRun {
  rows: readonly Row[];
  frames: { decoded: number; dropped: number };
  /** The number of the first 720p segment the origin was asked for: the playhead entered the rung at (n - 1) x 2 s of media time. */
  firstV720Segment: number;
  /** The audio segment the origin was asked for twice. */
  repeatedAudio: string;
  /** Media seconds from that entry to the downshift, as the trace gives it. */
  offset: number;
  /** Page-clock seconds from the climb to the downshift. */
  gap: number;
}

export const FORCED_DOWNSHIFT_RUNS: Record<string, ForcedDownshiftRun> = {
  'collection A, run 10, attempt 0': {
    rows: [
      [0.27, 0, 360, 'start'],
      [1.402, 0.635, 720, 'abr'],
      [10.658, 9.892, 360, 'abr'],
    ],
    frames: { decoded: 398, dropped: 7 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.892,
    gap: 9.256,
  },
  'collection A, run 9, attempt 1 (and 240p 1.95 s later)': {
    rows: [
      [0.298, 0, 360, 'start'],
      [1.396, 0.694, 720, 'abr'],
      [10.673, 9.972, 360, 'abr'],
      [12.627, 11.926, 240, 'abr'],
    ],
    frames: { decoded: 402, dropped: 30 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.972,
    gap: 9.277,
  },
  'collection A, run 16, attempt 1 (2 frames dropped)': {
    rows: [
      [0.178, 0, 360, 'start'],
      [1.242, 0.681, 720, 'abr'],
      [10.441, 9.88, 360, 'abr'],
    ],
    frames: { decoded: 394, dropped: 2 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.88,
    gap: 9.199,
  },
  'collection A, run 17, attempt 1 (2 frames dropped)': {
    rows: [
      [0.22, 0, 360, 'start'],
      [1.327, 0.695, 720, 'abr'],
      [10.523, 9.891, 360, 'abr'],
    ],
    frames: { decoded: 396, dropped: 2 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.891,
    gap: 9.196,
  },
  'collection A, run 19, attempt 0 (2 frames dropped)': {
    rows: [
      [0.246, 0, 360, 'start'],
      [1.339, 0.697, 720, 'abr'],
      [10.526, 9.884, 360, 'abr'],
    ],
    frames: { decoded: 393, dropped: 2 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.884,
    gap: 9.187,
  },
  'collection A, run 27, attempt 0 (2 frames dropped)': {
    rows: [
      [0.23, 0, 360, 'start'],
      [1.326, 0.677, 720, 'abr'],
      [10.533, 9.884, 360, 'abr'],
    ],
    frames: { decoded: 393, dropped: 2 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.884,
    gap: 9.207,
  },
  'collection B, run 19, attempt 1 (2 frames dropped)': {
    rows: [
      [0.232, 0, 360, 'start'],
      [1.341, 0.537, 720, 'abr'],
      [10.69, 9.887, 360, 'abr'],
    ],
    frames: { decoded: 388, dropped: 2 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.887,
    gap: 9.349,
  },
  'collection B, run 22, attempt 1 (the latest: 2.02 s)': {
    rows: [
      [0.305, 0, 360, 'start'],
      [1.414, 0.692, 720, 'abr'],
      [10.744, 10.022, 360, 'abr'],
    ],
    frames: { decoded: 409, dropped: 17 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 2.022,
    gap: 9.33,
  },
  'collection B, run 21, attempt 0': {
    rows: [
      [0.27, 0, 360, 'start'],
      [1.37, 0.654, 720, 'abr'],
      [10.698, 9.983, 360, 'abr'],
    ],
    frames: { decoded: 393, dropped: 10 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.983,
    gap: 9.328,
  },
  'collection A, run 11, attempt 1 (the earliest climb)': {
    rows: [
      [0.459, 0, 360, 'start'],
      [1.543, 0.491, 720, 'abr'],
      [10.969, 9.918, 360, 'abr'],
    ],
    frames: { decoded: 394, dropped: 15 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.918,
    gap: 9.426,
  },
  'collection B, run 16, attempt 0 (17 frames dropped)': {
    rows: [
      [0.306, 0, 360, 'start'],
      [1.435, 0.7, 720, 'abr'],
      [10.635, 9.9, 360, 'abr'],
    ],
    frames: { decoded: 394, dropped: 17 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.9,
    gap: 9.2,
  },
  'nightly 41891341097, attempt 0': {
    rows: [
      [0.74, 0, 360, 'start'],
      [1.995, 0.592, 720, 'abr'],
      [11.325, 9.922, 360, 'abr'],
    ],
    frames: { decoded: 394, dropped: 5 },
    firstV720Segment: 5,
    repeatedAudio: 'a-aac #10',
    offset: 1.922,
    gap: 9.33,
  },
  'nightly 41799187688, attempt 0 (the first 720p segment is #3, the downshift 5.9 s after the climb)': {
    rows: [
      [0.698, 0, 360, 'start'],
      [1.284, 0, 720, 'abr'],
      [7.214, 5.912, 360, 'abr'],
    ],
    frames: { decoded: 382, dropped: 10 },
    firstV720Segment: 3,
    repeatedAudio: 'a-aac #8',
    offset: 1.912,
    gap: 5.93,
  },
};

/**
 * The segments the origin was asked for in such an attempt: 360p before the climb, 720p from the run's first segment, an audio request cut
 * at the switch (no byte) and a 720p request cancelled by the player, then 360p and the audio segment asked for again.
 */
export function downshiftLogOf(run: ForcedDownshiftRun): RequestLogEntry[] {
  const entries: RequestLogEntry[] = [];
  const add = (rep: string, number: number, extra: Partial<RequestLogEntry> = {}) => {
    entries.push(segmentEntry(entries.length + 1, rep, number, extra));
  };
  const cut = Number(run.repeatedAudio.split('#')[1]);
  for (let n = 1; n < run.firstV720Segment; n++) add('v360', n);
  for (let n = run.firstV720Segment; n < cut; n++) add('v720', n);
  for (let n = 1; n < cut; n++) add('a-aac', n, { bytes: 8_800, totalMs: 5 });
  add('a-aac', cut, { bytes: 0, totalMs: 80 });
  add('v720', cut, { aborted: true, abortReason: 'client-closed', bytes: 0, totalMs: 15 });
  add('v360', cut);
  add('a-aac', cut, { bytes: 8_936, totalMs: 25 });
  return entries;
}
