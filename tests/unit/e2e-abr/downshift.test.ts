import { describe, expect, it } from 'vitest';
import { invalidRunHead, isInvalidRun } from '../../../flake/run.ts';
import { INVALID_RUN_PREFIX } from '../../../src/shared/criteria.ts';
import {
  DECISION_JITTER_S,
  DROPPED_FRAME_PROTECTION,
  FIRST_POLL_WINDOW_S,
  forcedDownshift,
  invalidDownshiftReason,
} from '../../../tests/e2e/abr/bans.ts';
import type { DownshiftEvidence } from '../../../tests/e2e/abr/bans.ts';
import { repeatedAudioSegments } from '../../../tests/e2e/abr/log.ts';
import { FORCED_DOWNSHIFT_RUNS, downshiftLogOf, segmentEntry, timeline } from './fixtures.ts';
import type { ForcedDownshiftRun, Row } from './fixtures.ts';

// A downshift from the top rung that the adaptation cannot have decided (ADR-106, amendment 3), on the attempts of PB-ABR-001 that
// failed on the GitHub macOS runner (fixtures.ts): in each the player climbed to 720p of a link that carries it and, about 1.9 s after
// the playhead entered the first 720p segment, left it for 360p, and the origin was asked twice for one audio segment.

const RUNS = Object.entries(FORCED_DOWNSHIFT_RUNS);
const run10 = FORCED_DOWNSHIFT_RUNS['collection A, run 10, attempt 0'] as ForcedDownshiftRun;
const run9 = FORCED_DOWNSHIFT_RUNS[
  'collection A, run 9, attempt 1 (and 240p 1.95 s later)'
] as ForcedDownshiftRun;

/** The climb to 720p is the second change (index 1) of every run. */
const CLIMB = 1;
const CARRIED = 720;

function evidenceOf(
  run: Pick<ForcedDownshiftRun, 'rows' | 'frames' | 'firstV720Segment' | 'repeatedAudio'>,
  override: Partial<DownshiftEvidence> = {},
): DownshiftEvidence {
  return {
    changes: timeline(run.rows),
    afterIndex: CLIMB,
    carriedHeight: CARRIED,
    frames: run.frames,
    boundaryMedia: (run.firstV720Segment - 1) * 2,
    originFailures: 0,
    playerErrors: 0,
    repeatedAudio: [run.repeatedAudio],
    ...override,
  };
}

const downshiftOf = (
  run: Pick<ForcedDownshiftRun, 'rows' | 'frames' | 'firstV720Segment' | 'repeatedAudio'>,
  override: Partial<DownshiftEvidence> = {},
) => forcedDownshift(evidenceOf(run, override));

/** Run 10's attempt with its downshift `offset` s of media time after the playhead entered the first 720p segment (media time 8 s). */
function downshiftAfterEntry(offset: number) {
  const rows: Row[] = [
    [0.25, 0, 360, 'start'],
    [0.75, 0.25, 720, 'abr'],
    [10.5, 8 + offset, 360, 'abr'],
  ];
  return downshiftOf({ ...run10, rows });
}

describe('forcedDownshift: the attempts that failed on the macOS runner', () => {
  it.each(RUNS)(
    '%s: the downshift to 360p, within the first poll after the entry, is found, with the offset of its trace',
    (_name, run) => {
      const found = downshiftOf(run);
      expect(found).not.toBeNull();
      expect(found?.change.height).toBe(360);
      expect(found?.after.height).toBe(720);
      expect(found?.boundaryMedia).toBe((run.firstV720Segment - 1) * 2);
      expect(found?.secondsAfterEntry).toBeCloseTo(run.offset, 3);
      expect(found?.secondsAfterEntry).toBeGreaterThan(1.87);
      expect(found?.secondsAfterEntry).toBeLessThan(FIRST_POLL_WINDOW_S);
      expect(found?.gapSeconds).toBeCloseTo(run.gap, 3);
      expect(found?.repeatedAudio).toEqual([run.repeatedAudio]);
    },
  );

  it('looks at the first change only: the run that went on to 240p one poll later is found by its first downshift', () => {
    const found = downshiftOf(run9);
    expect(found?.change.height).toBe(360);
    expect(found?.change.mediaTime).toBeCloseTo(9.972, 3);
  });

  it('a start on the top rung (as in Chromium) is the same claim: the downshift after the initial selection is found', () => {
    const rows: Row[] = [
      [0.1, 0, 720, 'start'],
      [10.4, 9.9, 360, 'abr'],
    ];
    expect(downshiftOf({ ...run10, rows }, { afterIndex: 0 })).not.toBeNull();
  });
});

