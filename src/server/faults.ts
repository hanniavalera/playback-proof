import type { FaultMatch, FaultRule, FaultRuleWithId, RequestKind } from '../shared/faults.ts';
import type { Clock } from './clock.ts';
import { MAX_FAULT_RULES_PER_SESSION } from './constants.ts';
import type { LiveStall } from './liveclock.ts';

// The fault engine of one session: validation, storage, and the decision "which rules fire on this request" (docs/CONTRACTS.md
// section 5, which defines every sentence implemented here). It decides; it does not write bytes (deliver.ts does) and it does not know the live clock
// (the session feeds `liveStalls()` to liveclock.ts).

export interface FaultContext {
  /** Is the session's stream live? `live-stall` and `manifest-stale` only make sense there. */
  live: boolean;
}

export type RuleResult = { ok: true; rules: FaultRuleWithId[] } | { ok: false; errors: string[] };

/** What the service knows about a request when it asks which rules fire. `track` comes from the stream's representation list. */
export interface RequestFacts {
  kind: RequestKind;
  track?: 'video' | 'audio';
  rep?: string;
  /** Segment number (VOD: 1..segmentCount, live: the live segment number). Absent for manifests and initialization segments. */
  number?: number;
}

export interface FaultPlan {
  /** Ids of the rules that fired, in rule order. */
  fired: string[];
  /** Sum of the delays of the latency rules that fired (jitter included), ms, >= 0. */
  latencyMs: number;
  /** First `status` rule that fired. */
  status?: number;
  /** First `stall` rule that fired. */
  stall?: { afterBytes: number; ms: number };
  /** First `abort` rule that fired. */
  abort?: { afterBytes: number };
  /** Every throttle rule that fired: the response is limited by all of them (the slowest wins). One bucket per rule and session. */
  throttle: Array<{ ruleId: string; kbps: number }>;
  /** A `manifest-stale` rule is active for this request: replay the recorded body instead of building a fresh one. */
  staleManifest: boolean;
}

const TYPES = ['throttle', 'latency', 'status', 'stall', 'abort', 'live-stall', 'manifest-stale'] as const;
type RuleType = (typeof TYPES)[number];

const COMMON_KEYS = ['type', 'id', 'match', 'times', 'afterMs', 'forMs'];
const KEYS: Record<RuleType, readonly string[]> = {
  throttle: [...COMMON_KEYS, 'kbps'],
  latency: [...COMMON_KEYS, 'ms', 'jitterMs'],
  status: [...COMMON_KEYS, 'status'],
  stall: [...COMMON_KEYS, 'afterBytes', 'ms'],
  abort: [...COMMON_KEYS, 'afterBytes'],
  'live-stall': ['type', 'id', 'atNumber', 'ms'],
  'manifest-stale': ['type', 'id', 'match', 'afterMs', 'ms'],
};

const MATCH_KINDS = ['manifest', 'init', 'segment', 'media', 'any'];
const TRACKS = ['video', 'audio', 'any'];
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value);
}

function parseMatch(raw: unknown, path: string, problems: string[]): FaultMatch | undefined {
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const out: FaultMatch = {};
  for (const key of Object.keys(raw)) {
    if (!['kind', 'track', 'rep', 'number'].includes(key))
      problems.push(`${path}.${key} is not a known match field`);
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind === 'string' && MATCH_KINDS.includes(raw.kind))
      out.kind = raw.kind as FaultMatch['kind'];
    else problems.push(`${path}.kind must be one of ${MATCH_KINDS.join(', ')}`);
  }
  if (raw.track !== undefined) {
    if (typeof raw.track === 'string' && TRACKS.includes(raw.track))
      out.track = raw.track as FaultMatch['track'];
    else problems.push(`${path}.track must be one of ${TRACKS.join(', ')}`);
  }
  if (raw.rep !== undefined) {
    if (typeof raw.rep === 'string' && raw.rep.length > 0) out.rep = raw.rep;
    else problems.push(`${path}.rep must be a non-empty string`);
  }
  if (raw.number !== undefined) {
    const n = raw.number;
    if (isInteger(n) && n >= 1) out.number = n;
    else if (isRecord(n) && isInteger(n.from) && isInteger(n.to) && n.from >= 1 && n.from <= n.to)
      out.number = { from: n.from, to: n.to };
    else problems.push(`${path}.number must be an integer >= 1 or { from, to } with 1 <= from <= to`);
  }
  return out;
}

