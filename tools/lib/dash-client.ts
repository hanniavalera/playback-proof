// An independent, deliberately literal DASH reader: it takes the text of an MPD and the URL it was fetched from, and returns what a
// client would work out from it: the representations, and for each one the list of segments (number, start, duration, absolute URL)
// that follows from SegmentTemplate + SegmentTimeline. It shares no code with src/server/media/dash.ts, so a round trip through it
// tests the builder against a consumer's reading of the standard. Scope: one Period, SegmentTemplate with a SegmentTimeline and
// $RepresentationID$ / $Number$ / $Time$ / $Bandwidth$ addressing (everything the lab produces); anything else is an error.

import { childrenNamed, parseXml, type XmlElement } from './xml.ts';

export class DashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashError';
  }
}

export interface DashSegment {
  number: number;
  /** Start in ticks of the representation's timescale. */
  start: number;
  duration: number;
  url: string;
}

export interface DashRepresentation {
  adaptationSetId: string;
  contentType: string;
  mimeType: string;
  id: string;
  bandwidth: number;
  codecs: string;
  width?: number;
  height?: number;
  frameRate?: number;
  audioSamplingRate?: number;
  channels?: number;
  timescale: number;
  initUrl: string;
  segments: DashSegment[];
}

export interface DashContentProtection {
  schemeIdUri: string;
  value?: string;
  /** cenc:default_KID, as written (UUID text, 8-4-4-4-12). */
  defaultKid?: string;
}

export interface DashAdaptationSet {
  id: string;
  contentType: string;
  segmentAlignment: boolean;
  startWithSAP?: number;
  contentProtection: DashContentProtection[];
  representations: DashRepresentation[];
}

export interface DashManifest {
  type: 'static' | 'dynamic';
  profiles: string;
  /** Seconds. */
  minBufferTime: number;
  mediaPresentationDuration?: number;
  maxSegmentDuration?: number;
  availabilityStartTime?: Date;
  publishTime?: Date;
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  utcTiming?: { scheme: string; url: string };
  adaptationSets: DashAdaptationSet[];
  representations: DashRepresentation[];
}

/** xs:duration restricted to days, hours, minutes and seconds (what DASH timing attributes use). Seconds. */
export function parseIsoDuration(value: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || value === 'P' || value.endsWith('T'))
    throw new DashError(`not a supported ISO 8601 duration: '${value}'`);
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export function parseIsoTimestamp(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
    throw new DashError(`not a UTC ISO 8601 timestamp: '${value}'`);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new DashError(`not a valid timestamp: '${value}'`);
  return new Date(t);
}

function required(el: XmlElement, attr: string): string {
  const v = el.attrs[attr];
  if (v === undefined) throw new DashError(`<${el.name}> is missing the required attribute '${attr}'`);
  return v;
}

function integer(el: XmlElement, attr: string, fallback?: number): number {
  const v = el.attrs[attr];
  if (v === undefined) {
    if (fallback === undefined) throw new DashError(`<${el.name}> is missing '${attr}'`);
    return fallback;
  }
  if (!/^-?\d+$/.test(v)) throw new DashError(`<${el.name} ${attr}="${v}"> is not an integer`);
  return Number(v);
}

/** $RepresentationID$, $Number$ (optionally $Number%05d$), $Bandwidth$, $Time$ and $$; any other identifier is an error. */
export function expandTemplate(
  template: string,
  values: { RepresentationID: string; Number?: number; Bandwidth?: number; Time?: number },
): string {
  return template.replace(/\$([A-Za-z]*)(?:%0(\d+)d)?\$/g, (_m, id: string, width: string | undefined) => {
    if (id === '') return '$';
    const v = (values as Record<string, string | number | undefined>)[id];
    if (v === undefined || !['RepresentationID', 'Number', 'Bandwidth', 'Time'].includes(id))
      throw new DashError(`unsupported or unavailable template identifier $${id}$ in '${template}'`);
    return width && typeof v === 'number' ? String(v).padStart(Number(width), '0') : String(v);
  });
}

