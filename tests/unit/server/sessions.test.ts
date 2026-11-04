import { describe, expect, it } from 'vitest';
import type { Protocol, StreamId, StreamInfo } from '../../../src/shared/streams.ts';
import { SESSION_DEFAULT_TTL_SEC } from '../../../src/server/constants.ts';
import { SessionLimitError, SessionStore, parseSessionRequest } from '../../../src/server/sessions.ts';
import type { ParsedSessionRequest } from '../../../src/server/sessions.ts';
import { ManualClock } from '../support/manual-clock.ts';

function stream(id: StreamId, kind: 'vod' | 'live', protocols: Protocol[] = ['dash', 'hls']): StreamInfo {
  return {
    id,
    kind,
    packaging: 'cmaf',
    protocols,
    segmentDurationSec: 2,
    segmentCount: kind === 'live' ? 12 : 30,
    durationSec: kind === 'live' ? 24 : 60,
    reps: [],
    contentHash: 'fixture',
    ffmpegVersion: 'fixture',
  };
}

const STREAMS = [stream('vod-cmaf', 'vod'), stream('vod-webm', 'vod', ['dash']), stream('live-cmaf', 'live')];

function parsed(raw: unknown): ParsedSessionRequest {
  const result = parseSessionRequest(raw, STREAMS);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

function problems(raw: unknown): { status: number; errors: string[] } {
  const result = parseSessionRequest(raw, STREAMS);
  if (result.ok) throw new Error('expected the request to be rejected');
  return { status: result.status, errors: result.errors };
}

describe('parseSessionRequest', () => {
  it('fills the defaults of a VOD session: DASH, the default lifetime, no faults', () => {
    const value = parsed({ stream: 'vod-cmaf' });
    expect(value).toMatchObject({ protocol: 'dash', ttlSec: SESSION_DEFAULT_TTL_SEC, faults: [] });
    expect(value.stream.id).toBe('vod-cmaf');
    expect(value.live).toBeUndefined();
    expect(value.label).toBeUndefined();
  });

  it('fills the live defaults from the contract: 30 s on air, 15 segments, 6 s presentation delay', () => {
    expect(parsed({ stream: 'live-cmaf' }).live).toEqual({
      startOffsetSec: 30,
      windowSegments: 15,
      presentationDelaySec: 6,
    });
  });

  it('accepts the options a test may set', () => {
    const value = parsed({
      stream: 'live-cmaf',
      protocol: 'hls',
      label: 'PB-LIVE-004',
      ttlSec: 3600,
      faults: [{ type: 'latency', ms: 100 }],
      live: { startOffsetSec: 60, windowSegments: 30, presentationDelaySec: 8 },
    });
    expect(value).toMatchObject({
      protocol: 'hls',
      label: 'PB-LIVE-004',
      ttlSec: 3600,
      live: { startOffsetSec: 60, windowSegments: 30, presentationDelaySec: 8 },
    });
    expect(value.faults).toHaveLength(1);
  });

  it('rejects a body that is not an object', () => {
    for (const body of [null, 'vod-cmaf', 7, ['vod-cmaf']]) {
      expect(problems(body)).toEqual({ status: 400, errors: ['the body must be a JSON object'] });
    }
  });

  it('answers 400 for a stream id that does not exist and 404 for one that exists but is not generated', () => {
    expect(problems({ stream: 'vod-nope' })).toMatchObject({ status: 400 });
    expect(problems({})).toMatchObject({ status: 400 });
    const missing = problems({ stream: 'vod-cmaf-short' });
    expect(missing.status).toBe(404);
    expect(missing.errors[0]).toMatch(/generate:streams/);
  });

  it('rejects HLS for a stream that is not served over HLS, and an unknown protocol', () => {
    expect(problems({ stream: 'vod-webm', protocol: 'hls' }).errors).toContain(
      'vod-webm is not served over hls',
    );
    expect(problems({ stream: 'vod-cmaf', protocol: 'smooth' }).errors).toContain(
      'protocol must be dash or hls',
    );
  });

  it('rejects unknown fields, a long label and a lifetime out of range', () => {
    expect(problems({ stream: 'vod-cmaf', colour: 'red' }).errors).toContain(
      'colour is not a known session field',
    );
    expect(problems({ stream: 'vod-cmaf', label: 'x'.repeat(201) }).errors[0]).toMatch(
      /label must be a string of at most 200/,
    );
    for (const ttlSec of [0, -1, 86_401, Number.NaN, '900']) {
      expect(problems({ stream: 'vod-cmaf', ttlSec }).errors[0]).toMatch(
        /ttlSec must be a number from 1 to 86400/,
      );
    }
  });

  it('reports invalid fault rules with the path of the request field, and knows whether the stream is live', () => {
    expect(problems({ stream: 'vod-cmaf', faults: [{ type: 'throttle', kbps: -1 }] }).errors).toContain(
      'faults[0].kbps must be a number > 0',
    );
    expect(
      problems({ stream: 'vod-cmaf', faults: [{ type: 'live-stall', atNumber: 3, ms: 1000 }] }).errors,
    ).toContain('faults[0]: live-stall needs a live stream');
    expect(
      parsed({ stream: 'live-cmaf', faults: [{ type: 'live-stall', atNumber: 3, ms: 1000 }] }).faults,
    ).toHaveLength(1);
  });

  it('rejects live options on VOD and out-of-range live options', () => {
    expect(problems({ stream: 'vod-cmaf', live: {} }).errors).toContain(
      'live options need a live stream, vod-cmaf is VOD',
    );
    const errors = problems({
      stream: 'live-cmaf',
      live: { startOffsetSec: 1, windowSegments: 1.5, presentationDelaySec: 500, extra: 1 },
    }).errors;
    expect(errors).toEqual([
      'live.extra is not a known live option',
      'live.startOffsetSec must be a number from 2 to 3600',
      'live.windowSegments must be an integer from 2 to 120',
      'live.presentationDelaySec must be a number from 0 to 120',
    ]);
  });

  it('reports every problem at once', () => {
    expect(problems({ stream: 'vod-webm', protocol: 'hls', ttlSec: 0, label: 5 }).errors).toHaveLength(3);
  });
});

describe('SessionStore', () => {
  const vod = parsed({ stream: 'vod-cmaf' });

  function store(limit?: number): { store: SessionStore; clock: ManualClock } {
    const clock = new ManualClock();
    let n = 0;
    return {
      store: new SessionStore({ clock, ...(limit === undefined ? {} : { limit }), newId: () => `id${++n}` }),
      clock,
    };
  }

  it('creates a session that can be fetched by id, and forgets an unknown id', () => {
    const { store: s } = store();
    const session = s.create(vod);
    expect(s.get(session.id)).toBe(session);
    expect(s.get('nope')).toBeUndefined();
    expect(s.size).toBe(1);
  });

  it('never reuses an id that is in use', () => {
    const clock = new ManualClock();
    const ids = ['same', 'same', 'other'];
    const s = new SessionStore({ clock, newId: () => ids.shift()! });
    expect(s.create(vod).id).toBe('same');
    expect(s.create(vod).id).toBe('other');
  });

  it('generates distinct url-safe ids by default', () => {
    const s = new SessionStore({ clock: new ManualClock() });
    const ids = new Set(Array.from({ length: 200 }, () => s.create(vod).id));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('expires a session after its lifetime: the lookup answers undefined and removes it', () => {
    const { store: s, clock } = store();
    const session = s.create(parsed({ stream: 'vod-cmaf', ttlSec: 10 }));
    clock.advance(9999);
    expect(s.get(session.id)).toBe(session);
    clock.advance(1);
    expect(s.get(session.id)).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it('sweeps the expired sessions and counts them', () => {
    const { store: s, clock } = store();
    s.create(parsed({ stream: 'vod-cmaf', ttlSec: 5 }));
    s.create(parsed({ stream: 'vod-cmaf', ttlSec: 5 }));
    const lasting = s.create(parsed({ stream: 'vod-cmaf', ttlSec: 100 }));
    clock.advance(6000);
    expect(s.sweep()).toBe(2);
    expect(s.get(lasting.id)).toBe(lasting);
    expect(s.sweep()).toBe(0);
  });

  it('refuses sessions beyond the limit, but collects expired ones first', () => {
    const { store: s, clock } = store(3);
    s.create(parsed({ stream: 'vod-cmaf', ttlSec: 5 }));
    s.create(vod);
    s.create(vod);
    expect(() => s.create(vod)).toThrow(SessionLimitError);
    clock.advance(6000); // the first one expires: its slot is freed by the sweep inside create
    expect(() => s.create(vod)).not.toThrow();
    expect(s.size).toBe(3);
  });

  it('deletes a session and says whether it existed', () => {
    const { store: s } = store();
    const session = s.create(vod);
    expect(s.delete(session.id)).toBe(true);
    expect(s.delete(session.id)).toBe(false);
    expect(s.get(session.id)).toBeUndefined();
  });

  it('installs the faults of the request', () => {
    const { store: s } = store();
    const session = s.create(
      parsed({ stream: 'vod-cmaf', faults: [{ type: 'throttle', kbps: 600, id: 'slow' }] }),
    );
    expect(session.faults.rules()).toMatchObject([{ id: 'slow', type: 'throttle', kbps: 600 }]);
  });

  it('isolates sessions completely: rules, request log, counters, bodies and attachments are not shared', () => {
    const { store: s } = store();
    const a = s.create(vod);
    const b = s.create(vod);
    a.faults.add([{ type: 'throttle', kbps: 100 }]);
    a.log.begin({ method: 'GET', path: '/a', kind: 'segment', arrivedAtMs: 1, sessionStartMs: 0 });
    a.recordCompletion({ kind: 'segment', bytes: 10, status: 200 });
    a.attachments.set('bucket:f1', {});
    a.manifestBody('/m', { staleManifest: false }, () => 'a-body');
    expect(b.faults.rules()).toEqual([]);
    expect(b.log.size).toBe(0);
    expect(b.counters.requests).toBe(0);
    expect(b.attachments.size).toBe(0);
    expect(b.manifestBody('/m', { staleManifest: true }, () => 'b-fresh')).toBe('b-fresh');
  });
});

describe('Session', () => {
  function make(raw: unknown): { session: ReturnType<SessionStore['create']>; clock: ManualClock } {
    const clock = new ManualClock();
    const store = new SessionStore({ clock, newId: () => 'sess' });
    return { session: store.create(parsed(raw)), clock };
  }

  it('describes a VOD session', () => {
    const { session, clock } = make({ stream: 'vod-cmaf', protocol: 'hls', label: 'PB-VOD-002', ttlSec: 60 });
    expect(session.info(clock.now())).toEqual({
      id: 'sess',
      stream: 'vod-cmaf',
      protocol: 'hls',
      label: 'PB-VOD-002',
      createdAt: new Date(clock.now()).toISOString(),
      ttlSec: 60,
      manifestUrl: '/s/sess/vod-cmaf/hls/master.m3u8',
    });
    expect(session.liveView(clock.now())).toBeUndefined();
  });

  it('puts a live session 30 s on air at creation: availabilityStartTime is created - 30 s and the edge is 15', () => {
    const { session, clock } = make({ stream: 'live-cmaf' });
    const info = session.info(clock.now());
    expect(info.live).toEqual({
      segmentDurationSec: 2,
      availabilityStartTime: new Date(clock.now() - 30_000).toISOString(),
      windowSegments: 15,
      presentationDelaySec: 6,
      edgeNumber: 15,
      stalled: false,
    });
    expect(info.manifestUrl).toBe('/s/sess/live-cmaf/dash/manifest.mpd');
    clock.advance(4000);
    expect(session.info(clock.now()).live?.edgeNumber).toBe(17);
  });

  it('shows a live stall in the live clock info, and the stall ends by itself', () => {
    const { session, clock } = make({ stream: 'live-cmaf' });
    session.faults.add([{ type: 'live-stall', atNumber: 18, ms: 10_000 }]); // starts at 36 s of stream time = 6 s from now
    clock.advance(5000);
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 17, stalled: false });
    clock.advance(1000);
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 18, stalled: true });
    clock.advance(8000);
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 18, stalled: true });
    clock.advance(2000); // t = 16 s after creation: the stall ended at 6 + 10
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 23, stalled: false });
  });

  it('removing a live-stall rule ends the stall at once (the origin catches up)', () => {
    const { session, clock } = make({
      stream: 'live-cmaf',
      faults: [{ type: 'live-stall', atNumber: 16, ms: 60_000, id: 'outage' }],
    });
    clock.advance(4000); // the free edge would be 17, the stall froze it at 16
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 16, stalled: true });
    session.faults.remove('outage');
    expect(session.info(clock.now()).live).toMatchObject({ edgeNumber: 17, stalled: false });
  });

  it('counts completed responses: requests, bytes, errors (4xx, 5xx and aborts) and kinds', () => {
    const { session } = make({ stream: 'vod-cmaf' });
    session.recordCompletion({ kind: 'segment', bytes: 1000, status: 200 });
    session.recordCompletion({ kind: 'segment', bytes: 0, status: 404 });
    session.recordCompletion({ kind: 'manifest', bytes: 500, status: 200 });
    session.recordCompletion({ kind: 'segment', bytes: 300, status: 200, aborted: true });
    expect(session.detail(0).counters).toEqual({
      requests: 4,
      bytes: 1800,
      errors: 2,
      byKind: { segment: 3, manifest: 1 },
    });
  });

  it('detail adds the stored rules and copies of the counters', () => {
    const { session } = make({ stream: 'vod-cmaf', faults: [{ type: 'abort', id: 'cut' }] });
    const detail = session.detail(0);
    expect(detail.faults).toEqual([{ type: 'abort', id: 'cut' }]);
    detail.counters.requests = 99;
    expect(session.counters.requests).toBe(0);
  });
});

