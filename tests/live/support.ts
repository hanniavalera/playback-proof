import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { LaunchedBrowser } from '../../src/lab/measure/browser.ts';
import type { CheckResult } from '../../src/lab/readiness/checks.ts';
import { candidateById } from '../../src/lab/readiness/candidates.ts';
import type { Candidate } from '../../src/lab/readiness/candidates.ts';
import { loadAndPlayInPage, openIdlePage } from '../../src/lab/readiness/page.ts';
import type { Engine } from '../../src/lab/readiness/soak-evaluators.ts';
import type { ReadinessPlayer, ReadinessRun, ReadinessWorld } from '../../src/lab/readiness/world.ts';
import type { ServiceClient } from '../../src/lab/service-client.ts';
import type { SessionRequest } from '../../src/shared/api.ts';
import type { Protocol, StreamId } from '../../src/shared/streams.ts';
import type { PlayerHandle } from '../e2e/support/player.ts';
import type { TestSession } from '../e2e/support/session.ts';

// What the readiness specs share: a world for the checks of src/lab/readiness made of the support library's own fixtures (the session of the
// test, so that a failure carries its diagnostics) and a fresh browser context for every run (a viewer who opens the page). The procedures
// are the ones the command line runs; the spec only decides, from their evaluations, whether it passes.

/** The context options of the project the test runs in, which `browser.newContext()` does not inherit by itself. */
export type ProjectContext = Pick<
  NonNullable<Parameters<Browser['newContext']>[0]>,
  'viewport' | 'userAgent' | 'deviceScaleFactor' | 'isMobile' | 'hasTouch'
>;

export interface SpecWorldArgs {
  engine: Engine;
  stream: StreamId;
  protocol: Protocol;
  service: ServiceClient;
  browser: Browser;
  context: ProjectContext;
  newSession: (request: SessionRequest) => Promise<TestSession>;
  player: (session: TestSession, page: Page) => PlayerHandle;
}

export function specWorld(args: SpecWorldArgs): ReadinessWorld {
  const { engine, stream, protocol, service, browser, context, newSession, player } = args;
  return {
    engine,
    stream,
    protocol,
    service,
    now: () => performance.now(),
    async newRun(request): Promise<ReadinessRun> {
      const session = await newSession({
        stream,
        protocol,
        label: request.label,
        ...(request.live === undefined ? {} : { live: request.live }),
        ...(request.faults === undefined ? {} : { faults: request.faults }),
        ...(request.ttlSec === undefined ? {} : { ttlSec: request.ttlSec }),
      });
      const fresh: BrowserContext = await browser.newContext(context);
      const page = await fresh.newPage();
      return {
        session,
        player: specPlayer(player(session, page), service.origin),
        // The session is the fixture's: it is deleted when the test ends, after the diagnostics have read it.
        close: () => fresh.close(),
      };
    },
  };
}

/**
 * The support library's `PlayerHandle` as the player of the checks: every member it has, and the two it lacks, which are the page's own
 * (`openIdlePage` and `loadAndPlayInPage`, shared with the command line's player): a handle always opens the page with a manifest, and a
 * configuration that Shaka reads when it loads has to arrive before that. The handle is the one the fixtures registered, so a failing
 * spec still carries the timeline and the console of the page.
 */
export function specPlayer(handle: PlayerHandle, origin: string): ReadinessPlayer {
  const consoleSummary = (): string => {
    const last = handle.consoleEntries().slice(-5);
    if (last.length === 0) return '';
    return `\nThe browser console said:\n${last.map((entry) => `  ${entry.type}: ${entry.text}`).join('\n')}`;
  };
  return {
    open: (params) => handle.open(params),
    openIdle: () => openIdlePage(handle.page, origin, consoleSummary),
    loadAndPlay: (manifestUri) => loadAndPlayInPage(handle.page, manifestUri),
    metrics: () => handle.metrics(),
    info: () => handle.info(),
    cursor: () => handle.cursor(),
    events: (since) => handle.events(since),
    waitFor: (name, options) => handle.waitFor(name, options),
    waitForMediaTime: (seconds, options) => handle.waitForMediaTime(seconds, options),
    configure: (patch) => handle.configure(patch),
  };
}

/** The same browser, as the lab's own `LaunchedBrowser`, so that the soak harness of the command line runs inside a spec unchanged. */
export function launchedFrom(args: {
  browser: Browser;
  engine: Engine;
  context: ProjectContext;
}): LaunchedBrowser {
  const { browser, engine, context } = args;
  return {
    profile: engine,
    engine,
    version: browser.version(),
    cpuThrottleRate: null,
    async newRun() {
      const fresh = await browser.newContext(context);
      try {
        const page = await fresh.newPage();
        return { page, context: fresh, close: () => fresh.close() };
      } catch (error) {
        await fresh.close().catch(() => undefined);
        throw error;
      }
    },
    async userAgent() {
      return context.userAgent ?? 'unknown (the project sets none)';
    },
    close: async () => undefined,
  };
}

/** The configuration under test: A (the defaults) unless `PB_READINESS_CANDIDATE` names a candidate (`live-sync`). */
export function candidateUnderTest(env: NodeJS.ProcessEnv = process.env): Candidate | null {
  const name = env.PB_READINESS_CANDIDATE;
  if (name === undefined || name === '' || name === 'A') return null;
  const candidate = candidateById(name);
  if (!candidate)
    throw new Error(`PB_READINESS_CANDIDATE=${name} is not a candidate configuration (known: live-sync)`);
  return candidate;
}

/** What a failing spec says: every criterion line that is not a GO, with the sentence a go/no-go sheet prints, and what ended the check. */
export function problemsOf(result: CheckResult): string[] {
  const lines = result.evaluations
    .filter(
      (evaluation) =>
        evaluation.scope === 'criterion' && evaluation.verdict !== 'GO' && evaluation.verdict !== 'N/A',
    )
    .map((evaluation) => `${evaluation.verdict} ${evaluation.label}: ${evaluation.sentence}`);
  if (result.failure) lines.push(`NO-GO ${result.failure}`);
  if (result.error) lines.push(`INCONCLUSIVE the check could not run: ${result.error}`);
  return lines;
}
