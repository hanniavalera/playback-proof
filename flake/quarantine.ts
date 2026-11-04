// The quarantine list (TEST_STRATEGY.md section 7.2): a committed file of tests that are known to flake, each with an owner, a reason, the
// evidence for it and an expiry. A quarantined test still runs, non-blocking, and is never silently deleted; the gate fails when an entry
// outlives its expiry. This module reads and judges the list; it never reads the clock (`today` comes in) and never touches the catalog
// file (the facts of the catalog come in as data).
import { existsSync, readFileSync } from 'node:fs';
import { FLAKE_LIMITS } from '../src/shared/criteria.ts';
import type { GateTier } from '../src/shared/criteria.ts';
import { expandEngines, parseCatalog } from '../tools/catalog.ts';
import type { CatalogRow } from '../tools/catalog.ts';

export const QUARANTINE_SCHEMA_VERSION = 1;
export const QUARANTINE_FILE = 'flake/quarantine.json';

export interface QuarantineEntry {
  /** A catalog id: `PB-VOD-007`. */
  id: string;
  /** One engine (`webkit`); without it the test is quarantined in every engine it runs in. */
  project?: string;
  /** Why, with the evidence that the failure is not deterministic (the same commit failed and passed). */
  reason: string;
  /** Who fixes it. */
  owner: string;
  /** `YYYY-MM-DD` (UTC): the day the quarantine started. */
  since: string;
  /** `YYYY-MM-DD` (UTC): valid through the end of this day; the gate fails from the next one. */
  expires: string;
  /** The issue or the CI run that justified it (an issue number or URL, a run id). */
  evidence: string;
}

export interface QuarantineFile {
  schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  entries: QuarantineEntry[];
}

/** What the catalog says of a test id: the tier decides the longest quarantine, the engines decide where an entry can apply. */
export interface CatalogFact {
  tier: GateTier;
  engines: readonly string[];
}
export type CatalogFacts = ReadonlyMap<string, CatalogFact>;

export function catalogFacts(rows: readonly CatalogRow[]): CatalogFacts {
  return new Map(rows.map((row) => [row.id, { tier: row.tier, engines: expandEngines(row.engines) }]));
}

export interface QuarantineLimits {
  readonly quarantineMaxAgeDays: number;
  readonly mergeQuarantineMaxAgeDays: number;
}

const ENTRY_KEYS = ['id', 'project', 'reason', 'owner', 'since', 'expires', 'evidence'] as const;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** A calendar day as a number of days since 1970-01-01, or null when the text is not a real day (`2026-02-30`, `2026-2-3`). */
export function dayNumber(text: string): number | null {
  const m = DAY.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day)
    return null;
  return ms / MS_PER_DAY;
}

/** The UTC day of a moment, as `YYYY-MM-DD`. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface ReadResult {
  entries: QuarantineEntry[];
  problems: string[];
}

function describe(entry: Record<string, unknown>, index: number): string {
  return typeof entry.id === 'string' && entry.id !== '' ? entry.id : `entries[${index}]`;
}

/**
 * The shape of the file. An entry that does not have it is reported and left out, so that one typo does not hide the others and
 * nothing quarantines a test by accident. Keys it does not know are an error too: `projects` instead of `project` would otherwise
 * quarantine a test in every engine without anybody having said so.
 */
export function readQuarantine(value: unknown, source = QUARANTINE_FILE): ReadResult {
  const problems: string[] = [];
  const entries: QuarantineEntry[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { entries, problems: [`${source}: expected an object with "schemaVersion" and "entries"`] };
  }
  const file = value as Record<string, unknown>;
  if (file.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    problems.push(
      `${source}: "schemaVersion" must be ${QUARANTINE_SCHEMA_VERSION}, found ${JSON.stringify(file.schemaVersion)}`,
    );
  }
  for (const key of Object.keys(file)) {
    if (key !== 'schemaVersion' && key !== 'entries') problems.push(`${source}: unknown key "${key}"`);
  }
  if (!Array.isArray(file.entries)) {
    problems.push(
      `${source}: "entries" must be a list (an empty list is the honest state of a lab with nothing quarantined)`,
    );
    return { entries, problems };
  }
  file.entries.forEach((raw: unknown, index: number) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`${source}: entries[${index}] must be an object`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const name = describe(entry, index);
    const before = problems.length;
    for (const key of Object.keys(entry)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
        problems.push(`${name}: unknown key "${key}" (the keys are ${ENTRY_KEYS.join(', ')})`);
      }
    }
    for (const key of ENTRY_KEYS) {
      const present = entry[key] !== undefined;
      if (key === 'project' && !present) continue;
      const item = entry[key];
      if (typeof item !== 'string' || item.trim() === '') {
        problems.push(
          present ? `${name}: "${key}" must be a non-empty string` : `${name}: "${key}" is missing`,
        );
      }
    }
    if (typeof entry.since === 'string' && dayNumber(entry.since) === null) {
      problems.push(`${name}: "since" must be a real day written YYYY-MM-DD, found "${entry.since}"`);
    }
    if (typeof entry.expires === 'string' && dayNumber(entry.expires) === null) {
      problems.push(`${name}: "expires" must be a real day written YYYY-MM-DD, found "${entry.expires}"`);
    }
    if (problems.length === before) entries.push(entry as unknown as QuarantineEntry);
  });
  return { entries, problems };
}

