import type { FaultRule } from './faults.ts';

// Named network and fault conditions. A profile is a `FaultRule[]` (src/shared/faults.ts): tests attach it to their session
// (`createSession({ faults: profile('constrained-600') })`) or add it to a running one, so the condition is the same in every
// browser engine and every run. TEST_STRATEGY.md section 11 renders its table from the definitions here.
//
// Two design rules:
//  - Rules select requests by segment number, not by wall-clock time, wherever the scenario allows it: "the third video
//    segment fails" is the same in a fast and in a slow run, "after 5 s" is not. Only the bandwidth drop uses time, because a
//    link that weakens is the point of it.
//  - The numbers that matter are tied to the stream ladder of docs/CONTRACTS.md section 3 (video 300, 700 and 1800 kbps plus
//    a 64 kbps audio track, 2 s segments), and the unit tests check the arithmetic in the purposes below.

export interface ProfileDefinition {
  /** Why the profile exists and which expectation it supports. */
  readonly purpose: string;
  /** Catalog ids (TEST_STRATEGY.md section 9) of the tests that use it. */
  readonly usedBy: readonly string[];
  readonly rules: readonly FaultRule[];
}

const DEFINITIONS = {
  clean: {
    purpose:
      'The control condition: no faults. Functional tests that must not be disturbed, and the baseline of the startup and frame-rate scenarios.',
    usedBy: ['PB-VOD-001', 'PB-PERF-001', 'PB-PERF-002', 'PB-PERF-004'],
    rules: [],
  },
  'constrained-1500': {
    purpose:
      'A 1500 kbps link carries the 360p rung with its audio (700 + 64 = 764 kbps) with headroom, but not the 720p rung (1800 + 64 = 1864 kbps): adaptive playback must settle on 360p, and a pinned 720p must struggle.',
    usedBy: ['PB-ABR-005'],
    rules: [{ type: 'throttle', kbps: 1500 }],
  },
  'constrained-600': {
    purpose:
      'A 600 kbps link carries only the 240p rung with its audio (300 + 64 = 364 kbps; 360p needs 764): the slowest connection the ladder can serve.',
    usedBy: ['PB-ABR-006'],
    rules: [{ type: 'throttle', kbps: 600 }],
  },
  'bandwidth-drop': {
    purpose:
      'A connection that weakens mid-title. The first 8 s are four segments, and the Shaka 5.3.3 default minimum switch interval is also 8 s, so the player has had the chance to climb before the link drops to what only the 240p rung can carry. The player must step down with at most one rebuffer.',
    usedBy: ['PB-ABR-002', 'PB-ABR-003', 'PB-ABR-007', 'PB-PERF-003', 'PB-AB-003'],
    rules: [{ type: 'throttle', kbps: 600, afterMs: 8000 }],
  },
  'high-latency': {
    purpose:
      'A distant or congested link: about 300 ms before the first byte of every response, manifests included, with jitter. Startup is a chain of round trips (manifest, initialization segments, first segments), so a configuration that saves a round trip shows up here at about 300 ms, where on localhost the same saving is a few milliseconds below the noise. Jitter is seeded with the session id: a rerun with the same request order sees the same delays.',
    usedBy: ['PB-AB-002'],
    rules: [{ type: 'latency', ms: 300, jitterMs: 100, match: { kind: 'any' } }],
  },
  'flaky-segments': {
    purpose:
      'A CDN hiccup in the middle of a title: the first three requests for video segment 3 fail. Three in a row exceed the two attempts of the default retry policy, so the network layer gives up on that request. What the player does next depends on the engine and on timing (it may disable the rung and switch to another, or its adaptation may abandon the request for a different rung): the test asserts the outcome, which is that it carries on, not the path. Selecting by segment number hits the same segment in every engine, whichever rung is playing.',
    usedBy: ['PB-REC-002'],
    rules: [{ type: 'status', status: 503, match: { kind: 'segment', track: 'video', number: 3 }, times: 3 }],
  },
  'transient-404': {
    purpose:
      'One missed object: a single failure that the default retry policy (two attempts) absorbs, so the member should notice nothing. The counterpart of the burst above: one retry versus the failure path.',
    usedBy: ['PB-REC-001'],
    rules: [{ type: 'status', status: 404, match: { kind: 'segment', track: 'video', number: 3 }, times: 1 }],
  },
  'slow-segment': {
    purpose:
      'A late segment, not a failed one: 8 s is below the default 10 s connection timeout, so the request succeeds, but late, and only the two segments buffered ahead of it (4 s) cover the wait. The player must absorb it with at most one rebuffer and recover on its own.',
    usedBy: ['PB-REC-004'],
    rules: [{ type: 'latency', ms: 8000, match: { kind: 'segment', track: 'video', number: 3 }, times: 1 }],
  },
  'rung-outage': {
    purpose:
      'One rendition is down while the others are healthy. The player must stop asking for it (after the retry policy, not forever), move to another rung and carry on, and the request log must show that the failed requests stay bounded.',
    usedBy: ['PB-REC-003'],
    rules: [{ type: 'status', status: 503, match: { kind: 'media', rep: 'v720' } }],
  },
  'truncated-segment': {
    purpose:
      'A connection that dies mid-download. 20,000 bytes is less than half of the smallest video segment (300 kbps x 2 s = 75,000 bytes), so the body is truncated whichever rung is playing. The segment must be retried, without a decode-error loop.',
    usedBy: ['PB-REC-005'],
    rules: [
      { type: 'abort', afterBytes: 20_000, match: { kind: 'segment', track: 'video', number: 3 }, times: 1 },
    ],
  },
  'manifest-down': {
    purpose:
      'The origin is down at load until the test removes the rule. `load()` must fail with an error in bounded time (not hang), and a retry after the rule is removed must play.',
    usedBy: ['PB-REC-006'],
    rules: [{ type: 'status', status: 503, match: { kind: 'manifest' } }],
  },
  'segments-down': {
    purpose:
      'Nothing can be fetched after the manifest, until the test removes the rule. The player must surface a critical error in bounded time, with every rung tried and given up on, instead of spinning forever.',
    usedBy: ['PB-REC-007'],
    rules: [{ type: 'status', status: 503, match: { kind: 'segment' } }],
  },
} satisfies Record<string, ProfileDefinition>;

