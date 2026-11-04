import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthInfo, RequestLogEntry, SessionDetail, SessionInfo } from '../../../src/shared/api.ts';
import type { FaultRuleWithId } from '../../../src/shared/faults.ts';
import type { StreamInfo } from '../../../src/shared/streams.ts';
import { MAX_JSON_BODY_BYTES, SESSION_LIMIT } from '../../../src/server/constants.ts';
import { makeScratch } from '../support/scratch.ts';
import { FAKE_LIVE, FAKE_VOD, FAKE_WEBM } from './fake-media.ts';
import { call, createSession, detailOf, rawConnect, startHarness } from './harness.ts';
import type { Harness, Reply } from './harness.ts';

// The control API of docs/CONTRACTS.md section 4, through real HTTP: every endpoint, its happy path and every error status.

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** An error of the service is always `{ error: string, details?: string[] }` and is JSON. */
function expectError(reply: Reply, status: number): { error: string; details?: string[] } {
  expect(reply.status).toBe(status);
  expect(reply.headers.get('content-type')).toMatch(/^application\/json/);
  const body = reply.json<{ error: string; details?: string[] }>();
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
  return body;
}

describe('the JSON API', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  describe('GET /health', () => {
    it('lists every stream of the catalog as ready or missing, in catalog order', async () => {
      const reply = await call(h.origin, 'GET', '/health');
      expect(reply.status).toBe(200);
      const info = reply.json<HealthInfo>();
      expect(info).toMatchObject({ status: 'ok', ffmpeg: 'fake-ffmpeg 0.0', player: 'missing' });
      expect(info.version).toBe(PACKAGE_VERSION);
      expect(Object.entries(info.streams)).toEqual([
        ['vod-cmaf', 'missing'],
        ['vod-cmaf-short', 'ready'],
        ['vod-webm', 'ready'],
        ['live-cmaf', 'ready'],
        ['vod-cmaf-clearkey', 'missing'],
      ]);
    });

    it('measures the uptime with the clock of the service', async () => {
      expect((await call(h.origin, 'GET', '/health')).json<HealthInfo>().uptimeSec).toBe(0);
      h.clock.advance(12_345);
      expect((await call(h.origin, 'GET', '/health')).json<HealthInfo>().uptimeSec).toBe(12.345);
    });

    it('says the player is built exactly when the player directory has an index.html', async () => {
      const dir = makeScratch('app-health-');
      const built = await startHarness({ playerDir: dir });
      try {
        expect((await call(built.origin, 'GET', '/health')).json<HealthInfo>().player).toBe('missing');
        writeFileSync(join(dir, 'index.html'), '<!doctype html>');
        expect((await call(built.origin, 'GET', '/health')).json<HealthInfo>().player).toBe('built');
      } finally {
        await built.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('GET /, /api/streams, /api/time', () => {
    it('answers / with a plain-text index that links to /health and /player/', async () => {
      const reply = await call(h.origin, 'GET', '/');
      expect(reply.status).toBe(200);
      expect(reply.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(reply.text).toContain('/health');
      expect(reply.text).toContain('/player/');
    });

    it('lists the ready streams with their catalog data', async () => {
      const reply = await call(h.origin, 'GET', '/api/streams');
      expect(reply.status).toBe(200);
      const { streams } = reply.json<{ streams: StreamInfo[] }>();
      expect(streams.map((s) => s.id)).toEqual([FAKE_VOD, FAKE_WEBM, FAKE_LIVE]);
      expect(streams[0]).toMatchObject({ kind: 'vod', segmentCount: 6, protocols: ['dash', 'hls'] });
      expect(streams[0]?.reps.map((r) => r.id)).toEqual(['v360', 'a-aac']);
    });

    it('answers /api/time with the ISO 8601 time of the service clock, as plain text, for the DASH UTCTiming element', async () => {
      const first = await call(h.origin, 'GET', '/api/time');
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(first.text).toBe('2030-01-01T00:00:00.000Z');
      h.clock.advance(1500);
      expect((await call(h.origin, 'GET', '/api/time')).text).toBe('2030-01-01T00:00:01.500Z');
    });
  });

  describe('POST /api/sessions', () => {
    it('creates a VOD session: 201, the SessionInfo, a Location, and a manifest URL on the contract layout', async () => {
      const reply = await call(h.origin, 'POST', '/api/sessions', {
        body: { stream: FAKE_VOD, label: 'PB-VOD-001' },
      });
      expect(reply.status).toBe(201);
      const info = reply.json<SessionInfo>();
      expect(info.id).toMatch(/^[0-9a-f]{12}$/);
      expect(info).toEqual({
        id: info.id,
        stream: FAKE_VOD,
        protocol: 'dash',
        label: 'PB-VOD-001',
        createdAt: '2030-01-01T00:00:00.000Z',
        ttlSec: 900,
        manifestUrl: `/s/${info.id}/${FAKE_VOD}/dash/manifest.mpd`,
      });
      expect(reply.headers.get('location')).toBe(`/api/sessions/${info.id}`);
    });

    it('points an HLS session at the master playlist', async () => {
      const info = await createSession(h, { stream: FAKE_VOD, protocol: 'hls' });
      expect(info.manifestUrl).toBe(`/s/${info.id}/${FAKE_VOD}/hls/master.m3u8`);
    });

    it('gives a live session its clock: on air for 30 s, a 15-segment window, edge 15', async () => {
      const info = await createSession(h, { stream: FAKE_LIVE });
      expect(info.live).toEqual({
        segmentDurationSec: 2,
        availabilityStartTime: '2029-12-31T23:59:30.000Z',
        windowSegments: 15,
        presentationDelaySec: 6,
        edgeNumber: 15,
        stalled: false,
      });
    });

    it('honours the live options, and the edge follows the clock', async () => {
      const info = await createSession(h, {
        stream: FAKE_LIVE,
        live: { startOffsetSec: 10, windowSegments: 4, presentationDelaySec: 3 },
      });
      expect(info.live).toMatchObject({
        availabilityStartTime: '2029-12-31T23:59:50.000Z',
        windowSegments: 4,
        presentationDelaySec: 3,
        edgeNumber: 5,
      });
      h.clock.advance(6000);
      expect((await detailOf(h, info.id)).live?.edgeNumber).toBe(8);
    });

    it('keeps the fault rules that come with the session request, with ids', async () => {
      const info = await createSession(h, {
        stream: FAKE_VOD,
        faults: [
          { type: 'latency', ms: 10 },
          { type: 'throttle', kbps: 800, id: 'slow' },
        ],
      });
      const detail = await detailOf(h, info.id);
      expect(detail.faults).toEqual([
        { type: 'latency', ms: 10, id: 'f1' },
        { type: 'throttle', kbps: 800, id: 'slow' },
      ]);
    });

    it('answers a request that is invalid in several ways with 400 and the list of the problems', async () => {
      const body = expectError(
        await call(h.origin, 'POST', '/api/sessions', {
          body: { stream: FAKE_WEBM, protocol: 'hls', ttlSec: 0, colour: 'red' },
        }),
        400,
      );
      expect(body.details?.length).toBeGreaterThanOrEqual(3);
      expect(body.details?.join('\n')).toMatch(/colour/);
      expect(body.details?.join('\n')).toMatch(/hls/);
      expect(body.details?.join('\n')).toMatch(/ttlSec/);
    });

    it('answers a stream id that does not exist with 400', async () => {
      expectError(await call(h.origin, 'POST', '/api/sessions', { body: { stream: 'nope' } }), 400);
      expectError(await call(h.origin, 'POST', '/api/sessions', { body: {} }), 400);
    });

    it('answers a valid stream that was not generated with 404 and says how to generate it', async () => {
      const body = expectError(
        await call(h.origin, 'POST', '/api/sessions', { body: { stream: 'vod-cmaf' } }),
        404,
      );
      expect(body.error).toMatch(/generate:streams/);
    });

    it('answers a body that is not a JSON object with 400', async () => {
      for (const raw of ['[]', '"vod-cmaf"', 'null', '42']) {
        expectError(await call(h.origin, 'POST', '/api/sessions', { raw }), 400);
      }
    });

    it('answers malformed JSON and an empty body with 400, not 500', async () => {
      expect(
        expectError(await call(h.origin, 'POST', '/api/sessions', { raw: '{"stream": ' }), 400).error,
      ).toMatch(/malformed JSON/);
      expect(expectError(await call(h.origin, 'POST', '/api/sessions', { raw: '' }), 400).error).toMatch(
        /empty/,
      );
      expect(expectError(await call(h.origin, 'POST', '/api/sessions', { raw: '   ' }), 400).error).toMatch(
        /empty/,
      );
    });

    it('accepts JSON whatever Content-Type the client sent (fetch sends text/plain for a string body)', async () => {
      const reply = await call(h.origin, 'POST', '/api/sessions', {
        raw: JSON.stringify({ stream: FAKE_VOD }),
        headers: { 'content-type': 'text/plain' },
      });
      expect(reply.status).toBe(201);
    });

    it('answers a body of exactly MAX_JSON_BODY_BYTES and refuses one byte more with 413', async () => {
      const json = JSON.stringify({ stream: FAKE_VOD });
      const padded = json + ' '.repeat(MAX_JSON_BODY_BYTES - json.length);
      expect(padded.length).toBe(MAX_JSON_BODY_BYTES);
      expect((await call(h.origin, 'POST', '/api/sessions', { raw: padded })).status).toBe(201);
      expect(
        expectError(await call(h.origin, 'POST', '/api/sessions', { raw: `${padded} ` }), 413).error,
      ).toMatch(/larger than 65536 bytes/);
    });

    it('answers a declared length over the limit at once, without waiting for a body that never comes', async () => {
      const raw = await rawConnect(h.port);
      try {
        raw.write(
          `POST /api/sessions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${MAX_JSON_BODY_BYTES * 20}\r\n\r\n`,
        );
        expect(await raw.until(/\r\n\r\n.*\}/s)).toMatch(/^HTTP\/1\.1 413 /);
      } finally {
        raw.close();
      }
    });

    it('stops reading a body without a declared length as soon as it crosses the limit', async () => {
      const raw = await rawConnect(h.port);
      try {
        const chunk = Buffer.alloc(MAX_JSON_BODY_BYTES + 1000, 0x20);
        // The terminating chunk is never sent: only a service that answers on the first chunk over the limit can reply.
        raw.write(
          `POST /api/sessions HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n${chunk.length.toString(16)}\r\n`,
        );
        raw.write(chunk);
        raw.write('\r\n');
        expect(await raw.until(/\r\n\r\n.*\}/s)).toMatch(/^HTTP\/1\.1 413 /);
      } finally {
        raw.close();
      }
      expect((await call(h.origin, 'GET', '/health')).status).toBe(200);
    });

    it(`answers 503 at ${SESSION_LIMIT} live sessions, and room comes back when sessions expire`, async () => {
      const ids: string[] = [];
      for (let batch = 0; batch < SESSION_LIMIT; batch += 50) {
        const created = await Promise.all(
          Array.from({ length: 50 }, () => createSession(h, { stream: FAKE_VOD, ttlSec: 60 })),
        );
        ids.push(...created.map((s) => s.id));
      }
      expect(new Set(ids).size).toBe(SESSION_LIMIT);
      const refused = expectError(
        await call(h.origin, 'POST', '/api/sessions', { body: { stream: FAKE_VOD } }),
        503,
      );
      expect(refused.error).toMatch(/500 sessions/);
      expect((await call(h.origin, 'DELETE', `/api/sessions/${ids[0]}`)).status).toBe(204);
      expect((await call(h.origin, 'POST', '/api/sessions', { body: { stream: FAKE_VOD } })).status).toBe(
        201,
      );
      expect((await call(h.origin, 'POST', '/api/sessions', { body: { stream: FAKE_VOD } })).status).toBe(
        503,
      );
      h.clock.advance(61_000);
      expect((await call(h.origin, 'POST', '/api/sessions', { body: { stream: FAKE_VOD } })).status).toBe(
        201,
      );
    });
  });

  describe('GET and DELETE /api/sessions/:id', () => {
    it('returns the SessionDetail: the info, the rules and zeroed counters', async () => {
      const info = await createSession(h, { stream: FAKE_VOD });
      const reply = await call(h.origin, 'GET', `/api/sessions/${info.id}`);
      expect(reply.status).toBe(200);
      expect(reply.json<SessionDetail>()).toEqual({
        ...info,
        faults: [],
        counters: { requests: 0, bytes: 0, errors: 0, byKind: {} },
      });
    });

    it('deletes a session: 204 with no body, then 404 for everything about it', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      const deleted = await call(h.origin, 'DELETE', `/api/sessions/${id}`);
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');
      expectError(await call(h.origin, 'GET', `/api/sessions/${id}`), 404);
      expectError(await call(h.origin, 'DELETE', `/api/sessions/${id}`), 404);
      expectError(await call(h.origin, 'GET', `/api/sessions/${id}/log`), 404);
      expectError(await call(h.origin, 'POST', `/api/sessions/${id}/faults`, { body: { rules: [] } }), 404);
    });

    it('answers an unknown session with 404 whatever the method', async () => {
      expectError(await call(h.origin, 'GET', '/api/sessions/0123456789ab'), 404);
      expectError(
        await call(h.origin, 'PUT', '/api/sessions/0123456789ab/faults', { body: { rules: [] } }),
        404,
      );
      expectError(await call(h.origin, 'DELETE', '/api/sessions/0123456789ab/faults/f1'), 404);
    });

    it('forgets a session when its lifetime is over, exactly at the end of it', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD, ttlSec: 1 });
      h.clock.advance(999);
      expect((await call(h.origin, 'GET', `/api/sessions/${id}`)).status).toBe(200);
      h.clock.advance(1);
      expectError(await call(h.origin, 'GET', `/api/sessions/${id}`), 404);
      expectError(await call(h.origin, 'GET', `/api/sessions/${id}/log`), 404);
    });
  });

  describe('fault rules: POST and PUT /api/sessions/:id/faults, DELETE .../faults/:rule', () => {
    let id: string;
    beforeEach(async () => {
      id = (await createSession(h, { stream: FAKE_LIVE })).id;
    });

    it('adds rules with 201 and returns them with the ids the service gave', async () => {
      const first = await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: {
          rules: [
            { type: 'latency', ms: 50 },
            { type: 'status', status: 503, match: { kind: 'segment' } },
          ],
        },
      });
      expect(first.status).toBe(201);
      expect(first.json<FaultRuleWithId[]>()).toEqual([
        { type: 'latency', ms: 50, id: 'f1' },
        { type: 'status', status: 503, match: { kind: 'segment' }, id: 'f2' },
      ]);
      const second = await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: { rules: [{ type: 'abort', id: 'cut' }] },
      });
      expect(second.json<FaultRuleWithId[]>()).toEqual([{ type: 'abort', id: 'cut' }]);
      expect((await detailOf(h, id)).faults.map((r) => r.id)).toEqual(['f1', 'f2', 'cut']);
    });

    it('replaces every rule with PUT: 200, and the old rules are gone', async () => {
      await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: { rules: [{ type: 'latency', ms: 50 }] },
      });
      const replaced = await call(h.origin, 'PUT', `/api/sessions/${id}/faults`, {
        body: { rules: [{ type: 'throttle', kbps: 1500 }] },
      });
      expect(replaced.status).toBe(200);
      expect(replaced.json<FaultRuleWithId[]>()).toEqual([{ type: 'throttle', kbps: 1500, id: 'f2' }]);
      expect((await detailOf(h, id)).faults).toEqual([{ type: 'throttle', kbps: 1500, id: 'f2' }]);
      const emptied = await call(h.origin, 'PUT', `/api/sessions/${id}/faults`, { body: { rules: [] } });
      expect(emptied.status).toBe(200);
      expect(emptied.json()).toEqual([]);
      expect((await detailOf(h, id)).faults).toEqual([]);
    });

    it('rejects invalid rules with 400 and every problem, and changes nothing', async () => {
      await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: { rules: [{ type: 'latency', ms: 50 }] },
      });
      const bad = [
        { type: 'throttle', kbps: 0 },
        { type: 'status', status: 99, match: { kind: 'segment' } },
        { type: 'status', status: 500 },
        { type: 'teleport' },
        { type: 'live-stall', atNumber: 3, ms: 100, afterMs: 5 },
        { type: 'latency', ms: -1, colour: 'red' },
      ];
      for (const verb of ['POST', 'PUT']) {
        const body = expectError(
          await call(h.origin, verb, `/api/sessions/${id}/faults`, {
            body: { rules: [{ type: 'abort' }, ...bad] },
          }),
          400,
        );
        expect(body.details?.length).toBeGreaterThanOrEqual(bad.length);
      }
      expect((await detailOf(h, id)).faults).toEqual([{ type: 'latency', ms: 50, id: 'f1' }]);
    });

    it('rejects a rule id that exists, and a rule that cannot apply to the stream', async () => {
      await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: { rules: [{ type: 'abort', id: 'cut' }] },
      });
      const duplicate = expectError(
        await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
          body: { rules: [{ type: 'abort', id: 'cut' }] },
        }),
        400,
      );
      expect(duplicate.details?.join(' ')).toMatch(/cut already exists/);
      const vod = (await createSession(h, { stream: FAKE_VOD })).id;
      const onVod = expectError(
        await call(h.origin, 'POST', `/api/sessions/${vod}/faults`, {
          body: { rules: [{ type: 'live-stall', atNumber: 3, ms: 1000 }] },
        }),
        400,
      );
      expect(onVod.details?.join(' ')).toMatch(/live stream/);
    });

    it('rejects a body that is not { rules: [...] }', async () => {
      for (const body of [{}, { rules: 'x' }, { rule: [] }]) {
        expectError(await call(h.origin, 'POST', `/api/sessions/${id}/faults`, { body }), 400);
      }
      expectError(await call(h.origin, 'POST', `/api/sessions/${id}/faults`, { body: [] }), 400);
      expectError(
        await call(h.origin, 'POST', `/api/sessions/${id}/faults`, { body: { rules: [], extra: 1 } }),
        400,
      );
      expectError(await call(h.origin, 'POST', `/api/sessions/${id}/faults`, { raw: '{' }), 400);
    });

    it('removes one rule with 204, and answers 404 for a rule that is not there', async () => {
      await call(h.origin, 'POST', `/api/sessions/${id}/faults`, {
        body: {
          rules: [
            { type: 'latency', ms: 5 },
            { type: 'abort', id: 'cut' },
          ],
        },
      });
      const removed = await call(h.origin, 'DELETE', `/api/sessions/${id}/faults/f1`);
      expect(removed.status).toBe(204);
      expect(removed.text).toBe('');
      expect((await detailOf(h, id)).faults.map((r) => r.id)).toEqual(['cut']);
      expectError(await call(h.origin, 'DELETE', `/api/sessions/${id}/faults/f1`), 404);
      expectError(await call(h.origin, 'DELETE', `/api/sessions/${id}/faults/never`), 404);
      expect((await call(h.origin, 'DELETE', `/api/sessions/${id}/faults/cut`)).status).toBe(204);
      expect((await detailOf(h, id)).faults).toEqual([]);
    });
  });

  describe('GET /api/sessions/:id/log?since=<seq>', () => {
    it('starts empty, and the since cursor must be an integer >= 0', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      const log = await call(h.origin, 'GET', `/api/sessions/${id}/log`);
      expect(log.status).toBe(200);
      expect(log.json<RequestLogEntry[]>()).toEqual([]);
      expect((await call(h.origin, 'GET', `/api/sessions/${id}/log?since=0`)).json()).toEqual([]);
      expect((await call(h.origin, 'GET', `/api/sessions/${id}/log?since=12345`)).json()).toEqual([]);
      for (const since of ['-1', 'abc', '1.5', '', '1e3', '0x10', '99999999999999999999', '1&since=2']) {
        const body = expectError(await call(h.origin, 'GET', `/api/sessions/${id}/log?since=${since}`), 400);
        expect(body.details?.join(' ')).toMatch(/since/);
      }
    });
  });

  describe('methods, unknown paths and the headers of every answer', () => {
    it('answers a method that a path does not support with 405 and the Allow header', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      const cases: Array<[string, string, string]> = [
        ['POST', '/', 'GET, HEAD, OPTIONS'],
        ['POST', '/health', 'GET, HEAD, OPTIONS'],
        ['DELETE', '/api/streams', 'GET, HEAD, OPTIONS'],
        ['PUT', '/api/time', 'GET, HEAD, OPTIONS'],
        ['GET', '/api/sessions', 'POST, OPTIONS'],
        ['POST', `/api/sessions/${id}`, 'GET, HEAD, DELETE, OPTIONS'],
        ['GET', `/api/sessions/${id}/faults`, 'POST, PUT, OPTIONS'],
        ['PUT', `/api/sessions/${id}/faults/f1`, 'DELETE, OPTIONS'],
        ['POST', `/api/sessions/${id}/log`, 'GET, HEAD, OPTIONS'],
      ];
      for (const [method, path, allow] of cases) {
        const reply = await call(h.origin, method, path);
        expectError(reply, 405);
        expect(reply.headers.get('allow'), `${method} ${path}`).toBe(allow);
      }
    });

    it('answers an unknown path with 404 and a JSON error', async () => {
      for (const path of [
        '/nope',
        '/api',
        '/api/',
        '/api/nope',
        '/api/sessions/',
        '/health/',
        '/api/sessions/abc/log/extra',
        '/api/sessions/abc/unknown',
        '//health',
      ]) {
        expectError(await call(h.origin, 'GET', path), 404);
      }
    });

    it('puts Cache-Control: no-store and Access-Control-Allow-Origin: * on every answer, errors and 204 included', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      const replies = [
        await call(h.origin, 'GET', '/'),
        await call(h.origin, 'GET', '/health'),
        await call(h.origin, 'GET', '/api/time'),
        await call(h.origin, 'GET', '/api/streams'),
        await call(h.origin, 'GET', `/api/sessions/${id}`),
        await call(h.origin, 'GET', '/nope'),
        await call(h.origin, 'POST', '/health'),
        await call(h.origin, 'POST', '/api/sessions', { raw: '{' }),
        await call(h.origin, 'DELETE', `/api/sessions/${id}`),
        await call(h.origin, 'OPTIONS', '/anything'),
      ];
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 404, 405, 400, 204, 204]);
      for (const reply of replies) {
        expect(reply.headers.get('cache-control')).toBe('no-store');
        expect(reply.headers.get('access-control-allow-origin')).toBe('*');
      }
    });

    it('answers every OPTIONS, whatever the path, with the CORS preflight', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      for (const path of [
        '/',
        '/health',
        '/api/sessions',
        `/api/sessions/${id}/faults`,
        `/s/${id}/${FAKE_VOD}/seg/v360/1.m4s`,
        '/player/',
        '/player/app.js',
        '/player',
        '/does/not/exist',
      ]) {
        const reply = await call(h.origin, 'OPTIONS', path, {
          headers: { origin: 'http://example.test', 'access-control-request-method': 'PUT' },
        });
        expect(reply.status, path).toBe(204);
        expect(reply.text).toBe('');
        expect(reply.headers.get('access-control-allow-methods')).toBe(
          'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        );
        expect(reply.headers.get('access-control-allow-headers')).toBe('Content-Type, Range');
        expect(reply.headers.get('access-control-max-age')).toBe('600');
        expect(reply.headers.get('access-control-allow-origin')).toBe('*');
        expect(reply.headers.get('cache-control')).toBe('no-store');
      }
    });

    it('answers OPTIONS * (the asterisk-form target) with the preflight too', async () => {
      const raw = await rawConnect(h.port);
      try {
        raw.write('OPTIONS * HTTP/1.1\r\nHost: x\r\n\r\n');
        const text = await raw.until(/\r\n\r\n/);
        expect(text).toMatch(/^HTTP\/1\.1 204 /);
        expect(text.toLowerCase()).toContain(
          'access-control-allow-methods: get, head, post, put, delete, options',
        );
      } finally {
        raw.close();
      }
    });

    it('serves HEAD wherever GET works: the same status and headers, no body', async () => {
      const { id } = await createSession(h, { stream: FAKE_VOD });
      for (const path of [
        '/',
        '/health',
        '/api/streams',
        '/api/time',
        `/api/sessions/${id}`,
        `/api/sessions/${id}/log`,
      ]) {
        const get = await call(h.origin, 'GET', path);
        const head = await call(h.origin, 'HEAD', path);
        expect(head.status, path).toBe(get.status);
        expect(head.text, path).toBe('');
        expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
        expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(get.text)));
        expect(head.headers.get('cache-control')).toBe('no-store');
      }
      const missing = await call(h.origin, 'HEAD', '/api/sessions/0123456789ab');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('content-type')).toMatch(/^application\/json/);
      expect(missing.text).toBe('');
    });
  });

  describe('failures inside the service', () => {
    it('answers an exception in a handler with 500 JSON, logs it, and keeps serving', async () => {
      await h.close();
      h = await startHarness({
        decorate: (media) => ({
          ...media,
          ffmpegVersion: () => {
            throw new Error('the store broke');
          },
        }),
      });
      expect(expectError(await call(h.origin, 'GET', '/health'), 500).error).toBe('internal error');
      expect(h.lines.some((line) => /ERROR GET \/health.*the store broke/s.test(line))).toBe(true);
      expect((await call(h.origin, 'GET', '/api/time')).status).toBe(200);
    });
  });
});
