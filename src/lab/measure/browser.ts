import type { Browser, BrowserContext, Page } from '@playwright/test';
import { applyCpuThrottle } from './cpu-throttle.ts';
import { cpuThrottleOf, engineOf } from './types.ts';
import type { PerfEngine, PerfProfile } from './types.ts';

// Launching an engine by profile name, and the fresh context of every run.
//
// ONE BROWSER PROCESS PER BATCH, ONE FRESH CONTEXT PER RUN (ADR-120). A context is a clean member session: no cache, no cookies, no
// storage, its own pages and processes of the page, which is what "a viewer who opens the player" means, and it costs milliseconds. A
// browser PROCESS per run would put the launch of the browser (hundreds of milliseconds to seconds, and far more variable than what is
// measured) into every number, or, if it were excluded, would still make every run's first frame pay for a cold process that no member's
// player pays for. Sharing one context between runs would carry the HTTP cache, the JIT and the connection pool from one run to the next,
// and the runs would stop being independent samples.

export interface RunPage {
  page: Page;
  context: BrowserContext;
  /** Closes the context (and with it the page and the throttle session). */
  close(): Promise<void>;
}

export interface LaunchedBrowser {
  profile: PerfProfile;
  engine: PerfEngine;
  /** `browser.version()`: the build that was measured. */
  version: string;
  /** The CPU slowdown this profile applies to every run's page, or null. */
  cpuThrottleRate: number | null;
  /** A new context and page; for a throttled profile the throttle is on before the page can navigate. */
  newRun(): Promise<RunPage>;
  /** The user agent string of the engine, read from a blank page (never part of a measurement). */
  userAgent(): Promise<string>;
  close(): Promise<void>;
}

/** The device descriptors the specs run in (playwright.config.ts), so the page has the same viewport and user agent in both. */
const DEVICE: Record<PerfEngine, string> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};

export type Launcher = (profile: PerfProfile) => Promise<LaunchedBrowser>;

/** Launches the engine of `profile`. Playwright is imported here, so that nothing that only judges numbers ever loads it. */
export const launchProfile: Launcher = async (profile) => {
  const playwright = await import('@playwright/test');
  const engine = engineOf(profile);
  const rate = cpuThrottleOf(profile);
  const descriptor = playwright.devices[DEVICE[engine]];
  if (!descriptor) throw new Error(`Playwright has no device descriptor called ${DEVICE[engine]}`);
  const browser: Browser = await playwright[engine].launch();

  const newContext = (): Promise<BrowserContext> => browser.newContext({ ...descriptor });

  return {
    profile,
    engine,
    version: browser.version(),
    cpuThrottleRate: rate,
    async newRun() {
      const context = await newContext();
      try {
        const page = await context.newPage();
        // Before the page navigates: the emulation is a property of the session, and a page that has already loaded has already run
        // its start-up at full speed.
        if (rate !== null) await applyCpuThrottle({ browserName: engine, rate, context, page });
        return { page, context, close: () => context.close() };
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    },
    async userAgent() {
      const context = await newContext();
      try {
        const page = await context.newPage();
        return await page.evaluate(() => navigator.userAgent);
      } finally {
        await context.close().catch(() => {});
      }
    },
    close: () => browser.close(),
  };
};
