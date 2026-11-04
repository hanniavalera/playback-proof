import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../../src/shared/api.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import { initPath, segmentPath } from '../../../src/shared/urls.ts';
import { jitterUnit } from '../../../src/server/faults.ts';
import { download, goodput } from '../support/delivery.ts';
import type { Download } from '../support/delivery.ts';
import { FAKE_AUDIO, FAKE_LIVE, FAKE_VIDEO, FAKE_VOD, describeBuffer, parseManifest } from './fake-media.ts';
import { call, createSession, detailOf, logOf, startHarness, waitForLog } from './harness.ts';
import type { Harness } from './harness.ts';

// Every fault type of docs/CONTRACTS.md section 5 through real HTTP: what the client sees, and what the request log says about it.
// Anything that depends on the clock of the service (afterMs, forMs, the live edge, live-stall, manifest-stale) uses the manual
// clock; delays and rates are measured by the client and asserted as bounds the contract promises.

function ended(d: Download): number {
  return Math.max(d.startedAt, ...d.chunks.map((c) => c.t));
}

describe('faults on the VOD pipeline', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  const vod = (faults: FaultRule[]): Promise<SessionInfo> => createSession(h, { stream: FAKE_VOD, faults });
  const seg = (s: SessionInfo, n: number, rep = FAKE_VIDEO): string =>
    segmentPath(s.id, s.stream, rep, n, 'm4s');

  describe('status', () => {
    it('answers the requests a rule matches with that status and an empty body, and leaves the others alone', async () => {
      const s = await vod([{ type: 'status', status: 503, match: { kind: 'segment', number: 2 } }]);
      const failed = await call(h.origin, 'GET', seg(s, 2));
      expect(failed.status).toBe(503);
      expect(failed.bytes.length).toBe(0);
      expect(failed.headers.get('content-length')).toBe('0');
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
      expect((await call(h.origin, 'GET', seg(s, 2, FAKE_AUDIO))).status).toBe(503);
      expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(200);
      expect((await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4'))).status).toBe(200);
      expect((await logOf(h, s.id)).map((e) => [e.status, e.faults])).toEqual([
        [503, ['f1']],
        [200, []],
        [503, ['f1']],
        [200, []],
        [200, []],
      ]);
    });

    it('can answer a manifest with an error, with the status of the rule and the session counting it as an error', async () => {
      const s = await vod([{ type: 'status', status: 500, match: { kind: 'manifest' } }]);
      expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(500);
      expect((await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/v360.m3u8`)).status).toBe(500);
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
      expect((await detailOf(h, s.id)).counters).toMatchObject({ requests: 3, errors: 2 });
    });

    it('wins over a resource that does not exist: an origin that is failing fails for every path', async () => {
      const s = await vod([{ type: 'status', status: 502, match: { kind: 'segment' } }]);
      expect((await call(h.origin, 'GET', seg(s, 99))).status).toBe(502);
      expect((await call(h.origin, 'GET', seg(s, 1, 'v999'))).status).toBe(502);
    });

    it('stops after `times` matching requests', async () => {
      const s = await vod([{ type: 'status', status: 503, match: { kind: 'segment' }, times: 2 }]);
      const statuses: number[] = [];
      for (const n of [1, 2, 3, 4]) statuses.push((await call(h.origin, 'GET', seg(s, n))).status);
      expect(statuses).toEqual([503, 503, 200, 200]);
      expect((await logOf(h, s.id)).map((e) => e.faults)).toEqual([['f1'], ['f1'], [], []]);
    });

    it('applies the latency of the rules that fire with it, and ignores the faults that need a body', async () => {
      const s = await vod([
        { type: 'status', status: 500, match: { kind: 'segment' } },
        { type: 'latency', ms: 150, match: { kind: 'segment' } },
        // these would hold a response open for ten seconds or cut it: there is no body for them to act on
        { type: 'stall', afterBytes: 0, ms: 10_000, match: { kind: 'segment' } },
        { type: 'abort', afterBytes: 0, match: { kind: 'segment' } },
        { type: 'throttle', kbps: 1, match: { kind: 'segment' } },
      ]);
      // a keep-alive client, like a browser: it does not hang up when it has the head of a response without a body, so a stall
      // or a cut on that response would be visible in the log (a client that closes the connection would hide them)
      const started = performance.now();
      const reply = await call(h.origin, 'GET', seg(s, 1));
      const answeredMs = performance.now() - started;
      expect(reply.status).toBe(500);
      expect(reply.bytes.length).toBe(0);
      expect(answeredMs).toBeGreaterThanOrEqual(150);
      expect(answeredMs).toBeLessThan(2000);
      const [entry] = await waitForLog(h, s.id, (entries) => entries[0]?.pending === false, 1500);
      expect(entry).toMatchObject({ status: 500, faults: ['f1', 'f2', 'f3', 'f4', 'f5'], bytes: 0 });
      expect(entry?.aborted).toBeUndefined();
      expect(entry?.totalMs).toBeLessThan(1500);
    });

    it('answers a HEAD request with the status too, and a HEAD counts toward `times` like a GET', async () => {
      const s = await vod([{ type: 'status', status: 410, match: { kind: 'segment' }, times: 1 }]);
      const head = await call(h.origin, 'HEAD', seg(s, 1));
      expect(head.status).toBe(410);
      expect(head.headers.get('content-length')).toBe('0');
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
    });
  });

  describe('latency', () => {
    it('delays the first byte by the configured time and logs a time to first byte at least that long', async () => {
      const s = await vod([{ type: 'latency', ms: 200, match: { kind: 'segment' } }]);
      const slow = await download(h.port, seg(s, 1));
      expect(slow.status).toBe(200);
      expect(slow.complete).toBe(true);
      expect(slow.headAt - slow.startedAt).toBeGreaterThanOrEqual(200);
      const quick = await call(h.origin, 'GET', s.manifestUrl);
      expect(quick.status).toBe(200);
      const [first, second] = await logOf(h, s.id);
      expect(first?.ttfbMs).toBeGreaterThanOrEqual(200);
      expect(first?.faults).toEqual(['f1']);
      expect(second?.faults).toEqual([]);
    });

    it('adds up the delays of several latency rules that fire on one request', async () => {
      const s = await vod([
        { type: 'latency', ms: 90, match: { kind: 'segment' } },
        { type: 'latency', ms: 90, match: { kind: 'segment', rep: FAKE_VIDEO } },
      ]);
      const reply = await download(h.port, seg(s, 1));
      expect(reply.headAt - reply.startedAt).toBeGreaterThanOrEqual(180);
      expect((await logOf(h, s.id))[0]?.faults).toEqual(['f1', 'f2']);
    });

    it('draws the jitter from (session id, request seq, rule id): the delay of each request can be computed', async () => {
      const s = await vod([{ type: 'latency', ms: 120, jitterMs: 100, match: { kind: 'segment' } }]);
      const delays: number[] = [];
      for (let n = 1; n <= 4; n++) {
        const seq = n;
        const expected = Math.max(0, 120 + jitterUnit(s.id, seq, 'f1') * 100);
        delays.push(expected);
        const reply = await download(h.port, seg(s, n));
        expect(reply.headAt - reply.startedAt, `request ${seq}`).toBeGreaterThanOrEqual(expected);
      }
      const entries = await logOf(h, s.id);
      entries.forEach((entry, i) => {
        expect(entry.seq).toBe(i + 1);
        expect(entry.ttfbMs).toBeGreaterThanOrEqual(delays[i] ?? Infinity);
      });
      // the draws differ between requests, and stay inside ms +- jitter
      expect(new Set(delays).size).toBe(4);
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(20);
      expect(Math.max(...delays)).toBeLessThanOrEqual(220);
    });
  });

  describe('abort', () => {
    it('sends afterBytes of the body and then destroys the connection: the client sees a premature close', async () => {
      const s = await vod([{ type: 'abort', afterBytes: 100, match: { kind: 'segment', number: 3 } }]);
      const cut = await download(h.port, seg(s, 3), { keepBody: true });
      expect(cut.status).toBe(200);
      expect(cut.headers['content-length']).toBe('600');
      expect(cut.bytes).toBe(100);
      expect(cut.complete).toBe(false);
      expect(cut.error).toBeDefined();
      expect(
        cut.body?.equals(h.media.segment(FAKE_VOD, FAKE_VIDEO, 3)?.subarray(0, 100) ?? Buffer.alloc(0)),
      ).toBe(true);
      const entries = await waitForLog(h, s.id, (e) => e.length === 1 && e[0]?.pending === false);
      expect(entries[0]).toMatchObject({
        status: 200,
        bytes: 100,
        aborted: true,
        pending: false,
        faults: ['f1'],
      });
      expect((await detailOf(h, s.id)).counters).toMatchObject({ requests: 1, errors: 1 });
    });

    it('cuts after the head when afterBytes is not given, and keeps serving the other requests', async () => {
      const s = await vod([{ type: 'abort', match: { kind: 'segment', number: 1 } }]);
      const cut = await download(h.port, seg(s, 1));
      expect(cut.status).toBe(200);
      expect(cut.bytes).toBe(0);
      expect(cut.complete).toBe(false);
      const ok = await download(h.port, seg(s, 2), { keepBody: true });
      expect(ok.complete).toBe(true);
      expect(ok.bytes).toBe(600);
      expect((await call(h.origin, 'GET', '/health')).status).toBe(200);
    });

    it('sends the whole body when afterBytes is beyond it, then closes: a complete response on a connection that dies', async () => {
      const s = await vod([{ type: 'abort', afterBytes: 100_000, match: { kind: 'segment' } }]);
      const reply = await download(h.port, seg(s, 1));
      expect(reply.bytes).toBe(600);
      const entries = await waitForLog(h, s.id, (e) => e.length === 1 && e[0]?.pending === false);
      expect(entries[0]).toMatchObject({ bytes: 600, aborted: true });
    });
  });

  describe('stall', () => {
    it('sends afterBytes, then pauses for ms, then finishes the body', async () => {
      const s = await vod([{ type: 'stall', afterBytes: 200, ms: 300, match: { kind: 'segment' } }]);
      const reply = await download(h.port, seg(s, 1), { keepBody: true });
      expect(reply.complete).toBe(true);
      expect(reply.bytes).toBe(600);
      expect(reply.body?.equals(h.media.segment(FAKE_VOD, FAKE_VIDEO, 1) ?? Buffer.alloc(0))).toBe(true);
      let seen = 0;
      let at = -1;
      reply.chunks.forEach((chunk, i) => {
        seen += chunk.bytes;
        if (at === -1 && seen >= 200) at = i;
      });
      expect(seen).toBe(600);
      const before = reply.chunks[at];
      const after = reply.chunks[at + 1];
      expect(before && after).toBeTruthy();
      expect((after?.t ?? 0) - (before?.t ?? 0)).toBeGreaterThanOrEqual(295);
      const [entry] = await logOf(h, s.id);
      expect(entry).toMatchObject({ status: 200, bytes: 600, faults: ['f1'], pending: false });
      expect(entry?.totalMs).toBeGreaterThanOrEqual(300);
    });
  });

  describe('afterMs, forMs and times', () => {
    it('measures afterMs and forMs from the first media request: not from the session, not from a manifest', async () => {
      const s = await vod([
        { type: 'status', status: 503, match: { kind: 'segment' }, afterMs: 5000, forMs: 3000 },
      ]);
      h.clock.advance(60_000);
      expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(200);
      h.clock.advance(60_000);
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
      const statusAfter = async (ms: number): Promise<number> => {
        h.clock.advance(ms);
        return (await call(h.origin, 'GET', seg(s, 1))).status;
      };
      expect(await statusAfter(4999)).toBe(200);
      expect(await statusAfter(1)).toBe(503);
      expect(await statusAfter(2999)).toBe(503);
      expect(await statusAfter(1)).toBe(200);
      expect(await statusAfter(10_000)).toBe(200);
    });

    it('keeps a rule with afterMs > 0 quiet until a media request has started the clock, and a rule with afterMs 0 active', async () => {
      const s = await vod([
        { type: 'status', status: 503, match: { kind: 'manifest' }, afterMs: 1 },
        { type: 'status', status: 504, match: { kind: 'manifest', rep: 'v360' } },
      ]);
      h.clock.advance(10_000);
      expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(200);
      expect((await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/v360.m3u8`)).status).toBe(504);
      expect((await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4'))).status).toBe(200);
      h.clock.advance(1);
      expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(503);
    });

    it('counts `times` per rule: the first N matching requests, then the rule goes quiet', async () => {
      const s = await vod([
        { type: 'status', status: 503, match: { kind: 'segment', rep: FAKE_VIDEO }, times: 1 },
        { type: 'status', status: 500, match: { kind: 'segment', rep: FAKE_AUDIO }, times: 2 },
      ]);
      const got: number[] = [];
      for (const [rep, n] of [
        [FAKE_AUDIO, 1],
        [FAKE_VIDEO, 1],
        [FAKE_AUDIO, 2],
        [FAKE_VIDEO, 2],
        [FAKE_AUDIO, 3],
      ] as const)
        got.push((await call(h.origin, 'GET', seg(s, n, rep))).status);
      expect(got).toEqual([500, 503, 500, 200, 200]);
    });
  });

  describe('rules that are added, replaced and removed while the session runs', () => {
    it('applies a rule from the next request on, and stops applying it when it is removed or replaced', async () => {
      const s = await vod([]);
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
      await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'status', status: 503, match: { kind: 'segment' }, id: 'down' }] },
      });
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(503);
      await call(h.origin, 'PUT', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'status', status: 404, match: { kind: 'segment' }, id: 'gone' }] },
      });
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(404);
      await call(h.origin, 'DELETE', `/api/sessions/${s.id}/faults/gone`);
      expect((await call(h.origin, 'GET', seg(s, 1))).status).toBe(200);
      expect((await logOf(h, s.id)).map((e) => e.faults)).toEqual([[], ['down'], ['gone'], []]);
    });
  });
});

