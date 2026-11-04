import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentTypeFor, resolveStaticFile, serveStatic } from '../../../src/server/static.ts';
import type { StaticResult } from '../../../src/server/static.ts';
import { makeScratch } from '../support/scratch.ts';

// Real files in a scratch directory, a real HTTP server on port 0, and raw sockets for everything where fetch or
// http.request would tidy the URL (`..`, `%2f`, backslashes) before the server ever saw it.
//
// Layout (the secrets are outside the root, where a traversal would land):
//   <scratch>/secret.txt          the file no request may ever return
//   <scratch>/outside/loot.txt    a directory outside the root
//   <scratch>/player-evil/loot.txt  a sibling whose name starts with the root's name
//   <scratch>/player/             the root

const SECRET = `SECRET-${randomUUID()}`;
const LOOT = `LOOT-${randomUUID()}`;
const scratch = makeScratch('unit-static-');
const root = join(scratch, 'player');
const MOUNT = '/player/';

const files: Record<string, string> = {
  'index.html': '<!doctype html><title>player</title><script src="app.js"></script>',
  'app.js': 'console.log("player");\n',
  'app.js.map': '{"version":3,"sources":["app.ts"],"mappings":""}',
  'style.css': 'body{margin:0}',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'data.json': '{"ok":true}',
  'notes.txt': 'plain text',
  'assets/deep/nested.mjs': 'export const nested = 1;\n',
  'sub/index.html': '<!doctype html><title>sub</title>',
};

let server: Server;
let port: number;
const served: Array<{ url: string; result: StaticResult }> = [];

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** One request with the request target exactly as given, over a plain socket; resolves when the server closes the connection. */
function raw(target: string, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: lab\r\nConnection: close\r\n\r\n`, 'latin1');
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

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  write(join(scratch, 'secret.txt'), SECRET);
  write(join(scratch, 'outside', 'loot.txt'), LOOT);
  write(join(scratch, 'player-evil', 'loot.txt'), LOOT);
  for (const [name, content] of Object.entries(files)) write(join(root, name), content);

  server = createServer((req, res) => {
    void serveStatic(req, res, root, MOUNT).then((result) => served.push({ url: req.url ?? '', result }));
  });
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
    ['app.js', 'text/javascript; charset=utf-8'],
    ['app.js.map', 'application/json'],
    ['style.css', 'text/css; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain; charset=utf-8'],
    ['assets/deep/nested.mjs', 'text/javascript; charset=utf-8'],
  ])('serves %s as %s with its exact length', async (name, type) => {
    const res = await fetch(`http://127.0.0.1:${port}${MOUNT}${name}`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(files[name] ?? '')));
    expect(body.toString()).toBe(files[name]);
  });

  it('serves index.html at the mount, with the headers that keep the lab honest', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${MOUNT}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(files['index.html']);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('maps content types by extension, case-insensitively, and falls back to octet-stream', () => {
    expect(contentTypeFor('/x/player.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('module.wasm')).toBe('application/wasm');
    expect(contentTypeFor('favicon.ico')).toBe('image/x-icon');
    expect(contentTypeFor('archive.tar.gz')).toBe('application/octet-stream');
    expect(contentTypeFor('no-extension')).toBe('application/octet-stream');
  });
});

describe('traversal vectors over a raw socket', () => {
  const vectors: Array<[string, string]> = [
    ['plain dot-dot', `${MOUNT}../secret.txt`],
    ['encoded dots', `${MOUNT}%2e%2e/secret.txt`],
    ['encoded dots and slash, upper case', `${MOUNT}%2E%2E%2fsecret.txt`],
    ['dots and an encoded slash', `${MOUNT}..%2fsecret.txt`],
    ['double-encoded dots', `${MOUNT}%252e%252e/secret.txt`],
    ['dots and an encoded backslash', `${MOUNT}..%5csecret.txt`],
    ['nested, encoded slashes', `${MOUNT}a/..%2f..%2fsecret.txt`],
    ['absolute path after a double slash', `${MOUNT}/etc/passwd`],
    ['NUL byte', `${MOUNT}%00`],
    ['NUL byte inside a name', `${MOUNT}index.html%00.png`],
    ['raw backslashes', `${MOUNT}\\..\\secret.txt`],
    ['half-encoded dots', `${MOUNT}.%2e/secret.txt`],
    ['four dots', `${MOUNT}....//secret.txt`],
  ];

  it.each(vectors)('%s: %s is never served', async (_label, target) => {
    const res = await raw(target);
    expect([400, 404]).toContain(res.status);
    expect(res.body.toString('latin1')).not.toContain(SECRET);
    expect(resolveStaticFile(root, MOUNT, target)).toBeNull();
  });
});
