// The lab's policy numbers in one place: live-event readiness limits, the time budgets of the gates, the flake policy and the
// risk-tiering thresholds. TEST_STRATEGY.md renders its tables from this file (`npm run docs:check` fails when they are stale) and
// the harnesses import the same numbers, so a limit cannot differ between the document and the check that enforces it.
//
// STATUS: every number below is INITIAL POLICY, set in Phase 1 before any component existed. Nothing here was measured.
// Phase 7 validates all of them against measurements (the readiness limits against live runs; the gate budgets and the
// per-test estimates against the CI timings that Phases 3 to 5 produce) and revises them with evidence: a revised entry
// changes its basis to `measured` and names the artifact it came from in docs/results. Each entry says where its number
// comes from:
//   fact        copied from a configuration value (the Playwright config, the contracts, an ADR); a test checks the copy
//   arithmetic  computed from other numbers by the stated rule, so it follows when its inputs change
//   assumption  a judgment with no formula behind it
//
// Code that enforces a policy imports the plain numbers (`LIVE_LIMITS.latencyMaxMs`); the documents render the whole entry.

export type PolicyUnit = 'ms' | 's' | 'min' | 'days' | 'count' | 'score' | 'ratio' | 'MB' | 'x';
export type BasisKind = 'fact' | 'arithmetic' | 'assumption' | 'measured';

export interface Policy {
  /** Short name used in the generated tables. */
  readonly label: string;
  readonly value: number;
  readonly unit: PolicyUnit;
  /** What is measured, where, and how the limit is applied. */
  readonly measure: string;
  /** Where the number comes from. */
  readonly basis: { readonly kind: BasisKind; readonly text: string };
}

function entry(
  kind: BasisKind,
  label: string,
  value: number,
  unit: PolicyUnit,
  measure: string,
  text: string,
): Policy {
  return { label, value, unit, measure, basis: { kind, text } };
}
const fact = (label: string, value: number, unit: PolicyUnit, measure: string, basis: string): Policy =>
  entry('fact', label, value, unit, measure, basis);
const arithmetic = (label: string, value: number, unit: PolicyUnit, measure: string, basis: string): Policy =>
  entry('arithmetic', label, value, unit, measure, basis);
const assumption = (label: string, value: number, unit: PolicyUnit, measure: string, basis: string): Policy =>
  entry('assumption', label, value, unit, measure, basis);

/** The plain numbers of a policy, for code that enforces it (`LIVE_LIMITS.latencyMaxMs`). */
export function limitsOf<T extends Record<string, Policy>>(policy: T): { readonly [K in keyof T]: number } {
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(policy)) out[key] = p.value;
  return out as { readonly [K in keyof T]: number };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live-event readiness

/**
 * Facts about the simulated live stream that the readiness limits are derived from. They mirror docs/CONTRACTS.md section 3
 * ("Live simulation": 2 s segments, a 15-segment window, a 6 s presentation delay, `minimumUpdatePeriod` PT2S, a 24 s looped
 * source). The test data service must use the same defaults: change them together.
 */
export const LIVE_FACTS = {
  segmentSec: 2,
  windowSegments: 15,
  presentationDelaySec: 6,
  manifestUpdatePeriodSec: 2,
  sourceLoopSec: 24,
} as const;

const SEGMENT_MS = LIVE_FACTS.segmentSec * 1000;
const WINDOW_SEC = LIVE_FACTS.segmentSec * LIVE_FACTS.windowSegments;
const MANIFEST_PERIOD_MS = LIVE_FACTS.manifestUpdatePeriodSec * 1000;
const CI_SOAK_MIN = 5;
const RELEASE_SOAK_MIN = 30;

const latencyTarget = arithmetic(
  'Latency target',
  LIVE_FACTS.presentationDelaySec * 1000,
  'ms',
  'A reference, not a limit: where the playhead sits behind the live edge.',
  'The `suggestedPresentationDelay` of the live manifest: three segments of 2 s.',
);
const injectedStall = assumption(
  'Injected origin stall',
  10_000,
  'ms',
  'A scenario parameter, not a limit: how long PB-REC-008 and PB-RDY-003 stop the origin from publishing.',
  `Longer than the ${LIVE_FACTS.presentationDelaySec} s presentation delay, so the buffer is certain to drain and the player really stalls; short enough to be a realistic origin hiccup.`,
);

