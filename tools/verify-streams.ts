// `npm run verify:streams -- [--streams a,b] [--cache-dir DIR] [--verbose] [--keep] [--skip-manifests] [--serve]`
//
// Independent evidence that the generated streams are what the manifests and the index say they are. Nothing is marked valid because
// this repository's own parser says so: every check is made against ffprobe / ffmpeg (a real demuxer and decoder).
//
//   1. concatenation decode    init + segment 1 + 2 + ... of every representation decodes without error; frame counts and durations
//   2. parser cross-check      per segment, the parser's first-sample time and duration equal ffprobe's packet-level numbers
//                              (packets are assigned to segments by BYTE POSITION in the concatenated file, never by the parser's counts)
//   3. keyframe alignment      every video segment starts at a key frame and holds exactly one; all rungs are identical
//   4. manifests               a local HTTP server lays the files out as docs/CONTRACTS.md says. HLS: ffprobe/ffmpeg read the master and
//                              the playlists. DASH: ffmpeg's DASH demuxer when this build has one (it needs libxml2; Homebrew's does not),
//                              and always an independent DASH client (tools/lib/dash-client.ts) that expands the SegmentTemplate like a
//                              player, fetches every listed segment and compares the times the MPD CLAIMS with the times ffprobe FINDS.
//                              Live: a window of 15 segments around n = 100 (the 12-segment loop has wrapped 8 times) and a window
//                              that straddles a loop boundary (segments 10..16): timestamps must be monotonic and gapless across it.
//
// Exit code 1 on any failure. Servers use ports 4620-4629 and are always closed. Scratch files live under .cache/tmp and are removed.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { STREAM_IDS, type StreamId } from '../src/shared/streams.ts';
import { parseServicePath } from '../src/shared/urls.ts';
import {
  checkStreamDir,
  defaultCacheDir,
  initFileName,
  segmentFileName,
  streamDir,
} from '../src/server/media/cache.ts';
import { CommandError, ffmpegBinary, ffmpegVersion, ffprobeBinary, run } from '../src/server/media/ffmpeg.ts';
import { parseWebmInit } from '../src/server/media/ebml.ts';
import { createMediaStore } from '../src/server/media/index.ts';
import { checkStreamIndex } from '../src/server/media/invariants.ts';
import { liveTiming } from '../src/server/media/live.ts';
import {
  AAC_GRID,
  audioFrameCount,
  audioSegmentFrameCounts,
  OPUS_WEBM_GRID,
  videoSegmentFrameCounts,
} from '../src/server/media/segmenter.ts';
import { CATALOG, streamSpec, type StreamSpec } from '../src/server/media/specs.ts';
import type {
  DashLiveParams,
  HlsLiveParams,
  MediaStore,
  RepIndex,
  StreamIndex,
} from '../src/server/media/types.ts';
import { parseDash, type DashManifest, type DashRepresentation } from './lib/dash-client.ts';

