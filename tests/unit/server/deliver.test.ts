import { Agent, createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeDeliveries, deliver } from '../../../src/server/deliver.ts';
import type { DeliverOutcome } from '../../../src/server/deliver.ts';
import { CHUNK_BYTES, bucketState, createBucket } from '../../../src/server/throttle.ts';
import { deliveryServer, download, patterned, prng, until } from '../support/delivery.ts';
import type { Download } from '../support/delivery.ts';

// Real localhost HTTP, a real client that timestamps every read. The numbers printed with console.info are the measurements
// quoted in docs/decisions/server-delivery.md.

const uncaught: unknown[] = [];
const onUncaught = (err: unknown): void => {
  uncaught.push(err);
};

beforeAll(() => {
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
});

afterAll(() => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUncaught);
  expect(uncaught).toEqual([]);
});

const BODY = patterned(100_000);

describe('the response', () => {
  it('sends the status, the headers and the whole body with the real Content-Length, never chunked', async () => {
    const srv = await deliveryServer(() => ({
      input: {
        status: 201,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Lab': 'yes' },
        body: BODY,
      },
    }));
    const got = await download(srv.port, '/', { keepBody: true });
    expect(got.status).toBe(201);
    expect(got.headers['x-lab']).toBe('yes');
    expect(got.headers['content-length']).toBe(String(BODY.length));
    expect(got.headers['transfer-encoding']).toBeUndefined();
    expect(got.complete).toBe(true);
    expect(got.body?.equals(BODY)).toBe(true);
    expect(await srv.settled()).toEqual([
      expect.objectContaining({ bytesSent: BODY.length, aborted: false }),
    ]);
    await srv.close();
  });

  it('measures a string body in bytes and replaces a Content-Length or Transfer-Encoding of the caller, in any case', async () => {
    const text = 'héllo ✓ wörld';
    const srv = await deliveryServer(() => ({
      input: {
        status: 200,
        headers: {
          'content-length': 3,
          'Transfer-Encoding': 'chunked',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: text,
      },
    }));
    const got = await download(srv.port, '/', { keepBody: true });
    expect(got.headers['content-length']).toBe(String(Buffer.byteLength(text)));
    expect(got.headers['transfer-encoding']).toBeUndefined();
    expect(got.body?.toString('utf8')).toBe(text);
    await srv.close();
  });

  it('answers a HEAD with the Content-Length of the would-be body and no body, with or without the flag', async () => {
    const srv = await deliveryServer((req) => ({
      input: { status: 200, headers: {}, body: BODY, head: req.url === '/flag' },
    }));
    for (const path of ['/flag', '/method-only']) {
      const got = await download(srv.port, path, { method: 'HEAD' });
      expect(got.status).toBe(200);
      expect(got.headers['content-length']).toBe(String(BODY.length));
      expect(got.bytes).toBe(0);
      expect(got.complete).toBe(true);
    }
    for (const outcome of await srv.settled())
      expect(outcome).toMatchObject({ bytesSent: 0, aborted: false });
    await srv.close();
  });

  it('answers an empty body', async () => {
    const srv = await deliveryServer(() => ({ input: { status: 204, headers: {}, body: '' } }));
    const got = await download(srv.port, '/');
    expect(got).toMatchObject({ status: 204, bytes: 0, complete: true });
    await srv.close();
  });

  it('reports the head once and the running byte count, and a hook that throws does not stop the response', async () => {
    const heads: number[] = [];
    const counts: number[] = [];
    const srv = await deliveryServer((req) => ({
      input: { status: 200, headers: {}, body: BODY },
      hooks: {
        onHead: (ttfb) => heads.push(ttfb),
        onBytes: (n) => {
          counts.push(n);
          if (req.url === '/throws') throw new Error('observer bug');
        },
      },
    }));
    const fine = await download(srv.port, '/');
    expect(fine.complete).toBe(true);
    expect(heads).toHaveLength(1);
    expect(counts.at(-1)).toBe(BODY.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(counts.length);

    counts.length = 0;
    const throwing = await download(srv.port, '/throws', { keepBody: true });
    expect(throwing.body?.equals(BODY)).toBe(true);
    const [, outcome] = await srv.settled();
    expect(outcome).toMatchObject({
      aborted: false,
      bytesSent: BODY.length,
      error: 'hook threw: observer bug',
    });
    await srv.close();
  });

  it.each([
    ['an invalid status code', { status: 99, headers: {} }, /status/i],
    ['an invalid header value', { status: 200, headers: { 'X-Bad': 'a\nb' } }, /header|character/i],
  ])('turns %s into an outcome, not a rejection, and drops the connection', async (_name, input, message) => {
    const srv = await deliveryServer(() => ({ input: { ...input, body: 'x' } }));
    const got = await download(srv.port, '/');
    expect(got.complete).toBe(false);
    expect(got.status).toBe(0);
    const [outcome] = await srv.settled();
    expect(outcome).toMatchObject({ aborted: true, reason: 'error', bytesSent: 0 });
    expect(outcome?.error).toMatch(message);
    await srv.close();
  });

  it('measures the first byte when the head is flushed to the socket, not when it is queued', async () => {
    const srv = await deliveryServer((_req, res) => {
      res.socket?.cork(); // nothing reaches the wire until the socket is uncorked
      setTimeout(() => res.socket?.uncork(), 150);
      return { input: { status: 200, headers: {}, body: 'x' } };
    });
    const got = await download(srv.port, '/');
    const [outcome] = await srv.settled();
    const clientMs = got.headAt - got.startedAt;
    console.info(
      `[delivery] head held back 150 ms by a corked socket: ttfbMs ${outcome?.ttfbMs.toFixed(1)}, the client saw it after ${clientMs.toFixed(1)} ms`,
    );
    expect(outcome?.ttfbMs).toBeGreaterThanOrEqual(145);
    expect(Math.abs((outcome?.ttfbMs ?? 0) - clientMs)).toBeLessThan(50);
    await srv.close();
  });

  it('settles at once, without throwing, when the client is already gone', async () => {
    let settle!: (outcome: DeliverOutcome) => void;
    const outcome = new Promise<DeliverOutcome>((resolve) => (settle = resolve));
    const server = createServer((req, res) => {
      // deliver() is only called after the connection has been closed
      res.once('close', () => {
        void deliver(req, res, { status: 200, headers: {}, body: BODY, plan: { latencyMs: 5000 } }).then(
          settle,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const req = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, agent: false });
    req.on('error', () => {});
    req.end();
    setTimeout(() => req.destroy(), 20);
    expect(await outcome).toMatchObject({ aborted: true, reason: 'client-closed', bytesSent: 0 });
    expect(activeDeliveries()).toBe(0);
    server.close();
  });
});

describe('latency', () => {
  it.each([50, 250])('holds the first byte back for %i ms and no longer than that', async (latencyMs) => {
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { latencyMs } },
    }));
    const got = await download(srv.port, '/');
    const [outcome] = await srv.settled();
    const seen = got.headAt - got.startedAt;
    console.info(
      `[delivery] latency ${latencyMs} ms: client saw the head after ${seen.toFixed(1)} ms (+${(seen - latencyMs).toFixed(1)}), ttfbMs ${outcome?.ttfbMs.toFixed(1)}`,
    );
    expect(outcome?.ttfbMs).toBeGreaterThanOrEqual(latencyMs);
    expect(seen).toBeGreaterThanOrEqual(latencyMs);
    expect(seen).toBeLessThan(latencyMs + 120); // +-30 ms on an idle machine; generous so a loaded one does not fail it
    expect(got.complete).toBe(true);
    await srv.close();
  });

  it('delays a HEAD too', async () => {
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, head: true, plan: { latencyMs: 80 } },
    }));
    const got = await download(srv.port, '/', { method: 'HEAD' });
    expect(got.headAt - got.startedAt).toBeGreaterThanOrEqual(80);
    expect(got.headers['content-length']).toBe(String(BODY.length));
    await srv.close();
  });
});