/** Live-event readiness (TEST_STRATEGY.md section 8, PB-RDY rows). Metric definitions: docs/METRICS.md. */
export const LIVE_READINESS = {
  startSamples: assumption(
    'Joins sampled',
    5,
    'count',
    'Fresh sessions joined one after another at different positions inside a segment interval (PB-RDY-001).',
    'Five is enough to expose a systematic start problem and keeps the check near 40 s. The worst join is judged, because a member only experiences their own.',
  ),
  startMaxMs: assumption(
    'Start time, worst join',
    5_000,
    'ms',
    '`startupMs` (load-requested to firstframe) of every sampled join; the maximum is compared.',
    'About 2.5 segments. A join on localhost is a handful of small requests, so the limit is loose on purpose: it fails a join that is plainly broken under event conditions, while the performance gate (PB-PERF-001) detects small regressions. Phase 7 replaces it with a multiple of the measured join time.',
  ),
  latencyTargetMs: latencyTarget,
  latencyP95MaxMs: arithmetic(
    'Latency, p95',
    latencyTarget.value + SEGMENT_MS,
    'ms',
    'p95 of the `latencyMs` samples over the measurement window after the first frame.',
    'Target plus one segment: the stream is GOP-aligned to the segment, so a start, seek or catch-up position is only defined to within one segment.',
  ),
  latencyMaxMs: arithmetic(
    'Latency, maximum',
    latencyTarget.value + 2 * SEGMENT_MS,
    'ms',
    'Largest `latencyMs` sample outside an injected fault window.',
    'Target plus two segments: one segment of positioning granularity and one of manifest-refresh lag. Beyond it the player is further behind than the system can explain.',
  ),
  injectedStallMs: injectedStall,
  stallRecoveryMaxMs: arithmetic(
    'Stall recovery',
    injectedStall.value + 2 * SEGMENT_MS,
    'ms',
    'From `buffering-start` to the next `playing` during the injected stall; the worst of the repeated runs is judged.',
    'The origin outage plus two segments: one manifest-refresh interval and one segment fetch after the origin returns. The player may stall for less than the outage (it has buffer), never for more than this.',
  ),
  latencyRestoreMaxMs: assumption(
    'Latency restored after a stall',
    60_000,
    'ms',
    'Time from recovery (`playing`) until `latencyMs` is back within the maximum above.',
    'A member who lived through an outage should be back at the live edge within about a minute (30 segments). Phase 7 measures what the default configuration and the candidate really achieve: a limit the default cannot meet is a finding, not a number to relax.',
  ),
  manifestPeriodMs: fact(
    'Manifest update period',
    MANIFEST_PERIOD_MS,
    'ms',
    'A reference, not a limit: the update period the origin advertises.',
    'docs/CONTRACTS.md section 3: DASH `minimumUpdatePeriod` PT2S; the HLS target duration is the same 2 s.',
  ),
  manifestMaxGapMs: arithmetic(
    'Manifest refresh, longest gap',
    2 * MANIFEST_PERIOD_MS,
    'ms',
    'Longest gap between consecutive manifest (or media playlist) requests in the request log, outside injected faults.',
    'Two update periods: one period of tolerance for fetch time and timer granularity. Two missed periods means the player has stopped tracking the window.',
  ),
  manifestMedianGapMinMs: arithmetic(
    'Manifest refresh, shortest median gap',
    MANIFEST_PERIOD_MS / 2,
    'ms',
    'Median gap between consecutive manifest requests, outside injected faults.',
    'Half the period. Polling twice as fast as advertised doubles the load on the origin, and at the scale of a live event every member polls.',
  ),
  warmupSec: arithmetic(
    'Soak warm-up',
    2 * WINDOW_SEC,
    's',
    'Excluded from the drift, ratio and heap baselines of a soak.',
    'Two DVR windows (2 x 30 s): the window has turned over twice, the bandwidth estimate and the JIT have settled.',
  ),
  soakMinutesCi: assumption(
    'Soak, CI',
    CI_SOAK_MIN,
    'min',
    'Duration of the short soak that runs in the nightly pipeline.',
    `${CI_SOAK_MIN * 60} s covers ${(CI_SOAK_MIN * 60) / WINDOW_SEC} DVR windows and ${Math.floor((CI_SOAK_MIN * 60) / LIVE_FACTS.sourceLoopSec)} source loops: enough to see loop-boundary, window-slide and drift problems, cheap enough to run every night.`,
  ),
  soakMinutesRelease: assumption(
    'Soak, release',
    RELEASE_SOAK_MIN,
    'min',
    'Duration of the soak that must pass before a release.',
    `${RELEASE_SOAK_MIN * 60} s covers ${(RELEASE_SOAK_MIN * 60) / WINDOW_SEC} DVR windows and ${Math.floor((RELEASE_SOAK_MIN * 60) / LIVE_FACTS.sourceLoopSec)} source loops, about as long as one job can hold a runner. A real event is longer, so the result is an extrapolation (TEST_STRATEGY.md section 13).`,
  ),
  maxUnrecoveredStalls: assumption(
    'Unrecovered stalls',
    0,
    'count',
    'Buffering episodes that last longer than the stall recovery limit or never end, over the soak.',
    'Zero tolerance: a stall that outlasts the limit is a hung player.',
  ),
  maxCriticalErrors: assumption(
    'Critical errors',
    0,
    'count',
    'Shaka errors with severity 2 in `qa.metrics().errors` over the soak.',
    'A critical error ends a viewing session. Recoverable errors are counted and reported, and must be explained by an injected fault.',
  ),
  maxRebufferRatio: assumption(
    'Rebuffer ratio',
    0.005,
    'ratio',
    'Rebuffer ratio (METRICS.md) over the soak after the warm-up, outside injected faults.',
    '0.5%: 1.5 s of stall in the 5-minute soak, 9 s in the 30-minute one. The expected value on a clean localhost session is zero; the allowance absorbs a loaded shared runner.',
  ),
  maxLatencyDriftMs: assumption(
    'Latency drift',
    SEGMENT_MS / 2,
    'ms',
    'Median `latencyMs` of the last quarter of the soak minus the median of the first quarter after the warm-up.',
    'Half a segment. A trend that large means the playhead is slipping relative to the edge; smaller differences are within what segment-granular positioning and timer jitter explain.',
  ),
  maxHeapGrowthMb: assumption(
    'JS heap growth (Chromium only)',
    20,
    'MB',
    'JS heap after a forced collection (DevTools protocol) at the end of the soak minus the value after the warm-up.',
    'The player keeps kilobytes of bookkeeping per segment, so 20 MB over 30 minutes is far beyond a normal sawtooth after collection: crossing it means a leak. The 5-minute soak uses the same number, so it only catches gross leaks; the release soak catches slow ones.',
  ),
  maxDroppedFrameRatio: assumption(
    'Dropped frame ratio',
    0.01,
    'ratio',
    'Dropped / decoded frames (METRICS.md) over the soak.',
    'A round number for "a few frames in a hundred". On a clean localhost run the expected value is near zero, so the limit guards against regressions rather than against a perceptual threshold.',
  ),
} satisfies Record<string, Policy>;

