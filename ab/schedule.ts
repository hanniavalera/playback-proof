import type { ArmId, ConfigLetter } from './types.ts';

// THE ORDER OF THE SESSIONS of an experiment (ADR-144 in docs/decisions/ab.md). It has no browser in it, so that the runner, which follows
// it, and the validity gates of the report, which check that it was followed, read the same function.

export interface ScheduledSession {
  /** 0-based position in the condition, warm-up included. */
  index: number;
  /** 0-based pair of sessions. */
  block: number;
  arm: ArmId;
  config: ConfigLetter;
  warmup: boolean;
}

/**
 * The order of the sessions: blocks of two, one session of each arm, and the arm that goes first ALTERNATES from block to block (A B, B A,
 * A B, B A, ...). A drift of the machine over the run (a thermal throttle, a background job starting, a cache warming) then falls on both
 * arms alike: with an even number of measured blocks the two arms have exactly the same average position in time, so a linear drift
 * cancels in the comparison. The first `warmupPerArm` blocks are the warm-up: executed like the rest, recorded, and left out.
 */
export function blockSchedule(
  sessionsPerArm: number,
  warmupPerArm: number,
  arms: { A: ConfigLetter; B: ConfigLetter },
): ScheduledSession[] {
  if (!Number.isInteger(sessionsPerArm) || sessionsPerArm < 1)
    throw new RangeError(`sessionsPerArm must be a positive integer, got ${String(sessionsPerArm)}`);
  if (!Number.isInteger(warmupPerArm) || warmupPerArm < 0)
    throw new RangeError(`warmupPerArm must be a non-negative integer, got ${String(warmupPerArm)}`);
  const schedule: ScheduledSession[] = [];
  for (let block = 0; block < warmupPerArm + sessionsPerArm; block++) {
    const order: ArmId[] = block % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    for (const arm of order) {
      schedule.push({ index: schedule.length, block, arm, config: arms[arm], warmup: block < warmupPerArm });
    }
  }
  return schedule;
}