describe('throttle', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ media: { segmentBytes: 120_000 } });
  });
  afterEach(async () => {
    await h.close();
  });

  const seg = (s: SessionInfo, n: number, rep = FAKE_VIDEO): string =>
    segmentPath(s.id, s.stream, rep, n, 'm4s');

  it('limits the body of a response to the configured rate, measured by the client', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 1600, match: { kind: 'segment' } }],
    });
    const reply = await download(h.port, seg(s, 1), { keepBody: true });
    expect(reply.complete).toBe(true);
    expect(reply.bytes).toBe(120_000);
    expect(reply.body?.equals(h.media.segment(FAKE_VOD, FAKE_VIDEO, 1) ?? Buffer.alloc(0))).toBe(true);
    const { steadyKbps } = goodput(reply.chunks);
    expect(steadyKbps).toBeGreaterThan(1600 * 0.9);
    expect(steadyKbps).toBeLessThan(1600 * 1.1);
    const [entry] = await logOf(h, s.id);
    expect(entry).toMatchObject({ status: 200, bytes: 120_000, faults: ['f1'] });
    // 120 kB at 200 kB/s is 0.6 s, less the burst allowance
    expect(entry?.totalMs).toBeGreaterThan(450);
  });

  it('shares the bucket of a rule between the concurrent responses of one session: audio and video compete for one link', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 1600, match: { kind: 'segment' } }],
    });
    const started = performance.now();
    const [video, audio] = await Promise.all([
      download(h.port, seg(s, 1, FAKE_VIDEO)),
      download(h.port, seg(s, 1, FAKE_AUDIO)),
    ]);
    expect(video.bytes + audio.bytes).toBe(240_000);
    const spanMs = Math.max(ended(video), ended(audio)) - started;
    // One 1600 kbps link carries 240 kB in 1.12 s (less the burst). Two private buckets would finish both in 0.52 s.
    expect(spanMs).toBeGreaterThan(900);
    const sumKbps = ((video.bytes + audio.bytes) * 8) / spanMs;
    expect(sumKbps).toBeGreaterThan(1600 * 0.85);
    expect(sumKbps).toBeLessThan(1600 * 1.15);
    // each gets about half of the link: they finish within a quarter of the span of each other
    expect(Math.abs(ended(video) - ended(audio))).toBeLessThan(spanMs / 4);
  });

  it('does not slow another session down: each session has its own link', async () => {
    const slow = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 800, match: { kind: 'segment' } }],
    });
    const free = await createSession(h, { stream: FAKE_VOD });
    const startedSlow = performance.now();
    const slowDownload = download(h.port, seg(slow, 1));
    const fast = await download(h.port, seg(free, 1));
    const fastMs = ended(fast) - startedSlow;
    expect(fast.bytes).toBe(120_000);
    expect(fastMs).toBeLessThan(400);
    const slowDone = await slowDownload;
    // 120 kB at 100 kB/s: more than a second, so the fast download was long over
    expect(ended(slowDone) - startedSlow).toBeGreaterThan(900);
  });

  it('limits only what the rule matches', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [{ type: 'throttle', kbps: 1600, match: { kind: 'segment', rep: FAKE_VIDEO } }],
    });
    const started = performance.now();
    const [video, audio] = await Promise.all([
      download(h.port, seg(s, 1, FAKE_VIDEO)),
      download(h.port, seg(s, 1, FAKE_AUDIO)),
    ]);
    expect(ended(audio) - started).toBeLessThan((ended(video) - started) / 2);
    expect((await logOf(h, s.id)).map((e) => [e.rep, e.faults])).toEqual(
      expect.arrayContaining([
        [FAKE_VIDEO, ['f1']],
        [FAKE_AUDIO, []],
      ]),
    );
  });

  it('limits a response by every throttle rule that matches it: the slowest wins', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [
        { type: 'throttle', kbps: 6400, match: { kind: 'segment' } },
        { type: 'throttle', kbps: 1600, match: { kind: 'segment' } },
      ],
    });
    const reply = await download(h.port, seg(s, 1));
    const { steadyKbps } = goodput(reply.chunks);
    expect(steadyKbps).toBeGreaterThan(1600 * 0.9);
    expect(steadyKbps).toBeLessThan(1600 * 1.1);
    expect((await logOf(h, s.id))[0]?.faults).toEqual(['f1', 'f2']);
  });

  it('combines a throttle with a latency on one request: the delay first, then the paced body', async () => {
    const s = await createSession(h, {
      stream: FAKE_VOD,
      faults: [
        { type: 'throttle', kbps: 3200, match: { kind: 'segment' } },
        { type: 'latency', ms: 250, match: { kind: 'segment' } },
      ],
    });
    const reply = await download(h.port, seg(s, 1));
    expect(reply.headAt - reply.startedAt).toBeGreaterThanOrEqual(250);
    expect(reply.bytes).toBe(120_000);
    // the body is paced after the head: 104 kB beyond the burst at 400 kB/s is 0.26 s
    expect(ended(reply) - reply.headAt).toBeGreaterThan(200);
  });
});

