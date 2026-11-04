import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { StreamKind } from '../../../src/lab/probe/formats.ts';
import { ServiceClient, ServiceError } from '../../../src/lab/service-client.ts';
import type { SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import type { Protocol, StreamId } from '../../../src/shared/streams.ts';
import { DEFAULT_PORT } from '../../../src/shared/urls.ts';
import { chooseStream, currentEnvironment, engineGap, gapForStream } from './gaps.ts';
import type { Environment } from './gaps.ts';
import { PlayerHandle } from './player.ts';

/** A session made by `newSession`: its `SessionInfo`, plus the service it lives on (what `waitForRequest` and the log helpers use). */
export type TestSession = SessionInfo & { readonly service: ServiceClient };

interface TestFixtures {
  /** (auto) Skips the test, before its body and before any browser starts, when the engine cannot play anything here: a documented gap. */
  documentedGap: void;
  /**
   * Creates a session for this test, labelled with the test title, and deletes it when the test ends, also when it failed.
   * Skips the test (with the reason of docs/CODEC_MATRIX.md) when the stream is made of a flavour this engine does not play.
   */
  newSession: (request: SessionRequest) => Promise<TestSession>;
  /** The stream to play for a kind and a protocol in THIS engine (capability-driven); skips the test with the documented reason when none plays. */
  streamFor: (kind: StreamKind, protocol: Protocol) => StreamId;
  /** A `PlayerHandle` on the test's page (or on `page`) for a session. Nothing is navigated until `open()`. */
  player: (session?: Pick<SessionInfo, 'id' | 'manifestUrl'>, page?: Page) => PlayerHandle;
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

  documentedGap: [
    async ({ environment }, use, testInfo) => {
      const reason = engineGap(environment);
      if (reason) testInfo.skip(true, reason);
      await use();
    },
    { auto: true },
  ],

  newSession: async ({ service, environment, documentedGap: _gap }, use, testInfo) => {
    const created: TestSession[] = [];
    await use(async (request) => {
      const gap = gapForStream(environment, request.stream);
      if (gap) testInfo.skip(true, gap);
      const info = await service.createSession({ label: testInfo.title, ...request });
      const session: TestSession = { ...info, service };
      created.push(session);
      return session;
    });
    for (const session of created) {
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

  streamFor: async ({ environment, documentedGap: _gap }, use, testInfo) => {
    await use((kind, protocol) => {
      const choice = chooseStream(environment, kind, protocol);
      if ('gap' in choice) {
        testInfo.skip(true, choice.gap);
        throw new Error(choice.gap);
      }
      return choice.stream;
    });
  },

  player: async ({ page, service }, use) => {
    await use((session, onPage = page) => new PlayerHandle(onPage, service.origin, session ?? null));
  },
});

export { expect };
