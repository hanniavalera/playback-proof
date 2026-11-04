import { createServer, request } from 'node:http';
import type { Agent, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deliver } from '../../../src/server/deliver.ts';
import type { DeliverHooks, DeliverInput, DeliverOutcome } from '../../../src/server/deliver.ts';

// Real localhost HTTP for the delivery tests: a server whose handler is `deliver()`, and a client that timestamps every read,
// so the tests measure what a client sees (the first byte, the pauses, the goodput) and not what the server believes it did.

export interface TestServer {
  port: number;
  server: Server;
  /** The outcome of every `deliver()` call so far (await it to know they have all settled). */
  settled(): Promise<DeliverOutcome[]>;
  /** The outcome of the delivery that answered this request URL. */
  outcomeOf(url: string): Promise<DeliverOutcome> | undefined;
  /** Number of requests the handler has received. */
  requests(): number;
  close(): Promise<void>;
}

export async function deliveryServer(
  make: (req: IncomingMessage, res: ServerResponse) => { input: DeliverInput; hooks?: DeliverHooks },
): Promise<TestServer> {
  const pending: Promise<DeliverOutcome>[] = [];
  const byUrl = new Map<string, Promise<DeliverOutcome>>();
  const server = createServer((req, res) => {
    const { input, hooks } = make(req, res);
    const outcome = deliver(req, res, input, hooks);
    pending.push(outcome);
    byUrl.set(req.url ?? '', outcome);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    settled: () => Promise.all(pending),
    outcomeOf: (url) => byUrl.get(url),
    requests: () => pending.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface Chunk {
  /** `performance.now()` when the client read it. */
  t: number;
  bytes: number;
}

export interface Download {
  status: number;
  headers: IncomingHttpHeaders;
  /** `performance.now()` right before the request was issued, and when the head arrived. */
  startedAt: number;
  headAt: number;
  chunks: Chunk[];
  bytes: number;
  /** The whole declared body arrived. */
  complete: boolean;
  /** Set when the connection failed (ECONNRESET and friends) before or during the response. */
  error?: string;
  body?: Buffer;
}

export function download(
  port: number,
  path: string,
  options: { method?: string; keepBody?: boolean; agent?: Agent } = {},
): Promise<Download> {
  return new Promise<Download>((resolve) => {
    const result: Download = {
      status: 0,
      headers: {},
      startedAt: performance.now(),
      headAt: 0,
      chunks: [],
      bytes: 0,
      complete: false,
    };
    const parts: Buffer[] = [];
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (options.keepBody) result.body = Buffer.concat(parts);
      resolve(result);
    };
    const req = request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: options.agent ?? false },
      (res: IncomingMessage) => {
        result.status = res.statusCode ?? 0;
        result.headers = res.headers;
        result.headAt = performance.now();
        res.on('data', (data: Buffer) => {
          result.chunks.push({ t: performance.now(), bytes: data.length });
          result.bytes += data.length;
          if (options.keepBody) parts.push(data);
        });
        res.on('error', (err: NodeJS.ErrnoException) => {
          result.error = err.code ?? err.message;
        });
        res.on('close', () => {
          result.complete = res.complete;
          finish();
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      result.error = err.code ?? err.message;
      finish();
    });
    req.end();
  });
}

/**
 * Goodput as a client sees it, from the first body read to the last. `steady` leaves out what the first read carried (the burst
 * allowance that goes out at once), `naive` counts everything: the contract is within +-10 % of the rate for both.
 */
export function goodput(chunks: Chunk[]): { steadyKbps: number; naiveKbps: number; spanMs: number } {
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (!first || !last || last.t <= first.t) throw new Error('not enough reads to measure a rate');
  const total = chunks.reduce((n, c) => n + c.bytes, 0);
  const spanMs = last.t - first.t;
  // bytes * 8 / ms is kilobits per second
  return { steadyKbps: ((total - first.bytes) * 8) / spanMs, naiveKbps: (total * 8) / spanMs, spanMs };
}

export function gapsMs(chunks: Chunk[]): number[] {
  return chunks.slice(1).map((c, i) => c.t - (chunks[i]?.t ?? c.t));
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** A patterned body, so a test can check content and not only length. */
export function patterned(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + (i >> 8)) & 0xff;
  return buf;
}

/** Polls until `condition` holds (for state a test cannot subscribe to, such as how many consumers a bucket has). */
export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`condition not reached within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Small deterministic PRNG (mulberry32): the "random" disconnect points of a test are the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
