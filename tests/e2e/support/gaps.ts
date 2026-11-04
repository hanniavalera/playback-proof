import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  capabilitiesFromEngine,
  describeFlavour,
  explainNoStream,
  pickStream,
  selectStreams,
} from '../../../src/lab/probe/capabilities.ts';
import type { Capabilities } from '../../../src/lab/probe/capabilities.ts';
import { LAB_STREAMS, STREAM_PREFERENCE } from '../../../src/lab/probe/formats.ts';
import type { StreamKind } from '../../../src/lab/probe/formats.ts';
import { parseResultFile } from '../../../src/lab/probe/report.ts';
import type { ResultFile } from '../../../src/lab/probe/report.ts';
import { detectEnvId } from '../../../src/shared/env.ts';
import type { Protocol, StreamId } from '../../../src/shared/streams.ts';

// Documented gaps: which engine and OS pairs cannot play which streams, decided from the COMMITTED result of the real-decode
// probe of the environment the suite runs in (docs/results/codec-matrix/<envId>.json, rendered in docs/CODEC_MATRIX.md), never
// from `MediaSource.isTypeSupported` and never from a list kept in a spec. A spec that cannot run because of a gap is skipped
// with the evidence as its reason; everything that is not documented here runs, and fails if it does not play.

/**
 * THE ONE OVERRIDE, for the open question of Linux WebKit.
 *
 * `false` (the default): Linux WebKit is a gap exactly where the committed matrix of the environment says it cannot play
 * (today: `docker-linux-arm64`, intermittent `MediaError 4` in every flavour), and nowhere else.
 * `true`: the specs run in Linux WebKit whatever the matrix says. Flip it when an experiment shows that the real player page
 * plays there reliably although the probe's default page profile (a muted element, data fetched after the SourceBuffers
 * exist) does not; re-probe and commit the matrix afterwards, then set it back.
 */
export const RUN_SPECS_IN_LINUX_WEBKIT = false;

export const MATRIX_DIR = fileURLToPath(new URL('../../../docs/results/codec-matrix/', import.meta.url));

/**
 * The committed probe result of an environment, or null when there is none (a new CI runner: nothing is documented there).
 * A file that exists but does not validate throws `ResultFileError`: a broken record must never read as "no gap".
 */
export function readEvidence(envId: string, dir: string = MATRIX_DIR): ResultFile | null {
  const file = `${envId}.json`;
  const path = join(dir, file);
  return existsSync(path) ? parseResultFile(readFileSync(path, 'utf8'), file) : null;
}

export interface Environment {
  /** `detectEnvId()`: `local-darwin-arm64`, `docker-linux-arm64`, `gha-linux-x64`... */
  envId: string;
  /** The Playwright engine of the project: `chromium` (also for `chromium-cpu4x`), `firefox` or `webkit`. */
  engine: string;
  platform: string;
  /** What the committed matrix says this engine can play. null: nothing is documented here, so nothing is skipped. */
  capabilities: Capabilities | null;
  /** Where `capabilities` came from, or why there are none: goes into skip reasons and failure messages. */
  basis: string;
}

export interface EnvironmentInput {
  envId: string;
  engine: string;
  /** Default: this process's platform. */
  platform?: string;
  evidence?: ResultFile | null;
  /** The override of this module (`RUN_SPECS_IN_LINUX_WEBKIT`), injectable for the unit tests. */
  runInLinuxWebKit?: boolean;
}

export function resolveEnvironment(input: EnvironmentInput): Environment {
  const { envId, engine } = input;
  const platform = input.platform ?? process.platform;
  const evidence = input.evidence ?? null;
  const path = `docs/results/codec-matrix/${envId}.json`;
  const base = { envId, engine, platform };

  if (!evidence) {
    return { ...base, capabilities: null, basis: `no committed probe result for ${envId} (${path})` };
  }
  const result = evidence.engines[engine];
  if (!result) {
    return { ...base, capabilities: null, basis: `${path} has no result for ${engine}` };
  }
  if ((input.runInLinuxWebKit ?? RUN_SPECS_IN_LINUX_WEBKIT) && engine === 'webkit' && platform === 'linux') {
    return {
      ...base,
      capabilities: null,
      basis: `RUN_SPECS_IN_LINUX_WEBKIT is set in tests/e2e/support/gaps.ts: the specs run in Linux WebKit whatever ${path} says`,
    };
  }
  return { ...base, capabilities: capabilitiesFromEngine(engine, result), basis: path };
}

/** The environment this process runs in, for one engine: reads the committed result file of `detectEnvId()`. */
export function currentEnvironment(engine: string): Environment {
  const envId = detectEnvId();
  return resolveEnvironment({ envId, engine, evidence: readEvidence(envId) });
}

function documented(env: Environment, text: string): string {
  return `documented gap in ${env.envId}: ${text}`;
}

/** `Failed to launch the browser process: Could not find profile folder.`: the headline and the browser's own complaint. */
function summarizeLaunchFailure(text: string): string {
  const [first = text] = text.split('\n');
  const complaints = text
    .split('\n')
    .filter((line) => /\[err\]/.test(line) && !line.startsWith('  - '))
    .map((line) => line.replace(/^.*\[err\]\s*/, ''))
    .filter((line) => line !== '' && !line.startsWith('***'));
  const headline = first.replace(/^browserType\.launch:\s*/, '').replace(/\.$/, '');
  return complaints.length > 0 ? `${headline}: ${complaints.join(' ')}` : headline;
}

