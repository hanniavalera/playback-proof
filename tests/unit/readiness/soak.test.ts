import { describe, expect, it } from 'vitest';
import { LIVE_LIMITS } from '../../../src/shared/criteria.ts';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import { limitsSnapshot, parseSoakReport } from '../../../src/lab/readiness/report.ts';
import { MAX_SERIES_POINTS, buildSoakReport, runSoak } from '../../../src/lab/readiness/soak.ts';
import type { SoakRunOptions } from '../../../src/lab/readiness/soak.ts';
import type { Evaluation } from '../../../src/lab/readiness/verdict.ts';
import { episode, error, fault, heapSeries, soak, T0 } from './soak-fixtures.ts';
import { VirtualDriver } from './virtual-driver.ts';

// The soak harness's loop, on a virtual clock: when it reads what, how it ends, and what it makes of a page that hangs or disappears.

const get = (evaluations: readonly Evaluation[], id: string): Evaluation => {
  const found = evaluations.find((evaluation) => evaluation.id === id);
  if (!found) throw new Error(`no evaluation ${id}`);
  return found;
};

const options = (overrides: Partial<SoakRunOptions> = {}): SoakRunOptions => ({
  engine: 'chromium',
  minutes: 5,
  warmupSec: 60,
  sampleSec: 5,
  heapEverySec: 30,
  drainSec: 30,
  ...overrides,
});

