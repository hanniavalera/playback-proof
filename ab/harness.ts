import { existsSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentEnvironment } from '../src/lab/gaps.ts';
import { launchProfile } from '../src/lab/measure/browser.ts';
import { startService } from '../src/lab/measure/service.ts';
import { collectHostInfo } from '../src/lab/probe/host-info.ts';
import { detectEnvId } from '../src/shared/env.ts';
import type { StreamId } from '../src/shared/streams.ts';
import { PLAYER_DIST, buildPlayer } from '../tools/build-player.ts';
import type { Machine } from './execute.ts';
import type { Engine } from './prereg.ts';

// What the A/B runner shares with no one: the machine. It builds the player page when it is missing, starts the test data service as a child
// process on the A/B port, reads what the service knows about its streams, and hands over the launcher of the engine. Everything with a
// decision in it is in ab/experiment.ts, ab/execute.ts and ab/analyze.ts and is unit-tested; this file is plumbing that needs a real machine,
// and is what the pipeline check exercises.

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const log = (line: string): void => {
  console.error(line);
};

export async function startAbHarness(options: { port: number; engine: Engine }): Promise<Machine> {
  if (!existsSync(join(PLAYER_DIST, 'index.html'))) {
    log('dist/player is missing: building the player page');
    await buildPlayer();
  }
  const envId = detectEnvId();
  const host = collectHostInfo(ROOT);
  const service = await startService({ root: ROOT, port: options.port });
  let stopped = false;
  const onSignal = (): void => {
    void stop().finally(() => process.exit(130));
  };
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await service.stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const streams: Partial<Record<StreamId, string>> = {};
  try {
    for (const stream of await service.client.streams()) streams[stream.id] = stream.contentHash;
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    envId,
    host,
    ffmpeg: service.health.ffmpeg,
    streams,
    deps: {
      service: { origin: service.origin, client: service.client },
      launch: launchProfile,
      environment: currentEnvironment(options.engine),
      loadAverage: () => loadavg()[0] ?? 0,
    },
    stop,
  };
}