describe('stall', () => {
  it.each([
    ['inside the body', 30_000],
    ['straight after the head', 0],
  ])('pauses %s and then finishes with the body intact', async (_name, afterBytes) => {
    const ms = 300;
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { stall: { afterBytes, ms } } },
    }));
    const got = await download(srv.port, '/', { keepBody: true });
    const [outcome] = await srv.settled();
    expect(got.body?.equals(BODY)).toBe(true);
    expect(got.complete).toBe(true);

    const pause = pauseAfter(got, afterBytes);
    console.info(
      `[delivery] stall ${ms} ms after ${afterBytes} bytes: the client saw ${pause.toFixed(1)} ms of silence at that byte`,
    );
    // Both timestamps are taken by the client when its event loop gets to the reads, so the silence it sees is the stall plus the jitter
    // of the second read minus the jitter of the first: a loaded CI runner showed 294 ms for 300. A stall that did not happen reads a few
    // milliseconds and one that was served twice reads twice as long, so half the stall below and a whole stall above still tell them
    // apart; the stall itself is proved by the server's own clock (`totalMs`).
    expect(pause).toBeGreaterThanOrEqual(ms - ms / 2);
    expect(pause).toBeLessThan(ms + ms);
    expect(outcome?.totalMs).toBeGreaterThanOrEqual(ms);
    expect(outcome).toMatchObject({ aborted: false, bytesSent: BODY.length });
    await srv.close();
  });

  it('holds the response open after the last byte until the stall is over (a keep-alive client cannot tell, the server can)', async () => {
    const agent = new Agent({ keepAlive: true });
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { stall: { afterBytes: BODY.length, ms: 250 } } },
    }));
    const got = await download(srv.port, '/', { agent });
    expect(got).toMatchObject({ bytes: BODY.length, complete: true });
    expect(got.chunks.at(-1)!.t - got.startedAt).toBeLessThan(200); // the client has everything straight away
    const [outcome] = await srv.settled();
    expect(outcome?.totalMs).toBeGreaterThanOrEqual(250);
    expect(outcome).toMatchObject({ aborted: false, bytesSent: BODY.length });
    agent.destroy();
    await srv.close();
  });

  it('is not an abort when the client hangs up after it has received everything', async () => {
    // A `Connection: close` client leaves the moment Content-Length is satisfied: here, during the stall after the last byte.
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { stall: { afterBytes: BODY.length, ms: 5000 } } },
    }));
    const got = await download(srv.port, '/');
    expect(got).toMatchObject({ bytes: BODY.length, complete: true });
    const [outcome] = await srv.settled();
    expect(outcome).toMatchObject({ aborted: false, bytesSent: BODY.length });
    expect(outcome?.reason).toBeUndefined();
    expect(outcome?.totalMs).toBeLessThan(1000); // released at once, not after the 5 s of stall
    await srv.close();
  });
});

