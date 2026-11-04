import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthInfo } from '../shared/api.ts';
import { STREAM_IDS } from '../shared/streams.ts';
import type { StreamId } from '../shared/streams.ts';
import { parseServicePath } from '../shared/urls.ts';
import { forgetBuckets } from './buckets.ts';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import {
  readJsonBody,
  sendError,
  sendJson,
  sendMethodNotAllowed,
  sendNoContent,
  sendPreflight,
  sendText,
  splitTarget,
} from './http.ts';
import type { MediaStore } from './media/types.ts';
import { serveMedia } from './pipeline.ts';
import type { RequestSummary } from './pipeline.ts';
import { SessionLimitError, SessionStore, parseSessionRequest } from './sessions.ts';
import type { Session } from './sessions.ts';
import { resolveStaticFile, serveStatic } from './static.ts';

// The HTTP application of the test data service: the router, the JSON control API (docs/CONTRACTS.md section 4) and the dispatch to the
// media pipeline and to the static player. It owns the sessions; it knows nothing about sockets beyond a request and a response, so
// `startServer` (index.ts) is the only place that listens.

export interface AppOptions {
  media: MediaStore;
  /** Where the built player is. Default `<repo>/dist/player`. */
  playerDir?: string;
  /** The clock of the whole service: session expiry, the live clock, the rule clocks, /api/time. Default the system clock. */
  clock?: Clock;
  /** One line per request, and every exception that was caught. `true` writes to stderr; a function receives the lines. Default off. */
  log?: boolean | ((line: string) => void);
}

export interface App {
  /** Handles one request. Never rejects: whatever goes wrong is answered (500) or the connection is dropped. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Logs an exception the app did not cause (when logging is on). */
  report(what: string, err: unknown): void;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const INDEX_TEXT = `Playback Proof: a test data service for a web video player.

Deterministic VOD and simulated live streams with fault injection (throttle, latency, status, stall, abort,
live-stall, manifest-stale), per-session isolation and a request log.

  /health     service status
  /player/    the player page
  /api/...    control API (docs/CONTRACTS.md, section 4)
  /s/...      the media of a session
`;

function readVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const shorten = (text: string, max = 64): string => (text.length > max ? `${text.slice(0, max)}...` : text);

const ignore = (): void => undefined;

const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/(faults|log)(?:\/([^/]+))?)?$/;

export function defaultPlayerDir(): string {
  return join(REPO_ROOT, 'dist', 'player');
}

