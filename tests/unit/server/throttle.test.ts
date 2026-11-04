import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_BYTES,
  bucketState,
  createBucket,
  createPacer,
  msUntilTake,
  tryTake,
} from '../../../src/server/throttle.ts';

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
