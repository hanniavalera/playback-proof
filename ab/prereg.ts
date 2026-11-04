import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateFaultRules } from '../src/server/faults.ts';
import type { FaultRule } from '../src/shared/faults.ts';
import { PROFILE_NAMES, profile } from '../src/shared/profiles.ts';
import type { ProfileName } from '../src/shared/profiles.ts';
import type { Protocol, StreamId } from '../src/shared/streams.ts';
import {
  describeUnmeasured,
  measurableCeilingKbps,
  measurableLatencyMs,
  unmeasuredWindows,
} from './conditions.ts';
import { METRICS, isMetricId } from './metrics.ts';
import type { MetricId } from './metrics.ts';
import { AB_POLICY } from './policy.ts';
import { mentionedSettings } from './settings.ts';
import type { ConfigLetter } from './types.ts';

// The pre-registration of an experiment: a JSON file, committed BEFORE the data run, that fixes what will be compared, how, and what will
// count as a result. The runner refuses to run without a valid one and records the sha256 of the file in its results, so that the report
// can show that the plan existed, byte for byte, before the data did (ADR-143 in docs/decisions/ab.md).
//
// The validator is strict on purpose. An unknown field is an error (a typo in a threshold must not become a threshold that silently is not
// there), and so is every number the policy of TEST_STRATEGY.md section 12 bounds: thirty sessions per arm or more, a practical threshold
// that comes with the minimum detectable effect it must not be below, alpha 0.05. A pipeline check is the one kind allowed to break them,
// and it decides nothing.

export const PREREG_SCHEMA_VERSION = 1;

/**
 * `experiment`: a pre-registered A/B comparison that ends in a verdict (PB-AB-002, PB-AB-003).
 * `exploratory`: the same comparison, labelled as exploratory: it estimates and decides nothing.
 * `aa`: both arms run configuration A; the harness's own check (PB-AB-001) and the pilot that measures the variance.
 * `pipeline-check`: a few sessions that prove the pipeline runs end to end; it decides nothing.
 */
export const EXPERIMENT_KINDS = ['experiment', 'exploratory', 'aa', 'pipeline-check'] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = (typeof ENGINES)[number];

export const DECISION_RULE_IDS = ['pb-ab-v1'] as const;
export type DecisionRuleId = (typeof DECISION_RULE_IDS)[number];

export interface HypothesisPlan {
  metric: MetricId;
  /** In words, before any data: what is expected and why (the null hypothesis is "no difference in this metric"). */
  text: string;
}

export interface MinimumDetectableEffect {
  /** In the unit of the metric (a share as a fraction): the smallest shift the A/A pilot says this design detects with `power`. */
  value: number;
  sessionsPerArm: number;
  power: number;
  /** The committed file the pilot's numbers come from (docs/results/ab/...). */
  source: string;
}

export interface MetricPlan {
  id: MetricId;
  /** `primary`: in the Holm family and the decision. `secondary`: pre-registered and reported with its raw p-value, never part of the decision. */
  role: 'primary' | 'secondary';
  direction: 'lower-is-better' | 'higher-is-better';
  /** The smallest difference between the arms, in the unit of the metric (a share or a ratio as a fraction), worth changing a configuration for. */
  practicalThreshold?: number;
  /** Why that number, in words: what a member or the team would notice or pay. */
  thresholdBasis?: string;
  minimumDetectableEffect?: MinimumDetectableEffect;
}

export interface ConditionPlan {
  id: string;
  /** The named profile of src/shared/profiles.ts this condition is, or null for a condition of its own. */
  profile: ProfileName | null;
  /** The rules sent to the service with every session, written out in full so that the file says what will be applied. */
  rules: FaultRule[];
  rationale: string;
}