/**
 * Why NO spec can run in this engine here (no stream of any kind plays), or null. The shared fixture skips every test with this
 * reason before its body runs: Linux WebKit, and Firefox on the macOS host, where the browser does not even start.
 */
export function engineGap(env: Environment): string | null {
  const { capabilities } = env;
  if (!capabilities) return null;
  if (selectStreams(capabilities).some((selection) => selection.stream !== null)) return null;
  if (capabilities.launchFailed) {
    const why = summarizeLaunchFailure(capabilities.launchFailed);
    return documented(env, `${env.engine} does not start here: ${why} (see docs/CODEC_MATRIX.md)`);
  }
  const reason = explainNoStream(capabilities, 'vod', 'dash');
  return documented(env, reason ?? `${env.engine} plays no stream of the lab`);
}

export type StreamChoice = { stream: StreamId } | { gap: string };

/**
 * The stream a spec should play for a kind and a protocol: the first preferred stream whose flavour decoded in every attempt of
 * the probe (`pickStream`), or the documented reason that none does. Without evidence the first preferred stream is chosen:
 * nothing is documented, so PB-ENV-001 is where a gap that is not documented fails.
 */
export function chooseStream(env: Environment, kind: StreamKind, protocol: Protocol): StreamChoice {
  if (!env.capabilities) {
    const stream = STREAM_PREFERENCE[kind].find((id) => LAB_STREAMS[id].protocols.includes(protocol));
    if (!stream)
      throw new Error(
        `no ${kind} stream is served over ${protocol} (STREAM_PREFERENCE in src/lab/probe/formats.ts)`,
      );
    return { stream };
  }
  const stream = pickStream(env.capabilities, kind, protocol);
  if (stream) return { stream };
  return { gap: documented(env, explainNoStream(env.capabilities, kind, protocol) ?? 'no stream plays') };
}

/**
 * Why one particular stream cannot play here (its flavour did not decode in every attempt), or null. For a spec that needs a
 * stream `chooseStream` would not pick: the short title, the open-codec WebM stream, the live stream.
 */
export function gapForStream(env: Environment, stream: StreamId): string | null {
  const { capabilities } = env;
  if (!capabilities) return null;
  const { flavour } = LAB_STREAMS[stream];
  const capability = capabilities.flavours[flavour];
  if (capability?.supported) return null;
  const where = `${capabilities.engine}${capabilities.browserVersion ? ` ${capabilities.browserVersion}` : ''}`;
  return documented(
    env,
    `${stream} is made of ${flavour}, which does not play in ${where}: ${describeFlavour(flavour, capability)} (see docs/CODEC_MATRIX.md)`,
  );
}

/** The browser version the matrix was probed on, when it is not the one running now: a hint that the evidence may be stale. */
export function versionDrift(env: Environment, actualVersion: string): string | null {
  const probed = env.capabilities?.browserVersion;
  if (!probed || probed === actualVersion) return null;
  return `${env.engine} is ${actualVersion} here, the committed matrix of ${env.envId} was probed on ${probed}: re-run npm run codec-matrix and commit the result if the engine changed`;
}

export interface UndocumentedGap {
  stream: StreamId;
  protocol: Protocol;
  /** The version of the browser that ran the spec. */
  actualVersion: string;
  userAgent?: string;
  /** What went wrong: the error the player produced. */
  cause: string;
}

/**
 * The failure text of PB-ENV-001 when an engine cannot play a stream that nothing documents as a gap: what was tried, what the
 * browser said, what the committed matrix claimed (or that there is none), and what to do about it.
 */
export function explainUndocumentedGap(env: Environment, gap: UndocumentedGap): string {
  const lines = [
    `${env.engine} ${gap.actualVersion} in ${env.envId} could not play ${gap.stream} over ${gap.protocol} through the player, and no documented gap covers it.`,
    `What the player said: ${gap.cause}`,
  ];
  if (gap.userAgent) lines.push(`User agent: ${gap.userAgent}`);
  if (env.capabilities) {
    const flavour = LAB_STREAMS[gap.stream].flavour;
    lines.push(
      `Committed evidence (${env.basis}) claims it plays: ${describeFlavour(flavour, env.capabilities.flavours[flavour])}.`,
      'So the engine or the runner image changed since the matrix was probed: this is an environment failure, not a playback regression. Re-run `npm run codec-matrix` here and read docs/CODEC_MATRIX.md; do not retry the specs.',
    );
    const drift = versionDrift(env, gap.actualVersion);
    if (drift) lines.push(drift);
  } else {
    lines.push(
      `Committed evidence: ${env.basis}.`,
      `If this engine is not expected to play here, run \`npm run codec-matrix\` in this environment and commit docs/results/codec-matrix/${env.envId}.json so that the gap is documented and the specs skip with its reason; otherwise fix the environment.`,
    );
  }
  return lines.join('\n');
}
