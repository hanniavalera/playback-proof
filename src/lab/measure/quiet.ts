import { loadavg } from 'node:os';
import { sleep } from './timeouts.ts';

// Waiting for a quiet machine before a measurement (ADR-130). The numbers of this harness are only as quiet as the machine that took
// them, so the command that records a baseline or runs the gate can be started through `perf/quiet.ts`, which waits until the 1-minute
// load average is at or below a limit, and tells the harness (through the environment) how long it waited and what the load was when it
// started: the baseline file then says so.

export interface QuietResult {
  /** The limit the load average had to fall to. */
  maxLoad: number;
  /** The 1-minute load average at the moment the machine was quiet. */
  hostLoad: number;
  /** How long the wait took, 0 when the machine was quiet at once. */
  waitedMs: number;
}

export interface QuietOptions {
  /** Wait while the 1-minute load average is ABOVE this. */
  maxLoad: number;
  /** Give up after this long. Default 15 minutes: a machine that never calms down is a finding, not a number to measure on. */
  timeoutMs?: number;
  /** Time between two readings. Default 5 s (the 1-minute average moves slowly). */
  pollMs?: number;
  /** Injectable for the unit tests. */
  load?: () => number;
  wait?: (ms: number) => Promise<void>;
  clock?: () => number;
  /** Called at every reading that found the machine busy. */
  onBusy?: (load: number, waitedMs: number) => void;
}

/** The machine did not calm down in time. */
export class MachineBusyError extends Error {
  override name = 'MachineBusyError';
  readonly load: number;
  constructor(message: string, load: number) {
    super(message);
    this.load = load;
  }
}

/** The names `perf/quiet.ts` puts in the environment of its command; `PB_DOCKER_ENV` lists them so that tools/docker/pw.sh hands them to the container. */
export const QUIET_ENV_NAMES = ['PB_QUIET_MAX_LOAD', 'PB_QUIET_HOST_LOAD', 'PB_QUIET_WAITED_MS'] as const;

/** The environment of the command that runs after the wait: what the wait found, in the names `machineFacts` reads. */
export function quietEnvironment(result: QuietResult, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const listed = (env.PB_DOCKER_ENV ?? '').split(/\s+/).filter(Boolean);
  return {
    ...env,
    PB_QUIET_MAX_LOAD: String(result.maxLoad),
    PB_QUIET_HOST_LOAD: result.hostLoad.toFixed(2),
    PB_QUIET_WAITED_MS: String(Math.round(result.waitedMs)),
    PB_DOCKER_ENV: [...new Set([...listed, ...QUIET_ENV_NAMES])].join(' '),
  };
}

export interface QuietInvocation {
  maxLoad: number;
  timeoutMs: number;
  /** The command and its arguments, everything after `--`. */
  command: string[];
}

export const QUIET_USAGE = `usage: npx tsx perf/quiet.ts --max-load N [--timeout-min M] -- <command> [args...]

Waits until the 1-minute load average of this machine is at or below N (the limit of the measurements of this project is 3), then runs
the command with the wait recorded in its environment (the baseline file says how long it waited). Gives up after M minutes (default 15)
with exit code 2. Otherwise the exit code is the command's.`;

export class QuietUsageError extends Error {
  override name = 'QuietUsageError';
}

export function parseQuietArgs(argv: readonly string[]): QuietInvocation {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new QuietUsageError('the command to run comes after "--"');
  const command = argv.slice(separator + 1);
  if (command.length === 0) throw new QuietUsageError('there is no command after "--"');
  let maxLoad: number | null = null;
  let timeoutMin = 15;
  const own = argv.slice(0, separator);
  for (let index = 0; index < own.length; index += 2) {
    const flag = own[index];
    const value = own[index + 1];
    const number = Number(value);
    if (value === undefined || value.trim() === '' || !Number.isFinite(number) || number <= 0)
      throw new QuietUsageError(`${flag} needs a number > 0, got ${JSON.stringify(value)}`);
    if (flag === '--max-load') maxLoad = number;
    else if (flag === '--timeout-min') timeoutMin = number;
    else throw new QuietUsageError(`unknown option ${JSON.stringify(flag)}`);
  }
  if (maxLoad === null) throw new QuietUsageError('--max-load is required: the load average to wait for');
  return { maxLoad, timeoutMs: Math.round(timeoutMin * 60_000), command };
}

export async function waitUntilQuiet(options: QuietOptions): Promise<QuietResult> {
  const { maxLoad } = options;
  if (!Number.isFinite(maxLoad) || maxLoad <= 0)
    throw new RangeError(`maxLoad must be a number > 0, got ${String(maxLoad)}`);
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? 5000;
  const load = options.load ?? ((): number => loadavg()[0] ?? 0);
  const pause = options.wait ?? sleep;
  const clock = options.clock ?? ((): number => Date.now());

  const started = clock();
  for (;;) {
    const now = load();
    const waitedMs = clock() - started;
    if (now <= maxLoad) return { maxLoad, hostLoad: now, waitedMs };
    options.onBusy?.(now, waitedMs);
    if (waitedMs + pollMs > timeoutMs) {
      throw new MachineBusyError(
        `the machine did not calm down: the 1-minute load average was ${now.toFixed(2)} after ${Math.round(waitedMs / 1000)} s, and the limit is ${maxLoad}`,
        now,
      );
    }
    await pause(pollMs);
  }
}
