import { describe, expect, it } from 'vitest';
import { candidateById } from '../../../src/lab/readiness/candidates.ts';
import { playwrightWorld } from '../../../src/lab/readiness/playwright-world.ts';
import { parseSoakReport, limitsSnapshot } from '../../../src/lab/readiness/report.ts';
import { buildSoakReport, runSoak } from '../../../src/lab/readiness/soak.ts';
import { playwrightSoakDriver } from '../../../src/lab/readiness/soak-driver.ts';
import type { Engine } from '../../../src/lab/readiness/soak-evaluators.ts';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import { fakePlaywright } from './fake-playwright.ts';
import type { FakePlaywright } from './fake-playwright.ts';
import type { Script } from './fake-world.ts';
import { AST_EPOCH } from './fake-world.ts';

// The soak's driver, which no unit test could run before because it needs a page: here it runs for real over the fake of the part of
// Playwright it uses (fake-playwright.ts), on a virtual clock that also runs the page's timers, so that a five-minute soak is milliseconds.
// What these tests pin is the wiring that Phase B would otherwise find by failing: the order of the calls (the outages are rules of the
// session before the page exists, the candidate is applied before the first frame), what crosses the page boundary, the order of the
// DevTools calls, what is closed and deleted, and that what the driver records is on one axis and builds a result file that reads back.

const host = {
  os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 16,
  node: 'v22',
  playwright: '1.64.1',
  git: { commit: 'abc1234', dirty: false },
} as HostInfo;

interface Setup {
  minutes?: number;
  engine?: Engine;
  stallAt?: number | null;
  staleAt?: number | null;
  patch?: Record<string, unknown> | null;
  script?: Script;
  retainedMb?: (sinceMs: number) => number;
  /** Called after every sleep of the harness, on the virtual clock: where a test makes something happen to the page. */
  afterSleep?: (fp: FakePlaywright) => void;
}

function soakOf(setup: Setup = {}) {
  const minutes = setup.minutes ?? 5;
  const engine = setup.engine ?? 'chromium';
  const fp: FakePlaywright = fakePlaywright(setup.script ?? {}, {
    engine,
    ...(setup.retainedMb ? { retainedMb: setup.retainedMb } : {}),
  });
  const world = playwrightWorld({
    engine,
    stream: 'live-cmaf',
    protocol: 'dash',
    service: fp.service,
    browser: fp.browser,
    now: fp.harness.now,
  });
  const driver = playwrightSoakDriver(world, {
    minutes,
    stallAtMinutes: setup.stallAt === undefined ? minutes / 2 : setup.stallAt,
    staleAtMinutes: setup.staleAt ?? null,
    patch: (setup.patch ?? null) as never,
    servicePid: null,
    clock: {
      now: fp.harness.now,
      sleep: async (ms) => {
        await fp.harness.sleep(ms);
        setup.afterSleep?.(fp);
      },
    },
  });
  const run = () =>
    runSoak(driver, { engine, minutes, warmupSec: 60, sampleSec: 5, heapEverySec: 30, drainSec: 30 });
  return { fp, driver, run };
}

