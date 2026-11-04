import type { Tier } from '../flake/run.ts';

// The shapes of failure triage (docs/TRIAGE.md). A `Failure` is what the collector reads out of a Playwright report and the failure
// attachments of docs/CONTRACTS.md section 7.2; a `Cluster` is what the deterministic clustering makes of them; a `TriageReport` is
// what the writers print. They are plain data (JSON-safe), so that a fixture is a file and a report is a file.

export const REPORT_SCHEMA_VERSION = 1;

/** What a test came to, for the tests triage reads: failed or timed out on every attempt, or failed and then passed on a retry. */
export type FailureOutcome = 'failed' | 'timedOut' | 'flaky';

/** A frame of the failure's stack in the lab's own code (never `node_modules`, never Playwright's own frames). */
export interface StackFrame {
  /** Relative to the repository root, with `/`. */
  file: string;
  /** The function the frame names; null for the body of a test (an anonymous function). */
  fn: string | null;
  line: number | null;
}

export interface FailureError {
  /** The whole message of the first failing attempt, without colour codes, cut to `MAX_MESSAGE_CHARS`. */
  message: string;
  /** Application frames only, the top one first, at most `MAX_FRAMES`. */
  frames: StackFrame[];
}

/** A Shaka error as the hook recorded it (`QAError`): the code is what names the cause, the name is for a reader. */
export interface ShakaErrorDigest {
  code: number;
  codeName: string | null;
  /** Shaka's category (1 network, 3 media, 4 manifest, 6 DRM...). 0 for an error of the page itself. */
  category: number;
  /** 1 recoverable, 2 critical. */
  severity: number;
  message: string;
  source: string | null;
}

/** One fault rule of the session, and what the request log says it did. */
export interface FaultDigest {
  id: string;
  /** `status`, `abort`, `throttle`...; null when the session detail was not attached. */
  type: string | null;
  /** The rule as the session stored it, as a short text (`status 503 on segment v360`), null when unknown. */
  description: string | null;
  /** How many requests of the log name this rule. */
  fired: number;
}

export interface RequestFailureDigest {
  seq: number;
  kind: string;
  rep: string | null;
  number: number | null;
  status: number;
  /** `fault-abort`, `error` or null: a client hang-up is not a failure of the origin and never listed here. */
  abortReason: string | null;
  faults: string[];
}

/** What the server saw (`request-log.json`), read the way docs/CONTRACTS.md section 4 says an origin failure is read. */
export interface RequestLogDigest {
  entries: number;
  segments: number;
  manifests: number;
  inits: number;
  other: number;
  /** A status of 400 or more, or a response the origin cut (`fault-abort`, `error`). A client's hang-up is not one. */
  originFailures: number;
  /** Origin failures on a request no fault rule named: the origin failed by itself. */
  originFailuresWithoutFault: number;
  /** Requests the client hung up on (`client-closed`): normal for a player that seeks or switches rung. */
  clientAborted: number;
  pending: number;
  /** Count of answers by status, `0` for a request that never got a head. Sorted by status. */
  byStatus: Record<string, number>;
  /** The first failures of the origin, in arrival order, at most `MAX_LISTED_REQUESTS`. */
  failed: RequestFailureDigest[];
}

export interface ConsoleDigest {
  errors: number;
  warnings: number;
  pageErrors: number;
  /** The first distinct error and page-error lines, each cut, at most `MAX_CONSOLE_SAMPLES`. */
  samples: string[];
}

export interface MetricsDigest {
  state: string | null;
  startupMs: number | null;
  rebuffers: { count: number; totalMs: number } | null;
  frames: { decoded: number; dropped: number } | null;
  liveLatencyMs: number | null;
  bitrateSwitches: number | null;
  currentTime: number | null;
}

export interface EventsDigest {
  total: number;
  /** Event names in order of first appearance, with how many times each happened. */
  names: Record<string, number>;
  /** A few events around the failure, one line each, for a person and for the prompt. */
  around: string[];
}

/** What the failure attachments said, as digests; every field is empty or null when its attachment was not there. */
export interface DiagnosticsDigest {
  /** The names of the lab's attachments that were found (`qa-events.json`, `request-log-2.json`...). */
  attached: string[];
  players: number;
  sessions: number;
  /** Distinct Shaka errors in order of appearance (from the timeline and the metrics). */
  shakaErrors: ShakaErrorDigest[];
  /** The first critical error: the one that ended playback. Null when the player never reported one. */
  primaryError: ShakaErrorDigest | null;
  metrics: MetricsDigest;
  events: EventsDigest;
  requestLog: RequestLogDigest | null;
  faults: FaultDigest[];
  console: ConsoleDigest;
  /** `diagnostics-problems.json`: what the fixture could not read. */
  problems: Record<string, string>;
  userAgent: string | null;
  config: string | null;
  loadMode: string | null;
}

export interface Annotation {
  type: string;
  description: string;
}

/**
 * A test, or the run itself (`scope: 'run'`: Playwright's own errors such as a global setup that threw, where no test ever started),
 * that failed or flaked.
 */