describe('the soak loop', () => {
  it('watches a healthy session for its whole length and judges it GO, reading the memory on its cadence and once at the warm-up', async () => {
    const driver = new VirtualDriver({ recorded: soak({ minutes: 5 }) });
    const lines: string[] = [];
    const run = await runSoak(driver, options({ log: (line) => lines.push(line) }));
    expect(run.evaluation.verdict).toBe('GO');
    expect(run.evaluation.kind).toBe('ci');
    expect(run.crashed).toBeNull();
    // 61 reads: one every 5 s from the first frame to the 300th second.
    expect(run.input.samples).toHaveLength(61);
    // Heap and harness memory: at the start, every 30 s, the warm-up (60 s) coincides with one of them, and once at the end: 11 readings.
    expect(driver.calls.heapReadings.map((at) => (at - T0) / 1000)).toEqual([
      0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300,
    ]);
    expect(driver.calls.harnessReadings).toEqual(driver.calls.heapReadings);
    expect(run.heap).toHaveLength(11);
    expect(run.harness).toHaveLength(11);
    // The harness collects what the page sampled every 30 s: ten drains and the last at the end.
    expect(driver.calls.drains).toBeGreaterThanOrEqual(10);
    expect(driver.calls.drains).toBeLessThanOrEqual(12);
    expect(driver.stopped).toBe(true);
    expect(lines.some((line) => line.startsWith('soak: 5 min on chromium'))).toBe(true);
    expect(lines.at(-1)).toBe('soak: GO (ci)');
  });

  it('reads the heap once at the end of a warm-up that does not fall on the cadence', async () => {
    const driver = new VirtualDriver({ recorded: soak({ minutes: 5, warmupSec: 45 }) });
    await runSoak(driver, options({ warmupSec: 45 }));
    const times = driver.calls.heapReadings.map((at) => (at - T0) / 1000);
    expect(times).toContain(45);
    expect(times.filter((t) => t === 45)).toHaveLength(1);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('passes the injected outage and its recovery: the stall is one the soak expects, and the soak is GO', async () => {
    const recorded = soak({
      minutes: 8,
      faults: [fault(240, 10)],
      episodes: [episode(246, 4)],
      latency: (sec) => (sec < 250 ? 6200 : 10_100),
    });
    const run = await runSoak(new VirtualDriver({ recorded }), options({ minutes: 8 }));
    expect(run.start.faults).toHaveLength(1);
    expect(run.evaluation.verdict).toBe('GO');
    expect(get(run.evaluation.evaluations, 'soak.stalls').detail?.episodes).toBe(1);
    // The player stayed 4 s further behind for good, which the soak reports as evidence and PB-RDY-003 judges; it is not a drift.
    expect(get(run.evaluation.evaluations, 'soak.latency-max').verdict).toBe('NO-GO');
    expect(get(run.evaluation.evaluations, 'soak.latency-drift').verdict).toBe('GO');
  });

  it('is NO-GO for a heap that climbs, and the series is in the file for a reader to see it climb', async () => {
    const recorded = soak({ minutes: 5 });
    const driver = new VirtualDriver({ recorded, heapMb: (sec) => 14 + Math.max(0, sec - 60) * 0.2 });
    const run = await runSoak(driver, options());
    expect(run.evaluation.verdict).toBe('NO-GO');
    expect(get(run.evaluation.evaluations, 'soak.heap-growth').verdict).toBe('NO-GO');
    expect(run.heap.at(-1)?.usedMb).toBeCloseTo(14 + 240 * 0.2, 6);
  });

  it('leaves the heap alone where the engine cannot read it, and says the criterion does not apply', async () => {
    const driver = new VirtualDriver({ recorded: soak({ minutes: 5, engine: 'webkit' }) });
    const run = await runSoak(driver, options({ engine: 'webkit' }));
    expect(driver.calls.heapReadings).toEqual([]);
    expect(driver.calls.harnessReadings.length).toBe(11);
    expect(run.input.heap).toBeNull();
    expect(get(run.evaluation.evaluations, 'soak.heap-growth').verdict).toBe('N/A');
    expect(run.evaluation.verdict).toBe('GO');
  });

  it('carries on when one heap reading fails, and the evaluators know there are fewer readings', async () => {
    const driver = new VirtualDriver({ recorded: soak({ minutes: 5 }), failHeapReading: 4 });
    const run = await runSoak(driver, options());
    expect(run.heap).toHaveLength(10);
    expect(run.samplerProblems.join(' ')).toContain('a memory reading failed');
    expect(run.evaluation.verdict).toBe('GO');
  });

  it('gives a player that is stalled at the end the recovery limit to get going, and counts a stall that does not as unrecovered', async () => {
    // The player is stalled from second 290 for good: the hook reports the episode as ongoing, and the reads say buffering from then on.
    const recorded = soak({ minutes: 5.5, episodes: [episode(290, 40, true)] });
    const driver = new VirtualDriver({ recorded });
    const run = await runSoak(driver, options());
    const waitedMs = run.input.endMs - (T0 + 300_000);
    expect(waitedMs).toBeGreaterThanOrEqual(LIVE_LIMITS.stallRecoveryMaxMs);
    expect(waitedMs).toBeLessThan(LIVE_LIMITS.stallRecoveryMaxMs + 2000);
    expect(get(run.evaluation.evaluations, 'soak.stalls').verdict).toBe('NO-GO');
    expect(run.evaluation.verdict).toBe('NO-GO');
  });

  it('ends a soak whose page has gone as NO-GO, with the reason, and a verdict that is not a CI soak', async () => {
    const driver = new VirtualDriver({ recorded: soak({ minutes: 5 }), crashAtSec: 130 });
    const run = await runSoak(driver, options());
    expect(run.crashed).toContain('the page crashed');
    expect(run.input.errors.at(-1)).toMatchObject({ severity: 2, codeName: 'PAGE_GONE', source: 'harness' });
    expect(run.evaluation.verdict).toBe('NO-GO');
    expect(run.evaluation.kind).toBe('short');
    expect(get(run.evaluation.evaluations, 'soak.critical-errors').verdict).toBe('NO-GO');
    expect(run.input.endMs - T0).toBeLessThan(200_000);
    expect(driver.stopped).toBe(true);
  });

  it('judges a 60-second harness check as a short run, not as a verdict', async () => {
    const run = await runSoak(
      new VirtualDriver({ recorded: soak({ minutes: 1, warmupSec: 15 }) }),
      options({ minutes: 1, warmupSec: 15 }),
    );
    expect(run.evaluation.kind).toBe('short');
    expect(run.evaluation.verdict).toBe('INCONCLUSIVE');
    expect(get(run.evaluation.evaluations, 'soak.length').verdict).toBe('INCONCLUSIVE');
  });
});

describe('the result file of a soak', () => {
  const host = {
    os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS 27.2' },
    cpus: 12,
    memoryGiB: 16,
    node: 'v22',
    playwright: '1.64.1',
    git: { commit: 'abc1234', dirty: false },
  } as HostInfo;

  it('keeps the whole verdict, the series with its peaks, the memory of the harness, and reads back as written', async () => {
    const latency = (sec: number): number => (sec === 777 ? 31_000 : 6200 + (sec % 7));
    const recorded = soak({ minutes: 30, cadenceSec: 1, latency, heap: heapSeries(30, 30, () => 14) });
    const run = await runSoak(new VirtualDriver({ recorded }), options({ minutes: 30, sampleSec: 1 }));
    const report = buildSoakReport(run, {
      envId: 'local-darwin-arm64',
      engine: 'chromium',
      generatedAt: '2030-01-01T00:00:00.000Z',
      commit: { hash: 'abc1234', dirty: false },
      host,
      browser: { name: 'chromium', version: '156', userAgent: null },
      stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
      configuration: { id: 'A', label: 'the library defaults', patch: null },
      options: {
        minutes: 30,
        warmupSec: 60,
        sampleSec: 1,
        heapEverySec: 30,
        stallAtMinutes: null,
        staleAtMinutes: null,
      },
    });
    expect(report.length).toBe('release');
    expect(report.series.sampleCount).toBe(1801);
    expect(report.series.samples.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
    expect(Math.max(...report.series.samples.map((sample) => sample.latencyMs ?? 0))).toBe(31_000);
    expect(report.series.samples[0]?.atMs).toBe(T0);
    expect(report.series.heap).toHaveLength(61);
    expect(report.harness.firstHeapMb).toBeCloseTo(40, 6);
    expect(report.harness.lastHeapMb).toBeGreaterThan(report.harness.firstHeapMb ?? 0);
    expect(report.harness.firstServiceRssMb).toBe(150);
    expect(report.limits).toEqual(limitsSnapshot());
    const text = JSON.stringify(report);
    expect(text.length).toBeLessThan(400_000);
    const back = parseSoakReport(text, 'soak.json');
    expect(back.verdict).toBe(report.verdict);
    expect(back.evaluations).toEqual(report.evaluations);
  });

  it('records the errors, the stalls and the faults as they were, and the console problems it was told about', async () => {
    const recorded = soak({
      minutes: 5,
      errors: [error(100, 1)],
      episodes: [episode(150, 3)],
      faults: [fault(200, 10)],
    });
    const run = await runSoak(
      new VirtualDriver({ recorded, consoleProblems: ['error: Failed to load resource'] }),
      options(),
    );
    const report = buildSoakReport(run, {
      envId: 'x',
      engine: 'chromium',
      generatedAt: '2030-01-01T00:00:00.000Z',
      commit: { hash: null, dirty: null },
      host,
      browser: { name: 'chromium', version: '156', userAgent: null },
      stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
      configuration: { id: 'A', label: 'the library defaults', patch: null },
      options: {
        minutes: 5,
        warmupSec: 60,
        sampleSec: 5,
        heapEverySec: 30,
        stallAtMinutes: 3.3,
        staleAtMinutes: null,
      },
    });
    expect(report.errors).toHaveLength(1);
    expect(report.episodes).toHaveLength(1);
    expect(report.faults).toHaveLength(1);
    expect(report.consoleProblems).toEqual(['error: Failed to load resource']);
    // A recoverable error that no injected fault explains is shown with a verdict of its own and decides nothing; the soak is NO-GO here
    // for what the recording shows besides it (a stall of 3 s outside the faults is above the rebuffer-ratio limit).
    const unexplained = get(report.evaluations, 'soak.unexplained-recoverable-errors');
    expect(unexplained.verdict).toBe('NO-GO');
    expect(unexplained.scope).toBe('advisory');
    expect(get(report.evaluations, 'soak.rebuffer-ratio').verdict).toBe('NO-GO');
    expect(report.verdict).toBe('NO-GO');
  });
});
