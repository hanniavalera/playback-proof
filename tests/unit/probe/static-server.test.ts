import { rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange, startStaticServer } from '../../../src/lab/probe/static-server.ts';
import type { StaticServer } from '../../../src/lab/probe/static-server.ts';
import { makeScratch } from '../support/scratch.ts';

const scratch = makeScratch('unit-server-');

describe('parseRange', () => {
  it.each([
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=-500', 100, { start: 0, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=99-99', 100, { start: 99, end: 99 }],
  ])('%s of %i bytes is %j', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each([
    ['bytes=100-', 100],
    ['bytes=500-600', 100],
    ['bytes=-0', 100],
    ['bytes=5-2', 100],
  ])('%s of %i bytes is unsatisfiable', (header, size) => {
    expect(parseRange(header, size)).toBe('unsatisfiable');
  });

  it.each([[undefined], [''], ['items=0-1'], ['bytes=0-1,5-6'], ['bytes=-'], ['bytes=a-b']])(
    'ignores %j (the whole body is served, which RFC 9110 allows)',
    (header) => {
      expect(parseRange(header, 100)).toBeNull();
    },
  );
});

describe('startStaticServer', () => {
  let server: StaticServer;
  let typed: StaticServer;

  beforeAll(async () => {
    writeFileSync(join(scratch, 'clip.mp4'), Buffer.from('0123456789'));
    writeFileSync(join(scratch, 'clip.webm'), Buffer.from('abcdef'));
    server = await startStaticServer(scratch);
    typed = await startStaticServer(scratch, { contentTypes: { 'clip.mp4': 'audio/mp4' } });
  });

  afterAll(async () => {
    await server.close();
    await typed.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A request with the path exactly as given (fetch would normalise `..` away before it reaches the server). */
  function raw(path: string, method = 'GET'): Promise<{ status: number; body: string }> {
    const { port } = new URL(server.origin);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('binds to a port the OS chose, on the loopback interface only', () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(server.origin).port).not.toBe('0');
  });

  it('serves a blank page at / so the probe runs on a real http origin', async () => {
    const res = await fetch(`${server.origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<body></body>');
  });

  it('serves a media file whole, with a content type by extension and no caching', async () => {
    const res = await fetch(`${server.origin}/media/clip.mp4`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0123456789');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${server.origin}/media/clip.webm`)).headers.get('content-type')).toBe('video/webm');
  });

  it('takes the content type from the caller when given (audio-only files)', async () => {
    expect((await fetch(`${typed.origin}/media/clip.mp4`)).headers.get('content-type')).toBe('audio/mp4');
  });

  it('serves byte ranges as 206 with the right Content-Range (what <video src> needs)', async () => {
    const part = await fetch(`${server.origin}/media/clip.mp4`, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await part.text()).toBe('2345');
    const tail = await fetch(`${server.origin}/media/clip.mp4`, { headers: { range: 'bytes=-3' } });
    expect(await tail.text()).toBe('789');
  });

  it('answers a range outside the file with 416', async () => {
    const res = await fetch(`${server.origin}/media/clip.mp4`, { headers: { range: 'bytes=50-60' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers HEAD with the length and no body', async () => {
    const res = await fetch(`${server.origin}/media/clip.mp4`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('');
  });

  it('does not serve anything outside the media directory', async () => {
    for (const path of [
      '/media/..%2f..%2fpackage.json',
      '/media/%2e%2e%2fpackage.json',
      '/media/..%5cpackage.json',
      '/media/sub%2fclip.mp4',
      '/media/.hidden',
      '/media/',
      '/package.json',
      '/media/missing.mp4',
    ]) {
      expect((await raw(path)).status, path).toBe(404);
    }
  });

  it('survives a malformed URL and keeps serving', async () => {
    expect((await raw('/media/%E0%A4%A')).status).toBe(400);
    expect((await fetch(`${server.origin}/media/clip.mp4`)).status).toBe(200);
  });

  it('refuses methods other than GET and HEAD', async () => {
    expect((await raw('/media/clip.mp4', 'POST')).status).toBe(405);
  });

  it('stops listening when closed', async () => {
    const extra = await startStaticServer(scratch);
    expect((await fetch(`${extra.origin}/`)).status).toBe(200);
    await extra.close();
    await expect(fetch(`${extra.origin}/`)).rejects.toThrow();
  });
});
