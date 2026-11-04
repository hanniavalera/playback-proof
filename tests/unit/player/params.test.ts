import { describe, expect, it } from 'vitest';
import { PARAM_DEFAULTS, clearKeyPatch, parsePlayerParams } from '../../../src/player/params.ts';
import type { ResolvedPlayerParams } from '../../../src/player/params.ts';
import type { PlayerPageParams } from '../../../src/shared/qa.ts';
import { playerUrl } from '../../../src/shared/urls.ts';

// Public throw-away values, the shape of the test stream's pair (16 bytes each as hex): they protect nothing.
const KEY_ID = '706c61796261636b70726f6f662d6964';
const KEY = '706c61796261636b70726f6f666b6579';

function queryOf(url: string): string {
  const mark = url.indexOf('?');
  return mark < 0 ? '' : url.slice(mark + 1);
}

function resolved(p: PlayerPageParams): ResolvedPlayerParams {
  return {
    manifest: p.manifest ?? null,
    config: p.config ?? 'A',
    autoplay: p.autoplay ?? true,
    muted: p.muted ?? true,
    start: p.start ?? null,
    abr: p.abr ?? true,
    hud: p.hud ?? false,
    clearKey: p.clearKey ?? null,
  };
}

describe('round trip with playerUrl', () => {
  const cases: Array<[string, PlayerPageParams]> = [
    ['nothing set', {}],
    ['a plain manifest path', { manifest: '/s/abc123/vod-cmaf/dash/manifest.mpd' }],
    [
      'every field, none default',
      { manifest: '/m.mpd', config: 'B', autoplay: false, muted: false, start: 12.5, abr: false, hud: true },
    ],
    [
      'every field, all default values set explicitly',
      { manifest: '/m.m3u8', config: 'A', autoplay: true, muted: true, abr: true, hud: false },
    ],
    ['start 0 (falsy, but a real position)', { manifest: '/m.mpd', start: 0 }],
    [
      'a manifest that carries its own query, a fragment and spaces',
      { manifest: '/s/x/v/dash/manifest.mpd?a=1&b=two words#frag' },
    ],
    ['a manifest that is an absolute URL', { manifest: 'http://127.0.0.1:4640/s/x/v/hls/master.m3u8' }],
    ['a manifest with non-ASCII characters', { manifest: '/s/é/ü/日本.mpd' }],
    ['a ClearKey pair', { manifest: '/m.mpd', clearKey: { keyId: KEY_ID, key: KEY } }],
  ];

  it.each(cases)('%s', (_name, input) => {
    const { params, problems } = parsePlayerParams(queryOf(playerUrl(input)));
    expect(problems).toEqual([]);
    expect(params).toEqual(resolved(input));
  });

  it('accepts location.search as the browser gives it, with its leading question mark', () => {
    const url = playerUrl({ manifest: '/m.mpd', config: 'B' });
    expect(parsePlayerParams(url.slice(url.indexOf('?'))).params.config).toBe('B');
  });

  it('hands a stream catalog entry (StreamInfo.drm, with its scheme) over as it is: only the pair travels', () => {
    const drm = { scheme: 'clearkey' as const, keyId: KEY_ID, key: KEY };
    const query = queryOf(playerUrl({ manifest: '/m.mpd', clearKey: drm }));
    expect(new URLSearchParams(query).get('clearKey')).toBe(`${KEY_ID}:${KEY}`);
    expect(parsePlayerParams(query).params.clearKey).toEqual({ keyId: KEY_ID, key: KEY });
  });
});

describe('defaults', () => {
  it('are muted autoplay with configuration A, ABR on, no HUD, no manifest, no start position and no key', () => {
    const { params, problems } = parsePlayerParams('');
    expect(params).toEqual(PARAM_DEFAULTS);
    expect(params).toEqual({
      manifest: null,
      config: 'A',
      autoplay: true,
      muted: true,
      start: null,
      abr: true,
      hud: false,
      clearKey: null,
    });
    expect(problems).toEqual([]);
  });

  it('ignore parameters the page does not know, so a cache buster is harmless', () => {
    const { params, problems } = parsePlayerParams('x=1&_=12345&manifest=%2Fm.mpd');
    expect(params.manifest).toBe('/m.mpd');
    expect(problems).toEqual([]);
  });

  it('are not shared: changing a result does not change the defaults', () => {
    parsePlayerParams('').params.muted = false;
    expect(PARAM_DEFAULTS.muted).toBe(true);
  });
});

