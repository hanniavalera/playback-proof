import type { StreamId } from '../shared/streams.ts';
import { DEFAULT_PORT } from '../shared/urls.ts';
import { startServer } from './index.ts';
import type { RunningServer } from './index.ts';
import { createMediaStore } from './media/index.ts';
import { CATALOG } from './media/specs.ts';
import type { MediaStore } from './media/types.ts';

// What `npm run serve` does, as a function of the environment, so that it is tested without a child process and without generated
// streams: tools/serve.ts is only the part that cannot be (the process, the signals, the exit code).
//
//   PB_PORT          default 4600; 0 picks a free port (the line that is printed says which)
//   PB_HOST          default 127.0.0.1
//   PB_PLAYER_DIR    where the built player is (default <repo>/dist/player)
//   PB_CACHE_DIR     the stream cache to serve (default <repo>/.cache/streams)
//   PB_LOG=1         one line per request on stderr (off by default)

/** A refusal to start that the user can act on: its message is printed as it is, without a stack. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliIo {
  /** stdout: the one line that says where the service listens. */
  out(line: string): void;
  /** stderr: warnings and the request log. */
  err(line: string): void;
}

export interface CliDeps {
  /** The store to serve. Default: the real one, over `PB_CACHE_DIR`. */
  media?: MediaStore;
  /** The streams that must be ready. Default: every stream that has a spec in the catalog. */
  required?: readonly StreamId[];
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Hosts that only this machine can reach. Anything else gets a warning: the service has no authentication. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw) || Number(raw) > 65_535)
    throw new CliError(`PB_PORT must be an integer from 0 to 65535 (0 picks a free port), got "${raw}"`);
  return Number(raw);
}

/** Starts the service as configured by the environment, or throws a CliError that says what to do. Prints the "listening" line. */
export async function serveFromEnv(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps = {},
): Promise<RunningServer> {
  const port = parsePort(env.PB_PORT);
  const host = env.PB_HOST || '127.0.0.1';
  const media = deps.media ?? createMediaStore(env.PB_CACHE_DIR ? { cacheDir: env.PB_CACHE_DIR } : {});

  // A stream that has a spec but no files is a service that fails halfway through a test: refuse now, and say how to fix it.
  const required = deps.required ?? CATALOG.map((spec) => spec.id);
  const missing = required.filter((id) => !media.has(id));
  if (missing.length > 0)
    throw new CliError(
      missing.map((id) => `stream ${id} is missing: run npm run generate:streams`).join('\n'),
    );

  let server: RunningServer;
  try {
    server = await startServer({
      port,
      host,
      media,
      ...(env.PB_PLAYER_DIR ? { playerDir: env.PB_PLAYER_DIR } : {}),
      ...(env.PB_LOG === '1' ? { log: (line: string) => io.err(line) } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE')
      throw new CliError(
        `port ${port} on ${host} is already in use: set PB_PORT to another port (0 picks a free one)`,
      );
    throw err;
  }
  if (!isLoopbackHost(host))
    io.err(
      `warning: listening on ${host}: the service has no authentication, anyone who can reach it can use it`,
    );
  io.out(`playback-proof service listening on ${server.origin}`);
  return server;
}
