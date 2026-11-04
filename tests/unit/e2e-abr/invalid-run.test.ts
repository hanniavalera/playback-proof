import type { TestInfo } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import {
  invalidDownshiftOf,
  invalidRunOf,
  skipIfForcedClimb,
  skipIfForcedDownshift,
} from '../../../tests/e2e/abr/invalid-run.ts';
import type { InvalidDownshiftInput, InvalidRunInput } from '../../../tests/e2e/abr/invalid-run.ts';
import {
  FORCED_CLIMB_RUNS,
  FORCED_DOWNSHIFT_RUNS,
  downshiftLogOf,
  logOf,
  segmentEntry,
  timeline,
} from './fixtures.ts';
import type { ForcedClimbRun, ForcedDownshiftRun } from './fixtures.ts';

// The end of an attempt that cannot evaluate its claim (ADR-106): the decision from a load's timeline, frames and request log, and what
// the attempt leaves behind when it ends, in the order a reader and the reporters need it.

const run20 = FORCED_CLIMB_RUNS['run 20'] as ForcedClimbRun;

function inputOf(run: ForcedClimbRun, override: Partial<InvalidRunInput> = {}): InvalidRunInput {
  return {
    changes: timeline(run.rows),
    afterIndex: 3,
    carriedHeight: 240,
    carriedRep: 'v240',
    frames: run.frames,
    log: logOf(run),
    segmentDurationSec: 2,
    linkKbps: 600,
    ...override,
  };
}

describe('invalidRunOf', () => {
  it.each(Object.entries(FORCED_CLIMB_RUNS))(
    '%s: is an invalid run, and the climb came 1.9 s after the playhead entered the first 240p segment',
    (_name, run) => {
      const invalid = invalidRunOf(inputOf(run));
      expect(invalid).not.toBeNull();
      const entered = (run.firstV240Segment - 1) * 2;
      const offset = invalid?.facts.secondsAfterThePlayheadEnteredIt as number;
      expect(offset).toBeGreaterThan(1.88);
      expect(offset).toBeLessThan(1.93);
      expect(invalid?.facts.firstSegmentOfTheCarriedRungStartsAtMediaSeconds).toBe(entered);
      expect(invalid?.reason).toContain(`(media time ${entered.toFixed(1)} s)`);
    },
  );

  it('gives the facts of the attachment: the climb and the step down it undid, the frames, the link and every change', () => {
    const invalid = invalidRunOf(inputOf(run20));
    expect(invalid?.facts).toMatchObject({
      climb: {
        toHeight: 360,
        atMediaSeconds: 25.888,
        stepDownToHeight: 240,
        stepDownAtMediaSeconds: 20.027,
      },
      frames: { decoded: 974, dropped: 10 },
      carriedHeight: 240,
      linkKbps: 600,
    });
    expect((invalid?.facts.climb as { secondsAfterTheStepDown: number }).secondsAfterTheStepDown).toBeCloseTo(
      5.861,
      3,
    );
    expect(invalid?.facts.changes).toHaveLength(5);
  });

  it('is not one when the load dropped no frame', () => {
    expect(invalidRunOf(inputOf(run20, { frames: { decoded: 974, dropped: 0 } }))).toBeNull();
  });

  it('is not one when the origin failed a request, with a status of 400 or more or by cutting the response', () => {
    const failed = [...logOf(run20), segmentEntry(99, 'v240', 20, { status: 503 })];
    expect(invalidRunOf(inputOf(run20, { log: failed }))).toBeNull();
    const cut = [
      ...logOf(run20),
      segmentEntry(99, 'v240', 20, { aborted: true, abortReason: 'fault-abort' }),
    ];
    expect(invalidRunOf(inputOf(run20, { log: cut }))).toBeNull();
  });

  it('still is one when the player cancelled requests of its own: it does so at every switch (client-closed)', () => {
    const cancelled = [
      ...logOf(run20),
      segmentEntry(98, 'v720', 11, { aborted: true, abortReason: 'client-closed', bytes: 270_000 }),
      segmentEntry(99, 'v240', 18, { aborted: true, abortReason: 'client-closed', bytes: 17_000 }),
    ];
    expect(invalidRunOf(inputOf(run20, { log: cancelled }))).not.toBeNull();
  });

  it('still is one when the log has no segment of the rung (the reason leaves out where the playhead was)', () => {
    const invalid = invalidRunOf(inputOf(run20, { log: [] }));
    expect(invalid).not.toBeNull();
    expect(invalid?.facts.secondsAfterThePlayheadEnteredIt).toBeNull();
    expect(invalid?.reason).not.toMatch(/playhead entered/);
  });
});

