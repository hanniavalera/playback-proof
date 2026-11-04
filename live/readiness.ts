// `npm run readiness -- [options]`
//
// Runs the live-event readiness checks of TEST_STRATEGY.md section 8 (PB-RDY-001 to PB-RDY-004) for the chosen engines, in the build as it
// ships (A, Shaka's defaults) and in the candidate configurations asked for, prints the go/no-go sheet with a measured value, a limit and a
// verdict on every line, then the checklist, and writes docs/results/readiness/<env>-<engine>.json.
//
// It needs the machine to itself: a check is a measurement. `npm run readiness -- --help` lists the options.

import { READINESS_USAGE, ReadinessUsageError, parseReadinessArgs } from '../src/lab/readiness/args.ts';
import type { ReadinessOptions } from '../src/lab/readiness/args.ts';
import {
  renderChecklist,
  renderReadinessReport,
  renderRun,
  runVerdict,
} from '../src/lab/readiness/checklist.ts';
import { playwrightWorld } from '../src/lab/readiness/playwright-world.ts';
import {
  buildReadinessReport,
  evaluateConfigurations,
  loadResults,
  readinessDir,
  writeResult,
} from '../src/lab/readiness/readiness-run.ts';
import { ResultFileError, readinessFileName } from '../src/lab/readiness/report.ts';
import type { ReadinessReport } from '../src/lab/readiness/report.ts';
import type { Verdict } from '../src/lab/readiness/verdict.ts';
import {
  DEFAULT_RESULTS_ROOT,
  describeRun,
  launchProfile,
  log,
  machine,
  planEngine,
  startLabService,
} from './common.ts';

/** This run's reports replace the committed ones of the same environment and engine; the others stay, for the checklist of every engine. */
function withCommitted(
  fresh: readonly ReadinessReport[],
  committed: readonly ReadinessReport[],
): ReadinessReport[] {
  const same = (a: ReadinessReport, b: ReadinessReport): boolean =>
    a.envId === b.envId && a.engine === b.engine;
  return [...committed.filter((old) => !fresh.some((now) => same(now, old))), ...fresh];
}

const exitCodeOf = (verdict: Verdict, skipped: number): number =>
  verdict === 'NO-GO' ? 1 : verdict === 'GO' && skipped === 0 ? 0 : 2;

async function fromResults(options: ReadinessOptions): Promise<number> {
  try {
    const loaded = loadResults(options.resultsDir ?? DEFAULT_RESULTS_ROOT);
    if (loaded.readiness.length === 0 && loaded.soaks.length === 0) {
      console.error(`no result files under ${options.resultsDir ?? DEFAULT_RESULTS_ROOT}/readiness or /soak`);
      return 2;
    }
    console.log(renderRun(loaded.readiness, loaded.soaks));
    return exitCodeOf(runVerdict(loaded.readiness), 0);
  } catch (error) {
    if (!(error instanceof ResultFileError)) throw error;
    console.error(error.message);
    return 2;
  }
}

async function main(argv: string[]): Promise<number> {
  let options: ReadinessOptions;
  try {
    options = parseReadinessArgs(argv);
  } catch (error) {
    if (error instanceof ReadinessUsageError) {
      console.error(`${error.message}\n\n${READINESS_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(READINESS_USAGE);
    return 0;
  }
  if (options.fromResults) return fromResults(options);

  const { envId, host } = machine();
  const outDir = options.outDir ?? readinessDir(DEFAULT_RESULTS_ROOT);
  const reports: ReadinessReport[] = [];
  let skipped = 0;
  const { service, release } = await startLabService(options.port).catch((error: unknown) => {
    console.error(`PROBLEM: ${error instanceof Error ? error.message : String(error)}`);
    return { service: null, release: () => undefined };
  });
  if (!service) return 2;
  try {
    for (const engine of options.engines) {
      const plan = planEngine(engine, options.protocol);
      if ('skipped' in plan) {
        skipped += 1;
        console.error(`SKIPPED ${engine}: ${plan.skipped}`);
        continue;
      }
      log(`${engine}: ${plan.stream} over ${plan.protocol}`);
      let browser;
      try {
        browser = await launchProfile(engine);
      } catch (error) {
        skipped += 1;
        console.error(
          `PROBLEM: the browser of ${engine} did not start: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const began = Date.now();
      try {
        const world = playwrightWorld({
          engine,
          stream: plan.stream,
          protocol: plan.protocol,
          service: service.client,
          browser,
        });
        const configurations = await evaluateConfigurations(world, options.candidates, {
          checks: options.checks,
          joins: options.joins,
          stallRuns: options.stallRuns,
          windowSec: options.windowSec,
          refreshes: options.refreshes,
          log,
        });
        const described = await describeRun(browser, service, plan);
        const report = buildReadinessReport(
          {
            envId,
            engine,
            generatedAt: new Date().toISOString(),
            durationMs: Date.now() - began,
            commit: { hash: host.git.commit, dirty: host.git.dirty },
            host,
            ...described,
            options: {
              checks: options.checks,
              joins: options.joins,
              stallRuns: options.stallRuns,
              windowSec: options.windowSec,
              refreshes: options.refreshes,
            },
          },
          configurations,
        );
        reports.push(report);
        console.log(`${renderReadinessReport(report)}\n`);
        if (options.write) log(`wrote ${writeResult(outDir, readinessFileName(envId, engine), report)}`);
      } finally {
        await browser.close().catch(() => undefined);
      }
    }
  } finally {
    release();
    await service.stop();
  }

  if (reports.length === 0) return 2;
  try {
    const committed = options.write ? loadResults(DEFAULT_RESULTS_ROOT) : { readiness: [], soaks: [] };
    const readiness = options.write ? withCommitted(reports, committed.readiness) : reports;
    console.log(renderChecklist({ readiness, soaks: committed.soaks }));
  } catch (error) {
    if (!(error instanceof ResultFileError)) throw error;
    console.error(`the committed results could not be read for the checklist: ${error.message}`);
    return 2;
  }
  return exitCodeOf(runVerdict(reports), skipped);
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
