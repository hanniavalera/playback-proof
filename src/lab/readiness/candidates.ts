import type { ShakaConfigPatch } from '../../player/configs.ts';

// The configurations a readiness run can evaluate besides the build as it ships (A, Shaka's own defaults, which is always evaluated first).
// A candidate is "A plus one knob", applied through `qa.configure()` to a page that is still idle and loaded afterwards (`bootPlayer` in
// checks.ts: Shaka reads some options, `streaming.liveSync.enabled` among them, when it loads), so that the effect can be attributed to
// the knob (docs/decisions/player.md, ADR-064) and so that a readiness check can answer the question it exists for: does a change fix
// what the defaults fail, and does it show GO?

export interface Candidate {
  /** The name on the command line and in the result files. */
  id: string;
  label: string;
  /** What `player.configure()` is given: type-checked against Shaka's own declaration of its configuration, so a key that does not exist in 5.3.3 is a compile error. */
  patch: ShakaConfigPatch;
  /** What it is expected to change, and where it should show: falsifiable, like the knobs of configuration B. */
  hypothesis: string;
}

export const CANDIDATES: readonly Candidate[] = [
  {
    id: 'live-sync',
    label: 'A plus streaming.liveSync.enabled',
    patch: { streaming: { liveSync: { enabled: true } } },
    hypothesis:
      "Shaka 5.3.3's `streaming.liveSync` (off by default) holds the playhead near the live edge by changing the playback rate: when the distance from `seekRange().end` to the playhead exceeds `targetLatency + targetLatencyTolerance` " +
      '(0.5 s + 0.5 s by default) it plays at `maxPlaybackRate` (1.1) until it is back. After a 10 s origin outage the defaults leave the playhead 4 s further behind the edge for good (docs/decisions/e2e-rec.md), which is above the 10 s latency maximum; ' +
      'with live sync on, the playhead gains 0.1 s per second and latency is back under the maximum within seconds. Expected: PB-RDY-003 shows GO for the restore line; PB-RDY-001, 002 and 004 stay GO ' +
      '(a healthy join sits within a second of `seekRange().end`, so the rate stays 1). Rejected if latency is not restored within the limit, or if the healthy checks regress (a sustained rate above 1 on a healthy stream, a longer join).',
  },
];

export function candidateById(id: string): Candidate | undefined {
  return CANDIDATES.find((candidate) => candidate.id === id);
}

/** `--config-json`: any patch, named `custom`. Shaka rejects an unknown key when it is applied (`qa.configure` throws), so a typo cannot pass silently. */
export function customCandidate(json: string): Candidate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SyntaxError(`the configuration is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    throw new TypeError(
      'the configuration must be a non-empty JSON object, for example {"streaming":{"liveSync":{"enabled":true}}}',
    );
  }
  return {
    id: 'custom',
    label: `A plus ${JSON.stringify(parsed)}`,
    patch: parsed as ShakaConfigPatch,
    hypothesis: 'A configuration given on the command line: no hypothesis is recorded for it.',
  };
}
