import { describe, expect, it } from 'vitest';
import { FaultEngine, jitterUnit, validateFaultRules } from '../../../src/server/faults.ts';
import type { FaultPlan, RequestFacts } from '../../../src/server/faults.ts';
import { MAX_FAULT_RULES_PER_SESSION } from '../../../src/server/constants.ts';
import { ManualClock } from '../support/manual-clock.ts';

const VOD = { live: false };
const LIVE = { live: true };

const segment = (number: number, rep = 'v240', track: 'video' | 'audio' = 'video'): RequestFacts => ({
  kind: 'segment',
  rep,
  track,
  number,
});
const init: RequestFacts = { kind: 'init', rep: 'v240', track: 'video' };
const manifest: RequestFacts = { kind: 'manifest' };

function engine(live = false): { engine: FaultEngine; clock: ManualClock } {
  const clock = new ManualClock();
  return { engine: new FaultEngine({ sessionId: 'sess-1', live, clock }), clock };
}

function errorsOf(raw: unknown, ctx = VOD): string[] {
  const result = validateFaultRules(raw, ctx);
  return result.ok ? [] : result.errors;
}

describe('validateFaultRules: what is rejected', () => {
  it('rejects anything that is not an array of objects', () => {
    expect(errorsOf({ type: 'throttle', kbps: 100 })).toEqual(['rules must be an array']);
    expect(errorsOf([42])).toEqual(['rules[0] must be an object']);
    expect(errorsOf([null])).toEqual(['rules[0] must be an object']);
  });

  it('rejects an unknown type and says which are known', () => {
    const [error] = errorsOf([{ type: 'explode' }]);
    expect(error).toMatch(/rules\[0\]\.type must be one of throttle, latency, status/);
  });

  it('rejects an unknown field, so that a typo cannot become a rule that silently does nothing', () => {
    expect(errorsOf([{ type: 'throttle', kbit: 500 }])).toContain('rules[0].kbit is not a field of throttle');
    expect(errorsOf([{ type: 'throttle', kbps: 500, tims: 2 }])).toContain(
      'rules[0].tims is not a field of throttle',
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '1500'],
  ])('rejects a throttle with kbps %s', (_name, kbps) => {
    expect(errorsOf([{ type: 'throttle', kbps }])).toContain('rules[0].kbps must be a number > 0');
  });

  it('rejects negative latency and jitter, accepts zero latency', () => {
    expect(errorsOf([{ type: 'latency', ms: -1 }])).toContain('rules[0].ms must be a number >= 0');
    expect(errorsOf([{ type: 'latency', ms: 10, jitterMs: -1 }])).toContain(
      'rules[0].jitterMs must be a number >= 0',
    );
    expect(errorsOf([{ type: 'latency', ms: 0 }])).toEqual([]);
  });

  // 1xx are interim responses: a client that is answered 101 or 199 waits for a final response that never comes.
  it.each([99, 100, 101, 199, 600, 404.5, '404', null])('rejects status %j', (status) => {
    expect(errorsOf([{ type: 'status', status, match: { kind: 'segment' } }])).toContain(
      'rules[0].status must be an integer from 200 to 599',
    );
  });

  it.each([200, 204, 304, 404, 503, 599])('accepts status %j', (status) => {
    expect(errorsOf([{ type: 'status', status, match: { kind: 'segment' } }])).toEqual([]);
  });

  it('requires match.kind for a status rule (no default: a 503 on everything is rarely what a test wants)', () => {
    expect(errorsOf([{ type: 'status', status: 503 }])).toContain(
      'rules[0].match.kind is required for status',
    );
    expect(errorsOf([{ type: 'status', status: 503, match: {} }])).toContain(
      'rules[0].match.kind is required for status',
    );
    expect(errorsOf([{ type: 'status', status: 503, match: { kind: 'media' } }])).toEqual([]);
  });

  it('rejects bad byte counts and durations for stall and abort', () => {
    expect(errorsOf([{ type: 'stall', afterBytes: -1, ms: 10 }])).toContain(
      'rules[0].afterBytes must be an integer >= 0',
    );
    expect(errorsOf([{ type: 'stall', afterBytes: 1.5, ms: 10 }])).toContain(
      'rules[0].afterBytes must be an integer >= 0',
    );
    expect(errorsOf([{ type: 'stall', afterBytes: 0, ms: -1 }])).toContain(
      'rules[0].ms must be a number >= 0',
    );
    expect(errorsOf([{ type: 'abort', afterBytes: -1 }])).toContain(
      'rules[0].afterBytes must be an integer >= 0',
    );
    expect(errorsOf([{ type: 'abort' }])).toEqual([]);
  });

  it('rejects live-stall and manifest-stale on a VOD session', () => {
    expect(errorsOf([{ type: 'live-stall', atNumber: 5, ms: 1000 }], VOD)).toContain(
      'rules[0]: live-stall needs a live stream',
    );
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000 }], VOD)).toContain(
      'rules[0]: manifest-stale needs a live stream',
    );
    expect(errorsOf([{ type: 'live-stall', atNumber: 5, ms: 1000 }], LIVE)).toEqual([]);
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000 }], LIVE)).toEqual([]);
  });

  it('gives live-stall no match, times, afterMs or forMs, and needs atNumber >= 1 and ms > 0', () => {
    for (const extra of [{ match: { kind: 'any' } }, { times: 1 }, { afterMs: 5 }, { forMs: 5 }]) {
      const key = Object.keys(extra)[0]!;
      expect(errorsOf([{ type: 'live-stall', atNumber: 5, ms: 1000, ...extra }], LIVE)).toContain(
        `rules[0].${key} is not allowed for live-stall`,
      );
    }
    expect(errorsOf([{ type: 'live-stall', atNumber: 0, ms: 1000 }], LIVE)).toContain(
      'rules[0].atNumber must be an integer >= 1',
    );
    expect(errorsOf([{ type: 'live-stall', atNumber: 2.5, ms: 1000 }], LIVE)).toContain(
      'rules[0].atNumber must be an integer >= 1',
    );
    expect(errorsOf([{ type: 'live-stall', atNumber: 5, ms: 0 }], LIVE)).toContain(
      'rules[0].ms must be a number > 0',
    );
  });

  it('gives manifest-stale no forMs or times, only manifest or any as kind, and needs ms > 0', () => {
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000, forMs: 5 }], LIVE)).toContain(
      'rules[0].forMs is not allowed for manifest-stale',
    );
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000, times: 2 }], LIVE)).toContain(
      'rules[0].times is not allowed for manifest-stale',
    );
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000, match: { kind: 'segment' } }], LIVE)).toContain(
      'rules[0].match.kind must be manifest or any for manifest-stale',
    );
    expect(errorsOf([{ type: 'manifest-stale', ms: 1000, match: { kind: 'any' } }], LIVE)).toEqual([]);
    expect(errorsOf([{ type: 'manifest-stale', ms: 0 }], LIVE)).toContain('rules[0].ms must be a number > 0');
  });

  it('rejects a times that is not a positive integer and negative afterMs or forMs', () => {
    expect(errorsOf([{ type: 'throttle', kbps: 1, times: 0 }])).toContain(
      'rules[0].times must be an integer >= 1',
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, times: 1.5 }])).toContain(
      'rules[0].times must be an integer >= 1',
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, afterMs: -1 }])).toContain(
      'rules[0].afterMs must be a number >= 0',
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, forMs: -1 }])).toContain(
      'rules[0].forMs must be a number >= 0',
    );
  });

  it('rejects a malformed match', () => {
    expect(errorsOf([{ type: 'throttle', kbps: 1, match: 'v240' }])).toContain(
      'rules[0].match must be an object',
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, match: { colour: 'red' } }])).toContain(
      'rules[0].match.colour is not a known match field',
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, match: { kind: 'video' } }])[0]).toMatch(
      /match\.kind must be one of/,
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, match: { track: 'text' } }])[0]).toMatch(
      /match\.track must be one of/,
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, match: { rep: '' } }])).toContain(
      'rules[0].match.rep must be a non-empty string',
    );
    for (const number of [0, -1, 1.5, { from: 3, to: 2 }, { from: 0, to: 2 }, { from: 1 }, 'three']) {
      expect(errorsOf([{ type: 'throttle', kbps: 1, match: { number } }])[0]).toMatch(
        /match\.number must be an integer >= 1/,
      );
    }
  });

  it('rejects duplicate and malformed ids', () => {
    expect(
      errorsOf([
        { type: 'throttle', kbps: 1, id: 'a' },
        { type: 'throttle', kbps: 2, id: 'a' },
      ]),
    ).toContain('duplicate rule id a');
    expect(errorsOf([{ type: 'throttle', kbps: 1, id: 'has space' }])[0]).toMatch(
      /rules\[0\]\.id must match/,
    );
    expect(errorsOf([{ type: 'throttle', kbps: 1, id: '' }])[0]).toMatch(/rules\[0\]\.id must match/);
  });

  it('reports every problem, not only the first', () => {
    const errors = errorsOf([{ type: 'throttle', kbps: -1 }, { type: 'latency', ms: -1 }, { type: 'nope' }]);
    expect(errors).toHaveLength(3);
  });
});

