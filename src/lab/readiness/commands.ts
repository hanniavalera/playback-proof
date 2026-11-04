import type { HostInfo } from '../probe/host-info.ts';
import type { LaunchedBrowser } from '../measure/browser.ts';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import {
  READINESS_USAGE,
  ReadinessUsageError,
  SOAK_USAGE,
  parseReadinessArgs,
  parseSoakArgs,
} from './args.ts';
import type { ReadinessOptions, SoakOptions } from './args.ts';
import {
  renderChecklist,
  renderReadinessReport,
  renderRun,
  renderSoakReport,
  runVerdict,
} from './checklist.ts';
import { playwrightWorld } from './playwright-world.ts';
import type { WorldService } from './playwright-world.ts';
import {
  buildReadinessReport,
  evaluateConfigurations,
  loadResults,
  readinessDir,
  soakDir,
  writeResult,
} from './readiness-run.ts';
import { ResultFileError, readinessFileName, soakFileName } from './report.ts';
import type { BrowserInfo, LoadReading, ReadinessReport, StreamRecord } from './report.ts';
import { buildSoakReport, runSoak } from './soak.ts';
import { playwrightSoakDriver } from './soak-driver.ts';
import type { Engine } from './soak-evaluators.ts';
import type { Verdict } from './verdict.ts';

// What `npm run readiness` and `npm run soak` do, written against what they need from the machine (`CommandDeps`) so that every line of
// them runs in a unit test with a fake service and a fake browser, and `live/readiness.ts` and `live/soak.ts` are the few lines that hand
// them the real ones (live/common.ts). The exit codes are decided here: 0 GO, 1 NO-GO, 2 a run that could not judge.

/** The service the command started: its client, its pid for the memory reading, and how to stop it. */
export interface LabService {
  client: WorldService;
  pid: number | null;
  stop(): Promise<void>;
}

export interface EnginePlan {
  engine: Engine;
  stream: StreamId;
  protocol: Protocol;
}

