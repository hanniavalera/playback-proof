import { describe, expect, it } from 'vitest';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { QAMetrics } from '../../../src/shared/qa.ts';
import {
  BYTES_PER_MB,
  enableHeapProbe,
  exposeGc,
  readChromiumHeap,
  readHarnessMemory,
  residentMb,
} from '../../../src/lab/readiness/heap.ts';
import type { CdpLike } from '../../../src/lab/readiness/heap.ts';
import {
  RequestLogDigester,
  episodesOf,
  errorsOf,
  outageSegment,
  outageWindow,
  staleWindow,
} from '../../../src/lab/readiness/soak-data.ts';

// The pieces between the page, the origin and the evaluators: the conversion to the epoch axis, the origin's injected conditions as
// windows, the digest of a request log that is read in slices while requests are still in flight, and the two memory readings.

const ORIGIN = 1_760_000_000_000;

describe('the epoch axis', () => {
  const metrics = {
    rebuffer: { events: [{ startMs: 36_000, durationMs: 3900, mediaTime: 36, ongoing: false }] },
    errors: [
      {
        t: 40_000,
        code: 1001,
        category: 1,
        severity: 1,
        message: 'HTTP error status 404',
        codeName: 'BAD_HTTP_STATUS',
        source: 'shaka',
      },
      { t: 41_000, code: 0, category: 0, severity: 2, message: 'boom' },
    ],
  } as unknown as QAMetrics;

  it('places the stalls and the errors of the page, which count from its own zero, on the clock of the machine', () => {
    expect(episodesOf(metrics, ORIGIN)).toEqual([
      { startMs: ORIGIN + 36_000, durationMs: 3900, ongoing: false, mediaTime: 36 },
    ]);
    const [first, second] = errorsOf(metrics, ORIGIN);
    expect(first).toEqual({
      atMs: ORIGIN + 40_000,
      severity: 1,
      code: 1001,
      codeName: 'BAD_HTTP_STATUS',
      source: 'shaka',
      message: 'HTTP error status 404',
    });
    expect(second).toEqual({ atMs: ORIGIN + 41_000, severity: 2, code: 0, message: 'boom' });
  });

  it('puts an outage where the contract puts it: when segment atNumber is published, for as long as it lasts', () => {
    const ast = new Date(ORIGIN).toISOString();
    expect(outageSegment(15, 2.5, 2)).toBe(15 + 75);
    expect(outageSegment(15, 0.01, 2)).toBe(16);
    expect(outageWindow(ast, 90, 2, 10_000)).toEqual({
      kind: 'origin-stall',
      startMs: ORIGIN + 180_000,
      endMs: ORIGIN + 190_000,
    });
  });

  it('puts a stale manifest after the first media request, as the rule clock of the service does', () => {
    const first = new Date(ORIGIN + 700).toISOString();
    expect(staleWindow(first, 1_200_000, 10_000)).toEqual({
      kind: 'stale-manifest',
      startMs: ORIGIN + 700 + 1_200_000,
      endMs: ORIGIN + 700 + 1_210_000,
    });
  });
});