interface Template {
  timescale: number;
  startNumber: number;
  initialization: string;
  media: string;
  timeline: Array<{ t?: number; d: number; r: number }>;
}

function readTemplate(el: XmlElement): Template {
  const timelineEl = childrenNamed(el, 'SegmentTimeline')[0];
  if (!timelineEl) throw new DashError('SegmentTemplate has no SegmentTimeline');
  const timeline = childrenNamed(timelineEl, 'S').map((s) => {
    const r = integer(s, 'r', 0);
    if (r < 0) throw new DashError('negative S@r (repeat until the end) is not supported');
    const out: { t?: number; d: number; r: number } = { d: integer(s, 'd'), r };
    if (s.attrs.t !== undefined) out.t = integer(s, 't');
    return out;
  });
  if (timeline.length === 0) throw new DashError('SegmentTimeline has no S');
  return {
    timescale: integer(el, 'timescale', 1),
    startNumber: integer(el, 'startNumber', 1),
    initialization: required(el, 'initialization'),
    media: required(el, 'media'),
    timeline,
  };
}

const CENC_NAMESPACE = 'urn:mpeg:cenc:2013';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ContentProtection elements of an AdaptationSet. The cenc prefix must be declared on the MPD, and the elements must precede the rest. */
function readContentProtection(mpd: XmlElement, set: XmlElement): DashContentProtection[] {
  const names = set.children.map((c) => c.name);
  const lastProtection = names.lastIndexOf('ContentProtection');
  const firstOther = names.findIndex((n) => n === 'SegmentTemplate' || n === 'Representation');
  if (lastProtection >= 0 && firstOther >= 0 && firstOther < lastProtection)
    throw new DashError(
      'ContentProtection must come before SegmentTemplate and Representation (MPD schema order)',
    );
  return childrenNamed(set, 'ContentProtection').map((cp) => {
    const out: DashContentProtection = { schemeIdUri: required(cp, 'schemeIdUri') };
    if (cp.attrs.value !== undefined) out.value = cp.attrs.value;
    const kid = cp.attrs['cenc:default_KID'];
    if (kid !== undefined) {
      if (mpd.attrs['xmlns:cenc'] !== CENC_NAMESPACE)
        throw new DashError(
          `cenc:default_KID is used but xmlns:cenc is '${mpd.attrs['xmlns:cenc']}', not ${CENC_NAMESPACE}`,
        );
      if (!UUID.test(kid))
        throw new DashError(`cenc:default_KID '${kid}' is not a UUID (8-4-4-4-12 hex digits)`);
      out.defaultKid = kid;
    }
    return out;
  });
}

