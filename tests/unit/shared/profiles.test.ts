import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FaultRule } from '../../../src/shared/faults.ts';
import {
  PROFILE_DEFINITIONS,
  PROFILE_FACTORIES,
  PROFILE_NAMES,
  originStall,
  profile,
  staleManifest,
} from '../../../src/shared/profiles.ts';
import type { ProfileName } from '../../../src/shared/profiles.ts';

// The stream ladder of docs/CONTRACTS.md section 3: video 300, 700 and 1800 kbps, audio 64 kbps, 2 s segments.
const LADDER_KBPS = { v240: 300, v360: 700, v720: 1800 } as const;
const AUDIO_KBPS = 64;
const SEGMENT_SEC = 2;
const KNOWN_REPS = ['v240', 'v360', 'v720', 'a-aac', 'a-opus'];

/** The Shaka 5.3.3 defaults the profiles are designed around, read from the pinned package so a bump cannot silently break them. */
function shakaRetryDefaults(): { maxAttempts: number; connectionTimeout: number } {
  const url = new URL('../../../node_modules/shaka-player/lib/net/backoff.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const defaults = source.slice(source.indexOf('defaultRetryParameters'));
  const read = (key: string): number => {
    const match = new RegExp(`${key}:\\s*(\\d+)`).exec(defaults);
    if (!match)
      throw new Error(
        `cannot find ${key} in Shaka's default retry parameters: update this test and the profiles`,
      );
    return Number(match[1]);
  };
  return { maxAttempts: read('maxAttempts'), connectionTimeout: read('connectionTimeout') };
}

const allRules = PROFILE_NAMES.flatMap((name) =>
  PROFILE_DEFINITIONS[name].rules.map((rule) => ({ name, rule })),
);
const rulesOf = (name: ProfileName): readonly FaultRule[] => PROFILE_DEFINITIONS[name].rules;

describe('PB-LAB-007 fault profiles: shapes and numeric sanity', () => {
  it('has the profiles the strategy names', () => {
    for (const name of [
      'clean',
      'constrained-1500',
      'constrained-600',
      'bandwidth-drop',
      'high-latency',
      'flaky-segments',
      'slow-segment',
    ] as const) {
      expect(PROFILE_NAMES).toContain(name);
    }
  });

  it('survives a JSON round trip unchanged, because rules travel to the service as JSON', () => {
    for (const name of PROFILE_NAMES) {
      const rules = profile(name);
      expect(JSON.parse(JSON.stringify(rules)), name).toStrictEqual(rules);
    }
    // NaN and Infinity would turn into null on the wire and silently change the condition.
    expect(JSON.stringify(allRules.map((r) => r.rule))).not.toMatch(/null/);
  });

  it.each(allRules.map(({ name, rule }) => [`${name}: ${rule.type}`, rule] as const))(
    '%s has sane numbers',
    (_label, rule) => {
      const positiveInt = (n: number | undefined): boolean => n !== undefined && Number.isInteger(n) && n > 0;
      switch (rule.type) {
        case 'throttle':
          expect(positiveInt(rule.kbps)).toBe(true);
          expect(rule.kbps).toBeLessThan(100_000);
          break;
        case 'latency':
          expect(positiveInt(rule.ms)).toBe(true);
          expect(rule.ms).toBeLessThanOrEqual(10_000);
          if (rule.jitterMs !== undefined) {
            expect(Number.isInteger(rule.jitterMs) && rule.jitterMs >= 0).toBe(true);
            // Symmetric jitter on a base delay must never reach below zero.
            expect(rule.jitterMs).toBeLessThanOrEqual(rule.ms);
          }
          break;
        case 'status':
          expect(Number.isInteger(rule.status) && rule.status >= 400 && rule.status <= 599).toBe(true);
          // faults.ts: a status rule has no default for `kind`; an unscoped one would fail the manifest as well.
          expect(rule.match?.kind).toBeDefined();
          break;
        case 'stall':
          expect(rule.afterBytes).toBeGreaterThanOrEqual(0);
          expect(positiveInt(rule.ms)).toBe(true);
          break;
        case 'abort':
          if (rule.afterBytes !== undefined) {
            expect(Number.isInteger(rule.afterBytes) && rule.afterBytes >= 0).toBe(true);
          }
          break;
        case 'live-stall':
          expect(positiveInt(rule.atNumber) && positiveInt(rule.ms)).toBe(true);
          break;
        case 'manifest-stale':
          expect(positiveInt(rule.ms)).toBe(true);
          break;
      }
      if (rule.times !== undefined) expect(positiveInt(rule.times)).toBe(true);
      if (rule.afterMs !== undefined) expect(Number.isInteger(rule.afterMs) && rule.afterMs >= 0).toBe(true);
      if (rule.forMs !== undefined) expect(positiveInt(rule.forMs)).toBe(true);
      const { number, rep } = rule.match ?? {};
      if (typeof number === 'number') expect(positiveInt(number)).toBe(true);
      if (typeof number === 'object') {
        expect(positiveInt(number.from) && number.to >= number.from).toBe(true);
      }
      if (rep !== undefined) expect(KNOWN_REPS).toContain(rep);
    },
  );

  it('chooses the throttles so that the ladder arithmetic of the purposes holds', () => {
    const throttle = (name: ProfileName): number => {
      const rule = rulesOf(name).find((r) => r.type === 'throttle');
      if (rule?.type !== 'throttle') throw new Error(`${name} has no throttle`);
      return rule.kbps;
    };
    const needs = (rung: keyof typeof LADDER_KBPS): number => LADDER_KBPS[rung] + AUDIO_KBPS;

    // 1500 kbps carries 360p with headroom but not 720p; 600 kbps carries 240p but not 360p.
    expect(throttle('constrained-1500')).toBeGreaterThan(needs('v360'));
    expect(throttle('constrained-1500')).toBeLessThan(needs('v720'));
    expect(throttle('constrained-600')).toBeGreaterThan(needs('v240'));
    expect(throttle('constrained-600')).toBeLessThan(needs('v360'));

    // The drop lands on the same link as constrained-600, after the first four segments.
    const drop = rulesOf('bandwidth-drop')[0];
    expect(drop?.type === 'throttle' && drop.kbps).toBe(throttle('constrained-600'));
    expect(drop?.afterMs).toBe(4 * SEGMENT_SEC * 1000);
  });

  it('builds the failure profiles around the retry policy that Shaka 5.3.3 ships', () => {
    const { maxAttempts, connectionTimeout } = shakaRetryDefaults();
    const times = (name: ProfileName): number => rulesOf(name)[0]?.times ?? Infinity;

    // One failure is absorbed by the retry; three in a row exhaust the two attempts and force the failure path.
    expect(times('transient-404')).toBeLessThan(maxAttempts);
    expect(times('flaky-segments')).toBeGreaterThan(maxAttempts);

    // A slow segment must be slow, not failed: under the connection timeout, but longer than the buffer ahead of it (two segments).
    const slow = rulesOf('slow-segment')[0];
    expect(slow?.type === 'latency' && slow.ms).toBeLessThan(connectionTimeout);
    expect(slow?.type === 'latency' && slow.ms).toBeGreaterThan(2 * SEGMENT_SEC * 1000);

    // The truncation must cut every video segment: less than half of the smallest one (300 kbps x 2 s).
    const smallestVideoSegmentBytes = (LADDER_KBPS.v240 * 1000 * SEGMENT_SEC) / 8;
    const cut = rulesOf('truncated-segment')[0];
    expect(cut?.type === 'abort' && cut.afterBytes).toBeLessThan(smallestVideoSegmentBytes / 2);
  });

  it('scopes the failure profiles to the requests they are about', () => {
    expect(rulesOf('manifest-down')[0]?.match?.kind).toBe('manifest');
    expect(rulesOf('segments-down')[0]?.match?.kind).toBe('segment');
    expect(rulesOf('rung-outage')[0]?.match).toMatchObject({ kind: 'media', rep: 'v720' });
    for (const name of ['flaky-segments', 'transient-404', 'slow-segment', 'truncated-segment'] as const) {
      expect(rulesOf(name)[0]?.match, name).toMatchObject({ kind: 'segment', track: 'video', number: 3 });
    }
  });

  it('documents every profile and factory with a purpose and the catalog ids that use it', () => {
    const catalogId = /^PB-[A-Z]+-\d{3}$/;
    for (const name of PROFILE_NAMES) {
      const def = PROFILE_DEFINITIONS[name];
      expect(def.purpose.length, name).toBeGreaterThan(40);
      expect(def.usedBy.length, name).toBeGreaterThan(0);
      for (const id of def.usedBy) expect(id).toMatch(catalogId);
    }
    for (const factory of PROFILE_FACTORIES) {
      expect(factory.purpose.length).toBeGreaterThan(40);
      for (const id of factory.usedBy) expect(id).toMatch(catalogId);
    }
  });
});

describe('PB-LAB-007 profile(): a fresh copy every time', () => {
  it('lets a test change its copy without touching the shared definition', () => {
    const copy = profile('bandwidth-drop');
    const rule = copy[0];
    if (rule?.type !== 'throttle') throw new Error('expected a throttle');
    rule.kbps = 1;
    copy.push({ type: 'latency', ms: 1 });

    const fresh = profile('bandwidth-drop');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toStrictEqual({ type: 'throttle', kbps: 600, afterMs: 8000 });
    expect(PROFILE_DEFINITIONS['bandwidth-drop'].rules).toHaveLength(1);
  });

  it('returns an empty list for clean', () => {
    expect(profile('clean')).toStrictEqual([]);
  });
});

describe('PB-LAB-007 live factories', () => {
  it('originStall returns a one-rule live-stall profile', () => {
    expect(originStall(23, 10_000)).toStrictEqual([{ type: 'live-stall', atNumber: 23, ms: 10_000 }]);
  });

  it.each([
    ['atNumber 0', () => originStall(0, 1000)],
    ['negative atNumber', () => originStall(-3, 1000)],
    ['fractional atNumber', () => originStall(2.5, 1000)],
    ['NaN atNumber', () => originStall(Number.NaN, 1000)],
    ['zero duration', () => originStall(5, 0)],
    ['fractional duration', () => originStall(5, 1000.5)],
    ['infinite duration', () => originStall(5, Infinity)],
  ])('originStall rejects %s', (_label, call) => {
    expect(call).toThrow(RangeError);
  });

  it('staleManifest starts at once by default and carries afterMs only when given', () => {
    expect(staleManifest(8000)).toStrictEqual([{ type: 'manifest-stale', ms: 8000 }]);
    expect(staleManifest(8000, 3000)).toStrictEqual([{ type: 'manifest-stale', ms: 8000, afterMs: 3000 }]);
  });

  it.each([
    ['zero duration', () => staleManifest(0)],
    ['fractional duration', () => staleManifest(10.5)],
    ['negative afterMs', () => staleManifest(1000, -1)],
    ['fractional afterMs', () => staleManifest(1000, 0.5)],
  ])('staleManifest rejects %s', (_label, call) => {
    expect(call).toThrow(RangeError);
  });

  it('composes with a profile by spreading', () => {
    const rules = [...profile('high-latency'), ...originStall(30, 10_000)];
    expect(rules.map((r) => r.type)).toStrictEqual(['latency', 'live-stall']);
  });
});
