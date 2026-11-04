// `npm run player:smoke -- [options]`   (npx tsx tools/player-smoke.ts --help)
//
// Plays real sessions in real browsers through the player page and window.__qa, and prints what the hook measured. It uses a
// running service (--origin) or starts one (tools/serve.ts on PB_PORT, 4640 when unset) and stops it when it is done.
// Every session runs in its own browser process. Everything is waited for on player events (qa.waitFor,
// qa.waitForMediaTime) or on the service's request log; the only timers are the safety nets of the waits.
//
// Sessions: vod-dash, vod-hls, live-dash, live-hls (play a few media seconds and check what the hook reports), `actions`
// (pause and resume, a seek inside the buffer and one outside it, pin a rung, frame rate) and `recovery` (a segment that
// answers 404 once). Exit code 1 when any session fails; a session skipped as a documented gap does not fail the run.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserType, Page } from '@playwright/test';
import { SMOKE_USAGE, SmokeUsageError, parseSmokeArgs } from '../src/lab/smoke/args.ts';
import type { SmokeOptions, SmokeSession } from '../src/lab/smoke/args.ts';
import {
  failedChecks,
  judgeBasic,
  mediaTargetSec,
  renderTable,
  summarize,
  summarizeFailures,
  summarizeMetrics,
} from '../src/lab/smoke/judge.ts';
import type { Check, SessionResult, SmokeStage } from '../src/lab/smoke/judge.ts';
import { describeEvidence } from '../src/lab/smoke/stats.ts';
import { capabilitiesFromEngine, explainNoStream, pickStream } from '../src/lab/probe/capabilities.ts';
import type { Capabilities } from '../src/lab/probe/capabilities.ts';
import type { EngineName } from '../src/lab/probe/cli-args.ts';
import type { StreamKind } from '../src/lab/probe/formats.ts';
import { collectHostInfo } from '../src/lab/probe/host-info.ts';
import { parseResultFile } from '../src/lab/probe/report.ts';
import { normalizeError, redactPaths, stripAnsi } from '../src/lab/probe/results.ts';
import { ServiceClient } from '../src/lab/service-client.ts';
import type { HealthInfo, SessionInfo } from '../src/shared/api.ts';
import { detectEnvId } from '../src/shared/env.ts';
import { profile } from '../src/shared/profiles.ts';
import type { QAEvent, QAMetrics } from '../src/shared/qa.ts';
import type { Protocol, StreamId, StreamInfo } from '../src/shared/streams.ts';
import { playerUrl } from '../src/shared/urls.ts';
import { buildPlayer, PLAYER_DIST } from './build-player.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RESULT_SCHEMA_VERSION = 1;
const DEFAULT_PORT = 4640;

// -------------------------------------------------------------------------------------------------------- the service

interface RunningService {
  origin: string;
  health: HealthInfo;
  stop(): Promise<void>;
}

async function fetchHealth(origin: string): Promise<HealthInfo | null> {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? ((await response.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}

/** Polls /health until the service answers, or the process that should serve it has died, or the safety net runs out. */
async function waitForHealth(
  origin: string,
  child: ChildProcess | null,
  stderr: string[],
  limitMs: number,
): Promise<HealthInfo> {
  const deadline = Date.now() + limitMs;
  let exited = child?.exitCode ?? null;
  child?.once('exit', (code) => {
    exited = code ?? -1;
  });
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `the service exited with code ${exited} before it answered:\n${stderr.join('').slice(-1500)}`,
      );
    }
    const health = await fetchHealth(origin);
    if (health) return health;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(
    `the service did not answer ${origin}/health within ${limitMs} ms:\n${stderr.join('').slice(-1500)}`,
  );
}

