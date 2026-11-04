import { constants, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Static serving of the player build (`/player/` -> `dist/player`), written to be safe by construction (ADR-055 to ADR-057).
// A request path is never "cleaned": it is decoded once, resolved against the real root, resolved again through the file
// system (symlinks included), and served only if the result is still strictly inside the real root. Everything else is a
// 400 or a 404, and an escape attempt answers exactly like a file that is not there.

export interface StaticResult {
  /** 301 is part of the type for callers that map redirects; this module answers 308. */
  status: 200 | 301 | 308 | 400 | 404 | 405;
  /** The real path that was sent; set only for 200. */
  file?: string;
}

const NO_STORE = {
  // The lab must never be fooled by a cached player build: every response, errors included, is uncacheable.
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
} as const;

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/** Longest request path (before decoding) that is looked at. The real files are a few dozen characters long. */
const MAX_PATH_LENGTH = 2048;

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream';
}

type Resolution =
  | { kind: 'file'; file: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'bad' }
  | { kind: 'missing' };

const BAD: Resolution = { kind: 'bad' };
const MISSING: Resolution = { kind: 'missing' };

/** `/player` and `/player/` both become `/player/`; anything that is not a plain absolute path is refused (null). */
function normaliseMount(mountPath: string): string | null {
  if (!mountPath.startsWith('/') || /[?#%\\]/.test(mountPath) || hasControlCharacter(mountPath)) return null;
  const segments = mountPath.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why the decoded path is refused outright: NUL and the other control characters, and the Windows separator. */
function isUnacceptable(decoded: string): boolean {
  return hasControlCharacter(decoded) || decoded.includes('\\');
}

// Any failure of these two (ENOENT, EACCES, ELOOP, ENAMETOOLONG, ENOTDIR...) means "there is nothing to serve here" and is
// deliberately not told apart from not found: the answer must not reveal what exists.
function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * The path below `root` (no leading separator, '' for the root itself), or null when `candidate` is not inside it.
 * The separator is part of the prefix: `/srv/player-evil` starts with `/srv/player` but is not inside it.
 */
function below(root: string, candidate: string): string | null {
  if (candidate === root) return '';
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

/** Dotfiles and dot-directories (`.env`, `.git/config`) are never served, whatever they are reached through. */
function hasDotSegment(relative: string): boolean {
  return relative.split(sep).some((segment) => segment.startsWith('.'));
}

interface Checked {
  /** The path as requested, normalised, below the root. */
  asked: string;
  real: string;
  stat: Stats;
}

/**
 * The one place that decides whether a path may be served: lexically inside the root, then (after symlinks are resolved)
 * still inside the root, and not a dotfile in either form. Only a regular file or a directory can be returned.
 */
function check(rootReal: string, wanted: string): Checked | null {
  const asked = below(rootReal, wanted);
  if (asked === null || hasDotSegment(asked)) return null;
  const real = realPath(wanted);
  if (real === null) return null;
  const actual = below(rootReal, real);
  if (actual === null || hasDotSegment(actual)) return null;
  const stat = statOf(real);
  if (stat === null || !(stat.isFile() || stat.isDirectory())) return null;
  return { asked, real, stat };
}

function redirectTo(mount: string, relative: string, query: string): Resolution {
  const path = relative === '' ? '' : `${relative.split(sep).map(encodeURIComponent).join('/')}/`;
  return { kind: 'redirect', location: `${mount}${path}${query}` };
}

function resolveRequest(root: string, mountPath: string, urlPath: string): Resolution {
  const mount = normaliseMount(mountPath);
  if (mount === null) return MISSING;

  const queryStart = urlPath.indexOf('?');
  const path = queryStart === -1 ? urlPath : urlPath.slice(0, queryStart);
  const query = queryStart === -1 ? '' : urlPath.slice(queryStart);
  if (path.length > MAX_PATH_LENGTH) return BAD;
  // The query is copied into a Location header; a control character there would be header injection.
  if (hasControlCharacter(query)) return BAD;

  // Relative asset URLs in the page need the slash: /player -> /player/.
  if (mount !== '/' && path === mount.slice(0, -1)) return redirectTo(mount, '', query);
  if (!path.startsWith(mount)) return MISSING;

  // Decoded exactly once, here. What the decoding produces is a file name and is never decoded again.
  let rest: string;
  try {
    rest = decodeURIComponent(path.slice(mount.length));
  } catch {
    return BAD;
  }
  if (isUnacceptable(rest)) return BAD;

  const rootReal = realPath(root);
  if (rootReal === null) return MISSING;
  // resolve() would let an absolute `rest` replace the root altogether; stripping the slashes makes that impossible.
  const found = check(rootReal, resolvePath(rootReal, rest.replace(/^\/+/, '')));
  if (found === null) return MISSING;

  const slashAsked = path.endsWith('/');
  if (found.stat.isFile()) {
    return slashAsked || rest.endsWith('/') ? MISSING : { kind: 'file', file: found.real };
  }
  // A directory is its index.html (checked like any other path, so an index that is a symlink out of the root is a 404),
  // never a listing.
  const index = check(rootReal, join(found.real, 'index.html'));
  if (index === null || !index.stat.isFile()) return MISSING;
  return slashAsked ? { kind: 'file', file: index.real } : redirectTo(mount, found.asked, query);
}

/**
 * Maps a URL path under the mount (`/player/...`, a query string is ignored) to a real file under `root`, or null.
 * Never returns a path outside the real `root`, and never a dotfile. Null covers every refusal; use `serveStatic` to tell a
 * 400 from a 404 from the redirect.
 */
export function resolveStaticFile(root: string, mountPath: string, urlPath: string): string | null {
  try {
    const resolved = resolveRequest(root, mountPath, urlPath);
    return resolved.kind === 'file' ? resolved.file : null;
  } catch {
    return null;
  }
}

const REASONS = {
  308: 'Permanent Redirect',
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
} as const;

function reply(
  res: ServerResponse,
  status: keyof typeof REASONS,
  head: boolean,
  extra: OutgoingHttpHeaders = {},
): StaticResult {
  const text = status === 308 ? '' : `${REASONS[status]}\n`;
  res.writeHead(status, {
    ...NO_STORE,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(head ? undefined : text);
  return { status };
}

const ignore = (): void => undefined;

async function sendFile(res: ServerResponse, file: string, head: boolean): Promise<StaticResult> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return reply(res, 404, head);
  }
  let size: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    size = info.size;
  } catch {
    await handle.close().catch(ignore);
    return reply(res, 404, head);
  }
  res.writeHead(200, {
    ...NO_STORE,
    'Content-Type': contentTypeFor(file),
    'Content-Length': size,
  });
  if (head) {
    await handle.close().catch(ignore);
    res.end();
  } else {
    // The stream owns the handle from here. pipeline destroys it, and so closes the file, when the client goes away.
    await pipeline(handle.createReadStream(), res).catch(ignore);
  }
  return { status: 200, file };
}

/** Writes the whole response for GET and HEAD under the mount. Never throws: what cannot be served is answered or dropped. */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  mountPath: string,
): Promise<StaticResult> {
  const head = req.method === 'HEAD';
  try {
    if (req.method !== 'GET' && !head) return reply(res, 405, head, { Allow: 'GET, HEAD' });
    const resolved = resolveRequest(root, mountPath, req.url ?? '');
    switch (resolved.kind) {
      case 'file':
        return await sendFile(res, resolved.file, head);
      case 'redirect':
        return reply(res, 308, head, { Location: resolved.location });
      case 'bad':
        return reply(res, 400, head);
      case 'missing':
        return reply(res, 404, head);
    }
  } catch {
    // Nothing unforeseen is allowed to take the lab's server down: refuse, or drop the connection if it is too late to.
    if (res.headersSent) {
      res.destroy();
      return { status: 404 };
    }
    try {
      return reply(res, 404, head);
    } catch {
      res.destroy();
      return { status: 404 };
    }
  }
}