describe('validateFaultRules: what is accepted', () => {
  it('accepts every type with its parameters, and keeps only the known fields', () => {
    const result = validateFaultRules(
      [
        {
          type: 'throttle',
          kbps: 1500,
          match: { kind: 'media', track: 'video' },
          times: 3,
          afterMs: 100,
          forMs: 5000,
        },
        { type: 'latency', ms: 300, jitterMs: 100 },
        { type: 'status', status: 503, match: { kind: 'segment', number: { from: 3, to: 4 } } },
        { type: 'stall', afterBytes: 1000, ms: 2000 },
        { type: 'abort', afterBytes: 20_000, match: { rep: 'v720' } },
        { type: 'live-stall', atNumber: 20, ms: 10_000 },
        { type: 'manifest-stale', ms: 8000, afterMs: 1000 },
      ],
      LIVE,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rules).toHaveLength(7);
  });

  it('does not alias the caller input', () => {
    const input = [{ type: 'throttle', kbps: 1500, match: { rep: 'v240' } }];
    const result = validateFaultRules(input, VOD);
    input[0]!.kbps = 1;
    input[0]!.match.rep = 'changed';
    expect(result.ok && result.rules[0]).toMatchObject({ kbps: 1500, match: { rep: 'v240' } });
  });
});

describe('FaultEngine: storing rules', () => {
  it('assigns ids f1, f2, ... and keeps the ids a test chose', () => {
    const { engine: e } = engine();
    const added = e.add([
      { type: 'throttle', kbps: 1 },
      { type: 'latency', ms: 1, id: 'mine' },
      { type: 'abort' },
    ]);
    expect(added.ok && added.rules.map((r) => r.id)).toEqual(['f1', 'mine', 'f2']);
  });

  it('never hands out an id that a test already chose', () => {
    const { engine: e } = engine();
    e.add([{ type: 'abort', id: 'f1' }]);
    const added = e.add([{ type: 'abort' }]);
    expect(added.ok && added.rules[0]!.id).toBe('f2');
  });

  it('rejects a whole batch when one rule is invalid or an id exists: nothing is added', () => {
    const { engine: e } = engine();
    e.add([{ type: 'abort', id: 'keep' }]);
    expect(
      e.add([
        { type: 'throttle', kbps: 1 },
        { type: 'throttle', kbps: -1 },
      ]).ok,
    ).toBe(false);
    expect(
      e.add([
        { type: 'throttle', kbps: 1 },
        { type: 'abort', id: 'keep' },
      ]),
    ).toEqual({
      ok: false,
      errors: ['rule id keep already exists'],
    });
    expect(e.rules().map((r) => r.id)).toEqual(['keep']);
  });

  it(`holds at most ${MAX_FAULT_RULES_PER_SESSION} rules`, () => {
    const { engine: e } = engine();
    const many = Array.from({ length: MAX_FAULT_RULES_PER_SESSION }, () => ({ type: 'abort' }));
    expect(e.add(many).ok).toBe(true);
    expect(e.add([{ type: 'abort' }]).ok).toBe(false);
  });

  it('replace swaps the whole list, and an invalid list changes nothing', () => {
    const { engine: e } = engine();
    e.add([{ type: 'throttle', kbps: 1, id: 'old' }]);
    expect(e.replace([{ type: 'throttle', kbps: -1 }]).ok).toBe(false);
    expect(e.rules().map((r) => r.id)).toEqual(['old']);
    const replaced = e.replace([{ type: 'latency', ms: 5, id: 'new' }]);
    expect(replaced.ok && replaced.rules.map((r) => r.id)).toEqual(['new']);
    expect(e.rules().map((r) => r.id)).toEqual(['new']);
  });

  it('removes a rule by id and says whether it existed', () => {
    const { engine: e } = engine();
    e.add([{ type: 'abort', id: 'a' }]);
    expect(e.remove('a')).toBe(true);
    expect(e.remove('a')).toBe(false);
    expect(e.rules()).toEqual([]);
  });

  it('returns copies of the rules', () => {
    const { engine: e } = engine();
    e.add([{ type: 'throttle', kbps: 1500, id: 'a' }]);
    const rule = e.rules()[0];
    if (rule?.type !== 'throttle') throw new Error('expected the throttle rule that was added');
    rule.kbps = 1;
    expect(e.rules()[0]).toMatchObject({ kbps: 1500 });
  });

  it('exposes live-stall rules with the instant they were installed, and forgets them when they are removed', () => {
    const { engine: e, clock } = engine(true);
    clock.advance(5000);
    e.add([
      { type: 'live-stall', atNumber: 20, ms: 10_000, id: 'stall' },
      { type: 'throttle', kbps: 1 },
    ]);
    expect(e.liveStalls()).toEqual([
      { ruleId: 'stall', atNumber: 20, ms: 10_000, installedAtMs: clock.now() },
    ]);
    e.remove('stall');
    expect(e.liveStalls()).toEqual([]);
  });
});

