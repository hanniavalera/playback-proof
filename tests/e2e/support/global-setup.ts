import type { FullConfig } from '@playwright/test';
import { ServiceClient } from '../../../src/lab/service-client.ts';
import { STREAM_IDS } from '../../../src/shared/streams.ts';

// Runs once, after Playwright has started (or found) the service: a run against a service that cannot serve what the specs ask for
// would fail test by test with timeouts, so it stops here with the one instruction that fixes it. The service itself refuses to
// start when a stream is missing (tools/serve.ts prints the same instruction); this covers a service that was already running
// (`reuseExistingServer`) or started without the cache.
export default async function globalSetup(config: FullConfig): Promise<void> {
  const origin = config.projects[0]?.use.baseURL;
  const service = new ServiceClient(origin);
  const health = await service.health().catch((error: unknown) => {
    throw new Error(
      `the test data service at ${service.origin} is not answering (${(error as Error).message}): start it with \`npm run build:player && npm run serve\``,
      { cause: error },
    );
  });
  const missing = STREAM_IDS.filter((id) => health.streams[id] !== 'ready');
  if (missing.length > 0) {
    throw new Error(
      `the test data service at ${service.origin} reports missing streams (${missing.join(', ')}): run \`npm run generate:streams\`, then start the service again`,
    );
  }
  if (health.player !== 'built') {
    throw new Error(
      `the test data service at ${service.origin} has no player page: run \`npm run build:player\`, then start the service again`,
    );
  }
}
