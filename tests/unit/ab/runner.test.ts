import { describe, expect, it } from 'vitest';
import { assertConfiguration, blockSchedule, runCondition } from '../../../ab/experiment.ts';
import { canonicalJson } from '../../../ab/prereg.ts';
import type { Preregistration } from '../../../ab/prereg.ts';
import { FLAVOUR_IDS } from '../../../src/lab/probe/formats.ts';
import { resolveEnvironment } from '../../../src/lab/gaps.ts';
import { configFor } from '../../../src/player/configs.ts';
import { HarnessError } from '../../../src/lab/measure/runner.ts';
import type { QAInfo } from '../../../src/shared/qa.ts';
import { probedEngine, resultFile, verdict } from '../probe/fixtures.ts';
import { planFrom, smallPlan, world } from './fake-world.ts';
import type { Script } from './fake-world.ts';
import { rebufferPrereg } from './fixtures.ts';

// The runner with a browser, a service and a player that are fakes (fake-world.ts): what is under test is WHEN things are created, recorded,
// discarded and closed, which arm runs with which configuration in which order, and what becomes of a session that fails. What a real
// browser does is the pipeline check of the second phase.

const conditionOf = (prereg: Preregistration): Preregistration['conditions'][number] =>
  prereg.conditions[0] as Preregistration['conditions'][number];

describe('PB-AB runner: the order of the sessions', () => {
  it('interleaves the arms in blocks of two and alternates the arm that goes first (A B, B A, A B, ...)', () => {
    const schedule = blockSchedule(4, 0, { A: 'A', B: 'B' });
    expect(schedule.map((s) => s.arm).join('')).toBe('ABBAABBA');
    expect(schedule.map((s) => s.block)).toStrictEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(schedule.map((s) => s.index)).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(schedule.every((s) => !s.warmup)).toBe(true);
  });

  it('puts the same average position in time on both arms for an even number of blocks, so that a linear drift cancels', () => {
    for (const blocks of [2, 4, 30]) {
      const measured = blockSchedule(blocks, 2, { A: 'A', B: 'B' }).filter((s) => !s.warmup);
      const mean = (arm: 'A' | 'B'): number => {
        const own = measured.filter((s) => s.arm === arm);
        return own.reduce((sum, s) => sum + s.index, 0) / own.length;
      };
      expect(mean('A')).toBe(mean('B'));
    }
    // An odd number of measured blocks does not balance: that is why the pre-registration insists on an even one.
    const odd = blockSchedule(3, 0, { A: 'A', B: 'B' });
    const average = (arm: 'A' | 'B'): number =>
      odd.filter((s) => s.arm === arm).reduce((sum, s) => sum + s.index, 0) / 3;
    expect(average('A')).not.toBe(average('B'));
  });

  it('marks the first blocks as the warm-up of both arms, and hands the configuration letter of each arm', () => {
    const schedule = blockSchedule(2, 2, { A: 'A', B: 'B' });
    expect(schedule.map((s) => s.warmup)).toStrictEqual([true, true, true, true, false, false, false, false]);
    expect(schedule.filter((s) => s.arm === 'A').every((s) => s.config === 'A')).toBe(true);
    expect(schedule.filter((s) => s.arm === 'B').every((s) => s.config === 'B')).toBe(true);
    expect(blockSchedule(2, 0, { A: 'A', B: 'A' }).every((s) => s.config === 'A')).toBe(true);
  });

  it('refuses a design that is not one', () => {
    expect(() => blockSchedule(0, 0, { A: 'A', B: 'B' })).toThrow(RangeError);
    expect(() => blockSchedule(2.5, 0, { A: 'A', B: 'B' })).toThrow(RangeError);
    expect(() => blockSchedule(2, -1, { A: 'A', B: 'B' })).toThrow(RangeError);
  });
});