describe('FaultEngine: the rule clock', () => {
  it('starts at the first media request: an init or a segment, never a manifest', () => {
    const { engine: e, clock } = engine();
    expect(e.origin).toBeUndefined();
    e.evaluate(manifest, 1);
    expect(e.origin).toBeUndefined();
    clock.advance(700);
    e.evaluate(init, 2);
    expect(e.origin).toBe(clock.now());
    clock.advance(500);
    e.evaluate(segment(1), 3);
    expect(e.origin).toBe(clock.now() - 500); // it does not move
  });

  it('before the first media request a rule with afterMs 0 is active and a rule with afterMs > 0 is not', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'latency', ms: 10, match: { kind: 'any' } },
      { type: 'latency', ms: 99, afterMs: 1, match: { kind: 'any' } },
    ]);
    expect(e.evaluate(manifest, 1).latencyMs).toBe(10);
  });

  it('activates afterMs after the origin and ends forMs later (end exclusive)', () => {
    const { engine: e, clock } = engine();
    e.add([{ type: 'status', status: 503, match: { kind: 'segment' }, afterMs: 1000, forMs: 2000 }]);
    e.evaluate(init, 1); // origin = now
    const status = (): number | undefined => e.evaluate(segment(1), 9).status;
    clock.advance(999);
    expect(status()).toBeUndefined();
    clock.advance(1);
    expect(status()).toBe(503);
    clock.advance(1999);
    expect(status()).toBe(503);
    clock.advance(1);
    expect(status()).toBeUndefined();
  });

  it('a rule without forMs stays active for ever once active', () => {
    const { engine: e, clock } = engine();
    e.add([{ type: 'throttle', kbps: 600, afterMs: 8000 }]);
    e.evaluate(init, 1);
    clock.advance(8000);
    expect(e.evaluate(segment(1), 2).throttle).toHaveLength(1);
    clock.advance(10 * 60_000);
    expect(e.evaluate(segment(2), 3).throttle).toHaveLength(1);
  });
});

