import { execFileSync } from 'node:child_process';
import { Agent, request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestLogEntry, SessionInfo } from '../../../src/shared/api.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import { segmentPath } from '../../../src/shared/urls.ts';
import { activeDeliveries } from '../../../src/server/deliver.ts';
import { startServer } from '../../../src/server/index.ts';
import { download, goodput, prng, until } from '../support/delivery.ts';
import { FAKE_AUDIO, FAKE_VIDEO, FAKE_VOD, createFakeMedia } from './fake-media.ts';
import { call, createSession, logOf, rawConnect, startHarness, waitForLog } from './harness.ts';
import type { Harness } from './harness.ts';

// The lifecycle of the service: how it starts, how it ends (promptly, with nothing left behind), and what clients may do to it on
// the way (disconnect, reset, keep connections idle) without it losing its health.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('startServer', () => {
  it('listens on loopback on a free port by default and says where', async () => {
    const server = await startServer({ media: createFakeMedia() });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
      expect((await call(server.origin, 'GET', '/health')).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('serves two services side by side on different ports, with nothing shared', async () => {
    const [a, b] = await Promise.all([
      startServer({ media: createFakeMedia() }),
      startServer({ media: createFakeMedia() }),
    ]);
    try {
      expect(a.port).not.toBe(b.port);
      const info = await createSession(a, { stream: FAKE_VOD });
      expect((await call(a.origin, 'GET', `/api/sessions/${info.id}`)).status).toBe(200);
      expect((await call(b.origin, 'GET', `/api/sessions/${info.id}`)).status).toBe(404);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it('refuses a port that is taken, with the error code of the operating system', async () => {
    const first = await startServer({ media: createFakeMedia() });
    try {
      await expect(startServer({ media: createFakeMedia(), port: first.port })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await first.close();
    }
  });

  it('uses the system clock unless it is given one', async () => {
    const server = await startServer({ media: createFakeMedia() });
    try {
      const before = Date.now();
      const text = (await call(server.origin, 'GET', '/api/time')).text;
      expect(Date.parse(text)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(text)).toBeLessThan(Date.now() + 1);
    } finally {
      await server.close();
    }
  });
});

describe('close()', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ media: { segmentBytes: 100_000 } });
  });
  afterEach(async () => {
    await h.close();
  });

  it('resolves promptly while a response is stalled and idle keep-alive connections are open, and drops them all', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'stall', afterBytes: 10, ms: 60_000, match: { kind: 'segment' } }],
    });
    const idle = new Agent({ keepAlive: true });
    await new Promise<void>((resolve) =>
      request({ host: '127.0.0.1', port: h.port, path: '/health', agent: idle }, (res) => {
        res.resume();
        res.on('end', resolve);
      }).end(),
    );
    let outcome = 'running';
    const stalled = new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          path: segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'),
          agent: false,
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('error', () => (outcome = 'cut'));
          res.on('close', () => {
            outcome = res.complete ? 'complete' : 'cut';
            resolve();
          });
        },
      );
      req.on('error', () => resolve());
      req.end();
    });
    await waitForLog(h, s.id, (entries) => entries[0]?.bytes === 10);

    const started = performance.now();
    await h.close();
    const took = performance.now() - started;
    expect(took).toBeLessThan(1000);
    await stalled;
    expect(outcome).toBe('cut');
    await until(() => activeDeliveries() === 0);
    await expect(fetch(`${h.origin}/health`)).rejects.toThrow();
    idle.destroy();
  });

  it('is safe to call twice, and a second call is the first', async () => {
    const first = h.close();
    expect(h.close()).toBe(first);
    await first;
  });

  it('leaves nothing alive: a process that started it, served in-flight and idle connections, and closed it, exits by itself', () => {
    // No process.exit(): the child ends only when its event loop is empty, so a timer, a bucket or a socket that close() left
    // behind keeps it alive until execFileSync gives up and throws.
    const program = `
      import { Agent, request } from 'node:http';
      import { startServer } from './src/server/index.ts';
      import { createFakeMedia } from './tests/unit/server/fake-media.ts';
      const server = await startServer({ media: createFakeMedia({ segmentBytes: 300000 }), port: 0 });
      const send = (method, path, body) => new Promise((resolve) => {
        const req = request({ host: '127.0.0.1', port: server.port, path, method, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
          const parts = [];
          res.on('data', (d) => parts.push(d)); res.on('error', () => resolve(null)); res.on('close', () => resolve(Buffer.concat(parts).toString()));
        });
        req.on('error', () => resolve(null));
        req.end(body);
      });
      const rules = [
        { type: 'throttle', kbps: 100, match: { kind: 'segment', rep: 'v360' } },
        { type: 'stall', afterBytes: 10, ms: 600000, match: { kind: 'segment', rep: 'a-aac' } },
        { type: 'latency', ms: 600000, match: { kind: 'init' } },
      ];
      const session = JSON.parse(await send('POST', '/api/sessions', JSON.stringify({ stream: 'vod-cmaf-short', faults: rules })));
      const base = '/s/' + session.id + '/vod-cmaf-short/seg/';
      const inflight = [send('GET', base + 'v360/1.m4s'), send('GET', base + 'a-aac/1.m4s'), send('GET', base + 'v360/init.mp4')];
      const idle = new Agent({ keepAlive: true });
      await new Promise((resolve) => request({ host: '127.0.0.1', port: server.port, path: '/health', agent: idle }, (res) => { res.resume(); res.on('end', resolve); }).end());
      await new Promise((resolve) => setTimeout(resolve, 300));
      await server.close();
      await Promise.all(inflight);
      idle.destroy();
      console.log('closed');
    `;
    const started = performance.now();
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(out.trim()).toBe('closed');
    console.info(
      `[server] a process that served a throttled, a stalled and a delayed response plus an idle keep-alive connection, then closed the service, exited on its own after ${(performance.now() - started).toFixed(0)} ms (including loading TypeScript)`,
    );
  });
});

