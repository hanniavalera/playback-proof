import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthInfo } from '../../../src/shared/api.ts';
import { makeScratch } from '../support/scratch.ts';
import { call, rawConnect, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

// The player page through the service: /player and /player/* go to serveStatic with the player directory (docs/CONTRACTS.md section 4).
// serveStatic has its own attack suite (static.test.ts); this file proves it is wired in, with the router's rules around it.

const SECRET = 'TOP-SECRET-OUTSIDE-THE-PLAYER-DIRECTORY';
const INDEX = '<!doctype html><title>player</title>';

describe('the player page', () => {
  let h: Harness;
  let root: string;

  beforeAll(async () => {
    root = makeScratch('app-static-');
    const player = join(root, 'player');
    mkdirSync(join(player, 'sub'), { recursive: true });
    mkdirSync(join(player, 'empty'), { recursive: true });
    writeFileSync(join(player, 'index.html'), INDEX);
    writeFileSync(join(player, 'app.js'), 'console.log("player");');
    writeFileSync(join(player, 'sub', 'index.html'), '<p>sub</p>');
    writeFileSync(join(root, 'secret.txt'), SECRET);
    h = await startHarness({ playerDir: player });
  });
  afterAll(async () => {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function raw(target: string): Promise<string> {
    const connection = await rawConnect(h.port);
    try {
      connection.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      return await connection.until(/\r\n\r\n/);
    } finally {
      connection.close();
    }
  }

  it('answers /player with a redirect to /player/ that keeps the query the page is configured with', async () => {
    const plain = await fetch(`${h.origin}/player`, { redirect: 'manual' });
    expect(plain.status).toBe(308);
    expect(plain.headers.get('location')).toBe('/player/');
    const configured = await fetch(`${h.origin}/player?manifest=%2Fs%2Fx%2Fdash%2Fmanifest.mpd&config=B`, {
      redirect: 'manual',
    });
    expect(configured.headers.get('location')).toBe(
      '/player/?manifest=%2Fs%2Fx%2Fdash%2Fmanifest.mpd&config=B',
    );
  });

  it('serves the index at /player/ and the files under it, typed, uncacheable and open to other origins', async () => {
    const index = await call(h.origin, 'GET', '/player/?manifest=anything');
    expect(index.status).toBe(200);
    expect(index.text).toBe(INDEX);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(index.headers.get('access-control-allow-origin')).toBe('*');
    const script = await call(h.origin, 'GET', '/player/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await call(h.origin, 'GET', '/player/sub/')).text).toBe('<p>sub</p>');
    const dir = await fetch(`${h.origin}/player/sub`, { redirect: 'manual' });
    expect(dir.status).toBe(308);
    expect(dir.headers.get('location')).toBe('/player/sub/');
  });

  it('serves HEAD like GET, and answers anything else than GET and HEAD with 405 (OPTIONS is the router’s)', async () => {
    const get = await call(h.origin, 'GET', '/player/app.js');
    const head = await call(h.origin, 'HEAD', '/player/app.js');
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect(head.headers.get('content-length')).toBe(String(get.bytes.length));
    const post = await call(h.origin, 'POST', '/player/', { raw: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect((await call(h.origin, 'OPTIONS', '/player/')).status).toBe(204);
  });

  it('answers what is not there with 404, and never lists a directory', async () => {
    expect((await call(h.origin, 'GET', '/player/nope.js')).status).toBe(404);
    expect((await call(h.origin, 'GET', '/player/empty/')).status).toBe(404);
    expect((await call(h.origin, 'GET', '/playerx')).status).toBe(404);
  });

  it('does not let a path leave the player directory: the secret next to it is never served', async () => {
    for (const target of [
      '/player/../secret.txt',
      '/player/%2e%2e/secret.txt',
      '/player/..%2fsecret.txt',
      '/player/%2e%2e%2fsecret.txt',
      '/player/sub/../../secret.txt',
      '/player/%252e%252e/secret.txt',
      '/player/..%5csecret.txt',
      '/player//etc/passwd',
    ]) {
      const text = await raw(target);
      expect(text, target).toMatch(/^HTTP\/1\.1 (400|404) /);
      expect(text, target).not.toContain(SECRET);
    }
  });

  it('reports the player as built in /health once the directory has an index.html', async () => {
    expect((await call(h.origin, 'GET', '/health')).json<HealthInfo>().player).toBe('built');
  });
});

describe('a service whose player was not built', () => {
  it('answers /player/ with 404 and says so in /health', async () => {
    const root = makeScratch('app-nobuild-');
    const h = await startHarness({ playerDir: join(root, 'missing') });
    try {
      expect((await call(h.origin, 'GET', '/player/')).status).toBe(404);
      expect((await call(h.origin, 'GET', '/health')).json<HealthInfo>().player).toBe('missing');
    } finally {
      await h.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
