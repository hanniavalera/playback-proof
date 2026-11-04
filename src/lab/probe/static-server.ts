import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

// The probe's whole origin: a blank page at `/` (so the probe code runs on a real http origin) and the media files under
// `/media/`. Range requests are served properly because `<video src>` needs them (WebKit refuses to play without).

export interface StaticServer {
  /** `http://127.0.0.1:<port>`; the port is chosen by the OS. */
  origin: string;
  close(): Promise<void>;
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>codec probe</title><body></body>';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm' };

export type ByteRange = { start: number; end: number };

/**
 * A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range of a resource of `size` bytes. Returns null when there is no usable
 * range (serve the whole body: RFC 9110 allows ignoring a Range header) and 'unsatisfiable' when it lies outside the body.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const length = Number(rawEnd);
    return length === 0 ? 'unsatisfiable' : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

export interface StaticServerOptions {
  /** Content type per file name; default by extension. */
  contentTypes?: Readonly<Record<string, string>>;
}

export async function startStaticServer(
  mediaDir: string,
  options: StaticServerOptions = {},
): Promise<StaticServer> {
  const noStore = { 'cache-control': 'no-store' };

  async function handle(
    method: string,
    rawUrl: string,
    rangeHeader: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { ...noStore, allow: 'GET, HEAD' }).end();
      return;
    }
    const head = method === 'HEAD';
    const path = new URL(rawUrl, 'http://probe.invalid').pathname;
    if (path === '/') {
      response.writeHead(200, { ...noStore, 'content-type': 'text/html; charset=utf-8' });
      response.end(head ? undefined : PAGE);
      return;
    }
    const name = path.startsWith('/media/') ? decodeURIComponent(path.slice('/media/'.length)) : '';
    if (!SAFE_NAME.test(name) || name.includes('..')) {
      response.writeHead(404, noStore).end();
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(join(mediaDir, name));
    } catch {
      response.writeHead(404, noStore).end();
      return;
    }
    const contentType =
      options.contentTypes?.[name] ?? DEFAULT_TYPES[extname(name)] ?? 'application/octet-stream';
    const base = { ...noStore, 'content-type': contentType, 'accept-ranges': 'bytes' };
    const range = parseRange(rangeHeader, body.byteLength);
    if (range === 'unsatisfiable') {
      response.writeHead(416, { ...base, 'content-range': `bytes */${body.byteLength}` }).end();
    } else if (range) {
      const slice = body.subarray(range.start, range.end + 1);
      response.writeHead(206, {
        ...base,
        'content-range': `bytes ${range.start}-${range.end}/${body.byteLength}`,
        'content-length': slice.byteLength,
      });
      response.end(head ? undefined : slice);
    } else {
      response.writeHead(200, { ...base, 'content-length': body.byteLength });
      response.end(head ? undefined : body);
    }
  }

  const server = createServer((request, response) => {
    handle(request.method ?? 'GET', request.url ?? '/', request.headers.range, response).catch(() => {
      // A malformed URL (bad percent-encoding) or a write to a closed socket: answer if we still can, never crash the run.
      if (!response.headersSent) response.writeHead(400, noStore);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the probe server has no TCP address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
