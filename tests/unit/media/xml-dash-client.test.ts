import { describe, expect, it } from 'vitest';
import {
  DashError,
  expandTemplate,
  parseDash,
  parseIsoDuration,
  parseIsoTimestamp,
} from '../../../tools/lib/dash-client.ts';
import { XmlError, childrenNamed, parseXml } from '../../../tools/lib/xml.ts';

describe('the strict XML reader used as an independent check', () => {
  it('reads elements, attributes, text, comments and the XML declaration', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- hi -->\n<a x="1" y='two'><b>text &amp; more</b><c/><!-- inner --></a>\n`,
    );
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1', y: 'two' });
    expect(childrenNamed(root, 'b')[0]?.text).toBe('text & more');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c']);
  });

  it('decodes the predefined entities and numeric references in attribute values', () => {
    const root = parseXml('<a v="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;"/>');
    expect(root.attrs.v).toBe(`<>&"'AB`);
  });

  it.each([
    ['a DOCTYPE', '<!DOCTYPE a><a/>'],
    ['CDATA', '<a><![CDATA[x]]></a>'],
    ['an undefined entity', '<a v="&nbsp;"/>'],
    ['a bare ampersand', '<a v="a & b"/>'],
    ['a duplicate attribute', '<a v="1" v="2"/>'],
    ['a < in an attribute value', '<a v="a<b"/>'],
    ['an unquoted attribute', '<a v=1/>'],
    ['two attributes without whitespace', '<a v="1"w="2"/>'],
    ['mismatched tags', '<a><b></a></b>'],
    ['an unclosed element', '<a><b></b>'],
    ['two roots', '<a/><b/>'],
    ['text after the root', '<a/>junk'],
    ['a processing instruction', '<a><?pi x?></a>'],
    ['a comment with --', '<a><!-- a -- b --></a>'],
    ['an empty document', ''],
  ])('rejects %s', (_name, src) => {
    expect(() => parseXml(src)).toThrow(XmlError);
  });

  it('says where it failed', () => {
    expect(() => parseXml('<a>\n  <b>\n</a>')).toThrow(/line 3/);
  });
});

describe('parseIsoDuration / parseIsoTimestamp', () => {
  it.each([
    ['PT2S', 2],
    ['PT1M', 60],
    ['PT1H1M1.5S', 3661.5],
    ['PT0.001S', 0.001],
    ['P1DT1H', 90_000],
  ])('%s is %s seconds', (text, seconds) => {
    expect(parseIsoDuration(text)).toBeCloseTo(seconds, 9);
  });

  it.each(['', 'P', 'PT', 'T2S', '2S', 'P1Y', 'PT-2S', 'PT1.S'])('rejects %j', (text) => {
    expect(() => parseIsoDuration(text)).toThrow(DashError);
  });

  it('accepts UTC timestamps only', () => {
    expect(parseIsoTimestamp('2026-01-01T00:00:00.500Z').getTime()).toBe(Date.UTC(2026, 0, 1, 0, 0, 0, 500));
    expect(() => parseIsoTimestamp('2026-01-01T00:00:00+01:00')).toThrow(DashError);
    expect(() => parseIsoTimestamp('2026-13-45T00:00:00Z')).toThrow(DashError);
  });
});

describe('expandTemplate', () => {
  it('fills the identifiers a SegmentTemplate may use', () => {
    expect(
      expandTemplate('../seg/$RepresentationID$/$Number$.m4s', { RepresentationID: 'v240', Number: 7 }),
    ).toBe('../seg/v240/7.m4s');
    expect(expandTemplate('s$Number%05d$.m4s', { RepresentationID: 'x', Number: 42 })).toBe('s00042.m4s');
    expect(expandTemplate('a$$b/$Time$', { RepresentationID: 'x', Time: 9 })).toBe('a$b/9');
  });

  it('refuses identifiers it does not implement and values it was not given', () => {
    expect(() => expandTemplate('$SubNumber$', { RepresentationID: 'x' })).toThrow(DashError);
    expect(() => expandTemplate('$Number$', { RepresentationID: 'x' })).toThrow(DashError);
  });
});

