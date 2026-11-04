import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import net from 'node:net';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentTypeFor, resolveStaticFile, serveStatic } from '../../../src/server/static.ts';
import type { StaticResult } from '../../../src/server/static.ts';
import { makeScratch } from '../support/scratch.ts';

// Real files in a scratch directory, a real HTTP server on port 0, and raw sockets for everything where fetch or
// http.request would tidy the URL (`..`, `%2f`, backslashes) before the server ever saw it.
//
// Layout (the secrets are outside the root, where a traversal would land):
//   <scratch>/secret.txt            the file no request may ever return
//   <scratch>/outside/loot.txt      a directory outside the root
//   <scratch>/player-evil/loot.txt  a sibling whose name starts with the root's name
//   <scratch>/player/               the root, with symlinks out of it and into it
//   <scratch>/player-link           a symlink to the root (a second mount, /linked/)

const SECRET = `SECRET-${randomUUID()}`;
const LOOT = `LOOT-${randomUUID()}`;
const DOTFILE = `DOTFILE-${randomUUID()}`;
const LITERAL = `LITERAL-${randomUUID()}`;
/** Nothing in a response to a refused request may contain any of these (`root:` is the first field of /etc/passwd). */
const FORBIDDEN = [SECRET, LOOT, DOTFILE, 'root:'];
const scratch = makeScratch('unit-static-');
const root = join(scratch, 'player');
const linkedRoot = join(scratch, 'player-link');
const MOUNT = '/player/';
const LINKED = '/linked/';

const files: Record<string, string> = {
  'index.html': '<!doctype html><title>player</title><script src="app.js"></script>',
  'app.js': 'console.log("player");\n',
  'app.js.map': '{"version":3,"sources":["app.ts"],"mappings":""}',
  'style.css': 'body{margin:0}',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'data.json': '{"ok":true}',
  'notes.txt': 'plain text',
  'my file.txt': 'a name with a space',
  'h\u00e9llo.txt': 'a name with a non-ASCII letter',
  'assets/deep/nested.mjs': 'export const nested = 1;\n',
  'sub/index.html': '<!doctype html><title>sub</title>',
  'my dir/index.html': '<!doctype html><title>spaced</title>',
  '100%/index.html': '<!doctype html><title>percent</title>',
  // A directory literally named "%2e%2e": the proof that a path is decoded once (see 'decodes exactly once').
  '%2e%2e/inside.txt': LITERAL,
  // Refused whatever they are reached through.
  '.env': DOTFILE,
  '.git/config': DOTFILE,
  'assets/.hidden': DOTFILE,
  'sub/.private': DOTFILE,
  'swap.txt': 'a regular file, for now',
};

const binaries: Record<string, Buffer> = {
  'codec.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  'pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  'favicon.ico': Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
  'blob.bin': Buffer.from([0xff, 0xfe, 0x00, 0x01]),
  'empty.txt': Buffer.alloc(0),
};

const BIG_BYTES = 16 * 1024 * 1024;
const big = randomBytes(BIG_BYTES);

/** Symlinks created in the root: [name, target]. A relative target is relative to the directory the link is in. */
const links: Array<[string, string]> = [
  ['link-to-secret.txt', '../secret.txt'],
  ['link-abs.txt', join(scratch, 'secret.txt')],
  ['link-to-outside', '../outside'],
  ['link-to-parent', '..'],
  ['link-to-sibling', '../player-evil'],
  ['link-to-etc', '/etc'],
  ['link-to-dotfile.txt', '.env'],
  ['link-loop-a', 'link-loop-b'],
  ['link-loop-b', 'link-loop-a'],
  ['link-broken', 'does-not-exist'],
  // Symlinks that stay inside the root are legitimate (a build may alias `latest` to a hashed name).
  ['link-ok.txt', 'app.js'],
  ['link-ok-dir', 'sub'],
];

let server: Server;
let port: number;
/** What serveStatic answered, by request target: the proof that the module (not the HTTP parser) made a decision. */
const answers = new Map<string, Promise<StaticResult>>();

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * One request with the request target exactly as given, over a plain socket; resolves when the server closes the connection.
 * The timeout is a safety net that turns a hung response into a failed assertion (status 0), never a measurement.
 */
function raw(
  target: string,
  method = 'GET',
  headers: string[] = [],
  atPort: number = port,
): Promise<RawResponse> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: atPort });
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('connect', () => {
      const lines = [`${method} ${target} HTTP/1.1`, 'Host: lab', 'Connection: close', ...headers];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    // A reset after the response is not a failure of the test; what was received is what is judged.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      const head = (end === -1 ? all : all.subarray(0, end)).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1] ?? 0),
        headers,
        body: end === -1 ? Buffer.alloc(0) : all.subarray(end + 4),
      });
    });
  });
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

let connections = 0;
const quietWaiters: Array<() => void> = [];

/** Counts the open connections of a server, so that a test can wait until every one of them has closed. */
function track(target: Server): void {
  target.on('connection', (socket) => {
    connections++;
    socket.on('close', () => {
      connections--;
      if (connections === 0) for (const waiter of quietWaiters.splice(0)) waiter();
    });
  });
}

