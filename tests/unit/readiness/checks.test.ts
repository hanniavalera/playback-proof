import { describe, expect, it } from 'vitest';
import {
  CHECK_TITLES,
  DRAIN_WITHIN_MS,
  JOIN_TIMEOUT_MS,
  STALL_AFTER_SEGMENTS,
  refreshSeries,
  runCadenceCheck,
  runLatencyCheck,
  runReadinessChecks,
  runStallCheck,
  runStartCheck,
} from '../../../src/lab/readiness/checks.ts';
import { candidateById } from '../../../src/lab/readiness/candidates.ts';
import { RELATIVE_TOLERANCE_MS, RESTORE_HOLD_MS } from '../../../src/lab/readiness/evaluators.ts';
import type { StallRun } from '../../../src/lab/readiness/evaluators.ts';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import { fakeWorld } from './fake-world.ts';

// The procedures of the checks, run against a scripted origin and player on a virtual clock: what they create, in what order, what they
// install and when, what they read, and what they make of a player that hangs, never runs dry or never resumes. The evaluators they end
// in are tested on their own (evaluators.test.ts); these tests are about the sequence, which is where a check can pass for the wrong reason.

const get = (result: { evaluations: Array<{ id: string }> }, id: string) => {
  const found = result.evaluations.find((evaluation) => evaluation.id === id);
  if (!found) throw new Error(`no evaluation ${id}`);
  return found as unknown as {
    id: string;
    verdict: string;
    scope: string;
    value: number | null;
    censored?: true;
    sentence: string;
    note?: string;
    detail?: Record<string, unknown>;
  };
};

describe('PB-RDY-001 stream start', () => {
  it('samples the joins in fresh sessions at different places in the segment interval, each in a context of its own', async () => {
    const { world, observed } = fakeWorld({ startupMs: [640, 700, 655, 1280, 702] });
    const result = await runStartCheck(world, { joins: 5 });
    expect(result.verdict).toBe('GO');
    expect(get(result, 'start.worst').value).toBe(1280);
    expect(observed.runs).toHaveLength(5);
    expect(observed.runs.map((run) => run.request.live?.startOffsetSec)).toEqual([
      30, 30.4, 30.8, 31.2, 31.6,
    ]);
    expect(observed.runs.every((run) => run.closed)).toBe(true);
    const phases = (result.samples.joins as Array<{ phaseMs: number }>).map((join) =>
      Math.round(join.phaseMs),
    );
    expect(new Set(phases).size).toBe(5);
    expect(Math.min(...phases)).toBeLessThan(500);
    expect(Math.max(...phases)).toBeGreaterThan(1500);
  });

  it('is a NO-GO when a join never presents a frame, still measures the others and still closes every context', async () => {
    const { world, observed } = fakeWorld({ startupMs: [700, 700, JOIN_TIMEOUT_MS, 700, 700] });
    const result = await runStartCheck(world, { joins: 5 });
    expect(result.verdict).toBe('NO-GO');
    expect(get(result, 'start.worst').sentence).toContain('join 3');
    expect(get(result, 'start.worst').sentence).toContain('timed out');
    expect(observed.runs).toHaveLength(5);
    expect(observed.runs.every((run) => run.closed)).toBe(true);
  });

  it('cannot judge fewer joins than the criterion asks for', async () => {
    const { world } = fakeWorld();
    expect((await runStartCheck(world, { joins: 3 })).verdict).toBe('INCONCLUSIVE');
  });

  it('applies the configuration under test BEFORE the player loads, and the result says it did', async () => {
    const { world, observed } = fakeWorld();
    const candidate = candidateById('live-sync');
    const result = await runStartCheck(world, { joins: 5, patch: candidate?.patch ?? null });
    expect(observed.runs.every((run) => run.configured.length === 1)).toBe(true);
    expect(observed.runs[0]?.configured[0]).toEqual({ streaming: { liveSync: { enabled: true } } });
    expect(result.player?.configured).toEqual([{ streaming: { liveSync: { enabled: true } } }]);
    // Shaka reads `streaming.liveSync.enabled` in load(): an idle page, then the configuration, then the load and the play.
    for (const run of observed.runs) {
      expect(run.calls).toEqual(['openIdle', 'configure', 'load', 'play']);
      expect(run.liveSyncAtLoad).toBe(true);
    }
    const plain = fakeWorld();
    const defaults = await runStartCheck(plain.world, { joins: 5 });
    expect(defaults.player?.configured).toEqual([]);
    // The defaults are opened as a viewer's page opens: with the manifest, and nothing is configured.
    for (const run of plain.observed.runs) {
      expect(run.calls).toEqual(['open']);
      expect(run.liveSyncAtLoad).toBe(false);
    }
  });
});