export type ProfileName = keyof typeof DEFINITIONS;

export const PROFILE_DEFINITIONS: Readonly<Record<ProfileName, ProfileDefinition>> = DEFINITIONS;
export const PROFILE_NAMES = Object.keys(DEFINITIONS) as ProfileName[];

/** A fresh copy of a profile's rules: a test may add to it or tweak it without touching the shared definition. */
export function profile(name: ProfileName): FaultRule[] {
  return PROFILE_DEFINITIONS[name].rules.map((rule) => structuredClone(rule));
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * The origin stops publishing at live segment `atNumber` for `ms` milliseconds, then catches up (timeline unchanged).
 * A live stall depends on the live segment number, so a test computes it from the session it just created:
 * `originStall(session.live!.edgeNumber + 3, 10_000)` stalls the origin three segments after "now". Returns a one-rule
 * profile, so it composes with the others by spreading.
 */
export function originStall(atNumber: number, ms: number): FaultRule[] {
  assertPositiveInteger('atNumber', atNumber);
  assertPositiveInteger('ms', ms);
  return [{ type: 'live-stall', atNumber, ms }];
}

/**
 * For `ms` milliseconds the manifest endpoint keeps answering with the last version it served before the rule started.
 * `afterMs` (from the first media request) lets the player load a good manifest first; leave it out to start at once.
 */
export function staleManifest(ms: number, afterMs = 0): FaultRule[] {
  assertPositiveInteger('ms', ms);
  if (!Number.isInteger(afterMs) || afterMs < 0) {
    throw new RangeError(`afterMs must be a non-negative integer, got ${afterMs}`);
  }
  return [afterMs > 0 ? { type: 'manifest-stale', ms, afterMs } : { type: 'manifest-stale', ms }];
}

export interface ProfileFactoryDoc {
  readonly signature: string;
  /** The condition in one line. */
  readonly condition: string;
  readonly purpose: string;
  readonly usedBy: readonly string[];
}

/** The live factories, described for the generated table in TEST_STRATEGY.md. */
export const PROFILE_FACTORIES: readonly ProfileFactoryDoc[] = [
  {
    signature: 'originStall(atNumber, ms)',
    condition: 'The live origin stops publishing at segment `atNumber` for `ms`, then catches up.',
    purpose:
      'The live outage. A stall depends on the live segment number, which only the session knows (`SessionInfo.live.edgeNumber`), so it is a factory. The injected length of the readiness checks is 10 s, longer than the 6 s presentation delay, so the buffer must drain.',
    usedBy: ['PB-REC-008', 'PB-RDY-003', 'PB-RDY-005'],
  },
  {
    signature: 'staleManifest(ms, afterMs?)',
    condition: 'The manifest endpoint serves the last version it served before the rule started, for `ms`.',
    purpose:
      'A stale cache, or an origin that stopped updating its manifest while still serving segments: the player must live on its buffer and find its place again when fresh manifests return.',
    usedBy: ['PB-REC-009'],
  },
];