describe('FaultEngine: times', () => {
  it('fires on the first N matching requests and then goes quiet', () => {
    const { engine: e } = engine();
    e.add([{ type: 'status', status: 503, match: { kind: 'segment', number: 3 }, times: 2 }]);
    const fire = (n: number): number | undefined => e.evaluate(segment(n), n).status;
    expect(fire(3)).toBe(503);
    expect(fire(3)).toBe(503);
    expect(fire(3)).toBeUndefined();
  });

  it('is not used up by requests that do not match', () => {
    const { engine: e } = engine();
    e.add([{ type: 'status', status: 404, match: { kind: 'segment', number: 3 }, times: 1 }]);
    expect(e.evaluate(segment(1), 1).status).toBeUndefined();
    expect(e.evaluate(init, 2).status).toBeUndefined();
    expect(e.evaluate(segment(3), 3).status).toBe(404);
  });

  it('counts only the matching requests while the rule is active (a request before afterMs is not counted)', () => {
    const { engine: e, clock } = engine();
    e.add([{ type: 'status', status: 503, match: { kind: 'segment' }, afterMs: 1000, times: 1 }]);
    e.evaluate(init, 1);
    expect(e.evaluate(segment(1), 2).status).toBeUndefined(); // not yet active: not counted
    clock.advance(1000);
    expect(e.evaluate(segment(2), 3).status).toBe(503);
    expect(e.evaluate(segment(3), 4).status).toBeUndefined();
  });

  it('is counted per rule', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'status', status: 503, match: { kind: 'segment' }, times: 1, id: 'a' },
      { type: 'latency', ms: 5, match: { kind: 'segment' }, times: 2, id: 'b' },
    ]);
    expect(e.evaluate(segment(1), 1).fired).toEqual(['a', 'b']);
    expect(e.evaluate(segment(2), 2).fired).toEqual(['b']);
    expect(e.evaluate(segment(3), 3).fired).toEqual([]);
  });
});