export const LIVE_LIMITS = limitsOf(LIVE_READINESS);

// ---------------------------------------------------------------------------------------------------------------------
// Gate time budgets (TEST_STRATEGY.md section 6)

/**
 * Design estimate of the wall-clock of one browser test, by catalog area. It is built from the parts a test cannot avoid:
 * the page and player boot, the startup, the media seconds the scenario waits for in real time (media plays at 1x), and the
 * fault's own duration. Phase 3 replaces these with measured durations; the budget check in `npm run docs:check` then
 * re-runs on the new numbers.
 */
export const TEST_SECONDS_BY_AREA = {
  VOD: assumption(
    'VOD',
    12,
    's',
    'One VOD browser test.',
    '3 s page and player boot + 1.5 s startup + about 6 s of real-time media waits (a 3 s play window, a seek, a second window) + 1.5 s teardown and slack.',
  ),
  ABR: assumption(
    'ABR',
    28,
    's',
    'One ABR browser test.',
    '3 s boot + 1.5 s startup + 8 s until the throttle starts + 12 s for the adaptation to react (the Shaka 5.3.3 default minimum switch interval is 8 s) + 3.5 s slack.',
  ),
  LIVE: assumption(
    'LIVE',
    20,
    's',
    'One live browser test.',
    '3 s boot + 2 s join + 12 s of observation (six manifest refreshes at the 2 s update period) + 3 s slack.',
  ),
  REC: assumption(
    'REC',
    20,
    's',
    'One recovery browser test.',
    '3 s boot + 1.5 s startup + the fault itself (a retry back-off of 1 to 3 s; for the live case a 10 s origin stall) + 4 s recovery + slack.',
  ),
  ENV: assumption(
    'ENV',
    8,
    's',
    'One environment browser test.',
    '3 s boot + about 3 s for the in-page decode probe + slack.',
  ),
  EME: assumption(
    'EME',
    12,
    's',
    'One ClearKey browser test.',
    'Like VOD, plus the license round trip (a local key, no network).',
  ),
} satisfies Record<string, Policy>;

