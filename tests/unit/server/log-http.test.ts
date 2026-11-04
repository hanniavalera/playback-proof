import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestLogEntry, SessionInfo } from '../../../src/shared/api.ts';
import { segmentPath } from '../../../src/shared/urls.ts';
import { activeDeliveries } from '../../../src/server/deliver.ts';
import { download, goodput, until } from '../support/delivery.ts';
import { FAKE_VIDEO, FAKE_VOD } from './fake-media.ts';
import { call, createSession, logOf, startHarness, waitForLog } from './harness.ts';
import type { Harness } from './harness.ts';

// The request log as the second observation channel (docs/CONTRACTS.md section 4): a request is listed from its ARRIVAL, while it is
// in flight, and is completed in place. Plus what the log must say when the client is the one that ends the response.

/** A request that the test can cut off: resolves when the response ends, however it ends. */
function cuttable(port: number, path: string): { cut(): void; done: Promise<void> } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
    res.on('data', () => undefined);
    res.on('error', () => finish());
    res.on('close', () => finish());
  });
  req.on('error', () => finish());
  req.end();
  return { cut: () => req.destroy(), done };
}

describe('the request log while requests are in flight', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const seg = (s: SessionInfo, n: number): string => segmentPath(s.id, s.stream, FAKE_VIDEO, n, 'm4s');

  it('lists a request at its arrival, pending and empty, and completes the same entry in place', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'latency', ms: 400, match: { kind: 'segment' } }],
    });
    let settled = false;
    const pending = download(h.port, seg(s, 5)).then((d) => {
      settled = true;
      return d;
    });
    // waiting on the server instead of sleeping: "a request for segment 5 has started"
    const [listed] = await waitForLog(h, s.id, (entries) => entries.some((e) => e.number === 5));
    expect(settled).toBe(false);
    expect(listed).toMatchObject({
      seq: 1,
      method: 'GET',
      kind: 'segment',
      rep: FAKE_VIDEO,
      number: 5,
      path: seg(s, 5),
      pending: true,
      status: 0,
      bytes: 0,
      faults: ['f1'],
    });
    await pending;
    const [done] = await logOf(h, s.id);
    expect(done).toMatchObject({ seq: 1, pending: false, status: 200, bytes: 600, faults: ['f1'] });
    expect(done?.ttfbMs).toBeGreaterThanOrEqual(400);
    expect(done?.totalMs).toBeGreaterThanOrEqual(done?.ttfbMs ?? Infinity);
    expect(done?.aborted).toBeUndefined();
  });

  it('shows the values so far while a body is being written: the status, the bytes sent', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'stall', afterBytes: 200, ms: 500, match: { kind: 'segment' } }],
    });
    const pending = download(h.port, seg(s, 1));
    const [midway] = await waitForLog(h, s.id, (entries) => entries[0]?.bytes === 200);
    expect(midway).toMatchObject({ pending: true, status: 200, bytes: 200 });
    expect(midway?.ttfbMs).toBeGreaterThanOrEqual(0);
    await pending;
    expect((await logOf(h, s.id))[0]).toMatchObject({ pending: false, status: 200, bytes: 600 });
  });

  it('assigns seq at arrival: a cursor cannot skip a request that is slower than the ones after it', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'latency', ms: 600, match: { kind: 'segment', number: 1 } }],
    });
    const slow = download(h.port, seg(s, 1));
    await waitForLog(h, s.id, (entries) => entries.length === 1);
    expect((await call(h.origin, 'GET', seg(s, 2))).status).toBe(200);
    expect((await call(h.origin, 'GET', seg(s, 3))).status).toBe(200);

    const midway = await logOf(h, s.id);
    expect(midway.map((e) => [e.seq, e.number, e.pending])).toEqual([
      [1, 1, true],
      [2, 2, false],
      [3, 3, false],
    ]);
    // a reader that has seen up to seq 3 has already seen the slow one: it was listed first
    expect(await logOf(h, s.id, 3)).toEqual([]);
    expect((await logOf(h, s.id, 1)).map((e) => e.seq)).toEqual([2, 3]);

    await slow;
    const finished = await logOf(h, s.id);
    expect(finished.map((e) => [e.seq, e.number, e.pending])).toEqual([
      [1, 1, false],
      [2, 2, false],
      [3, 3, false],
    ]);
    expect(finished[0]?.ttfbMs).toBeGreaterThanOrEqual(600);
  });

  it('completes the entry of a client that hangs up while the service is still delaying the response', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'latency', ms: 30_000, match: { kind: 'segment' } }],
    });
    const client = cuttable(h.port, seg(s, 4));
    await waitForLog(h, s.id, (entries) => entries.length === 1);
    client.cut();
    await client.done;
    const [entry] = await waitForLog(h, s.id, (entries) => entries[0]?.pending === false);
    expect(entry).toMatchObject({ pending: false, aborted: true, status: 0, bytes: 0, faults: ['f1'] });
    await until(() => activeDeliveries() === 0);
    expect((await call(h.origin, 'GET', '/health')).status).toBe(200);
  });
});

describe('a client that hangs up while a throttled body is being written', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ media: { segmentBytes: 120_000 } });
  });
  afterEach(async () => {
    await h.close();
  });

  it('ends the entry as aborted, releases the delivery and the bucket, and leaves the server healthy', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 800, match: { kind: 'segment' } }],
    });
    const path = (n: number): string => segmentPath(s.id, s.stream, FAKE_VIDEO, n, 'm4s');
    const first = cuttable(h.port, path(1));
    await waitForLog(h, s.id, (entries) => (entries[0]?.bytes ?? 0) > 0);
    first.cut();
    await first.done;
    const [entry] = await waitForLog(h, s.id, (entries) => entries[0]?.pending === false);
    expect(entry?.aborted).toBe(true);
    expect(entry?.status).toBe(200);
    expect(entry?.bytes).toBeGreaterThan(0);
    expect(entry?.bytes).toBeLessThan(120_000);
    await until(() => activeDeliveries() === 0);

    // The link is not left in a bad state: the next response gets the rate, and the session counts the cut as an error.
    const next = await download(h.port, path(2));
    expect(next.complete).toBe(true);
    expect(next.bytes).toBe(120_000);
    expect(goodput(next.chunks).steadyKbps).toBeGreaterThan(800 * 0.9);
    expect(goodput(next.chunks).steadyKbps).toBeLessThan(800 * 1.1);
    const log: RequestLogEntry[] = await logOf(h, s.id);
    expect(log.map((e) => [e.aborted === true, e.pending])).toEqual([
      [true, false],
      [false, false],
    ]);
  });
});