/** The age an entry may reach, in days: the merge tier gets the short one, because its quarantine is a hole in the merge gate. */
export function maxAgeDays(tier: GateTier, limits: QuarantineLimits = FLAKE_LIMITS): number {
  return tier === 'merge' ? limits.mergeQuarantineMaxAgeDays : limits.quarantineMaxAgeDays;
}

export interface ValidateOptions {
  catalog: CatalogFacts;
  /** `YYYY-MM-DD`, UTC. */
  today: string;
  limits?: QuarantineLimits;
}

/** One thing wrong with the list. `entry` is the entry it is about, or null for the list as a whole. */
export interface QuarantineProblem {
  entry: QuarantineEntry | null;
  message: string;
}

/**
 * The rules of the policy applied to entries of the right shape. An expired entry is valid here: expiry is the gate's finding.
 * The entry a problem is about is named, so that one entry with a typo does not take the others' protection away.
 */
export function validateQuarantine(
  entries: readonly QuarantineEntry[],
  options: ValidateOptions,
): QuarantineProblem[] {
  const { catalog, today } = options;
  const limits = options.limits ?? FLAKE_LIMITS;
  const todayNumber = dayNumber(today);
  const problems: QuarantineProblem[] = [];
  if (todayNumber === null)
    return [{ entry: null, message: `today "${today}" is not a day written YYYY-MM-DD` }];

  const seen: QuarantineEntry[] = [];
  for (const entry of entries) {
    const problem = (message: string): number => problems.push({ entry, message });
    const fact = catalog.get(entry.id);
    if (!fact) {
      problem(
        `${entry.id}: not a test of the catalog (TEST_STRATEGY.md section 9); a quarantine names the id of a catalog row`,
      );
      continue;
    }
    if (entry.project !== undefined && !fact.engines.includes(entry.project)) {
      problem(
        `${entry.id}: project "${entry.project}" is not an engine this test runs in (${fact.engines.join(', ') || 'none'})`,
      );
    }
    const since = dayNumber(entry.since);
    const expires = dayNumber(entry.expires);
    if (since !== null && since > todayNumber) {
      problem(`${entry.id}: since ${entry.since} is in the future (today is ${today})`);
    }
    if (since !== null && expires !== null) {
      const age = expires - since;
      const max = maxAgeDays(fact.tier, limits);
      if (age < 0) problem(`${entry.id}: expires ${entry.expires} is before since ${entry.since}`);
      else if (age > max) {
        problem(
          `${entry.id}: expires ${entry.expires} is ${age} days after since ${entry.since}; a ${fact.tier}-tier test may be quarantined for at most ${max} days`,
        );
      }
    }
    const earlier = seen.filter((e) => e.id === entry.id);
    if (earlier.some((e) => e.project === entry.project)) {
      problem(
        `${entry.id}: quarantined twice${entry.project ? ` in ${entry.project}` : ''}; one entry per test and engine`,
      );
    } else if (entry.project === undefined && earlier.length > 0) {
      problem(`${entry.id}: already quarantined in one engine; an entry without a project would overlap it`);
    } else if (entry.project !== undefined && earlier.some((e) => e.project === undefined)) {
      problem(
        `${entry.id}: already quarantined in every engine; an entry for ${entry.project} would overlap it`,
      );
    }
    seen.push(entry);
  }
  return problems;
}

export interface QuarantineAssessment {
  /** Every problem, in words: the shape of the file first, then the policy. */
  problems: string[];
  /** The entries that have no problem. Only these quarantine a test: a list with a typo in it protects nothing that it names wrongly. */
  effective: QuarantineEntry[];
}

