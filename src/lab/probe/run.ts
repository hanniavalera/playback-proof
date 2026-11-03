import { homedir, tmpdir } from 'node:os';
import type { Browser, BrowserType, LaunchOptions, Page } from '@playwright/test';
import { DEFAULT_PROFILE, FILE_FORMATS, PROBE_FILE_IDS, mimeTypesOf } from './formats.ts';
import type { ControlCase, PageProfile, ProbeCase } from './formats.ts';
import { collectBrowserFacts, probeInPage } from './in-page.ts';
import type { BrowserFacts, InPageOutcome, InPageSpec } from './in-page.ts';
import { normalizeError, redactPaths, summarizeAttempts } from './results.ts';
import type { AttemptResult, CaseResult, EngineResult, ProbeStage } from './results.ts';
import { startStaticServer } from './static-server.ts';
import type { StaticServer } from './static-server.ts';

// Runs probe cases in ONE browser engine against a tiny local static server (port 0). The library takes a Playwright
// `BrowserType` from the caller and never imports Playwright at run time, so it works under any loader.

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_THRESHOLD_SEC = 1;
export const DEFAULT_MIN_FRAMES = 5;

/** How much longer than the in-page deadline the runner waits before it declares the page itself unresponsive. */
const GUARD_SLACK_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 10_000;

// tsx compiles with esbuild's keepNames, which wraps inner functions in `__name(...)`. Playwright serialises the in-page
// function with toString(), so the helper must exist in the page or the probe dies with a ReferenceError.
const NAME_SHIM = 'window.__name = window.__name || function (target) { return target; };';

export interface RunOptions {
  /** Directory with the probe media (`ensureProbeMedia().dir`). */
  mediaDir: string;
  /** Attempts per case; more than one is what reveals an intermittent engine. Default 3. */
  attempts?: number;
  /**
   * A brand-new browser process for every attempt (default true). State leaks between cases on Playwright's Linux WebKit,
   * so a shared process would make a case's verdict depend on the cases that ran before it.
   */
  freshProcess?: boolean;
  /** In-page safety-net deadline per attempt. A failure to report, never a measurement. Default 20000. */
  timeoutMs?: number;
  /** Media time that must be reached, seconds. Default 1. */
  thresholdSec?: number;
  /** Frames that must be presented for sources with video. Default 5 (of ~30 expected: a loaded machine still passes). */
  minFrames?: number;
  launchOptions?: LaunchOptions;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProbePlan {
  /** MSE cases, each measured under the default page profile. */
  cases: readonly ProbeCase[];
  /** The same files as a plain `<video src>`. */
  controls?: readonly ControlCase[];
  /** One case again under other page profiles: shows whether an engine's verdict depends on how the page drives MSE. */
  sensitivity?: { probeCase: ProbeCase; profiles: readonly PageProfile[] };
}

export interface ProgressEvent {
  engine: string;
  id: string;
  attempt: number;
  attempts: number;
  result: AttemptResult;
}

type ResolvedOptions = Required<Omit<RunOptions, 'launchOptions' | 'onProgress'>> &
  Pick<RunOptions, 'launchOptions' | 'onProgress'>;

function resolveOptions(options: RunOptions): ResolvedOptions {
  const resolved = {
    ...options,
    attempts: options.attempts ?? DEFAULT_ATTEMPTS,
    freshProcess: options.freshProcess ?? true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    thresholdSec: options.thresholdSec ?? DEFAULT_THRESHOLD_SEC,
    minFrames: options.minFrames ?? DEFAULT_MIN_FRAMES,
  };
  if (!Number.isInteger(resolved.attempts) || resolved.attempts < 1) {
    throw new RangeError(`attempts must be an integer >= 1, got ${resolved.attempts}`);
  }
  return resolved;
}

function scrub(text: string): string {
  return normalizeError(redactPaths(text, homedir(), tmpdir()));
}

/** The first lines of an error: Playwright appends long call logs that say nothing more. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrub(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' | '),
  );
}

/** A launch failure keeps the browser's own log (that is the evidence), minus blank runs and the user's paths. */
function launchFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').map((line) => line.trimEnd());
  const compact = lines.filter((line, index) => line !== '' || (lines[index - 1] ?? '') !== '');
  return scrub(compact.slice(0, 40).join('\n').trim());
}