describe('connections', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('keeps a connection usable after every kind of answer: media, 404, 405, 204, 201, a refused body', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const s = await createSession(h, { stream: FAKE_VOD });
    const send = (
      method: string,
      path: string,
      body?: Buffer,
    ): Promise<{ status: number; reused: boolean }> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: h.port,
            path,
            method,
            agent,
            headers: { 'content-type': 'application/json' },
          },
          (res: IncomingMessage) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      const steps: Array<[string, string, number, Buffer?]> = [
        ['GET', s.manifestUrl, 200],
        ['GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'), 200],
        ['GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 99, 'm4s'), 404],
        ['POST', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'), 405],
        ['HEAD', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'), 200],
        ['POST', '/api/sessions', 201, Buffer.from(JSON.stringify({ stream: FAKE_VOD }))],
        ['POST', '/api/sessions', 413, Buffer.alloc(70_000, 0x20)],
        ['GET', '/health', 200],
        ['DELETE', `/api/sessions/${s.id}`, 204],
        ['GET', '/health', 200],
      ];
      const seen: Array<{ status: number; reused: boolean }> = [];
      for (const [method, path, , body] of steps) seen.push(await send(method, path, body));
      expect(seen.map((r) => r.status)).toEqual(steps.map((step) => step[2]));
      expect(seen.map((r) => r.reused)).toEqual([false, ...steps.slice(1).map(() => true)]);
    } finally {
      agent.destroy();
    }
  });

  it('survives clients that hang up or reset at random moments of throttled, delayed, stalled and cut responses', async () => {
    await h.close();
    h = await startHarness({ media: { segmentBytes: 120_000 } });
    const rules: FaultRule[] = [
      { type: 'throttle', kbps: 1600, match: { kind: 'segment', rep: FAKE_VIDEO } },
      { type: 'latency', ms: 120, jitterMs: 100, match: { kind: 'segment', rep: FAKE_AUDIO } },
      { type: 'stall', afterBytes: 1000, ms: 250, match: { kind: 'segment', number: 3 } },
      { type: 'abort', afterBytes: 20_000, match: { kind: 'segment', number: 4 } },
    ];
    const s = await createSession(h, { stream: FAKE_VOD, faults: rules });
    const random = prng(20_260_303);
    const clients: Array<Promise<void>> = [];
    for (let i = 0; i < 30; i++) {
      const rep = random() < 0.5 ? FAKE_VIDEO : FAKE_AUDIO;
      const number = 1 + Math.floor(random() * 6);
      const cutAfterMs = Math.floor(random() * 300);
      const reset = i % 2 === 0;
      clients.push(
        new Promise<void>((resolve) => {
          const socket = connect({ host: '127.0.0.1', port: h.port });
          socket.on('error', () => undefined);
          socket.on('close', () => resolve());
          socket.on('connect', () => {
            socket.write(
              `GET ${segmentPath(s.id, s.stream, rep, number, 'm4s')} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
            );
            setTimeout(() => (reset ? socket.resetAndDestroy() : socket.destroy()), cutAfterMs);
          });
        }),
      );
    }
    await Promise.all(clients);
    const entries: RequestLogEntry[] = await waitForLog(
      h,
      s.id,
      (all) => all.length === 30 && all.every((entry) => !entry.pending),
    );
    expect(entries).toHaveLength(30);
    await until(() => activeDeliveries() === 0);
    expect(h.lines.filter((line) => line.includes(' ERROR '))).toEqual([]);

    // still healthy: a fresh session gets a correct rate and a correct body
    expect((await call(h.origin, 'GET', '/health')).status).toBe(200);
    const probe = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 1600, match: { kind: 'segment' } }],
    });
    const reply = await download(h.port, segmentPath(probe.id, probe.stream, FAKE_VIDEO, 1, 'm4s'));
    expect(reply.complete).toBe(true);
    expect(goodput(reply.chunks).steadyKbps).toBeGreaterThan(1600 * 0.9);
    expect(goodput(reply.chunks).steadyKbps).toBeLessThan(1600 * 1.1);
  });

  it('survives a client that sends half a request line and a request with a header that is not HTTP', async () => {
    const half = await rawConnect(h.port);
    half.write('GET /health HT');
    half.close();
    const garbage = await rawConnect(h.port);
    garbage.write('\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03 not http at all\r\n\r\n');
    expect(await garbage.until(/HTTP\/1\.1 400/)).toMatch(/^HTTP\/1\.1 400/);
    garbage.close();
    expect((await call(h.origin, 'GET', '/health')).status).toBe(200);
  });
});

describe('failures inside the media pipeline', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
  });

  it('answers an exception in the store with 500 JSON, completes the log entry, logs it, and goes on', async () => {
    h = await startHarness({
      decorate: (media) => ({
        ...media,
        segment: () => {
          throw new Error('the disk is on fire');
        },
        dashVod: () => {
          throw new Error('the manifest builder broke');
        },
      }),
    });
    const s: SessionInfo = await createSession(h, { stream: FAKE_VOD });
    const segment = await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'));
    expect(segment.status).toBe(500);
    expect(segment.headers.get('content-type')).toMatch(/^application\/json/);
    expect(segment.json()).toEqual({ error: 'internal error' });
    expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(500);
    const entries = await logOf(h, s.id);
    expect(entries.map((e) => [e.status, e.pending])).toEqual([
      [500, false],
      [500, false],
    ]);
    expect(h.lines.some((line) => / ERROR GET .*seg\/v360\/1\.m4s.*the disk is on fire/s.test(line))).toBe(
      true,
    );
    expect((await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/seg/a-aac/init.mp4`)).status).toBe(200);
  });

  it('checks what it hands to deliver(): a header value that cannot be written is a 500 JSON, not a dropped connection', async () => {
    h = await startHarness({
      decorate: (media) => ({
        ...media,
        streams: () =>
          media.streams().map((info) => ({
            ...info,
            reps: info.reps.map((rep) => ({
              ...rep,
              mimeType: 'video/mp4\r\nX-Injected: 1' as typeof rep.mimeType,
            })),
          })),
      }),
    });
    const s = await createSession(h, { stream: FAKE_VOD });
    const reply = await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'));
    expect(reply.status).toBe(500);
    expect(reply.headers.get('x-injected')).toBeNull();
    expect(reply.json()).toEqual({ error: 'internal error' });
    expect(h.lines.some((line) => line.includes('invalid value for header Content-Type'))).toBe(true);
    expect((await logOf(h, s.id))[0]).toMatchObject({ status: 500, pending: false });
  });
});

describe('the access log (PB_LOG)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes one line per request: method, path, status, time, and for media the bytes, the rules that fired and an abort', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'abort', afterBytes: 100, match: { kind: 'segment', number: 2 } }],
    });
    h.lines.length = 0;
    await call(h.origin, 'GET', '/health');
    await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'));
    await download(h.port, segmentPath(s.id, s.stream, FAKE_VIDEO, 2, 'm4s'));
    await call(h.origin, 'GET', '/nope');
    await until(() => h.lines.length === 4);
    // each line starts with the ISO time of the request; the aborted one may be written after a later request's
    const lines = h.lines.map((line) => line.replace(/^\S+ /, ''));
    expect(lines).toContainEqual(expect.stringMatching(/^GET \/health 200 \d+\.\dms$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/^GET \/s\/[0-9a-f]{12}\/vod-cmaf-short\/seg\/v360\/1\.m4s 200 \d+\.\dms 600B$/),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^GET \/s\/\S+\/seg\/v360\/2\.m4s 200 \d+\.\dms 100B faults=f1 aborted$/),
    );
    expect(lines).toContainEqual(expect.stringMatching(/^GET \/nope 404 \d+\.\dms$/));
    expect(h.lines.every((line) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(line))).toBe(true);
  });

  it('keeps answering when the log itself fails (a closed pipe, a callback that throws)', async () => {
    const broken = await startServer({
      media: createFakeMedia(),
      log: () => {
        throw new Error('stderr is closed');
      },
    });
    try {
      const s = await createSession(broken, { stream: FAKE_VOD });
      expect(
        (await call(broken.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'))).status,
      ).toBe(200);
      expect((await call(broken.origin, 'GET', '/nope')).status).toBe(404);
    } finally {
      await broken.close();
    }
  });
});