describe('manifest-stale replay (Session.manifestBody)', () => {
  function liveSession(): {
    session: ReturnType<SessionStore['create']>;
    clock: ManualClock;
    serve: (url: string, facts?: 'manifest') => string;
  } {
    const clock = new ManualClock();
    const session = new SessionStore({ clock, newId: () => 'sess' }).create(
      parsed({
        stream: 'live-cmaf',
        faults: [{ type: 'manifest-stale', ms: 6000, afterMs: 4000, id: 'stale' }],
      }),
    );
    let version = 0;
    let seq = 0;
    const serve = (url: string): string => {
      const plan = session.faults.evaluate({ kind: 'manifest' }, ++seq, clock.now());
      return session.manifestBody(url, plan, () => `${url}#v${++version}`);
    };
    return { session, clock, serve };
  }

  it('serves fresh bodies, then replays the last one served before the rule became active, then serves fresh bodies again', () => {
    const { session, clock, serve } = liveSession();
    session.faults.evaluate({ kind: 'init' }, 0, clock.now()); // the first media request starts the rule clock
    expect(serve('/m')).toBe('/m#v1');
    clock.advance(2000);
    expect(serve('/m')).toBe('/m#v2'); // before afterMs: fresh
    clock.advance(2000); // the rule becomes active now (4 s after the origin)
    expect(serve('/m')).toBe('/m#v2'); // the last body served before the rule was active
    clock.advance(3000);
    expect(serve('/m')).toBe('/m#v2'); // still replayed: a body is not even built while the replay is served
    clock.advance(2999);
    expect(serve('/m')).toBe('/m#v2');
    clock.advance(1); // the window ends at origin + 4 s + 6 s
    expect(serve('/m')).toBe('/m#v3'); // the first fresh body after the replay: v3, because nothing was built during it
  });

  it('replays per URL', () => {
    const { session, clock, serve } = liveSession();
    session.faults.evaluate({ kind: 'init' }, 0, clock.now());
    expect(serve('/video.m3u8')).toBe('/video.m3u8#v1');
    expect(serve('/audio.m3u8')).toBe('/audio.m3u8#v2');
    clock.advance(4000);
    expect(serve('/video.m3u8')).toBe('/video.m3u8#v1');
    expect(serve('/audio.m3u8')).toBe('/audio.m3u8#v2');
  });

  it('serves the current body of a URL that was never served before the rule, and replays that one for the rest of the window', () => {
    const { session, clock, serve } = liveSession();
    session.faults.evaluate({ kind: 'init' }, 0, clock.now());
    clock.advance(4500); // the rule is active and /new has never been requested
    expect(serve('/new')).toBe('/new#v1');
    clock.advance(1000);
    expect(serve('/new')).toBe('/new#v1');
    clock.advance(5000); // the window is over
    expect(serve('/new')).toBe('/new#v2');
  });
});
