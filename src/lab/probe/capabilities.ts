import type { BrowserType, LaunchOptions } from '@playwright/test';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import { FLAVOUR_IDS, LAB_STREAMS, PROBE_CASES, STREAM_PREFERENCE } from './formats.ts';
import type { FlavourId, StreamKind } from './formats.ts';
import { ensureProbeMedia } from './media.ts';
import { claimsTrueButFails, isLaunchFailure } from './results.ts';
import type { EngineResult, ProbeStage, Reliability } from './results.ts';
import { runEngine } from './run.ts';
import type { ProgressEvent } from './run.ts';

// What a browser can really play, in the terms the rest of the lab needs: per flavour, a verdict; and a pure rule that turns
// the verdicts into the stream a suite should use (or the reason it must be skipped).

export interface FlavourCapability {
  /** Decoded in every attempt: the only state a gate may rely on. An intermittent flavour is not supported. */
  supported: boolean;
  reliability: Reliability;
  /** What `MediaSource.isTypeSupported` answered for the flavour's tracks. */
  typeSupportedClaim: boolean;
  attempts: number;
  passes: number;
  /** Where the most frequent failure happened (absent when every attempt passed). */
  stage?: ProbeStage;
  /** The error text of that failure. */
  error?: string;
}

export interface Capabilities {
  /** Playwright engine name: 'chromium' | 'firefox' | 'webkit'. */
  engine: string;
  /** null when the browser did not start. */
  browserVersion: string | null;
  launchFailed?: string;
  /** Flavours that were probed. A flavour that is missing counts as unsupported. */
  flavours: Partial<Record<FlavourId, FlavourCapability>>;
  /** Flavours for which `isTypeSupported` claims support but real decoding did not succeed in every attempt. */
  lies: FlavourId[];
}

const FLAVOUR_SET: ReadonlySet<string> = new Set(FLAVOUR_IDS);

/** Capabilities from the raw per-engine record (a live run or a committed JSON file). Pure. */
export function capabilitiesFromEngine(engine: string, result: EngineResult): Capabilities {
  if (isLaunchFailure(result)) {
    const flavours: Capabilities['flavours'] = {};
    for (const id of FLAVOUR_IDS) {
      flavours[id] = {
        supported: false,
        reliability: 'fail',
        typeSupportedClaim: false,
        attempts: 0,
        passes: 0,
        stage: 'launch',
        error: result.launchFailed.split('\n')[0] ?? result.launchFailed,
      };
    }
    return { engine, browserVersion: null, launchFailed: result.launchFailed, flavours, lies: [] };
  }

  const flavours: Capabilities['flavours'] = {};
  const lies: FlavourId[] = [];
  for (const [id, caseResult] of Object.entries(result.cases)) {
    if (!FLAVOUR_SET.has(id)) continue;
    const flavourId = id as FlavourId;
    flavours[flavourId] = {
      supported: caseResult.reliability === 'ok',
      reliability: caseResult.reliability,
      typeSupportedClaim: caseResult.typeSupportedClaim ?? false,
      attempts: caseResult.attempts,
      passes: caseResult.passes,
      ...(caseResult.failure ? { stage: caseResult.failure.stage, error: caseResult.failure.error } : {}),
    };
    if (claimsTrueButFails(caseResult)) lies.push(flavourId);
  }
  return { engine, browserVersion: result.browserVersion, flavours, lies };
}

/**
 * The stream a suite should use in this browser: the first of the preferred streams (CMAF with VP9+AAC, then WebM with
 * VP9+Opus for DASH) whose flavour really decoded in every attempt and that is served over `protocol`. null: no stream can
 * be played, and the caller must skip with `explainNoStream` as the reason (or fail, if the gap is not a documented one).
 */
export function pickStream(
  capabilities: Pick<Capabilities, 'flavours'>,
  kind: StreamKind,
  protocol: Protocol,
): StreamId | null {
  for (const id of STREAM_PREFERENCE[kind]) {
    const stream = LAB_STREAMS[id];
    if (stream.protocols.includes(protocol) && capabilities.flavours[stream.flavour]?.supported) return id;
  }
  return null;
}

