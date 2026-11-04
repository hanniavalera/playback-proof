import type shaka from 'shaka-player';
import type { ConfigId } from './params.ts';

// The two player configurations the lab compares (docs/CONTRACTS.md section 6, ADR-064 in docs/decisions/player.md).
//
//   A  Shaka Player 5.3.3's own defaults. No override: it is the control, and it is never tuned.
//   B  a candidate: a few overrides, each one a hypothesis that the A/B runner (phase 6) can confirm or reject. The overrides
//      are keyed by what they do, so a run can switch one of them on alone (A plus one knob through qa.configure) to
//      attribute an effect, instead of only comparing two bundles.
//
// Every key below is type-checked against Shaka's own declaration of PlayerConfiguration (dist/shaka-player.compiled.d.ts):
// a key that does not exist in the installed version is a compile error, not a silent no-op.

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/** What `player.configure()` accepts. */
export type ShakaConfigPatch = DeepPartial<shaka.extern.PlayerConfiguration>;

export interface ConfigKnob {
  id: string;
  /** What changes, in Shaka 5.3.3 terms, and the metric and condition in which it should show. Falsifiable on purpose. */
  hypothesis: string;
  patch: ShakaConfigPatch;
}

// Not part of B, deliberately: `streaming.rebufferingGoal`. At 0 (the default) Shaka reports `buffering` from the media
// element's own `waiting`/`playing` events; above 0 it polls the buffer and pauses playback itself (playbackRate 0) when the
// lead falls under 0.5 s. A rebuffer would then mean two different things in the two arms, and the A/B would compare two
// instruments instead of two configurations.
export const B_KNOBS: readonly ConfigKnob[] = [
  {
    id: 'conservative-start',
    patch: { abr: { useNetworkInformation: false, defaultBandwidthEstimate: 500_000 } },
    hypothesis:
      'Until Shaka has measured 128 KB of downloads, the first rung comes from a default bandwidth estimate. In A it is 1 Mbps, ' +
      "but wherever the browser has the Network Information API (Chromium) Shaka replaces it with navigator.connection.downlink, so A's " +
      'first rung depends on the engine. B fixes 500 kbps in every engine, which is below what the 360p variant needs ' +
      '(700 + 64 kbps), so B always starts on the lowest rung. Expected: when the link limits startup (constrained-600, ' +
      "constrained-1500) B's startupMs is lower, because its first segments are 2 to 6 times smaller (300 kbps against 700 or " +
      "1800); B pays one extra 'abr' " +
      'switch (bitrate.switches +1) and the first seconds at low resolution. When only latency limits startup (high-latency) ' +
      'no difference is expected: B does not save a round trip. Rejected if B is not faster under constrained-600.',
  },
  {
    id: 'faster-switching',
    patch: { abr: { switchInterval: 4 } },
    hypothesis:
      'Shaka re-evaluates the rung at most once per abr.switchInterval (8 s in A), so after the link weakens the player keeps ' +
      'requesting the old rung until the next evaluation. B evaluates every 4 s. Expected: under bandwidth-drop B steps down ' +
      'sooner and has fewer and shorter rebuffers (rebuffer.count and totalMs lower). Cost: on a noisy link B changes rung ' +
      'more often (bitrate.switches higher); on a clean link both stay close. Rejected if B does not rebuffer less under ' +
      'bandwidth-drop, or if it switches clearly more often on a clean link.',
  },
  {
    id: 'deeper-buffer',
    patch: { streaming: { bufferingGoal: 20 } },
    hypothesis:
      'Shaka fetches until streaming.bufferingGoal seconds are buffered ahead of the playhead (10 s in A); that lead is what the ' +
      'player lives on when the link slows or an object is late. B keeps up to 20 s. Expected: under bandwidth-drop B has fewer ' +
      'and shorter rebuffers, and its startupMs is not affected (the goal does not delay the first frame). Cost: up to twice ' +
      'the bytes ahead of the playhead (visible in the request log) and memory, and bytes that are wasted when a rung switch ' +
      'abandons the buffered rung. No effect on live, where the playhead is only about 6 s behind the edge. Rejected if ' +
      'startup is slower in B, or if the rebuffer count under bandwidth-drop is no lower.',
  },
];

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge of configuration patches, later ones winning. Arrays and scalars replace; the inputs are not changed. */
export function mergePatches(...patches: ShakaConfigPatch[]): ShakaConfigPatch {
  const out: Record<string, unknown> = {};
  for (const patch of patches) mergeInto(out, patch as Record<string, unknown>);
  return out as ShakaConfigPatch;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const existing = target[key];
    if (isPlainObject(value)) {
      const child: Record<string, unknown> = isPlainObject(existing) ? existing : {};
      mergeInto(child, value);
      target[key] = child;
    } else {
      target[key] = Array.isArray(value) ? structuredClone(value) : value;
    }
  }
}

/** The exact object handed to `player.configure()` for a preset: empty for A. A fresh copy on every call. */
export function configFor(id: ConfigId): ShakaConfigPatch {
  return id === 'B' ? mergePatches(...B_KNOBS.map((knob) => knob.patch)) : {};
}

/** `{ path: 'abr.switchInterval', value: 4 }` for every leaf of a patch, in order. */
export function flattenPatch(patch: unknown, prefix = ''): Array<{ path: string; value: unknown }> {
  if (!isPlainObject(patch)) return prefix === '' ? [] : [{ path: prefix, value: patch }];
  return Object.entries(patch).flatMap(([key, value]) =>
    flattenPatch(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/**
 * The values `source` holds at the leaves of `shape`: given Shaka's configuration before the overrides and the overrides,
 * what each overridden key was. Keys missing from `source` are left out, and so are the objects that end up empty.
 */
export function valuesAtShape(source: unknown, shape: unknown): Record<string, unknown> {
  const found = valuesAt(source, shape);
  return isPlainObject(found) ? found : {};
}

function valuesAt(source: unknown, shape: unknown): unknown {
  if (!isPlainObject(shape)) return source;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(shape)) {
    const value = valuesAt(isPlainObject(source) ? source[key] : undefined, child);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