describe('RequestLogDigester', () => {
  const entry = (seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
    seq,
    t: new Date(ORIGIN + seq * 1000).toISOString(),
    msSinceStart: seq * 1000,
    method: 'GET',
    path: '/x',
    kind: 'segment',
    rep: 'v720',
    number: seq,
    status: 200,
    bytes: 1,
    ttfbMs: 1,
    totalMs: 1,
    faults: [],
    ...overrides,
  });
  const manifest = (seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry =>
    entry(seq, { kind: 'manifest', rep: undefined, number: undefined, ...overrides });
  const isManifest = (e: RequestLogEntry): boolean => e.kind === 'manifest';

  it('counts what the origin got wrong and not what the client gave up on', () => {
    const digester = new RequestLogDigester(isManifest);
    digester.absorb([
      entry(1),
      entry(2, { status: 404 }),
      entry(3, { aborted: true, abortReason: 'client-closed' }),
      entry(4, { aborted: true, abortReason: 'fault-abort' }),
      entry(5, { status: 503, kind: 'init', number: undefined }),
    ]);
    const digest = digester.digest();
    expect(digest.total).toBe(5);
    expect(digest.refusedCount).toBe(3);
    expect(digest.refused.map((r) => r.status)).toEqual([404, 200, 503]);
    expect(digest.byKind).toEqual({ segment: 4, init: 1 });
    expect(digester.cursor).toBe(5);
  });

  it('notes a manifest request when it arrives and its answer when it has finished, once each, and holds the cursor before a request in flight', () => {
    const digester = new RequestLogDigester(isManifest);
    digester.absorb([manifest(1), manifest(2, { pending: true, status: 0 }), entry(3)]);
    expect(digester.manifestArrivalsMs()).toEqual([ORIGIN + 1000, ORIGIN + 2000]);
    expect(digester.digest().total).toBe(2);
    // The cursor stops before request 2, which is still in flight, so that the next slice returns it again, finished.
    expect(digester.cursor).toBe(1);
    digester.absorb([manifest(2), entry(3), manifest(4)]);
    expect(digester.manifestArrivalsMs()).toEqual([ORIGIN + 1000, ORIGIN + 2000, ORIGIN + 4000]);
    expect(digester.digest().total).toBe(4);
    expect(digester.cursor).toBe(4);
    // A slice read twice is not counted twice.
    digester.absorb([manifest(4), entry(3)]);
    expect(digester.digest().total).toBe(4);
    expect(digester.manifestArrivalsMs()).toHaveLength(3);
  });

  it('lists the segments the player asked for more than once', () => {
    const digester = new RequestLogDigester(isManifest);
    digester.absorb([
      entry(1, { number: 7 }),
      entry(2, { number: 8 }),
      entry(3, { number: 7 }),
      entry(4, { number: 7 }),
      entry(5, { rep: 'a-aac', number: 7 }),
    ]);
    expect(digester.digest().repeated).toEqual([{ rep: 'v720', number: 7, times: 3 }]);
  });

  it('keeps the first refusals and counts every one', () => {
    const digester = new RequestLogDigester(isManifest);
    digester.absorb(Array.from({ length: 80 }, (_, i) => entry(i + 1, { status: 404 })));
    const digest = digester.digest();
    expect(digest.refusedCount).toBe(80);
    expect(digest.refused).toHaveLength(50);
  });

  it('can pick the audio playlist of an HLS session as the series of refreshes', () => {
    const digester = new RequestLogDigester((e) => e.kind === 'manifest' && e.rep === 'a-aac');
    digester.absorb([manifest(1), manifest(2, { rep: 'v360' }), manifest(3, { rep: 'a-aac' })]);
    expect(digester.manifestArrivalsMs()).toEqual([ORIGIN + 3000]);
  });
});

describe('the heap of the page', () => {
  function cdp(metrics: Array<{ name: string; value: number }>): { session: CdpLike; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      session: {
        async send(method) {
          calls.push(method);
          return method === 'Performance.getMetrics' ? { metrics } : {};
        },
      },
    };
  }

  it('collects the garbage first and only then reads the heap, in MB, with the nodes and listeners that say what grew', async () => {
    const { session, calls } = cdp([
      { name: 'JSHeapUsedSize', value: 15 * BYTES_PER_MB },
      { name: 'Nodes', value: 321 },
      { name: 'JSEventListeners', value: 45 },
    ]);
    await enableHeapProbe(session);
    const read = await readChromiumHeap(session, () => ORIGIN);
    expect(calls).toEqual(['Performance.enable', 'HeapProfiler.collectGarbage', 'Performance.getMetrics']);
    expect(read).toEqual({ atMs: ORIGIN, usedMb: 15, nodes: 321, listeners: 45 });
  });

  it('refuses to invent a number when the page does not report the heap', async () => {
    const { session } = cdp([{ name: 'Nodes', value: 1 }]);
    await expect(readChromiumHeap(session, () => 0)).rejects.toThrow(
      /did not report JSHeapUsedSize \(it reported: Nodes\)/,
    );
    const nan = cdp([{ name: 'JSHeapUsedSize', value: Number.NaN }]);
    await expect(readChromiumHeap(nan.session, () => 0)).rejects.toThrow(/JSHeapUsedSize/);
  });
});

describe('the harness memory', () => {
  it('reads the resident size of a process, and nothing for one that is not there', async () => {
    const mine = await residentMb(process.pid);
    expect(mine).toBeGreaterThan(10);
    expect(await residentMb(2_147_483_000)).toBeNull();
  });

  it('collects before it reads its own heap when it can, and reads the service by its pid', async () => {
    let collected = 0;
    const sample = await readHarnessMemory({
      nowMs: () => ORIGIN,
      servicePid: process.pid,
      gc: () => void (collected += 1),
    });
    expect(collected).toBe(1);
    expect(sample.heapUsedMb).toBeGreaterThan(1);
    expect(sample.rssMb).toBeGreaterThan(sample.heapUsedMb);
    expect(sample.serviceRssMb).toBeGreaterThan(10);
    expect(sample.atMs).toBe(ORIGIN);
    expect((await readHarnessMemory({ nowMs: () => 0, servicePid: null })).serviceRssMb).toBeNull();
  });

  it('can get a collector without the --expose-gc flag, and it works', () => {
    const gc = exposeGc();
    expect(typeof gc).toBe('function');
    expect(() => gc?.()).not.toThrow();
  });
});