export function parseDash(xml: string, manifestUrl: string): DashManifest {
  const mpd = parseXml(xml);
  if (mpd.name !== 'MPD') throw new DashError(`root element is <${mpd.name}>, expected <MPD>`);
  if (mpd.attrs.xmlns !== 'urn:mpeg:dash:schema:mpd:2011')
    throw new DashError(`MPD namespace is '${mpd.attrs.xmlns}'`);
  const type = required(mpd, 'type');
  if (type !== 'static' && type !== 'dynamic') throw new DashError(`MPD@type is '${type}'`);
  const manifest: DashManifest = {
    type,
    profiles: required(mpd, 'profiles'),
    minBufferTime: parseIsoDuration(required(mpd, 'minBufferTime')),
    adaptationSets: [],
    representations: [],
  };
  if (type === 'static')
    manifest.mediaPresentationDuration = parseIsoDuration(required(mpd, 'mediaPresentationDuration'));
  else {
    manifest.availabilityStartTime = parseIsoTimestamp(required(mpd, 'availabilityStartTime'));
    manifest.publishTime = parseIsoTimestamp(required(mpd, 'publishTime'));
    manifest.minimumUpdatePeriod = parseIsoDuration(required(mpd, 'minimumUpdatePeriod'));
    manifest.timeShiftBufferDepth = parseIsoDuration(required(mpd, 'timeShiftBufferDepth'));
    manifest.suggestedPresentationDelay = parseIsoDuration(required(mpd, 'suggestedPresentationDelay'));
  }
  if (mpd.attrs.maxSegmentDuration !== undefined)
    manifest.maxSegmentDuration = parseIsoDuration(mpd.attrs.maxSegmentDuration);

  // Schema order: Period(s) first, then UTCTiming.
  const names = mpd.children.map((c) => c.name);
  const lastPeriod = names.lastIndexOf('Period');
  const firstTiming = names.indexOf('UTCTiming');
  if (firstTiming >= 0 && firstTiming < lastPeriod)
    throw new DashError('UTCTiming must come after the Period (MPD schema order)');
  const timing = childrenNamed(mpd, 'UTCTiming')[0];
  if (timing)
    manifest.utcTiming = {
      scheme: required(timing, 'schemeIdUri'),
      url: new URL(required(timing, 'value'), manifestUrl).toString(),
    };
  if (type === 'dynamic' && !timing)
    throw new DashError('a dynamic MPD needs a UTCTiming element: the client clock is not trusted');

  const periods = childrenNamed(mpd, 'Period');
  if (periods.length !== 1) throw new DashError(`expected exactly one Period, found ${periods.length}`);
  const period = periods[0] as XmlElement;
  for (const set of childrenNamed(period, 'AdaptationSet')) {
    const setId = required(set, 'id');
    const setTemplate = childrenNamed(set, 'SegmentTemplate')[0];
    const adaptation: DashAdaptationSet = {
      id: setId,
      contentType: required(set, 'contentType'),
      segmentAlignment: set.attrs.segmentAlignment === 'true',
      contentProtection: readContentProtection(mpd, set),
      representations: [],
    };
    if (set.attrs.startWithSAP !== undefined) adaptation.startWithSAP = integer(set, 'startWithSAP');
    for (const rep of childrenNamed(set, 'Representation')) {
      const id = required(rep, 'id');
      const bandwidth = integer(rep, 'bandwidth');
      const templateEl = childrenNamed(rep, 'SegmentTemplate')[0] ?? setTemplate;
      if (!templateEl) throw new DashError(`representation ${id} has no SegmentTemplate (own or inherited)`);
      const tpl = readTemplate(templateEl);
      const mimeType = rep.attrs.mimeType ?? set.attrs.mimeType;
      if (!mimeType) throw new DashError(`representation ${id} has no mimeType (own or inherited)`);
      const r: DashRepresentation = {
        adaptationSetId: setId,
        contentType: adaptation.contentType,
        mimeType,
        id,
        bandwidth,
        codecs: required(rep, 'codecs'),
        timescale: tpl.timescale,
        initUrl: new URL(
          expandTemplate(tpl.initialization, { RepresentationID: id, Bandwidth: bandwidth }),
          manifestUrl,
        ).toString(),
        segments: [],
      };
      if (rep.attrs.width !== undefined) r.width = integer(rep, 'width');
      if (rep.attrs.height !== undefined) r.height = integer(rep, 'height');
      if (rep.attrs.frameRate !== undefined) r.frameRate = Number(rep.attrs.frameRate);
      if (rep.attrs.audioSamplingRate !== undefined) r.audioSamplingRate = integer(rep, 'audioSamplingRate');
      const channels = childrenNamed(rep, 'AudioChannelConfiguration')[0];
      if (channels) r.channels = integer(channels, 'value');
      let number = tpl.startNumber;
      let expectedStart: number | undefined;
      for (const s of tpl.timeline) {
        const start = s.t ?? expectedStart;
        if (start === undefined) throw new DashError(`the first S of ${id} has no t`);
        let at = start;
        for (let k = 0; k <= s.r; k++) {
          r.segments.push({
            number,
            start: at,
            duration: s.d,
            url: new URL(
              expandTemplate(tpl.media, {
                RepresentationID: id,
                Number: number,
                Bandwidth: bandwidth,
                Time: at,
              }),
              manifestUrl,
            ).toString(),
          });
          number++;
          at += s.d;
        }
        expectedStart = at;
      }
      adaptation.representations.push(r);
      manifest.representations.push(r);
    }
    manifest.adaptationSets.push(adaptation);
  }
  if (manifest.representations.length === 0) throw new DashError('no Representation');
  return manifest;
}