export interface Preregistration {
  schemaVersion: 1;
  id: string;
  kind: ExperimentKind;
  /** The catalog row (TEST_STRATEGY.md section 9), or null. */
  catalogId: string | null;
  title: string;
  /** The date the plan was written, YYYY-MM-DD. */
  registeredOn: string;
  hypotheses: HypothesisPlan[];
  engine: Engine;
  stream: StreamId;
  protocol: Protocol;
  arms: { A: ConfigLetter; B: ConfigLetter };
  conditions: ConditionPlan[];
  observation: {
    /** Media seconds played after the first frame (0: the session ends at the first frame). */
    mediaSecondsAfterFirstFrame: number;
    /** A session that has not reached its end by then is a failed session. */
    sessionTimeoutMs: number;
  };
  sessionsPerArm: number;
  warmupSessionsPerArm: number;
  alpha: number;
  bootstrapResamples: number;
  metrics: MetricPlan[];
  decisionRule: { id: DecisionRuleId; text: string };
  exclusionRule: { text: string; maxFailedShare: number; abortAfterConsecutiveFailures: number };
  /**
   * The committed report of the real A/A run (PB-AB-001) this experiment relies on: the harness must have passed its own check, in this
   * environment, for this engine and this condition, before an A/B verdict means anything. Required for an experiment; the run refuses
   * to start, and the report calls itself not valid, when that report is missing or says the harness failed (ab/validity.ts).
   */
  aaCheck: { source: string } | null;
  seed: number;
}

export type PreregistrationResult =
  { ok: true; prereg: Preregistration; warnings: string[] } | { ok: false; problems: string[] };

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const VOD_STREAMS: readonly StreamId[] = ['vod-cmaf', 'vod-cmaf-short', 'vod-webm'];

/** JSON with the keys of every object in sorted order: two rule lists are the same condition whatever order their keys were written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const CONDITION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** The committed report of an A/A run: docs/results/ab/<experiment id>.<environment id>.<stamp>.report.json (ab/files.ts). */
const AA_REPORT_PATTERN = /^docs\/results\/ab\/[A-Za-z0-9][A-Za-z0-9._-]*\.report\.json$/;
const MIN_TEXT = 20;

/** Reports every key of `object` that is not in `allowed`: a misspelt field is a problem, never a silently ignored one. */
function onlyKeys(object: Json, allowed: readonly string[], path: string, problems: string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      problems.push(
        `${path}.${key} is not a field of the pre-registration (expected: ${allowed.join(', ')})`,
      );
  }
}

function text(object: Json, key: string, path: string, problems: string[], minLength = 1): string {
  const value = object[key];
  if (!isNonEmptyString(value) || value.trim().length < minLength) {
    problems.push(
      `${path}.${key} must be ${minLength > 1 ? `a sentence of at least ${minLength} characters` : 'a non-empty string'}`,
    );
    return '';
  }
  noSingleSetting(value, `${path}.${key}`, problems);
  return value;
}

/** B is several settings together: a sentence of a plan must not speak of one of them (ab/settings.ts). */
function noSingleSetting(value: string, path: string, problems: string[]): void {
  const named = mentionedSettings(value);
  if (named.length > 0)
    problems.push(
      `${path} names a single setting of configuration B (${named.join(', ')}): B is several settings together and the experiment compares the two configurations as shipped, so say what is expected of B, not of one of its settings`,
    );
}

