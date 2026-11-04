// `npm run smoke:service -- [--cache-dir DIR]`
//
// The service the way a user runs it, against the REAL streams: it spawns the CLI (`tools/serve.ts`, which is what `npm run serve` runs)
// on a free port with the real media store, and checks over HTTP, with the real clock, that what the service says is what the files are:
// manifests that reference URLs that exist, sizes and hashes that equal the stream index, the live loop on a monotonic timeline, faults
// that do what the contract says, a clean shutdown. Exit code 0 when every check passes, 1 otherwise. Needs `npm run generate:streams`
// first (or --cache-dir pointing at a cache that has them).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ServiceClient } from '../src/lab/service-client.ts';
import { createMediaStore } from '../src/server/media/index.ts';
import { CLEARKEY_SYSTEM_ID, keyIdUuid } from '../src/server/media/dash.ts';
import { readTfdts } from '../src/server/media/isobmff.ts';
import type { RepIndex } from '../src/server/media/types.ts';
import type { StreamId } from '../src/shared/streams.ts';
import { STREAM_IDS } from '../src/shared/streams.ts';
import { download, goodput } from '../tests/unit/support/delivery.ts';
import { parseDash } from './lib/dash-client.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const USAGE = `usage: npm run smoke:service -- [--cache-dir DIR]

  --cache-dir <dir>  the stream cache to serve (default: .cache/streams in the repository; npm run generate:streams fills it)`;

class Failed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failed(message);
}

function equal(actual: unknown, wanted: unknown, what: string): void {
  if (actual !== wanted) throw new Failed(`${what}: expected ${String(wanted)}, got ${String(actual)}`);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Failed(`missing ${what}`);
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Failed(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Reply {
  status: number;
  headers: Headers;
  body: Buffer;
  text: string;
}

async function http(url: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body, text: body.toString('utf8') };
}

// ------------------------------------------------------------------------------------------------------------------------------
// The service under test: the CLI, as a child process
// ------------------------------------------------------------------------------------------------------------------------------

interface Cli {
  child: ChildProcess;
  origin: string;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function startCli(cacheDir: string | undefined): Promise<Cli> {
  const env: NodeJS.ProcessEnv = { ...process.env, PB_PORT: '0', PB_HOST: '127.0.0.1' };
  delete env.PB_LOG;
  delete env.PB_ORIGIN;
  if (cacheDir) env.PB_CACHE_DIR = cacheDir;
  // The same program `npm run serve` runs (`tsx tools/serve.ts`), without npm in between so that a signal reaches it.
  const child = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), ['tools/serve.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let pending = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
      stdout.push(pending.slice(0, at));
      pending = pending.slice(at + 1);
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  let died = false;
  void exited.then(() => (died = true));
  await until(() => stdout.length > 0 || died, 60_000, 'the service to say where it listens');
  if (stdout.length === 0) throw new Failed(`the service exited before it listened:\n${stderr.join('')}`);
  const match = /^playback-proof service listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(stdout[0] ?? '');
  if (!match) throw new Failed(`unexpected first line of the service: ${JSON.stringify(stdout[0])}`);
  return { child, origin: match[1] as string, stdout, stderr, exited };
}

// ------------------------------------------------------------------------------------------------------------------------------
// A literal reader of HLS playlists (the lab's own consumer-side reading of the format)
// ------------------------------------------------------------------------------------------------------------------------------

interface HlsMedia {
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  map?: string;
  segments: Array<{ url: string; duration: number; programDateTime?: string }>;
}

function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.slice(line.indexOf(':') + 1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    out[m[1] as string] = (m[2] as string).replace(/^"|"$/g, '');
  return out;
}

function parseHlsMedia(text: string, playlistUrl: string): HlsMedia {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  expect(lines[0] === '#EXTM3U', 'a playlist starts with #EXTM3U');
  const out: HlsMedia = { targetDuration: 0, mediaSequence: 0, endList: false, segments: [] };
  let duration = 0;
  let pdt: string | undefined;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.mediaSequence = Number(line.split(':')[1]);
    else if (line === '#EXT-X-ENDLIST') out.endList = true;
    else if (line.startsWith('#EXT-X-MAP:'))
      out.map = new URL(must(attributes(line).URI, 'MAP URI'), playlistUrl).toString();
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))
      pdt = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice('#EXTINF:'.length).split(',')[0]);
    else if (!line.startsWith('#')) {
      out.segments.push({
        url: new URL(line, playlistUrl).toString(),
        duration,
        ...(pdt ? { programDateTime: pdt } : {}),
      });
      pdt = undefined;
    }
  }
  return out;
}

function parseHlsMaster(text: string, masterUrl: string): { variants: string[]; audio: string[] } {
  const lines = text.split('\n').map((line) => line.trim());
  expect(lines[0] === '#EXTM3U', 'a playlist starts with #EXTM3U');
  const variants: string[] = [];
  const audio: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('#EXT-X-STREAM-INF:'))
      variants.push(new URL(must(lines[i + 1], 'variant URI'), masterUrl).toString());
    if (line.startsWith('#EXT-X-MEDIA:') && attributes(line).TYPE === 'AUDIO')
      audio.push(new URL(must(attributes(line).URI, 'audio URI'), masterUrl).toString());
  });
  return { variants, audio };
}

// ------------------------------------------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const results: Result[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: performance.now() - started, detail });
  } catch (err) {
    const detail = err instanceof Failed ? err.message : `${(err as Error).name}: ${(err as Error).message}`;
    results.push({ name, ok: false, ms: performance.now() - started, detail });
  }
}

function table(): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map(
    (r) =>
      `${r.ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(width)}  ${`${Math.round(r.ms)} ms`.padStart(8)}  ${r.detail.split('\n')[0]}`,
  );
  const failed = results.filter((r) => !r.ok);
  const tail = failed.flatMap((r) => [``, `${r.name}:`, ...r.detail.split('\n').map((line) => `  ${line}`)]);
  return [...lines, '', `${results.length - failed.length} of ${results.length} checks passed`, ...tail].join(
    '\n',
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { 'cache-dir': { type: 'string' }, help: { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const cacheDir = values['cache-dir'];
  // The expected values come from the stream files, read by a store of this process: the service is checked against the files,
  // not against itself.
  const reference = createMediaStore(cacheDir ? { cacheDir } : {});
  const missing = STREAM_IDS.filter((id) => !reference.has(id));
  if (missing.length > 0) {
    for (const id of missing) console.error(`stream ${id} is missing: run npm run generate:streams`);
    return 1;
  }

  let cli = undefined as Cli | undefined;
  await check('cli: listens on a free port, says so in one line', async () => {
    cli = await startCli(cacheDir);
    return cli.stdout[0] ?? '';
  });
  if (!cli) {
    console.log(table());
    return 1;
  }
  const running: Cli = cli;
  const origin = running.origin;
  const port = Number(new URL(origin).port);
  const client = new ServiceClient(origin);

  // --- what the service says about itself ---------------------------------------------------------------------------------

  await check('health: every stream ready', async () => {
    const health = await client.waitUntilHealthy({ timeoutMs: 10_000, ready: [...STREAM_IDS] });
    for (const id of STREAM_IDS) equal(health.streams[id], 'ready', `stream ${id}`);
    equal(health.ffmpeg, reference.ffmpegVersion(), 'ffmpeg version');
    return `ffmpeg ${health.ffmpeg}, ${STREAM_IDS.length} streams ready, player ${health.player}`;
  });

  await check('catalog: /api/streams equals the files', async () => {
    const streams = await client.streams();
    equal(streams.length, STREAM_IDS.length, 'number of streams');
    for (const stream of streams) {
      const info = reference.index(stream.id).info;
      equal(stream.contentHash, info.contentHash, `${stream.id} content hash`);
      equal(stream.segmentCount, info.segmentCount, `${stream.id} segment count`);
    }
    const drm = must(streams.find((s) => s.id === 'vod-cmaf-clearkey')?.drm, 'the ClearKey test key');
    equal(drm.keyId.length + drm.key.length, 64, 'key and key id are 32 hex digits each');
    return `${streams.length} streams, content hashes equal the stream.json files`;
  });

  // --- VOD: every URL a manifest references exists, with the bytes of the files ----------------------------------------------

  async function expectSegment(url: string, real: RepIndex, k: number, mimeType: string): Promise<number> {
    const wanted = must(real.segments[k], `segment ${k + 1} of ${real.rep.id}`);
    const res = await http(url);
    equal(res.status, 200, `GET ${url}`);
    equal(res.headers.get('content-type'), mimeType, `content type of ${url}`);
    equal(res.headers.get('content-length'), String(wanted.bytes), `content length of ${url}`);
    equal(res.body.length, wanted.bytes, `bytes of ${url}`);
    equal(sha256(res.body), wanted.sha256, `sha256 of ${url}`);
    return res.body.length;
  }

  async function expectInit(url: string, id: StreamId, repId: string, mimeType: string): Promise<void> {
    const res = await http(url);
    equal(res.status, 200, `GET ${url}`);
    equal(res.headers.get('content-type'), mimeType, `content type of ${url}`);
    expect(res.body.equals(reference.init(id, repId)), `the init segment of ${repId} is not the file`);
  }

  async function vodDash(id: StreamId): Promise<string> {
    const index = reference.index(id);
    const session = await client.createSession({ stream: id, protocol: 'dash', label: `smoke ${id}` });
    const url = client.url(session.manifestUrl);
    const res = await http(url);
    equal(res.status, 200, 'the manifest');
    equal(res.headers.get('content-type'), 'application/dash+xml', 'content type of the manifest');
    const mpd = parseDash(res.text, url);
    equal(mpd.type, 'static', 'MPD type');
    expect(
      Math.abs(must(mpd.mediaPresentationDuration, 'duration') - index.info.durationSec) < 0.1,
      'presentation duration',
    );
    equal(mpd.representations.length, index.reps.length, 'number of representations');
    let bytes = 0;
    for (const rep of mpd.representations) {
      const real = must(
        index.reps.find((r) => r.rep.id === rep.id),
        `representation ${rep.id}`,
      );
      equal(rep.segments.length, real.segments.length, `${rep.id} segment count`);
      rep.segments.forEach((s, k) => {
        equal(s.start, real.segments[k]?.start, `${rep.id} start of segment ${k + 1}`);
        equal(s.duration, real.segments[k]?.duration, `${rep.id} duration of segment ${k + 1}`);
      });
      await expectInit(rep.initUrl, id, rep.id, real.rep.mimeType);
      for (const k of [0, rep.segments.length - 1])
        bytes += await expectSegment(must(rep.segments[k], 'segment').url, real, k, real.rep.mimeType);
    }
    return `${index.reps.length} reps: init, segment 1 and segment ${index.info.segmentCount} of each, ${bytes} bytes; timeline, sizes and sha256 equal the index`;
  }

  async function vodHls(id: StreamId): Promise<string> {
    const index = reference.index(id);
    const session = await client.createSession({ stream: id, protocol: 'hls', label: `smoke ${id} hls` });
    const url = client.url(session.manifestUrl);
    const res = await http(url);
    equal(res.status, 200, 'the master playlist');
    equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl', 'content type of the playlist');
    const master = parseHlsMaster(res.text, url);
    const playlists = [...master.variants, ...master.audio];
    equal(playlists.length, index.reps.length, 'number of media playlists');
    let bytes = 0;
    for (const playlistUrl of playlists) {
      const repId = must(/\/([^/]+)\.m3u8$/.exec(playlistUrl)?.[1], 'representation of the playlist');
      const real = must(
        index.reps.find((r) => r.rep.id === repId),
        `representation ${repId}`,
      );
      const playlist = await http(playlistUrl);
      equal(playlist.status, 200, `GET ${playlistUrl}`);
      const media = parseHlsMedia(playlist.text, playlistUrl);
      expect(media.endList, `${repId}: a VOD playlist ends with #EXT-X-ENDLIST`);
      equal(media.segments.length, real.segments.length, `${repId} segment count`);
      media.segments.forEach((s, k) => {
        const real_segment = must(real.segments[k], 'segment');
        expect(
          Math.abs(s.duration - real_segment.duration / real.timescale) < 1e-5,
          `${repId} EXTINF of segment ${k + 1}`,
        );
      });
      await expectInit(must(media.map, 'EXT-X-MAP'), id, repId, real.rep.mimeType);
      for (const k of [0, media.segments.length - 1])
        bytes += await expectSegment(must(media.segments[k], 'segment').url, real, k, real.rep.mimeType);
    }
    return `master + ${playlists.length} playlists, init, first and last segment of each: ${bytes} bytes, sizes and sha256 equal the index`;
  }

  await check('vod-cmaf over DASH: manifest, init, first and last segment', () => vodDash('vod-cmaf'));
  await check('vod-cmaf over HLS: master, playlists, init, first and last segment', () => vodHls('vod-cmaf'));
  await check('vod-webm over DASH (and 404 over HLS)', async () => {
    const detail = await vodDash('vod-webm');
    const session = await client.createSession({ stream: 'vod-webm' });
    const hls = await http(client.url(session.manifestUrl.replace('dash/manifest.mpd', 'hls/master.m3u8')));
    equal(hls.status, 404, 'HLS for a DASH-only stream');
    return `${detail}; HLS is 404`;
  });

  // --- live ---------------------------------------------------------------------------------------------------------------

  /** A live session at a moment that is not about to publish a segment: the checks below take a few ms, the edge must not move. */
  async function steadyLive(options: {
    stream: 'live-cmaf';
    protocol: 'dash' | 'hls';
    startOffsetSec?: number;
  }) {
    const created = await client.createSession({
      stream: options.stream,
      protocol: options.protocol,
      ...(options.startOffsetSec === undefined ? {} : { live: { startOffsetSec: options.startOffsetSec } }),
    });
    for (;;) {
      const detail = await client.detail(created.id);
      const live = must(detail.live, 'the live clock');
      const astMs = Date.parse(live.availabilityStartTime);
      const into = (Date.now() - astMs) % 2000;
      if (into < 1200) return { created, info: detail, live, astMs };
      await sleep(2000 - into + 100);
    }
  }

  const liveIndex = reference.index('live-cmaf');
  const liveSource = (n: number, count: number): number => ((n - 1) % count) + 1;

  await check('live-cmaf over DASH: window of 15, edge, 404 beyond, publishTime, UTCTiming', async () => {
    const { created, live, astMs } = await steadyLive({ stream: 'live-cmaf', protocol: 'dash' });
    equal(created.live?.edgeNumber, 15, 'edgeNumber at creation');
    equal(created.live?.windowSegments, 15, 'windowSegments');
    const edge = live.edgeNumber;
    const url = client.url(created.manifestUrl);
    const res = await http(url);
    equal(res.status, 200, 'the manifest');
    const mpd = parseDash(res.text, url);
    equal(mpd.type, 'dynamic', 'MPD type');
    equal(mpd.availabilityStartTime?.getTime(), astMs, 'availabilityStartTime');
    equal(
      mpd.publishTime?.getTime(),
      astMs + edge * 2000,
      'publishTime is the publication instant of the edge segment',
    );
    equal(mpd.timeShiftBufferDepth, 30, 'timeShiftBufferDepth');
    equal(mpd.suggestedPresentationDelay, 6, 'suggestedPresentationDelay');
    equal(mpd.minimumUpdatePeriod, 2, 'minimumUpdatePeriod');
    equal(mpd.utcTiming?.scheme, 'urn:mpeg:dash:utc:http-iso:2014', 'UTCTiming scheme');
    const timing = await http(must(mpd.utcTiming?.url, 'UTCTiming url'));
    equal(timing.status, 200, 'GET the UTCTiming url');
    expect(Math.abs(Date.parse(timing.text) - Date.now()) < 2000, `/api/time says ${timing.text}`);
    for (const rep of mpd.representations) {
      const real = must(
        liveIndex.reps.find((r) => r.rep.id === rep.id),
        `representation ${rep.id}`,
      );
      equal(rep.segments.length, 15, `${rep.id} segments listed`);
      equal(rep.segments[0]?.number, Math.max(1, edge - 14), `${rep.id} first listed`);
      const last = must(rep.segments.at(-1), 'last segment');
      equal(last.number, edge, `${rep.id} last listed`);
      const atEdge = await http(last.url);
      equal(atEdge.status, 200, `${rep.id} segment ${edge}`);
      equal(
        atEdge.body.length,
        real.segments[liveSource(edge, real.segments.length) - 1]?.bytes,
        `${rep.id} bytes of segment ${edge}`,
      );
      equal(
        readTfdts(atEdge.body)[0],
        last.start,
        `${rep.id} tfdt of segment ${edge} equals the manifest timeline`,
      );
    }
    const beyond = await http(`${origin}/s/${created.id}/live-cmaf/seg/v360/${edge + 1}.m4s`);
    equal(beyond.status, 404, `segment ${edge + 1}, beyond the edge`);
    return `edge ${edge}, window ${edge - 14}..${edge}, ${edge} served, ${edge + 1} is 404, publishTime ${new Date(astMs + edge * 2000).toISOString()}`;
  });

  await check('live-cmaf over HLS: sliding playlist, program date time, 404 beyond', async () => {
    const { created, live, astMs } = await steadyLive({ stream: 'live-cmaf', protocol: 'hls' });
    const edge = live.edgeNumber;
    const masterUrl = client.url(created.manifestUrl);
    const master = parseHlsMaster((await http(masterUrl)).text, masterUrl);
    equal(master.variants.length + master.audio.length, 4, 'media playlists');
    for (const playlistUrl of [...master.variants, ...master.audio]) {
      const repId = must(/\/([^/]+)\.m3u8$/.exec(playlistUrl)?.[1], 'representation');
      const real = must(
        liveIndex.reps.find((r) => r.rep.id === repId),
        `representation ${repId}`,
      );
      const media = parseHlsMedia((await http(playlistUrl)).text, playlistUrl);
      expect(!media.endList, `${repId}: a live playlist has no #EXT-X-ENDLIST`);
      equal(media.mediaSequence, Math.max(1, edge - 14), `${repId} media sequence`);
      equal(media.segments.length, 15, `${repId} segments listed`);
      expect(
        media.segments.every((s) => s.programDateTime !== undefined),
        `${repId}: every segment has a program date time`,
      );
      expect(
        Date.parse(must(media.segments[0]?.programDateTime, 'pdt')) >= astMs,
        `${repId} program date time`,
      );
      const last = must(media.segments.at(-1), 'last segment');
      const atEdge = await http(last.url);
      equal(atEdge.status, 200, `${repId} segment ${edge}`);
      equal(
        atEdge.body.length,
        real.segments[liveSource(edge, real.segments.length) - 1]?.bytes,
        `${repId} bytes`,
      );
      const beyond = await http(last.url.replace(/\/\d+\.m4s$/, `/${edge + 1}.m4s`));
      equal(beyond.status, 404, `${repId} segment ${edge + 1}`);
    }
    return `4 playlists, media sequence ${Math.max(1, edge - 14)}, ${edge} served and ${edge + 1} is 404 for every rep`;
  });

  await check(
    'live loop: segment 13 = segment 1 + loopTicks, segment 25 = + 2 loops (every rep)',
    async () => {
      const count = liveIndex.info.segmentCount;
      equal(count, 12, 'segments in the source loop');
      // offset 60 s: edge 30, window 16..30, so loop 2 (segments 25..) is there; the default session covers loop 1 with segment 1 beside it
      const { created } = await steadyLive({ stream: 'live-cmaf', protocol: 'dash' });
      const { created: later } = await steadyLive({
        stream: 'live-cmaf',
        protocol: 'dash',
        startOffsetSec: 60,
      });
      const lines: string[] = [];
      for (const real of liveIndex.reps) {
        const id = real.rep.id;
        const first = await http(`${origin}/s/${created.id}/live-cmaf/seg/${id}/1.m4s`);
        equal(first.status, 200, `${id} segment 1`);
        const loop1 = await http(`${origin}/s/${created.id}/live-cmaf/seg/${id}/${count + 1}.m4s`);
        equal(loop1.status, 200, `${id} segment ${count + 1}`);
        const source = must(readTfdts(first.body)[0], 'tfdt');
        equal(source, real.segments[0]?.start, `${id} tfdt of segment 1`);
        equal(readTfdts(loop1.body)[0], source + real.loopTicks, `${id} tfdt of segment ${count + 1}`);
        const loop2 = await http(`${origin}/s/${later.id}/live-cmaf/seg/${id}/${2 * count + 1}.m4s`);
        equal(loop2.status, 200, `${id} segment ${2 * count + 1}`);
        equal(
          readTfdts(loop2.body)[0],
          source + 2 * real.loopTicks,
          `${id} tfdt of segment ${2 * count + 1}`,
        );
        equal(loop2.body.length, real.segments[0]?.bytes, `${id} bytes of segment ${2 * count + 1}`);
        lines.push(`${id} +${real.loopTicks}`);
      }
      return `tfdt(n + ${count}) = tfdt(n) + loopTicks on all 4 reps (${lines.join(', ')})`;
    },
  );

  // --- faults on real segments ---------------------------------------------------------------------------------------------

  await check('status fault on a real segment: 503, empty body, only where it matches', async () => {
    const real = must(
      reference.index('vod-cmaf').reps.find((r) => r.rep.id === 'v360'),
      'v360',
    );
    const session = await client.createSession({
      stream: 'vod-cmaf',
      faults: [{ type: 'status', status: 503, match: { kind: 'segment', rep: 'v360', number: 2 } }],
    });
    const seg = (rep: string, n: number): string => `${origin}/s/${session.id}/vod-cmaf/seg/${rep}/${n}.m4s`;
    const failed = await http(seg('v360', 2));
    equal(failed.status, 503, 'segment 2 of v360');
    equal(failed.body.length, 0, 'the body of a status answer');
    const fine = await http(seg('v360', 1));
    equal(fine.status, 200, 'segment 1 of v360');
    equal(fine.body.length, real.segments[0]?.bytes, 'bytes of segment 1');
    equal((await http(seg('a-aac', 2))).status, 200, 'segment 2 of a-aac');
    const log = await client.waitForLog(
      session.id,
      (entries) => entries.length === 3 && entries.every((e) => !e.pending),
    );
    equal(
      JSON.stringify(log.map((e) => [e.status, e.faults])),
      JSON.stringify([
        [503, ['f1']],
        [200, []],
        [200, []],
      ]),
      'the log',
    );
    equal((await client.detail(session.id)).counters.errors, 1, 'errors counted');
    return 'v360/2 -> 503 (fault f1 in the log), v360/1 and a-aac/2 -> 200';
  });

  await check('throttle fault on a real segment: goodput within +-10 % of the rate', async () => {
    const real = must(
      reference.index('vod-cmaf').reps.find((r) => r.rep.id === 'v720'),
      'v720',
    );
    const kbps = 2400;
    const session = await client.createSession({
      stream: 'vod-cmaf',
      faults: [{ type: 'throttle', kbps, match: { kind: 'segment', rep: 'v720' } }],
    });
    const path = (n: number): string => `/s/${session.id}/vod-cmaf/seg/v720/${n}.m4s`;
    const one = await download(port, path(1), { keepBody: true });
    equal(one.bytes, real.segments[0]?.bytes, 'bytes of v720 segment 1');
    equal(sha256(must(one.body, 'body')), real.segments[0]?.sha256, 'sha256 of the throttled body');
    const single = goodput(one.chunks);
    expect(
      single.steadyKbps > kbps * 0.9 && single.steadyKbps < kbps * 1.1,
      `one segment: ${single.steadyKbps.toFixed(0)} kbps at ${kbps}`,
    );
    // two segments at once share the link (audio and video compete): together they carry more than 500 kB at the configured rate
    const pair = await Promise.all([download(port, path(2)), download(port, path(3))]);
    const total = pair.reduce((n, d) => n + d.bytes, 0);
    const finished = Math.max(...pair.map((d) => d.chunks.at(-1)?.t ?? 0));
    const begun = Math.min(...pair.map((d) => d.chunks[0]?.t ?? Infinity));
    // as in `goodput`: what the first read carried (the burst allowance that goes out at once) is not part of the rate
    const shared = ((total - Math.max(...pair.map((d) => d.chunks[0]?.bytes ?? 0))) * 8) / (finished - begun);
    expect(total > 500_000, `two segments carry ${total} bytes`);
    expect(shared > kbps * 0.9 && shared < kbps * 1.1, `two at once: ${shared.toFixed(0)} kbps at ${kbps}`);
    return `${single.steadyKbps.toFixed(0)} kbps for one ${one.bytes} B segment, ${shared.toFixed(0)} kbps shared by two (${total} B), rate ${kbps}`;
  });

  await check(
    'live-stall through the real manifest: frozen, 404 beyond, then catch-up with the timeline unchanged',
    async () => {
      const created = await client.createSession({ stream: 'live-cmaf', protocol: 'dash' });
      const astMs = Date.parse(must(created.live, 'live').availabilityStartTime);
      const stallMs = 6000;
      await client.addFaults(created.id, [{ type: 'live-stall', atNumber: 16, ms: stallMs }]);
      const start = astMs + 16 * 2000;
      const end = start + stallMs;
      const manifestUrl = client.url(created.manifestUrl);
      const last = async (): Promise<{ last: number; publish: number }> => {
        const mpd = parseDash((await http(manifestUrl)).text, manifestUrl);
        const rep = must(mpd.representations[0], 'representation');
        return {
          last: must(rep.segments.at(-1), 'segment').number,
          publish: must(mpd.publishTime, 'publishTime').getTime(),
        };
      };
      await until(() => Date.now() >= start + 300, 10_000, 'the stall to start');
      const frozen = await last();
      equal(frozen.last, 16, 'the edge when the stall started');
      equal(frozen.publish, astMs + 16 * 2000, 'publishTime when the stall started');
      await until(() => Date.now() >= start + 3000, 10_000, 'the middle of the stall');
      const middle = await last();
      equal(middle.last, 16, 'the edge in the middle of the stall (a healthy origin would be at 17)');
      equal(middle.publish, frozen.publish, 'publishTime stays frozen');
      equal(
        (await http(`${origin}/s/${created.id}/live-cmaf/seg/v360/17.m4s`)).status,
        404,
        'segment 17 during the stall',
      );
      const stalledNow = await client.detail(created.id);
      equal(stalledNow.live?.stalled, true, 'stalled in the session detail');
      equal(stalledNow.live?.edgeNumber, 16, 'edgeNumber in the session detail');
      await until(() => Date.now() >= end + 300, 20_000, 'the end of the stall');
      const caught = await last();
      const expectedEdge = Math.floor((Date.now() - astMs) / 2000);
      expect(
        caught.last >= 19 && caught.last <= expectedEdge,
        `edge after catch-up: ${caught.last}, free-running edge ${expectedEdge}`,
      );
      const late = await http(`${origin}/s/${created.id}/live-cmaf/seg/v360/17.m4s`);
      equal(late.status, 200, 'segment 17 after the stall');
      expect(
        late.body.equals(reference.liveSegment('live-cmaf', 'v360', 17)),
        'segment 17 is what an origin that never stalled serves',
      );
      equal((await client.detail(created.id)).live?.stalled, false, 'stalled after the stall');
      return `edge frozen at 16 for ${stallMs} ms (publishTime unchanged, 17 is 404), then jumped to ${caught.last}; segment 17 equals the unstalled bytes`;
    },
  );

  await check(
    'vod-cmaf-clearkey: DASH manifest with ContentProtection, no key in it, DASH only',
    async () => {
      const id: StreamId = 'vod-cmaf-clearkey';
      const drm = must((await client.streams()).find((s) => s.id === id)?.drm, 'drm');
      const session = await client.createSession({ stream: id });
      const url = client.url(session.manifestUrl);
      const res = await http(url);
      equal(res.status, 200, 'the manifest');
      expect(!res.text.includes(drm.key), 'the key must never be in the manifest');
      const mpd = parseDash(res.text, url);
      for (const set of mpd.adaptationSets) {
        const schemes = set.contentProtection.map((cp) => cp.schemeIdUri);
        expect(schemes.includes('urn:mpeg:dash:mp4protection:2011'), `${set.contentType}: mp4protection`);
        expect(schemes.includes(CLEARKEY_SYSTEM_ID), `${set.contentType}: the ClearKey system id`);
        equal(
          set.contentProtection.find((cp) => cp.defaultKid)?.defaultKid,
          keyIdUuid(drm.keyId),
          `${set.contentType} default_KID`,
        );
      }
      const index = reference.index(id);
      for (const rep of mpd.representations) {
        const real = must(
          index.reps.find((r) => r.rep.id === rep.id),
          'rep',
        );
        await expectInit(rep.initUrl, id, rep.id, real.rep.mimeType);
        await expectSegment(must(rep.segments[0], 'segment').url, real, 0, real.rep.mimeType);
      }
      equal(
        (await http(client.url(session.manifestUrl.replace('dash/manifest.mpd', 'hls/master.m3u8')))).status,
        404,
        'HLS for the encrypted stream',
      );
      return `ContentProtection (cenc + ClearKey), key id ${drm.keyId.slice(0, 8)}..., key absent, init and segment 1 equal the files, HLS 404`;
    },
  );

  await check('http: CORS preflight, HEAD, and the headers of every answer', async () => {
    const session = await client.createSession({ stream: 'vod-cmaf-short' });
    const path = `/s/${session.id}/vod-cmaf-short/seg/v360/1.m4s`;
    const pre = await http(`${origin}${path}`, { method: 'OPTIONS' });
    equal(pre.status, 204, 'OPTIONS');
    equal(
      pre.headers.get('access-control-allow-methods'),
      'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Allow-Methods',
    );
    const get = await http(`${origin}${path}`);
    const head = await http(`${origin}${path}`, { method: 'HEAD' });
    equal(head.status, 200, 'HEAD');
    equal(head.body.length, 0, 'HEAD body');
    equal(head.headers.get('content-length'), String(get.body.length), 'HEAD Content-Length');
    for (const reply of [get, head, pre, await http(`${origin}/nope`)]) {
      equal(reply.headers.get('cache-control'), 'no-store', 'Cache-Control');
      equal(reply.headers.get('access-control-allow-origin'), '*', 'Access-Control-Allow-Origin');
    }
    return 'OPTIONS 204 with the preflight headers, HEAD = GET without a body, no-store and CORS on every answer';
  });

  await check('cli: SIGTERM closes cleanly, exit 0, one line on stdout, nothing on stderr', async () => {
    running.child.kill('SIGTERM');
    const timer = setTimeout(() => running.child.kill('SIGKILL'), 15_000);
    const { code, signal } = await running.exited;
    clearTimeout(timer);
    equal(code, 0, `exit code (signal ${signal})`);
    equal(running.stdout.length, 1, 'lines on stdout');
    equal(running.stderr.join(''), '', 'stderr');
    return 'exit code 0 after SIGTERM';
  });

  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL');
  console.log(table());
  return results.every((r) => r.ok) ? 0 : 1;
}

process.exitCode = await main();