/** The silence the client saw right after the read that brought it to exactly `afterBytes` (after the head, for 0). */
function pauseAfter(got: Download, afterBytes: number): number {
  if (afterBytes === 0) return (got.chunks[0]?.t ?? Number.NaN) - got.headAt;
  let seen = 0;
  for (let i = 0; i < got.chunks.length - 1; i++) {
    seen += got.chunks[i]?.bytes ?? 0;
    if (seen === afterBytes) return (got.chunks[i + 1]?.t ?? 0) - (got.chunks[i]?.t ?? 0);
  }
  throw new Error(`no read of the client ended exactly at byte ${afterBytes}`);
}

describe('abort', () => {
  it.each([0, 1, 1234, CHUNK_BYTES, 70_000])(
    'sends exactly %i body bytes and then closes the connection, with Content-Length still the full size',
    async (afterBytes) => {
      const srv = await deliveryServer(() => ({
        input: { status: 200, headers: {}, body: BODY, plan: { abort: { afterBytes } } },
      }));
      const got = await download(srv.port, '/', { keepBody: true });
      expect(got.status).toBe(200);
      expect(got.headers['content-length']).toBe(String(BODY.length));
      expect(got.bytes).toBe(afterBytes);
      expect(got.body?.equals(BODY.subarray(0, afterBytes))).toBe(true);
      expect(got.complete).toBe(false);
      expect(got.error).toBe('ECONNRESET');
      expect(await srv.settled()).toEqual([
        expect.objectContaining({ aborted: true, reason: 'fault-abort', bytesSent: afterBytes }),
      ]);
      await srv.close();
    },
  );

  it('defaults to the head only', async () => {
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { abort: {} } },
    }));
    const got = await download(srv.port, '/');
    expect(got).toMatchObject({ status: 200, bytes: 0, complete: false });
    await srv.close();
  });

  it('cuts a body that is also throttled at the requested byte', async () => {
    const bucket = createBucket(1500);
    const srv = await deliveryServer(() => ({
      input: {
        status: 200,
        headers: {},
        body: BODY,
        plan: { buckets: [bucket], abort: { afterBytes: 40_000 } },
      },
    }));
    const got = await download(srv.port, '/');
    expect(got.bytes).toBe(40_000);
    expect(got.complete).toBe(false);
    // (40000 - the 16 KB burst) at 187.5 bytes per ms
    expect(got.chunks.at(-1)!.t - got.startedAt).toBeGreaterThan(100);
    await srv.close();
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 0, timerArmed: false });
  });

  it('stalls and then aborts when the plan has both', async () => {
    const srv = await deliveryServer(() => ({
      input: {
        status: 200,
        headers: {},
        body: BODY,
        plan: { stall: { afterBytes: 10_000, ms: 150 }, abort: { afterBytes: 30_000 } },
      },
    }));
    const got = await download(srv.port, '/');
    expect(got.bytes).toBe(30_000);
    expect(got.complete).toBe(false);
    // The silence the client saw is the stall within the jitter of two reads (see the stall test above): the stall was 150 ms.
    expect(pauseAfter(got, 10_000)).toBeGreaterThanOrEqual(100);
    expect(await srv.settled()).toEqual([
      expect.objectContaining({ aborted: true, reason: 'fault-abort', bytesSent: 30_000 }),
    ]);
    await srv.close();
  });
});

