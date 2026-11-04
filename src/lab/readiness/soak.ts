import { LIVE_LIMITS } from '../../shared/criteria.ts';
import type { PlayerEvidence } from './checks.ts';
import type { HarnessSample, RequestDigest, SoakReport, StreamRecord, BrowserInfo } from './report.ts';
import { limitsSnapshot } from './report.ts';
import type { HostInfo } from '../probe/host-info.ts';
import type { ShakaConfigPatch } from '../../player/configs.ts';
import { decimate } from './series.ts';
import { evaluateSoak } from './soak-evaluators.ts';
import type {
  Engine,
  FaultWindow,
  HeapSample,
  SoakEpisode,
  SoakError,
  SoakEvaluation,
  SoakInput,
  SoakSample,
} from './soak-evaluators.ts';
import type { Limits } from './verdict.ts';

// The soak harness (docs/decisions/readiness.md, ADR-155): one long live session, watched by an in-page sampler, with the memory of the page
// and of the harness itself read at a slower cadence, one injected outage (and, in a release soak, a stale manifest) that the evaluators
// know about, and the verdict at the end. The loop is written against `SoakDriver`, which the command line implements over Playwright and
// the unit tests implement over a virtual clock: a thirty-minute soak is exercised in milliseconds, including the end of it, the hung player
// and the crashed page.
//
// The harness's timers are allowed here (it is a harness, not a spec); what the player is watched with is not one of them.

export interface SoakStart {
  /** Epoch ms of the first frame of the load: the soak's clock starts here. */
  firstFrameMs: number;
  /** The conditions injected into the origin, on the epoch axis. */
  faults: FaultWindow[];
  player: PlayerEvidence | null;
  stream: StreamRecord;
}

export interface PageRead {
  samples: SoakSample[];
  /** Reads the page dropped because they were not collected in time. */
  lost: number;
  /** What went wrong inside the sampler. */
  problems: string[];
}

export interface PlayerSnapshot {
  episodes: SoakEpisode[];
  errors: SoakError[];
  frames: { decoded: number; dropped: number } | null;
  /** `QAState` right now. */
  state: string;
}

export interface SoakDriver {
  /** Whether the engine can force a collection and read its JS heap (Chromium). */
  readonly heapSupported: boolean;
  /** Epoch milliseconds, the harness's clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Creates the session (with its outages), opens the page, waits for the first frame. */
  start(): Promise<SoakStart>;
  /** Starts the sampler in the page. */
  startSampler(everyMs: number): Promise<void>;
  /** The reads the page took since the last call. Rejects when the page is gone. */
  drainSamples(): Promise<PageRead>;
  snapshot(): Promise<PlayerSnapshot>;
  /** Folds the requests the origin has seen since the last call into the digest. */
  drainLog(): Promise<void>;
  requestDigest(): { requests: RequestDigest; manifestArrivalsMs: number[] };
  readHeap(): Promise<HeapSample>;
  readHarness(): Promise<HarnessSample>;
  /** Errors and uncaught page errors the browser console said. */
  consoleProblems(): string[];
  /** Why the page is gone (it crashed or was closed), or null. */
  crashed(): string | null;
  /** Stops the sampler and releases the page and the session. */
  stop(): Promise<void>;
}

export interface SoakRunOptions {
  engine: Engine;
  minutes: number;
  warmupSec: number;
  sampleSec: number;
  /** Cadence of the heap reading and of the harness's memory. */
  heapEverySec: number;
  /** How often the harness collects what the page sampled and what the origin logged. */
  drainSec: number;
  limits?: Limits;
  log?: (line: string) => void;
}