describe('PB-RDY-002 latency over a window', () => {
  it('reads latency once per second of media time over the window and is GO for a steady player', async () => {
    const { world } = fakeWorld({ baseLatencyMs: 6200 });
    const result = await runLatencyCheck(world, { windowSec: 60 });
    expect(result.verdict).toBe('GO');
    expect((result.samples.reads as unknown[]).length).toBe(60);
    expect(get(result, 'latency.p95').value).toBe(6200);
  });

  it('is a NO-GO when the latency of the whole window is above the limit', async () => {
    const { world } = fakeWorld({ baseLatencyMs: 10_500 });
    const result = await runLatencyCheck(world, { windowSec: 30 });
    expect(get(result, 'latency.max').verdict).toBe('NO-GO');
    expect(result.verdict).toBe('NO-GO');
  });

  it('ends a window in which the media clock stops, with a NO-GO that says when, and keeps the reads until then', async () => {
    const { world } = fakeWorld({ hangAfterMediaSec: 25 });
    const result = await runLatencyCheck(world, { windowSec: 60 });
    expect(result.verdict).toBe('NO-GO');
    expect(result.failure).toContain('media clock stopped');
    expect((result.samples.reads as unknown[]).length).toBeGreaterThan(20);
    expect((result.samples.reads as unknown[]).length).toBeLessThan(60);
  });

  it('is a NO-GO, with no reads, when the first frame never comes', async () => {
    const { world } = fakeWorld({ startupMs: [JOIN_TIMEOUT_MS] });
    const result = await runLatencyCheck(world, { windowSec: 30 });
    expect(result.verdict).toBe('NO-GO');
    expect(result.failure).toContain('no first frame');
  });
});