async function closeQuietly(close: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([close().then(() => undefined), deadline]);
  } catch {
    // Closing a browser that already crashed is not a finding.
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a page.evaluate with the page's own death (crash, close, silence) turned into a rejection instead of a hang. */
async function guarded<R>(page: Page, guardMs: number, evaluate: () => Promise<R>): Promise<R> {
  let timer: NodeJS.Timeout | undefined;
  const guards = new Promise<never>((_resolve, reject) => {
    page.once('crash', () => reject(new Error('the page crashed')));
    page.once('close', () => reject(new Error('the page closed before the probe answered')));
    timer = setTimeout(() => reject(new Error(`the page did not answer within ${guardMs} ms`)), guardMs);
  });
  try {
    return await Promise.race([evaluate(), guards]);
  } finally {
    clearTimeout(timer);
  }
}

async function openPage(
  browser: Browser,
  origin: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const close = (): Promise<void> => closeQuietly(() => context.close());
  try {
    const page = await context.newPage();
    await page.addInitScript(NAME_SHIM);
    await page.goto(`${origin}/`, { timeout: NAVIGATION_TIMEOUT_MS });
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function toAttempt(outcome: InPageOutcome): AttemptResult {
  return {
    ok: outcome.ok,
    ...(outcome.ok
      ? {}
      : { stage: outcome.stage ?? 'evaluate', error: scrub(outcome.error ?? 'unknown failure') }),
    ...(outcome.mediaError
      ? { mediaError: { code: outcome.mediaError.code, message: scrub(outcome.mediaError.message) } }
      : {}),
    currentTime: outcome.currentTime,
    framesPresented: outcome.framesPresented,
  };
}

interface Attempter {
  browserType: BrowserType;
  options: ResolvedOptions;
  server: StaticServer;
  /** Set when the process is shared between attempts (freshProcess: false). */
  shared?: Browser;
}

async function attemptOnce(attempter: Attempter, spec: InPageSpec): Promise<AttemptResult> {
  let stage: ProbeStage = 'launch';
  let owned: Browser | undefined;
  try {
    const browser =
      attempter.shared ?? (owned = await attempter.browserType.launch(attempter.options.launchOptions));
    stage = 'navigate';
    const { page, close } = await openPage(browser, attempter.server.origin);
    try {
      stage = 'evaluate';
      const outcome = await guarded(page, spec.deadlineMs + GUARD_SLACK_MS, () =>
        page.evaluate(probeInPage, spec),
      );
      return toAttempt(outcome);
    } finally {
      await close();
    }
  } catch (error) {
    return { ok: false, stage, error: describeError(error) };
  } finally {
    const toClose = owned;
    if (toClose) await closeQuietly(() => toClose.close());
  }
}

function mseSpec(
  probeCase: ProbeCase,
  origin: string,
  options: ResolvedOptions,
  profile: PageProfile,
): InPageSpec {
  return {
    source: {
      kind: 'mse',
      tracks: probeCase.tracks.map((track) => ({
        type: track.mimeType,
        url: `${origin}/media/${track.file}`,
      })),
    },
    profile: { muted: profile.muted, prefetch: profile.prefetch },
    hasVideo: probeCase.tracks.some((track) => track.kind === 'video'),
    thresholdSec: options.thresholdSec,
    minFrames: options.minFrames,
    deadlineMs: options.timeoutMs,
  };
}

function nativeSpec(control: ControlCase, origin: string, options: ResolvedOptions): InPageSpec {
  return {
    source: { kind: 'native', url: `${origin}/media/${control.file}` },
    profile: { muted: DEFAULT_PROFILE.muted, prefetch: DEFAULT_PROFILE.prefetch },
    hasVideo: FILE_FORMATS[control.file].kind === 'video',
    thresholdSec: options.thresholdSec,
    minFrames: options.minFrames,
    deadlineMs: options.timeoutMs,
  };
}

async function readFacts(browser: Browser, origin: string, types: string[]): Promise<BrowserFacts> {
  const { page, close } = await openPage(browser, origin);
  try {
    return await guarded(page, CLOSE_TIMEOUT_MS, () => page.evaluate(collectBrowserFacts, types));
  } finally {
    await close();
  }
}

/**
 * Probes one engine. Never throws for a browser that does not start: that is returned as `{ launchFailed }` with the
 * browser's own error text, because "Firefox does not launch on this host" is a result of the matrix, not a crash of it.
 */
export async function runEngine(
  browserType: BrowserType,
  plan: ProbePlan,
  runOptions: RunOptions,
): Promise<EngineResult> {
  const options = resolveOptions(runOptions);
  const engine = browserType.name();
  const contentTypes = Object.fromEntries(
    PROBE_FILE_IDS.map((id) => [id, `${FILE_FORMATS[id].kind}/${FILE_FORMATS[id].container}`]),
  );
  const server = await startStaticServer(options.mediaDir, { contentTypes });
  let shared: Browser | undefined;
  try {
    let first: Browser;
    try {
      first = await browserType.launch(options.launchOptions);
    } catch (error) {
      return { launchFailed: launchFailureText(error) };
    }

    let facts: BrowserFacts;
    try {
      facts = await readFacts(
        first,
        server.origin,
        mimeTypesOf([...plan.cases, ...(plan.sensitivity ? [plan.sensitivity.probeCase] : [])]),
      );
    } catch (error) {
      await closeQuietly(() => first.close());
      return {
        launchFailed: `the browser started but could not load the probe page: ${describeError(error)}`,
      };
    }
    const browserVersion = first.version();
    if (options.freshProcess) await closeQuietly(() => first.close());
    else shared = first;

    const attempter: Attempter = { browserType, options, server, ...(shared ? { shared } : {}) };
    const repeat = async (id: string, spec: InPageSpec, claim?: boolean): Promise<CaseResult> => {
      const runs: AttemptResult[] = [];
      for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        const result = await attemptOnce(attempter, spec);
        runs.push(result);
        options.onProgress?.({ engine, id, attempt, attempts: options.attempts, result });
      }
      return summarizeAttempts(runs, claim);
    };

    const cases: Record<string, CaseResult> = {};
    for (const probeCase of plan.cases) {
      const claim = probeCase.tracks.every((track) => facts.typeSupported[track.mimeType] === true);
      cases[probeCase.id] = await repeat(
        probeCase.id,
        mseSpec(probeCase, server.origin, options, DEFAULT_PROFILE),
        claim,
      );
    }
    const controls: Record<string, CaseResult> = {};
    for (const control of plan.controls ?? []) {
      controls[control.id] = await repeat(control.id, nativeSpec(control, server.origin, options));
    }
    const sensitivity: Record<string, CaseResult> = {};
    if (plan.sensitivity) {
      const { probeCase, profiles } = plan.sensitivity;
      const claim = probeCase.tracks.every((track) => facts.typeSupported[track.mimeType] === true);
      for (const profile of profiles) {
        sensitivity[profile.id] = await repeat(
          `${probeCase.id} [${profile.id}]`,
          mseSpec(probeCase, server.origin, options, profile),
          claim,
        );
      }
    }

    return {
      browserVersion,
      userAgent: facts.userAgent,
      mediaSource: facts.mediaSource,
      nativeHls: facts.canPlayType,
      requestVideoFrameCallback: facts.requestVideoFrameCallback,
      getVideoPlaybackQuality: facts.getVideoPlaybackQuality,
      isTypeSupported: facts.typeSupported,
      cases,
      controls,
      sensitivity,
    };
  } finally {
    const toClose = shared;
    if (toClose) await closeQuietly(() => toClose.close());
    await server.close();
  }
}