describe('back-pressure', () => {
  it('does not queue a 20 MB body in memory for a client that reads slowly', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
    let flushed = 0;
    let maxQueued = 0;
    let highWaterMark = 0;
    let sampler: ReturnType<typeof setInterval> | undefined;
    const srv = await deliveryServer((_req, res) => {
      highWaterMark = res.writableHighWaterMark;
      sampler = setInterval(() => (maxQueued = Math.max(maxQueued, res.writableLength)), 2);
      return {
        input: { status: 200, headers: {}, body: big },
        hooks: {
          onBytes: (n) => {
            flushed = n;
            maxQueued = Math.max(maxQueued, res.writableLength);
          },
        },
      };
    });

    let flushedWhilePaused = 0;
    let received = 0;
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: srv.port, agent: false }, (res) => {
        res.pause(); // the reader stops: the kernel's buffers fill, then the socket backs up
        setTimeout(() => {
          flushedWhilePaused = flushed;
          res.resume();
        }, 400);
        res.on('data', (d: Buffer) => (received += d.length));
        res.on('end', resolve);
      });
      req.end();
    });
    clearInterval(sampler);
    const [outcome] = await srv.settled();
    console.info(
      `[delivery] 20 MB to a reader that stopped for 400 ms: ${(flushedWhilePaused / 1048576).toFixed(2)} MB flushed meanwhile, response buffer peaked at ${maxQueued} bytes (high-water mark ${highWaterMark})`,
    );
    expect(received).toBe(big.length);
    expect(outcome).toMatchObject({ aborted: false, bytesSent: big.length });
    // Back-pressure: the response never held more than its high-water mark plus the one piece that crossed it, however long
    // the reader stopped (what the kernel took meanwhile depends on the OS and is only reported).
    expect(maxQueued).toBeLessThanOrEqual(highWaterMark + CHUNK_BYTES);
    await srv.close();
  });
});

