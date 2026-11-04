import {
  PROBE_CASES,
  CONTROL_CASES,
  SENSITIVITY_PROFILES,
  mimeTypesOf,
} from '../../../src/lab/probe/formats.ts';
import type { ResultFile } from '../../../src/lab/probe/report.ts';
import type {
  AttemptResult,
  CaseResult,
  MediaErrorInfo,
  ProbeStage,
  ProbedEngine,
} from '../../../src/lab/probe/results.ts';

// Hand-written, invented results for the unit tests (engine versions like "1.0", environments called "fixture-*"). They
// are not measurements and must never be mistaken for the committed results under docs/results.

export interface Failure {
  stage: ProbeStage;
  error: string;
  mediaError?: MediaErrorInfo;
}

export const PUSH_FAILURE: Failure = {
  stage: 'play',
  error: 'NotSupportedError: The operation is not supported.',
  mediaError: { code: 4, message: 'Failed to push buffer' },
};

export const UNSUPPORTED_FAILURE: Failure = {
  stage: 'addSourceBuffer',
  error: 'NotSupportedError: The operation is not supported.',
};

export function runsOf(passes: number, attempts: number, failure: Failure = PUSH_FAILURE): AttemptResult[] {
  return Array.from({ length: attempts }, (_, index) =>
    index < passes
      ? { ok: true, currentTime: 1.01, framesPresented: 30 }
      : { ok: false, ...failure, currentTime: 0, framesPresented: 0 },
  );
}

/** A verdict written out by hand (not derived with the code under test). */
export function verdict(
  passes: number,
  attempts: number,
  claim?: boolean,
  failure: Failure = PUSH_FAILURE,
): CaseResult {
  const failed = attempts - passes;
  return {
    attempts,
    passes,
    reliability: passes === attempts ? 'ok' : passes === 0 ? 'fail' : 'intermittent',
    ...(claim === undefined ? {} : { typeSupportedClaim: claim }),
    ...(failed > 0 ? { failure: { ...failure, count: failed } } : {}),
    runs: runsOf(passes, attempts, failure),
  };
}

export interface EngineOverrides {
  version?: string;
  attempts?: number;
  cases?: Record<string, CaseResult>;
  controls?: Record<string, CaseResult>;
  sensitivity?: Record<string, CaseResult>;
  claims?: Record<string, boolean | null>;
}

/** An engine where everything decodes in every attempt, with the given overrides. */
export function probedEngine(overrides: EngineOverrides = {}): ProbedEngine {
  const attempts = overrides.attempts ?? 5;
  const cases: Record<string, CaseResult> = {};
  for (const probeCase of PROBE_CASES) cases[probeCase.id] = verdict(attempts, attempts, true);
  const controls: Record<string, CaseResult> = {};
  for (const control of CONTROL_CASES) controls[control.id] = verdict(attempts, attempts);
  const sensitivity: Record<string, CaseResult> = {};
  for (const profile of SENSITIVITY_PROFILES) sensitivity[profile.id] = verdict(attempts, attempts, true);
  const isTypeSupported: Record<string, boolean | null> = {};
  for (const type of mimeTypesOf(PROBE_CASES)) isTypeSupported[type] = true;
  return {
    browserVersion: overrides.version ?? '1.0',
    userAgent: 'Fixture/1.0',
    mediaSource: 'MediaSource',
    nativeHls: { 'application/vnd.apple.mpegurl': '', 'application/x-mpegURL': '' },
    requestVideoFrameCallback: true,
    getVideoPlaybackQuality: true,
    isTypeSupported: { ...isTypeSupported, ...overrides.claims },
    cases: { ...cases, ...overrides.cases },
    controls: { ...controls, ...overrides.controls },
    sensitivity: { ...sensitivity, ...overrides.sensitivity },
  };
}

export function resultFile(
  envId: string,
  engines: ResultFile['engines'],
  extra: Partial<ResultFile> = {},
): ResultFile {
  return {
    schemaVersion: 1,
    envId,
    generatedAt: '2030-01-02T03:04:05.000Z',
    invokedVia: 'direct',
    args: ['--browsers', 'chromium,firefox,webkit', '--attempts', '5'],
    host: {
      os: { platform: 'fixture', arch: 'arm64', release: '1.2.3', name: 'Fixture OS 1.0' },
      cpus: 8,
      memoryGiB: 16,
      node: 'v22.0.0',
      playwright: '1.64.1',
      git: { commit: 'abc1234', dirty: false },
    },
    media: {
      ffmpeg: '9.0.2',
      specHash: 'f'.repeat(64),
      files: { 'v-vp9.mp4': { sha256: 'e'.repeat(64), bytes: 1000 } },
    },
    options: { attempts: 5, freshProcess: true, timeoutMs: 20000, thresholdSec: 1, minFrames: 5 },
    engines,
    ...extra,
  };
}

/** Two environments: Linux where one engine is flaky on the primary flavour, and a host where Firefox does not start. */
export function twoEnvironments(): ResultFile[] {
  const linux = resultFile(
    'fixture-linux-arm64',
    {
      chromium: probedEngine({ version: '100.0' }),
      firefox: probedEngine({ version: '200.0' }),
      webkit: probedEngine({
        version: '3.0',
        cases: {
          'cmaf-vp9-aac': verdict(2, 5, true),
          'cmaf-vp9-opus': verdict(0, 5, true),
          'vp9-fmp4-video': verdict(4, 5, true),
        },
        sensitivity: { unmuted: verdict(5, 5, true), prefetch: verdict(5, 5, true) },
      }),
    },
    {
      invokedVia: 'docker:pw',
      dockerCpus: 4,
      host: {
        ...resultFile('x', {}).host,
        os: { platform: 'linux', arch: 'arm64', release: '6.5.0', name: 'Fixture Linux 24.04' },
      },
    },
  );
  const mac = resultFile('fixture-mac-arm64', {
    chromium: probedEngine({
      version: '100.0',
      cases: { 'hevc-fmp4-video': verdict(0, 5, false, UNSUPPORTED_FAILURE) },
      claims: { 'video/mp4; codecs="hvc1.1.6.L93.B0"': false },
    }),
    firefox: {
      launchFailed:
        'browserType.launch: Failed to launch the browser process.\nBrowser logs:\n\n<launching> ~/fixture/firefox -headless\nCould not find profile folder\nCall log:\n  - <launching> ~/fixture/firefox -headless\n  - Could not find profile folder',
    },
    webkit: probedEngine({
      version: '3.0',
      cases: {
        'cmaf-vp9-opus': verdict(0, 5, false, UNSUPPORTED_FAILURE),
        'opus-fmp4-audio': verdict(5, 5, false),
      },
    }),
  });
  return [mac, linux];
}