describe('PB-AB runner: one condition', () => {
  it('runs the schedule, hands each session the configuration of its arm, records the warm-up apart and keeps every number', async () => {
    const w = world();
    const prereg = smallPlan();
    const run = await runCondition(prereg, conditionOf(prereg), w.deps);
    const { result } = run;
    expect(result.sessions).toHaveLength(10);
    expect(result.sessions.map((s) => s.arm).join('')).toBe('ABBAABBAAB');
    expect(result.sessions.map((s) => s.warmup)).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(w.opens.map((open) => open.config).join('')).toBe('ABBAABBAAB');
    for (const open of w.opens) expect(open.manifest).toMatch(/^\/s\/s\d+\/vod-cmaf\/dash\/manifest\.mpd$/);
    expect(result.id).toBe('high-latency');
    expect(result.aborted).toBeNull();
    expect(result.loadAverage).toStrictEqual({ before: 1.25, after: 1.25 });
    expect(run.browser).toStrictEqual({
      name: 'chromium',
      version: '156.0.8078.4',
      userAgent: 'Mozilla/5.0 Chrome/156',
    });

    const a = result.sessions.find((s) => s.arm === 'A' && !s.warmup);
    const b = result.sessions.find((s) => s.arm === 'B' && !s.warmup);
    expect(a).toMatchObject({ status: 'ok', config: 'A', condition: 'high-latency', startRungHeight: 720 });
    expect(a?.values).toMatchObject({ startupMs: expect.any(Number), manifestMs: expect.any(Number) });
    expect(b).toMatchObject({ status: 'ok', config: 'B', startRungHeight: 240 });
    expect(b?.rungs.map((rung) => `${rung.reason}:${rung.height}`)).toStrictEqual([
      'start:240',
      'abr:360',
      'abr:720',
    ]);
  });

  it('records what qa.info() said: the letter, the exact override object and what Shaka held at those keys', async () => {
    const w = world();
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    const a = result.sessions.find((s) => s.arm === 'A');
    const b = result.sessions.find((s) => s.arm === 'B');
    expect(a?.info).toMatchObject({
      config: 'A',
      configOverrides: {},
      loadMode: 'media-source',
      userAgent: 'Mozilla/5.0 Chrome/156',
    });
    expect(canonicalJson(b?.info?.configOverrides)).toBe(canonicalJson(configFor('B')));
    expect(b?.info?.configOverrides).toMatchObject({
      abr: { useNetworkInformation: false, switchInterval: 4 },
      streaming: { bufferingGoal: 20 },
    });
    expect(b?.info?.configDefaults).toStrictEqual({ abr: { switchInterval: 8 } });
  });

  it("creates a service session for every session with the condition's rules (a copy), and a fresh context, closing both", async () => {
    const w = world();
    const prereg = smallPlan();
    const condition = conditionOf(prereg);
    await runCondition(prereg, condition, w.deps);
    expect(w.sessions).toHaveLength(10);
    for (const request of w.sessions) {
      expect(request).toMatchObject({ stream: 'vod-cmaf', protocol: 'dash', ttlSec: 600 });
      expect(request.label).toContain('ab PB-AB-002 high-latency');
      expect(request.faults).toStrictEqual(condition.rules);
      expect(request.faults).not.toBe(condition.rules);
    }
    expect(w.sessions[0]?.label).toContain('warm-up A #1');
    // One browser for the condition, a context per session opened and closed, a session per run created and deleted.
    expect(w.log.filter((line) => line === 'browser launched')).toHaveLength(1);
    expect(w.log.filter((line) => /^context \d+ open$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^context \d+ closed$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ created$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ deleted$/.test(line))).toHaveLength(10);
    expect(w.log.at(-1)).toBe('browser closed');
    const first = w.log.indexOf('session s1 created');
    expect(w.log.indexOf('session s1 deleted')).toBeLessThan(w.log.indexOf('session s2 created'));
    expect(first).toBeGreaterThan(w.log.indexOf('browser launched'));
  });

  it('ends a startup session at the first frame (no playback, the numbers that need playback are null), and plays on when the plan says so', async () => {
    const startup = world();
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), startup.deps);
    expect(startup.mediaWaits).toStrictEqual([]);
    expect(result.sessions[0]?.values).toMatchObject({
      rebufferCount: null,
      rebufferMs: null,
      rebufferRatio: null,
      switches: null,
      droppedRatio: null,
    });

    const rebuffer = world((arm) => ({ rebuffers: arm === 'B' ? 1 : 0 }));
    const plan = planFrom({
      ...rebufferPrereg(),
      kind: 'pipeline-check',
      catalogId: null,
      sessionsPerArm: 2,
      warmupSessionsPerArm: 0,
      bootstrapResamples: 100,
    });
    const played = await runCondition(plan, conditionOf(plan), rebuffer.deps);
    expect(rebuffer.mediaWaits).toStrictEqual([18.5, 18.5, 18.5, 18.5]);
    const b = played.result.sessions.find((s) => s.arm === 'B');
    expect(b?.values).toMatchObject({
      rebufferCount: 1,
      rebufferMs: 1500,
      rebufferRatio: 0.05,
      switches: 2,
      droppedRatio: 0.01,
    });
  });

  it('reports progress: the condition, then every session as it finishes', async () => {
    const w = world();
    const prereg = smallPlan();
    await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(w.progress[0]).toStrictEqual({
      kind: 'condition',
      condition: 'high-latency',
      sessions: 10,
      warmup: 2,
    });
    expect(w.progress.filter((event) => event.kind === 'session')).toHaveLength(10);
  });
});