export interface SoakRun {
  input: SoakInput;
  evaluation: SoakEvaluation;
  start: SoakStart;
  heap: HeapSample[];
  harness: HarnessSample[];
  requests: RequestDigest;
  consoleProblems: string[];
  /** Reads the page dropped, and what went wrong inside its sampler: both must be none for the series to be whole. */
  lostSamples: number;
  samplerProblems: string[];
  /** Why the page was gone before the end (a crash), or null. */
  crashed: string | null;
  /** Wall-clock the harness ran for, ms. */
  wallMs: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `buffering` or `seeking`: the player is not playing. A soak that ends with the player stalled waits for it, up to the recovery limit, before it says it is over. */
const notPlaying = (state: string): boolean =>
  state === 'buffering' || state === 'seeking' || state === 'loading';

export async function runSoak(driver: SoakDriver, options: SoakRunOptions): Promise<SoakRun> {
  const limits = options.limits ?? LIVE_LIMITS;
  const log = options.log ?? ((): void => undefined);
  const wallStart = driver.now();
  const sleepFloorMs = 1;
  const drainMs = options.drainSec * 1000;
  const heapEveryMs = options.heapEverySec * 1000;
  const warmupMs = options.warmupSec * 1000;

  const start = await driver.start();
  await driver.startSampler(options.sampleSec * 1000);
  const firstFrameMs = start.firstFrameMs;
  const endTarget = firstFrameMs + options.minutes * 60_000;
  const warmupEnd = firstFrameMs + warmupMs;

  const samples: SoakSample[] = [];
  const heap: HeapSample[] = [];
  const harness: HarnessSample[] = [];
  const samplerProblems: string[] = [];
  let lostSamples = 0;
  let crashed: string | null;

  /** Collects what the page sampled and what the origin logged; a page that is gone ends the soak. */
  const collect = async (): Promise<boolean> => {
    try {
      const read = await driver.drainSamples();
      samples.push(...read.samples);
      lostSamples += read.lost;
      for (const problem of read.problems) if (samplerProblems.length < 20) samplerProblems.push(problem);
      await driver.drainLog();
      return true;
    } catch (error) {
      crashed = driver.crashed() ?? `the page could not be read: ${messageOf(error)}`;
      return false;
    }
  };
  /** A reading that fails is a gap in the series and a line in the problems, not the end of a soak that has minutes to go: the evaluators say when there are too few. */
  const readMemory = async (): Promise<void> => {
    try {
      harness.push(await driver.readHarness());
      if (driver.heapSupported) heap.push(await driver.readHeap());
    } catch (error) {
      if (samplerProblems.length < 20) samplerProblems.push(`a memory reading failed: ${messageOf(error)}`);
    }
  };

  let nextMemoryAt = driver.now();
  let warmupRead = false;
  log(
    `soak: ${options.minutes} min on ${options.engine}, warm-up ${options.warmupSec} s, first frame at ${new Date(firstFrameMs).toISOString()}`,
  );
  for (;;) {
    const now = driver.now();
    crashed = driver.crashed();
    if (crashed) break;
    // The last reading of the soak is the one at its end, taken below: the loop takes the ones before it.
    if (now >= endTarget) break;
    if (now >= nextMemoryAt || (!warmupRead && now >= warmupEnd)) {
      await readMemory();
      if (now >= warmupEnd) warmupRead = true;
      while (nextMemoryAt <= now) nextMemoryAt += heapEveryMs;
    }
    const nextEvent = Math.min(
      now + drainMs,
      endTarget,
      nextMemoryAt,
      !warmupRead ? warmupEnd : Number.POSITIVE_INFINITY,
    );
    await driver.sleep(Math.max(sleepFloorMs, nextEvent - now));
    if (!(await collect())) break;
    const last = samples.at(-1);
    log(
      `  minute ${((driver.now() - firstFrameMs) / 60_000).toFixed(1)}: ${samples.length} reads, latency ${last?.latencyMs == null ? 'n/a' : `${(last.latencyMs / 1000).toFixed(2)} s`}, ${last?.state ?? 'no read yet'}, rebuffers ${last?.rebufferCount ?? 0}${heap.length > 0 ? `, heap ${heap.at(-1)?.usedMb.toFixed(1)} MB` : ''}`,
    );
  }

  // The end. A soak that ends while the player is stalled does not say it is over: it gives the player the recovery limit to get going, so
  // that "never ended" is a fact and not an accident of when the clock ran out.
  let snapshot: PlayerSnapshot | null = null;
  if (!crashed && (await collect())) {
    try {
      snapshot = await driver.snapshot();
      const graceEnd = driver.now() + limits.stallRecoveryMaxMs;
      while (!crashed && notPlaying(snapshot.state) && driver.now() < graceEnd) {
        await driver.sleep(1000);
        if (!(await collect())) break;
        snapshot = await driver.snapshot();
      }
    } catch (error) {
      crashed = driver.crashed() ?? `the page could not be read: ${messageOf(error)}`;
    }
  }
  if (!crashed) await readMemory();
  const endMs = driver.now();
  const consoleProblems = driver.consoleProblems();
  const { requests, manifestArrivalsMs } = driver.requestDigest();
  await driver.stop().catch(() => undefined);

  const crashError: SoakError[] = crashed
    ? [{ atMs: endMs, severity: 2, code: 0, codeName: 'PAGE_GONE', source: 'harness', message: crashed }]
    : [];
  const input: SoakInput = {
    engine: options.engine,
    firstFrameMs,
    endMs,
    requestedMinutes: options.minutes,
    warmupMs,
    samples,
    episodes: snapshot?.episodes ?? [],
    errors: [...(snapshot?.errors ?? []), ...crashError],
    frames: snapshot?.frames ?? null,
    heap: driver.heapSupported ? heap : null,
    faults: start.faults,
    manifestArrivalsMs,
  };
  const evaluation = evaluateSoak(input, limits);
  log(`soak: ${evaluation.verdict} (${evaluation.kind})`);
  return {
    input,
    evaluation,
    start,
    heap,
    harness,
    requests,
    consoleProblems,
    lostSamples,
    samplerProblems,
    crashed,
    wallMs: endMs - wallStart,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The result file

/** The most points of a series a result file keeps: a 30-minute soak at one read every 5 s has 360, and the file stays a few hundred kilobytes at most. */
export const MAX_SERIES_POINTS = 300;

export interface SoakMeta {
  envId: string;
  engine: Engine;
  generatedAt: string;
  commit: { hash: string | null; dirty: boolean | null };
  host: HostInfo;
  browser: BrowserInfo;
  stream: StreamRecord;
  configuration: { id: string; label: string; patch: ShakaConfigPatch | null };
  options: SoakReport['options'];
  limits?: Limits;
}

/** The result of a soak as a file: the verdict and every line behind it, the series (peaks kept), what the origin saw, and what the harness did to its own machine. */
export function buildSoakReport(run: SoakRun, meta: SoakMeta): SoakReport {
  const { input } = run;
  const harness = run.harness;
  return {
    schemaVersion: 1,
    kind: 'soak',
    envId: meta.envId,
    engine: meta.engine,
    generatedAt: meta.generatedAt,
    durationMs: run.wallMs,
    commit: meta.commit,
    host: meta.host,
    browser: meta.browser,
    stream: meta.stream,
    configuration: meta.configuration,
    player: run.start.player,
    options: meta.options,
    limits: limitsSnapshot(meta.limits ?? LIVE_LIMITS),
    length: run.evaluation.kind,
    verdict: run.evaluation.verdict,
    evaluations: run.evaluation.evaluations,
    firstFrameMs: input.firstFrameMs,
    endMs: input.endMs,
    faults: [...input.faults],
    series: {
      sampleCount: input.samples.length,
      samples: decimate(input.samples, MAX_SERIES_POINTS, (sample) => sample.latencyMs),
      heap: input.heap === null ? null : decimate(input.heap, MAX_SERIES_POINTS, (read) => read.usedMb),
      harness: decimate(harness, MAX_SERIES_POINTS, (read) => read.heapUsedMb),
    },
    episodes: [...input.episodes],
    errors: [...input.errors],
    consoleProblems: run.consoleProblems.slice(0, 20),
    requests: run.requests,
    harness: {
      firstHeapMb: harness[0]?.heapUsedMb ?? null,
      lastHeapMb: harness.at(-1)?.heapUsedMb ?? null,
      firstServiceRssMb: harness[0]?.serviceRssMb ?? null,
      lastServiceRssMb: harness.at(-1)?.serviceRssMb ?? null,
    },
  };
}