describe('forcedDownshift: the window of the first poll', () => {
  it('is the period of the protection and the jitter of the clocks', () => {
    expect(FIRST_POLL_WINDOW_S).toBe(DROPPED_FRAME_PROTECTION.checkSeconds + DECISION_JITTER_S);
    expect(FIRST_POLL_WINDOW_S).toBe(2.25);
  });

  it('holds the entry itself and 2.25 s after it, and not a hair more on either side', () => {
    expect(downshiftAfterEntry(0)).not.toBeNull();
    expect(downshiftAfterEntry(2.25)).not.toBeNull();
    expect(downshiftAfterEntry(2.26)).toBeNull();
    expect(downshiftAfterEntry(-0.01)).toBeNull();
  });

  it('does not hold a later poll: 3.9 s after the entry is the second poll, whatever the frames', () => {
    expect(downshiftAfterEntry(3.9)).toBeNull();
    expect(
      downshiftOf({ ...run10, frames: { decoded: 394, dropped: 300 } }, { boundaryMedia: 6 }),
    ).toBeNull();
  });

  it('does not hold a change before the playhead entered the rung: that is a ban of the rung that is fetched and not played', () => {
    expect(downshiftAfterEntry(-2.09)).toBeNull();
  });

  it('measures from the entry the log shows: with the first segment of 720p two segments later, the same change is before it', () => {
    expect(downshiftOf(run10, { boundaryMedia: 12 })).toBeNull();
  });
});

describe('forcedDownshift: what must still fail', () => {
  it('a downshift on a load that dropped no frame: the protection has nothing to act on', () => {
    expect(downshiftOf(run10, { frames: { decoded: 398, dropped: 0 } })).toBeNull();
  });

  it('a downshift on a load in which the origin failed a request: a failed request disables a rung as well', () => {
    expect(downshiftOf(run10, { originFailures: 1 })).toBeNull();
  });

  it('a downshift on a load in which the player raised an error: the other callers of disableStream are error paths', () => {
    expect(downshiftOf(run10, { playerErrors: 1 })).toBeNull();
  });

  it('a downshift that the adaptation made, with no mark of a forced switch in the log: its own switch leaves the audio alone', () => {
    expect(downshiftOf(run10, { repeatedAudio: [] })).toBeNull();
  });

  it('a throttled link: the rung it carries is not the one the player was on, so leaving 720p is not this claim', () => {
    expect(downshiftOf(run10, { carriedHeight: 360 })).toBeNull();
    expect(downshiftOf(run10, { carriedHeight: 240 })).toBeNull();
  });

  it('a change by anything but the player, on either side of the downshift', () => {
    const manualDownshift: Row[] = [...run10.rows];
    manualDownshift[2] = [10.658, 9.892, 360, 'manual'];
    expect(downshiftOf({ ...run10, rows: manualDownshift })).toBeNull();
    const manualClimb: Row[] = [...run10.rows];
    manualClimb[1] = [1.402, 0.635, 720, 'manual'];
    expect(downshiftOf({ ...run10, rows: manualClimb })).toBeNull();
  });

  it('the first change after the climb decides: a real flap that comes first is never hidden by a forced downshift after it', () => {
    const rows: Row[] = [
      [0.27, 0, 360, 'start'],
      [1.402, 0.635, 720, 'abr'],
      // the adaptation's own change, long before the playhead enters the first segment of 720p ...
      [6.2, 5.5, 360, 'abr'],
      [7.0, 6.3, 720, 'abr'],
      // ... and then a change with the whole fingerprint
      [10.658, 9.892, 360, 'abr'],
    ];
    expect(downshiftOf({ ...run10, rows })).toBeNull();
  });

  it('a change that is not a downshift from the rung the link carries: a climb, or a change up from the rung it carries', () => {
    const rows: Row[] = [
      [0.2, 0, 360, 'start'],
      [10.4, 9.9, 720, 'abr'],
    ];
    // the player was on 360p and went up: not a downshift, whatever the link carries
    expect(downshiftOf({ ...run10, rows }, { afterIndex: 0 })).toBeNull();
    expect(downshiftOf({ ...run10, rows }, { afterIndex: 0, carriedHeight: 360 })).toBeNull();
  });

  it('a log with no segment of the carried rung leaves nothing to measure from, even for a change that would sit inside any window', () => {
    expect(downshiftOf(run10, { boundaryMedia: null })).toBeNull();
    // a downshift 1.9 s into the title: without an entry to measure from it must not be read as "1.9 s after the entry"
    const early: Row[] = [
      [0.2, 0, 360, 'start'],
      [0.5, 0.1, 720, 'abr'],
      [2.1, 1.9, 360, 'abr'],
    ];
    expect(downshiftOf({ ...run10, rows: early }, { boundaryMedia: null })).toBeNull();
    expect(downshiftOf({ ...run10, rows: early }, { boundaryMedia: 0 })).not.toBeNull();
  });

  it('a timeline with nothing after the climb, or with only changes before it', () => {
    expect(downshiftOf(run10, { afterIndex: 2 })).toBeNull();
    expect(downshiftOf(run10, { afterIndex: 99 })).toBeNull();
    expect(downshiftOf({ ...run10, rows: [] })).toBeNull();
    expect(downshiftOf({ ...run10, rows: run10.rows.slice(0, 2) })).toBeNull();
  });
});

