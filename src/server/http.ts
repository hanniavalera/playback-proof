import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_JSON_BODY_BYTES } from './constants.ts';

// The small vocabulary every route of the service speaks: the headers of every response, JSON answers, errors, the CORS preflight and
// the body reader of the control API. No framework (ADR-058): the whole HTTP surface of the lab fits on a few screens.

/** On every response: the browser cache must never hide a throttle, and the player page and the tests are other origins. */
export const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
} as const;

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    ...COMMON_HEADERS,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Max-Age': '600',
  });
  res.end();
}

/** Writes a complete response. HEAD gets the headers (with the Content-Length of the body it would have had) and no body. */
export function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  res.writeHead(status, { ...COMMON_HEADERS, ...headers, 'Content-Length': length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  send(req, res, status, { 'Content-Type': JSON_TYPE, ...headers }, JSON.stringify(value));
}

export function sendText(req: IncomingMessage, res: ServerResponse, status: number, text: string): void {
  send(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, text);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, COMMON_HEADERS);
  res.end();
}

export interface ErrorOptions {
  /** One entry per problem, for a request that was refused for several reasons at once. */
  details?: string[];
  headers?: Record<string, string>;
}

/** Every error of the control API has the same shape: `{ error, details? }`. */
export function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
  options: ErrorOptions = {},
): void {
  const body = options.details === undefined ? { error } : { error, details: options.details };
  sendJson(req, res, status, body, options.headers);
}

/** 405 with the `Allow` header the status requires. OPTIONS is always allowed: every path answers the CORS preflight. */
export function sendMethodNotAllowed(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
): void {
  sendError(req, res, 405, `${req.method ?? 'this method'} is not allowed here`, {
    headers: { Allow: [...allowed, 'OPTIONS'].join(', ') },
  });
}

/** The path and the query of an origin-form request target (`/a/b?c=d`). Anything else (`*`, an absolute URL) is not routable. */
export function splitTarget(target: string | undefined): { pathname: string; query: URLSearchParams } | null {
  if (target === undefined || !target.startsWith('/')) return null;
  const at = target.indexOf('?');
  return {
    pathname: at === -1 ? target : target.slice(0, at),
    query: new URLSearchParams(at === -1 ? '' : target.slice(at + 1)),
  };
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

/**
 * Reads a JSON request body of at most `limit` bytes. A declared length over the limit is refused without reading a byte; an
 * undeclared one (chunked) is counted as it arrives and dropped on the chunk that crosses the limit, so a client cannot make
 * the service buffer more than that. The rest of the body is discarded by Node once the response is written, which keeps the
 * connection usable (closing it with unread data can reset it before the client has read the 413).
 */
export function readJsonBody(req: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<BodyResult> {
  const tooLarge: BodyResult = {
    ok: false,
    status: 413,
    error: `the request body is larger than ${limit} bytes`,
  };
  return new Promise<BodyResult>((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return resolve(tooLarge);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return settle(tooLarge);
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '')
        return settle({ ok: false, status: 400, error: 'the request body is empty: send a JSON document' });
      try {
        settle({ ok: true, value: JSON.parse(text) as unknown });
      } catch (err) {
        settle({ ok: false, status: 400, error: `malformed JSON: ${(err as Error).message}` });
      }
    });
    // A client that hangs up mid-body: nobody is left to answer, but the promise must settle and the error must be handled.
    req.on('error', () => settle({ ok: false, status: 400, error: 'the request was cut off' }));
  });
}