function describeFlavour(flavour: FlavourId, capability: FlavourCapability | undefined): string {
  if (!capability) return `${flavour} was not probed`;
  if (capability.attempts === 0) return `${flavour}: ${capability.error ?? 'the browser did not start'}`;
  let text = `${flavour} ${capability.reliability} ${capability.passes}/${capability.attempts}`;
  if (capability.stage) text += ` ([${capability.stage}] ${capability.error ?? ''})`.replace(' )', ')');
  if (capability.typeSupportedClaim && capability.reliability !== 'ok')
    text += ', isTypeSupported claims true';
  return text;
}

/**
 * Why `pickStream` returns null, as a sentence for a skipped test (null when a stream exists). It names every candidate
 * flavour with its verdict, so the skip reason carries the evidence and not only the conclusion.
 */
export function explainNoStream(
  capabilities: Pick<Capabilities, 'flavours' | 'engine' | 'browserVersion'>,
  kind: StreamKind,
  protocol: Protocol,
): string | null {
  if (pickStream(capabilities, kind, protocol)) return null;
  const candidates = STREAM_PREFERENCE[kind].filter((id) => LAB_STREAMS[id].protocols.includes(protocol));
  const where = `${capabilities.engine}${capabilities.browserVersion ? ` ${capabilities.browserVersion}` : ''}`;
  if (candidates.length === 0) return `no ${kind} stream is served over ${protocol}`;
  const reasons = [...new Set(candidates.map((id) => LAB_STREAMS[id].flavour))].map((flavour) =>
    describeFlavour(flavour, capabilities.flavours[flavour]),
  );
  return `no ${kind} stream plays over ${protocol} in ${where}: ${reasons.join('; ')} (see docs/CODEC_MATRIX.md)`;
}

export interface Selection {
  kind: StreamKind;
  protocol: Protocol;
  stream: StreamId | null;
  /** The skip reason when `stream` is null. */
  reason: string | null;
}

const SELECTION_COMBOS: ReadonlyArray<{ kind: StreamKind; protocol: Protocol }> = [
  { kind: 'vod', protocol: 'dash' },
  { kind: 'vod', protocol: 'hls' },
  { kind: 'live', protocol: 'dash' },
  { kind: 'live', protocol: 'hls' },
];

/** What `pickStream` decides for every kind and protocol the lab serves: the policy of a browser at a glance. */
export function selectStreams(
  capabilities: Pick<Capabilities, 'flavours' | 'engine' | 'browserVersion'>,
): Selection[] {
  return SELECTION_COMBOS.map(({ kind, protocol }) => ({
    kind,
    protocol,
    stream: pickStream(capabilities, kind, protocol),
    reason: explainNoStream(capabilities, kind, protocol),
  }));
}

export interface ProbeCapabilitiesOptions {
  /** Which flavours to probe. Default: all four. A run-time caller that only needs the lab's streams can pass two. */
  flavours?: readonly FlavourId[];
  attempts?: number;
  freshProcess?: boolean;
  timeoutMs?: number;
  thresholdSec?: number;
  minFrames?: number;
  launchOptions?: LaunchOptions;
  /** Directory with the probe media. Default: `ensureProbeMedia()` (generates it with ffmpeg when needed). */
  mediaDir?: string;
  onProgress?: (event: ProgressEvent) => void;
}

/** Decodes real media through MSE in `browserType` and reports the verdict per flavour. Never throws for a launch failure. */
export async function probeCapabilities(
  browserType: BrowserType,
  options: ProbeCapabilitiesOptions = {},
): Promise<Capabilities> {
  const { flavours, mediaDir, ...runOptions } = options;
  const dir = mediaDir ?? (await ensureProbeMedia()).dir;
  const wanted: readonly string[] = flavours ?? FLAVOUR_IDS;
  const cases = PROBE_CASES.filter((probeCase) => wanted.includes(probeCase.id));
  const run = await runEngine(browserType, { cases }, { ...runOptions, mediaDir: dir });
  return capabilitiesFromEngine(browserType.name(), run);
}