describe('FaultEngine: matching', () => {
  const fires = (match: object | undefined, facts: RequestFacts, type = 'abort'): boolean => {
    const { engine: e } = engine();
    const rule = match === undefined ? { type } : { type, match };
    const added = e.add([type === 'status' ? { type, status: 500, match } : rule]);
    expect(added.ok).toBe(true);
    return e.evaluate(facts, 1).fired.length > 0;
  };

  it('defaults to media (init and segment) for throttle, latency, stall and abort', () => {
    expect(fires(undefined, segment(1))).toBe(true);
    expect(fires(undefined, init)).toBe(true);
    expect(fires(undefined, manifest)).toBe(false);
  });

  it('knows media, manifest, init, segment and any', () => {
    expect(fires({ kind: 'media' }, manifest)).toBe(false);
    expect(fires({ kind: 'manifest' }, manifest)).toBe(true);
    expect(fires({ kind: 'manifest' }, segment(1))).toBe(false);
    expect(fires({ kind: 'init' }, init)).toBe(true);
    expect(fires({ kind: 'init' }, segment(1))).toBe(false);
    expect(fires({ kind: 'segment' }, init)).toBe(false);
    expect(fires({ kind: 'any' }, manifest)).toBe(true);
    expect(fires({ kind: 'any' }, init)).toBe(true);
  });

  it('matches the track and the representation exactly', () => {
    expect(fires({ track: 'video' }, segment(1, 'v240', 'video'))).toBe(true);
    expect(fires({ track: 'video' }, segment(1, 'a-aac', 'audio'))).toBe(false);
    expect(fires({ track: 'any' }, segment(1, 'a-aac', 'audio'))).toBe(true);
    expect(fires({ track: 'video' }, { kind: 'manifest' })).toBe(false);
    expect(fires({ kind: 'any', rep: 'v720' }, segment(1, 'v720'))).toBe(true);
    expect(fires({ kind: 'any', rep: 'v720' }, segment(1, 'v240'))).toBe(false);
    expect(fires({ kind: 'any', rep: 'v720' }, manifest)).toBe(false);
  });

  it('matches a segment number and an inclusive range, and never an init or a manifest', () => {
    expect(fires({ number: 3 }, segment(3))).toBe(true);
    expect(fires({ number: 3 }, segment(4))).toBe(false);
    expect(fires({ number: { from: 3, to: 5 } }, segment(3))).toBe(true);
    expect(fires({ number: { from: 3, to: 5 } }, segment(5))).toBe(true);
    expect(fires({ number: { from: 3, to: 5 } }, segment(6))).toBe(false);
    expect(fires({ number: 3 }, init)).toBe(false);
    expect(fires({ kind: 'any', number: 3 }, manifest)).toBe(false);
  });

  it('needs every field of the match to match', () => {
    const match = { kind: 'segment', rep: 'v240', number: 3 };
    expect(fires(match, segment(3, 'v240'))).toBe(true);
    expect(fires(match, segment(3, 'v360'))).toBe(false);
    expect(fires(match, segment(4, 'v240'))).toBe(false);
  });
});