/** The parts of `TestInfo` that the end of an attempt touches, recording the order in which it touches them. */
function fakeTestInfo() {
  const calls: string[] = [];
  const annotations: Array<{ type: string; description?: string }> = [];
  const attachments: Array<{ name: string; contentType?: string; body?: string | Buffer }> = [];
  const skips: Array<{ condition: boolean; description?: string }> = [];
  const info = {
    annotations,
    async attach(name: string, options: { contentType?: string; body?: string | Buffer }) {
      calls.push('attach');
      attachments.push({ name, ...options });
    },
    skip(condition: boolean, description?: string) {
      calls.push('skip');
      skips.push({ condition, ...(description === undefined ? {} : { description }) });
      // Playwright's own skip ends the test by throwing: so does this one, to show that nothing after it runs
      throw new Error('skipped');
    },
  };
  const push = annotations.push.bind(annotations);
  annotations.push = (...items) => {
    calls.push('annotation');
    return push(...items);
  };
  return { info: info as unknown as TestInfo, calls, annotations, attachments, skips };
}

describe('skipIfForcedClimb', () => {
  it('annotates, attaches and then skips, with one reason in the annotation and in the skip', async () => {
    const fake = fakeTestInfo();
    await expect(skipIfForcedClimb(fake.info, inputOf(run20))).rejects.toThrow('skipped');
    expect(fake.calls).toEqual(['annotation', 'attach', 'skip']);
    expect(fake.annotations).toHaveLength(1);
    expect(fake.annotations[0]?.type).toBe('invalid-run');
    expect(fake.skips).toEqual([{ condition: true, description: fake.annotations[0]?.description }]);
    expect(fake.skips[0]?.description).toMatch(
      /^invalid run: forced climb to 360p 5\.9 s after the step down, 10 of 974 frames dropped\. /,
    );
  });

  it('attaches invalid-run.json, which parses and carries the reason', async () => {
    const fake = fakeTestInfo();
    await expect(skipIfForcedClimb(fake.info, inputOf(run20))).rejects.toThrow('skipped');
    const [attachment] = fake.attachments;
    expect(attachment?.name).toBe('invalid-run.json');
    expect(attachment?.contentType).toBe('application/json');
    const facts = JSON.parse(String(attachment?.body)) as { reason: string; frames: { dropped: number } };
    expect(facts.reason).toBe(fake.skips[0]?.description);
    expect(facts.frames.dropped).toBe(10);
  });

  it('does nothing when the load shows no forced climb: no annotation, no attachment, no skip', async () => {
    const fake = fakeTestInfo();
    await expect(
      skipIfForcedClimb(fake.info, inputOf(run20, { frames: { decoded: 974, dropped: 0 } })),
    ).resolves.toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});

// The same end for PB-ABR-001 (amendment 3 of the ADR): a forced downshift from the top rung of a link that carries it, which the log
// has to prove.

const downshift10 = FORCED_DOWNSHIFT_RUNS['collection A, run 10, attempt 0'] as ForcedDownshiftRun;

/** What the spec gives it, with a log that is read (and counted) when the helper asks for it. */
function downshiftInputOf(
  run: ForcedDownshiftRun,
  override: Partial<InvalidDownshiftInput> = {},
  reads: { count: number } = { count: 0 },
): InvalidDownshiftInput {
  return {
    changes: timeline(run.rows),
    afterIndex: 1,
    carriedHeight: 720,
    carriedRep: 'v720',
    frames: run.frames,
    playerErrors: 0,
    segmentDurationSec: 2,
    linkKbps: 20_000,
    log: async () => {
      reads.count += 1;
      return downshiftLogOf(run);
    },
    ...override,
  };
}

describe('invalidDownshiftOf', () => {
  it.each(Object.entries(FORCED_DOWNSHIFT_RUNS))(
    '%s: is an invalid run, and the downshift came about 1.9 s after the playhead entered the first 720p segment',
    async (_name, run) => {
      const invalid = await invalidDownshiftOf(downshiftInputOf(run));
      expect(invalid).not.toBeNull();
      const offset = invalid?.facts.secondsAfterThePlayheadEnteredIt as number;
      expect(offset).toBeGreaterThan(1.87);
      expect(offset).toBeLessThan(2.25);
      expect(invalid?.facts.firstSegmentOfTheCarriedRungStartsAtMediaSeconds).toBe(
        (run.firstV720Segment - 1) * 2,
      );
      expect(invalid?.facts.audioSegmentsAskedForTwice).toEqual([run.repeatedAudio]);
      expect(invalid?.reason).toMatch(/^invalid run: forced downshift to 360p /);
    },
  );

  it('gives the facts of the attachment: the downshift and the climb it undid, the frames, the link, the log and every change', async () => {
    const invalid = await invalidDownshiftOf(downshiftInputOf(downshift10));
    expect(invalid?.facts).toMatchObject({
      downshift: { toHeight: 360, atMediaSeconds: 9.892, climbToHeight: 720, climbAtMediaSeconds: 0.635 },
      frames: { decoded: 398, dropped: 7 },
      carriedHeight: 720,
      linkKbps: 20_000,
      firstSegmentOfTheCarriedRungStartsAtMediaSeconds: 8,
      audioSegmentsAskedForTwice: ['a-aac #10'],
    });
    expect((invalid?.facts.downshift as { secondsAfterTheClimb: number }).secondsAfterTheClimb).toBeCloseTo(
      9.256,
      3,
    );
    expect(invalid?.facts.changes).toHaveLength(3);
  });

  it('does not read the log when nothing changed after the rung was reached: the passing path is left as it was', async () => {
    const reads = { count: 0 };
    const held = { ...downshift10, rows: downshift10.rows.slice(0, 2) };
    await expect(invalidDownshiftOf(downshiftInputOf(held, {}, reads))).resolves.toBeNull();
    expect(reads.count).toBe(0);
    const reads2 = { count: 0 };
    await expect(invalidDownshiftOf(downshiftInputOf(downshift10, {}, reads2))).resolves.not.toBeNull();
    expect(reads2.count).toBe(1);
  });

  it('is not one when the load dropped no frame, or the player raised an error', async () => {
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { frames: { decoded: 398, dropped: 0 } })),
    ).resolves.toBeNull();
    await expect(invalidDownshiftOf(downshiftInputOf(downshift10, { playerErrors: 1 }))).resolves.toBeNull();
  });

  it('is not one when the origin failed a request, with a status of 400 or more or by cutting the response', async () => {
    const failed = [...downshiftLogOf(downshift10), segmentEntry(99, 'v360', 11, { status: 503 })];
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { log: async () => failed })),
    ).resolves.toBeNull();
    const cut = [
      ...downshiftLogOf(downshift10),
      segmentEntry(99, 'v360', 11, { aborted: true, abortReason: 'fault-abort' }),
    ];
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { log: async () => cut })),
    ).resolves.toBeNull();
  });

  it('is not one when no audio segment was asked for twice: the adaptation leaves the audio stream alone', async () => {
    const once = downshiftLogOf(downshift10).filter((entry) => entry.bytes !== 0 || entry.rep !== 'a-aac');
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { log: async () => once })),
    ).resolves.toBeNull();
  });

  it('is not one when the log has no segment of the rung: there is no entry to measure the downshift from', async () => {
    const noTop = downshiftLogOf(downshift10).filter((entry) => entry.rep !== 'v720');
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { log: async () => noTop })),
    ).resolves.toBeNull();
  });

  it('still is one when the player cancelled requests of its own: it does so at every switch (client-closed)', async () => {
    const cancelled = downshiftLogOf(downshift10);
    expect(cancelled.some((entry) => entry.abortReason === 'client-closed')).toBe(true);
    await expect(
      invalidDownshiftOf(downshiftInputOf(downshift10, { log: async () => cancelled })),
    ).resolves.not.toBeNull();
  });
});

