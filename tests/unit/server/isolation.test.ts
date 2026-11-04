import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import { initPath, segmentPath } from '../../../src/shared/urls.ts';
import { download, goodput } from '../support/delivery.ts';
import {
  FAKE_AUDIO,
  FAKE_LIVE,
  FAKE_VIDEO,
  FAKE_VOD,
  FAKE_WEBM,
  describeBuffer,
  parseManifest,
} from './fake-media.ts';
import { call, createSession, detailOf, logOf, startHarness, waitForLog } from './harness.ts';
import type { Harness } from './harness.ts';

// "A session isolates everything: its own live clock, fault rules, token bucket and request log. Tests are therefore independent and
// can run in parallel" (docs/CONTRACTS.md section 4). Every test here makes two or more sessions disagree and checks that each one only
// ever sees its own world.

describe('isolation between sessions', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ media: { segmentBytes: 120_000 } });
  });
  afterEach(async () => {
    await h.close();
  });

  const seg = (s: SessionInfo, n: number, rep = FAKE_VIDEO): string =>
    segmentPath(s.id, s.stream, rep, n, 'm4s');

  it('keeps the faults of one session away from another on the same stream, even when they ask for the same segment at once', async () => {
    const a = await createSession(h, {
      stream: FAKE_VOD,
      faults: [
        { type: 'abort', afterBytes: 10, match: { kind: 'segment', number: 1 } },
        { type: 'status', status: 503, match: { kind: 'segment', number: 2 } },
        { type: 'latency', ms: 100, match: { kind: 'manifest' } },
      ],
    });
    const b = await createSession(h, { stream: FAKE_VOD });
    const [cutA, fullB] = await Promise.all([
      download(h.port, seg(a, 1)),
      download(h.port, seg(b, 1), { keepBody: true }),
    ]);
    expect(cutA.bytes).toBe(10);
    expect(cutA.complete).toBe(false);
    expect(fullB.complete).toBe(true);
    expect(fullB.body?.equals(h.media.segment(FAKE_VOD, FAKE_VIDEO, 1) ?? Buffer.alloc(0))).toBe(true);
    expect((await call(h.origin, 'GET', seg(a, 2))).status).toBe(503);
    expect((await call(h.origin, 'GET', seg(b, 2))).status).toBe(200);
    const slow = await download(h.port, a.manifestUrl);
    const quick = await download(h.port, b.manifestUrl);
    expect(slow.headAt - slow.startedAt).toBeGreaterThanOrEqual(100);
    expect(quick.status).toBe(200);
    expect(
      (await logOf(h, b.id)).every((entry) => entry.faults.length === 0 && entry.aborted === undefined),
    ).toBe(true);
    expect((await detailOf(h, b.id)).faults).toEqual([]);
    expect((await detailOf(h, a.id)).faults).toHaveLength(3);
  });

  it('gives each session its own throttle: a bucket is never shared between sessions', async () => {
    const rule = { type: 'throttle', kbps: 1600, match: { kind: 'segment' } } as const;
    const a = await createSession(h, { stream: FAKE_VOD, faults: [rule] });
    const b = await createSession(h, { stream: FAKE_VOD, faults: [rule] });
    const started = performance.now();
    const [da, db] = await Promise.all([download(h.port, seg(a, 1)), download(h.port, seg(b, 1))]);
    // Two sessions on one bucket would take twice as long and each would see half the rate.
    for (const d of [da, db]) {
      expect(goodput(d.chunks).steadyKbps).toBeGreaterThan(1600 * 0.85);
      expect(goodput(d.chunks).steadyKbps).toBeLessThan(1600 * 1.15);
    }
    expect(Math.max(...[da, db].map((d) => d.chunks.at(-1)?.t ?? 0)) - started).toBeLessThan(1000);
  });

  it('gives each live session its own clock, its own stalls and its own stale manifests', async () => {
    const stalled = await createSession(h, { stream: FAKE_LIVE });
    const stale = await createSession(h, { stream: FAKE_LIVE });
    const healthy = await createSession(h, { stream: FAKE_LIVE });
    expect((await call(h.origin, 'GET', seg(stale, 15))).status).toBe(200);
    const before = (await call(h.origin, 'GET', stale.manifestUrl)).text;
    await call(h.origin, 'POST', `/api/sessions/${stalled.id}/faults`, {
      body: { rules: [{ type: 'live-stall', atNumber: 16, ms: 3_600_000 }] },
    });
    await call(h.origin, 'POST', `/api/sessions/${stale.id}/faults`, {
      body: { rules: [{ type: 'manifest-stale', ms: 3_600_000 }] },
    });
    h.clock.advance(20_000);
    const last = async (s: SessionInfo): Promise<string | undefined> =>
      parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text).last;
    expect(await last(stalled)).toBe('16');
    expect(await last(healthy)).toBe('25');
    expect(await last(stale)).toBe('15');
    expect((await call(h.origin, 'GET', stale.manifestUrl)).text).toBe(before);
    expect((await call(h.origin, 'GET', seg(stalled, 17))).status).toBe(404);
    expect((await call(h.origin, 'GET', seg(healthy, 17))).status).toBe(200);
    expect((await call(h.origin, 'GET', seg(stale, 17))).status).toBe(200);
    expect((await detailOf(h, stalled.id)).live?.stalled).toBe(true);
    expect((await detailOf(h, healthy.id)).live?.stalled).toBe(false);
  });

  it('keeps every log to its own session, and does not let a session answer for another one’s stream', async () => {
    const vod = await createSession(h, { stream: FAKE_VOD });
    const webm = await createSession(h, { stream: FAKE_WEBM });
    await call(h.origin, 'GET', seg(vod, 1));
    await call(h.origin, 'GET', segmentPath(webm.id, webm.stream, FAKE_VIDEO, 1, 'webm'));
    await call(h.origin, 'GET', segmentPath(webm.id, webm.stream, FAKE_VIDEO, 2, 'webm'));
    expect((await logOf(h, vod.id)).map((e) => e.path)).toEqual([seg(vod, 1)]);
    expect((await logOf(h, webm.id)).map((e) => e.number)).toEqual([1, 2]);
    // a session id with the stream of another session: not a resource of that session
    expect((await call(h.origin, 'GET', `/s/${vod.id}/${FAKE_WEBM}/seg/v360/1.webm`)).status).toBe(404);
    expect((await call(h.origin, 'GET', `/s/${webm.id}/${FAKE_VOD}/seg/v360/1.m4s`)).status).toBe(404);
  });

  it('lets a response that is being written finish when its session is deleted, and forgets the session at once', async () => {
    const a = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 3200, match: { kind: 'segment' } }],
    });
    const b = await createSession(h, { stream: FAKE_VOD });
    const running = download(h.port, seg(a, 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await call(h.origin, 'DELETE', `/api/sessions/${a.id}`)).status).toBe(204);
    expect((await call(h.origin, 'GET', seg(a, 2))).status).toBe(404);
    expect((await call(h.origin, 'GET', seg(b, 2))).status).toBe(200);
    const finished = await running;
    expect(finished.complete).toBe(true);
    expect(finished.bytes).toBe(120_000);
  });
});

