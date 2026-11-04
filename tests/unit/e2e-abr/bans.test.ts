import { describe, expect, it } from 'vitest';
import {
  DECISION_JITTER_S,
  DROPPED_FRAME_PROTECTION,
  banBoundSeconds,
  banEvidence,
  banNote,
  describeForcedChanges,
  forcedChanges,
  forcedClimb,
  invalidRunReason,
  upshiftBound,
  upshiftWaitMs,
} from '../../../tests/e2e/abr/bans.ts';
import { SHAKA_SWITCH_INTERVAL_S, upshiftBoundSeconds } from '../../../tests/e2e/abr/conditions.ts';
import type { VariantChange } from '../../../tests/e2e/abr/variants.ts';
import { FORCED_CLIMB_RUNS, timeline } from './fixtures.ts';
import type { ForcedClimbRun, Row } from './fixtures.ts';

// The bound of the first step up after a recovery (PB-ABR-003) and the evidence that chooses it. The timelines are the ones the
// specs read: the numbers of the failed attempts of the nightly run 41793007785 (GitHub macOS runner, WebKit, 3 CPUs, one worker), the
// pass of Chromium on the same run, and the machine of the author, which dropped no frame (docs/decisions/e2e-abr.md, ADR-095).
// Then the classifier of ADR-106, on the four attempts of PB-ABR-002 that failed on the same kind of runner (fixtures.ts).

// What the timeline shows before the link recovers, and the recovery's media time; the step up is a row of its own.
const CI_ATTEMPT_0 = {
  before: timeline([
    [0.04, 0, 360, 'start'],
    [0.73, 0.33, 720, 'abr'],
    [12.31, 11.91, 360, 'abr'],
    [20.31, 19.91, 240, 'abr'],
  ]),
  frames: { decoded: 1271, dropped: 37 },
  recoveredAt: 20.128980208,
  stepUpAt: 42.0,
};
const CI_ATTEMPT_1 = {
  before: timeline([
    [0.04, 0, 360, 'start'],
    [1.11, 0.7, 720, 'abr'],
    [17.4, 16.99, 360, 'abr'],
    [22.32, 21.91, 240, 'abr'],
  ]),
  frames: { decoded: 1164, dropped: 40 },
  recoveredAt: 21.999974251,
  stepUpAt: 38.35,
};
const AUTHORS_MACHINE = {
  before: timeline([
    [0.05, 0, 360, 'start'],
    [0.8, 0.4, 720, 'abr'],
    [16.4, 16.0, 360, 'abr'],
    [24.4, 24.0, 240, 'abr'],
  ]),
  frames: { decoded: 366, dropped: 0 },
  recoveredAt: 24.0,
  stepUpAt: 33.6,
};
const CI_CHROMIUM = {
  before: timeline([
    [0.05, 0, 720, 'start'],
    [16.34, 16.0, 360, 'abr'],
    [24.38, 24.0, 240, 'abr'],
  ]),
  frames: { decoded: 365, dropped: 0 },
  recoveredAt: 24.0,
  stepUpAt: 32.2,
};

/** What the spec does with a run, minus the browser: the bound from the evidence, and the time to compare with it. */
function judge(run: {
  before: readonly VariantChange[];
  frames: { decoded: number; dropped: number };
  recoveredAt: number;
  stepUpAt: number;
}) {
  const bound = upshiftBound(2, banEvidence({ frames: run.frames, changesBeforeRecovery: run.before }));
  const elapsed = run.stepUpAt - run.recoveredAt;
  return { bound, elapsed, within: elapsed <= bound.seconds };
}

describe('the bound of the ban, derived from Shaka\u2019s documented defaults', () => {
  it('a ban lasts 30 s, the player is told on a 1 s tick, and one segment is margin: 33 s for 2 s segments', () => {
    expect(DROPPED_FRAME_PROTECTION).toEqual({
      checkSeconds: 2,
      threshold: 0.15,
      banSeconds: 30,
      reenableTickSeconds: 1,
    });
    expect(banBoundSeconds(2)).toBe(33);
    expect(banBoundSeconds(4)).toBe(35);
  });

  it('is wider than the bound of the link, which is the switch interval and three segments', () => {
    expect(upshiftBoundSeconds(2)).toBe(SHAKA_SWITCH_INTERVAL_S + 6);
    expect(banBoundSeconds(2)).toBeGreaterThan(upshiftBoundSeconds(2));
  });

  it('is waited for with ten seconds more, which is a bound for a failure and never the pace of a test', () => {
    expect(upshiftWaitMs(2)).toBe(43_000);
    expect(upshiftWaitMs(2) / 1000).toBeGreaterThanOrEqual(banBoundSeconds(2) + 10);
  });
});

