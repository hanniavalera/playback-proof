import type { RepInfo, StreamId, StreamInfo } from '../../../src/shared/streams.ts';
import { STREAM_IDS } from '../../../src/shared/streams.ts';
import type {
  DashLiveParams,
  HlsLiveParams,
  MediaStore,
  RepIndex,
  StreamIndex,
} from '../../../src/server/media/types.ts';

// A tiny in-memory MediaStore for the service tests: the HTTP layer is tested without ffmpeg and without generated streams (the
// unit job of CI has neither). It holds just enough to tell WHICH bytes the service served: the first line of every buffer says
// what it is (`describeBuffer`), and every manifest is one line of `key=value` tokens that echoes the parameters the service
// computed for it (`parseManifest`), so a test asserts the window and the publish time without parsing XML.
//
//   vod-cmaf-short  VOD, DASH + HLS, 6 segments of 2 s       (v360 video/mp4, a-aac audio/mp4)
//   live-cmaf       LIVE, DASH + HLS, 12 source segments     (looped by liveSegment, like the real store)
//   vod-webm        VOD, DASH only, 4 segments of 2 s        (v360 video/webm, a-opus audio/webm)
//
// The other streams of the catalog are "missing", which is what /health and POST /api/sessions must report for them.

export const FAKE_VOD: StreamId = 'vod-cmaf-short';
export const FAKE_LIVE: StreamId = 'live-cmaf';
export const FAKE_WEBM: StreamId = 'vod-webm';

export const FAKE_VOD_SEGMENTS = 6;
export const FAKE_LIVE_SEGMENTS = 12;
export const FAKE_WEBM_SEGMENTS = 4;
export const FAKE_VIDEO = 'v360';
export const FAKE_AUDIO = 'a-aac';

const SEGMENT_SEC = 2;
const TICKS = 1000;

export interface FakeMediaOptions {
  /** Size of every media segment in bytes (default 600), or a function of (rep, number). */
  segmentBytes?: number | ((rep: string, number: number) => number);
  /** Size of every initialization segment (default 120). */
  initBytes?: number;
}

export interface FakeMedia extends MediaStore {
  /** How many live manifests and playlists were built: a replayed (stale) body does not build. */
  liveManifestBuilds(): number;
}

/** What the first line of a fake buffer says. */
export interface FakeContent {
  what: 'init' | 'segment';
  stream: string;
  rep: string;
  /** The segment number as requested (the live number for a live segment). */
  number?: number;
  live: boolean;
  /** Live only: the source segment (1-based) and the loop index the live number maps to. */
  source?: number;
  loop?: number;
}

function repsFor(packaging: 'cmaf' | 'webm'): RepInfo[] {
  const webm = packaging === 'webm';
  return [
    {
      id: FAKE_VIDEO,
      track: 'video',
      mimeType: webm ? 'video/webm' : 'video/mp4',
      codecs: 'vp09.00.10.08',
      bandwidth: 700_000,
      width: 640,
      height: 360,
      frameRate: 30,
      initExt: webm ? 'webm' : 'mp4',
      segmentExt: webm ? 'webm' : 'm4s',
    },
    {
      id: webm ? 'a-opus' : FAKE_AUDIO,
      track: 'audio',
      mimeType: webm ? 'audio/webm' : 'audio/mp4',
      codecs: webm ? 'opus' : 'mp4a.40.2',
      bandwidth: 64_000,
      channels: 2,
      sampleRate: 48_000,
      initExt: webm ? 'webm' : 'mp4',
      segmentExt: webm ? 'webm' : 'm4s',
    },
  ];
}

function streamInfo(
  id: StreamId,
  kind: 'vod' | 'live',
  packaging: 'cmaf' | 'webm',
  protocols: StreamInfo['protocols'],
  segmentCount: number,
): StreamInfo {
  return {
    id,
    kind,
    packaging,
    protocols,
    segmentDurationSec: SEGMENT_SEC,
    segmentCount,
    durationSec: segmentCount * SEGMENT_SEC,
    reps: repsFor(packaging),
    contentHash: `fake-${id}`,
    ffmpegVersion: 'fake-ffmpeg 0.0',
  };
}

const INFOS: StreamInfo[] = [
  streamInfo(FAKE_VOD, 'vod', 'cmaf', ['dash', 'hls'], FAKE_VOD_SEGMENTS),
  streamInfo(FAKE_LIVE, 'live', 'cmaf', ['dash', 'hls'], FAKE_LIVE_SEGMENTS),
  streamInfo(FAKE_WEBM, 'vod', 'webm', ['dash'], FAKE_WEBM_SEGMENTS),
];

function indexOf(info: StreamInfo): StreamIndex {
  const reps: RepIndex[] = info.reps.map((rep) => ({
    rep,
    timescale: TICKS,
    loopTicks: info.segmentCount * SEGMENT_SEC * TICKS,
    segments: Array.from({ length: info.segmentCount }, (_, i) => ({
      number: i + 1,
      start: i * SEGMENT_SEC * TICKS,
      duration: SEGMENT_SEC * TICKS,
      bytes: 0,
      sha256: '',
    })),
  }));
  return { info, reps };
}

/** A buffer whose first line is `header` and whose rest is a pattern that depends on `seed`, so that two buffers never look alike. */
function buffer(header: string, size: number, seed: number): Buffer {
  const line = `${header}\n`;
  const out = Buffer.alloc(Math.max(size, line.length));
  out.write(line, 'latin1');
  for (let i = line.length; i < out.length; i++) out[i] = (seed * 131 + i * 31) & 0xff;
  return out;
}