export interface CommandDeps {
  /** What the command prints for a reader (stdout) and what it says about its own progress (stderr). */
  out(text: string): void;
  err(text: string): void;
  /** Starts the service on the port, as a child process; `release` lets go of the signal handlers that stop it. */
  startService(port: number): Promise<{ service: LabService; release(): void }>;
  launch(engine: Engine): Promise<LaunchedBrowser>;
  /** Whether the engine can play the live stream here, by the committed evidence of this environment: a plan, or the documented reason it cannot. */
  plan(engine: Engine, protocol: Protocol): EnginePlan | { engine: Engine; skipped: string };
  machine(): { envId: string; host: HostInfo };
  /** The machine's load average and CPU count right now (`os.loadavg()`), read before and after every run so that the file says how busy the machine was. */
  load(): LoadReading;
  /** The browser and the stream that were used, for the header of a result file. */
  describe(
    browser: LaunchedBrowser,
    service: LabService,
    plan: EnginePlan,
  ): Promise<{ browser: BrowserInfo; stream: StreamRecord }>;
  /** `docs/results` of the checkout: where the committed results are read for the checklist, and where result files go by default. */
  resultsRoot: string;
  /** The harness's clock and its sleep: the real ones unless a test gives the virtual pair its fake page runs on. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

const nowOf = (deps: CommandDeps): number => deps.clock?.now() ?? Date.now();
const dateOf = (deps: CommandDeps): string => new Date(nowOf(deps)).toISOString();

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

function fromResults(options: ReadinessOptions, deps: CommandDeps): number {
  const root = options.resultsDir ?? deps.resultsRoot;
  try {
    const loaded = loadResults(root);
    if (loaded.readiness.length === 0 && loaded.soaks.length === 0) {
      deps.err(`no result files under ${root}/readiness or /soak`);
      return 2;
    }
    deps.out(renderRun(loaded.readiness, loaded.soaks));
    return exitCodeOf(runVerdict(loaded.readiness), 0);
  } catch (error) {
    if (!(error instanceof ResultFileError)) throw error;
    deps.err(error.message);
    return 2;
  }
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runReadinessCommand(argv: string[], deps: CommandDeps): Promise<number> {
  let options: ReadinessOptions;
  try {
    options = parseReadinessArgs(argv);
  } catch (error) {
    if (error instanceof ReadinessUsageError) {
      deps.err(`${error.message}\n\n${READINESS_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    deps.out(READINESS_USAGE);
    return 0;
  }
  if (options.fromResults) return fromResults(options, deps);

  const { envId, host } = deps.machine();
  const outDir = options.outDir ?? readinessDir(deps.resultsRoot);
  const reports: ReadinessReport[] = [];
  let skipped = 0;
  let started;
  try {
    started = await deps.startService(options.port);
  } catch (error) {
    deps.err(`PROBLEM: ${reason(error)}`);
    return 2;
  }
  const { service, release } = started;
  try {
    for (const engine of options.engines) {
      const plan = deps.plan(engine, options.protocol);
      if ('skipped' in plan) {
        skipped += 1;
        deps.err(`SKIPPED ${engine}: ${plan.skipped}`);
        continue;
      }
      deps.err(`${engine}: ${plan.stream} over ${plan.protocol}`);
      let browser;
      try {
        browser = await deps.launch(engine);
      } catch (error) {
        skipped += 1;
        deps.err(`PROBLEM: the browser of ${engine} did not start: ${reason(error)}`);
        continue;
      }
      const loadBefore = deps.load();
      const began = nowOf(deps);
      try {
        const world = playwrightWorld({
          engine,
          stream: plan.stream,
          protocol: plan.protocol,
          service: service.client,
          browser,
          ...(deps.clock ? { now: () => nowOf(deps) } : {}),
        });
        const configurations = await evaluateConfigurations(world, options.candidates, {
          checks: options.checks,
          joins: options.joins,
          stallRuns: options.stallRuns,
          windowSec: options.windowSec,
          refreshes: options.refreshes,
          log: deps.err,
        });
        const described = await deps.describe(browser, service, plan);
        const report = buildReadinessReport(
          {
            envId,
            engine,
            generatedAt: dateOf(deps),
            durationMs: nowOf(deps) - began,
            commit: { hash: host.git.commit, dirty: host.git.dirty },
            host,
            load: { before: loadBefore, after: deps.load() },
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
        deps.out(`${renderReadinessReport(report)}\n`);
        if (options.write) deps.err(`wrote ${writeResult(outDir, readinessFileName(envId, engine), report)}`);
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
    const committed = options.write ? loadResults(deps.resultsRoot) : { readiness: [], soaks: [] };
    const readiness = options.write ? withCommitted(reports, committed.readiness) : reports;
    deps.out(renderChecklist({ readiness, soaks: committed.soaks }));
  } catch (error) {
    if (!(error instanceof ResultFileError)) throw error;
    deps.err(`the committed results could not be read for the checklist: ${error.message}`);
    return 2;
  }
  return exitCodeOf(runVerdict(reports), skipped);
}

export async function runSoakCommand(argv: string[], deps: CommandDeps): Promise<number> {
  let options: SoakOptions;
  try {
    options = parseSoakArgs(argv);
  } catch (error) {
    if (error instanceof ReadinessUsageError) {
      deps.err(`${error.message}\n\n${SOAK_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    deps.out(SOAK_USAGE);
    return 0;
  }

  const plan = deps.plan(options.engine, options.protocol);
  if ('skipped' in plan) {
    deps.err(`SKIPPED ${options.engine}: ${plan.skipped}`);
    return 2;
  }
  const { envId, host } = deps.machine();
  let started;
  try {
    started = await deps.startService(options.port);
  } catch (error) {
    deps.err(`PROBLEM: ${reason(error)}`);
    return 2;
  }
  const { service, release } = started;
  let browser;
  try {
    browser = await deps.launch(options.engine);
  } catch (error) {
    release();
    await service.stop();
    deps.err(`PROBLEM: the browser of ${options.engine} did not start: ${reason(error)}`);
    return 2;
  }
  try {
    const world = playwrightWorld({
      engine: options.engine,
      stream: plan.stream,
      protocol: plan.protocol,
      service: service.client,
      browser,
      ...(deps.clock ? { now: () => nowOf(deps) } : {}),
    });
    const driver = playwrightSoakDriver(world, {
      minutes: options.minutes,
      stallAtMinutes: options.stallAtMinutes,
      staleAtMinutes: options.staleAtMinutes,
      patch: options.candidate?.patch ?? null,
      servicePid: service.pid,
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    const injected = [
      options.stallAtMinutes === null ? 'no outage' : `an outage at minute ${options.stallAtMinutes}`,
      options.staleAtMinutes === null
        ? 'no stale manifest'
        : `a stale manifest at minute ${options.staleAtMinutes}`,
    ].join(', ');
    deps.err(
      `soak: ${options.minutes} min on ${options.engine} (${envId}), ${plan.stream} over ${plan.protocol}, configuration ${options.candidate?.id ?? 'A'}; ${injected}`,
    );
    const loadBefore = deps.load();
    const run = await runSoak(driver, {
      engine: options.engine,
      minutes: options.minutes,
      warmupSec: options.warmupSec,
      sampleSec: options.sampleSec,
      heapEverySec: options.heapEverySec,
      drainSec: options.drainSec,
      log: deps.err,
    });
    const described = await deps.describe(browser, service, plan);
    const report = buildSoakReport(run, {
      envId,
      engine: options.engine,
      generatedAt: dateOf(deps),
      commit: { hash: host.git.commit, dirty: host.git.dirty },
      host,
      load: { before: loadBefore, after: deps.load() },
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
    deps.out(renderSoakReport(report));
    if (run.lostSamples > 0 || run.samplerProblems.length > 0)
      deps.err(
        `warning: ${run.lostSamples} reads were lost and the sampler reported: ${run.samplerProblems.join('; ') || 'nothing'}`,
      );
    if (options.write) {
      const dir = options.outDir ?? soakDir(deps.resultsRoot);
      deps.err(`wrote ${writeResult(dir, soakFileName(envId, options.engine, options.minutes), report)}`);
    }
    return report.verdict === 'GO' ? 0 : report.verdict === 'NO-GO' ? 1 : 2;
  } finally {
    release();
    await browser.close().catch(() => undefined);
    await service.stop();
  }
}