interface Check {
  stream: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const evidence: string[] = [];
const skipped: string[] = [];
const verbose = { on: false };

function record(stream: string, name: string, ok: boolean, detail = ''): boolean {
  checks.push({ stream, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${stream.padEnd(15)} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

function skip(stream: string, name: string, why: string): void {
  skipped.push(`${stream}: ${name} (${why})`);
  console.log(`SKIP ${stream.padEnd(15)} ${name}: ${why}`);
}

function note(line: string): void {
  evidence.push(line);
  if (verbose.on) console.log(`     | ${line}`);
}

// ------------------------------------------------------------------------------------------------------------------------------
// ffprobe / ffmpeg
// ------------------------------------------------------------------------------------------------------------------------------

interface ProbePacket {
  streamIndex: number;
  pts: number;
  dts: number;
  duration: number;
  size: number;
  pos: number;
  key: boolean;
}

interface RawPacket {
  stream_index?: number;
  pts?: number;
  dts?: number;
  duration?: number;
  size?: string;
  pos?: string;
  flags?: string;
}

interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  time_base?: string;
  start_time?: string;
  duration?: string;
  duration_ts?: number;
  nb_read_frames?: string;
}

async function ffprobeJson(args: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const { stdout } = await run(ffprobeBinary(), ['-v', 'error', '-of', 'json', ...args], { timeoutMs });
  return JSON.parse(stdout.toString('utf8')) as Record<string, unknown>;
}

async function probePackets(target: string, extra: string[] = []): Promise<ProbePacket[]> {
  const json = await ffprobeJson([
    ...extra,
    '-show_entries',
    'packet=stream_index,pts,dts,duration,size,pos,flags',
    target,
  ]);
  const packets = ((json.packets as RawPacket[] | undefined) ?? []).map((p) => ({
    streamIndex: p.stream_index ?? 0,
    pts: p.pts ?? Number.NaN,
    dts: p.dts ?? Number.NaN,
    duration: p.duration ?? Number.NaN,
    size: Number(p.size ?? Number.NaN),
    pos: Number(p.pos ?? Number.NaN),
    key: (p.flags ?? '').includes('K'),
  }));
  fillFirstDurations(packets);
  return packets;
}

/**
 * ffprobe 6.1 leaves the duration of the first packet of a stream out (its parser has not seen a frame yet; 9.0 prints it) while the
 * packets after it carry theirs. That one value is the distance to the next packet of the stream, so it is filled in from there.
 * Any other missing duration stays NaN, and the checks that need it fail.
 */
function fillFirstDurations(packets: ProbePacket[]): void {
  const seen = new Set<number>();
  packets.forEach((p, i) => {
    if (seen.has(p.streamIndex)) return;
    seen.add(p.streamIndex);
    if (!Number.isNaN(p.duration)) return;
    const next = packets.slice(i + 1).find((q) => q.streamIndex === p.streamIndex);
    if (next && !Number.isNaN(next.duration)) {
      p.duration = next.pts - p.pts;
      note(
        `ffprobe left out the duration of the first packet of stream #${p.streamIndex}: ${p.duration} from the pts spacing`,
      );
    }
  });
}

async function probeStreams(
  target: string,
  extra: string[] = [],
): Promise<{ streams: ProbeStream[]; duration?: number }> {
  const json = await ffprobeJson([
    ...extra,
    '-show_entries',
    'stream=index,codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels,time_base,start_time,duration,duration_ts,nb_read_frames:format=duration',
    target,
  ]);
  const format = json.format as { duration?: string } | undefined;
  const out: { streams: ProbeStream[]; duration?: number } = {
    streams: (json.streams as ProbeStream[] | undefined) ?? [],
  };
  if (format?.duration !== undefined) out.duration = Number(format.duration);
  return out;
}

/** What a failed ffmpeg/ffprobe said, in one line (its stderr, not the command line). */
function reason(e: unknown): string {
  if (e instanceof CommandError) {
    const lines = e.stderr.split('\n').filter((l) => l.trim() !== '');
    return lines.slice(-2).join(' | ') || e.message.split('\n')[0] || 'failed';
  }
  return (e as Error).message.split('\n')[0] ?? 'failed';
}

/**
 * Decodes everything with ffmpeg (`-xerror`: the first decode error is fatal). Returns '' when clean, else the reason.
 * `input` options go before `-i` (demuxer options, `-t`), `output` options after it (`-map`).
 */
async function decodeErrors(target: string, input: string[] = [], output: string[] = []): Promise<string> {
  try {
    const { stderr } = await run(
      ffmpegBinary(),
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-xerror',
        ...input,
        '-i',
        target,
        ...output,
        '-f',
        'null',
        '-',
      ],
      {
        timeoutMs: 300_000,
      },
    );
    return stderr.trim();
  } catch (e) {
    return reason(e);
  }
}

async function hasDemuxer(name: string): Promise<boolean> {
  const { stdout } = await run(ffmpegBinary(), ['-hide_banner', '-demuxers'], { timeoutMs: 30_000 });
  return stdout
    .toString('utf8')
    .split('\n')
    .some((line) => {
      const m = /^\s*D\S*\s+(\S+)/.exec(line);
      return m !== null && (m[1] ?? '').split(',').includes(name);
    });
}

// ------------------------------------------------------------------------------------------------------------------------------
// Helpers shared by the checks
// ------------------------------------------------------------------------------------------------------------------------------

const countsFor = (spec: StreamSpec, index: StreamIndex, track: 'video' | 'audio'): number[] =>
  track === 'video'
    ? videoSegmentFrameCounts(index.info.segmentCount, index.info.segmentDurationSec, spec.frameRate)
    : audioSegmentFrameCounts(
        index.info.segmentCount,
        index.info.segmentDurationSec,
        index.info.packaging === 'webm' ? OPUS_WEBM_GRID : AAC_GRID,
      );

/** Packets of a concatenated file grouped by the segment their byte position falls into (`init` first, then the segments in order). */
function groupBySegment(packets: ProbePacket[], initLength: number, sizes: number[]): ProbePacket[][] {
  let at = initLength;
  return sizes.map((size) => {
    const from = at;
    at += size;
    return packets.filter((p) => p.pos >= from && p.pos < at);
  });
}

/** Each packet must start where the previous one ended: video has a constant frame duration, audio packets carry their own. */
function countBreaks(packets: ProbePacket[], video: boolean, frameTicks: number): number {
  return packets.filter((p, i) => {
    if (i === 0) return false;
    const before = packets[i - 1] as ProbePacket;
    return p.pts !== before.pts + (video ? frameTicks : before.duration);
  }).length;
}

const endTicksOf = (packets: ProbePacket[], st: ProbeStream | undefined): number => {
  if (st?.duration_ts !== undefined && Number.isFinite(Number(st.duration_ts))) return Number(st.duration_ts);
  const last = packets[packets.length - 1];
  const prev = packets[packets.length - 2];
  return last && prev ? last.pts + (last.pts - prev.pts) : Number.NaN;
};

const ffprobeCodecName = (codecs: string): string =>
  codecs.startsWith('vp09') ? 'vp9' : codecs.startsWith('mp4a') ? 'aac' : codecs === 'opus' ? 'opus' : codecs;

/** Ticks a demuxer subtracts from block timestamps: the Opus CodecDelay of a WebM init segment, 0 for everything else. */
function demuxerOffset(init: Buffer): number {
  if (init.subarray(0, 4).readUInt32BE(0) !== 0x1a45dfa3) return 0; // not EBML: an ISO BMFF init (no edit list, no offset)
  const webm = parseWebmInit(init);
  const track = webm.tracks[0];
  return track?.codecDelayNs ? Math.round(track.codecDelayNs / webm.timecodeScaleNs) : 0;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Checks 1 to 3: the files
// ------------------------------------------------------------------------------------------------------------------------------

interface RepProbe {
  packets: ProbePacket[];
  /** End of the representation in ticks, as the demuxer computed it (sum of the sample durations). */
  endTicks: number;
}

async function verifyRepFiles(
  id: StreamId,
  spec: StreamSpec,
  index: StreamIndex,
  r: RepIndex,
  dir: string,
  scratch: string,
): Promise<RepProbe> {
  const label = `${id}/${r.rep.id}`;
  const init = readFileSync(join(dir, initFileName(r.rep)));
  const segments = r.segments.map((s) => readFileSync(join(dir, segmentFileName(r.rep, s.number))));
  const file = join(scratch, `${id}-${r.rep.id}.${r.rep.initExt}`);
  writeFileSync(file, Buffer.concat([init, ...segments]));
  const video = r.rep.track === 'video';
  const mp4 = index.info.packaging === 'cmaf';

  // ---- 1. decode the concatenation with ffmpeg and count frames with ffprobe
  const errors = await decodeErrors(file);
  record(label, 'concatenation decodes without error', errors === '', errors.split('\n')[0] ?? '');
  const probed = await probeStreams(file, ['-count_frames']);
  const st = probed.streams[0];
  const frames = Number(st?.nb_read_frames);
  const packets = await probePackets(file);
  note(`${label}: ffprobe stream ${JSON.stringify(st)}`);
  note(`${label}: first packets ${JSON.stringify(packets.slice(0, 2))}`);
  const grid = mp4 ? AAC_GRID : OPUS_WEBM_GRID;
  const wanted = video
    ? Math.round(index.info.durationSec * spec.frameRate)
    : audioFrameCount(index.info.segmentCount * index.info.segmentDurationSec, grid);
  record(label, `decoded frame count == ${wanted}`, frames === wanted, `ffprobe decoded ${frames}`);
  const unordered = packets.filter((p, i) => i > 0 && !(p.dts > (packets[i - 1] as ProbePacket).dts)).length;
  record(
    label,
    'packet timestamps strictly increase',
    unordered === 0,
    `${unordered} out of order of ${packets.length}`,
  );
  const endTicks = endTicksOf(packets, st);

  // ---- 2. parser vs ffprobe, segment by segment; a segment lasts until the NEXT one starts (the last one: until the demuxer's end)
  const bySegment = groupBySegment(
    packets,
    init.length,
    segments.map((s) => s.length),
  );
  const covered = bySegment.reduce((n, p) => n + p.length, 0);
  record(
    label,
    'every packet falls into exactly one segment',
    covered === packets.length,
    `${covered}/${packets.length}`,
  );
  const expectedCounts = countsFor(spec, index, r.rep.track);
  // ffprobe reports Opus-in-WebM packets at (block timecode - CodecDelay): the demuxer applies the codec delay the Tracks element
  // declares (6.5 ms, 7 ticks of the millisecond timeline). The cluster timecodes themselves stay on the 2000 ms grid.
  const offset = demuxerOffset(init);
  const mismatches: string[] = [];
  r.segments.forEach((s, i) => {
    const group = bySegment[i] ?? [];
    const first = group[0];
    if (!first) {
      mismatches.push(`segment ${s.number}: ffprobe found no packet`);
      return;
    }
    if (first.pts + offset !== s.start)
      mismatches.push(
        `segment ${s.number}: first pts ${first.pts}${offset ? ` (+${offset} codec delay)` : ''} != parser start ${s.start}`,
      );
    // The packet count per segment must be what the cutting rule prescribes (94, 94, 94, 93, ... frames for AAC; 60 for video).
    if (group.length !== expectedCounts[i])
      mismatches.push(
        `segment ${s.number}: ffprobe found ${group.length} packets, the rule says ${expectedCounts[i]}`,
      );
    const next = bySegment[i + 1]?.[0];
    const spanEnd = next ? next.pts : mp4 ? endTicks : undefined;
    if (spanEnd !== undefined && spanEnd - first.pts !== s.duration) {
      mismatches.push(
        `segment ${s.number}: ffprobe says it lasts ${spanEnd - first.pts} ticks, parser says ${s.duration}`,
      );
    }
    if (mp4 && !video) {
      const sum = group.reduce((n, p) => n + p.duration, 0);
      if (sum !== s.duration)
        mismatches.push(`segment ${s.number}: ffprobe durations sum to ${sum}, parser says ${s.duration}`);
    }
  });
  record(
    label,
    'parser start/duration == ffprobe packets (all segments)',
    mismatches.length === 0,
    mismatches.slice(0, 3).join('; '),
  );
  if (mp4) {
    const breaks = countBreaks(packets, video, r.timescale / spec.frameRate);
    record(
      label,
      'packets are gapless and overlap-free (each starts where the previous ended)',
      breaks === 0,
      `${breaks} breaks`,
    );
  }

  // ---- 3. key frames
  if (video) {
    const bad = bySegment
      .map((g, i) => ({ i, g }))
      .filter(({ g }) => !(g[0]?.key === true && g.filter((p) => p.key).length === 1));
    record(
      label,
      'every segment starts at a key frame and holds exactly one',
      bad.length === 0,
      bad
        .map((b) => `segment ${b.i + 1}`)
        .slice(0, 3)
        .join(', '),
    );
  }
  return { packets, endTicks };
}

async function verifyStreamFiles(
  id: StreamId,
  cacheDir: string,
  scratch: string,
): Promise<{ bytes: number }> {
  const spec = streamSpec(id);
  if (!spec) throw new Error(`stream ${id} is not in the catalog`);
  const dir = streamDir(cacheDir, spec);
  const check = checkStreamDir(dir, spec, { hash: true });
  record(
    id,
    'cache is complete and every file matches its sha256',
    check.ok,
    check.problems.slice(0, 2).join('; '),
  );
  if (!check.ok || !check.file) throw new Error(`${id}: cannot continue, run npm run generate:streams`);
  const index = check.file.index;
  const problems = checkStreamIndex(index, {
    audioFrameSec: index.info.packaging === 'webm' ? 0.02 : 1024 / 48000,
  });
  record(
    id,
    'index invariants (alignment, contiguity, loop length)',
    problems.length === 0,
    problems.slice(0, 2).join('; '),
  );

  const perRep = new Map<string, RepProbe>();
  for (const r of index.reps) perRep.set(r.rep.id, await verifyRepFiles(id, spec, index, r, dir, scratch));

  // Rungs of one stream: identical first-pts per segment, taken from ffprobe, not from the parser.
  const video = index.reps.filter((r) => r.rep.track === 'video');
  const startsOf = (r: RepIndex): number[] => {
    const init = readFileSync(join(dir, initFileName(r.rep)));
    return groupBySegment(
      perRep.get(r.rep.id)?.packets ?? [],
      init.length,
      r.segments.map((s) => s.bytes),
    ).map((g) => g[0]?.pts ?? Number.NaN);
  };
  const ref = video[0];
  if (ref) {
    const refStarts = startsOf(ref);
    const misaligned = video.slice(1).filter((r) => startsOf(r).some((v, i) => v !== refStarts[i]));
    record(
      id,
      `all ${video.length} rungs start every segment at the same time (ffprobe)`,
      misaligned.length === 0,
      misaligned.map((r) => r.rep.id).join(', '),
    );
  }
  // Audio and video of the stream have the same length within one audio frame (live: to the tick, checked by the invariants above).
  const audio = index.reps.find((r) => r.rep.track === 'audio');
  if (ref && audio) {
    const vEnd = (perRep.get(ref.rep.id)?.endTicks ?? Number.NaN) / ref.timescale;
    const aEnd = (perRep.get(audio.rep.id)?.endTicks ?? Number.NaN) / audio.timescale;
    const frameSec = index.info.packaging === 'webm' ? 0.02 : 1024 / 48000;
    record(
      id,
      'audio duration == video duration within one audio frame (ffprobe)',
      Math.abs(vEnd - aEnd) < frameSec,
      `video ${vEnd.toFixed(6)} s, audio ${aEnd.toFixed(6)} s`,
    );
  }
  return { bytes: Object.values(check.file.files).reduce((n, f) => n + f.bytes, 0) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// The layout server (docs/CONTRACTS.md section 3, URL layout) with a fixed fake clock
// ------------------------------------------------------------------------------------------------------------------------------

/** Stream time 0 and the instant the server reports as "now". Nothing here depends on the real time. */
const AST = new Date('2026-01-01T00:00:00.000Z');
const SEGMENT_SEC = 2;

interface Scenario {
  session: string;
  firstNumber: number;
  lastNumber: number;
}

/** A window of 15 segments around n = 100 (the 12-segment loop has wrapped 8 times), and one that straddles a loop boundary. */
const SCENARIOS: Scenario[] = [
  { session: 'live100', firstNumber: 86, lastNumber: 100 },
  { session: 'wrap', firstNumber: 10, lastNumber: 16 },
];

const liveParams = (s: Scenario): DashLiveParams & HlsLiveParams => ({
  firstNumber: s.firstNumber,
  lastNumber: s.lastNumber,
  availabilityStartTime: AST,
  publishTime: new Date(AST.getTime() + s.lastNumber * SEGMENT_SEC * 1000),
  timeShiftBufferDepthSec: 30,
  presentationDelaySec: 6,
  minimumUpdatePeriodSec: 2,
});

function createLayoutServer(store: MediaStore): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, type: string, body: Buffer | string): void => {
      const data = typeof body === 'string' ? Buffer.from(body) : body;
      res.writeHead(status, {
        'content-type': type,
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    };
    try {
      if (url.pathname === '/api/time') {
        send(200, 'text/plain', new Date(AST.getTime() + 101 * SEGMENT_SEC * 1000).toISOString());
        return;
      }
      const p = parseServicePath(url.pathname);
      if (!p || !(STREAM_IDS as readonly string[]).includes(p.stream)) {
        send(404, 'text/plain', 'not found');
        return;
      }
      const id = p.stream as StreamId;
      const live = SCENARIOS.find((s) => s.session === p.sessionId);
      const info = store.index(id).info;
      const mime = (rep: string | undefined): string =>
        info.reps.find((r) => r.id === rep)?.mimeType ?? 'application/octet-stream';
      if (p.kind === 'manifest' && p.protocol === 'dash') {
        send(200, 'application/dash+xml', live ? store.dashLive(id, liveParams(live)) : store.dashVod(id));
      } else if (p.kind === 'manifest') {
        send(200, 'application/vnd.apple.mpegurl', store.hlsMaster(id));
      } else if (p.kind === 'media-playlist' && p.rep) {
        send(
          200,
          'application/vnd.apple.mpegurl',
          live ? store.hlsMediaLive(id, p.rep, liveParams(live)) : store.hlsMediaVod(id, p.rep),
        );
      } else if (p.kind === 'init' && p.rep) {
        send(200, mime(p.rep), store.init(id, p.rep));
      } else if (p.kind === 'segment' && p.rep && p.number !== undefined) {
        // Published segments only: [first - 2, last] like the service (docs/CONTRACTS.md: older ones are gone, newer ones not yet there).
        const body = live
          ? p.number >= live.firstNumber - 2 && p.number <= live.lastNumber
            ? store.liveSegment(id, p.rep, p.number)
            : undefined
          : store.segment(id, p.rep, p.number);
        if (body) send(200, mime(p.rep), body);
        else send(404, 'text/plain', 'no such segment');
      } else {
        send(404, 'text/plain', 'not found');
      }
    } catch (e) {
      send(500, 'text/plain', (e as Error).message);
    }
  });
}

async function listen(server: Server): Promise<number> {
  for (let port = 4620; port <= 4629; port++) {
    const ok = await new Promise<boolean>((done) => {
      const onError = (): void => done(false);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        done(true);
      });
    });
    if (ok) return port;
  }
  throw new Error('no free port in 4620-4629');
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });

