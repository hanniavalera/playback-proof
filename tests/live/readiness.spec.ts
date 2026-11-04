import type { TestInfo } from '@playwright/test';
import {
  DEFAULT_DRAIN_SEC,
  DEFAULT_HEAP_EVERY_SEC,
  DEFAULT_REFRESHES,
  DEFAULT_SAMPLE_SEC,
  DEFAULT_STALL_RUNS,
  DEFAULT_WINDOW_SEC,
  defaultInjections,
} from '../../src/lab/readiness/args.ts';
import { renderSoakReport } from '../../src/lab/readiness/checklist.ts';
import {
  runCadenceCheck,
  runLatencyCheck,
  runStallCheck,
  runStartCheck,
} from '../../src/lab/readiness/checks.ts';
import type { CheckResult } from '../../src/lab/readiness/checks.ts';
import { playwrightWorld } from '../../src/lab/readiness/playwright-world.ts';
import { buildSoakReport, runSoak } from '../../src/lab/readiness/soak.ts';
import { playwrightSoakDriver } from '../../src/lab/readiness/soak-driver.ts';
import type { Engine } from '../../src/lab/readiness/soak-evaluators.ts';
import { collectHostInfo } from '../../src/lab/probe/host-info.ts';
import { LIVE_LIMITS } from '../../src/shared/criteria.ts';
import { expect, test } from '../e2e/support/fixtures.ts';
import { candidateUnderTest, launchedFrom, problemsOf, specWorld } from './support.ts';
import type { ProjectContext } from './support.ts';

// Live-event readiness (TEST_STRATEGY.md section 8): the checks that judge the numbers, where the live and recovery specs of the merge gate
// judge the behaviour. They take their limits from `LIVE_LIMITS` (src/shared/criteria.ts) and never carry a number of the policy; the
// procedures are those of `npm run readiness` (src/lab/readiness/checks.ts), which also prints the go/no-go sheet and writes the results.
//
// They need minutes of real time, so each has an explicit timeout. They judge the build as it ships (configuration A); set
// PB_READINESS_CANDIDATE=live-sync to judge a candidate configuration instead (docs/decisions/readiness.md, ADR-153). PB-RDY-003 is red for
// configuration A in every engine that was measured, which is the finding of the phase and not a flaw of the check: see ADR-153.

/** Everything of the project's context that `browser.newContext()` would not inherit: the device the project stands for. */
type Device = ProjectContext;

async function keep(testInfo: TestInfo, name: string, body: unknown): Promise<void> {
  await testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
}

async function judged(testInfo: TestInfo, result: CheckResult): Promise<void> {
  await keep(testInfo, `${result.id}.json`, result);
  expect(
    problemsOf(result),
    `${result.id} ${result.title}: ${result.evaluations.length} evaluations, limits from LIVE_LIMITS (the measured series are attached as ${result.id}.json)`,
  ).toEqual([]);
}

const engineOf = (name: string): Engine => name as Engine;

