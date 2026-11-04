// The real effects of the paired gate (src/lab/measure/paired.ts takes them as `PairedDeps`): git and npm as child processes, the file system,
// the clock. Nothing here decides anything. A long command runs in a process group of its own, streams what it says to stderr (the gate's
// stdout is its report) and keeps the end of it for the message of a failure; an abort or a timeout stops the whole group.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { cpuModelOf } from '../src/lab/measure/machine.ts';
import type { ExecOptions, ExecResult, PairedDeps } from '../src/lab/measure/paired.ts';

const TAIL_CHARS = 16_384;
const GRACE_MS = 5_000;

function keepTail(current: string, chunk: string): string {
  const joined = current + chunk;
  return joined.length > TAIL_CHARS ? joined.slice(joined.length - TAIL_CHARS) : joined;
}

function runStreaming(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stdout = keepTail(stdout, chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = keepTail(stderr, chunk.toString('utf8'));
    });

    const stopGroup = (): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, GRACE_MS).unref();
    };
    const onAbort = (): void => stopGroup();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stopGroup();
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            stderr = keepTail(stderr, `\npaired: stopped after ${options.timeoutMs} ms\n`);
            stopGroup();
          }, options.timeoutMs);
    const done = (): void => {
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      done();
      reject(error);
    });
    child.on('close', (code, signal) => {
      done();
      // A command ended by a signal has no exit code: say 128 + the signal number, as a shell does.
      resolve({ code: code ?? (signal === 'SIGKILL' ? 137 : 143), stdout, stderr });
    });
  });
}

function removeAny(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // A symbolic link is removed as itself: what it points to (the head's node_modules) is never touched.
  if (stat.isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true });
}

export function realPairedDeps(log: (line: string) => void): PairedDeps {
  return {
    run: (command, args, options) => runStreaming(command, args, options),
    runSync: (command, args, options = {}) => {
      const result = spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error ? result.error.message : ''),
      };
    },
    exists: (path) => existsSync(path),
    readBytes: (path) => (existsSync(path) ? readFileSync(path) : null),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    mkdir: (path) => void mkdirSync(path, { recursive: true }),
    symlink: (target, path) => symlinkSync(target, path, 'dir'),
    remove: removeAny,
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    tmpdir: () => tmpdir(),
    now: () => Date.now(),
    cpuModel: () => cpuModelOf(cpus()),
    log,
  };
}
