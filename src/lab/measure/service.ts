import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { HealthInfo } from '../../shared/api.ts';
import { ServiceClient } from '../service-client.ts';
import { sleep } from './timeouts.ts';

// The test data service as a CHILD PROCESS of the harness (ADR-122). The service serves the media and applies the faults, so it does real
// work (reading segments, shaping bandwidth, writing the request log): if it ran inside the harness, that work would share an event loop
// with the code that times the player, and a slow response of the harness would read as a slow player. As its own process it only shares
// the machine, which is the same for the baseline and for the run under test.

export interface RunningService {
  origin: string;
  pid: number;
  client: ServiceClient;
  health: HealthInfo;
  /** SIGTERM, then SIGKILL after five seconds. Safe to call twice. */
  stop(): Promise<void>;
}

export interface StartServiceOptions {
  /** The checkout: where tools/serve.ts is and where the service finds `dist/player` and `.cache/streams`. */
  root: string;
  port: number;
  /** How long the service may take to answer `/health`. Default 30 s. */
  timeoutMs?: number;
  /** Extra environment of the child (the harness's own `process.env` is the base). */
  env?: NodeJS.ProcessEnv;
  /** How long `stop()` waits after SIGTERM before it sends SIGKILL. Default 5 s. */
  stopGraceMs?: number;
  /** Replaces `node --import tsx tools/serve.ts`: for the unit tests, which must not need generated streams. */
  command?: { file: string; args: readonly string[] };
}

const OUTPUT_KEPT = 4000;
const POLL_MS = 100;

/** The child ended before it answered: its own output says why (a port in use, a stream that was never generated). */
class ServiceExited extends Error {}

async function fetchHealth(origin: string): Promise<HealthInfo | null> {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? ((await response.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Starts the service on `port`, waits until it answers `/health` (and fails with the child's own output when it exits first), and returns a
 * handle that stops it by pid. One node process (the tsx loader runs inside it), so that stopping the pid stops the service and leaves
 * nothing behind.
 */
export async function startService(options: StartServiceOptions): Promise<RunningService> {
  const { root, port } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stopGraceMs = options.stopGraceMs ?? 5000;
  const command = options.command ?? {
    file: process.execPath,
    args: ['--import', 'tsx', join(root, 'tools', 'serve.ts')],
  };
  const origin = `http://127.0.0.1:${port}`;

  let output = '';
  const remember = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_KEPT);
  };
  const child: ChildProcess = spawn(command.file, [...command.args], {
    cwd: root,
    env: { ...process.env, ...options.env, PB_PORT: String(port), PB_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);

  let ended: string | null = null;
  const gone = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      ended = signal ? `signal ${signal}` : `code ${String(code)}`;
      resolve();
    });
    child.once('error', (error) => {
      output += `\n${error.message}`;
      ended = 'a launch error';
      resolve();
    });
  });

  // A harness that dies must not leave the service running: this handler runs on every exit path of the process.
  const killOnExit = (): void => {
    if (ended === null) child.kill('SIGKILL');
  };
  process.once('exit', killOnExit);

  const stop = async (): Promise<void> => {
    process.removeListener('exit', killOnExit);
    if (ended !== null) return;
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      gone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, stopGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (ended === null) {
      child.kill('SIGKILL');
      await gone;
    }
  };

  const said = (): string => (output.trim() === '' ? '(no output)' : output.trim());
  try {
    const deadline = Date.now() + timeoutMs;
    let health: HealthInfo | null = null;
    while (health === null) {
      if (ended !== null)
        throw new ServiceExited(
          `the service ended with ${ended} before it answered ${origin}/health:\n${said()}`,
        );
      health = await fetchHealth(origin);
      if (health !== null) break;
      if (Date.now() + POLL_MS > deadline)
        throw new Error(`the service at ${origin} was not healthy within ${timeoutMs} ms:\n${said()}`);
      await sleep(POLL_MS);
    }
    if (health.status !== 'ok')
      throw new Error(`the service at ${origin} answered with status ${String(health.status)}`);
    if (health.player !== 'built')
      throw new Error(`the service at ${origin} has no player page: run npm run build:player`);
    if (child.pid === undefined) throw new Error('the service process has no pid');
    return { origin, pid: child.pid, client: new ServiceClient(origin), health, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
