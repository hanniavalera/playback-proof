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
    seed: 20261104,
  }) as Json;
}

/** The rebuffering experiment: three primary metrics under the (unmodified) bandwidth-drop profile. */
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
        id: 'bandwidth-drop',
        profile: 'bandwidth-drop',
        rules: [{ type: 'throttle', kbps: 600, afterMs: 8000 }],
        rationale:
          'The catalog row names this profile: the link weakens after four segments to what only the lowest rung carries.',
      },
    ],
    observation: { mediaSecondsAfterFirstFrame: 18, sessionTimeoutMs: 120000 },
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
  return {
    ...base,
    id: 'PB-AB-001-high-latency',
    kind: 'aa',
    catalogId: 'PB-AB-001',
    title: 'A/A: configuration A against itself, startup under high latency',
    hypotheses: [
      {
        metric: 'startupMs',
        text: 'Both arms run configuration A, so the harness must find no difference between them.',
      },
    ],
    arms: { A: 'A', B: 'A' },
  };
}