async function get(url: string): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(url);
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Check 4a: DASH, through the independent client
// ------------------------------------------------------------------------------------------------------------------------------

async function verifyDashRep(
  label: string,
  r: DashRepresentation,
  store: MediaStore,
  id: StreamId,
  scenario: Scenario | undefined,
  scratch: string,
  spec: StreamSpec,
): Promise<void> {
  const info = store.index(id).info;
  const idx = store.index(id).reps.find((x) => x.rep.id === r.id);
  if (!idx) {
    record(label, `${r.id}: representation exists in the index`, false, '');
    return;
  }
  const tag = `${r.id}${scenario ? ` (${scenario.session})` : ''}`;
  const init = await get(r.initUrl);
  const bodies: Buffer[] = [];
  let missing = 0;
  for (const s of r.segments) {
    const got = await get(s.url);
    if (got.status !== 200) missing++;
    bodies.push(got.body);
  }
  record(
    label,
    `${tag}: init and all ${r.segments.length} listed segments are fetchable`,
    init.status === 200 && missing === 0,
    `${missing} missing, init ${init.status}`,
  );
  const file = join(scratch, `dash-${id}-${scenario?.session ?? 'vod'}-${r.id}.${idx.rep.initExt}`);
  writeFileSync(file, Buffer.concat([init.body, ...bodies]));
  const mp4 = info.packaging === 'cmaf';
  const video = r.contentType === 'video';
  const probed = await probeStreams(file);
  const st = probed.streams[0];
  const packets = await probePackets(file);

  // What the manifest says about the media, against what the demuxer finds in it.
  const codecOk = st?.codec_name === ffprobeCodecName(r.codecs);
  const dimsOk = !video || (st?.width === r.width && st?.height === r.height);
  const audioOk = video || (Number(st?.sample_rate) === r.audioSamplingRate && st?.channels === r.channels);
  record(
    label,
    `${tag}: codec ${r.codecs}, size/channels as the MPD says (ffprobe: ${st?.codec_name} ${st?.width ? `${st.width}x${st.height}` : `${st?.sample_rate} Hz x${st?.channels}`})`,
    codecOk && dimsOk && audioOk,
    '',
  );
  record(
    label,
    `${tag}: MPD attributes equal the index (codecs, bandwidth, mimeType)`,
    r.codecs === idx.rep.codecs && r.bandwidth === idx.rep.bandwidth && r.mimeType === idx.rep.mimeType,
    '',
  );

  // The times the MPD claims against the times ffprobe finds: first pts of each segment, and where the next one starts.
  const groups = groupBySegment(
    packets,
    init.body.length,
    bodies.map((b) => b.length),
  );
  const frameTicks = video ? r.timescale / spec.frameRate : 0;
  const offset = demuxerOffset(init.body); // Opus CodecDelay in WebM, see verifyRepFiles
  const wrong: string[] = [];
  r.segments.forEach((s, i) => {
    const first = groups[i]?.[0];
    if (!first) {
      wrong.push(`#${s.number}: no packet`);
      return;
    }
    if (first.pts + offset !== s.start)
      wrong.push(`#${s.number}: MPD start ${s.start}, media ${first.pts}${offset ? ` (+${offset})` : ''}`);
    const next = groups[i + 1]?.[0];
    if (next && mp4 && next.pts - first.pts !== s.duration)
      wrong.push(`#${s.number}: MPD duration ${s.duration}, media ${next.pts - first.pts}`);
    if (!next && mp4) {
      const last = groups[i] as ProbePacket[];
      const end = video
        ? (last[last.length - 1] as ProbePacket).pts + frameTicks
        : last.reduce((n, p) => n + p.duration, first.pts);
      if (end - first.pts !== s.duration)
        wrong.push(`#${s.number}: MPD duration ${s.duration}, media ${end - first.pts}`);
    }
  });
  record(
    label,
    `${tag}: every S entry (t, d) is what ffprobe finds in the segment bytes`,
    wrong.length === 0,
    wrong.slice(0, 3).join('; '),
  );
  if (mp4) {
    const breaks = countBreaks(packets, video, frameTicks);
    const mono = packets.every((p, i) => i === 0 || p.pts > (packets[i - 1] as ProbePacket).pts);
    record(
      label,
      `${tag}: timestamps are monotonic and gapless (${packets.length} packets, pts ${packets[0]?.pts}..${packets[packets.length - 1]?.pts}${scenario ? ', across the loop boundaries' : ''})`,
      mono && breaks === 0,
      `${breaks} breaks`,
    );
  }
  if (scenario) {
    const expected = liveTiming(idx, scenario.firstNumber).start;
    record(
      label,
      `${tag}: first packet is at the start of live segment ${scenario.firstNumber} (${expected})`,
      packets[0]?.pts === expected,
      `got ${packets[0]?.pts}`,
    );
    const errors = await decodeErrors(file);
    record(label, `${tag}: the window decodes without error`, errors === '', errors.split('\n')[0] ?? '');
  }
  // Declared bandwidth is the peak over every segment of the source loop; a window can only be at or below it.
  const peak = Math.max(
    ...r.segments.map((s, i) => ((bodies[i] as Buffer).length * 8 * r.timescale) / s.duration),
  );
  const bandwidthOk = scenario ? r.bandwidth >= Math.floor(peak) : r.bandwidth === Math.ceil(peak);
  record(
    label,
    `${tag}: declared bandwidth ${r.bandwidth} ${scenario ? '>=' : '=='} measured peak ${Math.ceil(peak)} bit/s`,
    bandwidthOk,
    '',
  );
}