describe('invalidDownshiftReason', () => {
  const reasonOf = (run: ForcedDownshiftRun) => {
    const downshift = downshiftOf(run);
    if (!downshift) throw new Error('the run must show a forced downshift');
    return invalidDownshiftReason({
      downshift,
      frames: run.frames,
      carriedHeight: CARRIED,
      linkKbps: 20_000,
    });
  };

  it('starts with the shared prefix that the flake tracker recognises an invalid run by', () => {
    const reason = reasonOf(run10);
    expect(reason.startsWith(`${INVALID_RUN_PREFIX} forced downshift to `)).toBe(true);
    // The other side of the contract: what the spec writes, the tracker counts.
    expect(isInvalidRun({ outcome: 'skipped', skipReason: reason })).toBe(true);
  });

  it.each(RUNS)(
    '%s: the numbers come first, inside the 90 characters that the flake report keeps of a cell',
    (_name, run) => {
      const reason = reasonOf(run);
      const head = reason.split('. ')[0] as string;
      expect(head.length).toBeLessThanOrEqual(90);
      expect(head).toMatch(
        /^invalid run: forced downshift to 360p \d\.\d s after entering 720p, \d+ of \d+ frames dropped$/,
      );
    },
  );

  it('says how long after the playhead entered the first segment of the rung the downshift came, and what is known', () => {
    const reason = reasonOf(run10);
    expect(reason).toContain(
      'invalid run: forced downshift to 360p 1.9 s after entering 720p, 7 of 398 frames dropped. ',
    );
    expect(reason).toContain(
      'The playhead entered the first 720p segment at media time 8.0 s and the player left 720p at 9.89 s, 9.3 s after it reached it, on a 20000 kbps link that carries it.',
    );
    expect(reason).toContain('The origin was asked twice for a-aac #10');
    expect(reason).toContain('No request failed and the player raised no error');
  });

  it('says that the protection fits and does not say that it did it: the cause is not observed', () => {
    const reason = reasonOf(run10);
    expect(reason).toContain(
      "Shaka's dropped-frame protection, which disables the rung that plays for 30 s, fits",
    );
    expect(reason).not.toMatch(/ was the cause| caused /);
  });

  it('is what the tracker quotes of it: the first sentence, which is the numbers', () => {
    expect(invalidRunHead(reasonOf(run10))).toBe(
      'forced downshift to 360p 1.9 s after entering 720p, 7 of 398 frames dropped',
    );
  });
});

describe('repeatedAudioSegments', () => {
  it('finds the audio segment the origin was asked for twice in a real shape of the log, and nothing else', () => {
    expect(repeatedAudioSegments(downshiftLogOf(run10))).toEqual(['a-aac #10']);
    const nightly = FORCED_DOWNSHIFT_RUNS[
      'nightly 41799187688, attempt 0 (the first 720p segment is #3, the downshift 5.9 s after the climb)'
    ] as ForcedDownshiftRun;
    expect(repeatedAudioSegments(downshiftLogOf(nightly))).toEqual(['a-aac #8']);
  });

  it('finds nothing in a log in which every audio segment was asked for once, as in a load whose switches were the adaptation own', () => {
    const log = [
      segmentEntry(1, 'a-aac', 1),
      segmentEntry(2, 'v360', 1),
      segmentEntry(3, 'a-aac', 2),
      segmentEntry(4, 'v720', 3),
    ];
    expect(repeatedAudioSegments(log)).toEqual([]);
    expect(repeatedAudioSegments([])).toEqual([]);
  });

  it('does not count a video segment asked for twice (the player cancels it at every switch) or an init segment', () => {
    const log = [
      segmentEntry(1, 'v720', 10, { aborted: true, abortReason: 'client-closed', bytes: 0 }),
      segmentEntry(2, 'v720', 10),
      segmentEntry(3, 'a-aac', 3, { kind: 'init', number: undefined }),
      segmentEntry(4, 'a-aac', 3, { kind: 'init', number: undefined }),
    ];
    expect(repeatedAudioSegments(log)).toEqual([]);
  });

  it('lists each repeated segment once, in the order it was first asked for', () => {
    const log = [
      segmentEntry(1, 'a-aac', 4),
      segmentEntry(2, 'a-aac', 7),
      segmentEntry(3, 'a-aac', 4),
      segmentEntry(4, 'a-aac', 7),
      segmentEntry(5, 'a-aac', 7),
    ];
    expect(repeatedAudioSegments(log)).toEqual(['a-aac #4', 'a-aac #7']);
  });
});
