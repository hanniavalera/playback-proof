// `npx tsx perf/quiet.ts --max-load 3 -- npm run perf:baseline -- --profile chromium`
//
// Waits until the machine is quiet, then runs the command. A measurement taken on a busy machine measures the machine, so the harness
// is started through this when it records a baseline or runs the A/A: it records how long it waited and what the load was.

import { spawn } from 'node:child_process';
import {
  MachineBusyError,
  QUIET_USAGE,
  QuietUsageError,
  parseQuietArgs,
  quietEnvironment,
  waitUntilQuiet,
} from '../src/lab/measure/quiet.ts';

const say = (message: string): void => {
  console.error(`[quiet] ${message}`);
};

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help')) {
    console.log(QUIET_USAGE);
    return 0;
  }
  let invocation;
  try {
    invocation = parseQuietArgs(argv);
  } catch (error) {
    if (error instanceof QuietUsageError) {
      console.error(`${error.message}\n\n${QUIET_USAGE}`);
      return 2;
    }
    throw error;
  }

  let lastReport = -Infinity;
  let quiet;
  try {
    quiet = await waitUntilQuiet({
      maxLoad: invocation.maxLoad,
      timeoutMs: invocation.timeoutMs,
      onBusy: (load, waitedMs) => {
        // One line a minute: the wait can be long.
        if (waitedMs - lastReport >= 60_000 || lastReport === -Infinity) {
          lastReport = waitedMs;
          say(
            `the 1-minute load average is ${load.toFixed(2)}, above ${invocation.maxLoad}: waiting (${Math.round(waitedMs / 1000)} s so far)`,
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof MachineBusyError) {
      say(`${error.message}: nothing was measured`);
      return 2;
    }
    throw error;
  }
  say(
    `the 1-minute load average is ${quiet.hostLoad.toFixed(2)} (limit ${quiet.maxLoad}) after waiting ${Math.round(quiet.waitedMs / 1000)} s: starting ${invocation.command.join(' ')}`,
  );

  const [program, ...args] = invocation.command;
  const child = spawn(program as string, args, {
    stdio: 'inherit',
    env: quietEnvironment(quiet, process.env),
  });
  const forward = (signal: NodeJS.Signals) => (): void => {
    child.kill(signal);
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  return new Promise((resolve) => {
    child.on('error', (error) => {
      say(`could not start ${program}: ${error.message}`);
      resolve(2);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 128 : 2));
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 2;
  },
);
