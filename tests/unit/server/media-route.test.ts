import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionDetail, SessionInfo } from '../../../src/shared/api.ts';
import { initPath, manifestPath, segmentPath } from '../../../src/shared/urls.ts';
import {
  FAKE_AUDIO,
  FAKE_LIVE,
  FAKE_LIVE_SEGMENTS,
  FAKE_VIDEO,
  FAKE_VOD,
  FAKE_VOD_SEGMENTS,
  FAKE_WEBM,
  describeBuffer,
  parseManifest,
} from './fake-media.ts';
import { call, createSession, detailOf, logOf, startHarness } from './harness.ts';
import type { Harness, Reply } from './harness.ts';

// The media request pipeline through real HTTP: manifests, initialization segments and segments of VOD and live sessions
// (docs/CONTRACTS.md sections 3 and 4). The store is the fake, whose buffers say which segment they are.

function expectNotFound(reply: Reply): void {
  expect(reply.status).toBe(404);
  expect(reply.headers.get('content-type')).toMatch(/^application\/json/);
  expect(reply.json<{ error: string }>().error.length).toBeGreaterThan(0);
}

describe('a VOD session', () => {
  let h: Harness;
  let s: SessionInfo;
  const seg = (rep: string, n: number): string => segmentPath(s.id, s.stream, rep, n, 'm4s');

  beforeEach(async () => {
    h = await startHarness();
    s = await createSession(h, { stream: FAKE_VOD });
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves the DASH manifest with its content type, the real length, and the headers of every answer', async () => {
    const reply = await call(h.origin, 'GET', s.manifestUrl);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/dash+xml');
    expect(reply.headers.get('content-length')).toBe(String(reply.bytes.length));
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('access-control-allow-origin')).toBe('*');
    expect(parseManifest(reply.text)).toEqual({ kind: 'dash-vod', stream: FAKE_VOD, segments: '6' });
  });

  it('serves the HLS master and the media playlist of each representation, whatever protocol the session was created with', async () => {
    const master = await call(h.origin, 'GET', manifestPath(s.id, s.stream, 'hls'));
    expect(master.status).toBe(200);
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(parseManifest(master.text)).toMatchObject({ kind: 'hls-master', stream: FAKE_VOD });
    for (const rep of [FAKE_VIDEO, FAKE_AUDIO]) {
      const playlist = await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/${rep}.m3u8`);
      expect(playlist.status).toBe(200);
      expect(playlist.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      expect(parseManifest(playlist.text)).toEqual({ kind: 'hls-vod', stream: FAKE_VOD, rep, segments: '6' });
    }
  });

  it('serves the initialization segment of each representation, typed by its track', async () => {
    const video = await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4'));
    expect(video.status).toBe(200);
    expect(video.headers.get('content-type')).toBe('video/mp4');
    expect(describeBuffer(video.bytes)).toEqual({
      what: 'init',
      stream: FAKE_VOD,
      rep: FAKE_VIDEO,
      live: false,
    });
    expect(video.bytes.length).toBe(120);
    const audio = await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_AUDIO, 'mp4'));
    expect(audio.headers.get('content-type')).toBe('audio/mp4');
    expect(describeBuffer(audio.bytes)).toMatchObject({ what: 'init', rep: FAKE_AUDIO });
  });

  it('serves every segment of every representation: exactly the bytes of that segment, with Content-Length', async () => {
    for (const rep of [FAKE_VIDEO, FAKE_AUDIO]) {
      for (let n = 1; n <= FAKE_VOD_SEGMENTS; n++) {
        const reply = await call(h.origin, 'GET', seg(rep, n));
        expect(reply.status, `${rep} ${n}`).toBe(200);
        expect(reply.headers.get('content-type')).toBe(rep === FAKE_VIDEO ? 'video/mp4' : 'audio/mp4');
        expect(reply.headers.get('content-length')).toBe('600');
        expect(describeBuffer(reply.bytes)).toEqual({
          what: 'segment',
          stream: FAKE_VOD,
          rep,
          number: n,
          live: false,
        });
        expect(reply.bytes.equals(h.media.segment(FAKE_VOD, rep, n) ?? Buffer.alloc(0))).toBe(true);
      }
    }
  });

  it('ignores a Range header and serves the whole segment', async () => {
    const reply = await call(h.origin, 'GET', seg(FAKE_VIDEO, 1), { headers: { range: 'bytes=0-9' } });
    expect(reply.status).toBe(200);
    expect(reply.bytes.length).toBe(600);
  });

  it('answers what does not exist with 404 and a JSON error, never with a server error', async () => {
    const stream = s.stream;
    const missing: Array<[string, string]> = [
      ['segment 0', seg(FAKE_VIDEO, 0)],
      ['the segment after the last', seg(FAKE_VIDEO, FAKE_VOD_SEGMENTS + 1)],
      ['a segment number beyond 2^53', `/s/${s.id}/${stream}/seg/v360/99999999999999999999.m4s`],
      ['an unknown representation', seg('v999', 1)],
      ['an extension that is not the representation', `/s/${s.id}/${stream}/seg/v360/1.webm`],
      ['a segment number with a leading zero', `/s/${s.id}/${stream}/seg/v360/01.m4s`],
      ['an init segment with the wrong extension', `/s/${s.id}/${stream}/seg/v360/init.webm`],
      ['the init segment of an unknown representation', `/s/${s.id}/${stream}/seg/v999/init.mp4`],
      ['the playlist of an unknown representation', `/s/${s.id}/${stream}/hls/v999.m3u8`],
      ['a segment that is not a number', `/s/${s.id}/${stream}/seg/v360/abc.m4s`],
      [
        'a representation id that is percent-encoded: routes never decode',
        `/s/${s.id}/${stream}/seg/v%33%36%30/1.m4s`,
      ],
      ['another stream than the one of the session', `/s/${s.id}/${FAKE_LIVE}/dash/manifest.mpd`],
      ['another stream, a segment', segmentPath(s.id, FAKE_LIVE, FAKE_VIDEO, 1, 'm4s')],
      ['garbage under the session', `/s/${s.id}/${stream}/nope`],
      ['a directory', `/s/${s.id}/${stream}/seg/`],
    ];
    for (const [what, path] of missing) {
      const reply = await call(h.origin, 'GET', path);
      expect(reply.status, what).toBe(404);
      expect(reply.headers.get('content-type'), what).toMatch(/^application\/json/);
    }
    // every refusal is part of the log of the session (the stream of the session exists, so they can be attributed to it)
    expect((await logOf(h, s.id)).map((entry) => entry.status)).toEqual(missing.map(() => 404));
    expect((await detailOf(h, s.id)).counters).toMatchObject({
      requests: missing.length,
      errors: missing.length,
    });
  });

  it('answers an unknown or expired session with 404, and a path that is no resource at all with 404', async () => {
    expectNotFound(await call(h.origin, 'GET', `/s/0123456789ab/${FAKE_VOD}/dash/manifest.mpd`));
    expectNotFound(await call(h.origin, 'GET', '/s/'));
    expectNotFound(await call(h.origin, 'GET', `/s/${s.id}`));
    expectNotFound(await call(h.origin, 'GET', `/s/${s.id}/${FAKE_VOD}`));
    expect(await logOf(h, s.id)).toEqual([]);
    const short = await createSession(h, { stream: FAKE_VOD, ttlSec: 1 });
    expect((await call(h.origin, 'GET', short.manifestUrl)).status).toBe(200);
    h.clock.advance(1000);
    expectNotFound(await call(h.origin, 'GET', short.manifestUrl));
  });

  it('keeps at most 300 characters of a path in the log: a client that sends kilobytes cannot fill it with them', async () => {
    const long = `/s/${s.id}/${s.stream}/${'x'.repeat(5000)}`;
    expectNotFound(await call(h.origin, 'GET', long));
    const [entry] = await logOf(h, s.id);
    expect(entry).toMatchObject({ kind: 'other', status: 404 });
    expect(entry?.path).toHaveLength(303);
    expect(entry?.path.startsWith(`/s/${s.id}/${s.stream}/xxx`)).toBe(true);
    expect(entry?.path.endsWith('xxx...')).toBe(true);
  });

  it('answers a method other than GET and HEAD with 405 and Allow, and logs it', async () => {
    const reply = await call(h.origin, 'POST', seg(FAKE_VIDEO, 1), { raw: '{}' });
    expect(reply.status).toBe(405);
    expect(reply.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(reply.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await logOf(h, s.id)).toMatchObject([{ method: 'POST', kind: 'segment', status: 405 }]);
  });

  it('serves HEAD like GET without a body: the same headers and the Content-Length of the segment', async () => {
    for (const path of [seg(FAKE_VIDEO, 2), s.manifestUrl, initPath(s.id, s.stream, FAKE_AUDIO, 'mp4')]) {
      const get = await call(h.origin, 'GET', path);
      const head = await call(h.origin, 'HEAD', path);
      expect(head.status).toBe(200);
      expect(head.bytes.length).toBe(0);
      expect(head.headers.get('content-length')).toBe(String(get.bytes.length));
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    }
    const missing = await call(h.origin, 'HEAD', seg(FAKE_VIDEO, 99));
    expect(missing.status).toBe(404);
    expect(missing.bytes.length).toBe(0);
    const heads = (await logOf(h, s.id)).filter((entry) => entry.method === 'HEAD');
    expect(heads).toHaveLength(4);
    expect(heads.every((entry) => entry.bytes === 0 && !entry.pending)).toBe(true);
  });
});

describe('a WebM session', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('types WebM segments video/webm and audio/webm, and serves them under the webm extension only', async () => {
    const s = await createSession(h, { stream: FAKE_WEBM });
    const video = await call(h.origin, 'GET', segmentPath(s.id, s.stream, 'v360', 1, 'webm'));
    expect(video.status).toBe(200);
    expect(video.headers.get('content-type')).toBe('video/webm');
    const audio = await call(h.origin, 'GET', initPath(s.id, s.stream, 'a-opus', 'webm'));
    expect(audio.headers.get('content-type')).toBe('audio/webm');
    expect(describeBuffer(audio.bytes)).toMatchObject({ what: 'init', rep: 'a-opus' });
    expectNotFound(await call(h.origin, 'GET', segmentPath(s.id, s.stream, 'v360', 1, 'm4s')));
  });

  it('does not serve HLS for a stream that is DASH only', async () => {
    const s = await createSession(h, { stream: FAKE_WEBM });
    expect((await call(h.origin, 'GET', s.manifestUrl)).status).toBe(200);
    expectNotFound(await call(h.origin, 'GET', manifestPath(s.id, s.stream, 'hls')));
    expectNotFound(await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/v360.m3u8`));
  });
});

