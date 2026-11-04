import type { BrowserContext, Page } from '@playwright/test';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import type { LaunchedBrowser } from '../measure/browser.ts';
import type { ServiceClient } from '../service-client.ts';
import { ReadinessPage } from './page.ts';
import type { Engine } from './soak-evaluators.ts';
import type { NewRunRequest, ReadinessRun, ReadinessWorld } from './world.ts';

// The world of the command line: the test data service as a client, one browser process for the engine, and for every run a fresh
// context (a viewer who opens the page: no cache, no storage, nothing carried over from the run before: ADR-120 in docs/decisions/perf.md)
// with a session of its own, which is deleted when the run closes. Not unit-tested, because it needs a browser: it is deliberately thin, and
// everything with a decision in it is in the modules that the unit tests cover.

export interface PlaywrightRun extends ReadinessRun {
  player: ReadinessPage;
  page: Page;
  context: BrowserContext;
  /** Errors and uncaught page errors the browser console said. */
  consoleProblems(): string[];
  /** Why the page is gone (it crashed or was closed), or null. */
  crashed(): string | null;
}

export interface PlaywrightWorld extends ReadinessWorld {
  newRun(request: NewRunRequest): Promise<PlaywrightRun>;
  readonly service: ServiceClient;
}

const MAX_CONSOLE_PROBLEMS = 40;

export function playwrightWorld(args: {
  engine: Engine;
  stream: StreamId;
  protocol: Protocol;
  service: ServiceClient;
  browser: LaunchedBrowser;
}): PlaywrightWorld {
  const { engine, stream, protocol, service, browser } = args;
  return {
    engine,
    stream,
    protocol,
    service,
    now: () => performance.now(),
    async newRun(request) {
      const info = await service.createSession({
        stream,
        protocol,
        label: request.label,
        ...(request.ttlSec === undefined ? {} : { ttlSec: request.ttlSec }),
        ...(request.live === undefined ? {} : { live: request.live }),
        ...(request.faults === undefined ? {} : { faults: request.faults }),
      });
      let run;
      try {
        run = await browser.newRun();
      } catch (error) {
        await service.deleteSession(info.id).catch(() => undefined);
        throw error;
      }
      const problems: string[] = [];
      let gone: string | null = null;
      run.page.on('crash', () => {
        gone = 'the page crashed';
      });
      run.page.on('close', () => {
        gone ??= 'the page was closed';
      });
      run.page.on('console', (message) => {
        if (message.type() === 'error' && problems.length < MAX_CONSOLE_PROBLEMS)
          problems.push(`console error: ${message.text()}`);
      });
      run.page.on('pageerror', (error) => {
        if (problems.length < MAX_CONSOLE_PROBLEMS) problems.push(`uncaught page error: ${error.message}`);
      });
      const player = new ReadinessPage(run.page, service.origin, info.manifestUrl);
      return {
        session: { ...info, service },
        player,
        page: run.page,
        context: run.context,
        consoleProblems: () => [...problems],
        crashed: () => gone,
        async close() {
          await run.close().catch(() => undefined);
          await service.deleteSession(info.id).catch(() => undefined);
        },
      };
    },
  };
}