async function verifyDash(
  id: StreamId,
  store: MediaStore,
  url: string,
  scenario: Scenario | undefined,
  scratch: string,
  port: number,
): Promise<void> {
  const spec = streamSpec(id) as StreamSpec;
  const info = store.index(id).info;
  const name = scenario ? `DASH live window ${scenario.firstNumber}..${scenario.lastNumber}` : 'DASH VOD';
  const text = (await get(url)).body.toString('utf8');
  let manifest: DashManifest;
  try {
    manifest = parseDash(text, url);
  } catch (e) {
    record(id, `${name}: the MPD is valid for a DASH client`, false, (e as Error).message);
    return;
  }
  record(
    id,
    `${name}: the MPD parses strictly (well-formed XML, mandatory attributes, schema order)`,
    true,
    `${manifest.representations.length} representations`,
  );
  const label = `${id}`;
  const expectedProfile =
    info.packaging === 'webm' ? 'urn:mpeg:dash:profile:full:2011' : 'urn:mpeg:dash:profile:isoff-live:2011';
  record(
    label,
    `${name}: type ${scenario ? 'dynamic' : 'static'}, profile ${expectedProfile}`,
    manifest.type === (scenario ? 'dynamic' : 'static') && manifest.profiles === expectedProfile,
    `${manifest.type} ${manifest.profiles}`,
  );
  if (scenario) {
    const p = liveParams(scenario);
    record(
      label,
      `${name}: live timing attributes`,
      manifest.availabilityStartTime?.getTime() === AST.getTime() &&
        manifest.publishTime?.getTime() === p.publishTime.getTime() &&
        manifest.timeShiftBufferDepth === 30 &&
        manifest.minimumUpdatePeriod === 2 &&
        manifest.suggestedPresentationDelay === 6,
      '',
    );
    const windows = manifest.representations.map(
      (r) => `${r.segments[0]?.number}..${r.segments[r.segments.length - 1]?.number}`,
    );
    record(
      label,
      `${name}: every representation lists segments ${scenario.firstNumber}..${scenario.lastNumber}`,
      windows.every((w) => w === `${scenario.firstNumber}..${scenario.lastNumber}`),
      windows.join(' '),
    );
    const timing = manifest.utcTiming;
    const time = timing ? await get(timing.url) : undefined;
    record(
      label,
      `${name}: UTCTiming (${timing?.scheme}) resolves to ${timing?.url} and answers an ISO 8601 instant`,
      timing?.url === `http://127.0.0.1:${port}/api/time` &&
        time?.status === 200 &&
        !Number.isNaN(Date.parse(time.body.toString('utf8'))),
      '',
    );
  } else {
    record(
      label,
      `${name}: mediaPresentationDuration ${manifest.mediaPresentationDuration} s == ${info.durationSec} s`,
      Math.abs((manifest.mediaPresentationDuration ?? Number.NaN) - info.durationSec) < 0.001,
      '',
    );
  }
  for (const set of manifest.adaptationSets) {
    const aligned = set.representations.every(
      (r, i) =>
        r.segments.every(
          (s, k) =>
            s.start === set.representations[0]?.segments[k]?.start &&
            s.duration === set.representations[0]?.segments[k]?.duration,
        ) || i === 0,
    );
    record(
      label,
      `${name}: AdaptationSet ${set.id} (${set.contentType}) claims segmentAlignment=${set.segmentAlignment} and the timelines are ${aligned ? 'identical' : 'NOT identical'}`,
      set.segmentAlignment === aligned && set.startWithSAP === 1,
      '',
    );
  }
  for (const r of manifest.representations) await verifyDashRep(label, r, store, id, scenario, scratch, spec);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Check 4b: HLS and (when the build has the demuxer) DASH, through ffprobe / ffmpeg
// ------------------------------------------------------------------------------------------------------------------------------

const groupByStream = (packets: ProbePacket[]): Map<number, ProbePacket[]> => {
  const m = new Map<number, ProbePacket[]>();
  for (const p of packets) {
    const list = m.get(p.streamIndex) ?? [];
    list.push(p);
    m.set(p.streamIndex, list);
  }
  return m;
};

/** Per stream of a probed live window: timestamps monotonic and gapless (wrap or no wrap), starting where live segment `first` starts. */
function assertGapless(
  label: string,
  name: string,
  index: StreamIndex,
  streams: ProbeStream[],
  packets: ProbePacket[],
  first: number,
  frameRate: number,
): void {
  const grouped = groupByStream(packets);
  for (const st of streams) {
    const list = (grouped.get(st.index) ?? []).slice().sort((a, b) => a.dts - b.dts);
    const video = st.codec_type === 'video';
    const rep = index.reps.find((r) =>
      video
        ? r.rep.track === 'video' && r.rep.width === st.width && r.rep.height === st.height
        : r.rep.track === 'audio',
    );
    if (!rep || list.length < 2) {
      record(
        label,
        `${name}: stream #${st.index} (${st.codec_type}) delivered packets`,
        false,
        `${list.length} packets`,
      );
      continue;
    }
    const frameTicks = video ? rep.timescale / frameRate : 0;
    const mono = list.every((p, i) => i === 0 || p.pts > (list[i - 1] as ProbePacket).pts);
    const breaks = countBreaks(list, video, frameTicks);
    record(
      label,
      `${name}: ${rep.rep.id} timestamps are monotonic and gapless (${list.length} packets, pts ${list[0]?.pts}..${list[list.length - 1]?.pts})`,
      mono && breaks === 0,
      `${breaks} breaks`,
    );
    const expected = liveTiming(rep, first).start;
    record(
      label,
      `${name}: ${rep.rep.id} starts at live segment ${first} (${expected})`,
      list[0]?.pts === expected,
      `got ${list[0]?.pts}`,
    );
  }
}

async function verifyThroughFfmpeg(
  id: StreamId,
  store: MediaStore,
  kind: 'dash' | 'hls',
  url: string,
  scenario: Scenario | undefined,
): Promise<void> {
  const spec = streamSpec(id) as StreamSpec;
  const index = store.index(id);
  const info = index.info;
  const name = `${kind.toUpperCase()} ${scenario ? `live window ${scenario.firstNumber}..${scenario.lastNumber}` : 'VOD'} via ffmpeg's demuxer`;
  // `-live_start_index` is an option of the HLS demuxer only; the DASH demuxer starts a SegmentTimeline window at its first segment
  // when the window is shorter than 60 s, which both scenarios are.
  const input = scenario && kind === 'hls' ? ['-live_start_index', '0'] : [];
  try {
    const probed = await probeStreams(url, input);
    note(
      `${name}: ${probed.streams.map((s) => `#${s.index} ${s.codec_type}/${s.codec_name} ${s.width ? `${s.width}x${s.height}` : `${s.sample_rate} Hz x${s.channels}`}`).join(' | ')}`,
    );
    const video = probed.streams.filter((s) => s.codec_type === 'video');
    const audio = probed.streams.filter((s) => s.codec_type === 'audio');
    const wantSizes = info.reps.filter((r) => r.track === 'video').map((r) => `${r.width}x${r.height}`);
    const sizes = new Set(video.map((v) => `${v.width}x${v.height}`));
    record(
      id,
      `${name}: lists every video rung (${wantSizes.join(', ')})`,
      wantSizes.every((s) => sizes.has(s)),
      `saw ${[...sizes].join(', ') || 'none'}`,
    );
    const audioCodec = info.packaging === 'webm' ? 'opus' : 'aac';
    record(
      id,
      `${name}: codecs are vp9 + ${audioCodec}`,
      video.length > 0 &&
        video.every((v) => v.codec_name === 'vp9') &&
        audio.length > 0 &&
        audio.every((a) => a.codec_name === audioCodec),
      `video ${[...new Set(video.map((v) => v.codec_name))].join('/')}, audio ${[...new Set(audio.map((a) => a.codec_name))].join('/')}`,
    );
    if (scenario) {
      // Read real packets through the live manifest: ffprobe walks the window segment by segment over HTTP. The interval stops two
      // segments short of the end of the window (a live demuxer that reaches the end waits for a refresh that never comes) and still
      // covers every loop boundary of the window.
      const seconds = (scenario.lastNumber - scenario.firstNumber + 1) * SEGMENT_SEC - 2 * SEGMENT_SEC;
      const packets = await probePackets(url, [...input, '-read_intervals', `%+${seconds}`]);
      assertGapless(id, name, index, probed.streams, packets, scenario.firstNumber, spec.frameRate);
      const errors = await decodeErrors(url, [...input, '-t', String(seconds)]);
      record(
        id,
        `${name}: ${seconds} s of the window decode without error`,
        errors === '',
        errors.split('\n')[0] ?? '',
      );
    } else {
      if (probed.duration !== undefined) {
        // The presentation duration the demuxer derives from the manifest (audio may be up to a frame short of the video).
        record(
          id,
          `${name}: duration ${probed.duration.toFixed(3)} s == ${info.durationSec} s`,
          Math.abs(probed.duration - info.durationSec) < 0.05,
          '',
        );
      }
      const maps = kind === 'dash' ? ['-map', '0:v:1', '-map', '0:a:0'] : [];
      const errors = await decodeErrors(url, [], maps);
      record(
        id,
        `${name}: decodes end to end${maps.length ? ' (v360 + audio)' : ' (default variant)'}`,
        errors === '',
        errors.split('\n')[0] ?? '',
      );
    }
  } catch (e) {
    record(id, name, false, reason(e));
  }
}

async function verifyManifests(
  id: StreamId,
  store: MediaStore,
  port: number,
  scratch: string,
  dashDemuxer: boolean,
): Promise<void> {
  const info = store.index(id).info;
  const base = `http://127.0.0.1:${port}/s`;
  const sessions: Array<{ session: string; scenario?: Scenario }> =
    info.kind === 'live' ? SCENARIOS.map((s) => ({ session: s.session, scenario: s })) : [{ session: 'vod' }];
  for (const { session, scenario } of sessions) {
    const dashUrl = `${base}/${session}/${id}/dash/manifest.mpd`;
    try {
      await verifyDash(id, store, dashUrl, scenario, scratch, port);
    } catch (e) {
      record(id, `DASH ${session}`, false, reason(e));
    }
    if (dashDemuxer) await verifyThroughFfmpeg(id, store, 'dash', dashUrl, scenario);
    else
      skip(
        id,
        `DASH ${session} through ffmpeg's demuxer`,
        'this ffmpeg build has no DASH demuxer (it needs libxml2); the independent DASH client above covers it. Run verify in Docker for the real one',
      );
    if (info.protocols.includes('hls'))
      await verifyThroughFfmpeg(id, store, 'hls', `${base}/${session}/${id}/hls/master.m3u8`, scenario);
  }
}

// ------------------------------------------------------------------------------------------------------------------------------

function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      streams: { type: 'string' },
      'cache-dir': { type: 'string' },
      verbose: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      'skip-manifests': { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
    },
  });
  verbose.on = values.verbose;
  const cacheDir = resolve(values['cache-dir'] ?? defaultCacheDir());
  const ids = (
    values.streams ? values.streams.split(',').map((s) => s.trim()) : CATALOG.map((s) => s.id)
  ) as StreamId[];
  for (const id of ids)
    if (!(STREAM_IDS as readonly string[]).includes(id)) throw new Error(`unknown stream '${id}'`);

  if (values.serve) {
    // Debugging aid: only the layout server, until Ctrl-C. Point ffprobe, ffplay or a player at the printed URLs.
    const server = createLayoutServer(createMediaStore({ cacheDir }));
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}/s`;
    console.log(
      `layout server on ${origin}  (sessions: vod, ${SCENARIOS.map((s) => `${s.session} = live window ${s.firstNumber}..${s.lastNumber}`).join(', ')})`,
    );
    for (const id of ids)
      console.log(`  ${id}: ${origin}/vod/${id}/dash/manifest.mpd   ${origin}/vod/${id}/hls/master.m3u8`);
    await new Promise<void>((done) => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    await closeServer(server);
    return;
  }

  const scratch = join(dirname(cacheDir), 'tmp', `verify-${process.pid}-${randomBytes(3).toString('hex')}`);
  mkdirSync(scratch, { recursive: true });
  const dashDemuxer = await hasDemuxer('dash');
  console.log(
    `ffmpeg ${await ffmpegVersion()} (DASH demuxer: ${dashDemuxer ? 'yes' : 'NO'})  cache ${cacheDir}\n`,
  );

  const store = createMediaStore({ cacheDir });
  const rows = [['stream', 'reps', 'segments', 'bytes', 'duration', 'content hash', 'checks']];
  let server: Server | undefined;
  try {
    if (!values['skip-manifests']) server = createLayoutServer(store);
    const port = server ? await listen(server) : 0;
    for (const id of ids) {
      const before = checks.length;
      try {
        if (!store.has(id)) {
          record(id, 'stream is ready in the cache', false, 'generate it first: npm run generate:streams');
          rows.push([id, '-', '-', '-', '-', '-', 'FAILED']);
          continue;
        }
        const { bytes } = await verifyStreamFiles(id, cacheDir, scratch);
        if (server) await verifyManifests(id, store, port, scratch, dashDemuxer);
        const info = store.index(id).info;
        const mine = checks.slice(before);
        rows.push([
          id,
          String(info.reps.length),
          String(info.segmentCount),
          `${(bytes / 1024 / 1024).toFixed(2)} MB`,
          `${info.durationSec} s`,
          info.contentHash.slice(0, 12),
          `${mine.filter((c) => c.ok).length}/${mine.length}${mine.every((c) => c.ok) ? '' : ' FAILED'}`,
        ]);
      } catch (e) {
        record(id, 'verification aborted', false, reason(e));
        rows.push([id, '-', '-', '-', '-', '-', 'ABORTED']);
      }
    }
  } finally {
    if (server) await closeServer(server);
    if (!values.keep && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${table(rows)}`);
  if (evidence.length > 0 && !verbose.on)
    console.log(`\n(${evidence.length} raw ffprobe evidence lines: re-run with --verbose to print them)`);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
  );
  for (const s of skipped) console.log(`  skipped: ${s}`);
  if (failed.length > 0) {
    console.error(
      `\nFAILED:\n${failed.map((c) => `  ${c.stream}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}`,
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`verify:streams failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
