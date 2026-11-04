// A valid pre-registration of an experiment, as the plain JSON a file holds, for the tests that change one thing at a time.

export type Json = Record<string, unknown>;

export function startupPrereg(): Json {
  return structuredClone({
    schemaVersion: 1,
    id: 'PB-AB-002',
    kind: 'experiment',
    catalogId: 'PB-AB-002',
    title: 'Startup time of configuration B against configuration A under high latency',
    registeredOn: '2026-11-05',
    hypotheses: [
      {
        metric: 'startupMs',
        text: 'Under 300 ms of latency B starts no faster than A: it saves no round trip, so the difference is expected to be zero.',
      },
    ],
    engine: 'chromium',
    stream: 'vod-cmaf',
    protocol: 'dash',
    arms: { A: 'A', B: 'B' },
    conditions: [
      {
        id: 'high-latency',
        profile: 'high-latency',
        rules: [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }],
        rationale:
          'The catalog row names this profile: startup is a chain of round trips and 300 ms makes each one visible.',
      },
    ],
    observation: { mediaSecondsAfterFirstFrame: 0, sessionTimeoutMs: 30000 },
    sessionsPerArm: 30,
    warmupSessionsPerArm: 2,
    alpha: 0.05,
    bootstrapResamples: 5000,
    metrics: [
      {
        id: 'startupMs',
        role: 'primary',
        direction: 'lower-is-better',
        practicalThreshold: 100,
        thresholdBasis: 'A tenth of a second is the smallest startup change a viewer notices on a page load.',
        minimumDetectableEffect: {
          value: 80,
          sessionsPerArm: 30,
          power: 0.8,
          source: 'docs/results/ab/pilot-high-latency.json',
        },
      },
    ],
    decisionRule: {
      id: 'pb-ab-v1',
      text: 'Ship B only if it is better on a primary metric beyond the threshold and not worse on any; do not ship B if it is worse beyond the threshold with an interval that excludes zero; otherwise keep A.',
    },
    exclusionRule: {
      text: 'A session that errors or times out is a failed session: it is reported and never silently dropped; its metrics are left out of the comparison.',
      maxFailedShare: 0.1,
      abortAfterConsecutiveFailures: 5,
    },
    aaCheck: { source: AA_SOURCE },
    seed: 20261104,
  }) as Json;
}

/** The committed report of the real A/A run (PB-AB-001) that the experiments of these tests rely on. */
export const AA_SOURCE =
  'docs/results/ab/PB-AB-001-high-latency.local-darwin-arm64.20261101T090000Z.report.json';
export const AA_SOURCE_REBUFFER =
  'docs/results/ab/PB-AB-001-bandwidth-drop-finite.local-darwin-arm64.20261101T100000Z.report.json';

/** What the report JSON of an A/A run that passed says, as far as an experiment reads it (ab/validity.ts `checkAaReport`). */
export function passingAaReport(over: Json = {}, condition = 'high-latency'): string {
  return JSON.stringify({
    kind: 'ab-report',
    experiment: { id: 'PB-AB-001-x', kind: 'aa' },
    environment: { envId: 'local-darwin-arm64' },
    design: { engine: 'chromium' },
    validity: { valid: true },
    conditions: [{ id: condition, aa: { acceptable: true, ideal: true } }],
    calibrations: [{ condition, result: { pass: true } }],
    ...over,
  });
}

/** The rebuffering experiment: its primary metric under the finite variant of the bandwidth-drop profile (see the condition). */
export function rebufferPrereg(): Json {
  const base = startupPrereg();
  return {
    ...base,
    id: 'PB-AB-003',
    catalogId: 'PB-AB-003',
    title: 'Rebuffering of configuration B against configuration A under a bandwidth drop',
    hypotheses: [
      {
        metric: 'rebufferShare',
        text: 'B steps down sooner after the link drops and buffers deeper, so fewer sessions stall at all.',
      },
    ],
    conditions: [
      {
        id: 'bandwidth-drop-finite',
        profile: null,
        rules: [
          { type: 'throttle', kbps: 20000 },
          { type: 'throttle', kbps: 600, afterMs: 8000 },
        ],
        rationale:
          'The catalog profile bandwidth-drop with its first 8 s on a finite 20 Mbps link instead of an unthrottled one (the slowest throttle wins, so the link is 600 kbps from 8 s on), because the player ignores downloads under 5 ms and an unthrottled start would not be heard.',
      },
    ],
    observation: { mediaSecondsAfterFirstFrame: 18, sessionTimeoutMs: 120000 },
    aaCheck: { source: AA_SOURCE_REBUFFER },
    metrics: [
      {
        id: 'rebufferShare',
        role: 'primary',
        direction: 'lower-is-better',
        practicalThreshold: 0.2,
        thresholdBasis:
          'One session in five stalling more or less often is what the team would change a default for.',
        minimumDetectableEffect: {
          value: 0.2,
          sessionsPerArm: 30,
          power: 0.8,
          source: 'docs/results/ab/pilot-bandwidth-drop.json',
        },
      },
      { id: 'rebufferRatio', role: 'secondary', direction: 'lower-is-better' },
    ],
  };
}

/** The real interleaved A/A run (PB-AB-001): configuration A in both arms, startup under high latency. */
export function aaPrereg(): Json {
  const base = startupPrereg();
  const plan: Json = {
    ...base,
    id: 'PB-AB-001-high-latency',
    kind: 'aa',
    catalogId: 'PB-AB-001',
    title: 'A/A: configuration A against itself, startup under high latency',
    hypotheses: [
      {
        metric: 'startupMs',
        text: 'Both arms run configuration A, so the harness must not call either arm better.',
      },
    ],
    arms: { A: 'A', B: 'A' },
  };
  delete plan.aaCheck;
  return plan;
}