describe('FaultEngine: the plan of one request', () => {
  it('lets several rules fire on one request: throttle and latency together', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'throttle', kbps: 1500, id: 't' },
      { type: 'latency', ms: 200, id: 'l' },
    ]);
    const plan: FaultPlan = e.evaluate(segment(1), 1);
    expect(plan.fired).toEqual(['t', 'l']);
    expect(plan.throttle).toEqual([{ ruleId: 't', kbps: 1500 }]);
    expect(plan.latencyMs).toBe(200);
  });

  it('limits a response by every throttle rule that fires (the slowest wins in the bucket)', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'throttle', kbps: 1500, id: 'a' },
      { type: 'throttle', kbps: 600, id: 'b', match: { track: 'video' } },
    ]);
    expect(e.evaluate(segment(1), 1).throttle).toEqual([
      { ruleId: 'a', kbps: 1500 },
      { ruleId: 'b', kbps: 600 },
    ]);
    expect(e.evaluate(segment(1, 'a-aac', 'audio'), 2).throttle).toEqual([{ ruleId: 'a', kbps: 1500 }]);
  });

  it('adds up the delays of several latency rules', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'latency', ms: 100 },
      { type: 'latency', ms: 250 },
    ]);
    expect(e.evaluate(segment(1), 1).latencyMs).toBe(350);
  });

  it('takes the first status, stall and abort rule in rule order when several fire', () => {
    const { engine: e } = engine();
    e.add([
      { type: 'status', status: 503, match: { kind: 'segment' } },
      { type: 'status', status: 404, match: { kind: 'segment' } },
      { type: 'stall', afterBytes: 10, ms: 100 },
      { type: 'stall', afterBytes: 20, ms: 200 },
      { type: 'abort', afterBytes: 5 },
      { type: 'abort' },
    ]);
    const plan = e.evaluate(segment(1), 1);
    expect(plan.status).toBe(503);
    expect(plan.stall).toEqual({ afterBytes: 10, ms: 100 });
    expect(plan.abort).toEqual({ afterBytes: 5 });
    expect(plan.fired).toHaveLength(6);
  });

  it('defaults an abort to 0 bytes', () => {
    const { engine: e } = engine();
    e.add([{ type: 'abort' }]);
    expect(e.evaluate(segment(1), 1).abort).toEqual({ afterBytes: 0 });
  });

  it('is empty when nothing fires', () => {
    const { engine: e } = engine();
    expect(e.evaluate(segment(1), 1)).toEqual({
      fired: [],
      latencyMs: 0,
      throttle: [],
      staleManifest: false,
    });
  });

  it('ignores live-stall rules: they act on the live clock, not on a request', () => {
    const { engine: e } = engine(true);
    e.add([{ type: 'live-stall', atNumber: 3, ms: 1000 }]);
    expect(e.evaluate(segment(3), 1).fired).toEqual([]);
  });
});