/** The shape problems of a read and the policy problems of its entries, and the entries that can be trusted. */
export function assessQuarantine(read: ReadResult, options: ValidateOptions): QuarantineAssessment {
  const policy = validateQuarantine(read.entries, options);
  const rejected = new Set(policy.map((p) => p.entry));
  return {
    problems: [...read.problems, ...policy.map((p) => p.message)],
    effective: read.entries.filter((entry) => !rejected.has(entry)),
  };
}

/** `day` plus `n` days, as `YYYY-MM-DD`. */
export function addDays(day: string, n: number): string {
  const base = dayNumber(day);
  if (base === null) throw new RangeError(`"${day}" is not a day written YYYY-MM-DD`);
  return new Date((base + n) * MS_PER_DAY).toISOString().slice(0, 10);
}

function covers(entry: QuarantineEntry, id: string, project: string): boolean {
  return entry.id === id && (entry.project === undefined || entry.project === project);
}

/** The entry that quarantines the test on `today` (valid from `since` through the end of `expires`), or null. */
export function findQuarantine(
  entries: readonly QuarantineEntry[],
  id: string,
  project: string,
  today: string,
): QuarantineEntry | null {
  const now = dayNumber(today);
  if (now === null) return null;
  return (
    entries.find((entry) => {
      const since = dayNumber(entry.since);
      const expires = dayNumber(entry.expires);
      return (
        covers(entry, id, project) && since !== null && expires !== null && since <= now && now <= expires
      );
    }) ?? null
  );
}

export function isQuarantined(
  entries: readonly QuarantineEntry[],
  id: string,
  project: string,
  today: string,
): boolean {
  return findQuarantine(entries, id, project, today) !== null;
}

/** The entries in force on `today`: started, and not past their expiry. */
export function activeEntries(entries: readonly QuarantineEntry[], today: string): QuarantineEntry[] {
  const now = dayNumber(today);
  if (now === null) return [];
  return entries.filter((entry) => {
    const since = dayNumber(entry.since);
    const expires = dayNumber(entry.expires);
    return since !== null && expires !== null && since <= now && now <= expires;
  });
}

export interface ExpiredEntry {
  entry: QuarantineEntry;
  tier: GateTier | null;
  /** Days past the expiry, 1 or more. */
  daysOver: number;
}

/** The entries whose expiry has passed: the day after `expires` and every day after it. */
export function expiredEntries(
  entries: readonly QuarantineEntry[],
  today: string,
  catalog: CatalogFacts,
): ExpiredEntry[] {
  const now = dayNumber(today);
  if (now === null) return [];
  const out: ExpiredEntry[] = [];
  for (const entry of entries) {
    const expires = dayNumber(entry.expires);
    if (expires !== null && now > expires) {
      out.push({ entry, tier: catalog.get(entry.id)?.tier ?? null, daysOver: now - expires });
    }
  }
  return out;
}

export interface LoadedQuarantine extends ReadResult {
  /** The file was found. A file that is missing is a problem for the gate, and no quarantine for everything else. */
  found: boolean;
}

export function parseQuarantineText(text: string, source = QUARANTINE_FILE): ReadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { entries: [], problems: [`${source}: not JSON: ${(error as Error).message}`] };
  }
  return readQuarantine(value, source);
}

export function loadQuarantine(path: string, source = QUARANTINE_FILE): LoadedQuarantine {
  if (!existsSync(path)) {
    return {
      found: false,
      entries: [],
      problems: [
        `${source}: the file is missing; it is the list of record, commit it (empty if nothing is quarantined)`,
      ],
    };
  }
  return { found: true, ...parseQuarantineText(readFileSync(path, 'utf8'), source) };
}

export const STRATEGY_FILE = 'TEST_STRATEGY.md';

/** The catalog of the strategy document as the facts a quarantine is judged against. Throws when the catalog does not parse. */
export function loadCatalogFacts(path: string): CatalogFacts {
  return catalogFacts(parseCatalog(readFileSync(path, 'utf8')));
}

export interface LoadListOptions {
  quarantineFile: string;
  strategyFile: string;
  /** `YYYY-MM-DD`, UTC. */
  today: string;
}

export interface LoadedList {
  /** The list as read from the file: the entries of the right shape, and what was wrong with the others. */
  read: LoadedQuarantine;
  /** The entries without a problem, and every problem in words. */
  assessment: QuarantineAssessment;
  catalog: CatalogFacts;
}

/** The quarantine list of the repository, read and judged: what the gate, the merge wrapper and the report all start from. */
export function loadList(options: LoadListOptions): LoadedList {
  const catalog = loadCatalogFacts(options.strategyFile);
  const read = loadQuarantine(options.quarantineFile);
  return { read, assessment: assessQuarantine(read, { catalog, today: options.today }), catalog };
}
