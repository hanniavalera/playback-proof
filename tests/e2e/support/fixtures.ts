import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { StreamKind } from '../../../src/lab/probe/formats.ts';
import { ServiceClient, ServiceError } from '../../../src/lab/service-client.ts';
import type { SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import type { Protocol, StreamId } from '../../../src/shared/streams.ts';
import { DEFAULT_PORT } from '../../../src/shared/urls.ts';
import { applyCpuThrottle, throttleRateOf } from './cpu-throttle.ts';
import { attachDiagnostics } from './diagnostics.ts';
import { chooseStream, currentEnvironment, engineGap, gapForStream } from './gaps.ts';
import type { Environment } from './gaps.ts';
import { PlayerHandle } from './player.ts';
import type { TestSession } from './session.ts';

export type { TestSession } from './session.ts';

// The fixtures every spec imports (`import { expect, test } from './support/fixtures.ts'`). Three rules shape them: a test owns its
// world (its own session, created for it and deleted after it), a documented gap is a skip with the evidence as its reason (decided
// before the body runs, never silently), and a failure explains itself (the diagnostics are attached to the result).

interface TestFixtures {
  /**
   * (auto) Skips the test, before its body and before any browser starts, when the engine cannot play anything here: a documented gap.
   * Marks every test of an experimental engine (Linux WebKit) with an `experimental-engine` annotation.
   */
  documentedGap: void;
  /** (auto) Slows the page's CPU when the project's `metadata.cpuThrottleRate` is set (`chromium-cpu4x`), before the page navigates. */
  cpuThrottle: void;
  /** (auto) When the test fails or times out, attaches the timeline, metrics, info, console, session detail and request log (`diagnostics.ts`). */
  diagnostics: void;
  /**
   * Creates a session for this test, labelled with the test title, and deletes it when the test ends, also when it failed.
   * Skips the test (with the reason of docs/CODEC_MATRIX.md) when the stream is made of a flavour this engine does not play.
   */
  newSession: (request: SessionRequest) => Promise<TestSession>;
  /** The stream to play for a kind and a protocol in THIS engine (capability-driven); skips the test with the documented reason when none plays. */
  streamFor: (kind: StreamKind, protocol: Protocol) => StreamId;
  /** A `PlayerHandle` on the test's page (or on `page`) for a session. Nothing is navigated until `open()`. */
  player: (session?: Pick<SessionInfo, 'id' | 'manifestUrl'>, page?: Page) => PlayerHandle;
  /** Internal: what the test created, for the diagnostics. */
  labRun: { sessions: TestSession[]; players: PlayerHandle[] };
}

interface WorkerFixtures {
  /** The test data service, on the project's `baseURL`. One client per worker. */
  service: ServiceClient;
  /** Where this worker runs and what the committed codec matrix says about it (`gaps.ts`). */
  environment: Environment;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  service: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const origin =
        workerInfo.project.use.baseURL ?? `http://127.0.0.1:${process.env.PB_PORT ?? DEFAULT_PORT}`;
      await use(new ServiceClient(origin));
    },
    { scope: 'worker' },
  ],

  environment: [
    async ({ browserName }, use) => {
      await use(currentEnvironment(browserName));
    },
    { scope: 'worker' },
  ],

  // Declared first, and every fixture that starts a browser or a session depends on it: the skip comes before either.
  documentedGap: [
    async ({ environment }, use, testInfo) => {
      const reason = engineGap(environment);
      if (reason) testInfo.skip(true, reason);
      // Every test of an experimental engine says so in its result, so that the flake tracking can follow it apart from the others.
      if (environment.experimental) {
        testInfo.annotations.push({ type: 'experimental-engine', description: environment.experimental });
      }
      await use();
    },
    { auto: true },
  ],

  labRun: async ({ documentedGap: _gap }, use) => {
    await use({ sessions: [], players: [] });
  },

  cpuThrottle: [
    async ({ documentedGap: _gap, page, context, browserName }, use, testInfo) => {
      const rate = throttleRateOf(testInfo.project.metadata);
      const session = rate === null ? null : await applyCpuThrottle({ browserName, rate, context, page });
      await use();
      await session?.detach().catch(() => {});
    },
    { auto: true },
  ],

  newSession: async ({ service, environment, labRun }, use, testInfo) => {
    await use(async (request) => {
      const gap = gapForStream(environment, request.stream);
      if (gap) testInfo.skip(true, gap);
      const info = await service.createSession({ label: testInfo.title, ...request });
      const session: TestSession = { ...info, service };
      labRun.sessions.push(session);
      return session;
    });
    for (const session of labRun.sessions) {
      try {
        await service.deleteSession(session.id);
      } catch (error) {
        // An expired session is already gone; anything else is worth a line in the report, not a failed test.
        if (!(error instanceof ServiceError && error.status === 404)) {
          testInfo.annotations.push({
            type: 'cleanup',
            description: `could not delete session ${session.id}: ${(error as Error).message}`,
          });
        }
      }
    }
  },

  streamFor: async ({ environment, labRun: _run }, use, testInfo) => {
    await use((kind, protocol) => {
      const choice = chooseStream(environment, kind, protocol);
      if ('gap' in choice) {
        testInfo.skip(true, choice.gap);
        throw new Error(choice.gap);
      }
      return choice.stream;
    });
  },

  player: async ({ page, service, labRun }, use) => {
    await use((session, onPage = page) => {
      const handle = new PlayerHandle(onPage, service.origin, session ?? null);
      labRun.players.push(handle);
      return handle;
    });
  },

  // Depends on `newSession` and `player` only for the order: fixtures are torn down in reverse, so the diagnostics are read while the
  // sessions still exist (`newSession` deletes them after) and the page is still open.
  diagnostics: [
    async ({ labRun, service, newSession: _newSession, player: _player }, use, testInfo) => {
      await use();
      if (testInfo.status === testInfo.expectedStatus || testInfo.status === 'skipped') return;
      await attachDiagnostics(testInfo, { service, sessions: labRun.sessions, players: labRun.players });
    },
    { auto: true },
  ],
});

export { expect };