describe('forcedChanges: what the switch interval proves', () => {
  it('finds nothing in decisions that are a switch interval apart, the start-up shortcut included', () => {
    expect(forcedChanges(AUTHORS_MACHINE.before)).toEqual([]);
    expect(forcedChanges(CI_CHROMIUM.before)).toEqual([]);
    // The first change after the initial selection is exempt: 0.69 s after it, in the real runs.
    expect(
      forcedChanges(
        timeline([
          [0.04, 0, 360, 'start'],
          [0.73, 0.33, 720, 'abr'],
        ]),
      ),
    ).toEqual([]);
  });

  it('finds the change that came 4.9 s after the one before it (attempt 1 of the failed run)', () => {
    const [forced, ...others] = forcedChanges(CI_ATTEMPT_1.before);
    expect(others).toEqual([]);
    expect(forced?.change.height).toBe(240);
    expect(forced?.after.height).toBe(360);
    expect(forced?.gapSeconds).toBeCloseTo(4.92, 2);
    expect(describeForcedChanges(forcedChanges(CI_ATTEMPT_1.before))).toBe(
      '240p at media time 21.91 s, 4.9 s after the change before it',
    );
  });

  it('does not find the ban that came exactly a switch interval after the change before it: it is a proof, not a test', () => {
    // 12.31 s then 20.31 s in attempt 0 of the failed run: the second was a ban as well, and nothing in the gap says so.
    expect(forcedChanges(CI_ATTEMPT_0.before)).toEqual([]);
  });

  it('allows the jitter of the clocks and not more: a gap of the interval less 0.25 s is a decision, less 0.26 s is not', () => {
    expect(DECISION_JITTER_S).toBe(0.25);
    const gap = (seconds: number) =>
      forcedChanges(
        timeline([
          [0.05, 0, 360, 'start'],
          [0.8, 0.4, 720, 'abr'],
          [10, 9.6, 360, 'abr'],
          [10 + seconds, 9.6 + seconds, 240, 'abr'],
        ]),
      ).length;
    expect(gap(SHAKA_SWITCH_INTERVAL_S - DECISION_JITTER_S)).toBe(0);
    expect(gap(SHAKA_SWITCH_INTERVAL_S - DECISION_JITTER_S - 0.01)).toBe(1);
    expect(gap(0.5)).toBe(1);
  });

  it('ignores a change the page asked for, on either side of the gap', () => {
    expect(
      forcedChanges(
        timeline([
          [0.05, 0, 360, 'start'],
          [3, 3, 720, 'manual'],
          [5, 5, 240, 'abr'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('the evidence that a ban may have held a rung', () => {
  it('is empty on a machine that dropped no frame and whose decisions are a switch interval apart', () => {
    expect(
      banEvidence({ frames: AUTHORS_MACHINE.frames, changesBeforeRecovery: AUTHORS_MACHINE.before }),
    ).toEqual([]);
    expect(banEvidence({ frames: CI_CHROMIUM.frames, changesBeforeRecovery: CI_CHROMIUM.before })).toEqual(
      [],
    );
  });

  it('is one dropped frame: a window after a switch or a stall holds so few frames that no larger number is a lower limit', () => {
    expect(
      banEvidence({ frames: { decoded: 366, dropped: 1 }, changesBeforeRecovery: AUTHORS_MACHINE.before }),
    ).toEqual(['1 of 366 frames were dropped']);
  });

  it('is a forced change, with or without a dropped frame', () => {
    const reasons = banEvidence({
      frames: { decoded: 1164, dropped: 0 },
      changesBeforeRecovery: CI_ATTEMPT_1.before,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(
      /a change came sooner than the switch interval allows \(240p at media time 21\.91 s, 4\.9 s/,
    );
  });

  it('says both when both are there (attempt 1 of the failed run)', () => {
    expect(
      banEvidence({ frames: CI_ATTEMPT_1.frames, changesBeforeRecovery: CI_ATTEMPT_1.before }),
    ).toHaveLength(2);
  });
});

describe('the first step up after the recovery', () => {
  it('on a machine that dropped no frame is bound by the link: 14 s, and the 9.6 s measured there pass', () => {
    const { bound, elapsed, within } = judge(AUTHORS_MACHINE);
    expect(bound.regime).toBe('link');
    expect(bound.seconds).toBe(14);
    expect(bound.basis).toMatch(
      /^no frame was dropped and no change came sooner than the switch interval allows/,
    );
    expect(elapsed).toBeCloseTo(9.6, 6);
    expect(within).toBe(true);
    expect(judge(CI_CHROMIUM).within).toBe(true);
  });

  it('on a machine that dropped no frame, a player that needs 20 s to climb fails: the ban\u2019s bound is not for it', () => {
    const slow = judge({ ...AUTHORS_MACHINE, stepUpAt: AUTHORS_MACHINE.recoveredAt + 20 });
    expect(slow.bound.regime).toBe('link');
    expect(slow.within).toBe(false);
  });

  it('on the macOS runner, attempt 0 (37 of 1271 frames dropped, 21.87 s) is within the bound of the ban and not of the link', () => {
    const { bound, elapsed, within } = judge(CI_ATTEMPT_0);
    expect(elapsed).toBeCloseTo(21.871, 3);
    expect(bound.regime).toBe('ban');
    expect(bound.seconds).toBe(33);
    expect(bound.basis).toMatch(/a ban may have held the rungs above \(37 of 1271 frames were dropped\)/);
    expect(within).toBe(true);
    expect(elapsed).toBeGreaterThan(upshiftBoundSeconds(2));
  });

  it('on the macOS runner, attempt 1 (40 of 1164 frames dropped and a change 4.9 s after the one before, 16.35 s) is within the bound of the ban', () => {
    const { bound, elapsed, within } = judge(CI_ATTEMPT_1);
    expect(elapsed).toBeCloseTo(16.35, 2);
    expect(bound.regime).toBe('ban');
    expect(within).toBe(true);
    expect(elapsed).toBeGreaterThan(upshiftBoundSeconds(2));
  });

  it('is the same bound for every run that may have had a ban, at its edge: 33 s passes, 33.01 s does not', () => {
    expect(judge({ ...CI_ATTEMPT_0, stepUpAt: CI_ATTEMPT_0.recoveredAt + 33 }).within).toBe(true);
    expect(judge({ ...CI_ATTEMPT_0, stepUpAt: CI_ATTEMPT_0.recoveredAt + 33.01 }).within).toBe(false);
  });

  it.each([
    ['a minute', 60],
    ['a minute and a half', 90],
    ['never', Number.POSITIVE_INFINITY],
  ])('a player that climbs after %s fails, whatever the machine dropped', (_name, seconds) => {
    for (const run of [AUTHORS_MACHINE, CI_ATTEMPT_0, CI_ATTEMPT_1, CI_CHROMIUM]) {
      expect(judge({ ...run, stepUpAt: run.recoveredAt + seconds }).within).toBe(false);
    }
  });

  it('follows the segments: 4 s segments widen both bounds, and the ban\u2019s stays the wider', () => {
    expect(upshiftBound(4, []).seconds).toBe(20);
    expect(upshiftBound(4, ['1 of 366 frames were dropped']).seconds).toBe(35);
    expect(upshiftBound(2, ['x']).seconds).toBeGreaterThan(upshiftBound(2, []).seconds);
  });
});

describe('the note in the message of a rung change', () => {
  it('is the dropped frames of the load when no change was forced', () => {
    const note = banNote({ decoded: 1271, dropped: 37 }, CI_ATTEMPT_0.before);
    expect(note).toMatch(/dropped frames in this load: 37 of 1271 \(2\.9 %\)$/);
    expect(note).not.toMatch(/forced/);
  });

  it('adds the changes the switch interval proves were forced, with their gaps', () => {
    const note = banNote({ decoded: 1164, dropped: 40 }, CI_ATTEMPT_1.before);
    expect(note).toMatch(
      /dropped frames in this load: 40 of 1164 \(3\.4 %\)\. Changes that came sooner than the 8 s the adaptation waits/,
    );
    expect(note).toMatch(
      /they were forced \(a ban\): 240p at media time 21\.91 s, 4\.9 s after the change before it$/,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A climb that the protection forced (ADR-106), on the four attempts of PB-ABR-002 that failed in the 40 repetitions on the GitHub macOS
// runner (fixtures.ts): in each the player stepped down to 240p, and 4.0 to 6.0 s later it climbed to 360p, a rung that the 600 kbps link
// cannot carry.

/** The step down to 240p is the fourth change of each run (index 3). */
const STEP_DOWN = 3;
const CARRIED = 240;

function climbOf(
  run: Pick<ForcedClimbRun, 'rows' | 'frames'>,
  override: Partial<Parameters<typeof forcedClimb>[0]> = {},
) {
  return forcedClimb({
    changes: timeline(run.rows),
    afterIndex: STEP_DOWN,
    carriedHeight: CARRIED,
    frames: run.frames,
    originFailures: 0,
    ...override,
  });
}

/** Run 20 up to its step down, then a climb to 360p `gap` seconds later (the page clock of the step down is 20.5 s, so the sums are exact). */
function climbAfterGap(gap: number, frames = { decoded: 974, dropped: 10 }) {
  const rows: Row[] = [
    [0.25, 0, 360, 'start'],
    [0.75, 0.25, 720, 'abr'],
    [12.5, 11.75, 360, 'abr'],
    [20.5, 19.75, 240, 'abr'],
    [20.5 + gap, 19.75 + gap, 360, 'abr'],
  ];
  return climbOf({ rows, frames });
}

describe('forcedClimb: the four attempts that failed on the macOS runner', () => {
  it.each(Object.entries(FORCED_CLIMB_RUNS))(
    '%s: the climb to 360p, a rung the link cannot carry, is found, with the gap its message printed',
    (_name, run) => {
      const climb = climbOf(run);
      expect(climb).not.toBeNull();
      expect(climb?.change.height).toBe(360);
      expect(climb?.after.height).toBe(240);
      expect(climb?.gapSeconds).toBeCloseTo(run.gap, 3);
      expect(climb?.gapSeconds).toBeLessThan(SHAKA_SWITCH_INTERVAL_S - DECISION_JITTER_S);
    },
  );

  it.each(Object.entries(FORCED_CLIMB_RUNS))(
    '%s: is not found when the link carries 360p, because the change is then to a rung the link can carry',
    (_name, run) => {
      expect(climbOf(run, { carriedHeight: 360 })).toBeNull();
    },
  );
});

describe('forcedClimb: what must still fail', () => {
  it('a change 8.1 s after the one before it is a decision of the adaptation, whatever the frames (a real flap)', () => {
    expect(climbAfterGap(8.1)).toBeNull();
    expect(climbAfterGap(8.1, { decoded: 974, dropped: 400 })).toBeNull();
  });

  it('the jitter of the clocks is allowed and not more: 7.75 s is a decision, 7.74 s is not', () => {
    expect(climbAfterGap(7.75)).toBeNull();
    expect(climbAfterGap(7.74)).not.toBeNull();
    expect(climbAfterGap(0.5)).not.toBeNull();
  });

  it('a climb that looks forced on a load that dropped no frame is not: the protection has nothing to act on', () => {
    const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
    expect(climbOf(run, { frames: { decoded: 974, dropped: 0 } })).toBeNull();
  });

  it('a climb on a load in which the origin failed a request is not: a failed request disables a rung as well', () => {
    const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
    expect(climbOf(run, { originFailures: 1 })).toBeNull();
  });

  it('a change the page asked for is not, on either side of the gap', () => {
    const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
    const manualClimb = [...run.rows];
    manualClimb[4] = [26.497, 25.888, 360, 'manual'];
    expect(climbOf({ ...run, rows: manualClimb })).toBeNull();
    const manualStepDown = [...run.rows];
    manualStepDown[3] = [20.636, 20.027, 240, 'manual'];
    expect(climbOf({ ...run, rows: manualStepDown })).toBeNull();
  });

  it('the first change after the step down decides: a real flap that comes first is never hidden by a forced climb after it', () => {
    const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
    const rows: Row[] = [
      ...run.rows.slice(0, 4),
      // 8.1 s after the step down: the adaptation's own decision, to a rung the link cannot carry
      [28.736, 28.127, 360, 'abr'],
      // 3 s after that one, inside the interval, with frames dropped: it looks forced, but the real flap came first
      [31.736, 31.127, 720, 'abr'],
    ];
    expect(climbOf({ ...run, rows })).toBeNull();
  });

  it('a change before the step down is not looked at, and neither is a timeline with nothing after it', () => {
    const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
    expect(climbOf(run, { afterIndex: 4 })).toBeNull();
    expect(climbOf(run, { afterIndex: 99 })).toBeNull();
    expect(climbOf({ rows: [], frames: run.frames })).toBeNull();
    // the early step down of the same run (720p to 360p, 11.6 s after the climb to 720p) is a change before the step down to 240p
    expect(climbOf(run, { afterIndex: 1 })).toBeNull();
  });

  it('a change to a rung the link carries is not a climb: the link of 1500 kbps carries 360p, so a change down to 240p is not one', () => {
    const rows: Row[] = [
      [0.206, 0, 360, 'start'],
      [0.878, 0.269, 720, 'abr'],
      [12.503, 11.894, 360, 'abr'],
      [15.5, 14.9, 240, 'abr'],
    ];
    expect(
      forcedClimb({
        changes: timeline(rows),
        afterIndex: 2,
        carriedHeight: 360,
        frames: { decoded: 974, dropped: 10 },
        originFailures: 0,
      }),
    ).toBeNull();
  });

  it('the first change after the initial selection is exempt from the interval: a step down right after the start is not forced', () => {
    const rows: Row[] = [
      [0.05, 0, 360, 'start'],
      [2, 0.2, 240, 'abr'],
      [4.2, 2.4, 360, 'abr'],
    ];
    // the step down is the change at index 1; the climb after it is 2.2 s later (the Firefox shape of PB-ABR-006): it IS found
    expect(
      forcedClimb({
        changes: timeline(rows),
        afterIndex: 1,
        carriedHeight: 240,
        frames: { decoded: 366, dropped: 13 },
        originFailures: 0,
      }),
    ).not.toBeNull();
    // but a first change after the start (a start on 240p, so no change before it of the adaptation's own) is exempt
    expect(
      forcedClimb({
        changes: timeline([
          [0.05, 0, 240, 'start'],
          [2.2, 2, 360, 'abr'],
        ]),
        afterIndex: 0,
        carriedHeight: 240,
        frames: { decoded: 366, dropped: 13 },
        originFailures: 0,
      }),
    ).toBeNull();
  });
});

describe('invalidRunReason', () => {
  const run = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;
  const climb = climbOf(run);

  it('starts with the numbers, inside the 90 characters that the flake report keeps of a cell', () => {
    if (!climb) throw new Error('run 20 must be a forced climb');
    const reason = invalidRunReason({
      climb,
      frames: run.frames,
      carriedHeight: 240,
      linkKbps: 600,
      boundaryMedia: 24,
    });
    expect(reason.slice(0, 89)).toMatch(
      /^invalid run: forced climb to 360p 5\.9 s after the step down, 10 of 974 frames dropped/,
    );
  });

  it('says how long after the playhead entered the first segment of the rung the climb came, when the log shows it', () => {
    if (!climb) throw new Error('run 20 must be a forced climb');
    const reason = invalidRunReason({
      climb,
      frames: run.frames,
      carriedHeight: 240,
      linkKbps: 600,
      boundaryMedia: 24,
    });
    expect(reason).toContain(
      "Shaka's dropped-frame protection, which bans the rung that plays for 30 s, fits, and it leaves only rungs above the 240p that the 600 kbps link carries",
    );
    expect(reason).toContain(
      'The climb is at media time 25.89 s, 1.9 s after the playhead entered the first 240p segment (media time 24.0 s).',
    );
  });

  it('leaves the boundary out when the log has no segment of the rung', () => {
    if (!climb) throw new Error('run 20 must be a forced climb');
    const reason = invalidRunReason({
      climb,
      frames: run.frames,
      carriedHeight: 240,
      linkKbps: 600,
      boundaryMedia: null,
    });
    expect(reason).toMatch(/The climb is at media time 25\.89 s\.$/);
    expect(reason).not.toMatch(/playhead entered/);
  });
});