const MPD = (body: string, attrs = 'type="static" mediaPresentationDuration="PT4S"'): string =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="p" minBufferTime="PT2S" ${attrs}>${body}</MPD>`;
const SET = (template: string, rep = '<Representation id="r" bandwidth="1" codecs="c"/>'): string =>
  `<Period id="1"><AdaptationSet id="1" contentType="video" mimeType="video/mp4">${template}${rep}</AdaptationSet></Period>`;
const TEMPLATE =
  '<SegmentTemplate timescale="10" startNumber="3" initialization="i/$RepresentationID$.mp4" media="m/$Number$.m4s"><SegmentTimeline><S t="5" d="20" r="1"/><S d="30"/></SegmentTimeline></SegmentTemplate>';

describe('parseDash (the consumer side of the manifest builders)', () => {
  it('expands SegmentTimeline like a player: startNumber, t, d, r, and t carried over between S entries', () => {
    const mpd = parseDash(MPD(SET(TEMPLATE)), 'http://h/a/b/manifest.mpd');
    const r = mpd.representations[0];
    expect(r?.segments.map((s) => [s.number, s.start, s.duration, s.url])).toEqual([
      [3, 5, 20, 'http://h/a/b/m/3.m4s'],
      [4, 25, 20, 'http://h/a/b/m/4.m4s'],
      [5, 45, 30, 'http://h/a/b/m/5.m4s'],
    ]);
    expect(r?.initUrl).toBe('http://h/a/b/i/r.mp4');
  });

  it.each([
    ['a wrong namespace', MPD(SET(TEMPLATE)).replace('urn:mpeg:dash:schema:mpd:2011', 'urn:other')],
    ['no type', MPD(SET(TEMPLATE), 'mediaPresentationDuration="PT4S"')],
    ['a static MPD without mediaPresentationDuration', MPD(SET(TEMPLATE), 'type="static"')],
    [
      'a dynamic MPD without UTCTiming',
      MPD(
        SET(TEMPLATE),
        'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" publishTime="2026-01-01T00:00:00Z" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT30S" suggestedPresentationDelay="PT6S"',
      ),
    ],
    ['a template without a timeline', MPD(SET('<SegmentTemplate initialization="i" media="m"/>'))],
    ['an S without d', MPD(SET(TEMPLATE.replace('<S d="30"/>', '<S/>')))],
    ['a negative repeat', MPD(SET(TEMPLATE.replace('r="1"', 'r="-1"')))],
    ['an unknown template identifier', MPD(SET(TEMPLATE.replace('$Number$', '$Foo$')))],
    ['two periods', MPD(`${SET(TEMPLATE)}${SET(TEMPLATE)}`)],
    ['a Representation without bandwidth', MPD(SET(TEMPLATE, '<Representation id="r" codecs="c"/>'))],
    ['no mimeType anywhere', MPD(SET(TEMPLATE).replace(' mimeType="video/mp4"', ''))],
    ['no template anywhere', MPD(SET(''))],
  ])('rejects %s', (_name, xml) => {
    expect(() => parseDash(xml, 'http://h/m.mpd')).toThrow();
  });

  it('requires UTCTiming after the Period (schema order)', () => {
    const live =
      'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" publishTime="2026-01-01T00:00:00Z" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT30S" suggestedPresentationDelay="PT6S"';
    const timing = '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="/api/time"/>';
    expect(() => parseDash(MPD(`${timing}${SET(TEMPLATE)}`, live), 'http://h/m.mpd')).toThrow(
      /after the Period/,
    );
    expect(parseDash(MPD(`${SET(TEMPLATE)}${timing}`, live), 'http://h:1/x/m.mpd').utcTiming?.url).toBe(
      'http://h:1/api/time',
    );
  });

  it('lets a Representation use its own SegmentTemplate and inherits the AdaptationSet one otherwise', () => {
    const own =
      '<SegmentTemplate timescale="1" initialization="own-i" media="own-m$Number$"><SegmentTimeline><S t="0" d="1"/></SegmentTimeline></SegmentTemplate>';
    const mpd = parseDash(
      MPD(
        SET(
          TEMPLATE,
          `<Representation id="a" bandwidth="1" codecs="c">${own}</Representation><Representation id="b" bandwidth="2" codecs="c"/>`,
        ),
      ),
      'http://h/m.mpd',
    );
    expect(mpd.representations.map((r) => [r.id, r.segments.length, r.timescale])).toEqual([
      ['a', 1, 1],
      ['b', 3, 10],
    ]);
  });
});