/** Design estimate of one measured run of a performance scenario (one fresh browser context), by catalog id. */
export const PERF_SECONDS_PER_RUN = {
  'PB-PERF-001': assumption(
    'PB-PERF-001 startup',
    5,
    's',
    'One run.',
    '3 s boot + 1.5 s startup + 0.5 s teardown.',
  ),
  'PB-PERF-002': assumption(
    'PB-PERF-002 frame rate',
    12,
    's',
    'One run.',
    '3 s boot + 1.5 s startup + 2 s warm-up + a 5 s measured media window + 0.5 s teardown.',
  ),
  'PB-PERF-003': assumption(
    'PB-PERF-003 rebuffering',
    23,
    's',
    'One run.',
    '3 s boot + 1.5 s startup + 8 s until the throttle + about 10 s to observe the adaptation + 0.5 s teardown.',
  ),
  'PB-PERF-004': assumption(
    'PB-PERF-004 low-end profile',
    15,
    's',
    'One run under the 4x CPU throttle.',
    '6 s boot and startup (the throttle slows both) + 2 s warm-up + a 5 s measured window + 2 s teardown.',
  ),
} satisfies Record<string, Policy>;

const CI_WORKERS = 2;
const TEST_TIMEOUT_SEC = 45;
const CI_RETRIES = 1;
const JOB_SETUP_SEC = 90;
const MERGE_JOB_SEC = 480;
const AVERAGE_TEST_SEC = 20;
const PERF_RUNS = 10;
const FAILURE_ALLOWANCE_SEC = TEST_TIMEOUT_SEC * (1 + CI_RETRIES);
const testSeconds = Object.values(TEST_SECONDS_BY_AREA).map((p) => p.value);
const slowestPerfScenarioSec =
  Math.max(...Object.values(PERF_SECONDS_PER_RUN).map((p) => p.value)) * PERF_RUNS;

