// Running ffmpeg and ffprobe: spawn with an argument array (never a shell), a timeout, and the stderr tail in the error message.
// PB_FFMPEG / PB_FFPROBE override the binaries (a different build, a wrapper, a Docker shim).

import { spawn } from 'node:child_process';

export const ffmpegBinary = (): string => process.env.PB_FFMPEG || 'ffmpeg';
export const ffprobeBinary = (): string => process.env.PB_FFPROBE || 'ffprobe';

export interface RunOptions {
  /** Kill the process and fail after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Fail when stdout grows past this many bytes. Default 128 MiB. */
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** A failed command: the message names the command line; `stderr` keeps the tool's own words for callers that report them. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

const STDERR_TAIL_BYTES = 8192;

/** A command line for messages: arguments that need it are single-quoted, very long ones are abbreviated. */
export function formatCommand(command: string, args: string[]): string {
  const quote = (a: string): string => {
    const shown = a.length > 160 ? `${a.slice(0, 157)}...` : a;
    return /^[\w@%+=:,./-]+$/.test(shown) ? shown : `'${shown.replace(/'/g, `'\\''`)}'`;
  };
  return [command, ...args].map(quote).join(' ');
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxStdout = options.maxStdoutBytes ?? 128 * 1024 * 1024;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = Buffer.alloc(0);
    let settled = false;
    const label = formatCommand(command, args);
    const finish = (error: Error | null, result?: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result as RunResult);
    };
    const stderrTail = (): string => err.toString('utf8').trim();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new CommandError(`timed out after ${timeoutMs} ms: ${label}\n${stderrTail()}`, stderrTail()));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        child.kill('SIGKILL');
        finish(new CommandError(`output exceeded ${maxStdout} bytes: ${label}`, stderrTail()));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = Buffer.concat([err, chunk]);
      if (err.length > STDERR_TAIL_BYTES) err = err.subarray(err.length - STDERR_TAIL_BYTES);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === 'ENOENT'
          ? ` (is it installed and on PATH? PB_FFMPEG / PB_FFPROBE override the binaries)`
          : '';
      finish(new CommandError(`cannot run '${command}': ${e.message}${hint}`, ''));
    });
    child.on('close', (code, signal) => {
      if (code === 0) finish(null, { stdout: Buffer.concat(out), stderr: stderrTail() });
      else
        finish(
          new CommandError(
            `exited with ${code ?? `signal ${signal}`}: ${label}\n${stderrTail()}`,
            stderrTail(),
          ),
        );
    });
  });
}

/** The version token of the ffmpeg build ("9.0.2", "6.1.1-3ubuntu5"): it is recorded next to every generated stream. */
export async function ffmpegVersion(binary = ffmpegBinary()): Promise<string> {
  const { stdout } = await run(binary, ['-hide_banner', '-version'], { timeoutMs: 30_000 });
  const m = /^ffmpeg version (\S+)/m.exec(stdout.toString('utf8'));
  if (!m || !m[1]) throw new Error(`cannot read the ffmpeg version from '${binary} -version'`);
  return m[1];
}
