// DASH manifests (MPD), built from a StreamIndex. Pure functions: the same index and parameters always give the same bytes.
//
// Timing is REAL: every S entry of the SegmentTimeline comes from the segments' parsed start and duration, never from the nominal 2 s
// (AAC segments are 93 or 94 frames long, see docs/decisions/media.md ADR-042). Every URL is relative to the manifest's own URL
// (docs/CONTRACTS.md section 3), so the layout works behind any prefix and a manifest needs no session id.

import type { DrmInfo, RepInfo } from '../../shared/streams.ts';
import { liveTiming } from './live.ts';
import { isoDuration, isoTimestamp, xmlEscape } from './time.ts';
import type { DashLiveParams, RepIndex, StreamIndex } from './types.ts';

/** URL of the /api/time endpoint the live manifest points its UTCTiming at: an absolute path, resolved against the manifest URL. */
export const UTC_TIMING_PATH = '/api/time';

interface Timeline {
  startNumber: number;
  entries: Array<{ start: number; duration: number }>;
}

type Attrs = Array<[string, string | number | undefined]>;

class Xml {
  private readonly lines: string[] = [];
  private depth = 0;
  private static attrs(attrs: Attrs): string {
    return attrs
      .filter((a): a is [string, string | number] => a[1] !== undefined)
      .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
      .join('');
  }
  open(name: string, attrs: Attrs = []): void {
    this.lines.push(`${'  '.repeat(this.depth)}<${name}${Xml.attrs(attrs)}>`);
    this.depth++;
  }
  close(name: string): void {
    this.depth--;
    this.lines.push(`${'  '.repeat(this.depth)}</${name}>`);
  }
  empty(name: string, attrs: Attrs = []): void {
    this.lines.push(`${'  '.repeat(this.depth)}<${name}${Xml.attrs(attrs)}/>`);
  }
  toString(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n${this.lines.join('\n')}\n`;
  }
}

/** Run-length encodes a contiguous timeline: `t` only where the first entry or a discontinuity needs it, `r` = additional repeats. */
export function timelineEntries(
  entries: Array<{ start: number; duration: number }>,
): Array<{ t?: number; d: number; r?: number }> {
  const out: Array<{ t?: number; d: number; r?: number }> = [];
  let expected: number | undefined;
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && expected === e.start && last.d === e.duration) {
      last.r = (last.r ?? 0) + 1;
    } else {
      out.push(expected === e.start ? { d: e.duration } : { t: e.start, d: e.duration });
    }
    expected = e.start + e.duration;
  }
  return out;
}

const sameTimeline = (a: RepIndex, ta: Timeline, b: RepIndex, tb: Timeline): boolean =>
  a.timescale === b.timescale &&
  ta.startNumber === tb.startNumber &&
  ta.entries.length === tb.entries.length &&
  ta.entries.every((e, i) => e.start === tb.entries[i]?.start && e.duration === tb.entries[i]?.duration);

function writeTimeline(x: Xml, repIndex: RepIndex, timeline: Timeline): void {
  const ext = repIndex.rep;
  x.open('SegmentTemplate', [
    ['timescale', repIndex.timescale],
    ['startNumber', timeline.startNumber],
    ['initialization', `../seg/$RepresentationID$/init.${ext.initExt}`],
    ['media', `../seg/$RepresentationID$/$Number$.${ext.segmentExt}`],
  ]);
  x.open('SegmentTimeline');
  for (const s of timelineEntries(timeline.entries))
    x.empty('S', [
      ['t', s.t],
      ['d', s.d],
      ['r', s.r],
    ]);
  x.close('SegmentTimeline');
  x.close('SegmentTemplate');
}

function writeRepresentation(x: Xml, rep: RepInfo, mimeOnRep: boolean): void {
  const common: Attrs = [
    ['id', rep.id],
    ['bandwidth', rep.bandwidth],
    ['codecs', rep.codecs],
    ['mimeType', mimeOnRep ? rep.mimeType : undefined],
  ];
  if (rep.track === 'video') {
    x.empty('Representation', [
      ...common,
      ['width', rep.width],
      ['height', rep.height],
      ['frameRate', rep.frameRate],
    ]);
    return;
  }
  const audioAttrs: Attrs = [...common, ['audioSamplingRate', rep.sampleRate]];
  if (rep.channels === undefined) {
    x.empty('Representation', audioAttrs);
    return;
  }
  x.open('Representation', audioAttrs);
  x.empty('AudioChannelConfiguration', [
    ['schemeIdUri', 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011'],
    ['value', rep.channels],
  ]);
  x.close('Representation');
}

function writeAdaptationSet(
  x: Xml,
  id: number,
  reps: RepIndex[],
  timelineOf: (r: RepIndex) => Timeline,
  drm: DrmInfo | undefined,
): void {
  const first = reps[0] as RepIndex;
  const track = first.rep.track;
  const mimeTypes = new Set(reps.map((r) => r.rep.mimeType));
  const timelines = reps.map((r) => timelineOf(r));
  // Alignment is a claim about the data, so it is derived from the data: only true when every representation of the set has the
  // identical timeline, which is also what allows one shared SegmentTemplate for the set.
  const aligned = reps.every((r, i) =>
    sameTimeline(first, timelines[0] as Timeline, r, timelines[i] as Timeline),
  );
  const attrs: Attrs = [
    ['id', id],
    ['contentType', track],
    ['mimeType', mimeTypes.size === 1 ? first.rep.mimeType : undefined],
    ['segmentAlignment', aligned ? 'true' : undefined],
    ['subsegmentAlignment', aligned ? 'true' : undefined],
    ['startWithSAP', 1],
  ];
  if (track === 'video') {
    attrs.push(
      ['maxWidth', Math.max(...reps.map((r) => r.rep.width ?? 0))],
      ['maxHeight', Math.max(...reps.map((r) => r.rep.height ?? 0))],
      ['maxFrameRate', Math.max(...reps.map((r) => r.rep.frameRate ?? 0))],
    );
  }
  x.open('AdaptationSet', attrs);
  // Schema order: ContentProtection comes before the SegmentTemplate and the Representations.
  if (drm) writeContentProtection(x, drm);
  if (aligned) writeTimeline(x, first, timelines[0] as Timeline);
  reps.forEach((r, i) => {
    if (aligned) {
      writeRepresentation(x, r.rep, mimeTypes.size !== 1);
    } else {
      x.open('Representation', [
        ['id', r.rep.id],
        ['bandwidth', r.rep.bandwidth],
        ['codecs', r.rep.codecs],
        ['mimeType', mimeTypes.size !== 1 ? r.rep.mimeType : undefined],
        ['width', r.rep.width],
        ['height', r.rep.height],
        ['frameRate', r.rep.frameRate],
        ['audioSamplingRate', r.rep.sampleRate],
      ]);
      writeTimeline(x, r, timelines[i] as Timeline);
      x.close('Representation');
    }
  });
  x.close('AdaptationSet');
}

function assertDash(index: StreamIndex): void {
  if (!index.info.protocols.includes('dash'))
    throw new Error(`stream ${index.info.id} is not offered as DASH`);
}

/** The system id of ClearKey (W3C EME, "org.w3.clearkey"). */
export const CLEARKEY_SYSTEM_ID = 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e';
const MP4_PROTECTION_SCHEME = 'urn:mpeg:dash:mp4protection:2011';
const CENC_NAMESPACE = 'urn:mpeg:cenc:2013';

/** 32 hex digits as the UUID text `cenc:default_KID` uses: 8-4-4-4-12. */
export function keyIdUuid(keyId: string): string {
  if (!/^[0-9a-f]{32}$/.test(keyId)) throw new Error(`a key id is 32 lower-case hex digits, got '${keyId}'`);
  return `${keyId.slice(0, 8)}-${keyId.slice(8, 12)}-${keyId.slice(12, 16)}-${keyId.slice(16, 20)}-${keyId.slice(20)}`;
}

/**
 * The two elements a DASH client needs to start EME for an encrypted set: the generic CENC one with the default key id (what the client
 * asks a license for), and the ClearKey system. There is no license URL: the player is configured with the key pair (StreamInfo.drm).
 */
function writeContentProtection(x: Xml, drm: DrmInfo): void {
  x.empty('ContentProtection', [
    ['schemeIdUri', MP4_PROTECTION_SCHEME],
    ['value', 'cenc'],
    ['cenc:default_KID', keyIdUuid(drm.keyId)],
  ]);
  x.empty('ContentProtection', [
    ['schemeIdUri', CLEARKEY_SYSTEM_ID],
    ['value', 'ClearKey1.0'],
  ]);
}

function profileOf(index: StreamIndex): string {
  // isoff-live promises ISO BMFF segments. A WebM stream cannot claim it; the full profile allows any segment format.
  return index.info.packaging === 'webm'
    ? 'urn:mpeg:dash:profile:full:2011'
    : 'urn:mpeg:dash:profile:isoff-live:2011';
}

/** An upper bound, so it rounds UP to the millisecond: 2.00533 s must not be announced as 2.005 s. */
function maxSegmentSeconds(index: StreamIndex): number {
  const longest = Math.max(...index.reps.flatMap((r) => r.segments.map((s) => s.duration / r.timescale)));
  return Math.ceil(longest * 1000) / 1000;
}

function writeSets(x: Xml, index: StreamIndex, timelineOf: (r: RepIndex) => Timeline): void {
  const video = index.reps.filter((r) => r.rep.track === 'video');
  const audio = index.reps.filter((r) => r.rep.track === 'audio');
  let id = 1;
  const drm = index.info.drm;
  if (video.length > 0) writeAdaptationSet(x, id++, video, timelineOf, drm);
  if (audio.length > 0) writeAdaptationSet(x, id, audio, timelineOf, drm);
}

/** The longest representation: audio may run up to one frame short of the video, never past it, so this is the video duration. */
function presentationSeconds(index: StreamIndex): number {
  return Math.max(...index.reps.map((r) => r.loopTicks / r.timescale));
}

export function buildDashVod(index: StreamIndex): string {
  assertDash(index);
  if (index.info.kind !== 'vod') throw new Error(`stream ${index.info.id} is live: use the live manifest`);
  const x = new Xml();
  x.open('MPD', [
    ['xmlns', 'urn:mpeg:dash:schema:mpd:2011'],
    ['xmlns:cenc', index.info.drm ? CENC_NAMESPACE : undefined],
    ['type', 'static'],
    ['profiles', profileOf(index)],
    ['minBufferTime', isoDuration(index.info.segmentDurationSec)],
    ['mediaPresentationDuration', isoDuration(presentationSeconds(index))],
    ['maxSegmentDuration', isoDuration(maxSegmentSeconds(index))],
  ]);
  x.open('Period', [
    ['id', 1],
    ['start', 'PT0S'],
  ]);
  writeSets(x, index, (r) => ({
    startNumber: 1,
    entries: r.segments.map((s) => ({ start: s.start, duration: s.duration })),
  }));
  x.close('Period');
  x.close('MPD');
  return x.toString();
}

function assertWindow(p: DashLiveParams): void {
  if (
    !Number.isSafeInteger(p.firstNumber) ||
    !Number.isSafeInteger(p.lastNumber) ||
    p.firstNumber < 1 ||
    p.lastNumber < p.firstNumber
  ) {
    throw new RangeError(`invalid live window ${p.firstNumber}..${p.lastNumber}`);
  }
  for (const [name, v] of [
    ['timeShiftBufferDepthSec', p.timeShiftBufferDepthSec],
    ['presentationDelaySec', p.presentationDelaySec],
    ['minimumUpdatePeriodSec', p.minimumUpdatePeriodSec],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`invalid ${name}: ${v}`);
  }
}

export function buildDashLive(index: StreamIndex, params: DashLiveParams): string {
  assertDash(index);
  if (index.info.kind !== 'live') throw new Error(`stream ${index.info.id} is not live`);
  assertWindow(params);
  const x = new Xml();
  x.open('MPD', [
    ['xmlns', 'urn:mpeg:dash:schema:mpd:2011'],
    ['xmlns:cenc', index.info.drm ? CENC_NAMESPACE : undefined],
    ['type', 'dynamic'],
    ['profiles', profileOf(index)],
    ['availabilityStartTime', isoTimestamp(params.availabilityStartTime)],
    ['publishTime', isoTimestamp(params.publishTime)],
    ['minimumUpdatePeriod', isoDuration(params.minimumUpdatePeriodSec)],
    ['timeShiftBufferDepth', isoDuration(params.timeShiftBufferDepthSec)],
    ['suggestedPresentationDelay', isoDuration(params.presentationDelaySec)],
    ['minBufferTime', isoDuration(index.info.segmentDurationSec)],
    ['maxSegmentDuration', isoDuration(maxSegmentSeconds(index))],
  ]);
  x.open('Period', [
    ['id', 1],
    ['start', 'PT0S'],
  ]);
  writeSets(x, index, (r) => {
    const entries: Timeline['entries'] = [];
    for (let n = params.firstNumber; n <= params.lastNumber; n++) entries.push(liveTiming(r, n));
    return { startNumber: params.firstNumber, entries };
  });
  x.close('Period');
  // The schema puts UTCTiming after the Periods. The client's clock is not trusted: the service's /api/time is the reference.
  x.empty('UTCTiming', [
    ['schemeIdUri', 'urn:mpeg:dash:utc:http-iso:2014'],
    ['value', UTC_TIMING_PATH],
  ]);
  x.close('MPD');
  return x.toString();
}
