import { describe, expect, it } from 'vitest';
import {
  B_KNOBS,
  configFor,
  flattenPatch,
  mergePatches,
  valuesAtShape,
} from '../../../src/player/configs.ts';
import type { ShakaConfigPatch } from '../../../src/player/configs.ts';
import { PROFILE_NAMES } from '../../../src/shared/profiles.ts';

describe('configuration A', () => {
  it('is Shaka defaults: nothing is overridden', () => {
    expect(configFor('A')).toEqual({});
  });

  it('is a fresh object on every call, so a test that edits it cannot change the next page', () => {
    const first = configFor('A') as Record<string, unknown>;
    first.abr = { enabled: false };
    expect(configFor('A')).toEqual({});
  });
});

describe('configuration B', () => {
  it('is the merge of its knobs and nothing else', () => {
    expect(flattenPatch(configFor('B'))).toEqual(B_KNOBS.flatMap((knob) => flattenPatch(knob.patch)));
    expect(flattenPatch(configFor('B')).length).toBeGreaterThan(0);
  });

  it('is a fresh object on every call', () => {
    const first = configFor('B') as { abr?: { switchInterval?: number } };
    if (first.abr) first.abr.switchInterval = 99;
    expect((configFor('B') as { abr?: { switchInterval?: number } }).abr?.switchInterval).not.toBe(99);
  });

  it('keeps rebufferingGoal at its default: with a goal Shaka measures a rebuffer differently, and the A/B would compare two instruments', () => {
    const paths = flattenPatch(configFor('B')).map((leaf) => leaf.path);
    expect(paths).not.toContain('streaming.rebufferingGoal');
  });

  it('has knobs that touch different keys, so one can be switched on alone to attribute an effect', () => {
    const paths = B_KNOBS.flatMap((knob) => flattenPatch(knob.patch).map((leaf) => leaf.path));
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(B_KNOBS.map((knob) => knob.id)).size).toBe(B_KNOBS.length);
  });

  it('states each hypothesis against a fault profile that exists, so renaming a profile cannot leave a stale claim', () => {
    for (const knob of B_KNOBS) {
      const named = PROFILE_NAMES.filter((name) => knob.hypothesis.includes(name));
      expect(named, `knob ${knob.id} names no known profile`).not.toHaveLength(0);
      const mentioned = [
        ...knob.hypothesis.matchAll(
          /\b(?:constrained-\d+|bandwidth-drop|high-latency|flaky-segments|slow-segment)\b/g,
        ),
      ];
      for (const [name] of mentioned) expect(PROFILE_NAMES as string[]).toContain(name);
    }
  });
});

describe('mergePatches', () => {
  it('merges nested objects and lets the later patch win a key', () => {
    const merged = mergePatches(
      { abr: { switchInterval: 8, enabled: true }, streaming: { bufferingGoal: 10 } },
      { abr: { switchInterval: 4 } },
    );
    expect(merged).toEqual({ abr: { switchInterval: 4, enabled: true }, streaming: { bufferingGoal: 10 } });
  });

  it('does not change its inputs and does not share nested objects with them', () => {
    const a: ShakaConfigPatch = { abr: { switchInterval: 8 } };
    const merged = mergePatches(a, { abr: { enabled: false } }) as { abr: Record<string, unknown> };
    merged.abr.switchInterval = 1;
    expect(a).toEqual({ abr: { switchInterval: 8 } });
  });

  it('replaces arrays instead of merging them, and copies them', () => {
    const language: ShakaConfigPatch = { preferredDecodingAttributes: ['a', 'b'] };
    const merged = mergePatches(language, { preferredDecodingAttributes: ['c'] });
    expect(merged.preferredDecodingAttributes).toEqual(['c']);
    const copy = mergePatches(language) as { preferredDecodingAttributes: string[] };
    copy.preferredDecodingAttributes.push('z');
    expect(language.preferredDecodingAttributes).toEqual(['a', 'b']);
  });

  it('cannot be used to pollute Object.prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
    );
    mergePatches(hostile as ShakaConfigPatch);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('flattenPatch and valuesAtShape', () => {
  it('lists every leaf with its dotted path, in order, and treats an array as one leaf', () => {
    expect(
      flattenPatch({
        abr: { switchInterval: 4, restrictions: { maxHeight: 360 } },
        preferredAudio: [{ language: 'en' }],
      }),
    ).toEqual([
      { path: 'abr.switchInterval', value: 4 },
      { path: 'abr.restrictions.maxHeight', value: 360 },
      { path: 'preferredAudio', value: [{ language: 'en' }] },
    ]);
    expect(flattenPatch({})).toEqual([]);
  });

  it('reads, from the defaults, the value at each key an override sets: what B changed, and from what', () => {
    const defaults = {
      abr: { switchInterval: 8, enabled: true, useNetworkInformation: true },
      streaming: { bufferingGoal: 10 },
    };
    expect(
      valuesAtShape(defaults, {
        abr: { switchInterval: 4, useNetworkInformation: false },
        streaming: { bufferingGoal: 20 },
      }),
    ).toEqual({
      abr: { switchInterval: 8, useNetworkInformation: true },
      streaming: { bufferingGoal: 10 },
    });
  });

  it('leaves out a key the defaults do not have, instead of inventing a value', () => {
    expect(
      valuesAtShape(
        { abr: { enabled: true } },
        { abr: { switchInterval: 4 }, streaming: { bufferingGoal: 20 } },
      ),
    ).toEqual({});
    expect(
      valuesAtShape(
        { abr: { enabled: true, switchInterval: 8 } },
        { abr: { switchInterval: 4 }, streaming: { bufferingGoal: 20 } },
      ),
    ).toEqual({
      abr: { switchInterval: 8 },
    });
  });
});