function parseRule(raw: unknown, path: string, ctx: FaultContext, problems: string[]): FaultRule | undefined {
  if (!isRecord(raw)) {
    problems.push(`${path} must be an object`);
    return undefined;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
    problems.push(`${path}.type must be one of ${TYPES.join(', ')}`);
    return undefined;
  }
  const ruleType = type as RuleType;
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (!KEYS[ruleType].includes(key)) {
      problems.push(
        COMMON_KEYS.includes(key)
          ? `${path}.${key} is not allowed for ${ruleType}`
          : `${path}.${key} is not a field of ${ruleType}`,
      );
    }
  }
  if ((ruleType === 'live-stall' || ruleType === 'manifest-stale') && !ctx.live)
    problems.push(`${path}: ${ruleType} needs a live stream`);

  const rule: Record<string, unknown> = { type: ruleType };
  if (raw.id !== undefined) {
    if (typeof raw.id === 'string' && ID_PATTERN.test(raw.id)) rule.id = raw.id;
    else problems.push(`${path}.id must match ${ID_PATTERN.source}`);
  }
  if (raw.match !== undefined && KEYS[ruleType].includes('match')) {
    const match = parseMatch(raw.match, `${path}.match`, problems);
    if (match) {
      const kind = match.kind;
      if (ruleType === 'manifest-stale' && kind !== undefined && kind !== 'manifest' && kind !== 'any')
        problems.push(`${path}.match.kind must be manifest or any for manifest-stale`);
      rule.match = match;
    }
  }
  if (ruleType === 'status' && !(isRecord(raw.match) && raw.match.kind !== undefined))
    problems.push(`${path}.match.kind is required for status`);
  if (raw.times !== undefined && KEYS[ruleType].includes('times')) {
    if (isInteger(raw.times) && raw.times >= 1) rule.times = raw.times;
    else problems.push(`${path}.times must be an integer >= 1`);
  }
  for (const key of ['afterMs', 'forMs'] as const) {
    if (raw[key] === undefined || !KEYS[ruleType].includes(key)) continue;
    if (isNumber(raw[key]) && raw[key] >= 0) rule[key] = raw[key];
    else problems.push(`${path}.${key} must be a number >= 0`);
  }

  const positive = (key: string, strict: boolean): void => {
    const value = raw[key];
    if (isNumber(value) && (strict ? value > 0 : value >= 0)) rule[key] = value;
    else problems.push(`${path}.${key} must be a number ${strict ? '> 0' : '>= 0'}`);
  };
  switch (ruleType) {
    case 'throttle':
      positive('kbps', true);
      break;
    case 'latency':
      positive('ms', false);
      if (raw.jitterMs !== undefined) {
        if (isNumber(raw.jitterMs) && raw.jitterMs >= 0) rule.jitterMs = raw.jitterMs;
        else problems.push(`${path}.jitterMs must be a number >= 0`);
      }
      break;
    case 'status':
      if (isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) rule.status = raw.status;
      else problems.push(`${path}.status must be an integer from 100 to 599`);
      break;
    case 'stall':
      if (isInteger(raw.afterBytes) && raw.afterBytes >= 0) rule.afterBytes = raw.afterBytes;
      else problems.push(`${path}.afterBytes must be an integer >= 0`);
      positive('ms', false);
      break;
    case 'abort':
      if (raw.afterBytes !== undefined) {
        if (isInteger(raw.afterBytes) && raw.afterBytes >= 0) rule.afterBytes = raw.afterBytes;
        else problems.push(`${path}.afterBytes must be an integer >= 0`);
      }
      break;
    case 'live-stall':
      if (isInteger(raw.atNumber) && raw.atNumber >= 1) rule.atNumber = raw.atNumber;
      else problems.push(`${path}.atNumber must be an integer >= 1`);
      positive('ms', true);
      break;
    case 'manifest-stale':
      positive('ms', true);
      break;
  }
  return problems.length === before ? (rule as unknown as FaultRule) : undefined;
}