/** Resolves when no connection is open and every serveStatic call has settled: nothing of the requests so far is in flight. */
async function quiet(): Promise<void> {
  if (connections > 0) await new Promise<void>((resolve) => quietWaiters.push(resolve));
  await Promise.all(answers.values());
}

beforeAll(async () => {
  write(join(scratch, 'secret.txt'), SECRET);
  write(join(scratch, 'outside', 'loot.txt'), LOOT);
  write(join(scratch, 'player-evil', 'loot.txt'), LOOT);
  for (const [name, content] of Object.entries(files)) write(join(root, name), content);
  for (const [name, content] of Object.entries(binaries)) write(join(root, name), content);
  write(join(root, 'big.bin'), big);
  mkdirSync(join(root, 'emptydir'));
  write(join(scratch, 'index-target.html'), SECRET);
  mkdirSync(join(root, 'evil-index'));
  symlinkSync('../../index-target.html', join(root, 'evil-index', 'index.html'));
  for (const [name, target] of links) symlinkSync(target, join(root, name));
  symlinkSync(root, linkedRoot);

  server = createServer((req, res) => {
    const linked = req.url?.startsWith(LINKED) ?? false;
    answers.set(req.url ?? '', serveStatic(req, res, linked ? linkedRoot : root, linked ? LINKED : MOUNT));
  });
  track(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

describe('normal serving', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['assets/deep/nested.mjs', 'text/javascript; charset=utf-8'],
    ['app.js.map', 'application/json'],
    ['style.css', 'text/css; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain; charset=utf-8'],
  ])('serves %s as %s with its exact length', async (name, type) => {
    const res = await fetch(url(`${MOUNT}${name}`));
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(files[name] ?? '')));
    expect(body.toString()).toBe(files[name]);
  });

  it.each([
    ['codec.wasm', 'application/wasm'],
    ['pic.png', 'image/png'],
    ['favicon.ico', 'image/x-icon'],
    ['blob.bin', 'application/octet-stream'],
    ['empty.txt', 'text/plain; charset=utf-8'],
  ])('serves %s as %s, byte for byte', async (name, type) => {
    const res = await fetch(url(`${MOUNT}${name}`));
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('content-length')).toBe(String(binaries[name]?.length));
    expect(body).toEqual(binaries[name]);
  });

  it.each([
    ['the mount itself', MOUNT, 'index.html'],
    [
      'the mount with the page parameters',
      `${MOUNT}?manifest=%2Fs%2Fa%2Fdash%2Fmanifest.mpd&config=A`,
      'index.html',
    ],
    ['a directory', `${MOUNT}sub/`, 'sub/index.html'],
    ['a directory with a double slash', `${MOUNT}sub//`, 'sub/index.html'],
    ['a file with a query that looks like a path', `${MOUNT}app.js?/../../secret.txt`, 'app.js'],
  ])('answers %s with the right file', async (_label, path, name) => {
    const res = await fetch(url(path));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(files[name]);
  });

  it.each([
    ['a space', 'my%20file.txt', 'my file.txt'],
    ['a UTF-8 letter', 'h%C3%A9llo.txt', 'h\u00e9llo.txt'],
    ['lower-case hex', 'h%c3%a9llo.txt', 'h\u00e9llo.txt'],
  ])('decodes %s in a name', async (_label, encoded, name) => {
    const res = await fetch(url(`${MOUNT}${encoded}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(files[name]);
  });

  it('decodes exactly once: a file named like an escape is reached only through its escaped name', async () => {
    // The directory "%2e%2e" exists. Decoded once, %252e%252e is that name; decoded twice it would be ".." (outside the root).
    const literal = await raw(`${MOUNT}%252e%252e/inside.txt`);
    expect(literal.status).toBe(200);
    expect(literal.body.toString()).toBe(LITERAL);
    // Decoded once this is "../inside.txt": outside the root, and the directory of that name is not reachable this way.
    expect((await raw(`${MOUNT}%2e%2e/inside.txt`)).status).toBe(404);
  });

  it.each([
    `${MOUNT}./app.js`,
    `${MOUNT}assets/../app.js`,
    `${MOUNT}assets/deep/../../app.js`,
    `${MOUNT}%2e/app.js`,
    `${MOUNT}assets%2f..%2fapp.js`,
  ])('resolves the dot segments of %s that stay inside the root and serves the file', async (path) => {
    const res = await raw(path);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['app.js']);
  });

  it('streams a large file byte for byte', async () => {
    const res = await fetch(url(`${MOUNT}big.bin`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(BIG_BYTES));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(BIG_BYTES);
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      createHash('sha256').update(big).digest('hex'),
    );
  });

  it.each([
    ['a file', 'GET', `${MOUNT}app.js`, 200],
    ['the index', 'GET', MOUNT, 200],
    ['a HEAD', 'HEAD', `${MOUNT}app.js`, 200],
    ['a missing file', 'GET', `${MOUNT}nope.js`, 404],
    ['a malformed path', 'GET', `${MOUNT}%zz`, 400],
    ['a refused method', 'POST', `${MOUNT}app.js`, 405],
    ['the redirect', 'GET', '/player', 308],
  ])('%s carries the lab headers: no-store, CORS, nosniff', async (_label, method, path, status) => {
    const res = await raw(path, method);
    expect(res.status).toBe(status);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([`${MOUNT}app.js`, MOUNT, `${MOUNT}empty.txt`, `${MOUNT}missing.js`, `${MOUNT}%zz`, '/player'])(
    'HEAD %s answers like GET, without a body',
    async (path) => {
      const get = await raw(path);
      const head = await raw(path, 'HEAD');
      expect(head.status).toBe(get.status);
      expect(head.body.length).toBe(0);
      for (const name of ['content-length', 'content-type', 'location', 'cache-control']) {
        expect(head.headers[name], name).toBe(get.headers[name]);
      }
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    '%s is a 405 that names the allowed methods',
    async (method) => {
      const res = await raw(`${MOUNT}app.js`, method, ['Content-Length: 0']);
      expect(res.status).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD');
      expect(res.body.toString()).toBe('Method Not Allowed\n');
    },
  );

  it('answers a refused method before it looks at the path', async () => {
    const res = await raw(`${MOUNT}../secret.txt`, 'POST', ['Content-Length: 0']);
    expect(res.status).toBe(405);
    expect(res.body.toString('latin1')).not.toContain(SECRET);
  });

  it.each([
    ['the mount without its slash', '/player', '/player/'],
    [
      'the mount without its slash, with the page parameters',
      '/player?manifest=%2Fs%2Fa%2Fdash%2Fmanifest.mpd&config=B&autoplay=1',
      '/player/?manifest=%2Fs%2Fa%2Fdash%2Fmanifest.mpd&config=B&autoplay=1',
    ],
    ['a directory without its slash', `${MOUNT}sub`, `${MOUNT}sub/`],
    ['a directory without its slash, with a query', `${MOUNT}sub?x=1`, `${MOUNT}sub/?x=1`],
    ['a directory behind a double slash', `${MOUNT}/sub`, `${MOUNT}sub/`],
    ['a directory behind a dot segment', `${MOUNT}assets/../sub`, `${MOUNT}sub/`],
    ['a directory with a space', `${MOUNT}my%20dir`, `${MOUNT}my%20dir/`],
    ['a directory with a percent sign', `${MOUNT}100%25`, `${MOUNT}100%25/`],
    ['a symlink to a directory inside the root', `${MOUNT}link-ok-dir`, `${MOUNT}link-ok-dir/`],
    ['the mount as a dot segment', `${MOUNT}.`, MOUNT],
  ])('redirects %s with a 308, so that relative URLs in the page resolve', async (_label, from, to) => {
    const res = await raw(from);
    expect(res.status).toBe(308);
    // The Location is built from the decoded, normalised path, re-encoded: never copied from the request.
    expect(res.headers['location']).toBe(to);
    expect(res.headers['location']?.startsWith('//')).toBe(false);
  });

  it.each([
    `${MOUNT}emptydir`,
    `${MOUNT}emptydir/`,
    `${MOUNT}app.js/`,
    `${MOUNT}app.js%2f`,
    `${MOUNT}index.html/`,
  ])(
    'answers %s with a 404: a directory without an index is not listed, a file is not a directory',
    async (path) => {
      const res = await raw(path);
      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe('Not Found\n');
    },
  );

  it.each([
    '/',
    '/other/app.js',
    '/playerx/app.js',
    '/PLAYER/app.js',
    '/player%2Fapp.js',
    '/%70layer/app.js',
    '//player/app.js',
    'http://lab/player/app.js',
  ])('answers %s, which is not under the mount, with a 404', async (path) => {
    const res = await raw(path);
    expect(res.status).toBe(404);
    expect(res.body.toString('latin1')).not.toContain(files['app.js'] ?? '');
  });

  it('ignores Range, conditional and compression headers: the whole file, identity-encoded', async () => {
    const res = await raw(`${MOUNT}app.js`, 'GET', [
      'Range: bytes=0-3',
      'If-None-Match: *',
      'If-Modified-Since: Wed, 21 Oct 2037 07:28:00 GMT',
      'Accept-Encoding: gzip, br',
    ]);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['app.js']);
    for (const name of ['content-range', 'content-encoding', 'etag', 'last-modified', 'accept-ranges']) {
      expect(res.headers[name], name).toBeUndefined();
    }
  });

  it('maps content types by extension, case-insensitively, and falls back to octet-stream', () => {
    expect(contentTypeFor('/x/player.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('module.wasm')).toBe('application/wasm');
    expect(contentTypeFor('favicon.ico')).toBe('image/x-icon');
    expect(contentTypeFor('archive.tar.gz')).toBe('application/octet-stream');
    expect(contentTypeFor('no-extension')).toBe('application/octet-stream');
  });
});

type Vector = [label: string, target: string, status: 400 | 404];

/**
 * Every request target here must be refused (400 for a request that is malformed, 404 for everything else) and must never
 * return the content of a file outside the root. A refusal of an escape is a 404 on purpose: the answer must not tell a
 * secret that exists from a file that does not.
 */
const vectors: Vector[] = [
  // The classic forms.
  ['dot-dot', `${MOUNT}../secret.txt`, 404],
  ['dot-dot, trailing', `${MOUNT}..`, 404],
  ['dot-dot, trailing slash', `${MOUNT}../`, 404],
  ['dot-dot behind a dot', `${MOUNT}./../secret.txt`, 404],
  ['dot-dot, many levels', `${MOUNT}../../../../../../../../etc/passwd`, 404],
  ['dot-dot, as many levels as fit', `${MOUNT}${'../'.repeat(600)}etc/passwd`, 404],
  ['absolute path after a double slash', `${MOUNT}/etc/passwd`, 404],
  ['absolute path after many slashes', `${MOUNT}////etc/passwd`, 404],
  ['a URL as the name', `${MOUNT}file:///etc/passwd`, 404],
  ['four dots', `${MOUNT}....//secret.txt`, 404],
  ['dot-dot with a path parameter', `${MOUNT}..;/secret.txt`, 404],
  // Percent-encoded forms: decoded once, then judged like the plain forms.
  ['encoded dots', `${MOUNT}%2e%2e/secret.txt`, 404],
  ['encoded dots, trailing', `${MOUNT}%2e%2e`, 404],
  ['encoded dots and slash, upper case', `${MOUNT}%2E%2E%2fsecret.txt`, 404],
  ['dots and an encoded slash', `${MOUNT}..%2fsecret.txt`, 404],
  ['encoded slash only', `${MOUNT}%2e%2e%2f`, 404],
  ['half-encoded dots', `${MOUNT}.%2e/secret.txt`, 404],
  ['half-encoded dots, the other half', `${MOUNT}%2e./secret.txt`, 404],
  ['nested, encoded slashes', `${MOUNT}a/..%2f..%2fsecret.txt`, 404],
  ['encoded dots with a path parameter', `${MOUNT}%2e%2e;/secret.txt`, 404],
  ['many encoded levels', `${MOUNT}%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`, 404],
  ['encoded absolute path', `${MOUNT}%2fetc%2fpasswd`, 404],
  // Look-alikes and names a different platform would trim: literal names here, so nothing to serve.
  ['fullwidth dots', `${MOUNT}%ef%bc%8e%ef%bc%8e/secret.txt`, 404],
  ['division slash', `${MOUNT}..%e2%88%95secret.txt`, 404],
  ['dot-dot followed by a space', `${MOUNT}..%20/secret.txt`, 404],
  // Double encoding stays literal: it names a file that does not exist.
  ['double-encoded dots', `${MOUNT}%252e%252e/secret.txt`, 404],
  ['double-encoded slash', `${MOUNT}..%252fsecret.txt`, 404],
  ['double-encoded backslash', `${MOUNT}..%255csecret.txt`, 404],
  // The Windows separator is refused whatever form it takes.
  ['dots and an encoded backslash', `${MOUNT}..%5csecret.txt`, 400],
  ['encoded backslash first', `${MOUNT}%5c..%5csecret.txt`, 400],
  ['raw backslashes', `${MOUNT}\\..\\secret.txt`, 400],
  ['raw backslash in a name', `${MOUNT}a\\b`, 400],
  // NUL and the other control characters.
  ['NUL byte', `${MOUNT}%00`, 400],
  ['NUL byte inside a name', `${MOUNT}index.html%00.png`, 400],
  ['NUL byte after a traversal', `${MOUNT}../secret.txt%00.js`, 400],
  ['line feed', `${MOUNT}app.js%0a`, 400],
  ['carriage return and line feed', `${MOUNT}app.js%0d%0aX-Injected:%201`, 400],
  ['tab', `${MOUNT}app.js%09`, 400],
  ['unit separator', `${MOUNT}app.js%1f`, 400],
  ['DEL', `${MOUNT}app.js%7f`, 400],
  // Malformed escapes: the decoder refuses them, the module answers 400.
  ['a lone percent sign', `${MOUNT}%`, 400],
  ['a percent sign at the end of a name', `${MOUNT}a%`, 400],
  ['one hex digit', `${MOUNT}%2`, 400],
  ['not hex', `${MOUNT}%zz`, 400],
  ['truncated multi-byte sequence', `${MOUNT}%e0%a4%a`, 400],
  ['a continuation byte alone', `${MOUNT}%80`, 400],
  ['invalid UTF-8 byte', `${MOUNT}%ff`, 400],
  ['overlong UTF-8 slash', `${MOUNT}..%c0%afsecret.txt`, 400],
  ['overlong UTF-8 dots', `${MOUNT}%c0%ae%c0%ae/secret.txt`, 400],
  ['overlong three-byte slash', `${MOUNT}..%e0%80%afsecret.txt`, 400],
  ['non-standard %u escape', `${MOUNT}%u002e%u002e/secret.txt`, 400],
  // The sibling whose name starts with the root's name: a prefix check without a separator would let these in.
  ['sibling of the root', `${MOUNT}../player-evil/loot.txt`, 404],
  ['sibling of the root, encoded dots', `${MOUNT}%2e%2e/player-evil/loot.txt`, 404],
  ['sibling of the root, encoded slashes', `${MOUNT}..%2fplayer-evil%2floot.txt`, 404],
  ['sibling of the root, its directory', `${MOUNT}../player-evil/`, 404],
  // Symlinks inside the root that lead out of it.
  ['symlink to a file outside', `${MOUNT}link-to-secret.txt`, 404],
  ['symlink to a file outside, absolute target', `${MOUNT}link-abs.txt`, 404],
  ['symlink to a directory outside', `${MOUNT}link-to-outside/loot.txt`, 404],
  ['symlink to a directory outside, the directory', `${MOUNT}link-to-outside/`, 404],
  ['symlink to the parent of the root', `${MOUNT}link-to-parent/secret.txt`, 404],
  ['symlink to the sibling of the root', `${MOUNT}link-to-sibling/loot.txt`, 404],
  ['symlink to the system directory /etc', `${MOUNT}link-to-etc/passwd`, 404],
  ['symlink as the index of a directory', `${MOUNT}evil-index/`, 404],
  ['symlink loop', `${MOUNT}link-loop-a`, 404],
  ['symlink loop, through a directory', `${MOUNT}link-loop-a/x`, 404],
  ['symlink to nothing', `${MOUNT}link-broken`, 404],
  // Lengths.
  ['a path longer than the limit', `${MOUNT}${'a'.repeat(3000)}`, 400],
  ['a path far longer than the limit (still below the parser limit)', `${MOUNT}${'a'.repeat(10_000)}`, 400],
  ['encoded dot-dots, longer than the limit', `${MOUNT}${'%2e%2e%2f'.repeat(300)}secret.txt`, 400],
  ['a name longer than any file system accepts', `${MOUNT}${'a'.repeat(2000)}`, 404],
  ['a deep path that does not exist', `${MOUNT}${'a/'.repeat(900)}x`, 404],
];

describe('traversal vectors over a raw socket', () => {
  it.each(vectors)('%s', async (_label, target, status) => {
    const res = await raw(target);
    expect(res.status).toBe(status);
    const text = `${res.body.toString('latin1')}\n${JSON.stringify(res.headers)}`;
    for (const secret of FORBIDDEN) expect(text).not.toContain(secret);
    // The module made the decision: the HTTP parser did not tidy the target or turn it away first.
    expect((await answers.get(target))?.status).toBe(status);
    expect(resolveStaticFile(root, MOUNT, target)).toBeNull();
  });

  it('turns a request line beyond the parser limit away before the module sees it', async () => {
    const target = `${MOUNT}${'a'.repeat(20_000)}`;
    const res = await raw(target);
    expect([0, 400, 414, 431]).toContain(res.status);
    expect(answers.has(target)).toBe(false);
  });

  it('is rejected the same way under a mount reached through a symlinked root', async () => {
    for (const target of [
      `${LINKED}../secret.txt`,
      `${LINKED}link-to-secret.txt`,
      `${LINKED}link-to-sibling/loot.txt`,
    ]) {
      const res = await raw(target);
      expect(res.status, target).toBe(404);
      expect(res.body.toString('latin1')).not.toContain(SECRET);
      expect(res.body.toString('latin1')).not.toContain(LOOT);
    }
  });
});

describe('dotfiles', () => {
  it.each([
    ['a dotfile', `${MOUNT}.env`],
    ['a dotfile, the dot encoded', `${MOUNT}%2eenv`],
    ['a dotfile, another case', `${MOUNT}.ENV`],
    ['a dot directory', `${MOUNT}.git/config`],
    ['a dot directory, listed', `${MOUNT}.git/`],
    ['a dot directory, bare', `${MOUNT}.git`],
    ['a dotfile in a subdirectory', `${MOUNT}assets/.hidden`],
    ['a dotfile next to an index', `${MOUNT}sub/.private`],
    ['a dotfile after a dot segment', `${MOUNT}assets/../.env`],
    ['a dotfile after a traversal that comes back', `${MOUNT}.%2e/player/.env`],
    ['a symlink to a dotfile', `${MOUNT}link-to-dotfile.txt`],
  ])('does not serve %s', async (_label, target) => {
    const res = await raw(target);
    expect(res.status).toBe(404);
    expect(res.body.toString('latin1')).not.toContain(DOTFILE);
    expect(resolveStaticFile(root, MOUNT, target)).toBeNull();
  });
});

describe('symlinks', () => {
  it('serves a symlink that stays inside the root, as the file it points to', async () => {
    const res = await raw(`${MOUNT}link-ok.txt`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['app.js']);
    // The type follows the file that is sent, not the name of the link.
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('serves the index of a symlinked directory that stays inside the root', async () => {
    const res = await raw(`${MOUNT}link-ok-dir/`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['sub/index.html']);
  });

  it('judges a symlink by where it lands: out and back in is a file inside the root', async () => {
    const res = await raw(`${MOUNT}link-to-parent/player/app.js`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['app.js']);
  });

  it('serves through a root that is itself a symlink', async () => {
    const res = await raw(`${LINKED}app.js`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(files['app.js']);
    expect(resolveStaticFile(linkedRoot, LINKED, `${LINKED}app.js`)).toBe(join(realpathSync(root), 'app.js'));
  });

  it('decides on every request: a file replaced by a symlink to a secret is refused at once', async () => {
    expect((await raw(`${MOUNT}swap.txt`)).status).toBe(200);
    rmSync(join(root, 'swap.txt'));
    symlinkSync('../secret.txt', join(root, 'swap.txt'));
    const res = await raw(`${MOUNT}swap.txt`);
    expect(res.status).toBe(404);
    expect(res.body.toString('latin1')).not.toContain(SECRET);
  });

  it.skipIf(process.platform === 'win32')(
    'answers a FIFO with a 404 and does not wait for a writer',
    async () => {
      execFileSync('mkfifo', [join(root, 'fifo')]);
      const res = await raw(`${MOUNT}fifo`);
      expect(res.status).toBe(404);
    },
  );
});

describe('resolveStaticFile', () => {
  let realRoot: string;

  beforeAll(() => {
    realRoot = realpathSync(root);
  });

  it('returns the real path of the file that would be sent', () => {
    expect(resolveStaticFile(root, MOUNT, `${MOUNT}app.js`)).toBe(join(realRoot, 'app.js'));
    expect(resolveStaticFile(root, MOUNT, MOUNT)).toBe(join(realRoot, 'index.html'));
    expect(resolveStaticFile(root, MOUNT, `${MOUNT}sub/`)).toBe(join(realRoot, 'sub', 'index.html'));
    expect(resolveStaticFile(root, MOUNT, `${MOUNT}link-ok.txt`)).toBe(join(realRoot, 'app.js'));
  });

  it('ignores the query string, and takes the mount with or without its slash', () => {
    expect(resolveStaticFile(root, MOUNT, `${MOUNT}app.js?v=2&x=%2e%2e%2f`)).toBe(join(realRoot, 'app.js'));
    expect(resolveStaticFile(root, '/player', `${MOUNT}app.js`)).toBe(join(realRoot, 'app.js'));
  });

  it('takes a root given relative to the working directory', () => {
    expect(resolveStaticFile(relative(process.cwd(), root), MOUNT, `${MOUNT}app.js`)).toBe(
      join(realRoot, 'app.js'),
    );
  });

  it.each([
    ['the mount without its slash (a redirect)', '/player'],
    ['a directory without its slash (a redirect)', `${MOUNT}sub`],
    ['a directory without an index', `${MOUNT}emptydir/`],
    ['a path outside the mount', '/other/app.js'],
    ['an empty path', ''],
    ['a path that is not absolute', 'player/app.js'],
  ])('is null for %s', (_label, target) => {
    expect(resolveStaticFile(root, MOUNT, target)).toBeNull();
  });

  it('treats a root that does not exist yet (the player is not built) as having nothing in it', async () => {
    const missing = join(scratch, 'not-built');
    expect(resolveStaticFile(missing, MOUNT, MOUNT)).toBeNull();
    const res = await serveWith(missing, '/player/');
    expect(res.status).toBe(404);
  });

  it.each(['', 'player', '/a/../b', '/a/./b', '/pl%61yer/', '/a?b', '/a#b', '/a\\b', '/a\u0000b'])(
    'refuses to serve anything under the mount %j, which is not a plain absolute path',
    (mount) => {
      expect(resolveStaticFile(root, mount, `${mount}/app.js`)).toBeNull();
      expect(resolveStaticFile(root, mount, '/app.js')).toBeNull();
    },
  );

  it('can mount the root at /, and is as strict there', () => {
    expect(resolveStaticFile(root, '/', '/app.js')).toBe(join(realRoot, 'app.js'));
    expect(resolveStaticFile(root, '/', '/../secret.txt')).toBeNull();
    expect(resolveStaticFile(root, '/', '/.env')).toBeNull();
  });

  it('never returns anything but a regular, non-dot file strictly inside the real root, whatever it is given', () => {
    const next = seeded(0x5eed);
    const pieces = [
      ...[
        'a',
        'app.js',
        'sub',
        'assets',
        'index.html',
        'big.bin',
        'player',
        'player-evil',
        'secret.txt',
        'outside',
      ],
      ...[
        'link-to-secret.txt',
        'link-to-parent',
        'link-to-outside',
        'link-ok-dir',
        'link-ok.txt',
        'link-loop-a',
      ],
      ...[
        '..',
        '.',
        '...',
        '.env',
        '.git',
        '%2e',
        '%2e%2e',
        '%2f',
        '%5c',
        '%252e',
        '%00',
        '%',
        '%zz',
        '\\',
        ';',
      ],
      ...['/', '//', '?', '#', '\u00e9', '%c3%a9', ' ', 'file:', ':'],
    ];
    let accepted = 0;
    for (let i = 0; i < 6000; i++) {
      let target = MOUNT;
      for (let part = 1 + Math.floor(next() * 8); part > 0; part--) {
        target += (pieces[Math.floor(next() * pieces.length)] ?? '') + (next() < 0.6 ? '/' : '');
      }
      const file = resolveStaticFile(root, MOUNT, target);
      if (file === null) continue;
      accepted++;
      expect(file.startsWith(realRoot + sep), target).toBe(true);
      expect(statSync(file).isFile(), target).toBe(true);
      expect(
        relative(realRoot, file)
          .split(sep)
          .some((name) => name.startsWith('.')),
        target,
      ).toBe(false);
    }
    // The generator must reach the serving branch often enough for the loop above to mean something.
    expect(accepted).toBeGreaterThan(100);
  });
});

/** Small seeded generator (mulberry32), so that a failing input can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** serveStatic for one URL over a short-lived server of its own, for the tests that need another root. */
async function serveWith(otherRoot: string, target: string): Promise<RawResponse> {
  const other = createServer((req, res) => void serveStatic(req, res, otherRoot, MOUNT));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    return await raw(target, 'GET', [], (other.address() as net.AddressInfo).port);
  } finally {
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
}

// Descriptors of this process (macOS and Linux both list them under /dev/fd): a file handle the server failed to release
// is one more entry. The counter is calibrated below: with stalled downloads it must see every open file.
const countsDescriptors = existsSync('/dev/fd');

function openDescriptors(): number {
  return readdirSync('/dev/fd').length;
}

/** Waits `count` turns of the event loop (never a duration). */
async function nextTurns(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The descriptor count once it has stopped changing from one turn of the event loop to the next (bounded). */
async function stableCount(): Promise<number> {
  let previous = openDescriptors();
  for (let turns = 0; turns < 500; turns++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const current = openDescriptors();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

/** Waits, in turns of the event loop and for at most 2 s, until the process holds no more than `limit` descriptors. */
async function settleTo(limit: number): Promise<number> {
  const deadline = Date.now() + 2000;
  let count = openDescriptors();
  while (count > limit && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    count = openDescriptors();
  }
  return count;
}

interface Download {
  socket: net.Socket;
  /** Bytes of the response head, so that body bytes can be told from header bytes. */
  headBytes: number;
  /** Bytes received so far, head included. */
  received: number;
}

/** Starts a download (the large file by default) and returns it once the body has begun, reading no further. */
function stalledDownload(path = `${MOUNT}big.bin`, extraHeaders: string[] = []): Promise<Download> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let received = 0;
    socket.on('connect', () =>
      socket.write(`${[`GET ${path} HTTP/1.1`, 'Host: lab', ...extraHeaders].join('\r\n')}\r\n\r\n`),
    );
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > 4096) {
        // Detached, or it would pause the socket again on every chunk once the download is resumed.
        socket.off('data', onData);
        socket.pause();
        resolve({ socket, headBytes: Buffer.concat(chunks).indexOf('\r\n\r\n') + 4, received });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/**
 * Resumes a stalled download and counts the rest of the body until the server closes the connection. The timeout is a
 * safety net: it reports `closed: false` for a server that left the connection open, it is never a measurement.
 */
function finish(download: Download): Promise<{ closed: boolean; body: number }> {
  return new Promise((resolve) => {
    let received = download.received;
    let settled = false;
    const done = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      download.socket.destroy();
      resolve({ closed, body: received - download.headBytes });
    };
    download.socket.setTimeout(3000, () => done(false));
    download.socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    download.socket.on('close', () => done(true));
    download.socket.resume();
  });
}

describe.skipIf(!countsDescriptors)('file handles', () => {
  // A FileHandle that is never closed is closed by the garbage collector, which warns. That can hide a leak from a
  // descriptor count taken after the collection, so the warning is a failure of its own.
  const collected: string[] = [];
  const onWarning = (warning: Error): void => {
    if (warning.message.includes('on garbage collection')) collected.push(warning.message);
  };

  beforeAll(() => {
    process.on('warning', onWarning);
  });

  afterAll(async () => {
    await nextTurns(2);
    process.off('warning', onWarning);
    expect(collected, 'handles closed by the garbage collector during the file').toEqual([]);
  });

  /** The process holds no more descriptors than `baseline`, and the garbage collector had no handle to close. */
  async function expectNoLeak(baseline: number, when: string): Promise<void> {
    expect(await settleTo(baseline), `descriptors ${when}`).toBeLessThanOrEqual(baseline);
    // The warning is emitted a turn after the collection that closed the handle.
    await nextTurns(2);
    expect(collected, `handles closed by the garbage collector ${when}`).toEqual([]);
  }

  /** Closes the idle connections earlier tests left behind and returns the descriptor count of the quiet process. */
  async function quietBaseline(): Promise<number> {
    server.closeAllConnections();
    await quiet();
    return stableCount();
  }

  /** Starts `count` downloads that stall mid-body, then abandons them all. Returns the descriptors held while stalled. */
  async function abandonDownloads(count: number): Promise<number> {
    const downloads = await Promise.all(Array.from({ length: count }, () => stalledDownload()));
    const held = openDescriptors();
    for (const download of downloads) download.socket.destroy();
    await quiet();
    return held;
  }

  it('releases the file of every download that the client abandons', async () => {
    const downloads = 40;
    await quietBaseline();
    // Warm-up: what the runtime allocates once and keeps (thread pool, buffers) is allocated before the baseline is taken.
    await abandonDownloads(downloads);
    const baseline = await stableCount();
    let peak = 0;
    for (let round = 1; round <= 5; round++) {
      peak = Math.max(peak, await abandonDownloads(downloads));
      await expectNoLeak(baseline, `after round ${round}`);
    }
    // Calibration: while stalled, every download holds a file and two sockets (client and server side) in this process,
    // so the counter does see the files. Without it, "no growth" above could mean "the counter sees nothing".
    expect(peak - baseline).toBeGreaterThanOrEqual(3 * downloads);
  });

  it('does not keep a file open for HEAD, refusals or redirects either', async () => {
    const baseline = await quietBaseline();
    const targets: Array<[method: string, target: string]> = [
      ['HEAD', `${MOUNT}big.bin`],
      ['HEAD', MOUNT],
      ['GET', `${MOUNT}missing.js`],
      ['GET', `${MOUNT}link-to-secret.txt`],
      ['GET', `${MOUNT}%zz`],
      ['POST', `${MOUNT}app.js`],
      ['GET', '/player'],
    ];
    for (let round = 0; round < 15; round++) {
      for (const [method, target] of targets)
        await raw(target, method, method === 'POST' ? ['Content-Length: 0'] : []);
    }
    await quiet();
    await expectNoLeak(baseline, 'after HEAD, refusals and redirects');
  });

  it('releases the file when the client is already gone before the response starts', async () => {
    const baseline = await quietBaseline();
    const settled: Array<Promise<StaticResult>> = [];
    const gone = createServer((req, res) => {
      req.socket.destroy();
      settled.push(serveStatic(req, res, root, MOUNT));
    });
    await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
    const gonePort = (gone.address() as net.AddressInfo).port;
    try {
      for (let i = 0; i < 20; i++) await raw(`${MOUNT}big.bin`, 'GET', [], gonePort);
      // Every call resolved, none hung on a stream nobody reads ...
      expect(settled).toHaveLength(20);
      await Promise.all(settled);
    } finally {
      gone.closeAllConnections();
      await new Promise<void>((resolve) => gone.close(() => resolve()));
    }
    // ... and none kept its file.
    await expectNoLeak(baseline, 'after downloads whose client was already gone');
  });

  it('never throws, and closes the file it opened, when the response cannot be written', async () => {
    const baseline = await quietBaseline();
    let destroyed = 0;
    const res = {
      headersSent: false,
      writeHead() {
        throw new Error('the socket is broken');
      },
      end() {},
      destroy() {
        destroyed++;
      },
    } as unknown as ServerResponse;
    const req = { method: 'GET', url: `${MOUNT}app.js` } as IncomingMessage;
    await expect(serveStatic(req, res, root, MOUNT)).resolves.toEqual({ status: 404 });
    expect(destroyed).toBe(1);
    await expectNoLeak(baseline, 'after a response that could not be written');
  });
});

describe('a file that changes while it is being sent', () => {
  const SIZE = 32 * 1024 * 1024;
  const changing = join(root, 'changing.bin');

  // A sparse file: the reads are cheap and the server cannot have buffered all of it while the client is stalled.
  beforeEach(() => {
    writeFileSync(changing, '');
    truncateSync(changing, SIZE);
  });

  it('closes the connection when the file shrinks, instead of leaving a keep-alive client waiting for the rest', async () => {
    const download = await stalledDownload(`${MOUNT}changing.bin`);
    truncateSync(changing, 1024);
    const { closed, body } = await finish(download);
    expect(closed).toBe(true);
    expect(body).toBeLessThan(SIZE);
  });

  it('never sends more than the length it declared when the file grows', async () => {
    const download = await stalledDownload(`${MOUNT}changing.bin`, ['Connection: close']);
    appendFileSync(changing, Buffer.alloc(1024 * 1024));
    const { closed, body } = await finish(download);
    expect(closed).toBe(true);
    expect(body).toBe(SIZE);
  });
});

describe('serveStatic given an unusual request', () => {
  it('answers a request without a URL or a method as what it is, and does not throw', async () => {
    const written: number[] = [];
    const res = {
      headersSent: false,
      writeHead(status: number) {
        written.push(status);
      },
      end() {},
    } as unknown as ServerResponse;
    await expect(serveStatic({} as IncomingMessage, res, root, MOUNT)).resolves.toEqual({ status: 405 });
    await expect(serveStatic({ method: 'GET' } as IncomingMessage, res, root, MOUNT)).resolves.toEqual({
      status: 404,
    });
    expect(written).toEqual([405, 404]);
  });
});