export function createApp(options: AppOptions): App {
  const { media } = options;
  const clock = options.clock ?? systemClock;
  const playerDir = options.playerDir ?? defaultPlayerDir();
  const sessions = new SessionStore({ clock });
  const startedAtMs = clock.now();
  const version = readVersion();
  const sink =
    typeof options.log === 'function'
      ? options.log
      : options.log === true
        ? (line: string): void => void process.stderr.write(`${line}\n`)
        : undefined;

  function report(what: string, err: unknown): void {
    sink?.(
      `${new Date().toISOString()} ERROR ${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }

  function health(): HealthInfo {
    const streams = {} as Record<StreamId, 'ready' | 'missing'>;
    for (const id of STREAM_IDS) streams[id] = media.has(id) ? 'ready' : 'missing';
    return {
      status: 'ok',
      version,
      ffmpeg: media.ffmpegVersion(),
      streams,
      player: resolveStaticFile(playerDir, '/player/', '/player/') === null ? 'missing' : 'built',
      uptimeSec: Math.round(clock.now() - startedAtMs) / 1000,
    };
  }

  /** Looks the session up and answers 404 itself when there is none. */
  function sessionOr404(req: IncomingMessage, res: ServerResponse, id: string): Session | undefined {
    const session = sessions.get(id);
    if (!session) sendError(req, res, 404, `session ${shorten(id)} does not exist or has expired`);
    return session;
  }

  async function createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(req, res, body.status, body.error);
    const parsed = parseSessionRequest(body.value, media.streams());
    if (!parsed.ok) {
      if (parsed.status === 404) return sendError(req, res, 404, parsed.errors.join('; '));
      return sendError(req, res, 400, 'invalid session request', { details: parsed.errors });
    }
    let session: Session;
    try {
      session = sessions.create(parsed.value);
    } catch (err) {
      if (err instanceof SessionLimitError) return sendError(req, res, 503, err.message);
      throw err;
    }
    sendJson(req, res, 201, session.info(clock.now()), { Location: `/api/sessions/${session.id}` });
  }

  async function writeFaults(
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
    replace: boolean,
  ): Promise<void> {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(req, res, body.status, body.error);
    if (!isRecord(body.value))
      return sendError(req, res, 400, 'the body must be an object: { "rules": [...] }');
    const unknown = Object.keys(body.value).filter((key) => key !== 'rules');
    if (unknown.length > 0)
      return sendError(req, res, 400, 'invalid fault request', {
        details: unknown.map((key) => `${key} is not a known field: the body is { "rules": [...] }`),
      });
    const result = replace ? session.faults.replace(body.value.rules) : session.faults.add(body.value.rules);
    if (!result.ok) return sendError(req, res, 400, 'invalid fault rules', { details: result.errors });
    // Rules that are replaced start on a fresh link; responses already being written keep the one they were given.
    if (replace) forgetBuckets(session);
    sendJson(req, res, replace ? 200 : 201, result.rules);
  }

  function readLog(
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
    query: URLSearchParams,
  ): void {
    const values = query.getAll('since');
    const raw = values[0];
    const since = raw === undefined ? 0 : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (values.length > 1 || !Number.isSafeInteger(since))
      return sendError(req, res, 400, 'invalid query', {
        details: ['since must be an integer >= 0 (the seq of the last entry already seen)'],
      });
    sendJson(req, res, 200, session.log.since(since));
  }

  async function routeSession(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    id: string,
    part: string | undefined,
    ruleId: string | undefined,
  ): Promise<void> {
    const method = req.method ?? '';
    if (part === 'log' && ruleId !== undefined) return sendError(req, res, 404, 'not found');
    const allowed =
      part === undefined
        ? ['GET', 'HEAD', 'DELETE']
        : part === 'log'
          ? ['GET', 'HEAD']
          : ruleId === undefined
            ? ['POST', 'PUT']
            : ['DELETE'];
    if (!allowed.includes(method)) return sendMethodNotAllowed(req, res, allowed);
    const session = sessionOr404(req, res, id);
    if (!session) return;

    if (part === undefined) {
      if (method === 'DELETE') {
        sessions.delete(id);
        return sendNoContent(res);
      }
      return sendJson(req, res, 200, session.detail(clock.now()));
    }
    if (part === 'log') return readLog(req, res, session, query);
    if (ruleId === undefined) return writeFaults(req, res, session, method === 'PUT');
    if (!session.faults.remove(ruleId))
      return sendError(req, res, 404, `session ${session.id} has no fault rule ${shorten(ruleId)}`);
    forgetBuckets(session, ruleId);
    sendNoContent(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<RequestSummary | void> {
    // Before any routing, and for every path: serveStatic would answer an OPTIONS with 405.
    if (req.method === 'OPTIONS') return sendPreflight(res);
    const target = splitTarget(req.url);
    if (!target) return sendError(req, res, 400, 'the request target must be a path');
    const { pathname, query } = target;

    if (pathname === '/player' || pathname.startsWith('/player/')) {
      await serveStatic(req, res, playerDir, '/player/');
      return;
    }
    if (pathname.startsWith('/s/')) {
      const parsed = parseServicePath(pathname);
      if (!parsed) return sendError(req, res, 404, 'not found');
      const session = sessionOr404(req, res, parsed.sessionId);
      if (!session) return;
      return serveMedia({ media, clock, report }, session, parsed, pathname, req, res);
    }

    const readOnly = ['GET', 'HEAD'];
    const method = req.method ?? '';
    const session = SESSION_ROUTE.exec(pathname);
    if (session) {
      const [, id, part, ruleId] = session as unknown as [
        string,
        string,
        string | undefined,
        string | undefined,
      ];
      return routeSession(req, res, query, id, part, ruleId);
    }
    switch (pathname) {
      case '/':
        if (!readOnly.includes(method)) return sendMethodNotAllowed(req, res, readOnly);
        return sendText(req, res, 200, INDEX_TEXT);
      case '/health':
        if (!readOnly.includes(method)) return sendMethodNotAllowed(req, res, readOnly);
        return sendJson(req, res, 200, health());
      case '/api/streams':
        if (!readOnly.includes(method)) return sendMethodNotAllowed(req, res, readOnly);
        return sendJson(req, res, 200, { streams: media.streams() });
      case '/api/time':
        if (!readOnly.includes(method)) return sendMethodNotAllowed(req, res, readOnly);
        return sendText(req, res, 200, new Date(clock.now()).toISOString());
      case '/api/sessions':
        if (method !== 'POST') return sendMethodNotAllowed(req, res, ['POST']);
        return createSession(req, res);
      default:
        return sendError(req, res, 404, 'not found');
    }
  }

  return {
    report,
    async handle(req, res) {
      const started = performance.now();
      // A response whose client has gone must never become an uncaught 'error' event.
      res.on('error', ignore);
      let summary: RequestSummary | undefined;
      try {
        const result = await route(req, res);
        if (result) summary = result;
      } catch (err) {
        report(`${req.method} ${shorten(req.url ?? '', 200)}`, err);
        if (!res.headersSent && !res.destroyed) sendError(req, res, 500, 'internal error');
        else res.destroy();
      } finally {
        if (sink) {
          const status = summary ? summary.status : res.headersSent ? res.statusCode : 0;
          const ms = (performance.now() - started).toFixed(1);
          const extra = summary
            ? ` ${summary.bytes}B${summary.faults.length > 0 ? ` faults=${summary.faults.join(',')}` : ''}${summary.aborted ? ' aborted' : ''}`
            : '';
          sink(
            `${new Date().toISOString()} ${req.method} ${shorten(req.url ?? '', 200)} ${status} ${ms}ms${extra}`,
          );
        }
      }
    },
  };
}