describe('20 sessions in parallel', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  /** What session `i` is and what it must see: four kinds of session, each with a rule or a clock that is only its own. */
  function scenario(i: number): { request: SessionRequest; run(s: SessionInfo): Promise<number> } {
    const seg = (s: SessionInfo, n: number, rep: string, ext = 'm4s'): string =>
      segmentPath(s.id, s.stream, rep, n, ext);
    switch (i % 4) {
      case 0: {
        const target = (i % 6) + 1;
        return {
          request: {
            stream: FAKE_VOD,
            faults: [
              {
                type: 'status',
                status: 500 + i,
                match: { kind: 'segment', rep: FAKE_VIDEO, number: target },
              },
            ],
          },
          async run(s) {
            const numbers = [1, 2, 3, 4, 5, 6];
            const replies = await Promise.all(
              numbers.flatMap((n) =>
                [FAKE_VIDEO, FAKE_AUDIO].map((rep) => call(h.origin, 'GET', seg(s, n, rep))),
              ),
            );
            replies.forEach((reply, k) => {
              const n = numbers[Math.floor(k / 2)] ?? 0;
              const rep = k % 2 === 0 ? FAKE_VIDEO : FAKE_AUDIO;
              if (rep === FAKE_VIDEO && n === target) {
                expect(reply.status, `session ${i} segment ${n}`).toBe(500 + i);
              } else {
                expect(reply.status, `session ${i} ${rep} ${n}`).toBe(200);
                expect(describeBuffer(reply.bytes)).toMatchObject({
                  stream: FAKE_VOD,
                  rep,
                  number: n,
                  live: false,
                });
              }
            });
            return replies.length;
          },
        };
      }
      case 1:
        return {
          request: {
            stream: FAKE_VOD,
            faults: [{ type: 'latency', ms: 40 + i, match: { kind: 'manifest' } }],
          },
          async run(s) {
            const manifest = await download(h.port, s.manifestUrl);
            expect(manifest.headAt - manifest.startedAt, `session ${i}`).toBeGreaterThanOrEqual(40 + i);
            const [first, second] = await Promise.all([
              call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4')),
              call(h.origin, 'GET', seg(s, 3, FAKE_AUDIO)),
            ]);
            expect([first.status, second.status]).toEqual([200, 200]);
            return 3;
          },
        };
      case 2: {
        const target = (Math.floor(i / 4) % 4) + 1;
        return {
          request: {
            stream: FAKE_WEBM,
            faults: [{ type: 'abort', afterBytes: 50 + i, match: { kind: 'segment', number: target } }],
          },
          async run(s) {
            const cut = await download(h.port, seg(s, target, FAKE_VIDEO, 'webm'));
            expect(cut.bytes, `session ${i}`).toBe(50 + i);
            expect(cut.complete).toBe(false);
            const other = await download(h.port, seg(s, (target % 4) + 1, FAKE_VIDEO, 'webm'));
            expect(other.complete).toBe(true);
            expect(other.bytes).toBe(600);
            return 2;
          },
        };
      }
      default: {
        const edge = i + 1;
        return {
          request: { stream: FAKE_LIVE, live: { startOffsetSec: 2 * edge } },
          async run(s) {
            const manifest = parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text);
            expect(manifest, `session ${i}`).toMatchObject({
              last: String(edge),
              first: String(Math.max(1, edge - 14)),
            });
            const atEdge = await call(h.origin, 'GET', seg(s, edge, FAKE_VIDEO));
            expect(atEdge.status).toBe(200);
            expect(describeBuffer(atEdge.bytes)).toMatchObject({ number: edge, live: true });
            expect((await call(h.origin, 'GET', seg(s, edge + 1, FAKE_VIDEO))).status).toBe(404);
            return 3;
          },
        };
      }
    }
  }

  it('keeps 20 sessions with 20 different rules and clocks apart: each sees exactly its own world, and its own log', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const { request, run } = scenario(i);
        const s = await createSession(h, request);
        const requests = await run(s);
        return { i, s, requests };
      }),
    );
    expect(new Set(results.map((r) => r.s.id)).size).toBe(20);
    for (const { i, s, requests } of results) {
      // the entry of a response the service cut is completed a moment after the client saw the cut
      const log = await waitForLog(
        h,
        s.id,
        (entries) => entries.length === requests && entries.every((entry) => !entry.pending),
      );
      expect(
        log.every((entry) => entry.path.startsWith(`/s/${s.id}/`)),
        `session ${i}`,
      ).toBe(true);
      // `seq` is per session: it starts at 1 in every log
      expect(log.map((entry) => entry.seq)).toEqual(Array.from({ length: requests }, (_, k) => k + 1));
      const detail = await detailOf(h, s.id);
      expect(detail.faults.length, `session ${i}`).toBe(i % 4 === 3 ? 0 : 1);
      expect(detail.counters.requests, `session ${i}`).toBe(requests);
    }
  });
});