export const GATE_BUDGETS = {
  ciCores: assumption(
    'CI runner cores (design target)',
    2,
    'count',
    'The runner class the budgets are sized for.',
    'The smallest common CI runner class. A larger runner only adds headroom.',
  ),
  ciWorkers: fact(
    'Playwright workers in CI',
    CI_WORKERS,
    'count',
    'Parallel browser tests in one job.',
    'playwright.config.ts: `workers` is 2 when `CI` is set (override with `PB_WORKERS`).',
  ),
  testTimeoutSec: fact(
    'Timeout of one browser test',
    TEST_TIMEOUT_SEC,
    's',
    'Playwright `timeout`: a test that has not finished by then fails.',
    'playwright.config.ts: `timeout: 45_000`.',
  ),
  ciRetries: fact(
    'Retries in CI',
    CI_RETRIES,
    'count',
    'A failed test is re-run this many times; a pass on retry is recorded as a flake.',
    'playwright.config.ts: `retries` is 1 when `CI` is set.',
  ),
  staticAndUnitSec: assumption(
    'Static checks plus unit tests',
    240,
    's',
    'Wall-clock of `gate:static` and `gate:unit` together.',
    'Four minutes. Typecheck, lint, format and the docs check take tens of seconds each; Vitest includes the tests that run real ffmpeg. Measured in Phase 4 once the job exists.',
  ),
  mergeJobSec: assumption(
    'Merge job, one engine',
    MERGE_JOB_SEC,
    's',
    'Wall-clock of the `@merge` browser job of one engine on the design-target runner (2 cores, 2 workers).',
    'Eight minutes: about where a pull request author stops waiting and starts something else. The jobs of the engines run in parallel, so the pull request waits for the slowest.',
  ),
  perfJobSec: assumption(
    'Performance gate job',
    720,
    's',
    'Wall-clock of one performance job (one environment, its profiles) when no metric fails.',
    'Twelve minutes. Performance runs are serial (one browser at a time) and must not share the machine; the table in section 6 adds up the scenarios.',
  ),
  perfRemeasureSec: assumption(
    'Performance re-measure',
    360,
    's',
    'Extra time allowed when a metric fails and the gate re-measures it with fresh runs.',
    `One scenario of N runs at the slowest per-run estimate (${PERF_RUNS} x ${slowestPerfScenarioSec / PERF_RUNS} s = ${slowestPerfScenarioSec} s) plus margin. Only a failing build pays it.`,
  ),
  releaseE2eJobSec: assumption(
    'Release job, browser tests, one engine',
    900,
    's',
    'Wall-clock of the `@merge` plus `@release` browser tests of one engine (the soak and the readiness checks run in their own jobs).',
    'Fifteen minutes: the release gate runs nightly and before a release, so it can afford about twice the merge budget.',
  ),
  jobSetupSec: assumption(
    'Job setup',
    JOB_SETUP_SEC,
    's',
    'Checkout, `npm ci` from the cache, browser from the cache or image, stream cache restore, service start.',
    'Warm caches. Cold caches cost more and are a CI-infrastructure problem, not a test-count problem.',
  ),
  failureAllowanceSec: arithmetic(
    'Failure allowance',
    FAILURE_ALLOWANCE_SEC,
    's',
    'Time added to a browser job for one failing test.',
    `One test that runs into its timeout (${TEST_TIMEOUT_SEC} s) and again on its retry: timeout x (1 + retries).`,
  ),
  averageTestSec: assumption(
    'Average browser test (for the ceiling)',
    AVERAGE_TEST_SEC,
    's',
    'Average wall-clock of one browser test, used only to turn the merge budget into a ceiling.',
    `Conservative: the per-area estimates run from ${Math.min(...testSeconds)} s to ${Math.max(...testSeconds)} s. The catalog is checked against those estimates, not against this average.`,
  ),
  maxMergeTestsPerEngine: arithmetic(
    'Ceiling: merge-tier browser tests per engine',
    Math.floor(((MERGE_JOB_SEC - JOB_SETUP_SEC - FAILURE_ALLOWANCE_SEC) * CI_WORKERS) / AVERAGE_TEST_SEC),
    'count',
    'Most `@merge` browser tests one engine may carry.',
    `(merge job - setup - failure allowance) x workers / average test = (${MERGE_JOB_SEC} - ${JOB_SETUP_SEC} - ${FAILURE_ALLOWANCE_SEC}) x ${CI_WORKERS} / ${AVERAGE_TEST_SEC}.`,
  ),
  cpuSlowdown: assumption(
    'Browser test under the 4x CPU throttle',
    1.5,
    'x',
    'How much longer a browser test takes in the `chromium-cpu4x` project.',
    'The throttle slows main-thread work fourfold (page boot, manifest parsing, our instrumentation) but not the media clock or the network, so a whole test is slower by less than 4x. Measured in Phase 3.',
  ),
  perfRunsPerScenario: fact(
    'Runs per performance scenario',
    PERF_RUNS,
    'count',
    'Fresh-context runs behind every median and p90.',
    'ADR-004 in docs/DESIGN_DECISIONS.md: every scenario runs N times, default 10.',
  ),
} satisfies Record<string, Policy>;

export const GATE_LIMITS = limitsOf(GATE_BUDGETS);

// ---------------------------------------------------------------------------------------------------------------------
// Flake policy (TEST_STRATEGY.md section 7, ADR-022)
//
// The binomial arithmetic behind the numbers (computed, not measured). For a test that really flakes with probability p per run:
//   P(at least 2 flaky outcomes in 30 runs):  p = 1%: 3.6%   p = 5%: 44.6%   p = 10%: 81.6%   p = 20%: 98.9%
//   P(a merge job of 15 tests has at least one retried test):  p = 0.5%: 7.2%   p = 1%: 14.0%   p = 2%: 26.1%

