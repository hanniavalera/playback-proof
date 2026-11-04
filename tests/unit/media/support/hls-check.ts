// A strict HLS playlist checker for the tests: it returns the list of problems (empty = a well-formed playlist of the subset the lab
// produces) and the facts a test wants to assert on. RFC 8216 rules that matter for fMP4 playlists at version 7.

export interface HlsSegment {
  uri: string;
  duration: number;
  programDateTime?: string;
}

export interface HlsMediaFacts {
  version?: number;
  targetDuration?: number;
  mediaSequence?: number;
  playlistType?: string;
  endList: boolean;
  independentSegments: boolean;
  mapUri?: string;
  segments: HlsSegment[];
}

export interface HlsVariant {
  attrs: Record<string, string>;
  uri: string;
}

export interface HlsMasterFacts {
  version?: number;
  independentSegments: boolean;
  media: Array<Record<string, string>>;
  variants: HlsVariant[];
}

const KNOWN_TAGS = new Set([
  '#EXTM3U',
  '#EXT-X-VERSION',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-ENDLIST',
  '#EXT-X-MAP',
  '#EXT-X-PROGRAM-DATE-TIME',
  '#EXTINF',
  '#EXT-X-MEDIA',
  '#EXT-X-STREAM-INF',
]);

/** Parses `KEY=value,KEY="quoted, value"` into a map (values without their quotes). Returns null for a malformed list. */
export function parseAttributes(list: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"\r\n]*"|[^",\s]*)(,|$)/y;
  let at = 0;
  while (at < list.length) {
    re.lastIndex = at;
    const m = re.exec(list);
    if (!m) return null;
    const key = m[1] as string;
    const raw = m[2] as string;
    if (key in out) return null;
    out[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    at = re.lastIndex;
    if (m[3] === '' && at < list.length) return null;
  }
  return out;
}

const isRelative = (uri: string): boolean =>
  uri !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('/');
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function lines(text: string, problems: string[]): string[] {
  if (!text.startsWith('#EXTM3U\n')) problems.push('does not start with #EXTM3U');
  if (!text.endsWith('\n')) problems.push('does not end with a newline');
  if (text.includes('\r')) problems.push('contains a carriage return');
  return text.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''));
}

function tagOf(line: string): { name: string; value: string } {
  const colon = line.indexOf(':');
  return colon < 0 ? { name: line, value: '' } : { name: line.slice(0, colon), value: line.slice(colon + 1) };
}

export function checkHlsMedia(text: string): { problems: string[]; facts: HlsMediaFacts } {
  const problems: string[] = [];
  const facts: HlsMediaFacts = { endList: false, independentSegments: false, segments: [] };
  let pendingDuration: number | undefined;
  let pendingPdt: string | undefined;
  let firstSegmentSeen = false;
  for (const line of lines(text, problems)) {
    if (line === '') {
      problems.push('blank line');
      continue;
    }
    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue; // a comment
      const { name, value } = tagOf(line);
      if (!KNOWN_TAGS.has(name)) problems.push(`unknown tag ${name}`);
      switch (name) {
        case '#EXT-X-VERSION':
          facts.version = Number(value);
          break;
        case '#EXT-X-TARGETDURATION':
          if (!/^\d+$/.test(value)) problems.push(`TARGETDURATION '${value}' is not an integer`);
          facts.targetDuration = Number(value);
          break;
        case '#EXT-X-MEDIA-SEQUENCE':
          if (firstSegmentSeen) problems.push('MEDIA-SEQUENCE after the first segment');
          if (!/^\d+$/.test(value)) problems.push(`MEDIA-SEQUENCE '${value}' is not an integer`);
          facts.mediaSequence = Number(value);
          break;
        case '#EXT-X-PLAYLIST-TYPE':
          facts.playlistType = value;
          break;
        case '#EXT-X-ENDLIST':
          facts.endList = true;
          break;
        case '#EXT-X-INDEPENDENT-SEGMENTS':
          facts.independentSegments = true;
          break;
        case '#EXT-X-MAP': {
          const attrs = parseAttributes(value);
          if (!attrs || !attrs.URI) problems.push(`malformed EXT-X-MAP: ${value}`);
          else {
            if (!isRelative(attrs.URI)) problems.push(`MAP URI '${attrs.URI}' is not relative`);
            facts.mapUri = attrs.URI;
          }
          break;
        }
        case '#EXT-X-PROGRAM-DATE-TIME':
          if (!isoUtc.test(value)) problems.push(`PROGRAM-DATE-TIME '${value}' is not ISO 8601 UTC`);
          pendingPdt = value;
          break;
        case '#EXTINF': {
          const m = /^(\d+(?:\.\d+)?),(.*)$/.exec(value);
          if (!m) problems.push(`malformed EXTINF: ${value}`);
          if (pendingDuration !== undefined) problems.push('EXTINF without a URI before the next EXTINF');
          pendingDuration = m ? Number(m[1]) : Number.NaN;
          break;
        }
        default:
          if (name !== '#EXTM3U') problems.push(`tag ${name} does not belong in a media playlist`);
      }
      continue;
    }
    // a URI line
    if (pendingDuration === undefined) {
      problems.push(`URI '${line}' without a preceding EXTINF`);
      continue;
    }
    if (!isRelative(line)) problems.push(`segment URI '${line}' is not relative`);
    const seg: HlsSegment = { uri: line, duration: pendingDuration };
    if (pendingPdt !== undefined) seg.programDateTime = pendingPdt;
    facts.segments.push(seg);
    firstSegmentSeen = true;
    pendingDuration = undefined;
    pendingPdt = undefined;
  }
  if (pendingDuration !== undefined) problems.push('EXTINF at the end without a URI');
  if (facts.version !== 7)
    problems.push(`EXT-X-VERSION is ${facts.version}, expected 7 (fMP4 with EXT-X-MAP)`);
  if (facts.targetDuration === undefined) problems.push('missing EXT-X-TARGETDURATION');
  if (!facts.mapUri) problems.push('missing EXT-X-MAP');
  if (!facts.independentSegments) problems.push('missing EXT-X-INDEPENDENT-SEGMENTS');
  if (facts.mediaSequence === undefined) problems.push('missing EXT-X-MEDIA-SEQUENCE');
  if (facts.targetDuration !== undefined) {
    // RFC 8216 4.3.3.1: each EXTINF duration, rounded to the nearest integer, must not exceed the target duration.
    const over = facts.segments.filter((s) => Math.round(s.duration) > (facts.targetDuration as number));
    if (over.length > 0)
      problems.push(`${over.length} segment(s) longer than TARGETDURATION ${facts.targetDuration}`);
  }
  if (facts.endList !== (facts.playlistType === 'VOD'))
    problems.push('ENDLIST and PLAYLIST-TYPE:VOD must go together');
  if (facts.endList && !text.trimEnd().endsWith('#EXT-X-ENDLIST'))
    problems.push('ENDLIST is not the last line');
  return { problems, facts };
}

