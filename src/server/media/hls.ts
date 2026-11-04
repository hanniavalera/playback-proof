// HLS playlists (multivariant, VOD media, live media), built from a StreamIndex. Pure functions.
//
// EXTINF is the real duration of each segment (6 decimals: an AAC segment of 94 frames reads 2.005333, one of 93 frames 1.984000).
// Every URI is relative to the playlist's own URL (docs/CONTRACTS.md section 3): the master and the media playlists live in /hls/,
// the segments in /seg/<rep>/, hence "../seg/...". Audio is a separate EXT-X-MEDIA group, like the DASH audio AdaptationSet.

import type { RepInfo } from '../../shared/streams.ts';
import { liveTiming } from './live.ts';
import { formatSeconds, instantAt, isoTimestamp } from './time.ts';
import type { HlsLiveParams, RepIndex, StreamIndex } from './types.ts';

const AUDIO_GROUP = 'audio';

function assertHls(index: StreamIndex): void {
  if (!index.info.protocols.includes('hls')) throw new Error(`stream ${index.info.id} is not offered as HLS`);
  if (index.info.drm)
    throw new Error(`stream ${index.info.id} is encrypted: this builder does not emit EXT-X-KEY`);
}

function findRep(index: StreamIndex, repId: string): RepIndex {
  const r = index.reps.find((x) => x.rep.id === repId);
  if (!r)
    throw new Error(
      `stream ${index.info.id} has no representation '${repId}' (has: ${index.reps.map((x) => x.rep.id).join(', ')})`,
    );
  return r;
}

/** A quoted-string attribute value: HLS allows anything except line breaks and the double quote itself. */
function quoted(value: string): string {
  if (/["\r\n]/.test(value))
    throw new RangeError(
      `HLS quoted-string cannot contain a quote or a line break: ${JSON.stringify(value)}`,
    );
  return `"${value}"`;
}

/** Playlist URI of a representation, relative to the master playlist. */
const playlistUri = (rep: RepInfo): string => `${rep.id}.m3u8`;

const averageBandwidth = (r: RepIndex): number => {
  const bits = r.segments.reduce((sum, s) => sum + s.bytes * 8, 0);
  return Math.round((bits * r.timescale) / r.loopTicks);
};

export function buildHlsMaster(index: StreamIndex): string {
  assertHls(index);
  const video = index.reps.filter((r) => r.rep.track === 'video');
  const audio = index.reps.filter((r) => r.rep.track === 'audio');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  audio.forEach((a, i) => {
    const attrs = [
      'TYPE=AUDIO',
      `GROUP-ID=${quoted(AUDIO_GROUP)}`,
      `NAME=${quoted(a.rep.id)}`,
      `DEFAULT=${i === 0 ? 'YES' : 'NO'}`,
      `AUTOSELECT=YES`,
    ];
    if (a.rep.channels !== undefined) attrs.push(`CHANNELS=${quoted(String(a.rep.channels))}`);
    attrs.push(`URI=${quoted(playlistUri(a.rep))}`);
    lines.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
  });
  const withAudio = audio[0];
  for (const v of video) {
    const codecs = [v.rep.codecs, ...(withAudio ? [withAudio.rep.codecs] : [])].join(',');
    const attrs = [
      // BANDWIDTH is the peak of the variant: video peak + audio peak (an upper bound of the true joint peak).
      `BANDWIDTH=${v.rep.bandwidth + (withAudio?.rep.bandwidth ?? 0)}`,
      `AVERAGE-BANDWIDTH=${averageBandwidth(v) + (withAudio ? averageBandwidth(withAudio) : 0)}`,
      `CODECS=${quoted(codecs)}`,
    ];
    if (v.rep.width !== undefined && v.rep.height !== undefined)
      attrs.push(`RESOLUTION=${v.rep.width}x${v.rep.height}`);
    if (v.rep.frameRate !== undefined) attrs.push(`FRAME-RATE=${v.rep.frameRate.toFixed(3)}`);
    if (withAudio) attrs.push(`AUDIO=${quoted(AUDIO_GROUP)}`);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, playlistUri(v.rep));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * EXT-X-TARGETDURATION = ceil(max EXTINF) over every segment of the source loop, not over the listed window: the value must not change
 * while a live playlist slides, and a window of three AAC segments can hold only 93-frame ones. For AAC that is 3 (94 frames = 2.0053 s).
 */
function targetDuration(r: RepIndex): number {
  return Math.ceil(Math.max(...r.segments.map((s) => s.duration / r.timescale)));
}

function segmentLines(r: RepIndex, first: number, last: number, program?: Date): string[] {
  const lines: string[] = [];
  for (let n = first; n <= last; n++) {
    const t = program ? liveTiming(r, n) : (r.segments[n - 1] as { start: number; duration: number });
    if (program)
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${isoTimestamp(instantAt(program, t.start, r.timescale))}`);
    lines.push(
      `#EXTINF:${formatSeconds(t.duration, r.timescale, 6)},`,
      `../seg/${r.rep.id}/${n}.${r.rep.segmentExt}`,
    );
  }
  return lines;
}

function header(r: RepIndex): string[] {
  return ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${targetDuration(r)}`];
}

export function buildHlsMediaVod(index: StreamIndex, repId: string): string {
  assertHls(index);
  if (index.info.kind !== 'vod') throw new Error(`stream ${index.info.id} is live: use the live playlist`);
  const r = findRep(index, repId);
  return `${[
    ...header(r),
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:1',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI=${quoted(`../seg/${r.rep.id}/init.${r.rep.initExt}`)}`,
    ...segmentLines(r, 1, r.segments.length),
    '#EXT-X-ENDLIST',
  ].join('\n')}\n`;
}

export function buildHlsMediaLive(index: StreamIndex, repId: string, params: HlsLiveParams): string {
  assertHls(index);
  if (index.info.kind !== 'live') throw new Error(`stream ${index.info.id} is not live`);
  if (
    !Number.isSafeInteger(params.firstNumber) ||
    !Number.isSafeInteger(params.lastNumber) ||
    params.firstNumber < 1 ||
    params.lastNumber < params.firstNumber
  ) {
    throw new RangeError(`invalid live window ${params.firstNumber}..${params.lastNumber}`);
  }
  const r = findRep(index, repId);
  // No ENDLIST and no PLAYLIST-TYPE: a live playlist. The media sequence is the number of the first listed segment, so the number in
  // every segment URL is its media sequence number, and a player that reloads can match segments by number.
  return `${[
    ...header(r),
    `#EXT-X-MEDIA-SEQUENCE:${params.firstNumber}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI=${quoted(`../seg/${r.rep.id}/init.${r.rep.initExt}`)}`,
    ...segmentLines(r, params.firstNumber, params.lastNumber, params.availabilityStartTime),
  ].join('\n')}\n`;
}