describe('clients that leave', () => {
  it('releases a response waiting for its turn in a throttled queue as soon as its client leaves', async () => {
    // At 100 kbps a slice takes 117 ms, so six consumers wait about 700 ms between their turns: a delivery that only noticed the
    // departure when its turn came would settle long after the client was gone.
    const bucket = createBucket(100);
    const srv = await deliveryServer(() => ({
      input: { status: 200, headers: {}, body: BODY, plan: { buckets: [bucket] } },
    }));
    const requests = [1, 2, 3, 4, 5, 6].map((i) => {
      const req = request({ host: '127.0.0.1', port: srv.port, agent: false, path: `/${i}` }, (res) =>
        res.resume(),
      );
      req.on('error', () => {});
      req.end();
      return req;
    });
    await until(() => bucketState(bucket).consumers === 6 && bucketState(bucket).waiting >= 5);
    const leaving = srv.outcomeOf('/6');
    const left = performance.now();
    requests[5]?.destroy();
    const outcome = await leaving;
    const settledAfter = performance.now() - left;
    console.info(
      `[delivery] a client at the back of a queue of 6 on a 100 kbps bucket left: its delivery settled ${settledAfter.toFixed(1)} ms later`,
    );
    expect(outcome).toMatchObject({ aborted: true, reason: 'client-closed' });
    expect(settledAfter).toBeLessThan(100);
    expect(bucketState(bucket).consumers).toBe(5);
    for (const req of requests) req.destroy();
    await srv.settled();
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 0, timerArmed: false });
    await srv.close();
  });
  it('leaves nothing behind when 50 clients disconnect at random points of throttled, stalled and delayed responses', async () => {
    const bucket = createBucket(800);
    const big = patterned(300_000);
    const small = patterned(30_000);
    const kinds = ['delayed', 'throttled', 'stalled', 'everything'] as const;
    const srv = await deliveryServer((req) => {
      const kind = new URL(req.url ?? '/', 'http://lab').searchParams.get('kind');
      const plan =
        kind === 'delayed'
          ? { latencyMs: 2000 }
          : kind === 'throttled'
            ? { buckets: [bucket] }
            : kind === 'stalled'
              ? { stall: { afterBytes: 20_000, ms: 3000 } }
              : kind === 'after'
                ? { buckets: [bucket] }
                : { latencyMs: 100, buckets: [bucket], stall: { afterBytes: 40_000, ms: 2000 } };
      return { input: { status: 200, headers: {}, body: kind === 'after' ? small : big, plan } };
    });

    const random = prng(2026);
    const clients: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      const kind = kinds[i % kinds.length];
      const leaveAfterMs = 1 + Math.floor(random() * 300);
      clients.push(
        new Promise<void>((resolve) => {
          const socket = connect(srv.port, '127.0.0.1');
          socket.on('error', () => {});
          socket.on('close', () => resolve());
          socket.on('connect', () => {
            socket.write(`GET /?kind=${kind} HTTP/1.1\r\nHost: lab\r\nConnection: close\r\n\r\n`);
            socket.on('data', () => {});
            // every second client leaves with a FIN (end), the others with a reset-style destroy
            setTimeout(() => (i % 2 === 0 ? socket.destroy() : socket.end()), leaveAfterMs);
          });
        }),
      );
    }
    await Promise.all(clients);
    const outcomes = await srv.settled();

    expect(outcomes).toHaveLength(50);
    // every response was meant to outlast every client, so every one of them must have noticed that its client left
    for (const outcome of outcomes) expect(outcome).toMatchObject({ aborted: true, reason: 'client-closed' });
    expect(activeDeliveries()).toBe(0);
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 0, timerArmed: false });

    // the same bucket still serves: a 30 KB response is the 16 KB burst plus 14 KB at 100 bytes per ms
    const after = await download(srv.port, '/?kind=after', { keepBody: true });
    expect(after).toMatchObject({ status: 200, complete: true });
    expect(after.body?.equals(small)).toBe(true);
    expect(after.chunks.at(-1)!.t - after.startedAt).toBeLessThan(600);

    const closing = performance.now();
    await new Promise<void>((resolve) => srv.server.close(() => resolve()));
    const closeMs = performance.now() - closing;
    console.info(
      `[delivery] 50 clients left at random points: all 50 deliveries settled client-closed, server.close() took ${closeMs.toFixed(1)} ms`,
    );
    expect(closeMs).toBeLessThan(1000);
    expect(uncaught).toEqual([]);
  });
});
