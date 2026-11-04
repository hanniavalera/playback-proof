import { describe, expect, it } from 'vitest';
import { PARAM_DEFAULTS, parsePlayerParams } from '../../../src/player/params.ts';
import type { ResolvedPlayerParams } from '../../../src/player/params.ts';
import type { PlayerPageParams } from '../../../src/shared/qa.ts';
import { playerUrl } from '../../../src/shared/urls.ts';

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
});

describe('defaults', () => {
  it('are muted autoplay with configuration A, ABR on, no HUD, no manifest and no start position', () => {
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
});