describe("the soak through the command line's driver", () => {
  it("runs a CI soak: the sampler in the page, the DevTools heap, the origin's log, and the verdict of the evaluators", async () => {
    const { fp, run } = soakOf();
    const result = await run();
    expect(result.evaluation.kind).toBe('ci');
    expect(result.evaluation.verdict).toBe('GO');
    expect(result.crashed).toBeNull();
    expect(result.lostSamples).toBe(0);
    expect(result.samplerProblems).toEqual([]);
    // One read at the start of the sampler and one every 5 s for 300 s.
    expect(result.input.samples.length).toBeGreaterThanOrEqual(60);
    expect(result.input.samples.length).toBeLessThanOrEqual(63);
    const times = result.input.samples.map((sample) => sample.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThanOrEqual(result.input.firstFrameMs);
    expect(Math.max(...times)).toBeLessThanOrEqual(result.input.endMs);
    expect(new Set(result.input.samples.map((sample) => sample.latencyMs))).toEqual(new Set([6200]));
    // The harness's clock is the one the page's timers run on: 300 s of soak took 300 s of the virtual clock, and not a millisecond more than the grace.
    expect(result.wallMs).toBeGreaterThanOrEqual(300_000);
    expect(result.wallMs).toBeLessThan(310_000);
    expect(fp.timers.running).toBe(0);
  });

  it('orders the DevTools calls as the protocol needs: the domain on once, and every reading a collection and then the metrics', async () => {
    const { fp, run } = soakOf();
    const result = await run();
    const calls = fp.env.cdp[0]?.calls ?? [];
    expect(calls[0]).toBe('Performance.enable');
    expect(calls.filter((call) => call === 'Performance.enable')).toHaveLength(1);
    const rest = calls.slice(1);
    expect(rest).toHaveLength(2 * result.heap.length);
    rest.forEach((call, i) =>
      expect(call, `call ${i + 1}`).toBe(
        i % 2 === 0 ? 'HeapProfiler.collectGarbage' : 'Performance.getMetrics',
      ),
    );
    // A reading without the collection first would include the garbage made since the last one (0.2 MB a second here).
    expect(new Set(result.heap.map((reading) => reading.usedMb))).toEqual(new Set([12]));
    expect(result.heap.length).toBeGreaterThanOrEqual(10);
    expect(result.heap[0]?.nodes).toBeGreaterThan(800);
    expect(result.harness).toHaveLength(result.heap.length);
  });

  it('reads a leak after collection: what the page retains, not what it has yet to throw away', async () => {
    const { run } = soakOf({ retainedMb: (sinceMs) => 12 + (sinceMs / 60_000) * 10 });
    const result = await run();
    const growth = result.evaluation.evaluations.find((e) => e.id === 'soak.heap-growth');
    // 10 MB a minute, and the medians of the first and of the last three readings after the warm-up are three minutes apart: 30 MB against 20.
    expect(growth?.verdict).toBe('NO-GO');
    expect(growth?.value).toBeCloseTo(30, 0);
    expect(result.evaluation.verdict).toBe('NO-GO');
  });

  it('puts the outage in the session before the page exists, at the segment the arithmetic names, and records its window on the epoch axis', async () => {
    const { fp, run } = soakOf({ stallAt: 2.5 });
    const result = await run();
    const calls = fp.service.calls;
    expect(calls.indexOf('createSession')).toBeLessThan(
      calls.findIndex((call) => call.startsWith('addFaults')),
    );
    expect(calls.findIndex((call) => call.startsWith('addFaults'))).toBeLessThan(calls.indexOf('goto'));
    const rule = fp.observed.runs[0]?.faults[0];
    expect(rule).toMatchObject({ type: 'live-stall', ms: LIVE_LIMITS.injectedStallMs });
    const [window] = result.start.faults;
    expect(window).toMatchObject({ kind: 'origin-stall' });
    const detail = await fp.service.detail(fp.service.deleted[0] ?? 'session-0');
    const atNumber = rule && rule.type === 'live-stall' ? rule.atNumber : -1;
    // The contract (docs/CONTRACTS.md section 5): the origin stops when segment atNumber is published, AST + atNumber * d.
    expect(window?.startMs).toBe(Date.parse(detail.live?.availabilityStartTime ?? '') + atNumber * 2000);
    expect((window?.endMs ?? 0) - (window?.startMs ?? 0)).toBe(LIVE_LIMITS.injectedStallMs);
    const minute = ((window?.startMs ?? 0) - result.input.firstFrameMs) / 60_000;
    expect(minute).toBeGreaterThan(2.3);
    expect(minute).toBeLessThan(2.6);
  });

  it('applies the candidate configuration to an idle page BEFORE it loads and plays, and the evidence says it was applied', async () => {
    const candidate = candidateById('live-sync');
    const { fp, run } = soakOf({ patch: candidate?.patch as Record<string, unknown> });
    const result = await run();
    const calls = fp.service.calls;
    // The page is opened without a manifest (Shaka reads liveSync in load()), configured, and only then told to load and play.
    expect(calls.indexOf('goto')).toBeLessThan(calls.indexOf('qa.configure'));
    expect(calls.indexOf('qa.configure')).toBeLessThan(calls.indexOf('qa.load'));
    expect(calls.indexOf('qa.load')).toBeLessThan(calls.indexOf('qa.play'));
    expect(fp.env.pages[0]?.gotoUrls).toEqual([`${fp.service.origin}/player/`]);
    expect(fp.observed.runs[0]?.calls).toEqual(['openIdle', 'configure', 'load', 'play']);
    expect(fp.observed.runs[0]?.liveSyncAtLoad).toBe(true);
    expect(fp.observed.runs[0]?.configured).toEqual([candidate?.patch]);
    expect(result.start.player?.configured).toEqual([candidate?.patch]);
  });

  it('opens the page for the defaults with the manifest, as a viewer does, and configures nothing', async () => {
    const { fp, run } = soakOf({});
    await run();
    expect(fp.observed.runs[0]?.calls).toEqual(['open']);
    expect(fp.env.pages[0]?.gotoUrls[0]).toContain('/player/?manifest=');
    expect(fp.service.calls).not.toContain('qa.configure');
  });

  it('creates the session for the length of the soak and a quarter of an hour, and says what it is for', async () => {
    const { fp, run } = soakOf({ minutes: 5 });
    await run();
    expect(fp.observed.runs[0]?.request).toMatchObject({
      ttlSec: 5 * 60 + 900,
      label: 'PB-RDY-005 soak 5 min',
    });
  });

  it("places a stale manifest from the first media request in the origin's log, and installs it as a rule of the session", async () => {
    const { fp, run } = soakOf({ staleAt: 1.5, script: { mediaRequests: true } });
    const result = await run();
    const stale = result.start.faults.find((fault) => fault.kind === 'stale-manifest');
    const log = await fp.service.log(fp.service.deleted[0] ?? 'session-0');
    const firstMedia = log.find((entry) => entry.kind === 'init' || entry.kind === 'segment');
    expect(stale?.startMs).toBe(Date.parse(firstMedia?.t ?? '') + 90_000);
    expect((stale?.endMs ?? 0) - (stale?.startMs ?? 0)).toBe(LIVE_LIMITS.injectedStallMs);
    expect(fp.observed.runs[0]?.faults.map((rule) => rule.type)).toEqual(['live-stall', 'manifest-stale']);
    expect(result.start.faults.map((fault) => fault.kind)).toEqual(['origin-stall', 'stale-manifest']);
  });

  it("says so, and does not guess, when there was no media request to start the stale manifest's clock from", async () => {
    const { run } = soakOf({ staleAt: 1.5 });
    await expect(run()).rejects.toThrow('made no media request');
  });

  it("digests the origin's log in slices as it goes: nothing counted twice, nothing missed", async () => {
    const { run } = soakOf({ script: { mediaRequests: true } });
    const result = await run();
    const total = result.requests.total;
    // About 150 refreshes in 300 s, and an init segment and 150 media segments.
    expect(result.input.manifestArrivalsMs.length).toBeGreaterThanOrEqual(148);
    expect(result.input.manifestArrivalsMs.length).toBeLessThanOrEqual(155);
    expect(result.requests.byKind.manifest).toBe(result.input.manifestArrivalsMs.length);
    expect(result.requests.byKind.segment).toBeGreaterThanOrEqual(148);
    expect(total).toBe(
      (result.requests.byKind.manifest ?? 0) +
        (result.requests.byKind.init ?? 0) +
        (result.requests.byKind.segment ?? 0),
    );
  });

  it('asks for no DevTools session outside Chromium, reads no heap, and says the criterion does not apply', async () => {
    const { fp, run } = soakOf({ engine: 'firefox' });
    const result = await run();
    expect(fp.env.cdp).toHaveLength(0);
    expect(result.heap).toEqual([]);
    expect(result.input.heap).toBeNull();
    expect(result.evaluation.evaluations.find((e) => e.id === 'soak.heap-growth')?.verdict).toBe('N/A');
    expect(result.evaluation.verdict).toBe('GO');
    expect(result.harness.length).toBeGreaterThan(5);
  });

  it('ends at once, as a critical error, when the page crashes, and still releases everything it made', async () => {
    let crashed = false;
    const { fp, run } = soakOf({
      afterSleep: (fp) => {
        // Two minutes and a bit into the soak: the clock of the fake world starts a minute after its stream's availability start.
        if (!crashed && fp.clock.now > AST_EPOCH + 60_000 + 130_000) {
          crashed = true;
          fp.env.pages[0]?.crash();
        }
      },
    });
    const result = await run();
    expect(result.crashed).toBe('the page crashed');
    expect(result.input.errors.map((error) => error.codeName)).toContain('PAGE_GONE');
    expect(result.evaluation.verdict).toBe('NO-GO');
    expect(result.evaluation.evaluations.find((e) => e.id === 'soak.critical-errors')?.verdict).toBe('NO-GO');
    expect(fp.env.contexts.every((context) => context.closed)).toBe(true);
    expect(fp.service.deleted).toHaveLength(1);
  });

  it('stops the sampler, detaches the DevTools session, closes the context and deletes the session when the soak is over', async () => {
    const { fp, run } = soakOf();
    await run();
    expect(fp.timers.running).toBe(0);
    expect(fp.env.cdp[0]?.detached).toBe(true);
    expect(fp.env.contexts[0]?.closed).toBe(true);
    expect(fp.env.pages[0]?.isClosed()).toBe(true);
    expect(fp.service.deleted).toHaveLength(1);
  });

  it('builds a result file from what the driver recorded, and the strict reader takes it back', async () => {
    const { fp, run } = soakOf({ script: { mediaRequests: true } });
    const result = await run();
    const report = buildSoakReport(result, {
      envId: 'test-env',
      engine: 'chromium',
      generatedAt: '2030-01-01T01:00:00.000Z',
      commit: { hash: 'abc1234', dirty: false },
      host,
      browser: { name: 'chromium', version: fp.browser.version, userAgent: 'FakeBrowser/1' },
      stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
      configuration: { id: 'A', label: 'the library defaults', patch: null },
      options: {
        minutes: 5,
        warmupSec: 60,
        sampleSec: 5,
        heapEverySec: 30,
        stallAtMinutes: 2.5,
        staleAtMinutes: null,
      },
    });
    const back = parseSoakReport(JSON.stringify(report), 'soak.json');
    expect(back.verdict).toBe('GO');
    expect(back.length).toBe('ci');
    expect(back.faults).toHaveLength(1);
    expect(back.series.heap?.length).toBe(result.heap.length);
    expect(back.limits).toEqual(limitsSnapshot());
  });
});