async function useOrStartService(options: SmokeOptions): Promise<RunningService> {
  if (options.origin) {
    const origin = options.origin.replace(/\/+$/, '');
    const health = await waitForHealth(origin, null, [], 5000);
    return { origin, health, stop: async () => {} };
  }
  const port = Number(process.env.PB_PORT ?? DEFAULT_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const already = await fetchHealth(origin);
  if (already) return { origin, health: already, stop: async () => {} };

  const stderr: string[] = [];
  // One node process (the tsx loader runs inside it), so that stopping the pid stops the service.
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tools', 'serve.ts')], {
    cwd: ROOT,
    env: { ...process.env, PB_PORT: String(port), PB_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const gone = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  try {
    return { origin, health: await waitForHealth(origin, child, stderr, 30_000), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------- streams

const SESSION_STREAM: Record<SmokeSession, { kind: StreamKind; protocol: Protocol }> = {
  'vod-dash': { kind: 'vod', protocol: 'dash' },
  'vod-hls': { kind: 'vod', protocol: 'hls' },
  'live-dash': { kind: 'live', protocol: 'dash' },
  'live-hls': { kind: 'live', protocol: 'hls' },
  actions: { kind: 'vod', protocol: 'dash' },
  recovery: { kind: 'vod', protocol: 'dash' },
};

/** The capabilities this environment's committed codec matrix records per engine, or null when it has none. */
function committedCapabilities(envId: string): Map<string, Capabilities> | null {
  const file = join(ROOT, 'docs', 'results', 'codec-matrix', `${envId}.json`);
  if (!existsSync(file)) return null;
  const parsed = parseResultFile(readFileSync(file, 'utf8'), file);
  return new Map(
    Object.entries(parsed.engines).map(([engine, result]) => [
      engine,
      capabilitiesFromEngine(engine, result),
    ]),
  );
}

type Choice = { stream: StreamId } | { skip: string };

function chooseStream(capabilities: Capabilities | undefined, engine: string, session: SmokeSession): Choice {
  const { kind, protocol } = SESSION_STREAM[session];
  if (!capabilities) return { stream: kind === 'live' ? 'live-cmaf' : 'vod-cmaf' };
  const stream = pickStream(capabilities, kind, protocol);
  if (stream) return { stream };
  return {
    skip: explainNoStream(capabilities, kind, protocol) ?? `no ${kind} stream over ${protocol} in ${engine}`,
  };
}

// -------------------------------------------------------------------------------------------------------- the waits

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

class Stage {
  current: SmokeStage = 'launch';
  set(stage: SmokeStage): void {
    this.current = stage;
  }
}

const HOME = homedir();
const TMP = tmpdir();
/** What goes into a result file: no user paths, no colour codes, no port numbers that make equal failures look different. */
const clean = (text: string): string => normalizeError(stripAnsi(redactPaths(text, HOME, TMP)));
const firstLines = (text: string, lines = 12): string =>
  clean(text).split('\n').slice(0, lines).join('\n').slice(0, 3000);

function excerptOf(events: readonly QAEvent[]): string[] {
  const origin = events[0]?.t ?? 0;
  return events.map((event) => {
    const detail = event.detail ? ` ${JSON.stringify(event.detail)}` : '';
    return `#${event.index} +${(event.t - origin).toFixed(0)} ms media ${event.mediaTime.toFixed(2)} ${event.name}${detail}`.slice(
      0,
      200,
    );
  });
}

// --------------------------------------------------------------------------------------------------- the scenarios

class Checks {
  readonly list: Check[] = [];
  add(name: string, ok: boolean, detail?: string): void {
    this.list.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  }
}

const eventsSince = (page: Page, cursor: number): Promise<QAEvent[]> =>
  page.evaluate((since) => window.__qa.events().filter((event) => event.index >= since), cursor);

/** Pause and resume, a seek inside the buffer and one outside it, a pinned rung, the frame rate: each with the events it must leave. */
async function actionsScenario(
  page: Page,
  stream: StreamInfo,
  mediaSeconds: number,
  timeoutMs: number,
): Promise<{ checks: Check[]; excerpt: string[] }> {
  const checks = new Checks();
  const excerpt: string[] = [];
  const waitMedia = (seconds: number): Promise<number> =>
    page.evaluate(
      ([s, ms]) => window.__qa.waitForMediaTime(s as number, { timeoutMs: ms as number }),
      [seconds, timeoutMs],
    );

  const first = await page.evaluate((ms) => window.__qa.waitFor('firstframe', { timeoutMs: ms }), timeoutMs);
  await waitMedia(mediaTargetSec(first.mediaTime, mediaSeconds));

  // 1. pause and resume
  let cursor = await page.evaluate(() => window.__qa.cursor());
  await page.evaluate(() => window.__qa.pause());
  const paused = await page.evaluate(() => window.__qa.metrics());
  checks.add(
    'pause: the element and the state say paused',
    paused.playback.paused && paused.state === 'paused',
    `state=${paused.state}`,
  );
  checks.add(
    'pause: a paused event is on the timeline',
    (await eventsSince(page, cursor)).some((event) => event.name === 'paused'),
  );
  cursor = await page.evaluate(() => window.__qa.cursor());
  await page.evaluate(() => window.__qa.play());
  await page.evaluate(
    ([since, ms]) => window.__qa.waitFor('playing', { since: since as number, timeoutMs: ms as number }),
    [cursor, timeoutMs],
  );
  await waitMedia(paused.playback.currentTime + 1);
  const resumed = await page.evaluate(() => window.__qa.metrics());
  checks.add(
    'resume: playing again, and a pause is not a rebuffer',
    resumed.state === 'playing' && resumed.rebuffer.count === 0,
    `state=${resumed.state} rebuffers=${resumed.rebuffer.count}`,
  );

  // 2. a seek inside the buffer (backwards: what was just played is buffered behind the playhead)
  cursor = await page.evaluate(() => window.__qa.cursor());
  await page.evaluate(() => window.__qa.seek(1));
  const near = await eventsSince(page, cursor);
  const nearNames = near.map((event) => event.name);
  checks.add(
    'seek in the buffer: seeking then seeked on the timeline',
    nearNames.indexOf('seeking') >= 0 && nearNames.indexOf('seeked') > nearNames.indexOf('seeking'),
    nearNames.join(' '),
  );
  await waitMedia(2.5);
  checks.add(
    'seek in the buffer: not counted as a rebuffer',
    (await page.evaluate(() => window.__qa.metrics())).rebuffer.count === 0,
  );
  excerpt.push('-- seek inside the buffer', ...excerptOf(near));

  // 3. a seek outside the buffer
  const far = Math.floor(stream.durationSec * 0.66);
  cursor = await page.evaluate(() => window.__qa.cursor());
  await page.evaluate((seconds) => window.__qa.seek(seconds), far);
  await waitMedia(far + 1);
  const farEvents = await eventsSince(page, cursor);
  const afterFar = await page.evaluate(() => window.__qa.metrics());
  checks.add(
    'seek outside the buffer: seeked, then playback continues from the target',
    afterFar.playback.currentTime >= far,
    `currentTime=${afterFar.playback.currentTime.toFixed(2)} target=${far}`,
  );
  checks.add(
    'seek outside the buffer: the buffering it causes is not counted as a rebuffer',
    afterFar.rebuffer.count === 0,
    `rebuffers=${afterFar.rebuffer.count}`,
  );
  excerpt.push('-- seek outside the buffer', ...excerptOf(farEvents));

  // 4. pin a rung, and give ABR back
  const current = afterFar.bitrate.current?.height ?? null;
  const heights = stream.reps.filter((rep) => rep.track === 'video').map((rep) => rep.height ?? 0);
  const pin = heights.find((height) => height !== current && height > 0);
  if (pin === undefined) {
    checks.add(
      'pin: the stream has a second rung to pin',
      false,
      `current ${String(current)}, rungs ${heights.join(', ')}`,
    );
  } else {
    cursor = await page.evaluate(() => window.__qa.cursor());
    await page.evaluate((height) => window.__qa.selectVariantByHeight(height), pin);
    const pinned = await page.evaluate(() => window.__qa.metrics());
    const changes = (await eventsSince(page, cursor)).filter((event) => event.name === 'variant-changed');
    checks.add(
      'pin: a manual variant-changed to that height is on the timeline',
      changes.some((event) => event.detail?.reason === 'manual' && event.detail?.height === pin),
      JSON.stringify(changes.map((event) => event.detail)),
    );
    checks.add(
      'pin: the active rung is the one asked for',
      pinned.bitrate.current?.height === pin,
      `current=${String(pinned.bitrate.current?.height)} asked=${pin}`,
    );
    checks.add(
      'pin: ABR is off and the switch is counted',
      pinned.bitrate.switches >= 1 &&
        JSON.stringify((await page.evaluate(() => window.__qa.info())).configured).includes(
          '"enabled":false',
        ),
    );
    await page.evaluate(() => window.__qa.selectVariantByHeight(null));
    checks.add(
      'pin: null gives ABR back',
      JSON.stringify((await page.evaluate(() => window.__qa.info())).configured).includes('"enabled":true'),
    );
    excerpt.push('-- pinning a rung', ...excerptOf(changes));
  }

  // 5. the frame rate over two media seconds
  const frames = await page.evaluate(
    (ms) => window.__qa.measureFrames(2, { stallTimeoutMs: ms }),
    Math.min(timeoutMs, 8000),
  );
  checks.add(
    'frames: presented frames were counted over the window',
    frames.presented !== null && frames.presented > 0,
    JSON.stringify(frames),
  );
  checks.add(
    'frames: the elapsed media time is the window asked for',
    frames.mediaSeconds >= 2 && frames.mediaSeconds < 2.5,
    `mediaSeconds=${frames.mediaSeconds.toFixed(3)}`,
  );
  checks.add(
    'frames: a plausible rate for 30 fps content',
    frames.fps !== null && frames.fps > 5 && frames.fps < 35,
    `fps=${String(frames.fps?.toFixed(1))}`,
  );
  excerpt.push(`-- measureFrames(2): ${JSON.stringify(frames)}`);
  return { checks: checks.list, excerpt };
}

/** A segment that answers 404 once: Shaka retries it, the player carries on, and both channels (the hook, the request log) tell the same story. */
async function recoveryScenario(
  page: Page,
  client: ServiceClient,
  session: SessionInfo,
  mediaSeconds: number,
  timeoutMs: number,
): Promise<{ checks: Check[]; excerpt: string[]; metrics: QAMetrics }> {
  const checks = new Checks();
  const first = await page.evaluate((ms) => window.__qa.waitFor('firstframe', { timeoutMs: ms }), timeoutMs);
  // Segment 3 covers 4 to 6 s: playing well past it proves that the player got over the 404.
  const target = mediaTargetSec(first.mediaTime, Math.max(8, mediaSeconds + 5));
  const reached = await page.evaluate(
    ([s, ms]) => window.__qa.waitForMediaTime(s as number, { timeoutMs: ms as number }),
    [target, timeoutMs],
  );
  const metrics = await page.evaluate(() => window.__qa.metrics());
  const log = await client.log(session.id);
  const video3 = log.filter(
    (entry) =>
      entry.kind === 'segment' && entry.number === 3 && entry.rep !== undefined && entry.rep.startsWith('v'),
  );
  const failed = video3.filter((entry) => entry.status === 404);
  checks.add(
    'the request log shows the faulted segment answered 404 once, with the rule that did it',
    failed.length === 1 && (failed[0]?.faults.length ?? 0) > 0,
    `video segment 3: ${video3.map((entry) => `${entry.rep}:${entry.status}`).join(' ')}`,
  );
  checks.add(
    'the same segment was requested again and served',
    failed[0] !== undefined && video3.some((entry) => entry.status === 200 && entry.seq > failed[0]!.seq),
    `statuses ${video3.map((entry) => entry.status).join(', ')}`,
  );
  checks.add(
    'playback continued past the fault',
    reached >= target,
    `reached ${reached.toFixed(2)} s, needed ${target} s`,
  );
  checks.add(
    'no critical error',
    metrics.errors.every((error) => error.severity !== 2),
    JSON.stringify(metrics.errors.map((error) => `${error.codeName ?? error.code}/${error.severity}`)),
  );
  checks.add(
    'at most one rebuffer (PB-REC-001)',
    metrics.rebuffer.count <= 1,
    `rebuffers=${metrics.rebuffer.count}, ${metrics.rebuffer.totalMs.toFixed(0)} ms`,
  );
  const events = await page.evaluate(() => window.__qa.events());
  return {
    checks: checks.list,
    excerpt: [
      `-- the request log, video segment 3: ${video3.map((entry) => `seq ${entry.seq} ${entry.rep} ${entry.status} faults=[${entry.faults.join(',')}] ttfb ${entry.ttfbMs} ms`).join(' | ')}`,
      `-- error events seen by the hook: ${metrics.errors.length === 0 ? 'none (Shaka retried below the application)' : metrics.errors.map((error) => `${error.codeName ?? error.code} severity ${error.severity}`).join(', ')}`,
      ...excerptOf(events.slice(-24)),
    ],
    metrics,
  };
}

// ---------------------------------------------------------------------------------------------------------- one run

/** What a browser build offers that the lab depends on, read once per engine from a page: the facts behind a result, not a verdict. */
interface BrowserFacts {
  /** `navigator.connection.downlink` in Mbit/s. Shaka replaces `abr.defaultBandwidthEstimate` with it where it exists. */
  downlinkMbps: number | null;
  requestVideoFrameCallback: boolean;
  getVideoPlaybackQuality: boolean;
  mediaSource: 'MediaSource' | 'ManagedMediaSource' | 'none';
  /** `canPlayType('application/vnd.apple.mpegurl')`: whether the engine would play HLS by itself (the lab's player does not let it). */
  hlsCanPlayType: string;
}

function readBrowserFacts(page: Page): Promise<BrowserFacts> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { connection?: { downlink?: number } };
    const win = window as Window & { MediaSource?: unknown; ManagedMediaSource?: unknown };
    return {
      downlinkMbps: nav.connection?.downlink ?? null,
      requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      getVideoPlaybackQuality: 'getVideoPlaybackQuality' in HTMLVideoElement.prototype,
      mediaSource: win.MediaSource ? 'MediaSource' : win.ManagedMediaSource ? 'ManagedMediaSource' : 'none',
      hlsCanPlayType: document.createElement('video').canPlayType('application/vnd.apple.mpegurl'),
    } as const;
  });
}

interface RunContext {
  options: SmokeOptions;
  service: RunningService;
  client: ServiceClient;
  catalog: Map<StreamId, StreamInfo>;
  capabilities: Map<string, Capabilities> | null;
  browserTypes: Record<EngineName, BrowserType>;
  engineVersions: Map<string, string>;
  userAgents: Map<string, string>;
  engineFacts: Map<string, BrowserFacts>;
}

async function runSession(
  context: RunContext,
  repeat: number,
  engine: EngineName,
  name: SmokeSession,
): Promise<SessionResult> {
  const { options, client } = context;
  const started = performance.now();
  const base: SessionResult = {
    repeat,
    engine,
    session: name,
    status: 'fail',
    stream: null,
    durationMs: 0,
    startupMs: null,
    mediaTime: null,
    rebuffers: null,
    decoded: null,
    dropped: null,
    presented: null,
    rungHeight: null,
    startRungHeight: null,
    switches: null,
    latencyMs: null,
    info: null,
    metrics: null,
    errors: [],
    checks: [],
    consoleErrors: [],
  };
  const finish = (result: SessionResult): SessionResult => ({
    ...result,
    durationMs: Math.round(performance.now() - started),
  });

  const choice = chooseStream(context.capabilities?.get(engine), engine, name);
  if ('skip' in choice) return finish({ ...base, status: 'skip', skipReason: clean(choice.skip) });
  const stream = choice.stream;
  const streamInfo = context.catalog.get(stream);
  if (!streamInfo)
    return finish({ ...base, stream, error: `the service's catalog has no stream ${stream}`, stage: 'load' });
  const { protocol, kind } = SESSION_STREAM[name];

  const stage = new Stage();
  let browser: Browser | null = null;
  let page: Page | null = null;
  let session: SessionInfo | null = null;
  const consoleErrors: string[] = [];
  let info: SessionResult['info'] = null;
  let metrics: QAMetrics | null = null;
  let mediaTime: number | null = null;
  let checks: Check[] = [];
  let excerpt: string[] | undefined;

  try {
    stage.set('launch');
    browser = await context.browserTypes[engine].launch();
    if (!context.engineVersions.has(engine)) context.engineVersions.set(engine, browser.version());
    const browserContext = await browser.newContext();
    page = await browserContext.newPage();
    // What the browser itself complains about (a blocked script, a refused request): the first thing to read when a page does not boot.
    const remember = (line: string): void => {
      if (consoleErrors.length < 40) consoleErrors.push(line);
    };
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning')
        remember(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => remember(`pageerror: ${error.message}`));

    session = await client.createSession({
      stream,
      protocol,
      label: `player-smoke ${engine} ${name} #${repeat}`,
      ttlSec: 300,
      ...(name === 'recovery' ? { faults: profile('transient-404') } : {}),
    });
    const url =
      context.service.origin +
      playerUrl({ manifest: session.manifestUrl, muted: options.muted, config: options.config });

    stage.set('navigate');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

    stage.set('boot');
    await page.waitForFunction(() => window.__qa !== undefined, undefined, { timeout: options.timeoutMs });
    await withTimeout(
      page.evaluate(() => window.__qa.ready),
      options.timeoutMs,
      'qa.ready',
    );
    info = await page.evaluate(() => window.__qa.info());
    context.userAgents.set(engine, info.userAgent);
    if (!context.engineFacts.has(engine)) context.engineFacts.set(engine, await readBrowserFacts(page));

    stage.set('load');
    await page.evaluate((ms) => window.__qa.waitFor('loaded', { timeoutMs: ms }), options.timeoutMs);

    stage.set('firstframe');
    const first = await page.evaluate(
      (ms) => window.__qa.waitFor('firstframe', { timeoutMs: ms }),
      options.timeoutMs,
    );

    stage.set('playback');
    const target = mediaTargetSec(first.mediaTime, options.mediaSeconds);
    mediaTime = await page.evaluate(
      ([seconds, ms]) => window.__qa.waitForMediaTime(seconds as number, { timeoutMs: ms as number }),
      [target, options.timeoutMs],
    );

    stage.set('checks');
    info = await page.evaluate(() => window.__qa.info());
    metrics = await page.evaluate(() => window.__qa.metrics());
    checks = judgeBasic({
      kind,
      mediaSeconds: options.mediaSeconds,
      firstFrameSeen: true,
      startMediaTime: first.mediaTime,
      reachedMediaTime: mediaTime,
      info,
      metrics,
    });

    if (name === 'actions') {
      stage.set('actions');
      const outcome = await actionsScenario(page, streamInfo, options.mediaSeconds, options.timeoutMs);
      checks.push(...outcome.checks);
      excerpt = outcome.excerpt;
      metrics = await page.evaluate(() => window.__qa.metrics());
    } else if (name === 'recovery') {
      stage.set('recovery');
      const outcome = await recoveryScenario(page, client, session, options.mediaSeconds, options.timeoutMs);
      checks = outcome.checks;
      excerpt = outcome.excerpt;
      metrics = outcome.metrics;
      // The page played to the end of the fault window with the same instrument: its own basic checks still apply, except
      // that a recoverable error event is allowed here (the scenario judges errors itself).
      checks.unshift(
        ...judgeBasic({
          kind,
          mediaSeconds: options.mediaSeconds,
          firstFrameSeen: true,
          startMediaTime: first.mediaTime,
          reachedMediaTime: mediaTime,
          info,
          metrics,
        }).filter((check) => check.name !== 'no error events'),
      );
    }

    const failures = failedChecks(checks);
    const verdict =
      failures.length === 0
        ? { status: 'pass' as const }
        : {
            status: 'fail' as const,
            stage: name === 'actions' || name === 'recovery' ? stage.current : ('checks' as const),
            error: failures
              .map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`)
              .join('; '),
          };
    return finish({
      ...base,
      ...verdict,
      stream,
      ...summarizeMetrics(metrics),
      mediaTime,
      info,
      metrics,
      errors: metrics?.errors ?? [],
      checks,
      consoleErrors: consoleErrors.map(clean),
      ...(excerpt ? { excerpt } : {}),
    });
  } catch (error) {
    // Whatever the page can still tell about itself goes into the result: the failing stage alone is rarely enough.
    if (page) {
      try {
        info =
          info ??
          (await withTimeout(
            page.evaluate(() => window.__qa.info()),
            3000,
            'qa.info()',
          ));
        metrics = await withTimeout(
          page.evaluate(() => window.__qa.metrics()),
          3000,
          'qa.metrics()',
        );
        const events = await withTimeout(
          page.evaluate(() => window.__qa.events()),
          3000,
          'qa.events()',
        );
        excerpt = excerptOf(events.slice(-20));
      } catch {
        // the page is gone (crashed or never booted)
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return finish({
      ...base,
      stage: stage.current,
      error: firstLines(message),
      stream,
      ...summarizeMetrics(metrics),
      mediaTime,
      info,
      metrics,
      errors: metrics?.errors ?? [],
      checks,
      consoleErrors: consoleErrors.map(clean),
      ...(excerpt ? { excerpt } : {}),
    });
  } finally {
    if (session) await client.deleteSession(session.id).catch(() => {});
    await browser?.close().catch(() => {});
  }
}

// -------------------------------------------------------------------------------------------------------------- main

interface SmokeResultFile {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  tool: 'player-smoke';
  envId: string;
  generatedAt: string;
  invokedVia: 'direct' | 'docker:pw';
  args: string[];
  dockerCpus?: number;
  host: ReturnType<typeof collectHostInfo>;
  service: { origin: string; health: HealthInfo };
  options: Omit<SmokeOptions, 'help' | 'out' | 'origin'>;
  capabilities: string;
  engines: Record<
    string,
    { browserVersion: string | null; userAgent: string | null; facts: BrowserFacts | null }
  >;
  summary: ReturnType<typeof summarize>;
  failures: ReturnType<typeof summarizeFailures>;
  results: SessionResult[];
}

async function main(argv: string[]): Promise<number> {
  let options: SmokeOptions;
  try {
    options = parseSmokeArgs(argv);
  } catch (error) {
    if (error instanceof SmokeUsageError) {
      console.error(`${error.message}\n\n${SMOKE_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(SMOKE_USAGE);
    return 0;
  }

  if (!existsSync(join(PLAYER_DIST, 'index.html'))) {
    console.error('dist/player is missing: building the player page');
    await buildPlayer();
  }
  // Imported here so that --help and the unit tests never load Playwright.
  const { chromium, firefox, webkit } = await import('@playwright/test');
  const envId = detectEnvId();
  const host = collectHostInfo(ROOT);

  const service = await useOrStartService(options);
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (service.health.player !== 'built')
      throw new Error(`the service at ${service.origin} has no player page: run npm run build:player`);
    const client = new ServiceClient(service.origin);
    const catalog = new Map((await client.catalog()).map((stream) => [stream.id, stream] as const));

    const capabilities = options.useCapabilities ? committedCapabilities(envId) : null;
    if (options.useCapabilities && !capabilities)
      console.error(`no committed codec matrix for ${envId}: playing the default streams`);

    const context: RunContext = {
      options,
      service,
      client,
      catalog,
      capabilities,
      browserTypes: { chromium, firefox, webkit },
      engineVersions: new Map(),
      userAgents: new Map(),
      engineFacts: new Map(),
    };

    const results: SessionResult[] = [];
    outer: for (let repeat = 1; repeat <= options.repeat; repeat++) {
      for (const engine of options.browsers) {
        for (const name of options.sessions) {
          if (interrupted) break outer;
          const result = await runSession(context, repeat, engine, name);
          results.push(result);
          const note =
            result.status === 'pass'
              ? ''
              : ` ${result.stage ?? ''} ${(result.error ?? result.skipReason ?? '').split('\n')[0]}`;
          console.error(
            `[${repeat}/${options.repeat}] ${engine} ${name}: ${result.status.toUpperCase()}${note}`,
          );
        }
      }
    }

    console.log(renderTable(results));
    const summary = summarize(results);
    const failures = summarizeFailures(results);
    if (options.repeat > 1) {
      console.log('');
      for (const row of summary) {
        if (row.runs > 0)
          console.log(`${row.engine} ${row.session}: ${describeEvidence(row.passes, row.runs)}`);
      }
    }
    if (failures.length > 0) {
      console.log('\nfailure signatures:');
      for (const group of failures) {
        console.log(`  ${group.count}x ${group.engine} ${group.session} ${group.signature}`);
      }
    }

    if (options.out) {
      const viaDocker = process.env.PB_DOCKER_PW === '1';
      const dockerCpus = Number(process.env.PB_DOCKER_CPUS);
      const { help: _help, out: _out, origin: _origin, ...recorded } = options;
      const file: SmokeResultFile = {
        schemaVersion: RESULT_SCHEMA_VERSION,
        tool: 'player-smoke',
        envId,
        generatedAt: new Date().toISOString(),
        invokedVia: viaDocker ? 'docker:pw' : 'direct',
        args: argv,
        ...(viaDocker && dockerCpus > 0 ? { dockerCpus } : {}),
        host,
        service: { origin: service.origin.replace(/:\d+$/, ':<port>'), health: service.health },
        options: recorded,
        capabilities: capabilities
          ? `docs/results/codec-matrix/${envId}.json`
          : 'defaults (vod-cmaf, live-cmaf)',
        engines: Object.fromEntries(
          options.browsers.map((engine) => [
            engine,
            {
              browserVersion: context.engineVersions.get(engine) ?? null,
              userAgent: context.userAgents.get(engine) ?? null,
              facts: context.engineFacts.get(engine) ?? null,
            },
          ]),
        ),
        summary,
        failures,
        results,
      };
      const out = resolve(options.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
      console.error(`wrote ${out}`);
    }
    return interrupted || results.some((result) => result.status === 'fail') ? 1 : 0;
  } finally {
    await service.stop();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  },
);