export function describeBuffer(data: Buffer): FakeContent {
  const end = data.indexOf(0x0a);
  const tokens = data
    .subarray(0, end === -1 ? Math.min(data.length, 200) : end)
    .toString('latin1')
    .split(' ');
  const field = (name: string): string | undefined =>
    tokens.find((token) => token.startsWith(`${name}=`))?.slice(name.length + 1);
  const what = tokens[1];
  if (tokens[0] !== 'PB' || (what !== 'init' && what !== 'segment'))
    throw new Error(`not a fake media buffer: ${JSON.stringify(tokens.slice(0, 4))}`);
  const number = field('n');
  const source = field('src');
  const loop = field('loop');
  return {
    what,
    stream: field('stream') ?? '',
    rep: field('rep') ?? '',
    ...(number === undefined ? {} : { number: Number(number) }),
    live: tokens.includes('live'),
    ...(source === undefined ? {} : { source: Number(source) }),
    ...(loop === undefined ? {} : { loop: Number(loop) }),
  };
}

/** The tokens of a fake manifest: `kind=dash-live stream=live-cmaf first=1 last=15 ...`. */
export function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of text.trim().split(/\s+/)) {
    const at = token.indexOf('=');
    if (at > 0) out[token.slice(0, at)] = token.slice(at + 1);
  }
  return out;
}

export function createFakeMedia(options: FakeMediaOptions = {}): FakeMedia {
  const initBytes = options.initBytes ?? 120;
  const segmentBytes = options.segmentBytes ?? 600;
  const sizeOf = (rep: string, number: number): number =>
    typeof segmentBytes === 'function' ? segmentBytes(rep, number) : segmentBytes;
  const byId = new Map(INFOS.map((info) => [info.id, info]));
  const cache = new Map<string, Buffer>();
  let liveBuilds = 0;

  const info = (id: StreamId): StreamInfo => {
    const found = byId.get(id);
    if (!found) throw new Error(`stream '${id}' is not ready (fake store)`);
    return found;
  };
  const rep = (id: StreamId, repId: string): RepInfo => {
    const found = info(id).reps.find((candidate) => candidate.id === repId);
    if (!found) throw new Error(`stream '${id}' has no representation '${repId}'`);
    return found;
  };
  const cached = (key: string, make: () => Buffer): Buffer => {
    let data = cache.get(key);
    if (!data) cache.set(key, (data = make()));
    return data;
  };
  const requireLive = (id: StreamId): StreamInfo => {
    const found = info(id);
    if (found.kind !== 'live') throw new Error(`stream '${id}' is not live`);
    return found;
  };
  const live = (id: StreamId, params: HlsLiveParams): string =>
    `first=${params.firstNumber} last=${params.lastNumber} ast=${params.availabilityStartTime.toISOString()}`;

  return {
    ffmpegVersion: () => 'fake-ffmpeg 0.0',
    streams: () => STREAM_IDS.filter((id) => byId.has(id)).map((id) => info(id)),
    has: (id) => byId.has(id),
    index: (id) => indexOf(info(id)),

    init(id, repId) {
      rep(id, repId);
      return cached(`init:${id}:${repId}`, () => buffer(`PB init stream=${id} rep=${repId}`, initBytes, 1));
    },
    segment(id, repId, number) {
      const found = info(id);
      rep(id, repId);
      if (!Number.isInteger(number) || number < 1 || number > found.segmentCount) return undefined;
      return cached(`seg:${id}:${repId}:${number}`, () =>
        buffer(`PB segment stream=${id} rep=${repId} n=${number} vod`, sizeOf(repId, number), number),
      );
    },
    liveSegment(id, repId, number) {
      const found = requireLive(id);
      rep(id, repId);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new RangeError(`live segment numbers are integers >= 1, got ${number}`);
      const source = ((number - 1) % found.segmentCount) + 1;
      const loop = Math.floor((number - 1) / found.segmentCount);
      return cached(`live:${id}:${repId}:${number}`, () =>
        buffer(
          `PB segment stream=${id} rep=${repId} n=${number} live src=${source} loop=${loop}`,
          sizeOf(repId, number),
          number,
        ),
      );
    },
    liveSegmentTiming(id, repId, number) {
      requireLive(id);
      rep(id, repId);
      return { start: (number - 1) * SEGMENT_SEC * TICKS, duration: SEGMENT_SEC * TICKS };
    },

    dashVod: (id) => `kind=dash-vod stream=${info(id).id} segments=${info(id).segmentCount}`,
    dashLive(id, params: DashLiveParams) {
      requireLive(id);
      liveBuilds++;
      return (
        `kind=dash-live stream=${id} ${live(id, params)} publish=${params.publishTime.toISOString()} ` +
        `tsbd=${params.timeShiftBufferDepthSec} delay=${params.presentationDelaySec} ` +
        `mup=${params.minimumUpdatePeriodSec}`
      );
    },
    hlsMaster: (id) => `kind=hls-master stream=${info(id).id}`,
    hlsMediaVod(id, repId) {
      rep(id, repId);
      return `kind=hls-vod stream=${id} rep=${repId} segments=${info(id).segmentCount}`;
    },
    hlsMediaLive(id, repId, params) {
      requireLive(id);
      rep(id, repId);
      liveBuilds++;
      return `kind=hls-live stream=${id} rep=${repId} ${live(id, params)}`;
    },
    liveManifestBuilds: () => liveBuilds,
  };
}
