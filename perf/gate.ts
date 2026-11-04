// `npm run perf:gate -- [options]`
//
// Measures the scenarios of the profiles, compares them with the committed baseline of THIS environment, and fails the build only for a
// regression that reproduces: a metric that fails is measured again in a fresh browser with fresh runs, and counts only if it fails again.
//
//   exit 0   every metric is within its threshold (a failure that did not reproduce is reported and passes)
//   exit 1   a regression reproduced
//   exit 2   the measurement could not be trusted: no baseline here (the message has the command that records one), a stream that
//            changed since the baseline, a browser that did not start, a run that failed. An environment failure is not a regression.
//
// Writes reports/perf/<envId>/<profile>.json (every run) and .md, and appends the Markdown to $GITHUB_STEP_SUMMARY when it is set.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERF_USAGE, PerfUsageError, parsePerfArgs } from '../src/lab/measure/args.ts';
import type { PerfOptions } from '../src/lab/measure/args.ts';
import { BaselineError, baselinePath, loadBaseline } from '../src/lab/measure/baseline.ts';
import type { Baseline } from '../src/lab/measure/baseline.ts';
import { combineExitCodes, compareEnvironment } from '../src/lab/measure/decide.ts';
import type { ExitCode, Problem } from '../src/lab/measure/decide.ts';
import { runGate } from '../src/lab/measure/gate.ts';
import { loadAround, machineFacts } from '../src/lab/measure/machine.ts';
import {
  buildGateReport,
  busyWarning,
  renderGateMarkdown,
  renderGateText,
  serializeReport,
} from '../src/lab/measure/report.ts';
import type { GateReport } from '../src/lab/measure/report.ts';
import { scenariosFor } from '../src/lab/measure/scenarios.ts';
import type { BatchMeasurement, PerfProfile } from '../src/lab/measure/types.ts';
import { DEFAULT_BASELINE_DIR, DEFAULT_REPORTS_DIR, log, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

/** Writes the JSON and the Markdown of a profile's report; the Markdown also goes to the job summary of the CI system when there is one. */
function writeReports(dir: string, report: GateReport): string {
  mkdirSync(join(dir, report.envId), { recursive: true });
  const base = join(dir, report.envId, report.profile);
  const markdown = renderGateMarkdown(report);
  writeFileSync(`${base}.json`, serializeReport(report));
  writeFileSync(`${base}.md`, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return `${base}.json`;
}

/** One profile: the baseline, the environment check, the gate loop, the reports. Returns the exit code of the profile. */
async function gateProfile(harness: Harness, profile: PerfProfile, options: PerfOptions): Promise<ExitCode> {
  const specs = scenariosFor(profile, options.scenarios);
  const baselineDir = options.baselineDir ?? DEFAULT_BASELINE_DIR;
  const reportsDir = options.reportsDir ?? DEFAULT_REPORTS_DIR;
  const baselineFile = baselinePath(baselineDir, harness.envId, profile);
  const common = {
    envId: harness.envId,
    profile,
    generatedAt: new Date().toISOString(),
    host: harness.host,
    ffmpeg: harness.ffmpeg,
  };

  let baseline: Baseline | null = null;
  const setupProblems: Problem[] = [];
  try {
    baseline = loadBaseline({ dir: baselineDir, envId: harness.envId, profile });
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error;
    if (error.problem === 'missing' && options.allowMissingBaseline) {
      log(
        `warning: no baseline for ${profile} in ${harness.envId}: --allow-missing-baseline, so the numbers are reported and nothing is judged`,
      );
    } else {
      setupProblems.push({ scenario: '*', message: error.message });
    }
  }

  const warnings: string[] = [];
  if (baseline) {
    // The streams are checked before any browser starts: a changed stream makes every number incomparable, and there is no point in
    // measuring forty batches to say so.
    const environment = compareEnvironment(baseline, {
      streams: harness.streamHashes,
      ffmpeg: harness.ffmpeg,
      browserVersion: null,
      playwright: harness.host.playwright,
      cpus: harness.host.cpus,
    });
    setupProblems.push(...environment.problems);
    warnings.push(...environment.warnings);
  }
  const scope =
    options.injectOn === 'first'
      ? 'the FIRST batch of each scenario only (the fresh batch is clean)'
      : 'every session';
  if (options.injectFaults.length > 0) {
    warnings.push(
      `FAULTS WERE INJECTED ON PURPOSE into ${scope} (${JSON.stringify(options.injectFaults)}): this is a sensitivity check of the gate, not a measurement of the build`,
    );
  }
  if (options.injectCpuThrottle !== null) {
    warnings.push(
      `THE CPU THROTTLE WAS REPLACED ON PURPOSE by ${options.injectCpuThrottle}x in ${scope}: this is a sensitivity check of the gate, not a measurement of the build`,
    );
  }

  const withBaseline = baseline ? { file: baselineFile, baseline } : null;
  if (setupProblems.length > 0) {
    const report = buildGateReport({
      ...common,
      result: { scenarios: [], problems: [], exitCode: 2 },
      baseline: withBaseline,
      browser: null,
      warnings,
      setupProblems,
    });
    console.log(renderGateText(report, []));
    log(`wrote ${writeReports(reportsDir, report)}`);
    return report.exitCode;
  }

  const result = await runGate({
    specs,
    baseline,
    measure: (scenario, attempt) => {
      log(
        `${attempt === 'first' ? 'measuring' : 're-measuring with a fresh browser'} ${scenario.id} ${scenario.name} on ${profile}`,
      );
      return harness.measure(profile, scenario, attempt);
    },
    onScenario: ({ spec, outcome }) =>
      log(`${spec.id} ${spec.name}: ${outcome.status}${outcome.remeasured ? ' (after a fresh batch)' : ''}`),
  });

  const browser = harness.browsers.get(profile) ?? null;
  if (baseline && browser && baseline.browser.version !== browser.version) {
    warnings.push(
      `the browser is ${browser.version}; the baseline was recorded on ${baseline.browser.version}`,
    );
  }
  const batches = result.scenarios
    .flatMap((scenario) => [scenario.first?.batch, scenario.remeasure?.batch])
    .filter((batch): batch is BatchMeasurement => batch !== undefined);
  const busy = busyWarning(batches, harness.host.cpus);
  if (busy) warnings.push(busy);

  const machine = machineFacts(process.env, loadAround(batches));
  const report = buildGateReport({
    ...common,
    result,
    baseline: withBaseline,
    machine,
    browser,
    warnings,
  });
  console.log(renderGateText(report, result.scenarios));
  log(`wrote ${writeReports(reportsDir, report)}`);
  return report.exitCode;
}

async function main(argv: string[]): Promise<number> {
  let options: PerfOptions;
  try {
    options = parsePerfArgs('gate', argv);
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

  const profiles = options.profiles.filter((profile) => {
    const runs = scenariosFor(profile, options.scenarios).length > 0;
    if (!runs)
      log(`nothing to run on ${profile}${options.scenarios ? ` for ${options.scenarios.join(', ')}` : ''}`);
    return runs;
  });
  if (profiles.length === 0) {
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

  const codes: ExitCode[] = [];
  try {
    for (const profile of profiles) codes.push(await gateProfile(harness, profile, options));
  } finally {
    await harness.stop();
  }
  return combineExitCodes(codes);
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