test(
  'PB-RDY-001 stream start: every sampled fresh live join reaches the first frame within the start limit',
  { tag: ['@release', '@live', '@dash'] },
  async (
    {
      browser,
      service,
      environment,
      newSession,
      streamFor,
      player,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    testInfo,
  ) => {
    test.setTimeout(180_000);
    const device: Device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const world = specWorld({
      engine: engineOf(environment.engine),
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      service,
      browser,
      context: device,
      newSession,
      player,
    });
    const result = await runStartCheck(world, {
      joins: LIVE_LIMITS.startSamples,
      patch: candidateUnderTest()?.patch ?? null,
    });
    await judged(testInfo, result);
  },
);

test(
  'PB-RDY-002 live-edge latency over a window: p95 and maximum within the limits',
  { tag: ['@release', '@live', '@dash'] },
  async (
    {
      browser,
      service,
      environment,
      newSession,
      streamFor,
      player,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    testInfo,
  ) => {
    test.setTimeout((DEFAULT_WINDOW_SEC + 90) * 1000);
    const device: Device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const world = specWorld({
      engine: engineOf(environment.engine),
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      service,
      browser,
      context: device,
      newSession,
      player,
    });
    const result = await runLatencyCheck(world, {
      windowSec: DEFAULT_WINDOW_SEC,
      patch: candidateUnderTest()?.patch ?? null,
    });
    await judged(testInfo, result);
  },
);

test(
  'PB-RDY-003 stall recovery after an injected origin stall: recovery within the limit and latency restored within its limit',
  { tag: ['@release', '@live', '@dash'] },
  async (
    {
      browser,
      service,
      environment,
      newSession,
      streamFor,
      player,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    testInfo,
  ) => {
    // Per outage: the lead to the stall (about 20 s), the resume (up to the recovery limit and its slack) and the watch of the restoration
    // (the limit and its hold): the worst case of every run, three runs, and a minute of slack.
    const perRunMs = 60_000 + LIVE_LIMITS.stallRecoveryMaxMs + LIVE_LIMITS.latencyRestoreMaxMs + 5_000;
    test.setTimeout(DEFAULT_STALL_RUNS * perRunMs + 60_000);
    const device: Device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const world = specWorld({
      engine: engineOf(environment.engine),
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      service,
      browser,
      context: device,
      newSession,
      player,
    });
    const result = await runStallCheck(world, {
      runs: DEFAULT_STALL_RUNS,
      patch: candidateUnderTest()?.patch ?? null,
    });
    await judged(testInfo, result);
  },
);

test(
  'PB-RDY-004 manifest update cadence: median and longest gap between refreshes within the limits',
  { tag: ['@release', '@live', '@dash'] },
  async (
    {
      browser,
      service,
      environment,
      newSession,
      streamFor,
      player,
      viewport,
      userAgent,
      deviceScaleFactor,
      isMobile,
      hasTouch,
    },
    testInfo,
  ) => {
    test.setTimeout((DEFAULT_REFRESHES + 5) * LIVE_LIMITS.manifestPeriodMs + 120_000);
    const device: Device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const world = specWorld({
      engine: engineOf(environment.engine),
      stream: streamFor('live', 'dash'),
      protocol: 'dash',
      service,
      browser,
      context: device,
      newSession,
      player,
    });
    const result = await runCadenceCheck(world, {
      refreshes: DEFAULT_REFRESHES,
      patch: candidateUnderTest()?.patch ?? null,
    });
    await judged(testInfo, result);
  },
);

test(
  'PB-RDY-005 soak: no unrecovered stall, no critical error, rebuffer ratio, latency drift, JS heap growth (Chromium) and dropped frames within the limits',
  { tag: ['@release', '@live', '@soak', '@dash'] },
  async (
    { browser, service, environment, streamFor, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch },
    testInfo,
  ) => {
    // The CI soak: the length the policy names for the nightly pipeline. The release soak is `npm run soak -- --minutes release`.
    const minutes = LIVE_LIMITS.soakMinutesCi;
    // The soak, the stall it may end in (the recovery limit), the page's start and the harness's own readings, with room.
    test.setTimeout((minutes + 5) * 60_000);
    const engine = engineOf(environment.engine);
    const stream = streamFor('live', 'dash');
    const device: Device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const world = playwrightWorld({
      engine,
      stream,
      protocol: 'dash',
      service,
      browser: launchedFrom({ browser, engine, context: device }),
    });
    const injections = defaultInjections(minutes);
    const candidate = candidateUnderTest();
    const driver = playwrightSoakDriver(world, {
      minutes,
      stallAtMinutes: injections.stallAtMinutes,
      staleAtMinutes: injections.staleAtMinutes,
      patch: candidate?.patch ?? null,
      servicePid: null,
    });
    const run = await runSoak(driver, {
      engine,
      minutes,
      warmupSec: LIVE_LIMITS.warmupSec,
      sampleSec: DEFAULT_SAMPLE_SEC,
      heapEverySec: DEFAULT_HEAP_EVERY_SEC,
      drainSec: DEFAULT_DRAIN_SEC,
    });
    const host = collectHostInfo(process.cwd());
    const report = buildSoakReport(run, {
      envId: environment.envId,
      engine,
      generatedAt: new Date().toISOString(),
      commit: { hash: host.git.commit, dirty: host.git.dirty },
      host,
      browser: { name: engine, version: browser.version(), userAgent: userAgent ?? null },
      stream: { id: stream, protocol: 'dash', contentHash: null },
      configuration: candidate
        ? { id: candidate.id, label: candidate.label, patch: candidate.patch }
        : { id: 'A', label: 'the library defaults (what ships)', patch: null },
      options: {
        minutes,
        warmupSec: LIVE_LIMITS.warmupSec,
        sampleSec: DEFAULT_SAMPLE_SEC,
        heapEverySec: DEFAULT_HEAP_EVERY_SEC,
        stallAtMinutes: injections.stallAtMinutes,
        staleAtMinutes: injections.staleAtMinutes,
      },
    });
    await keep(testInfo, 'PB-RDY-005.json', report);
    await testInfo.attach('PB-RDY-005-summary.txt', {
      body: renderSoakReport(report),
      contentType: 'text/plain',
    });
    const problems = report.evaluations
      .filter(
        (evaluation) =>
          evaluation.scope === 'criterion' && evaluation.verdict !== 'GO' && evaluation.verdict !== 'N/A',
      )
      .map((evaluation) => `${evaluation.verdict} ${evaluation.label}: ${evaluation.sentence}`);
    expect(
      problems,
      `PB-RDY-005 soak of ${minutes} min in ${engine} (the series and the verdict lines are attached as PB-RDY-005.json and PB-RDY-005-summary.txt)`,
    ).toEqual([]);
  },
);