export interface Failure {
  scope: 'test' | 'run';
  /** `PB-VOD-001`, or the full title of a test that has no catalog id, or `(run)`. */
  id: string;
  title: string;
  /** The spec file, relative to the repository root. Empty for the run. */
  file: string;
  line: number | null;
  /** The Playwright project, which is the engine job: `chromium`, `firefox`, `webkit`, `chromium-cpu4x`. `(run)` for the run. */
  project: string;
  tags: string[];
  tier: Tier | null;
  outcome: FailureOutcome;
  /** The retries the project was configured with, and the attempts the test used. */
  retries: number;
  attempts: number;
  failedAttempts: number;
  /** Which attempt (0 based) the error and the attachments are from: the first one that failed. */
  attempt: number;
  durationMs: number;
  quarantined: boolean;
  experimental: boolean;
  /** The annotations of the test and of the attempt that failed (`skip`, `environment`, `evidence-drift`, `recovery`...). */
  annotations: Annotation[];
  /** `detectEnvId()` of the run that made it, when a flake run file or the environment annotation says. */
  envId: string | null;
  /** The report it was read from, relative to the directory that was read. */
  source: string;
  error: FailureError;
  diagnostics: DiagnosticsDigest;
  /** What could not be read, and why: a launch failure has no attachments, and that is said here, not hidden. */
  missing: string[];
}

/** A test that did not run, and the reason it carries (a documented gap). */
export interface SkippedTest {
  id: string;
  project: string;
  /** The `skip` annotation's text. Null when there is none: a silent skip is a bug. */
  reason: string | null;
  source: string;
}

export interface SourceSummary {
  /** Relative to the directory that was read. */
  path: string;
  tests: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  interrupted: number;
  /** Errors of the run itself (`errors[]` of the report). */
  runErrors: number;
  startTime: string | null;
  durationMs: number | null;
}

export interface Collection {
  failures: Failure[];
  skipped: SkippedTest[];
  sources: SourceSummary[];
  /** Files that could not be read or are not a report, and every other thing the reader wants said once. */
  problems: string[];
}

/** The classes of TEST_STRATEGY.md section 10, which a cluster is mapped to. */
export type FailureClass =
  | 'Functional regression'
  | 'Performance regression'
  | 'Flake'
  | 'Environment or infrastructure'
  | 'Known gap'
  | 'Needs a person';

export const CATEGORIES = [
  'environment',
  'page-boot-failure',
  'origin-error',
  'network-fault-not-recovered',
  'decode-or-mse-error',
  'instrument-disagreement',
  'timeout-waiting-for-event',
  'metric-regression',
  'known-gap',
  'unknown',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** What a rule found in one failure: its name, and the evidence a person can check it against. */
export interface RuleVerdict {
  rule: string;
  category: Category;
  evidence: string[];
}

/** The parts a signature is made of (triage/signature.ts); the signature is their one-line form. */
export interface SignatureParts {
  /** The first line of the message, normalised (`errorSignature`, with the steps triage adds). */
  message: string;
  /** What kind of failure the message came from: an assertion's matcher, `test-timeout`, or `thrown`. */
  assertion: string;
  /** `file:function` of a helper that threw (a spec's own body names the test, not the cause), or the spec of a generic message. */
  location: string | null;
  /** The code of the critical Shaka error, if the player reported one. */
  shakaCode: number | null;
}

export interface ClusterMember {
  id: string;
  project: string;
  outcome: FailureOutcome;
  source: string;
}

export interface Cluster {
  /** 1 is the largest. */
  rank: number;
  /** A short hash of the signature: a stable name for the cluster. */
  key: string;
  signature: string;
  parts: SignatureParts;
  size: number;
  /** Distinct test ids, sorted. */
  tests: string[];
  /** Distinct Playwright projects (engine jobs), sorted. */
  projects: string[];
  outcomes: Record<FailureOutcome, number>;
  category: Category;
  /** The rule that fired for the representative failure, and what it found. */
  rule: RuleVerdict;
  ruleRationale: string;
  failureClass: FailureClass;
  /** The first thing to look at, from the rule. */
  firstCheck: string;
  /** How many failures of the cluster the same rule fired for, and which rules fired for the others. */
  agreement: { sameRule: number; of: number; otherRules: string[] };
  /** The failure the cluster is described by: the one with the most diagnostics, then by engine and test id. */
  representative: Failure;
  members: ClusterMember[];
}

export interface SummaryRecord {
  clusterKey: string;
  status: 'summarized' | 'cached' | 'skipped' | 'failed';
  /** The model's draft, a few sentences. Only when summarized or cached. */
  text?: string;
  model?: string;
  /** Why it is not summarized: no key, the budget, an API error. Never contains a key. */
  note?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TriageReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  /** ISO 8601, UTC. The only field of the report that depends on when it was made. */
  generatedAt: string;
  /** What was read: the directory as given, the reports found in it. */
  from: string;
  sources: SourceSummary[];
  totals: { failures: number; flaky: number; clusters: number; skipped: number; interrupted: number };
  clusters: Cluster[];
  skipped: SkippedTest[];
  problems: string[];
  summaries: SummaryRecord[];
  /** One line saying why there are no summaries, or null when there are. */
  summaryNote: string | null;
}
