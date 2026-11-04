import type { FullConfig } from '@playwright/test';
import { ServiceClient } from '../../../src/lab/service-client.ts';
import type { HealthInfo } from '../../../src/shared/api.ts';
import { STREAM_IDS } from '../../../src/shared/streams.ts';

// Runs once, after Playwright has started (or found) the service: a run against a service that cannot serve what the specs ask for
// would fail test by test with timeouts, so it stops here with the one instruction that fixes it. The service itself refuses to
// start when a stream is missing (tools/serve.ts prints the same instruction); this covers a service that was already running
// (`reuseExistingServer`) or one that was started without the cache.

/** What is wrong with a service that answered `/health`, with the instruction that fixes it; null when it can serve the specs. */
export function describeUnreadyService(origin: string, health: HealthInfo): string | null {
  const problems: string[] = [];
  const missing = STREAM_IDS.filter((id) => health.streams[id] !== 'ready');
  if (missing.length > 0) {
    problems.push(`it reports missing streams (${missing.join(', ')}): run \`npm run generate:streams\``);
  }
  if (health.player !== 'built') problems.push('it has no player page: run `npm run build:player`');
  if (problems.length === 0) return null;
  return `the test data service at ${origin} cannot serve the specs: ${problems.join('; ')}; then start the service again`;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const service = new ServiceClient(config.projects[0]?.use.baseURL);
  const health = await service.health().catch((error: unknown) => {
    throw new Error(
      `the test data service at ${service.origin} is not answering (${(error as Error).message}): start it with \`npm run build:player && npm run serve\``,
      { cause: error },
    );
  });
  const problem = describeUnreadyService(service.origin, health);
  if (problem) throw new Error(problem);
}