describe('live faults', () => {
  let h: Harness;
  let s: SessionInfo;
  let t0: number;
  const seg = (n: number, rep = FAKE_VIDEO): string => segmentPath(s.id, s.stream, rep, n, 'm4s');
  const manifest = async (): Promise<Record<string, string>> =>
    parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text);
  const status = async (n: number): Promise<number> => (await call(h.origin, 'GET', seg(n))).status;

  beforeEach(async () => {
    h = await startHarness();
    t0 = h.clock.now();
    s = await createSession(h, { stream: FAKE_LIVE });
  });
  afterEach(async () => {
    await h.close();
  });

  describe('live-stall', () => {
    it('freezes the manifest and the edge at the segment the origin stopped at, then catches up with the timeline unchanged', async () => {
      await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'live-stall', atNumber: 18, ms: 10_000 }] },
      });
      // The stall starts when segment 18 would be published: t0 + 6 s. Before it the origin is healthy.
      h.clock.advance(5000);
      expect(await manifest()).toMatchObject({ last: '17' });
      expect(await status(18)).toBe(404);
      expect((await detailOf(h, s.id)).live).toMatchObject({ edgeNumber: 17, stalled: false });

      h.clock.advance(1000);
      expect(await manifest()).toMatchObject({
        first: '4',
        last: '18',
        publish: new Date(t0 + 6000).toISOString(),
      });
      expect(await status(18)).toBe(200);
      expect((await detailOf(h, s.id)).live).toMatchObject({ edgeNumber: 18, stalled: true });

      // 3 s in: the free-running edge would be 19, the stalled origin says 18 and 19 is not there
      h.clock.advance(3000);
      expect(await manifest()).toMatchObject({ last: '18', publish: new Date(t0 + 6000).toISOString() });
      expect(await status(19)).toBe(404);
      expect(await status(18)).toBe(200);
      h.clock.advance(6999);
      expect(await manifest()).toMatchObject({ last: '18', publish: new Date(t0 + 6000).toISOString() });
      expect(await status(19)).toBe(404);
      expect((await detailOf(h, s.id)).live).toMatchObject({ edgeNumber: 18, stalled: true });

      // The stall is over: the origin catches up. Every segment that should exist by now is there, at once.
      h.clock.advance(1);
      expect(await manifest()).toMatchObject({
        first: '9',
        last: '23',
        publish: new Date(t0 + 16_000).toISOString(),
      });
      for (let n = 18; n <= 23; n++) expect(await status(n), `segment ${n}`).toBe(200);
      expect(await status(24)).toBe(404);
      expect((await detailOf(h, s.id)).live).toMatchObject({ edgeNumber: 23, stalled: false });
      // the timeline is unchanged: segment 19 is the same segment it would have been without the stall
      const late = await call(h.origin, 'GET', seg(19));
      expect(describeBuffer(late.bytes)).toMatchObject({ number: 19, live: true, source: 7, loop: 1 });
    });

    it('starts at once when it is installed after the segment it names was published', async () => {
      h.clock.advance(4000);
      await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'live-stall', atNumber: 3, ms: 6000 }] },
      });
      expect(await manifest()).toMatchObject({ last: '17' });
      h.clock.advance(5999);
      expect(await manifest()).toMatchObject({ last: '17' });
      expect(await status(18)).toBe(404);
      expect((await detailOf(h, s.id)).live?.stalled).toBe(true);
      h.clock.advance(1);
      expect(await manifest()).toMatchObject({ last: '20' });
      expect(await status(18)).toBe(200);
    });

    it('never unpublishes a segment, and a rule that is removed ends the stall', async () => {
      const [rule] = (
        await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
          body: { rules: [{ type: 'live-stall', atNumber: 16, ms: 100_000 }] },
        })
      ).json<Array<{ id: string }>>();
      h.clock.advance(20_000);
      expect(await manifest()).toMatchObject({ last: '16' });
      expect(await status(16)).toBe(200);
      expect(await status(17)).toBe(404);
      await call(h.origin, 'DELETE', `/api/sessions/${s.id}/faults/${rule?.id}`);
      expect(await manifest()).toMatchObject({ last: '25' });
      expect(await status(25)).toBe(200);
      expect(await status(16)).toBe(200);
    });
  });

  describe('manifest-stale', () => {
    it('replays the last manifest served before the rule became active, then serves fresh ones again', async () => {
      expect((await call(h.origin, 'GET', seg(15))).status).toBe(200); // the first media request: the rule clock starts
      const before = await call(h.origin, 'GET', s.manifestUrl);
      expect(parseManifest(before.text)).toMatchObject({ last: '15' });
      await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'manifest-stale', ms: 5000, afterMs: 1000 }] },
      });

      h.clock.advance(2500); // t0 + 2.5 s: inside [1 s, 6 s). Fresh would say 16.
      const builds = h.media.liveManifestBuilds();
      const stale = await call(h.origin, 'GET', s.manifestUrl);
      expect(stale.text).toBe(before.text);
      h.clock.advance(2000);
      expect((await call(h.origin, 'GET', s.manifestUrl)).text).toBe(before.text);
      expect(h.media.liveManifestBuilds()).toBe(builds); // replaying does not build
      // segments are not affected: the origin has published 16 and 17 whatever the manifest says
      expect(await status(17)).toBe(200);

      h.clock.advance(1499); // t0 + 5.999 s
      expect((await call(h.origin, 'GET', s.manifestUrl)).text).toBe(before.text);
      h.clock.advance(1); // t0 + 6 s: the rule is over
      const fresh = parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text);
      expect(fresh).toMatchObject({ last: '18', publish: new Date(t0 + 6000).toISOString() });
    });

    it('replays per URL, and a URL that was never served gets its first body inside the window, then keeps it', async () => {
      expect((await call(h.origin, 'GET', seg(15))).status).toBe(200);
      await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, {
        body: { rules: [{ type: 'manifest-stale', ms: 10_000 }] },
      });
      h.clock.advance(2000);
      const playlist = `/s/${s.id}/${s.stream}/hls/v360.m3u8`;
      const first = await call(h.origin, 'GET', playlist);
      expect(parseManifest(first.text)).toMatchObject({ rep: 'v360', last: '16' });
      h.clock.advance(4000);
      expect((await call(h.origin, 'GET', playlist)).text).toBe(first.text);
      // the other playlists and the DASH manifest each have their own recorded body
      const audio = await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/a-aac.m3u8`);
      expect(parseManifest(audio.text)).toMatchObject({ rep: 'a-aac', last: '18' });
      h.clock.advance(10_000);
      expect(parseManifest((await call(h.origin, 'GET', playlist)).text)).toMatchObject({ last: '23' });
    });
  });
});