describe('PB-AB runner: a session that fails is recorded, never dropped, and the run goes on', () => {
  const failing: Script = (_arm, index) =>
    index === 4
      ? { fail: 'timeout' }
      : index === 6
        ? { fail: 'critical' }
        : index === 7
          ? { fail: 'page' }
          : {};

  it('classifies a timeout, a critical error and a page failure, keeps no numbers for them, and still closes what it opened', async () => {
    const w = world(failing);
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions).toHaveLength(10);
    const failures = result.sessions.filter((s) => s.status === 'failed');
    expect(failures.map((s) => [s.index, s.failure?.kind])).toStrictEqual([
      [4, 'timeout'],
      [6, 'critical-error'],
      [7, 'page'],
    ]);
    for (const failure of failures) {
      expect(failure.values).toStrictEqual({});
      expect(failure.failure?.message).toContain('the last events of the player');
    }
    expect(failures[1]?.failure?.message).toContain('BAD_HTTP_STATUS/2');
    expect(result.sessions.filter((s) => s.status === 'ok')).toHaveLength(7);
    expect(w.log.filter((line) => /^context \d+ closed$/.test(line))).toHaveLength(10);
    expect(w.log.filter((line) => /^session s\d+ deleted$/.test(line))).toHaveLength(10);
  });

  it('a session that played through something other than Media Source Extensions is a failure, not a measurement', async () => {
    const w = world((_arm, index) => (index === 3 ? { fail: 'not-mse' } : {}));
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions[3]).toMatchObject({ status: 'failed', failure: { kind: 'page' } });
    expect(result.sessions[3]?.failure?.message).toContain('Media Source Extensions');
  });

  it('stops the condition after the pre-registered number of failures in a row, with the sessions it has, and says why', async () => {
    const w = world((_arm, index) => (index >= 2 ? { fail: 'timeout' } : {}));
    const prereg = smallPlan({
      exclusionRule: { text: 'x'.repeat(70), maxFailedShare: 0.1, abortAfterConsecutiveFailures: 3 },
    });
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions).toHaveLength(5);
    expect(result.aborted).toContain('3 sessions failed in a row');
    expect(result.aborted).toContain('the harness or the environment is broken');
    expect(w.log.at(-1)).toBe('browser closed');
  });

  it('a failure between two good sessions does not count as a streak', async () => {
    const w = world((_arm, index) => (index === 2 || index === 4 || index === 6 ? { fail: 'timeout' } : {}));
    const prereg = smallPlan({
      exclusionRule: { text: 'x'.repeat(70), maxFailedShare: 0.1, abortAfterConsecutiveFailures: 2 },
    });
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions).toHaveLength(10);
    expect(result.aborted).toBeNull();
  });
});

describe('PB-AB runner: the condition is proved from the service, session by session', () => {
  it('records for every finished session that the service held exactly the rules of the condition, and how many requests each fired on', async () => {
    const w = world();
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions).toHaveLength(10);
    for (const session of result.sessions)
      expect(session.applied, `session ${session.index}`).toStrictEqual({
        rulesMatch: true,
        requests: 12,
        fired: [12],
      });
  });

  it('creates every session of both arms with the same rules: identical conditions, the warm-up included', async () => {
    const w = world();
    const prereg = smallPlan();
    await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(w.sessions).toHaveLength(10);
    const registered = canonicalJson(conditionOf(prereg).rules);
    expect(new Set(w.sessions.map((request) => canonicalJson(request.faults)))).toStrictEqual(
      new Set([registered]),
    );
  });

  it('records a condition that was not applied (no request met the rule) and goes on: the validity of the run is judged at the end', async () => {
    const w = world((_arm, index) => (index === 3 ? { fail: 'not-applied' } : {}));
    const prereg = smallPlan();
    const { result } = await runCondition(prereg, conditionOf(prereg), w.deps);
    expect(result.sessions[3]?.status).toBe('ok');
    expect(result.sessions[3]?.applied).toStrictEqual({ rulesMatch: true, requests: 12, fired: [0] });
    expect(result.sessions[4]?.applied?.fired).toStrictEqual([12]);
  });

  it('ends the run when the service holds other rules than the ones it was given: the arms would not meet the registered condition', async () => {
    const w = world((_arm, index) => (index === 2 ? { fail: 'rules-mismatch' } : {}));
    const prereg = smallPlan();
    const attempt = runCondition(prereg, conditionOf(prereg), w.deps);
    await expect(attempt).rejects.toThrow(HarnessError);
    await expect(attempt).rejects.toThrow(
      /the service holds other rules for the session than the condition's/,
    );
    expect(w.log).toContain('browser closed');
  });

  it('ends the run when the service cannot say what it holds, instead of recording a session nobody can vouch for', async () => {
    const w = world((_arm, index) => (index === 1 ? { fail: 'unreadable' } : {}));
    const prereg = smallPlan();
    const attempt = runCondition(prereg, conditionOf(prereg), w.deps);
    await expect(attempt).rejects.toThrow(
      /could not read what the service holds for the session: the service did not answer/,
    );
  });
});

