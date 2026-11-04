import { connect } from 'node:net';
import type { SessionDetail, SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import { startServer } from '../../../src/server/index.ts';
import type { RunningServer } from '../../../src/server/index.ts';
import type { MediaStore } from '../../../src/server/media/types.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { createFakeMedia } from './fake-media.ts';
import type { FakeMedia, FakeMediaOptions } from './fake-media.ts';

// What every HTTP test of the service starts from: the real `startServer` on a free port, the in-memory fake store and a manual
// clock, plus a typed way to call it. Nothing here is mocked: requests cross a real socket.

export interface Harness extends RunningServer {
  media: FakeMedia;
  clock: ManualClock;
  /** The lines the service logged (one per request, and every exception it caught). */
  lines: string[];
}

export interface HarnessOptions {
  media?: FakeMediaOptions;
  playerDir?: string;
  clock?: ManualClock;
  /** Wraps the fake before the service gets it (to make a store method throw, for example). */
  decorate?: (media: FakeMedia) => MediaStore;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const media = createFakeMedia(options.media);
  const clock = options.clock ?? new ManualClock();
  const lines: string[] = [];
  const server = await startServer({
    port: 0,
    media: options.decorate ? options.decorate(media) : media,
    clock,
    log: (line) => lines.push(line),
    ...(options.playerDir === undefined ? {} : { playerDir: options.playerDir }),
  });
  return { ...server, media, clock, lines };
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

export interface CallOptions {
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is (malformed JSON, an empty body...). */
  raw?: string;
  headers?: Record<string, string>;
}

export async function call(
  origin: string,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  } else if (options.raw !== undefined) {
    body = options.raw;
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: <T>() => JSON.parse(text) as T };
}

export async function createSession(
  h: Pick<Harness, 'origin'>,
  request: SessionRequest,
): Promise<SessionInfo> {
  const reply = await call(h.origin, 'POST', '/api/sessions', { body: request });
  if (reply.status !== 201) throw new Error(`creating a session failed: ${reply.status} ${reply.text}`);
  return reply.json<SessionInfo>();
}

export async function detailOf(h: Pick<Harness, 'origin'>, id: string): Promise<SessionDetail> {
  const reply = await call(h.origin, 'GET', `/api/sessions/${id}`);
  if (reply.status !== 200) throw new Error(`reading a session failed: ${reply.status} ${reply.text}`);
  return reply.json<SessionDetail>();
}

export interface RawExchange {
  /** Everything received so far. */
  received: string;
  /** Writes more to the socket. */
  write(data: string | Buffer): void;
  /** Resolves with the text received once `pattern` has been seen (rejects after `timeoutMs`). */
  until(pattern: RegExp, timeoutMs?: number): Promise<string>;
  close(): void;
}

/**
 * A raw TCP connection to the service, for what `fetch` cannot say: a request that is still being sent when the answer
 * arrives, a request target of `*`, a body that is declared and never sent.
 */
export async function rawConnect(port: number): Promise<RawExchange> {
  const socket = connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const state = { received: '' };
  const waiters = new Set<() => void>();
  socket.on('data', (data: Buffer) => {
    state.received += data.toString('latin1');
    for (const wake of [...waiters]) wake();
  });
  socket.on('error', () => undefined);
  socket.on('close', () => {
    for (const wake of [...waiters]) wake();
  });
  return {
    get received() {
      return state.received;
    },
    write: (data) => void socket.write(data),
    until: (pattern, timeoutMs = 5000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `${pattern} not seen within ${timeoutMs} ms; received ${JSON.stringify(state.received)}`,
            ),
          );
        }, timeoutMs);
        function check(): void {
          if (!pattern.test(state.received) && !socket.destroyed) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(state.received);
        }
        waiters.add(check);
        check();
      }),
    close: () => void socket.destroy(),
  };
}
