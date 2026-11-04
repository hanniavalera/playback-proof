import { describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { RepInfo } from '../../../src/shared/streams.ts';
import { CLOCK_SLACK_MS, compareHistoryWithLog, rungRuns } from '../../../tests/e2e/abr/agreement.ts';
import type { Anchor, HistoryEntry } from '../../../tests/e2e/abr/agreement.ts';
import { ladderOf } from '../../../tests/e2e/abr/ladder.ts';

// PB-ABR-007 compares two accounts of one session. These are stories the comparison must call the same and stories it must call
// different, in the shapes the real engines produce (the Chromium, WebKit and Firefox timelines of the smoke runs and of the ABR specs).

const rep = (id: string, track: 'video' | 'audio', bandwidth: number, height?: number): RepInfo => ({
  id,
  track,
  mimeType: track === 'video' ? 'video/mp4' : 'audio/mp4',
  codecs: 'x',
  bandwidth,
  ...(height === undefined ? {} : { height }),
  initExt: 'mp4',
  segmentExt: 'm4s',
});
const ladder = ladderOf({
  id: 'vod-cmaf',
  reps: [
    rep('v240', 'video', 305_000, 240),
    rep('v360', 'video', 709_900, 360),
    rep('v720', 'video', 1_808_424, 720),
    rep('a-aac', 'audio', 36_878),
  ],
});

// The manifest arrived at 100 ms of the origin's clock; the page's `load-requested` was at 50 ms of the page's. So page time t is
// about t + 50 ms of the origin's time, give or take the 12 ms the manifest took.
const anchor: Anchor = { loadT: 50, manifestAtMs: 100, manifestMs: 12 };
const originAt = (t: number): number => 100 + (t - 50);

let seq = 0;
function segment(rep: string, number: number, msSinceStart: number): RequestLogEntry {
  seq += 1;
  return {
    seq,
    t: '2030-01-01T00:00:00.000Z',
    msSinceStart,
    method: 'GET',
    path: `/s/x/vod-cmaf/seg/${rep}/${number}.m4s`,
    kind: 'segment',
    rep,
    number,
    status: 200,
    bytes: 1000,
    ttfbMs: 1,
    totalMs: 1,
    faults: [],
  };
}
const audio = (number: number, at: number): RequestLogEntry => ({ ...segment('a-aac', number, at) });

/** Video segments of `rep` numbered from `from`, one every 100 ms of the origin's clock from `at`. */
function fetches(rep: string, from: number, count: number, at: number): RequestLogEntry[] {
  return Array.from({ length: count }, (_, i) => segment(rep, from + i, at + i * 100));
}

const entry = (t: number, height: number, reason: HistoryEntry['reason']): HistoryEntry => ({
  t,
  height,
  reason,
});
const compare = (history: HistoryEntry[], log: RequestLogEntry[]) =>
  compareHistoryWithLog({ history, runs: rungRuns(log, ladder), anchor, segmentDurationSec: 2 });

describe('rungRuns', () => {
  it('collapses consecutive video segment requests of one rung and ignores audio', () => {
    const log = [...fetches('v720', 1, 3, 200), audio(1, 250), ...fetches('v240', 4, 2, 9000)];
    expect(rungRuns(log, ladder).map((run) => [run.height, run.requests, run.first.number])).toEqual([
      [720, 3, 1],
      [240, 2, 4],
    ]);
  });
});

describe('compareHistoryWithLog: accounts that agree', () => {
  it('a start on 720p and one step down (Chromium)', () => {
    const t = 16_800;
    const log = [...fetches('v720', 1, 11, 150), ...fetches('v240', 11, 4, originAt(t) + 40)];
    const { problems, lags } = compare([entry(60, 720, 'start'), entry(t, 240, 'abr')], log);
    expect(problems).toEqual([]);
    expect(lags).toEqual([{ height: 240, reason: 'abr', lagMs: 40 }]);
  });

  it('a start on 360p, a climb and a step down in two decisions (WebKit)', () => {
    const log = [
      ...fetches('v360', 1, 4, 150),
      ...fetches('v720', 5, 6, originAt(600) + 20),
      ...fetches('v360', 11, 4, originAt(16_300) + 30),
      ...fetches('v240', 15, 4, originAt(24_300) + 30),
    ];
    const history = [
      entry(60, 360, 'start'),
      entry(600, 720, 'abr'),
      entry(16_300, 360, 'abr'),
      entry(24_300, 240, 'abr'),
    ];
    expect(compare(history, log).problems).toEqual([]);
  });

  it('a rung that was chosen and left within a few ms is allowed to have no segment at the origin (Firefox: 360p for 12 ms)', () => {
    const log = [
      ...fetches('v720', 1, 4, originAt(80) + 10),
      ...fetches('v240', 5, 3, originAt(16_000) + 10),
    ];
    const history = [entry(60, 360, 'start'), entry(72, 720, 'abr'), entry(16_000, 240, 'abr')];
    expect(compare(history, log).problems).toEqual([]);
  });

  it('does not hold the initial selection to the timing of a switch: the hook records it after the load resolves, a moment after the first requests', () => {
    const log = fetches('v360', 1, 3, 90); // asked for at 90 ms, the start is stamped at 60 ms of the page: 110 ms of the origin's
    expect(compare([entry(60, 360, 'start')], log).problems).toEqual([]);
  });
});

describe('compareHistoryWithLog: accounts that disagree', () => {
  const t = 16_800;
  const drop = [...fetches('v720', 1, 11, 150), ...fetches('v240', 11, 4, originAt(t) + 40)];

  it('a rung the origin saw and the player never named', () => {
    const log = [
      ...fetches('v720', 1, 10, 150),
      ...fetches('v360', 11, 2, 9000),
      ...fetches('v240', 13, 3, originAt(t) + 40),
    ];
    const { problems } = compare([entry(60, 720, 'start'), entry(t, 240, 'abr')], log);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/asked for v360 .* the player's history has no 360p from there on/);
    expect(problems[0]).toMatch(/player says 720p > 240p, the origin saw 720p x 10 > 360p x 2 > 240p x 3/);
  });

  it('a rung the player named for seconds and the origin never saw', () => {
    const { problems } = compare(
      [entry(60, 720, 'start'), entry(8000, 360, 'abr'), entry(t, 240, 'abr')],
      drop,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/history has 360p for 8\.8 s .* never asked for a segment of it/);
  });

  it('a history that ends on a rung the origin was not asked for', () => {
    const { problems } = compare(
      [entry(60, 720, 'start'), entry(t, 240, 'abr')],
      fetches('v720', 1, 11, 150),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /history ends with 240p \(abr\) but the origin was not asked for a segment of it/,
    );
  });

  it('an origin that goes back to a rung the player left (flapping the player did not report)', () => {
    const log = [...drop, ...fetches('v720', 15, 2, originAt(t) + 2000)];
    const { problems } = compare([entry(60, 720, 'start'), entry(t, 240, 'abr')], log);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/asked for v720 .* no 720p from there on/);
  });

  it('an origin asked for the new rung before the player says it switched: the player stamps the change late', () => {
    const early = [...fetches('v720', 1, 11, 150), ...fetches('v240', 11, 4, originAt(t) - 900)];
    const { problems } = compare([entry(60, 720, 'start'), entry(t, 240, 'abr')], early);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /asked for v240 at \d+ ms, \d+ ms before the player says it switched to 240p .* timestamp is late/,
    );
  });

  it('a new rung asked for a segment later than the change: the player stamps early, or kept fetching the old rung', () => {
    const late = [...fetches('v720', 1, 11, 150), ...fetches('v240', 11, 4, originAt(t) + 2500)];
    const { problems } = compare([entry(60, 720, 'start'), entry(t, 240, 'abr')], late);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /first v240 segment was requested \d+ ms after the player says it switched to 240p .* 2000 ms of one segment/,
    );
  });

  it('tolerates the alignment of the two clocks, and not a ms more', () => {
    const early = anchor.manifestMs + CLOCK_SLACK_MS; // the manifest's own round trip, and the margin for the clocks' resolution
    const late = CLOCK_SLACK_MS + 2000; // one segment, and the same margin
    const at = (shift: number) => [
      ...fetches('v720', 1, 11, 150),
      ...fetches('v240', 11, 4, originAt(t) + shift),
    ];
    const history = [entry(60, 720, 'start'), entry(t, 240, 'abr')];
    expect(compare(history, at(-early)).problems).toEqual([]);
    expect(compare(history, at(-early - 1)).problems).toHaveLength(1);
    expect(compare(history, at(late)).problems).toEqual([]);
    expect(compare(history, at(late + 1)).problems).toHaveLength(1);
  });
});
