import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_BYTES,
  bucketState,
  createBucket,
  createPacer,
  msUntilTake,
  tryTake,
} from '../../../src/server/throttle.ts';
import { deliveryServer, download, gapsMs, goodput, percentile } from '../support/delivery.ts';
import type { Chunk } from '../support/delivery.ts';

// The arithmetic of the bucket, driven by an injected clock: no timers, no sockets, exact numbers. The accuracy of the whole
// path (bucket, pacing, socket, a real client) is measured in the second half of this file.

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('bucket arithmetic (injected clock)', () => {
  it('refills at kbps * 1000 / 8 bytes per second', () => {
    const c = clock();
    const bucket = createBucket(800, { now: c.now }); // 100 bytes per ms, a slice of 1500 bytes
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(CHUNK_BYTES); // the burst allowance, spent
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(0);
    c.advance(14);
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(0); // 1400 bytes: less than a slice
    c.advance(1);
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(1500);
    c.advance(1000);
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(CHUNK_BYTES); // a second later: 100 KB owed, but only one chunk can be banked
  });

  it.each([
    [800, 100],
    [1500, 187.5],
    [3000, 375],
  ])('%i kbps is %f bytes per ms', (kbps, bytesPerMs) => {
    const c = clock();
    const bucket = createBucket(kbps, { now: c.now });
    tryTake(bucket, CHUNK_BYTES);
    c.advance(10);
    expect(bucketState(bucket).tokens).toBeCloseTo(10 * bytesPerMs, 6);
  });

  it('banks at most one chunk while nobody is asking, however long the idle time', () => {
    const c = clock();
    const bucket = createBucket(3000, { now: c.now });
    c.advance(3_600_000);
    expect(tryTake(bucket, 10 * CHUNK_BYTES)).toBe(CHUNK_BYTES);
    expect(tryTake(bucket, 10 * CHUNK_BYTES)).toBe(0);
  });

  it('serves a consumer that wants less than a slice as soon as it has what it wants', () => {
    const c = clock();
    const bucket = createBucket(800, { now: c.now });
    tryTake(bucket, CHUNK_BYTES);
    c.advance(3);
    expect(tryTake(bucket, 300)).toBe(300);
    expect(tryTake(bucket, 301)).toBe(0); // 0 bytes left over, it needs a slice
  });

  it('reports how long until a grant is possible', () => {
    const c = clock();
    const bucket = createBucket(800, { now: c.now });
    tryTake(bucket, CHUNK_BYTES);
    expect(msUntilTake(bucket, CHUNK_BYTES)).toBeCloseTo(15, 6); // a 1500-byte slice at 100 bytes per ms
    c.advance(5);
    expect(msUntilTake(bucket, CHUNK_BYTES)).toBeCloseTo(10, 6);
    expect(msUntilTake(bucket, 200)).toBe(0);
    c.advance(100);
    expect(msUntilTake(bucket, CHUNK_BYTES)).toBe(0);
  });

  it('never grants less than a full-size segment, nor a slice larger than a chunk', () => {
    const c = clock();
    const slow = createBucket(100, { now: c.now }); // 12.5 bytes per ms: 15 ms would be 187 bytes
    tryTake(slow, CHUNK_BYTES);
    expect(msUntilTake(slow, CHUNK_BYTES)).toBeCloseTo(1460 / 12.5, 6);
    const fast = createBucket(1_000_000, { now: c.now }); // 125 KB per ms
    tryTake(fast, CHUNK_BYTES);
    c.advance(1);
    expect(tryTake(fast, 1_000_000)).toBe(CHUNK_BYTES);
  });

  it('does not run backwards when the clock does', () => {
    const c = clock(1000);
    const bucket = createBucket(800, { now: c.now });
    tryTake(bucket, CHUNK_BYTES);
    c.advance(-500);
    expect(tryTake(bucket, CHUNK_BYTES)).toBe(0);
    expect(bucketState(bucket).tokens).toBeGreaterThanOrEqual(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects kbps %s', (kbps) => {
    expect(() => createBucket(kbps)).toThrow(RangeError);
  });

  it('rejects an object that is not one of its buckets', () => {
    expect(() => createPacer([{ kbps: 800 }])).toThrow(TypeError);
  });
});

describe('scheduling (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Buckets read Date.now(), which the fake timers move together with the timers themselves. */
  function fakeBucket(kbps: number) {
    vi.useFakeTimers();
    return createBucket(kbps, { now: () => Date.now() });
  }

  /** Asks for chunks until stopped; records who was granted what and when (ms since the start). */
  function consumer(
    name: string,
    pacer: ReturnType<typeof createPacer>,
    log: { name: string; bytes: number; at: number }[],
  ) {
    const start = Date.now();
    let running = true;
    const done = (async () => {
      while (running) {
        const bytes = await pacer.take(CHUNK_BYTES);
        if (bytes === 0) break;
        log.push({ name, bytes, at: Date.now() - start });
      }
    })();
    return {
      async stop() {
        running = false;
        pacer.leave();
        await done;
      },
    };
  }

  it('has no timer while idle, one while somebody waits, none again afterwards', async () => {
    const bucket = fakeBucket(800);
    const pacer = createPacer([bucket]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pacer.take(CHUNK_BYTES)).toBe(CHUNK_BYTES); // the burst allowance: served at once
    expect(vi.getTimerCount()).toBe(0);

    const second = pacer.take(CHUNK_BYTES);
    expect(vi.getTimerCount()).toBe(1);
    expect(bucketState(bucket)).toMatchObject({ waiting: 1, timerArmed: true });
    await vi.advanceTimersByTimeAsync(15);
    expect(await second).toBe(1500);
    expect(vi.getTimerCount()).toBe(0);
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 1, timerArmed: false });

    pacer.leave();
    expect(bucketState(bucket).consumers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leave() resolves a pending take with 0, removes the waiter and clears the timer', async () => {
    const bucket = fakeBucket(800);
    const pacer = createPacer([bucket]);
    await pacer.take(CHUNK_BYTES);
    const pending = pacer.take(CHUNK_BYTES);
    expect(bucketState(bucket).waiting).toBe(1);
    pacer.leave();
    pacer.leave(); // idempotent
    expect(await pending).toBe(0);
    expect(await pacer.take(100)).toBe(0); // and stays left
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 0, timerArmed: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serves waiting consumers round robin, chunk by chunk', async () => {
    const bucket = fakeBucket(800);
    const log: { name: string; bytes: number; at: number }[] = [];
    const a = consumer('a', createPacer([bucket]), log);
    const b = consumer('b', createPacer([bucket]), log);
    await vi.advanceTimersByTimeAsync(3000);
    await a.stop();
    await b.stop();

    // After the burst (a asked first and took all of it) every grant alternates between the two.
    const afterBurst = log.slice(1);
    expect(afterBurst.length).toBeGreaterThan(100);
    afterBurst.forEach((entry, i) => expect(entry.name).toBe(i % 2 === 0 ? 'b' : 'a'));
    const sum = (name: string) => log.filter((e) => e.name === name).reduce((n, e) => n + e.bytes, 0);
    // 3 s at 100 bytes per ms, shared: a also holds the 16 KB burst, so compare what is left after it.
    expect(sum('a') - CHUNK_BYTES).toBeCloseTo(sum('b'), -3);
    expect(sum('a') + sum('b')).toBeCloseTo(CHUNK_BYTES + 300_000, -4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives n consumers 1/n each', async () => {
    const bucket = fakeBucket(1500);
    const log: { name: string; bytes: number; at: number }[] = [];
    const names = ['a', 'b', 'c', 'd'];
    const consumers = names.map((n) => consumer(n, createPacer([bucket]), log));
    await vi.advanceTimersByTimeAsync(8000);
    await Promise.all(consumers.map((c) => c.stop()));
    const total = log.reduce((n, e) => n + e.bytes, 0);
    expect(total).toBeCloseTo(CHUNK_BYTES + 187.5 * 8000, -4);
    for (const n of names) {
      const share = log.filter((e) => e.name === n).reduce((s, e) => s + e.bytes, 0);
      expect(Math.abs(share - total / 4)).toBeLessThan(CHUNK_BYTES + 2000); // the burst goes to whoever asked first
    }
  });

  it('is limited by the slowest of several buckets, whatever order they are given in', async () => {
    vi.useFakeTimers();
    const now = () => Date.now();
    for (const order of [
      [800, 3000],
      [3000, 800],
    ]) {
      const buckets = order.map((kbps) => createBucket(kbps, { now }));
      const log: { name: string; bytes: number; at: number }[] = [];
      const c = consumer('x', createPacer(buckets), log);
      await vi.advanceTimersByTimeAsync(2000);
      await c.stop();
      const total = log.reduce((n, e) => n + e.bytes, 0);
      expect(total).toBeGreaterThan(CHUNK_BYTES + 100 * 2000 * 0.97);
      expect(total).toBeLessThan(CHUNK_BYTES + 100 * 2000 * 1.03);
    }
  });

  it('hands back what a contended bucket could not grant, so the slower bucket is not charged for it', async () => {
    vi.useFakeTimers();
    const now = () => Date.now();
    const slow = createBucket(800, { now });
    const fast = createBucket(3000, { now });
    tryTake(fast, CHUNK_BYTES - 2000); // the fast bucket has 2000 bytes left: less than its 5625-byte slice
    const pacer = createPacer([slow, fast]);
    const pending = pacer.take(CHUNK_BYTES);
    await vi.advanceTimersByTimeAsync(20);
    const granted = await pending;
    // The slow bucket granted 16384 at once. The fast one is woken after 10 ms (the first whole millisecond that makes a
    // slice) and grants 2000 + 10 * 375 = 5750, so 16384 - 5750 bytes go back to the slow one.
    expect(granted).toBe(5750);
    expect(bucketState(slow).tokens).toBeGreaterThanOrEqual(CHUNK_BYTES - 5750 + 10 * 100);
    expect(bucketState(slow).tokens).toBeLessThanOrEqual(CHUNK_BYTES);
    pacer.leave();
  });

  it('does not lose credit when its timer fires late: the long-run rate holds', async () => {
    const bucket = fakeBucket(3000); // 375 bytes per ms
    const pacer = createPacer([bucket]);
    await pacer.take(CHUNK_BYTES);
    const grants: number[] = [];
    const loop = (async () => {
      for (;;) {
        const bytes = await pacer.take(CHUNK_BYTES);
        if (bytes === 0) return;
        grants.push(bytes);
      }
    })();
    await vi.advanceTimersByTimeAsync(5); // the consumer is now waiting on the timer
    vi.setSystemTime(Date.now() + 400); // the event loop was blocked for 400 ms: the timer fires 400 ms late
    await vi.advanceTimersByTimeAsync(11);
    pacer.leave();
    await loop;
    // 400 ms + the 16 ms the timers did run are all owed: about 156 KB, paid out in chunks at once, not one slice of it.
    const total = grants.reduce((n, g) => n + g, 0);
    expect(total).toBeGreaterThan(375 * 400);
    expect(Math.max(...grants)).toBe(CHUNK_BYTES);
  });

  it('does not bank credit for a consumer that is simply not asking (back-pressure, a stall)', async () => {
    const bucket = fakeBucket(3000);
    const pacer = createPacer([bucket]);
    await pacer.take(CHUNK_BYTES);
    await vi.advanceTimersByTimeAsync(2000); // nobody asks for two seconds
    expect(await pacer.take(10 * CHUNK_BYTES)).toBe(CHUNK_BYTES);
    const next = pacer.take(10 * CHUNK_BYTES);
    expect(bucketState(bucket).waiting).toBe(1);
    pacer.leave();
    expect(await next).toBe(0);
  });

  it('forgets owed credit when the last consumer leaves', async () => {
    const bucket = fakeBucket(3000);
    const pacer = createPacer([bucket]);
    await pacer.take(CHUNK_BYTES);
    const waiting = pacer.take(CHUNK_BYTES);
    vi.setSystemTime(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(20);
    await waiting; // served late, with a large credit left over
    expect(bucketState(bucket).tokens).toBeGreaterThan(CHUNK_BYTES);
    pacer.leave();
    expect(bucketState(bucket).tokens).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('removing the head of the queue lets the next consumer be served on its own schedule', async () => {
    const bucket = fakeBucket(800);
    const big = createPacer([bucket]);
    const small = createPacer([bucket]);
    await big.take(CHUNK_BYTES); // burst spent
    const bigWait = big.take(CHUNK_BYTES); // needs a 1500-byte slice
    const smallWait = small.take(100); // needs only 100 bytes
    big.leave();
    expect(await bigWait).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await smallWait).toBe(100);
    small.leave();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// End to end: the bucket, the pacing, deliver(), a real socket and a real client that timestamps every read.
// ---------------------------------------------------------------------------------------------------------------------------

const BODY_500KB = Buffer.alloc(512_000, 0x2a); // the contract is for transfers of at least 500 KB

/** Bytes the client read in (from, to], as kilobits per second. */
function rateBetween(chunks: Chunk[], from: number, to: number): number {
  const bytes = chunks.filter((c) => c.t > from && c.t <= to).reduce((n, c) => n + c.bytes, 0);
  return (bytes * 8) / (to - from);
}

async function throttledServer(buckets: ReturnType<typeof createBucket>[], body: Buffer) {
  return deliveryServer(() => ({ input: { status: 200, headers: {}, body, plan: { buckets } } }));
}

describe.concurrent(
  'accuracy: goodput of a real client against the configured rate (contract: +-10 %)',
  () => {
    it.each([800, 1500, 3000])('%i kbps over 512000 bytes', async (kbps) => {
      const srv = await throttledServer([createBucket(kbps)], BODY_500KB);
      const got = await download(srv.port, '/');
      await srv.close();
      expect(got).toMatchObject({ status: 200, complete: true, bytes: BODY_500KB.length });

      const { steadyKbps, naiveKbps, spanMs } = goodput(got.chunks);
      console.info(
        `[throttle] ${kbps} kbps over ${got.bytes} bytes: measured ${steadyKbps.toFixed(1)} kbps from the first read to the last without the first read (${(steadyKbps / kbps).toFixed(3)} of configured), ${naiveKbps.toFixed(1)} kbps counting it (${(naiveKbps / kbps).toFixed(3)}); first read ${got.chunks[0]?.bytes} bytes, ${got.chunks.length} reads, ${spanMs.toFixed(0)} ms`,
      );
      for (const measured of [steadyKbps, naiveKbps]) {
        expect(measured).toBeGreaterThan(kbps * 0.9);
        expect(measured).toBeLessThan(kbps * 1.1);
      }
    });
  },
);

describe.concurrent('sharing: one bucket is one link', () => {
  it('two concurrent downloads on one bucket get half each, and together the whole rate', async () => {
    const srv = await throttledServer([createBucket(1500)], Buffer.alloc(250_000, 2));
    const [a, b] = await Promise.all([download(srv.port, '/a'), download(srv.port, '/b')]);
    await srv.close();
    // Only the stretch in which both were transferring counts: after both had started, until the first one finished.
    const from = Math.max(a.chunks[0]!.t, b.chunks[0]!.t);
    const to = Math.min(a.chunks.at(-1)!.t, b.chunks.at(-1)!.t);
    const [ra, rb] = [rateBetween(a.chunks, from, to), rateBetween(b.chunks, from, to)];
    console.info(
      `[throttle] two downloads on one 1500 kbps bucket: ${ra.toFixed(1)} and ${rb.toFixed(1)} kbps (each ${((ra / 1500) * 100).toFixed(1)} % and ${((rb / 1500) * 100).toFixed(1)} % of the rate), together ${(ra + rb).toFixed(1)} kbps, over ${(to - from).toFixed(0)} ms`,
    );
    expect(ra).toBeGreaterThan(750 * 0.8);
    expect(ra).toBeLessThan(750 * 1.2);
    expect(rb).toBeGreaterThan(750 * 0.8);
    expect(rb).toBeLessThan(750 * 1.2);
    expect(ra + rb).toBeGreaterThan(1500 * 0.9);
    expect(ra + rb).toBeLessThan(1500 * 1.1);
  });

  it('a short response (audio) is not starved behind a long one (video) on the same bucket', async () => {
    const bucket = createBucket(1500);
    const srv = await deliveryServer((req) => ({
      input: {
        status: 200,
        headers: {},
        body: Buffer.alloc(req.url === '/video' ? 400_000 : 60_000, 3),
        plan: { buckets: [bucket] },
      },
    }));
    const [video, audio] = await Promise.all([download(srv.port, '/video'), download(srv.port, '/audio')]);
    await srv.close();
    const audioDone = audio.chunks.at(-1)!.t;
    const videoByThen = video.chunks.filter((c) => c.t <= audioDone).reduce((n, c) => n + c.bytes, 0);
    const audioMs = audioDone - audio.startedAt;
    console.info(
      `[throttle] audio 60000 bytes next to video 400000 bytes on 1500 kbps: audio finished after ${audioMs.toFixed(0)} ms (alone it would take ${((60_000 * 8) / 1500).toFixed(0)} ms, behind the whole video ${(((400_000 + 60_000) * 8) / 1500).toFixed(0)} ms), video had ${videoByThen} bytes by then`,
    );
    expect(audioMs).toBeLessThan(((60_000 * 2 + CHUNK_BYTES) * 8) / 1500 + 150);
    expect(Math.abs(videoByThen - 60_000)).toBeLessThan(60_000 * 0.3 + CHUNK_BYTES);
  });

  it.each([
    [1500, 6000],
    [6000, 1500],
  ])('a response limited by %i and %i kbps runs at the slower one', async (first, second) => {
    const srv = await throttledServer([createBucket(first), createBucket(second)], Buffer.alloc(300_000, 4));
    const got = await download(srv.port, '/');
    await srv.close();
    const { steadyKbps } = goodput(got.chunks);
    console.info(
      `[throttle] one response behind ${first} and ${second} kbps: ${steadyKbps.toFixed(1)} kbps (the slower is 1500)`,
    );
    expect(steadyKbps).toBeGreaterThan(1500 * 0.9);
    expect(steadyKbps).toBeLessThan(1500 * 1.1);
  });

  it('two responses on two different buckets do not interfere', async () => {
    const slow = await throttledServer([createBucket(800)], Buffer.alloc(200_000, 5));
    const fast = await throttledServer([createBucket(3000)], Buffer.alloc(400_000, 6));
    const [a, b] = await Promise.all([download(slow.port, '/'), download(fast.port, '/')]);
    await Promise.all([slow.close(), fast.close()]);
    const [ra, rb] = [goodput(a.chunks).steadyKbps, goodput(b.chunks).steadyKbps];
    console.info(
      `[throttle] 800 and 3000 kbps buckets, transferring at the same time: ${ra.toFixed(1)} and ${rb.toFixed(1)} kbps`,
    );
    expect(ra).toBeGreaterThan(800 * 0.9);
    expect(ra).toBeLessThan(800 * 1.1);
    expect(rb).toBeGreaterThan(3000 * 0.9);
    expect(rb).toBeLessThan(3000 * 1.1);
  });

  it('gives the whole link to the one that stays when the other client leaves', async () => {
    const bucket = createBucket(1500);
    const srv = await throttledServer([bucket], Buffer.alloc(350_000, 7));
    const stayer = download(srv.port, '/stay');
    // the other client starts, reads for a while, then goes away
    let leftAt = 0;
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port: srv.port, agent: false, path: '/leave' }, (res) => {
        res.resume();
        setTimeout(() => {
          leftAt = performance.now();
          req.destroy();
          resolve();
        }, 400);
      });
      req.on('error', () => {});
      req.end();
    });
    const got = await stayer;
    await srv.close();
    // Allow one round of the queue for the departure to be noticed, then the remaining client has the link to itself.
    const alone = rateBetween(got.chunks, leftAt + 100, got.chunks.at(-1)!.t);
    console.info(
      `[throttle] after the other client left a 1500 kbps bucket, the one that stayed ran at ${alone.toFixed(1)} kbps`,
    );
    expect(alone).toBeGreaterThan(1500 * 0.9);
    expect(alone).toBeLessThan(1500 * 1.1);
    expect(bucketState(bucket)).toMatchObject({ waiting: 0, consumers: 0, timerArmed: false });
  });
});

// Alone on the event loop: the one measurement that another stream's timers could disturb.
describe('smoothness: a rate is a steady stream, not bursts', () => {
  it('1500 kbps: no silence longer than 150 ms between reads, and nothing bigger than the burst allowance goes out at once', async () => {
    const srv = await throttledServer([createBucket(1500)], Buffer.alloc(400_000, 1));
    const got = await download(srv.port, '/');
    await srv.close();
    const gaps = gapsMs(got.chunks);
    const largestRead = Math.max(...got.chunks.map((c) => c.bytes));
    console.info(
      `[throttle] 1500 kbps smoothness over ${got.chunks.length} reads: first read ${got.chunks[0]?.bytes} bytes (the burst allowance), largest read ${largestRead} bytes, gap between reads p50 ${percentile(gaps, 50).toFixed(1)} ms, p95 ${percentile(gaps, 95).toFixed(1)} ms, max ${Math.max(...gaps).toFixed(1)} ms`,
    );
    expect(Math.max(...gaps)).toBeLessThan(150);
    expect(largestRead).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(got.chunks[0]?.bytes).toBeLessThanOrEqual(CHUNK_BYTES);
  });
});

describe('the process can exit', () => {
  it('an idle bucket, or a consumer that joined and never asks, keeps nothing alive', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const program = `
      import { createBucket, createPacer } from './src/server/throttle.ts';
      const bucket = createBucket(800);
      const pacer = createPacer([bucket]);
      for (let i = 0; i < 3; i++) await pacer.take(16384); // real timers, real waits
      const silent = createPacer([bucket]); // joined and never asking
      pacer.leave();
      console.log('done');
    `;
    const started = performance.now();
    // execFileSync throws when the child is still alive at the timeout: that is the failure
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(out.trim()).toBe('done');
    console.info(
      `[throttle] a process that used and left a bucket exited on its own after ${(performance.now() - started).toFixed(0)} ms (including loading TypeScript)`,
    );
  });
});