describe('PB-RDY-003 stall recovery', () => {
  it('finds what the defaults do: the outage costs a 4 s stall and the latency never comes back, so the restore line is the NO-GO', async () => {
    const { world, observed } = fakeWorld();
    const result = await runStallCheck(world, { runs: 3 });
    const recovery = get(result, 'stall.recovery');
    const restore = get(result, 'stall.restore');
    expect(recovery.verdict).toBe('GO');
    expect(recovery.value).toBe(4100);
    expect(restore.verdict).toBe('NO-GO');
    expect(restore.censored).toBe(true);
    expect(restore.value).toBeGreaterThanOrEqual(LIVE_LIMITS.latencyRestoreMaxMs + RESTORE_HOLD_MS);
    expect(result.verdict).toBe('NO-GO');
    expect(observed.runs).toHaveLength(3);
    expect(observed.runs.every((run) => run.closed)).toBe(true);
    const runs = result.samples.runs as StallRun[];
    expect(runs.map((run) => run.latencyBeforeMs)).toEqual([6200, 6200, 6200]);
    // The level before is the median of three reads, one per media second, and they are kept.
    expect(runs.map((run) => run.latencyBeforeReadsMs)).toEqual(Array(3).fill([6200, 6200, 6200]));
    expect(result.samples.relativeToleranceMs).toBe(RELATIVE_TOLERANCE_MS);
  });

  it("asks the same question relative to the session's own level, as an advisory line next to the criterion: the defaults fail it too", async () => {
    const { world } = fakeWorld();
    const result = await runStallCheck(world, { runs: 2 });
    const relative = get(result, 'stall.restore-relative');
    expect(relative.scope).toBe('advisory');
    expect(relative.verdict).toBe('NO-GO');
    expect(relative.censored).toBe(true);
    expect(relative.sentence).toContain('within 2.00 s of its own level before the outage');
    expect(relative.sentence).toContain('further behind than before the outage (6.20 s)');
    const runs = (relative.detail?.runs ?? []) as Array<{ ceilingMs: number; levelBeforeMs: number }>;
    expect(runs.map((run) => run.ceilingMs)).toEqual([8200, 8200]);
    // The absolute and the relative reading agree here, so there is nothing to note.
    expect(relative.note).toBeUndefined();
  });

  it('installs the origin outage the contract names, three segments from the edge it read, with the length of the policy', async () => {
    const { world, observed } = fakeWorld();
    await runStallCheck(world, { runs: 1 });
    const [rule] = observed.runs[0]?.faults ?? [];
    expect(rule).toMatchObject({ type: 'live-stall', ms: LIVE_LIMITS.injectedStallMs });
    // The session started at edge 15 (30 s on air) and 4 s of media were played after the first frame: the edge read was 17 or 18.
    const atNumber = rule && rule.type === 'live-stall' ? rule.atNumber : 0;
    expect(atNumber).toBeGreaterThanOrEqual(15 + STALL_AFTER_SEGMENTS);
    expect(atNumber).toBeLessThanOrEqual(15 + STALL_AFTER_SEGMENTS + 4);
  });

  it('shows GO for the candidate that brings the latency back, only because the check applied it before the outage', async () => {
    const candidate = candidateById('live-sync');
    const { world, observed } = fakeWorld();
    const result = await runStallCheck(world, { runs: 3, patch: candidate?.patch ?? null });
    const restore = get(result, 'stall.restore');
    expect(restore.verdict).toBe('GO');
    expect(restore.value).toBeGreaterThan(2000);
    expect(restore.value).toBeLessThan(5000);
    expect(restore.sentence).toContain('playback rate to 1.10');
    expect(result.verdict).toBe('GO');
    expect(observed.runs.every((run) => run.configured.length === 1)).toBe(true);
    // The relative reading asks for more of a player than the absolute one (back within a segment of where it was, not under the maximum),
    // so it is the one that ends the observation: seconds, not the full minute.
    const relative = get(result, 'stall.restore-relative');
    expect(relative.verdict).toBe('GO');
    expect(relative.scope).toBe('advisory');
    expect(relative.value).toBeGreaterThan(restore.value as number);
    const runs = result.samples.runs as StallRun[];
    expect(Math.max(...runs.map((run) => run.observedMs))).toBeLessThan(35_000);
    expect(Math.max(...runs.map((run) => run.observedMs))).toBeGreaterThan(
      (relative.value as number) + RESTORE_HOLD_MS - 1,
    );

    // The same player without the knob is the same NO-GO as the defaults: the fake only catches up when it was configured to.
    const without = await runStallCheck(fakeWorld().world, { runs: 1 });
    expect(get(without, 'stall.restore').verdict).toBe('NO-GO');
  });

  it('does not judge a recovery that was never exercised: a player that never ran dry is INCONCLUSIVE, not a pass', async () => {
    const { world } = fakeWorld({ neverRunsDry: true });
    const result = await runStallCheck(world, { runs: 2 });
    expect(get(result, 'stall.recovery').verdict).toBe('INCONCLUSIVE');
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.notes.join(' ')).toContain('never ran dry');
    expect(DRAIN_WITHIN_MS).toBe((3 * 2 + 6) * 1000 + 15_000);
  });

  it('is a NO-GO when the player ran dry and never resumed', async () => {
    const { world } = fakeWorld({ neverResumes: true });
    const result = await runStallCheck(world, { runs: 1 });
    expect(get(result, 'stall.recovery').verdict).toBe('NO-GO');
    expect(get(result, 'stall.recovery').censored).toBe(true);
    expect(result.verdict).toBe('NO-GO');
  });

  it('judges the worst of the runs: one slow resume is the number', async () => {
    const { world } = fakeWorld({ resumeDelayMs: LIVE_LIMITS.stallRecoveryMaxMs });
    const result = await runStallCheck(world, { runs: 2 });
    expect(get(result, 'stall.recovery').value).toBe(4100 + LIVE_LIMITS.stallRecoveryMaxMs);
    expect(get(result, 'stall.recovery').verdict).toBe('NO-GO');
  });
});