describe('PB-AB runner: what stops the whole run', () => {
  it('a page that runs another configuration than its arm is a defect of the harness, not a failed session', async () => {
    const w = world((_arm, index) => (index === 2 ? { fail: 'mismatch' } : {}));
    const prereg = smallPlan();
    const attempt = runCondition(prereg, conditionOf(prereg), w.deps);
    await expect(attempt).rejects.toBeInstanceOf(HarnessError);
    await expect(attempt).rejects.toThrow(/the page runs configuration .*, the arm needs/);
    expect(w.log.at(-1)).toBe('browser closed');
    expect(w.log.filter((line) => /^session s\d+ created$/.test(line)).length).toBe(
      w.log.filter((line) => /^session s\d+ deleted$/.test(line)).length,
    );
  });

  it('checks the exact overrides, and that ABR is on', () => {
    const base = {
      config: 'B',
      configOverrides: configFor('B') as Record<string, unknown>,
      params: { abr: true },
    } as unknown as QAInfo;
    expect(() => assertConfiguration(base, 'B', 'x')).not.toThrow();
    expect(() =>
      assertConfiguration({ ...base, configOverrides: { abr: { switchInterval: 4 } } }, 'B', 'x'),
    ).toThrow(/overrides the page applied/);
    expect(() => assertConfiguration({ ...base, config: 'A', configOverrides: {} }, 'B', 'x')).toThrow(
      /runs configuration A/,
    );
    expect(() =>
      assertConfiguration({ ...base, params: { abr: false } } as unknown as QAInfo, 'B', 'x'),
    ).toThrow(/ABR was off/);
    expect(() =>
      assertConfiguration(
        {
          config: 'A',
          configOverrides: { abr: { switchInterval: 1 } },
          params: { abr: true },
        } as unknown as QAInfo,
        'A',
        'x',
      ),
    ).toThrow();
  });

  it('a service that cannot create a session ends the run, naming the session', async () => {
    const w = world(() => ({}), { failSession: true });
    const prereg = smallPlan();
    const attempt = runCondition(prereg, conditionOf(prereg), w.deps);
    await expect(attempt).rejects.toMatchObject({ kind: 'run' });
    await expect(attempt).rejects.toThrow(
      /PB-AB-002 high-latency warm-up A #1: could not set the session up: the service is gone/,
    );
    expect(w.log.at(-1)).toBe('browser closed');
  });

  it('a browser that does not start ends the run before any session exists', async () => {
    const w = world(() => ({}), { failLaunch: true });
    const prereg = smallPlan();
    const attempt = runCondition(prereg, conditionOf(prereg), w.deps);
    await expect(attempt).rejects.toMatchObject({ kind: 'launch' });
    expect(w.sessions).toStrictEqual([]);
  });

  it('refuses where the engine cannot play the stream (a documented gap), launching nothing', async () => {
    const gapped = resolveEnvironment({
      envId: 'fixture-linux-arm64',
      engine: 'webkit',
      platform: 'linux',
      runInLinuxWebKit: false,
      evidence: resultFile('fixture-linux-arm64', {
        webkit: probedEngine({
          version: '3.0',
          cases: Object.fromEntries(FLAVOUR_IDS.map((id) => [id, verdict(2, 5, true)])),
        }),
      }),
    });
    const w = world();
    const prereg = smallPlan({ engine: 'webkit' });
    const attempt = runCondition(prereg, conditionOf(prereg), { ...w.deps, environment: gapped });
    await expect(attempt).rejects.toMatchObject({ kind: 'gap' });
    await expect(attempt).rejects.toThrow(/PB-AB-002 cannot run in fixture-linux-arm64: documented gap/);
    expect(w.log).toStrictEqual([]);
  });
});