describe('skipIfForcedDownshift', () => {
  it('annotates, attaches and then skips, with one reason in the annotation and in the skip', async () => {
    const fake = fakeTestInfo();
    await expect(skipIfForcedDownshift(fake.info, downshiftInputOf(downshift10))).rejects.toThrow('skipped');
    expect(fake.calls).toEqual(['annotation', 'attach', 'skip']);
    expect(fake.annotations).toHaveLength(1);
    expect(fake.annotations[0]?.type).toBe('invalid-run');
    expect(fake.skips).toEqual([{ condition: true, description: fake.annotations[0]?.description }]);
    expect(fake.skips[0]?.description).toMatch(
      /^invalid run: forced downshift to 360p 1\.9 s after entering 720p, 7 of 398 frames dropped\. /,
    );
  });

  it('attaches invalid-run.json, which parses and carries the reason', async () => {
    const fake = fakeTestInfo();
    await expect(skipIfForcedDownshift(fake.info, downshiftInputOf(downshift10))).rejects.toThrow('skipped');
    const [attachment] = fake.attachments;
    expect(attachment?.name).toBe('invalid-run.json');
    expect(attachment?.contentType).toBe('application/json');
    const facts = JSON.parse(String(attachment?.body)) as {
      reason: string;
      audioSegmentsAskedForTwice: string[];
    };
    expect(facts.reason).toBe(fake.skips[0]?.description);
    expect(facts.audioSegmentsAskedForTwice).toEqual(['a-aac #10']);
  });

  it('does nothing when the load shows no forced downshift: no annotation, no attachment, no skip', async () => {
    const fake = fakeTestInfo();
    await expect(
      skipIfForcedDownshift(fake.info, downshiftInputOf(downshift10, { playerErrors: 2 })),
    ).resolves.toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});