describe('FaultEngine: manifest-stale', () => {
  it('is active for ms after the origin plus afterMs, for manifests only', () => {
    const { engine: e, clock } = engine(true);
    e.add([{ type: 'manifest-stale', ms: 5000, afterMs: 1000 }]);
    e.evaluate(init, 1);
    expect(e.evaluate(manifest, 2).staleManifest).toBe(false);
    clock.advance(1000);
    expect(e.evaluate(manifest, 3).staleManifest).toBe(true);
    expect(e.evaluate(segment(1), 4).staleManifest).toBe(false);
    clock.advance(4999);
    expect(e.evaluate(manifest, 5).staleManifest).toBe(true);
    clock.advance(1);
    expect(e.evaluate(manifest, 6).staleManifest).toBe(false);
  });

  it('can be limited to one playlist (HLS media playlists have a rep)', () => {
    const { engine: e } = engine(true);
    e.add([{ type: 'manifest-stale', ms: 5000, match: { rep: 'v360' } }]);
    expect(e.evaluate({ kind: 'manifest', rep: 'v360' }, 1).staleManifest).toBe(true);
    expect(e.evaluate({ kind: 'manifest', rep: 'v720' }, 2).staleManifest).toBe(false);
    expect(e.evaluate(manifest, 3).staleManifest).toBe(false);
  });
});

describe('jitter', () => {
  it('is a pure function of (session id, request seq, rule id): the same input gives the same draw', () => {
    expect(jitterUnit('s', 7, 'f1')).toBe(jitterUnit('s', 7, 'f1'));
    expect(jitterUnit('s', 7, 'f1')).not.toBe(jitterUnit('s', 8, 'f1'));
    expect(jitterUnit('s', 7, 'f1')).not.toBe(jitterUnit('t', 7, 'f1'));
    expect(jitterUnit('s', 7, 'f1')).not.toBe(jitterUnit('s', 7, 'f2'));
  });

  it('is uniform in [-1, 1): bounded, centred and spread', () => {
    const draws = Array.from({ length: 5000 }, (_, seq) => jitterUnit('sess', seq, 'f1'));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...draws)).toBeLessThan(1);
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(draws.filter((d) => d < -0.5).length / draws.length).toBeGreaterThan(0.2);
    expect(draws.filter((d) => d > 0.5).length / draws.length).toBeGreaterThan(0.2);
  });

  it('gives the same delays for the same session and request order, other delays for another session', () => {
    const delays = (sessionId: string): number[] => {
      const clock = new ManualClock();
      const e = new FaultEngine({ sessionId, live: false, clock });
      e.add([{ type: 'latency', ms: 300, jitterMs: 100 }]);
      return Array.from({ length: 20 }, (_, i) => e.evaluate(segment(i + 1), i + 1).latencyMs);
    };
    expect(delays('abc')).toEqual(delays('abc'));
    expect(delays('abc')).not.toEqual(delays('abd'));
  });

  it('keeps the delay within ms +- jitterMs and never below zero', () => {
    const { engine: e } = engine();
    e.add([{ type: 'latency', ms: 300, jitterMs: 100, id: 'wide' }]);
    for (let seq = 1; seq <= 500; seq++) {
      const delay = e.evaluate(segment(1), seq).latencyMs;
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThan(400);
    }
    const { engine: small } = engine();
    small.add([{ type: 'latency', ms: 10, jitterMs: 100 }]);
    for (let seq = 1; seq <= 500; seq++)
      expect(small.evaluate(segment(1), seq).latencyMs).toBeGreaterThanOrEqual(0);
  });
});