export function checkHlsMaster(text: string): { problems: string[]; facts: HlsMasterFacts } {
  const problems: string[] = [];
  const facts: HlsMasterFacts = { independentSegments: false, media: [], variants: [] };
  let pending: Record<string, string> | undefined;
  for (const line of lines(text, problems)) {
    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue;
      const { name, value } = tagOf(line);
      if (!KNOWN_TAGS.has(name)) problems.push(`unknown tag ${name}`);
      if (name === '#EXT-X-VERSION') facts.version = Number(value);
      else if (name === '#EXT-X-INDEPENDENT-SEGMENTS') facts.independentSegments = true;
      else if (name === '#EXT-X-MEDIA') {
        const attrs = parseAttributes(value);
        if (!attrs) problems.push(`malformed EXT-X-MEDIA: ${value}`);
        else {
          for (const k of ['TYPE', 'GROUP-ID', 'NAME'])
            if (!attrs[k]) problems.push(`EXT-X-MEDIA lacks ${k}`);
          if (attrs.URI && !isRelative(attrs.URI)) problems.push(`media URI '${attrs.URI}' is not relative`);
          facts.media.push(attrs);
        }
      } else if (name === '#EXT-X-STREAM-INF') {
        const attrs = parseAttributes(value);
        if (!attrs) problems.push(`malformed EXT-X-STREAM-INF: ${value}`);
        pending = attrs ?? {};
      } else if (name !== '#EXTM3U') problems.push(`tag ${name} does not belong in a master playlist`);
      continue;
    }
    if (!pending) {
      problems.push(`URI '${line}' without a preceding EXT-X-STREAM-INF`);
      continue;
    }
    if (!isRelative(line)) problems.push(`variant URI '${line}' is not relative`);
    facts.variants.push({ attrs: pending, uri: line });
    pending = undefined;
  }
  if (pending) problems.push('EXT-X-STREAM-INF at the end without a URI');
  const groups = new Set(facts.media.filter((m) => m.TYPE === 'AUDIO').map((m) => m['GROUP-ID']));
  for (const v of facts.variants) {
    if (!/^\d+$/.test(v.attrs.BANDWIDTH ?? ''))
      problems.push(`variant ${v.uri}: BANDWIDTH is not an integer`);
    if (!v.attrs.CODECS) problems.push(`variant ${v.uri}: no CODECS`);
    if (v.attrs.RESOLUTION && !/^\d+x\d+$/.test(v.attrs.RESOLUTION))
      problems.push(`variant ${v.uri}: bad RESOLUTION`);
    if (v.attrs.AUDIO && !groups.has(v.attrs.AUDIO))
      problems.push(`variant ${v.uri}: AUDIO group '${v.attrs.AUDIO}' is not declared`);
    if (v.attrs['AVERAGE-BANDWIDTH'] && Number(v.attrs['AVERAGE-BANDWIDTH']) > Number(v.attrs.BANDWIDTH))
      problems.push(`variant ${v.uri}: AVERAGE-BANDWIDTH exceeds BANDWIDTH`);
  }
  if (facts.version !== 7) problems.push(`EXT-X-VERSION is ${facts.version}, expected 7`);
  if (!facts.independentSegments) problems.push('missing EXT-X-INDEPENDENT-SEGMENTS');
  if (facts.variants.length === 0) problems.push('no variant');
  return { problems, facts };
}
