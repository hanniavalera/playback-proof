// `npm run perf -- [options]`           measure the scenarios of the profiles and print their statistics
// `npm run perf:baseline -- [options]`  the same, then record the baseline of each profile: perf/baselines/<envId>/<profile>.json
//
// Run it alone on a quiet machine: it measures, and everything else on the machine is noise (the report prints the load average of every
// batch, and warns when it was high). `npm run perf -- --help` lists the options.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERF_USAGE, PerfUsageError, parsePerfArgs } from '../src/lab/measure/args.ts';
import type { PerfOptions } from '../src/lab/measure/args.ts';
import { BaselineError, buildBaseline, writeBaseline } from '../src/lab/measure/baseline.ts';
import { gatingStatus } from '../src/lab/measure/decide.ts';
import { loadAround, machineFacts } from '../src/lab/measure/machine.ts';
import { busyWarning, renderBatchSummary } from '../src/lab/measure/report.ts';
import { HarnessError } from '../src/lab/measure/runner.ts';
import { scenariosFor } from '../src/lab/measure/scenarios.ts';
import type { Scenario } from '../src/lab/measure/scenarios.ts';
import type { BatchMeasurement, PerfProfile } from '../src/lab/measure/types.ts';
import { cpuThrottleOf } from '../src/lab/measure/types.ts';
import { DEFAULT_BASELINE_DIR, DEFAULT_REPORTS_DIR, log, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

interface Measured {
  scenario: Scenario;
  batch: BatchMeasurement;
}

/** What `--write-baseline` and a plain measurement both leave next to the reports: every batch, with every run. */
function writeRunReport(
  dir: string,
  harness: Harness,
  profile: PerfProfile,
  options: PerfOptions,
  measured: Measured[],
): string {
  const path = join(dir, harness.envId, `${profile}.run.json`);
  mkdirSync(join(dir, harness.envId), { recursive: true });
  const report = {
    schemaVersion: 1,
    kind: 'perf-run',
    envId: harness.envId,
    profile,
    generatedAt: new Date().toISOString(),
    options: {
      runs: options.runs,
      warmupRuns: options.warmupRuns,
      scenarios: options.scenarios,
      injectedFaults: options.injectFaults,
      injectedCpuThrottle: options.injectCpuThrottle,
      injectOn: options.injectOn,
    },
    host: harness.host,
    machine: machineFacts(process.env, loadAround(measured.map((m) => m.batch))),
    browser: harness.browsers.get(profile) ?? null,
    ffmpeg: harness.ffmpeg,
    streams: Object.fromEntries(
      [...new Set(measured.map((m) => m.batch.stream))].map((s) => [s, harness.streamHashes[s] ?? null]),
    ),
    batches: measured.map((m) => m.batch),
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

async function measureProfile(
  harness: Harness,
  profile: PerfProfile,
  scenarios: Scenario[],
): Promise<Measured[] | null> {
  const measured: Measured[] = [];
  for (const scenario of scenarios) {
    try {
      const batch = await harness.measure(profile, scenario);
      measured.push({ scenario, batch });
      console.log(`${renderBatchSummary(scenario, batch)}\n`);
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      console.error(`PROBLEM: ${error.message}`);
      return null;
    }
  }
  return measured;
}

function recordBaseline(
  harness: Harness,
  profile: PerfProfile,
  options: PerfOptions,
  measured: Measured[],
  dir: string,
): boolean {
  try {
    const streams = Object.fromEntries(
      [...new Set(measured.map((m) => m.batch.stream))].map((stream) => [
        stream,
        harness.streamHashes[stream] as string,
      ]),
    );
    const browser = harness.browsers.get(profile);
    if (!browser) throw new Error(`no browser was launched for ${profile}`);
    const baseline = buildBaseline({
      envId: harness.envId,
      profile,
      generatedAt: new Date().toISOString(),
      host: harness.host,
      machine: machineFacts(process.env, loadAround(measured.map((m) => m.batch))),
      browser: { ...browser, cpuThrottleRate: cpuThrottleOf(profile) },
      ffmpeg: harness.ffmpeg,
      streams,
      warmupRuns: options.warmupRuns,
      scenarios: measured.map(({ scenario, batch }) => ({ spec: scenario, batch })),
    });
    const path = writeBaseline(dir, baseline);
    log(`wrote ${path}`);
    for (const status of gatingStatus(
      measured.map((m) => m.scenario),
      baseline,
    )) {
      log(
        `  ${status.scenario} ${status.metric}: ${status.gates ? 'gates' : `tracked, not gated (${status.reason})`}`,
      );
    }
    return true;
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    console.error(`PROBLEM: ${error.message}`);
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  let options: PerfOptions;
  try {
    options = parsePerfArgs('run', argv);
  } catch (error) {
    if (error instanceof PerfUsageError) {
      console.error(`${error.message}\n\n${PERF_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(PERF_USAGE);
    return 0;
  }

  const plan = options.profiles
    .map((profile) => ({ profile, scenarios: scenariosFor(profile, options.scenarios) }))
    .filter(({ profile, scenarios }) => {
      if (scenarios.length === 0)
        log(`nothing to run on ${profile}${options.scenarios ? ` for ${options.scenarios.join(', ')}` : ''}`);
      return scenarios.length > 0;
    });
  if (plan.length === 0) {
    console.error('no scenario to run for the profiles and scenarios asked for');
    return 2;
  }

  let harness: Harness;
  try {
    harness = await startHarness(options);
  } catch (error) {
    console.error(`PROBLEM: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let exitCode = 0;
  try {
    for (const { profile, scenarios } of plan) {
      const measured = await measureProfile(harness, profile, scenarios);
      if (measured === null) {
        exitCode = 2;
        continue;
      }
      const busy = busyWarning(
        measured.map((m) => m.batch),
        harness.host.cpus,
      );
      if (busy) log(`warning: ${busy}`);
      log(
        `wrote ${writeRunReport(options.reportsDir ?? DEFAULT_REPORTS_DIR, harness, profile, options, measured)}`,
      );
      if (
        options.writeBaseline &&
        !recordBaseline(harness, profile, options, measured, options.baselineDir ?? DEFAULT_BASELINE_DIR)
      ) {
        exitCode = 2;
      }
    }
  } finally {
    await harness.stop();
  }
  return exitCode;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 2;
  },
);
