// What the two commands of the performance harness share (perf/run.ts, perf/gate.ts): the checkout, the environment, the service that runs
// as a child process, the metadata of a measurement, and the closure that measures one batch. Everything with a decision in it is in
// src/lab/measure and unit-tested; this file is the plumbing that needs a real machine.

import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchProfile } from '../src/lab/measure/browser.ts';
import type { BaselineBrowser, PerfHost } from '../src/lab/measure/baseline.ts';
import { injectionFor } from '../src/lab/measure/args.ts';
import type { PerfOptions } from '../src/lab/measure/args.ts';
import { perfHost } from '../src/lab/measure/machine.ts';
import { runBatch } from '../src/lab/measure/runner.ts';
import type { Attempt } from '../src/lab/measure/gate.ts';
import type { BatchProgress } from '../src/lab/measure/runner.ts';
import type { Scenario } from '../src/lab/measure/scenarios.ts';
import { startService } from '../src/lab/measure/service.ts';
import type { RunningService } from '../src/lab/measure/service.ts';
import type { BatchMeasurement, PerfProfile, RunRecord } from '../src/lab/measure/types.ts';
import { cpuThrottleOf, engineOf } from '../src/lab/measure/types.ts';
import { currentEnvironment } from '../src/lab/gaps.ts';
import { collectHostInfo } from '../src/lab/probe/host-info.ts';
import { detectEnvId } from '../src/shared/env.ts';
import type { StreamId } from '../src/shared/streams.ts';
import { PLAYER_DIST, buildPlayer } from '../tools/build-player.ts';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_BASELINE_DIR = join(ROOT, 'perf', 'baselines');
export const DEFAULT_REPORTS_DIR = join(ROOT, 'reports', 'perf');

export interface Harness {
  envId: string;
  host: PerfHost;
  service: RunningService;
  /** The content hash of every stream the service has, by id. */
  streamHashes: Partial<Record<StreamId, string>>;
  ffmpeg: string;
  /** What was launched, by profile, once the profile has been measured. */
  browsers: Map<PerfProfile, BaselineBrowser>;
  /** One batch of `scenario` on `profile`: the warm-up and the measured runs, in one browser process. `attempt` tells an injection scoped to the first batch which one this is. */
  measure(profile: PerfProfile, scenario: Scenario, attempt?: Attempt): Promise<BatchMeasurement>;
  stop(): Promise<void>;
}

export const log = (line: string): void => {
  console.error(line);
};

/** One line per run: the numbers it produced, the rung it started on and how long it took. */
export function describeRun(record: RunRecord): string {
  const values = Object.entries(record.values)
    .map(([key, value]) => `${key}=${value === null ? 'n/a' : String(Number(value.toPrecision(4)))}`)
    .join(' ');
  const rung = record.startRungHeight === null ? '' : ` start ${record.startRungHeight}p`;
  const errors = record.errors.length > 0 ? ` errors: ${record.errors.join(', ')}` : '';
  return `${values}${rung}, ${(record.durationMs / 1000).toFixed(1)} s${errors}`;
}

export function progressLine(event: BatchProgress): string {
  if (event.kind === 'batch')
    return `[${event.scenario} ${event.profile}] stream ${event.stream}: ${event.warmupRuns} warm-up + ${event.runs} runs`;
  const label = event.warmup ? 'warm-up' : `run ${event.index + 1}/${event.total}`;
  return `[${event.scenario}]   ${label}: ${describeRun(event.record)}`;
}

/**
 * Starts the service as a child process (building the player page first when it is missing), reads what the service knows about its
 * streams, and returns the handle the commands measure through. Throws with a message that says what to do when it cannot.
 */
export async function startHarness(options: PerfOptions): Promise<Harness> {
  if (!existsSync(join(PLAYER_DIST, 'index.html'))) {
    log('dist/player is missing: building the player page');
    await buildPlayer();
  }
  const envId = detectEnvId();
  const host = perfHost(collectHostInfo(ROOT), cpus());
  const service = await startService({ root: ROOT, port: options.port });
  const onSignal = (): void => {
    void service.stop().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let streams;
  try {
    streams = await service.client.streams();
  } catch (error) {
    await service.stop();
    throw error;
  }
  const streamHashes: Partial<Record<StreamId, string>> = {};
  for (const stream of streams) streamHashes[stream.id] = stream.contentHash;

  const browsers = new Map<PerfProfile, BaselineBrowser>();
  const launch: typeof launchProfile = async (profile, launchOptions) => {
    const browser = await launchProfile(profile, launchOptions);
    if (!browsers.has(profile)) {
      browsers.set(profile, {
        name: browser.engine,
        version: browser.version,
        userAgent: await browser.userAgent().catch(() => null),
        // What the profile is, not what an injection made of it (the batch records an injection itself).
        cpuThrottleRate: cpuThrottleOf(profile),
      });
    }
    return browser;
  };

  return {
    envId,
    host,
    service,
    streamHashes,
    ffmpeg: service.health.ffmpeg,
    browsers,
    measure: (profile, scenario, attempt = 'first') =>
      runBatch({
        scenario,
        profile,
        runs: options.runs,
        warmupRuns: options.warmupRuns,
        environment: currentEnvironment(engineOf(profile)),
        service: { origin: service.origin, client: service.client },
        launch,
        runTimeoutMs: options.runTimeoutMs,
        ...injectionFor(options, attempt),
        onProgress: (event) => log(progressLine(event)),
      }),
    stop: async () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await service.stop();
    },
  };
}
