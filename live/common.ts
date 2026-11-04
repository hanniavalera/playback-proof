// What the two commands of the live-event readiness (live/readiness.ts, live/soak.ts) share: the checkout, the service that runs as a child
// process, the environment of the machine, and the choice of the stream an engine plays. Everything with a decision in it is in
// src/lab/readiness (commands.ts is what the commands do, run by a unit test over fakes); this file is the plumbing that needs a real
// machine, and `realDeps()` is what hands it to them.

import { existsSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentEnvironment, chooseStream, engineGap } from '../src/lab/gaps.ts';
import { launchProfile } from '../src/lab/measure/browser.ts';
import type { LaunchedBrowser } from '../src/lab/measure/browser.ts';
import { startService } from '../src/lab/measure/service.ts';
import type { RunningService } from '../src/lab/measure/service.ts';
import { collectHostInfo } from '../src/lab/probe/host-info.ts';
import type { CommandDeps, EnginePlan, LabService } from '../src/lab/readiness/commands.ts';
import type { BrowserInfo, LoadReading, StreamRecord } from '../src/lab/readiness/report.ts';
import type { Engine } from '../src/lab/readiness/soak-evaluators.ts';
import { detectEnvId } from '../src/shared/env.ts';
import type { Protocol } from '../src/shared/streams.ts';
import { PLAYER_DIST, buildPlayer } from '../tools/build-player.ts';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_RESULTS_ROOT = join(ROOT, 'docs', 'results');

export const log = (line: string): void => {
  console.error(line);
};

/** Starts the service as a child process (building the player page first when it is missing), and stops it on SIGINT and SIGTERM. */
export async function startLabService(
  port: number,
): Promise<{ service: RunningService; release: () => void }> {
  if (!existsSync(join(PLAYER_DIST, 'index.html'))) {
    log('dist/player is missing: building the player page');
    await buildPlayer();
  }
  const service = await startService({ root: ROOT, port });
  const onSignal = (): void => {
    void service.stop().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    service,
    release: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
  };
}

/** Whether the engine can play the live stream here, by the committed evidence of this environment: a plan, or the documented reason it cannot. */
export function planEngine(
  engine: Engine,
  protocol: Protocol,
): EnginePlan | { engine: Engine; skipped: string } {
  const environment = currentEnvironment(engine);
  const gap = engineGap(environment);
  if (gap) return { engine, skipped: gap };
  const choice = chooseStream(environment, 'live', protocol);
  if ('gap' in choice) return { engine, skipped: choice.gap };
  return { engine, stream: choice.stream, protocol };
}

export function machine(): ReturnType<CommandDeps['machine']> {
  return { envId: detectEnvId(), host: collectHostInfo(ROOT) };
}

/** What was launched, and the stream it played, for the header of a result file. */
export async function describeRun(
  browser: LaunchedBrowser,
  service: LabService,
  plan: EnginePlan,
): Promise<{ browser: BrowserInfo; stream: StreamRecord }> {
  const streams = await service.client.streams().catch(() => []);
  return {
    browser: {
      name: browser.engine,
      version: browser.version,
      userAgent: await browser.userAgent().catch(() => null),
    },
    stream: {
      id: plan.stream,
      protocol: plan.protocol,
      contentHash: streams.find((stream) => stream.id === plan.stream)?.contentHash ?? null,
    },
  };
}

/** The load average of the machine right now: what `uptime` prints, with the time it was read. */
export function loadNow(): LoadReading {
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  return { at: new Date().toISOString(), load1, load5, load15, cpus: cpus().length };
}

/** The real machine behind the commands: the service as a child process, the browsers Playwright launches, this checkout's results. */
export function realDeps(): CommandDeps {
  return {
    out: (text) => console.log(text),
    err: log,
    startService: startLabService,
    launch: (engine: Engine) => launchProfile(engine),
    plan: planEngine,
    machine,
    load: loadNow,
    describe: describeRun,
    resultsRoot: DEFAULT_RESULTS_ROOT,
  };
}

export { launchProfile };
