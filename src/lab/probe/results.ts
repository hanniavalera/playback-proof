// Pure result model of the probe: what one attempt reports, how attempts add up to a verdict, and where a browser's
// `isTypeSupported` answer disagrees with what it really decoded. No browsers, no I/O: everything here is unit-tested.

/**
 * Where an attempt failed, in the order the stages happen in the default flow (a prefetching profile fetches before
 * `setup`). `launch`, `navigate` and `evaluate` are the runner's (the browser did not start, the page did not load, or the
 * page crashed or never answered); the rest are the in-page probe's.
 */
export const PROBE_STAGES = [
  'launch',
  'navigate',
  'setup',
  'sourceopen',
  'addSourceBuffer',
  'fetch',
  'append',
  'endOfStream',
  'play',
  'currentTime',
  'frames',
  'evaluate',
] as const;
export type ProbeStage = (typeof PROBE_STAGES)[number];

export type Reliability = 'ok' | 'intermittent' | 'fail';

export interface MediaErrorInfo {
  /** MediaError.code: 1 aborted, 2 network, 3 decode, 4 source not supported. */
  code: number;
  message: string;
}

export interface AttemptResult {
  ok: boolean;
  /** Set when `ok` is false. */
  stage?: ProbeStage;
  /** `Name: message` of the failure, with the engine's own wording. */
  error?: string;
  /** The media element's `error` when it had one: the engine's view of why the pipeline stopped. */
  mediaError?: MediaErrorInfo;
  /** Media time reached, seconds. Evidence for the verdict, not a measurement. */
  currentTime?: number;
  /** Video frames presented when the attempt ended (null: the engine offers no way to count them). Evidence, not a measurement. */
  framesPresented?: number | null;
}

export interface FailureSignature {
  stage: ProbeStage;
  error: string;
  mediaError?: MediaErrorInfo;
  /** How many attempts failed this way. */
  count: number;
}

export interface CaseResult {
  attempts: number;
  passes: number;
  reliability: Reliability;
  /** What `MediaSource.isTypeSupported` answered for every track type of the case. Absent for plain-playback controls. */
  typeSupportedClaim?: boolean;
  /** The most frequent failure, when any attempt failed. */
  failure?: FailureSignature;
  runs: AttemptResult[];
}

/** `ok`: every attempt decoded. `fail`: none did. `intermittent`: some did, some did not. */
export function classifyReliability(passes: number, attempts: number): Reliability {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new RangeError(`attempts must be an integer >= 1, got ${attempts}`);
  if (!Number.isInteger(passes) || passes < 0 || passes > attempts) {
    throw new RangeError(`passes must be an integer between 0 and ${attempts}, got ${passes}`);
  }
  if (passes === attempts) return 'ok';
  return passes === 0 ? 'fail' : 'intermittent';
}

/** Error texts embed the probe server's random port; it must not make two identical failures look different. */
export function normalizeError(text: string): string {
  return text.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

function signatureKey(run: AttemptResult): string {
  return JSON.stringify([run.stage, run.error, run.mediaError?.code, run.mediaError?.message]);
}

/** The failure most attempts had (the earliest one on a tie); undefined when nothing failed. */
export function dominantFailure(runs: readonly AttemptResult[]): FailureSignature | undefined {
  const groups = new Map<string, { run: AttemptResult; count: number }>();
  for (const run of runs) {
    if (run.ok) continue;
    const key = signatureKey(run);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { run, count: 1 });
  }
  let best: { run: AttemptResult; count: number } | undefined;
  for (const group of groups.values()) if (!best || group.count > best.count) best = group;
  if (!best) return undefined;
  const { run, count } = best;
  return {
    stage: run.stage ?? 'evaluate',
    error: run.error ?? 'unknown failure',
    ...(run.mediaError ? { mediaError: run.mediaError } : {}),
    count,
  };
}

export function summarizeAttempts(runs: readonly AttemptResult[], typeSupportedClaim?: boolean): CaseResult {
  const passes = runs.filter((r) => r.ok).length;
  const failure = dominantFailure(runs);
  return {
    attempts: runs.length,
    passes,
    reliability: classifyReliability(passes, runs.length),
    ...(typeSupportedClaim === undefined ? {} : { typeSupportedClaim }),
    ...(failure ? { failure } : {}),
    runs: [...runs],
  };
}

/** `isTypeSupported` said yes, but real decoding did not succeed every time: the capability report is not to be trusted. */
export function claimsTrueButFails(result: Pick<CaseResult, 'typeSupportedClaim' | 'reliability'>): boolean {
  return result.typeSupportedClaim === true && result.reliability !== 'ok';
}

/** `isTypeSupported` said no, yet the media decoded: the report is too pessimistic (a missed capability). */
export function claimsFalseButPlays(result: Pick<CaseResult, 'typeSupportedClaim' | 'passes'>): boolean {
  return result.typeSupportedClaim === false && result.passes > 0;
}

export interface Disagreements {
  /** Claimed supported, did not decode in every attempt. */
  lies: string[];
  /** Claimed unsupported, decoded in at least one attempt. */
  underclaims: string[];
}

export function deriveDisagreements(cases: Readonly<Record<string, CaseResult>>): Disagreements {
  const lies: string[] = [];
  const underclaims: string[] = [];
  for (const [id, result] of Object.entries(cases)) {
    if (claimsTrueButFails(result)) lies.push(id);
    else if (claimsFalseButPlays(result)) underclaims.push(id);
  }
  return { lies, underclaims };
}

/** The engine could not be started: the whole engine is a result, not an exception. */
export interface LaunchFailure {
  launchFailed: string;
}

/** What one engine answered and decoded in one environment. This is the per-engine record of the committed JSON. */
export interface ProbedEngine {
  browserVersion: string;
  userAgent: string;
  mediaSource: 'MediaSource' | 'ManagedMediaSource' | 'none';
  /** `canPlayType` for the HLS types: does the engine play HLS by itself (the lab's player does not rely on it). */
  nativeHls: Record<string, string>;
  requestVideoFrameCallback: boolean;
  getVideoPlaybackQuality: boolean;
  /** What the engine claims, per type string. null: no MediaSource, or the call threw. */
  isTypeSupported: Record<string, boolean | null>;
  /** Real MSE decode, per case id. */
  cases: Record<string, CaseResult>;
  /** The same files as a plain `<video src>`, per control id. */
  controls: Record<string, CaseResult>;
  /** The primary flavour again, driven by differently behaving pages (see SENSITIVITY_PROFILES), per profile id. */
  sensitivity: Record<string, CaseResult>;
}

export type EngineResult = LaunchFailure | ProbedEngine;

export function isLaunchFailure(engine: EngineResult): engine is LaunchFailure {
  return 'launchFailed' in engine;
}

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/** `MediaError 4 (MEDIA_ERR_SRC_NOT_SUPPORTED): Failed to push buffer` */
export function describeMediaError(error: MediaErrorInfo): string {
  const name = MEDIA_ERROR_NAMES[error.code];
  return `MediaError ${error.code}${name ? ` (${name})` : ''}${error.message ? `: ${error.message}` : ''}`;
}

/** Paths in an error text that would identify the machine's user: replaced before anything is committed. */
export function redactPaths(text: string, home: string, tmp: string): string {
  let out = text;
  if (home && home !== '/') out = out.split(home).join('~');
  if (tmp && tmp !== '/') out = out.split(tmp).join('<tmpdir>');
  return out;
}
