import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import type { Baseline } from '../../../src/lab/measure/baseline.ts';
import { buildBaseline } from '../../../src/lab/measure/baseline.ts';
import type { BatchMeasurement, RunRecord, ScenarioSpec } from '../../../src/lab/measure/types.ts';

// Synthetic scenarios, runs and batches for the unit tests of the harness: no browser, no service, numbers chosen so that the arithmetic
// of a threshold can be done by hand.

export const STARTUP: ScenarioSpec = {
  id: 'PB-PERF-001',
  name: 'startup',
  title: 'Startup',
  profiles: ['chromium'],
  faultProfile: 'clean',
  protocol: 'dash',
  pinnedHeight: null,
  startRungMatters: true,
  metrics: [
    { id: 'startupMs', label: 'Startup', unit: 'ms', rule: 'startup' },
    { id: 'manifestMs', label: 'Manifest time', unit: 'ms', rule: null },
  ],
};

export const REBUFFERING: ScenarioSpec = {
  id: 'PB-PERF-003',
  name: 'rebuffering',
  title: 'Rebuffering',
  profiles: ['chromium'],
  faultProfile: 'bandwidth-drop',
  protocol: 'dash',
  pinnedHeight: null,
  startRungMatters: true,
  metrics: [
    { id: 'rebufferCount', label: 'Rebuffers', unit: 'count', rule: 'rebufferCount' },
    { id: 'rebufferMs', label: 'Rebuffer time', unit: 'ms', rule: 'rebufferMs' },
    { id: 'rebufferRatio', label: 'Rebuffer ratio', unit: 'ratio', rule: 'rebufferRatio' },
  ],
};

export const FRAME_RATE: ScenarioSpec = {
  id: 'PB-PERF-002',
  name: 'frame-rate',
  title: 'Frame rate',
  profiles: ['chromium'],
  faultProfile: 'clean',
  protocol: 'dash',
  pinnedHeight: 720,
  startRungMatters: false,
  metrics: [
    { id: 'fps', label: 'Effective fps', unit: 'fps', rule: 'fps' },
    { id: 'droppedRatio', label: 'Dropped ratio', unit: 'ratio', rule: 'frameDropped' },
  ],
};

export function run(values: Record<string, number | null>, startRungHeight: number | null = 720): RunRecord {
  return {
    values,
    startRungHeight,
    rungs:
      startRungHeight === null
        ? []
        : [{ t: 100, from: null, to: 3, height: startRungHeight, reason: 'start' }],
    durationMs: 5000,
    errors: [],
  };
}

/** A batch of the startup scenario with one run per value: manifest time is a tenth of the startup. */
export function startupBatch(
  startups: readonly number[],
  startRungHeight: number | null = 720,
): BatchMeasurement {
  return {
    scenarioId: STARTUP.id,
    profile: 'chromium',
    stream: 'vod-cmaf',
    protocol: 'dash',
    faultProfile: 'clean',
    pinnedHeight: null,
    warmup: run({ startupMs: 999, manifestMs: 99 }, startRungHeight),
    runs: startups.map((startupMs) => run({ startupMs, manifestMs: startupMs / 10 }, startRungHeight)),
    loadAverage: { before: 1.5, after: 1.7 },
    startedAt: '2026-11-04T09:00:00.000Z',
    finishedAt: '2026-11-04T09:01:00.000Z',
  };
}

export function rebufferBatch(counts: readonly number[]): BatchMeasurement {
  return {
    scenarioId: REBUFFERING.id,
    profile: 'chromium',
    stream: 'vod-cmaf',
    protocol: 'dash',
    faultProfile: 'bandwidth-drop',
    pinnedHeight: null,
    warmup: null,
    runs: counts.map((count) =>
      run({ rebufferCount: count, rebufferMs: count * 400, rebufferRatio: (count * 400) / 20_000 }),
    ),
    loadAverage: { before: 1, after: 1 },
    startedAt: '2026-11-04T09:02:00.000Z',
    finishedAt: '2026-11-04T09:04:00.000Z',
  };
}

export function frameBatch(fps: readonly number[], droppedRatio: readonly number[] = []): BatchMeasurement {
  return {
    scenarioId: FRAME_RATE.id,
    profile: 'chromium',
    stream: 'vod-cmaf',
    protocol: 'dash',
    faultProfile: 'clean',
    pinnedHeight: 720,
    warmup: null,
    runs: fps.map((value, index) => run({ fps: value, droppedRatio: droppedRatio[index] ?? 0 })),
    loadAverage: { before: 1, after: 1 },
    startedAt: '2026-11-04T09:05:00.000Z',
    finishedAt: '2026-11-04T09:06:00.000Z',
  };
}

export const HOST: HostInfo = {
  os: { platform: 'darwin', arch: 'arm64', release: '25.0.0', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 36,
  node: 'v22.11.0',
  playwright: '1.64.1',
  git: { commit: 'abc1234', dirty: false },
};

export const HASH = 'a'.repeat(64);

export function baselineOf(
  scenarios: ReadonlyArray<{ spec: ScenarioSpec; batch: BatchMeasurement }>,
  overrides: Partial<Pick<Baseline, 'envId' | 'profile' | 'machine'>> = {},
): Baseline {
  return buildBaseline({
    envId: overrides.envId ?? 'local-darwin-arm64',
    profile: overrides.profile ?? 'chromium',
    generatedAt: '2026-11-04T09:10:00.000Z',
    host: HOST,
    ...(overrides.machine ? { machine: overrides.machine } : {}),
    browser: { name: 'chromium', version: '156.0.0.0', userAgent: 'UA', cpuThrottleRate: null },
    ffmpeg: '9.0',
    streams: { 'vod-cmaf': HASH },
    warmupRuns: 1,
    scenarios,
  });
}