export const FLAKE_POLICY = {
  windowRuns: assumption(
    'Window',
    30,
    'count',
    'The last N executions of a test (for its own rate) and the last N builds (for the suite rate).',
    'Large enough that bad luck rarely condemns a healthy test: a test that flakes 1% of the time shows two flaky outcomes in 30 runs only 3.6% of the time. Small enough that a fixed test leaves the window within weeks.',
  ),
  minRunsToJudge: assumption(
    'Minimum runs before a test is judged',
    20,
    'count',
    'A test with fewer executions in the window has no verdict (it is reported as "not enough data").',
    'Below 20 runs one flaky outcome is already 5% or more: too little evidence for a blocking decision.',
  ),
  quarantineTriggerRate: assumption(
    'Quarantine trigger, per test',
    0.05,
    'ratio',
    'Flake rate (METRICS.md: passed only after a retry / executions) of one test over the window; above it the test must be fixed or quarantined, and the flake gate fails until one of the two happens.',
    'Above 5% means two flaky outcomes in a 30-run window (2/30 = 6.7%; one is 3.3%). A test that flakes 5% of the time is caught in 45% of windows, one at 10% in 82%, one at 20% in 99%: the worst offenders go first and the healthy ones are left alone.',
  ),
  suiteBudgetRate: assumption(
    'Flake budget of the gate, per engine job',
    0.02,
    'ratio',
    'Retried-then-passed executions / all executions of the merge-tier browser tests of one engine over the window; above it the flake gate fails.',
    'The goal is well under 1% (at 1% per test a merge job of about 15 tests needs a retry in 14% of builds, at 2% in 26%). 2% is the red line: it still tolerates one moderately flaky test, and it fails when flakiness spreads across tests, which points at the environment rather than at one test.',
  ),
  quarantineMaxAgeDays: assumption(
    'Quarantine, maximum age',
    14,
    'days',
    'Days from the quarantine date to its expiry, for a release-tier test.',
    'Two weeks: long enough to reproduce and fix a timing problem in a media test, short enough that a quarantined test cannot be forgotten.',
  ),
  mergeQuarantineMaxAgeDays: assumption(
    'Quarantine, maximum age, merge-tier test',
    7,
    'days',
    'Days from the quarantine date to its expiry, for a merge-tier test; it must be fixed or replaced by then.',
    'A quarantined merge-tier test leaves a hole in the gate over a high-risk scenario (score 15 or more), so the hole is kept short.',
  ),
} satisfies Record<string, Policy>;

export const FLAKE_LIMITS = limitsOf(FLAKE_POLICY);

// ---------------------------------------------------------------------------------------------------------------------
// Risk tiering (TEST_STRATEGY.md section 4, ADR-020)

export const RISK_TIERING = {
  mergeMinScore: assumption(
    'Merge threshold',
    15,
    'score',
    'Risk score (likelihood x impact) from which a test in the `e2e` or `perf` lane gates a merge.',
    '15 = 3 x 5: a possible (L3) blocker (I5) gates a merge, and so does a likely (L4) interruption (I4 gives 16). A possible interruption or a likely degradation (3 x 4 = 4 x 3 = 12) does not. Lowering it to 12 would double the merge tier and leave its job without headroom (ADR-020).',
  ),
  releaseMinScore: assumption(
    'Release threshold',
    8,
    'score',
    'Risk score from which a test in the `e2e` or `perf` lane gates a release. Below it a scenario is exploratory: not automated.',
    '8 = 2 x 4: an unlikely (L2) interruption (I4), or a possible (L3) minor degradation (I3 gives 9). Below it a failure is a nuisance a person finds by hand faster than a suite finds it.',
  ),
} satisfies Record<string, Policy>;

export const RISK_LIMITS = limitsOf(RISK_TIERING);

export type Lane = 'e2e' | 'live' | 'perf' | 'ab' | 'unit';
export type GateTier = 'merge' | 'release';

/**
 * How a lane's tier is decided. `by-score` lanes follow the risk score. The others are fixed by cost: a unit test runs in
 * milliseconds, so it gates every merge whatever its score; a readiness or A/B run needs minutes of wall-clock and a quiet
 * machine, so it can only gate a release.
 */
export const LANE_TIER: Readonly<Record<Lane, 'by-score' | GateTier>> = {
  e2e: 'by-score',
  perf: 'by-score',
  unit: 'merge',
  live: 'release',
  ab: 'release',
};

/** The band a risk score falls in, before cost is taken into account. */
export function riskBand(score: number): GateTier | 'exploratory' {
  if (score >= RISK_LIMITS.mergeMinScore) return 'merge';
  if (score >= RISK_LIMITS.releaseMinScore) return 'release';
  return 'exploratory';
}

/** The tier a catalog row must have, or null when the score is below the line (the scenario is not automated). */
export function tierFor(score: number, lane: Lane): GateTier | null {
  const band = riskBand(score);
  if (band === 'exploratory') return null;
  const rule = LANE_TIER[lane];
  return rule === 'by-score' ? band : rule;
}
