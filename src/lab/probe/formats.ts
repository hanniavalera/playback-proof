import type { Protocol, StreamId } from '../../shared/streams.ts';

// The cases of the capability probe. A case is "append these tracks through MediaSource, play, and see time and frames
// advance". The four flavours are what the lab's streams are made of (docs/CONTRACTS.md, section 3); the single-track cases
// isolate which track of a flavour an engine cannot handle; the informational cases are codecs the lab does not stream.

/** Standalone, tiny, ffmpeg-generated files (media.ts). Each case appends one or two of them. */
export const PROBE_FILE_IDS = [
  'v-vp9.mp4',
  'v-vp9.webm',
  'v-vp8.webm',
  'v-h264.mp4',
  'v-av1.mp4',
  'v-hevc.mp4',
  'a-aac.mp4',
  'a-opus.mp4',
  'a-opus.webm',
] as const;
export type ProbeFileId = (typeof PROBE_FILE_IDS)[number];

export type TrackKind = 'video' | 'audio';

export interface FileFormat {
  kind: TrackKind;
  container: 'mp4' | 'webm';
  /** The type string given to `addSourceBuffer` and `MediaSource.isTypeSupported`, with the codec string a manifest would carry. */
  mimeType: string;
}

export const FILE_FORMATS: Record<ProbeFileId, FileFormat> = {
  'v-vp9.mp4': { kind: 'video', container: 'mp4', mimeType: 'video/mp4; codecs="vp09.00.10.08"' },
  'v-vp9.webm': { kind: 'video', container: 'webm', mimeType: 'video/webm; codecs="vp09.00.10.08"' },
  'v-vp8.webm': { kind: 'video', container: 'webm', mimeType: 'video/webm; codecs="vp8"' },
  'v-h264.mp4': { kind: 'video', container: 'mp4', mimeType: 'video/mp4; codecs="avc1.42E01E"' },
  'v-av1.mp4': { kind: 'video', container: 'mp4', mimeType: 'video/mp4; codecs="av01.0.04M.08"' },
  'v-hevc.mp4': { kind: 'video', container: 'mp4', mimeType: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  'a-aac.mp4': { kind: 'audio', container: 'mp4', mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
  'a-opus.mp4': { kind: 'audio', container: 'mp4', mimeType: 'audio/mp4; codecs="opus"' },
  'a-opus.webm': { kind: 'audio', container: 'webm', mimeType: 'audio/webm; codecs="opus"' },
};

export const FLAVOUR_IDS = ['cmaf-vp9-aac', 'cmaf-vp9-opus', 'webm-vp9-opus', 'cmaf-h264-aac'] as const;
export type FlavourId = (typeof FLAVOUR_IDS)[number];

export const SINGLE_TRACK_IDS = [
  'vp9-fmp4-video',
  'vp9-webm-video',
  'h264-fmp4-video',
  'vp8-webm-video',
  'aac-fmp4-audio',
  'opus-fmp4-audio',
  'opus-webm-audio',
] as const;
export type SingleTrackId = (typeof SINGLE_TRACK_IDS)[number];

export const INFORMATIONAL_IDS = ['av1-fmp4-video', 'hevc-fmp4-video'] as const;
export type InformationalId = (typeof INFORMATIONAL_IDS)[number];

export type CaseId = FlavourId | SingleTrackId | InformationalId;
export type CaseGroup = 'flavour' | 'single-track' | 'informational';

export interface ProbeTrack {
  kind: TrackKind;
  file: ProbeFileId;
  mimeType: string;
}

export interface ProbeCase {
  id: CaseId;
  group: CaseGroup;
  title: string;
  tracks: readonly ProbeTrack[];
}

function defineCase(id: CaseId, group: CaseGroup, title: string, files: readonly ProbeFileId[]): ProbeCase {
  return {
    id,
    group,
    title,
    tracks: files.map((file) => ({
      kind: FILE_FORMATS[file].kind,
      file,
      mimeType: FILE_FORMATS[file].mimeType,
    })),
  };
}

export const PROBE_CASES: readonly ProbeCase[] = [
  defineCase('cmaf-vp9-aac', 'flavour', 'fMP4: VP9 + AAC (primary)', ['v-vp9.mp4', 'a-aac.mp4']),
  defineCase('cmaf-vp9-opus', 'flavour', 'fMP4: VP9 + Opus', ['v-vp9.mp4', 'a-opus.mp4']),
  defineCase('webm-vp9-opus', 'flavour', 'WebM: VP9 + Opus', ['v-vp9.webm', 'a-opus.webm']),
  defineCase('cmaf-h264-aac', 'flavour', 'fMP4: H.264 + AAC', ['v-h264.mp4', 'a-aac.mp4']),
  defineCase('vp9-fmp4-video', 'single-track', 'fMP4: VP9 video only', ['v-vp9.mp4']),
  defineCase('vp9-webm-video', 'single-track', 'WebM: VP9 video only', ['v-vp9.webm']),
  defineCase('h264-fmp4-video', 'single-track', 'fMP4: H.264 video only', ['v-h264.mp4']),
  defineCase('vp8-webm-video', 'single-track', 'WebM: VP8 video only', ['v-vp8.webm']),
  defineCase('aac-fmp4-audio', 'single-track', 'fMP4: AAC audio only', ['a-aac.mp4']),
  defineCase('opus-fmp4-audio', 'single-track', 'fMP4: Opus audio only', ['a-opus.mp4']),
  defineCase('opus-webm-audio', 'single-track', 'WebM: Opus audio only', ['a-opus.webm']),
  defineCase('av1-fmp4-video', 'informational', 'fMP4: AV1 video only', ['v-av1.mp4']),
  defineCase('hevc-fmp4-video', 'informational', 'fMP4: HEVC video only', ['v-hevc.mp4']),
];

export function findCase(id: string): ProbeCase | undefined {
  return PROBE_CASES.find((c) => c.id === id);
}

export function isFlavourId(id: string): id is FlavourId {
  return (FLAVOUR_IDS as readonly string[]).includes(id);
}

/** Every distinct type string the cases use: what the page is asked about with `isTypeSupported`. */
export function mimeTypesOf(cases: readonly ProbeCase[]): string[] {
  return [...new Set(cases.flatMap((c) => c.tracks.map((t) => t.mimeType)))];
}

/**
 * Controls: the same bytes played as a plain `<video src>` (no MediaSource). Where a control plays and the matching MSE
 * case does not, the file is sound and the failure is in the engine's MSE pipeline. Only the files the lab's streams use.
 */
export interface ControlCase {
  id: string;
  title: string;
  file: ProbeFileId;
}

export const CONTROL_CASES: readonly ControlCase[] = [
  { id: 'native-vp9-fmp4-video', title: 'fMP4 VP9 video', file: 'v-vp9.mp4' },
  { id: 'native-aac-fmp4-audio', title: 'fMP4 AAC audio', file: 'a-aac.mp4' },
  { id: 'native-vp9-webm-video', title: 'WebM VP9 video', file: 'v-vp9.webm' },
  { id: 'native-opus-webm-audio', title: 'WebM Opus audio', file: 'a-opus.webm' },
];

export type StreamKind = 'vod' | 'live';

/**
 * How the page that hosts the probe behaves. Playwright's Linux WebKit decodes or fails depending on it (ADR-031), so the
 * verdict of a case is only meaningful together with the profile it was measured under.
 */
export interface PageProfile {
  id: string;
  title: string;
  /** `video.muted = true` before the source is attached (what a page does so autoplay is allowed). */
  muted: boolean;
  /** Fetch the data before the MediaSource exists, so the appends follow `addSourceBuffer` immediately. */
  prefetch: boolean;
}

/** What a player page does: muted element, segments fetched after the SourceBuffers exist. Used for every verdict. */
export const DEFAULT_PROFILE: PageProfile = {
  id: 'default',
  title: 'muted element, data fetched after the SourceBuffers exist (like a player page)',
  muted: true,
  prefetch: false,
};

/** One factor changed at a time, run for the primary flavour in every engine. */
export const SENSITIVITY_PROFILES: readonly PageProfile[] = [
  {
    id: 'unmuted',
    title: 'element not muted, otherwise like the default',
    muted: false,
    prefetch: false,
  },
  {
    id: 'prefetch',
    title: 'muted, but the data is fetched before the MediaSource exists',
    muted: true,
    prefetch: true,
  },
];

export const SENSITIVITY_CASE: FlavourId = 'cmaf-vp9-aac';

/**
 * Which flavour each lab stream is made of, and over which protocols it is served. Mirrors the stream catalog in
 * docs/CONTRACTS.md, section 3 (the running service's `GET /api/streams` is authoritative for everything else).
 * `Record<StreamId, ...>` makes the compiler flag a new stream that has no flavour.
 */
export const LAB_STREAMS: Record<
  StreamId,
  { kind: StreamKind; flavour: FlavourId; protocols: readonly Protocol[] }
> = {
  'vod-cmaf': { kind: 'vod', flavour: 'cmaf-vp9-aac', protocols: ['dash', 'hls'] },
  'vod-cmaf-short': { kind: 'vod', flavour: 'cmaf-vp9-aac', protocols: ['dash', 'hls'] },
  'vod-webm': { kind: 'vod', flavour: 'webm-vp9-opus', protocols: ['dash'] },
  'live-cmaf': { kind: 'live', flavour: 'cmaf-vp9-aac', protocols: ['dash', 'hls'] },
  // The codecs are the primary flavour's; whether the engine can decrypt (EME) is a separate capability.
  'vod-cmaf-clearkey': { kind: 'vod', flavour: 'cmaf-vp9-aac', protocols: ['dash'] },
};

/** The stream the lab serves for a flavour that has one (the canonical VOD stream of that flavour). */
export const FLAVOUR_STREAMS = {
  'cmaf-vp9-aac': 'vod-cmaf',
  'webm-vp9-opus': 'vod-webm',
} as const satisfies Partial<Record<FlavourId, StreamId>>;

/** Selection order per kind: the first stream whose flavour plays in the browser (and that offers the protocol) wins. */
export const STREAM_PREFERENCE: Record<StreamKind, readonly StreamId[]> = {
  vod: ['vod-cmaf', 'vod-webm'],
  live: ['live-cmaf'],
};