describe('what is accepted', () => {
  it('reads 1/0 and true/false for the flags, in any case', () => {
    const { params, problems } = parsePlayerParams('autoplay=FALSE&muted=0&abr=True&hud=1');
    expect(params).toMatchObject({ autoplay: false, muted: false, abr: true, hud: true });
    expect(problems).toEqual([]);
  });

  it('reads the configuration in any case', () => {
    expect(parsePlayerParams('config=b').params.config).toBe('B');
    expect(parsePlayerParams('config=a').params.config).toBe('A');
  });

  it('reads a fractional start position and 0', () => {
    expect(parsePlayerParams('start=0').params.start).toBe(0);
    expect(parsePlayerParams('start=0.25').params.start).toBe(0.25);
  });

  it('takes the first of a repeated parameter', () => {
    expect(parsePlayerParams('config=B&config=A').params.config).toBe('B');
  });

  it('reads a ClearKey pair of two 32-digit hex numbers, in any case, as lower case', () => {
    const { params, problems } = parsePlayerParams(
      `clearKey=${KEY_ID.toUpperCase()}:${KEY.slice(0, 16).toUpperCase()}${KEY.slice(16)}`,
    );
    expect(params.clearKey).toEqual({ keyId: KEY_ID, key: KEY });
    expect(problems).toEqual([]);
  });

  it('reads the pair with its colon written as the browser or playerUrl writes it (%3A)', () => {
    expect(parsePlayerParams(`clearKey=${KEY_ID}%3A${KEY}`).params.clearKey).toEqual({
      keyId: KEY_ID,
      key: KEY,
    });
  });
});

describe('what is refused: reported, and the default is kept', () => {
  it.each([
    ['muted=yes', 'muted'],
    ['autoplay=2', 'autoplay'],
    ['abr=', 'abr'],
    ['hud=on', 'hud'],
  ])('%s', (query, name) => {
    const { params, problems } = parsePlayerParams(query);
    expect(params[name as 'muted']).toBe(PARAM_DEFAULTS[name as 'muted']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${name}=`);
  });

  it('a configuration that is not A or B', () => {
    const { params, problems } = parsePlayerParams('config=C');
    expect(params.config).toBe('A');
    expect(problems[0]).toContain('config="C"');
  });

  it.each(['start=-1', 'start=abc', 'start=', 'start=%20', 'start=Infinity', 'start=1e999', 'start=NaN'])(
    '%s',
    (query) => {
      const { params, problems } = parsePlayerParams(query);
      expect(params.start).toBeNull();
      expect(problems).toHaveLength(1);
    },
  );

  it('an empty manifest: the page stays idle, and says so', () => {
    const { params, problems } = parsePlayerParams('manifest=&autoplay=0');
    expect(params.manifest).toBeNull();
    expect(params.autoplay).toBe(false);
    expect(problems).toEqual(['manifest is empty: the page stays idle until qa.load(uri)']);
  });

  it('reports every bad parameter, not only the first', () => {
    const { problems } = parsePlayerParams('muted=x&config=Z&start=-5');
    expect(problems).toHaveLength(3);
  });

  const uuid = KEY_ID.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  it.each([
    ['an empty value', ''],
    ['no colon', KEY_ID],
    ['nothing after the colon', `${KEY_ID}:`],
    ['nothing before the colon', `:${KEY}`],
    ['two colons', `${KEY_ID}:${KEY}:${KEY}`],
    ['a key id of 31 digits', `${KEY_ID.slice(1)}:${KEY}`],
    ['a key of 33 digits', `${KEY_ID}:${KEY}0`],
    ['a key that is not hex', `${KEY_ID}:${'g'.repeat(32)}`],
    ['a key id written as a UUID, with dashes', `${uuid}:${KEY}`],
    [
      'the base64url form of the pair (22 characters each), which Shaka would take',
      `AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA`,
    ],
  ])(
    'clearKey with %s: no key is configured, and the report does not repeat what was given',
    (_what, raw) => {
      const { params, problems } = parsePlayerParams(`clearKey=${encodeURIComponent(raw)}`);
      expect(params.clearKey).toBeNull();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('clearKey');
      expect(problems[0]).toContain('no key is configured');
      for (const part of raw.split(':')) if (part.length >= 8) expect(problems[0]).not.toContain(part);
    },
  );

  it('a bad pair does not discard the other parameters', () => {
    const { params, problems } = parsePlayerParams(`manifest=%2Fm.mpd&clearKey=${KEY_ID}&muted=0`);
    expect(params).toMatchObject({ manifest: '/m.mpd', muted: false, clearKey: null });
    expect(problems).toHaveLength(1);
  });
});

describe('clearKeyPatch: what the page hands to Shaka before the load', () => {
  it("is Shaka's drm.clearKeys, a map from the key id to the key", () => {
    expect(clearKeyPatch({ keyId: KEY_ID, key: KEY })).toEqual({ drm: { clearKeys: { [KEY_ID]: KEY } } });
  });

  it('is empty without a pair: a page that was not given a key configures nothing', () => {
    expect(clearKeyPatch(null)).toEqual({});
  });
});
