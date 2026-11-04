import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceClient, ServiceError } from '../../../src/lab/service-client.ts';
import { startServer } from '../../../src/server/index.ts';
import { segmentPath } from '../../../src/shared/urls.ts';
import { FAKE_LIVE, FAKE_VIDEO, FAKE_VOD, createFakeMedia } from './fake-media.ts';
import { startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

// The client every harness uses, against the real service (startServer) over the fake store: nothing about the HTTP is mocked.

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    return err as ServiceError;
  }
  throw new Error('expected the call to fail');
}

describe('ServiceClient', () => {
  let h: Harness;
  let client: ServiceClient;
  beforeEach(async () => {
    h = await startHarness();
    client = new ServiceClient(h.origin);
  });
  afterEach(async () => {
    await h.close();
  });

  it('reads the health and the catalog, under the new and the old name', async () => {
    const health = await client.health();
    expect(health).toMatchObject({ status: 'ok', ffmpeg: 'fake-ffmpeg 0.0' });
    expect(health.streams[FAKE_VOD]).toBe('ready');
    expect(health.streams['vod-cmaf']).toBe('missing');
    const streams = await client.streams();
    expect(streams.map((s) => s.id)).toEqual([FAKE_VOD, 'vod-webm', FAKE_LIVE]);
    expect(await client.catalog()).toEqual(streams);
  });

  it('creates, reads and deletes a session', async () => {
    const info = await client.createSession({ stream: FAKE_VOD, label: 'PB-VOD-001' });
    expect(info).toMatchObject({ stream: FAKE_VOD, protocol: 'dash', label: 'PB-VOD-001' });
    expect(client.url(info.manifestUrl)).toBe(`${h.origin}${info.manifestUrl}`);
    const detail = await client.detail(info.id);
    expect(detail).toMatchObject({ id: info.id, faults: [], counters: { requests: 0 } });
    expect(await client.getSession(info.id)).toEqual(detail);
    await expect(client.deleteSession(info.id)).resolves.toBeUndefined();
    expect((await failure(client.detail(info.id))).status).toBe(404);
  });

  it('adds, replaces and removes fault rules, and returns the stored ones with their ids', async () => {
    const { id } = await client.createSession({ stream: FAKE_LIVE });
    const added = await client.addFaults(id, [
      { type: 'latency', ms: 10 },
      { type: 'live-stall', atNumber: 20, ms: 1000, id: 'stall' },
    ]);
    expect(added).toEqual([
      { type: 'latency', ms: 10, id: 'f1' },
      { type: 'live-stall', atNumber: 20, ms: 1000, id: 'stall' },
    ]);
    expect(await client.setFaults(id, [{ type: 'status', status: 503, match: { kind: 'segment' } }])).toEqual(
      [{ type: 'status', status: 503, match: { kind: 'segment' }, id: 'f2' }],
    );
    await client.removeFault(id, 'f2');
    expect((await client.detail(id)).faults).toEqual([]);
    expect((await failure(client.removeFault(id, 'f2'))).status).toBe(404);
  });

  it('turns an error of the service into a ServiceError with the status, the call and the problems it listed', async () => {
    const { id } = await client.createSession({ stream: FAKE_VOD });
    const invalid = await failure(
      client.addFaults(id, [
        { type: 'throttle', kbps: 0 },
        { type: 'status', status: 99, match: { kind: 'segment' } },
      ]),
    );
    expect(invalid).toMatchObject({
      name: 'ServiceError',
      status: 400,
      method: 'POST',
      path: `/api/sessions/${id}/faults`,
    });
    expect(invalid.details).toHaveLength(2);
    expect(invalid.message).toContain('400');
    expect(invalid.message).toContain('kbps');
    const unknown = await failure(client.createSession({ stream: 'vod-cmaf' }));
    expect(unknown.status).toBe(404);
    expect(unknown.message).toContain('generate:streams');
  });

  it('reads the request log from a cursor, and waits on it without sleeping', async () => {
    const { id } = await client.createSession({
      stream: FAKE_VOD,
      faults: [{ type: 'latency', ms: 400, match: { kind: 'segment', number: 5 } }],
    });
    await fetch(client.url(segmentPath(id, FAKE_VOD, FAKE_VIDEO, 1, 'm4s')));
    const first = await client.log(id);
    expect(first).toMatchObject([{ seq: 1, number: 1, status: 200, pending: false }]);
    const slow = fetch(client.url(segmentPath(id, FAKE_VOD, FAKE_VIDEO, 5, 'm4s'))).then((res) =>
      res.arrayBuffer(),
    );
    // "a request for segment 5 has started", seen while it is still waiting out its latency
    const seen = await client.waitForLog(id, (entries) => entries.some((e) => e.number === 5), { since: 1 });
    expect(seen).toMatchObject([{ seq: 2, number: 5, pending: true, status: 0 }]);
    expect(await client.log(id, 2)).toEqual([]);
    await slow;
    const done = await client.waitForLog(id, (entries) => entries.every((e) => !e.pending));
    expect(done.map((e) => e.status)).toEqual([200, 200]);
  });

  it('says what the log looked like when a wait gives up', async () => {
    const { id } = await client.createSession({ stream: FAKE_VOD });
    await fetch(client.url(segmentPath(id, FAKE_VOD, FAKE_VIDEO, 2, 'm4s')));
    await expect(
      client.waitForLog(id, (entries) => entries.some((e) => e.number === 99), {
        timeoutMs: 150,
        intervalMs: 20,
      }),
    ).rejects.toThrow(/did not reach the expected state within 150 ms: \[#1 segment 200\]/);
  });

  it('answers with status 0 when the service cannot be reached, and when it does not answer in time', async () => {
    await h.close();
    const refused = await failure(client.health());
    expect(refused.status).toBe(0);
    expect(refused.message).toMatch(/no answer.*ECONNREFUSED/);

    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const port = (silent.address() as { port: number }).port;
      const slow = new ServiceClient(`http://127.0.0.1:${port}/`, { requestTimeoutMs: 150 });
      const timedOut = await failure(slow.health());
      expect(timedOut.status).toBe(0);
      expect(timedOut.message).toMatch(/timeout/i);
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });
});

describe('ServiceClient.waitUntilHealthy', () => {
  it('resolves with the health as soon as the service answers', async () => {
    const h = await startHarness();
    try {
      const health = await new ServiceClient(h.origin).waitUntilHealthy({ timeoutMs: 2000 });
      expect(health.status).toBe('ok');
    } finally {
      await h.close();
    }
  });

  it('waits for a service that is not listening yet', async () => {
    // find a free port, then let the client start waiting before anything listens on it
    const probe = await startServer({ media: createFakeMedia() });
    const { port } = probe;
    await probe.close();
    const waiting = new ServiceClient(`http://127.0.0.1:${port}`).waitUntilHealthy({
      timeoutMs: 10_000,
      intervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const late = await startServer({ media: createFakeMedia(), port });
    try {
      expect((await waiting).status).toBe('ok');
    } finally {
      await late.close();
    }
  });

  it('waits for the streams it is told to wait for, and names the ones that never came', async () => {
    const h = await startHarness();
    try {
      const client = new ServiceClient(h.origin);
      await expect(
        client.waitUntilHealthy({ ready: [FAKE_VOD, FAKE_LIVE], timeoutMs: 1000 }),
      ).resolves.toBeDefined();
      await expect(
        client.waitUntilHealthy({
          ready: [FAKE_VOD, 'vod-cmaf', 'vod-cmaf-clearkey'],
          timeoutMs: 200,
          intervalMs: 20,
        }),
      ).rejects.toThrow(/not healthy within 200 ms \(streams not ready: vod-cmaf, vod-cmaf-clearkey\)/);
    } finally {
      await h.close();
    }
  });

  it('gives up with the last problem when nothing listens', async () => {
    const probe = await startServer({ media: createFakeMedia() });
    const { port } = probe;
    await probe.close();
    await expect(
      new ServiceClient(`http://127.0.0.1:${port}`).waitUntilHealthy({ timeoutMs: 200, intervalMs: 20 }),
    ).rejects.toThrow(/was not healthy within 200 ms \(.*ECONNREFUSED/);
  });
});

describe('ServiceClient defaults', () => {
  const saved = { origin: process.env.PB_ORIGIN, port: process.env.PB_PORT };
  afterEach(() => {
    for (const [name, value] of [
      ['PB_ORIGIN', saved.origin],
      ['PB_PORT', saved.port],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('takes the origin from PB_ORIGIN, then from PB_PORT, then 4600, and drops trailing slashes', () => {
    process.env.PB_ORIGIN = 'http://example.test:9999//';
    expect(new ServiceClient().origin).toBe('http://example.test:9999');
    delete process.env.PB_ORIGIN;
    process.env.PB_PORT = '4633';
    expect(new ServiceClient().origin).toBe('http://127.0.0.1:4633');
    delete process.env.PB_PORT;
    expect(new ServiceClient().origin).toBe('http://127.0.0.1:4600');
  });
});