describe('a live session', () => {
  let h: Harness;
  let s: SessionInfo;
  let t0: number;
  const seg = (rep: string, n: number): string => segmentPath(s.id, s.stream, rep, n, 'm4s');
  const manifest = async (): Promise<Record<string, string>> =>
    parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text);

  beforeEach(async () => {
    h = await startHarness();
    t0 = h.clock.now();
    s = await createSession(h, { stream: FAKE_LIVE });
  });
  afterEach(async () => {
    await h.close();
  });

  it('publishes the window of the contract at creation: segments 1 to 15, edge 15, published at the edge', async () => {
    const m = await manifest();
    expect(m).toEqual({
      kind: 'dash-live',
      stream: FAKE_LIVE,
      first: '1',
      last: '15',
      ast: new Date(t0 - 30_000).toISOString(),
      publish: new Date(t0).toISOString(),
      tsbd: '30',
      delay: '6',
      mup: '2',
    });
  });

  it('slides the window with the clock, one segment every 2 s, and publishes at the instant of the edge segment', async () => {
    h.clock.advance(1999);
    expect(await manifest()).toMatchObject({ first: '1', last: '15', publish: new Date(t0).toISOString() });
    h.clock.advance(1);
    expect(await manifest()).toMatchObject({
      first: '2',
      last: '16',
      publish: new Date(t0 + 2000).toISOString(),
    });
    h.clock.advance(12_000);
    expect(await manifest()).toMatchObject({
      first: '8',
      last: '22',
      publish: new Date(t0 + 14_000).toISOString(),
    });
    expect((await detailOf(h, s.id)).live?.edgeNumber).toBe(22);
  });

  it('takes the window from the options of the session: depth, offset and presentation delay', async () => {
    const custom = await createSession(h, {
      stream: FAKE_LIVE,
      live: { startOffsetSec: 6, windowSegments: 2, presentationDelaySec: 4 },
    });
    const m = parseManifest((await call(h.origin, 'GET', custom.manifestUrl)).text);
    expect(m).toMatchObject({ first: '2', last: '3', tsbd: '4', delay: '4' });
  });

  it('lists the same window in the HLS playlists: the master is static, the media playlists slide', async () => {
    const master = await call(h.origin, 'GET', manifestPath(s.id, s.stream, 'hls'));
    expect(parseManifest(master.text)).toEqual({ kind: 'hls-master', stream: FAKE_LIVE });
    const playlist = async (rep: string): Promise<Record<string, string>> =>
      parseManifest((await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/${rep}.m3u8`)).text);
    expect(await playlist(FAKE_VIDEO)).toEqual({
      kind: 'hls-live',
      stream: FAKE_LIVE,
      rep: FAKE_VIDEO,
      first: '1',
      last: '15',
      ast: new Date(t0 - 30_000).toISOString(),
    });
    h.clock.advance(20_000);
    expect(await playlist(FAKE_AUDIO)).toMatchObject({ rep: FAKE_AUDIO, first: '11', last: '25' });
  });

  it('serves a segment up to the edge and answers 404 beyond it, until the clock publishes it', async () => {
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 15))).status).toBe(200);
    const early = await call(h.origin, 'GET', seg(FAKE_VIDEO, 16));
    expectNotFound(early);
    expect(early.json<{ error: string }>().error).toMatch(/not published yet.*edge is 15/);
    h.clock.advance(1999);
    expectNotFound(await call(h.origin, 'GET', seg(FAKE_VIDEO, 16)));
    h.clock.advance(1);
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 16))).status).toBe(200);
    expectNotFound(await call(h.origin, 'GET', seg(FAKE_VIDEO, 0)));
  });

  it('keeps two segments beyond the window and answers 404 from the third: older than the window minus 2 is gone', async () => {
    h.clock.advance(30_000);
    expect(await manifest()).toMatchObject({ first: '16', last: '30' });
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 16))).status).toBe(200);
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 15))).status).toBe(200);
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 14))).status).toBe(200);
    const gone = await call(h.origin, 'GET', seg(FAKE_VIDEO, 13));
    expectNotFound(gone);
    expect(gone.json<{ error: string }>().error).toMatch(/gone.*window starts at 16/);
    expect((await call(h.origin, 'GET', seg(FAKE_VIDEO, 30))).status).toBe(200);
  });

  it('serves live segment n from the looped source: source ((n-1) mod 12)+1 of loop (n-1) div 12', async () => {
    h.clock.advance(40_000);
    const edge = 35;
    expect((await detailOf(h, s.id)).live?.edgeNumber).toBe(edge);
    for (const n of [24, 25, 26, 30, 35]) {
      for (const rep of [FAKE_VIDEO, FAKE_AUDIO]) {
        const reply = await call(h.origin, 'GET', seg(rep, n));
        expect(reply.status, `${rep} ${n}`).toBe(200);
        expect(describeBuffer(reply.bytes)).toEqual({
          what: 'segment',
          stream: FAKE_LIVE,
          rep,
          number: n,
          live: true,
          source: ((n - 1) % FAKE_LIVE_SEGMENTS) + 1,
          loop: Math.floor((n - 1) / FAKE_LIVE_SEGMENTS),
        });
      }
    }
  });

  it('serves the initialization segments, which do not depend on the clock', async () => {
    for (const advance of [0, 100_000]) {
      h.clock.advance(advance);
      const reply = await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_AUDIO, 'mp4'));
      expect(reply.status).toBe(200);
      expect(describeBuffer(reply.bytes)).toEqual({
        what: 'init',
        stream: FAKE_LIVE,
        rep: FAKE_AUDIO,
        live: false,
      });
    }
  });

  it('keeps sessions apart: each has its own clock origin', async () => {
    h.clock.advance(10_000);
    const later = await createSession(h, { stream: FAKE_LIVE });
    const first = parseManifest((await call(h.origin, 'GET', s.manifestUrl)).text);
    const second = parseManifest((await call(h.origin, 'GET', later.manifestUrl)).text);
    expect(first).toMatchObject({ first: '6', last: '20' });
    expect(second).toMatchObject({ first: '1', last: '15' });
  });
});

describe('the request log of a session', () => {
  let h: Harness;
  let s: SessionInfo;
  beforeEach(async () => {
    h = await startHarness();
    s = await createSession(h, { stream: FAKE_VOD });
  });
  afterEach(async () => {
    await h.close();
  });

  it('lists every request under /s/<session>/ in arrival order with what the player asked for and what it got', async () => {
    await call(h.origin, 'GET', s.manifestUrl);
    h.clock.advance(1500);
    await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/hls/v360.m3u8`);
    await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4'));
    await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_AUDIO, 3, 'm4s'));
    await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 9, 'm4s'));
    await call(h.origin, 'GET', `/s/${s.id}/${s.stream}/nope`);
    const entries = await logOf(h, s.id);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const t0 = Date.UTC(2030, 0, 1);
    expect(entries).toMatchObject([
      {
        method: 'GET',
        kind: 'manifest',
        path: s.manifestUrl,
        status: 200,
        msSinceStart: 0,
        t: new Date(t0).toISOString(),
      },
      {
        kind: 'manifest',
        rep: 'v360',
        path: `/s/${s.id}/${s.stream}/hls/v360.m3u8`,
        status: 200,
        msSinceStart: 1500,
        t: new Date(t0 + 1500).toISOString(),
      },
      { kind: 'init', rep: FAKE_VIDEO, status: 200, bytes: 120 },
      { kind: 'segment', rep: FAKE_AUDIO, number: 3, status: 200, bytes: 600, pending: false, faults: [] },
      { kind: 'segment', rep: FAKE_VIDEO, number: 9, status: 404 },
      { kind: 'other', status: 404, path: `/s/${s.id}/${s.stream}/nope` },
    ]);
    for (const entry of entries) {
      expect(entry.pending).toBe(false);
      expect(entry.aborted).toBeUndefined();
      expect(entry.ttfbMs).toBeGreaterThanOrEqual(0);
      expect(entry.totalMs).toBeGreaterThanOrEqual(entry.ttfbMs);
    }
  });

  it('does not list the control API or /health', async () => {
    await call(h.origin, 'GET', '/health');
    await call(h.origin, 'GET', '/api/streams');
    await call(h.origin, 'GET', '/api/time');
    await call(h.origin, 'GET', `/api/sessions/${s.id}`);
    await call(h.origin, 'POST', `/api/sessions/${s.id}/faults`, { body: { rules: [] } });
    expect(await logOf(h, s.id)).toEqual([]);
  });

  it('returns only what is newer than the cursor, and keeps the cursor valid as entries are added', async () => {
    const get = (n: number): Promise<Reply> =>
      call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, n, 'm4s'));
    await get(1);
    await get(2);
    const seen = await logOf(h, s.id);
    const cursor = seen[seen.length - 1]?.seq ?? 0;
    expect(cursor).toBe(2);
    expect(await logOf(h, s.id, cursor)).toEqual([]);
    await get(3);
    await get(4);
    expect((await logOf(h, s.id, cursor)).map((e) => e.number)).toEqual([3, 4]);
    expect((await logOf(h, s.id, 3)).map((e) => e.number)).toEqual([4]);
    expect((await logOf(h, s.id, 0)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('counts requests, bytes, errors and kinds in the session detail', async () => {
    const manifest = await call(h.origin, 'GET', s.manifestUrl);
    await call(h.origin, 'GET', initPath(s.id, s.stream, FAKE_VIDEO, 'mp4'));
    await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 1, 'm4s'));
    await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 2, 'm4s'));
    const missing = await call(h.origin, 'GET', segmentPath(s.id, s.stream, FAKE_VIDEO, 77, 'm4s'));
    const detail: SessionDetail = await detailOf(h, s.id);
    expect(detail.counters).toEqual({
      requests: 5,
      bytes: manifest.bytes.length + 120 + 600 + 600 + missing.bytes.length,
      errors: 1,
      byKind: { manifest: 1, init: 1, segment: 3 },
    });
  });
});