function integer(
  object: Json,
  key: string,
  path: string,
  problems: string[],
  min: number,
  max: number,
): number {
  const value = object[key];
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${path}.${key} must be an integer from ${min} to ${max}`);
    return min;
  }
  return value;
}

function oneOf<T extends string>(
  object: Json,
  key: string,
  allowed: readonly T[],
  path: string,
  problems: string[],
  fallback: T,
): T {
  const value = object[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    problems.push(`${path}.${key} must be one of ${allowed.join(', ')}`);
    return fallback;
  }
  return value as T;
}

function validateMetric(
  raw: unknown,
  index: number,
  kind: ExperimentKind,
  plan: Preregistration,
  problems: string[],
): MetricPlan | undefined {
  const path = `metrics[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  onlyKeys(
    raw,
    ['id', 'role', 'direction', 'practicalThreshold', 'thresholdBasis', 'minimumDetectableEffect'],
    path,
    problems,
  );
  if (!isMetricId(raw.id)) {
    problems.push(`${path}.id must be one of ${Object.keys(METRICS).join(', ')}`);
    return undefined;
  }
  const id = raw.id;
  const role = oneOf(raw, 'role', ['primary', 'secondary'] as const, path, problems, 'secondary');
  const direction = oneOf(
    raw,
    'direction',
    ['lower-is-better', 'higher-is-better'] as const,
    path,
    problems,
    'lower-is-better',
  );
  const metric: MetricPlan = { id, role, direction };

  const unit = METRICS[id].unit;
  const bounded = unit === 'ratio' || unit === 'share';
  if (raw.practicalThreshold !== undefined) {
    if (
      !isFiniteNumber(raw.practicalThreshold) ||
      raw.practicalThreshold <= 0 ||
      (bounded && raw.practicalThreshold > 1)
    ) {
      problems.push(
        `${path}.practicalThreshold must be a number > 0${bounded ? ' and at most 1 (a fraction)' : ''}`,
      );
    } else metric.practicalThreshold = raw.practicalThreshold;
  }
  if (raw.thresholdBasis !== undefined) {
    if (!isNonEmptyString(raw.thresholdBasis))
      problems.push(`${path}.thresholdBasis must be a non-empty string`);
    else {
      noSingleSetting(raw.thresholdBasis, `${path}.thresholdBasis`, problems);
      metric.thresholdBasis = raw.thresholdBasis;
    }
  }
  if (role === 'primary') {
    if (metric.practicalThreshold === undefined)
      problems.push(
        `${path}.practicalThreshold is required for a primary metric: the smallest difference worth changing a configuration for`,
      );
    if (metric.thresholdBasis === undefined || metric.thresholdBasis.trim().length < MIN_TEXT)
      problems.push(
        `${path}.thresholdBasis is required for a primary metric: say in words why that number is the smallest difference that matters`,
      );
  }

  if (raw.minimumDetectableEffect !== undefined) {
    const mdePath = `${path}.minimumDetectableEffect`;
    const mde = raw.minimumDetectableEffect;
    if (!isRecord(mde)) problems.push(`${mdePath} must be an object`);
    else {
      onlyKeys(mde, ['value', 'sessionsPerArm', 'power', 'source'], mdePath, problems);
      const value = mde.value;
      const power = mde.power;
      if (!isFiniteNumber(value) || value <= 0) problems.push(`${mdePath}.value must be a number > 0`);
      if (!isFiniteNumber(power) || power <= 0 || power >= 1)
        problems.push(`${mdePath}.power must be strictly between 0 and 1`);
      if (!isNonEmptyString(mde.source) || !mde.source.startsWith('docs/results/ab/'))
        problems.push(
          `${mdePath}.source must name the committed pilot file under docs/results/ab/ the number comes from`,
        );
      const n = mde.sessionsPerArm;
      if (!isFiniteNumber(n) || !Number.isInteger(n) || n < 2)
        problems.push(`${mdePath}.sessionsPerArm must be an integer >= 2`);
      if (
        isFiniteNumber(value) &&
        isFiniteNumber(power) &&
        isFiniteNumber(n) &&
        isNonEmptyString(mde.source)
      ) {
        metric.minimumDetectableEffect = { value, sessionsPerArm: n, power, source: mde.source };
      }
    }
  }
  // Only a plan that decides must show that its threshold can be told from noise: an exploratory plan estimates and decides nothing.
  if (role === 'primary' && kind === 'experiment') {
    const mde = metric.minimumDetectableEffect;
    if (mde === undefined) {
      problems.push(
        `${path}.minimumDetectableEffect is required: a practical threshold is never below what the A/A pilot says the design can detect`,
      );
    } else {
      if (metric.practicalThreshold !== undefined && metric.practicalThreshold < mde.value)
        problems.push(
          `${path}.practicalThreshold (${metric.practicalThreshold}) is below the minimum detectable effect (${mde.value}): a difference the design cannot tell from noise cannot be what the decision is about`,
        );
      if (mde.sessionsPerArm !== plan.sessionsPerArm)
        problems.push(
          `${path}.minimumDetectableEffect.sessionsPerArm (${mde.sessionsPerArm}) is not the sessionsPerArm of the plan (${plan.sessionsPerArm}): the number was computed for another design`,
        );
      if (mde.power < AB_POLICY.targetPower)
        problems.push(
          `${path}.minimumDetectableEffect.power (${mde.power}) is below the ${AB_POLICY.targetPower} of the policy`,
        );
    }
  }
  return metric;
}

function validateCondition(
  raw: unknown,
  index: number,
  plan: Preregistration,
  problems: string[],
  warnings: string[],
): ConditionPlan | undefined {
  const path = `conditions[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  onlyKeys(raw, ['id', 'profile', 'rules', 'rationale'], path, problems);
  const id = raw.id;
  if (typeof id !== 'string' || !CONDITION_ID_PATTERN.test(id))
    problems.push(`${path}.id must match ${CONDITION_ID_PATTERN.source}`);
  const rationale = text(raw, 'rationale', path, problems, MIN_TEXT);

  let named: ProfileName | null = null;
  if (raw.profile !== null && raw.profile !== undefined) {
    if (typeof raw.profile === 'string' && (PROFILE_NAMES as readonly string[]).includes(raw.profile))
      named = raw.profile as ProfileName;
    else problems.push(`${path}.profile must be null or one of ${PROFILE_NAMES.join(', ')}`);
  }
  const checked = validateFaultRules(raw.rules, { live: false });
  if (!checked.ok) {
    for (const error of checked.errors) problems.push(`${path}.${error}`);
    return undefined;
  }
  const rules = structuredClone(raw.rules) as FaultRule[];
  if (named !== null && canonicalJson(profile(named)) !== canonicalJson(rules)) {
    problems.push(
      `${path}.rules differ from the named profile "${named}" as it is defined now in src/shared/profiles.ts: either the profile changed after the plan was written, or this is not that profile any more (then say "profile": null and name the condition what it is)`,
    );
  }
  if (typeof id !== 'string') return undefined;
  for (const note of describeUnmeasured(unmeasuredWindows(rules))) {
    // An experiment lets Shaka adapt, so every stretch of its session must be on a link the player can hear: finite links only.
    if (plan.kind === 'pipeline-check') warnings.push(`${path} (${id}): ${note}`);
    else
      problems.push(
        `${path} (${id}): ${note}. An experiment runs on finite links only: write the condition so that a throttle of at most ${measurableCeilingKbps()} kbps, or a delay of at least ${measurableLatencyMs()} ms, covers the whole session (a named profile with a quiet start is not that: say "profile": null and name the finite variant for what it is)`,
      );
  }
  for (const [r, rule] of rules.entries()) {
    const starts = rule.afterMs ?? 0;
    const observedMs = plan.observation.mediaSecondsAfterFirstFrame * 1000;
    if (starts > 0 && starts >= observedMs)
      problems.push(
        `${path}.rules[${r}] starts ${starts} ms after the first media request, but the session observes only ${observedMs} ms of media after the first frame: the fault would never be seen`,
      );
  }
  return { id, profile: named, rules, rationale };
}

/**
 * Validates a parsed pre-registration. Returns every problem found (not just the first), or the typed plan with the warnings that do not
 * block it. A condition with a stretch in which the player's estimator is deaf (ab/conditions.ts) is a problem for every kind but a
 * pipeline check, which only warns: an experiment runs on finite links only.
 */
export function validatePreregistration(raw: unknown): PreregistrationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: ['the pre-registration must be a JSON object'] };
  onlyKeys(
    raw,
    [
      'schemaVersion',
      'id',
      'kind',
      'catalogId',
      'title',
      'registeredOn',
      'hypotheses',
      'engine',
      'stream',
      'protocol',
      'arms',
      'conditions',
      'observation',
      'sessionsPerArm',
      'warmupSessionsPerArm',
      'alpha',
      'bootstrapResamples',
      'metrics',
      'decisionRule',
      'exclusionRule',
      'aaCheck',
      'seed',
    ],
    '$',
    problems,
  );
  if (raw.schemaVersion !== PREREG_SCHEMA_VERSION)
    problems.push(`$.schemaVersion must be ${PREREG_SCHEMA_VERSION}`);

  const kind = oneOf(raw, 'kind', EXPERIMENT_KINDS, '$', problems, 'pipeline-check');
  const decides = kind === 'experiment' || kind === 'aa';
  const real = kind !== 'pipeline-check';

  const id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : '';
  if (id === '') problems.push(`$.id must match ${ID_PATTERN.source}`);
  let catalogId: string | null = null;
  if (raw.catalogId !== null && raw.catalogId !== undefined) {
    if (typeof raw.catalogId === 'string' && /^PB-AB-\d{3}$/.test(raw.catalogId)) catalogId = raw.catalogId;
    else problems.push('$.catalogId must be null or a catalog id such as PB-AB-002');
  }
  if (kind === 'experiment' && catalogId === null)
    problems.push('$.catalogId is required for an experiment: the catalog row it is the evidence of');
  const title = text(raw, 'title', '$', problems, 8);
  const registeredOn =
    typeof raw.registeredOn === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw.registeredOn) &&
    !Number.isNaN(Date.parse(raw.registeredOn))
      ? raw.registeredOn
      : '';
  if (registeredOn === '') problems.push('$.registeredOn must be a date, YYYY-MM-DD');

  const engine = oneOf(raw, 'engine', ENGINES, '$', problems, 'chromium');
  const stream = oneOf(raw, 'stream', VOD_STREAMS, '$', problems, 'vod-cmaf');
  const protocol = oneOf(raw, 'protocol', ['dash', 'hls'] as const, '$', problems, 'dash');
  if (stream === 'vod-webm' && protocol === 'hls')
    problems.push('$.protocol: vod-webm is served over DASH only');

  const arms: Preregistration['arms'] = { A: 'A', B: 'B' };
  if (!isRecord(raw.arms)) problems.push('$.arms must be an object { "A": "A" | "B", "B": "A" | "B" }');
  else {
    onlyKeys(raw.arms, ['A', 'B'], '$.arms', problems);
    arms.A = oneOf(raw.arms, 'A', ['A', 'B'] as const, '$.arms', problems, 'A');
    arms.B = oneOf(raw.arms, 'B', ['A', 'B'] as const, '$.arms', problems, 'B');
    if ((kind === 'experiment' || kind === 'exploratory') && (arms.A !== 'A' || arms.B !== 'B'))
      problems.push(
        '$.arms: a comparison of configurations puts configuration A (Shaka defaults) in arm A and configuration B in arm B',
      );
    if (kind === 'aa' && (arms.A !== 'A' || arms.B !== 'A'))
      problems.push('$.arms: an A/A run puts configuration A in both arms');
  }

  const observation: Preregistration['observation'] = {
    mediaSecondsAfterFirstFrame: 0,
    sessionTimeoutMs: 60_000,
  };
  if (!isRecord(raw.observation))
    problems.push('$.observation must be an object { mediaSecondsAfterFirstFrame, sessionTimeoutMs }');
  else {
    onlyKeys(raw.observation, ['mediaSecondsAfterFirstFrame', 'sessionTimeoutMs'], '$.observation', problems);
    const seconds = raw.observation.mediaSecondsAfterFirstFrame;
    if (!isFiniteNumber(seconds) || seconds < 0 || seconds > 300)
      problems.push('$.observation.mediaSecondsAfterFirstFrame must be a number from 0 to 300');
    else observation.mediaSecondsAfterFirstFrame = seconds;
    observation.sessionTimeoutMs = integer(
      raw.observation,
      'sessionTimeoutMs',
      '$.observation',
      problems,
      5000,
      600_000,
    );
  }

  const sessionsPerArm = integer(
    raw,
    'sessionsPerArm',
    '$',
    problems,
    real ? AB_POLICY.minSessionsPerArm : 2,
    10_000,
  );
  if (real && sessionsPerArm % 2 !== 0)
    problems.push(
      '$.sessionsPerArm must be even: the arm that goes first alternates from block to block, and only an even number of blocks puts the two arms at the same average position in time, so that a drift of the machine cancels',
    );
  const warmupSessionsPerArm = integer(
    raw,
    'warmupSessionsPerArm',
    '$',
    problems,
    0,
    AB_POLICY.maxWarmupPerArm,
  );

  let alpha: number = AB_POLICY.alpha;
  if (!isFiniteNumber(raw.alpha) || raw.alpha <= 0 || raw.alpha >= 0.5)
    problems.push('$.alpha must be a number strictly between 0 and 0.5');
  else {
    alpha = raw.alpha;
    if (real && alpha !== AB_POLICY.alpha)
      problems.push(
        `$.alpha must be ${AB_POLICY.alpha}, the significance level of the policy (TEST_STRATEGY.md section 12)`,
      );
  }
  const bootstrapResamples = integer(
    raw,
    'bootstrapResamples',
    '$',
    problems,
    real ? AB_POLICY.minBootstrapResamples : 100,
    1_000_000,
  );
  const seed = integer(raw, 'seed', '$', problems, 0, 2 ** 32 - 1);

  const plan: Preregistration = {
    schemaVersion: 1,
    id,
    kind,
    catalogId,
    title,
    registeredOn,
    hypotheses: [],
    engine,
    stream,
    protocol,
    arms,
    conditions: [],
    observation,
    sessionsPerArm,
    warmupSessionsPerArm,
    alpha,
    bootstrapResamples,
    metrics: [],
    decisionRule: { id: 'pb-ab-v1', text: '' },
    exclusionRule: {
      text: '',
      maxFailedShare: AB_POLICY.defaultMaxFailedShare,
      abortAfterConsecutiveFailures: 5,
    },
    aaCheck: null,
    seed,
  };

  if (raw.aaCheck !== undefined && raw.aaCheck !== null) {
    if (!isRecord(raw.aaCheck)) problems.push('$.aaCheck must be null or an object { source }');
    else {
      onlyKeys(raw.aaCheck, ['source'], '$.aaCheck', problems);
      const source = raw.aaCheck.source;
      if (typeof source !== 'string' || !AA_REPORT_PATTERN.test(source))
        problems.push(
          `$.aaCheck.source must name the committed report of the A/A run under docs/results/ab/ (<id>.<environment>.<stamp>.report.json), got ${JSON.stringify(source)}`,
        );
      else plan.aaCheck = { source };
    }
  }
  if (kind === 'experiment' && (raw.aaCheck === undefined || raw.aaCheck === null))
    problems.push(
      '$.aaCheck is required for an experiment: the harness must have passed the real A/A run (PB-AB-001) in this environment, and the plan names its committed report',
    );

  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0)
    problems.push('$.conditions must be a non-empty array');
  else {
    plan.conditions = raw.conditions
      .map((condition, index) => validateCondition(condition, index, plan, problems, warnings))
      .filter((condition): condition is ConditionPlan => condition !== undefined);
    const ids = plan.conditions.map((condition) => condition.id);
    if (new Set(ids).size !== ids.length) problems.push('$.conditions: two conditions have the same id');
    if ((kind === 'experiment' || kind === 'exploratory') && raw.conditions.length !== 1)
      problems.push(
        '$.conditions: an experiment decides on one condition (its family of tests, and so its error rate, is per condition): pre-register another experiment for another condition',
      );
  }

  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0)
    problems.push('$.metrics must be a non-empty array');
  else {
    plan.metrics = raw.metrics
      .map((metric, index) => validateMetric(metric, index, kind, plan, problems))
      .filter((metric): metric is MetricPlan => metric !== undefined);
    const ids = plan.metrics.map((metric) => metric.id);
    if (new Set(ids).size !== ids.length) problems.push('$.metrics: a metric is listed twice');
    if (!plan.metrics.some((metric) => metric.role === 'primary'))
      problems.push(
        '$.metrics: at least one metric must be primary: a decision needs something to decide on',
      );
    const needsPlayback = plan.metrics.filter((metric) => METRICS[metric.id].needsPlayback);
    if (needsPlayback.length > 0 && observation.mediaSecondsAfterFirstFrame < 1)
      problems.push(
        `$.observation.mediaSecondsAfterFirstFrame is ${observation.mediaSecondsAfterFirstFrame}, but ${needsPlayback.map((metric) => metric.id).join(', ')} only exist once the player has played`,
      );
  }

  if (!Array.isArray(raw.hypotheses) || raw.hypotheses.length === 0)
    problems.push('$.hypotheses must be a non-empty array of { metric, text }');
  else {
    for (const [index, hypothesis] of raw.hypotheses.entries()) {
      const path = `hypotheses[${index}]`;
      if (!isRecord(hypothesis)) {
        problems.push(`${path} must be an object { metric, text }`);
        continue;
      }
      onlyKeys(hypothesis, ['metric', 'text'], path, problems);
      if (!isMetricId(hypothesis.metric))
        problems.push(`${path}.metric must be one of ${Object.keys(METRICS).join(', ')}`);
      const sentence = text(hypothesis, 'text', path, problems, MIN_TEXT);
      if (isMetricId(hypothesis.metric) && sentence !== '')
        plan.hypotheses.push({ metric: hypothesis.metric, text: sentence });
    }
    for (const metric of plan.metrics.filter((candidate) => candidate.role === 'primary')) {
      if (!plan.hypotheses.some((hypothesis) => hypothesis.metric === metric.id))
        problems.push(`$.hypotheses: the primary metric ${metric.id} has no hypothesis in words`);
    }
  }

  if (!isRecord(raw.decisionRule)) problems.push('$.decisionRule must be an object { id, text }');
  else {
    onlyKeys(raw.decisionRule, ['id', 'text'], '$.decisionRule', problems);
    plan.decisionRule = {
      id: oneOf(raw.decisionRule, 'id', DECISION_RULE_IDS, '$.decisionRule', problems, 'pb-ab-v1'),
      text: text(raw.decisionRule, 'text', '$.decisionRule', problems, 60),
    };
  }
  if (!isRecord(raw.exclusionRule))
    problems.push(
      '$.exclusionRule must be an object { text, maxFailedShare, abortAfterConsecutiveFailures }',
    );
  else {
    onlyKeys(
      raw.exclusionRule,
      ['text', 'maxFailedShare', 'abortAfterConsecutiveFailures'],
      '$.exclusionRule',
      problems,
    );
    const share = raw.exclusionRule.maxFailedShare;
    if (!isFiniteNumber(share) || share <= 0 || share > 0.5)
      problems.push('$.exclusionRule.maxFailedShare must be a number above 0 and at most 0.5');
    plan.exclusionRule = {
      text: text(raw.exclusionRule, 'text', '$.exclusionRule', problems, 60),
      maxFailedShare: isFiniteNumber(share) ? share : AB_POLICY.defaultMaxFailedShare,
      abortAfterConsecutiveFailures: integer(
        raw.exclusionRule,
        'abortAfterConsecutiveFailures',
        '$.exclusionRule',
        problems,
        2,
        50,
      ),
    };
  }

  if (
    decides &&
    plan.metrics.some((metric) => metric.role === 'primary' && metric.direction === 'higher-is-better')
  ) {
    warnings.push(
      'a primary metric is higher-is-better: every metric of this lab is lower-is-better, check the direction',
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, prereg: plan, warnings };
}

export class PreregistrationError extends Error {
  override name = 'PreregistrationError';
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file} is not a valid pre-registration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export interface LoadedPreregistration {
  /** The path as given. */
  path: string;
  /** The exact text of the file, kept so that the hash can be recomputed from the results alone. */
  text: string;
  /** sha256 of the bytes of the file, as hex. */
  sha256: string;
  prereg: Preregistration;
  warnings: string[];
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Parses and validates the text of a pre-registration file; throws a `PreregistrationError` listing every problem. */
export function parsePreregistration(path: string, content: string): LoadedPreregistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new PreregistrationError(path, [`not valid JSON: ${(error as Error).message}`]);
  }
  const result = validatePreregistration(parsed);
  if (!result.ok) throw new PreregistrationError(path, result.problems);
  return {
    path,
    text: content,
    sha256: sha256Hex(content),
    prereg: result.prereg,
    warnings: result.warnings,
  };
}

/** Reads, parses and validates a pre-registration file. The runner calls this first and refuses to run when it throws. */
export function loadPreregistration(path: string): LoadedPreregistration {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new PreregistrationError(path, [`cannot be read: ${(error as Error).message}`]);
  }
  return parsePreregistration(path, content);
}
