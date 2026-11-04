// `npm run soak -- --minutes N|ci|release --engine chromium|firefox|webkit [options]`
//
// A long live session, sampled by the page at its own cadence, with one injected origin outage (and, in a release soak, a stale manifest) at
// fixed points, the JS heap after a forced collection in Chromium, the harness's own memory, and the PB-RDY-005 evaluators at the end. It
// prints the summary and writes docs/results/soak/<env>-<engine>-<minutes>m.json (the series decimated, peaks kept).
//
// It needs the machine to itself for its whole length. A soak shorter than the CI length is reported and is not a verdict.
// `npm run soak -- --help` lists the options.

import { SOAK_USAGE, ReadinessUsageError, parseSoakArgs } from '../src/lab/readiness/args.ts';
import type { SoakOptions } from '../src/lab/readiness/args.ts';
import { renderSoakReport } from '../src/lab/readiness/checklist.ts';
import { playwrightWorld } from '../src/lab/readiness/playwright-world.ts';
import { soakDir, writeResult } from '../src/lab/readiness/readiness-run.ts';
import { soakFileName } from '../src/lab/readiness/report.ts';
import { buildSoakReport, runSoak } from '../src/lab/readiness/soak.ts';
import { playwrightSoakDriver } from '../src/lab/readiness/soak-driver.ts';
import {
  DEFAULT_RESULTS_ROOT,
  describeRun,
  launchProfile,
  log,
  machine,
  planEngine,
  startLabService,
} from './common.ts';

async function main(argv: string[]): Promise<number> {
  let options: SoakOptions;
  try {
    options = parseSoakArgs(argv);
  } catch (error) {
    if (error instanceof ReadinessUsageError) {
      console.error(`${error.message}\n\n${SOAK_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(SOAK_USAGE);
    return 0;
  }

  const plan = planEngine(options.engine, options.protocol);
  if ('skipped' in plan) {
    console.error(`SKIPPED ${options.engine}: ${plan.skipped}`);
    return 2;
  }
  const { envId, host } = machine();
  let started;
  try {
    started = await startLabService(options.port);
  } catch (error) {
    console.error(`PROBLEM: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { service, release } = started;
  let browser;
  try {
    browser = await launchProfile(options.engine);
  } catch (error) {
    release();
    await service.stop();
    console.error(
      `PROBLEM: the browser of ${options.engine} did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  try {
    const world = playwrightWorld({
      engine: options.engine,
      stream: plan.stream,
      protocol: plan.protocol,
      service: service.client,
      browser,
    });
    const driver = playwrightSoakDriver(world, {
      minutes: options.minutes,
      stallAtMinutes: options.stallAtMinutes,
      staleAtMinutes: options.staleAtMinutes,
      patch: options.candidate?.patch ?? null,
      servicePid: service.pid,
    });
    log(
      `soak: ${options.minutes} min on ${options.engine} (${envId}), ${plan.stream} over ${plan.protocol}, configuration ${options.candidate?.id ?? 'A'}; outage at ${options.stallAtMinutes ?? 'none'} min, stale manifest at ${options.staleAtMinutes ?? 'none'} min`,
    );
    const run = await runSoak(driver, {
      engine: options.engine,
      minutes: options.minutes,
      warmupSec: options.warmupSec,
      sampleSec: options.sampleSec,
      heapEverySec: options.heapEverySec,
      drainSec: options.drainSec,
      log,
    });
    const described = await describeRun(browser, service, plan);
    const report = buildSoakReport(run, {
      envId,
      engine: options.engine,
      generatedAt: new Date().toISOString(),
      commit: { hash: host.git.commit, dirty: host.git.dirty },
      host,
      ...described,
      configuration: options.candidate
        ? { id: options.candidate.id, label: options.candidate.label, patch: options.candidate.patch }
        : { id: 'A', label: 'the library defaults (what ships)', patch: null },
      options: {
        minutes: options.minutes,
        warmupSec: options.warmupSec,
        sampleSec: options.sampleSec,
        heapEverySec: options.heapEverySec,
        stallAtMinutes: options.stallAtMinutes,
        staleAtMinutes: options.staleAtMinutes,
      },
    });
    console.log(renderSoakReport(report));
    if (run.lostSamples > 0 || run.samplerProblems.length > 0)
      console.error(
        `warning: ${run.lostSamples} reads were lost and the sampler reported: ${run.samplerProblems.join('; ') || 'nothing'}`,
      );
    if (options.write) {
      const dir = options.outDir ?? soakDir(DEFAULT_RESULTS_ROOT);
      log(`wrote ${writeResult(dir, soakFileName(envId, options.engine, options.minutes), report)}`);
    }
    return report.verdict === 'GO' ? 0 : report.verdict === 'NO-GO' ? 1 : 2;
  } finally {
    release();
    await browser.close().catch(() => undefined);
    await service.stop();
  }
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