describe('PB-RDY-004 manifest cadence', () => {
  it('reads the gaps from the server log and is GO for the advertised period', async () => {
    const { world } = fakeWorld({ manifestEveryMs: 2000 });
    const result = await runCadenceCheck(world, { refreshes: 20 });
    expect(result.verdict).toBe('GO');
    expect(get(result, 'cadence.median').value).toBe(2000);
    expect((result.samples.arrivalsMs as number[]).length).toBeGreaterThanOrEqual(21);
  });

  it('is a NO-GO, with the gaps so far, when the player stops asking for the manifest', async () => {
    const { world } = fakeWorld({ manifestEveryMs: 2000, manifestStopsAfter: 12 });
    const result = await runCadenceCheck(world, { refreshes: 20 });
    expect(result.verdict).toBe('NO-GO');
    expect(result.failure).toContain('stopped tracking the live window');
    expect((result.samples.arrivalsMs as number[]).length).toBe(12);
  });

  it('is a NO-GO for a player that polls much faster than advertised', async () => {
    const { world } = fakeWorld({ manifestEveryMs: 400 });
    const result = await runCadenceCheck(world, { refreshes: 20 });
    expect(get(result, 'cadence.median').verdict).toBe('NO-GO');
  });

  it('picks the audio playlist of an HLS session as the refresh series, not the video playlists nor the master', () => {
    const entry = (seq: number, rep: string | undefined): RequestLogEntry => ({
      seq,
      t: new Date(Date.UTC(2030, 0, 1, 0, 0, seq)).toISOString(),
      msSinceStart: seq * 1000,
      method: 'GET',
      path: '/x',
      kind: 'manifest',
      ...(rep ? { rep } : {}),
      status: 200,
      bytes: 1,
      ttfbMs: 1,
      totalMs: 1,
      faults: [],
    });
    const log = [
      entry(1, undefined),
      entry(2, 'v360'),
      entry(3, 'a-aac'),
      entry(4, 'v720'),
      entry(5, 'a-aac'),
    ];
    expect(refreshSeries(log, 'hls', ['a-aac']).map((e) => e.seq)).toEqual([3, 5]);
    expect(refreshSeries(log, 'dash', []).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('every check of a configuration', () => {
  const options = {
    checks: ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-004'] as const,
    joins: 5,
    stallRuns: 1,
    windowSec: 30,
    refreshes: 12,
  };

  it('runs the selected checks in the order of the catalog, with their titles', async () => {
    const { world } = fakeWorld({ startupMs: [800] });
    const lines: string[] = [];
    const results = await runReadinessChecks(world, {
      ...options,
      checks: ['PB-RDY-004', 'PB-RDY-001'],
      log: (line) => lines.push(line),
    });
    expect(results.map((result) => result.id)).toEqual(['PB-RDY-004', 'PB-RDY-001']);
    expect(results.map((result) => result.title)).toEqual([
      CHECK_TITLES['PB-RDY-004'],
      CHECK_TITLES['PB-RDY-001'],
    ]);
    expect(lines.some((line) => line.includes('PB-RDY-001 Stream start'))).toBe(true);
  });

  it('reports a check the harness could not run as INCONCLUSIVE with the reason, and goes on with the others', async () => {
    const { world } = fakeWorld({ openFails: true });
    const results = await runReadinessChecks(world, { ...options, checks: ['PB-RDY-001', 'PB-RDY-002'] });
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.verdict).toBe('INCONCLUSIVE');
      expect(result.error).toContain('did not boot');
    }
  });
});