/** Validates a list of rules (a request body). Unknown fields are errors: a typo must not become a rule that silently does nothing. */
export function validateFaultRules(raw: unknown, ctx: FaultContext): RuleResult {
  if (!Array.isArray(raw)) return { ok: false, errors: ['rules must be an array'] };
  const problems: string[] = [];
  const rules: FaultRule[] = [];
  raw.forEach((item, index) => {
    const rule = parseRule(item, `rules[${index}]`, ctx, problems);
    if (rule) rules.push(rule);
  });
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.id === undefined) continue;
    if (seen.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`);
    seen.add(rule.id);
  }
  if (problems.length > 0) return { ok: false, errors: problems };
  return { ok: true, rules: rules as FaultRuleWithId[] };
}

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The jitter draw of a request: uniform in [-1, 1), a pure function of (session id, request seq, rule id). */
export function jitterUnit(sessionId: string, seq: number, ruleId: string): number {
  return mulberry32(hash32(`${sessionId}:${seq}:${ruleId}`))() * 2 - 1;
}

function numberMatches(wanted: NonNullable<FaultMatch['number']>, actual: number | undefined): boolean {
  if (actual === undefined) return false;
  return typeof wanted === 'number' ? actual === wanted : actual >= wanted.from && actual <= wanted.to;
}

function matches(rule: FaultRule, facts: RequestFacts): boolean {
  const match = rule.match;
  const kind = match?.kind ?? (rule.type === 'manifest-stale' ? 'manifest' : 'media');
  const kindOk =
    kind === 'any' ||
    kind === facts.kind ||
    (kind === 'media' && (facts.kind === 'init' || facts.kind === 'segment'));
  if (!kindOk) return false;
  if (match?.track !== undefined && match.track !== 'any' && match.track !== facts.track) return false;
  if (match?.rep !== undefined && match.rep !== facts.rep) return false;
  if (match?.number !== undefined && !numberMatches(match.number, facts.number)) return false;
  return true;
}

interface RuleEntry {
  rule: FaultRuleWithId;
  installedAtMs: number;
  /** Requests this rule has fired on (for `times`). */
  fired: number;
}

export class FaultEngine {
  private entries: RuleEntry[] = [];
  private nextId = 1;
  private originMs: number | undefined;
  private readonly sessionId: string;
  private readonly live: boolean;
  private readonly clock: Clock;

  constructor(options: { sessionId: string; live: boolean; clock: Clock }) {
    this.sessionId = options.sessionId;
    this.live = options.live;
    this.clock = options.clock;
  }

  rules(): FaultRuleWithId[] {
    return this.entries.map((entry) => structuredClone(entry.rule));
  }

  /** When the first media request arrived (epoch ms): the origin of `afterMs` and `forMs`. undefined until then. */
  get origin(): number | undefined {
    return this.originMs;
  }

  add(raw: unknown): RuleResult {
    const result = validateFaultRules(raw, { live: this.live });
    if (!result.ok) return result;
    const known = new Set(this.entries.map((entry) => entry.rule.id));
    const errors: string[] = [];
    for (const rule of result.rules) if (known.has(rule.id)) errors.push(`rule id ${rule.id} already exists`);
    if (this.entries.length + result.rules.length > MAX_FAULT_RULES_PER_SESSION)
      errors.push(`a session holds at most ${MAX_FAULT_RULES_PER_SESSION} rules`);
    if (errors.length > 0) return { ok: false, errors };
    const now = this.clock.now();
    const stored: FaultRuleWithId[] = [];
    for (const rule of result.rules) {
      let id = rule.id;
      if (id === undefined) {
        do id = `f${this.nextId++}`;
        while (known.has(id));
      }
      known.add(id);
      const withId = { ...rule, id } as FaultRuleWithId;
      this.entries.push({ rule: withId, installedAtMs: now, fired: 0 });
      stored.push(structuredClone(withId));
    }
    return { ok: true, rules: stored };
  }

  /** Replaces every rule. The new list is validated first: an invalid list changes nothing. */
  replace(raw: unknown): RuleResult {
    const result = validateFaultRules(raw, { live: this.live });
    if (!result.ok) return result;
    const previous = this.entries;
    this.entries = [];
    const added = this.add(raw);
    if (!added.ok) this.entries = previous;
    return added;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.rule.id !== id);
    return this.entries.length !== before;
  }

  /** The installed `live-stall` rules, for liveclock.ts. */
  liveStalls(): LiveStall[] {
    const stalls: LiveStall[] = [];
    for (const { rule, installedAtMs } of this.entries) {
      if (rule.type === 'live-stall')
        stalls.push({ ruleId: rule.id, atNumber: rule.atNumber, ms: rule.ms, installedAtMs });
    }
    return stalls;
  }

  private active(rule: FaultRuleWithId, nowMs: number): boolean {
    const after = rule.afterMs ?? 0;
    if (this.originMs === undefined) return after === 0;
    const start = this.originMs + after;
    if (nowMs < start) return false;
    const duration = rule.type === 'manifest-stale' ? rule.ms : rule.forMs;
    return duration === undefined || nowMs < start + duration;
  }

  /**
   * Which rules fire on this request. `seq` is the request's log sequence number (it seeds the jitter). The first media request
   * (an init or a segment) starts the rule clock.
   */
  evaluate(facts: RequestFacts, seq: number, nowMs: number = this.clock.now()): FaultPlan {
    if (facts.kind !== 'manifest' && this.originMs === undefined) this.originMs = nowMs;
    const plan: FaultPlan = { fired: [], latencyMs: 0, throttle: [], staleManifest: false };
    for (const entry of this.entries) {
      const rule = entry.rule;
      if (rule.type === 'live-stall') continue;
      if (!this.active(rule, nowMs) || !matches(rule, facts)) continue;
      if (rule.type === 'manifest-stale') {
        plan.staleManifest = true;
        plan.fired.push(rule.id);
        continue;
      }
      if (rule.times !== undefined && entry.fired >= rule.times) continue;
      entry.fired++;
      plan.fired.push(rule.id);
      switch (rule.type) {
        case 'throttle':
          plan.throttle.push({ ruleId: rule.id, kbps: rule.kbps });
          break;
        case 'latency':
          plan.latencyMs += Math.max(
            0,
            rule.ms + jitterUnit(this.sessionId, seq, rule.id) * (rule.jitterMs ?? 0),
          );
          break;
        case 'status':
          plan.status ??= rule.status;
          break;
        case 'stall':
          plan.stall ??= { afterBytes: rule.afterBytes, ms: rule.ms };
          break;
        case 'abort':
          plan.abort ??= { afterBytes: rule.afterBytes ?? 0 };
          break;
      }
    }
    return plan;
  }
}
