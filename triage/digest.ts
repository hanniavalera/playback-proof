import { oneLine, truncate } from './text.ts';
import type {
  ConsoleDigest,
  DiagnosticsDigest,
  EventsDigest,
  FaultDigest,
  MetricsDigest,
  RequestFailureDigest,
  RequestLogDigest,
  ShakaErrorDigest,
} from './types.ts';

// Digests of the failure attachments (docs/CONTRACTS.md section 7.2). The documents are written by the lab's own fixture, but they are read
// after the fact, from artifacts of another machine and maybe another version, so every field is checked and nothing throws: a field
// that is not what it should be is a field that is missing. Each digest is small on purpose: what a person reads and what a prompt carries.

export const MAX_LISTED_REQUESTS = 8;
export const MAX_CONSOLE_SAMPLES = 3;
export const EVENTS_AROUND = 8;
const MAX_SAMPLE_CHARS = 160;
const MAX_ERROR_CHARS = 240;

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// ---------------------------------------------------------------------------------------------------------------------
// Errors and events

function errorDigest(value: unknown): ShakaErrorDigest | null {
  const error = asRecord(value);
  if (!error) return null;
  const code = asNumber(error.code);
  if (code === null) return null;
  return {
    code,
    codeName: asString(error.codeName),
    category: asNumber(error.category) ?? 0,
    severity: asNumber(error.severity) ?? 1,
    message: oneLine(asString(error.message) ?? '', MAX_ERROR_CHARS),
    source: asString(error.source),
  };
}

const errorKey = (error: ShakaErrorDigest): string =>
  `${error.code}|${error.severity}|${error.source ?? ''}|${error.message}`;

/** One line of the timeline, the way the hook prints it in a failed wait (src/player/timeline.ts), so the two read alike. */
export function formatEvent(event: unknown): string | null {
  const item = asRecord(event);
  const name = asString(item?.name);
  if (!item || name === null) return null;
  const index = asNumber(item.index);
  const t = asNumber(item.t);
  const media = asNumber(item.mediaTime);
  let line = `#${index ?? '?'} t=${t === null ? '?' : t.toFixed(1)} media=${media === null ? '?' : media.toFixed(3)} ${name}`;
  if (item.detail !== undefined) {
    const detail = JSON.stringify(item.detail) ?? '';
    line += ` ${truncate(detail, MAX_SAMPLE_CHARS)}`;
  }
  return line;
}

export interface EventsReading {
  digest: EventsDigest;
  errors: Array<{ error: ShakaErrorDigest; count: number }>;
}

/**
 * The timeline: how many events, which names, the errors in order, and a few events around the first critical error (or the end of
 * the timeline when the player never reported one): "around the failure".
 */
export function digestEvents(events: unknown): EventsReading {
  const list = asArray(events).filter((event) => asRecord(event) !== null) as Json[];
  const names: Record<string, number> = {};
  const errors = new Map<string, { error: ShakaErrorDigest; count: number; at: number }>();
  let critical = -1;
  list.forEach((event, position) => {
    const name = asString(event.name);
    if (name === null) return;
    names[name] = (names[name] ?? 0) + 1;
    if (name !== 'error') return;
    const error = errorDigest(event.detail);
    if (!error) return;
    if (error.severity >= 2 && critical < 0) critical = position;
    const key = errorKey(error);
    const seen = errors.get(key);
    if (seen) seen.count += 1;
    else errors.set(key, { error, count: 1, at: position });
  });
  const focus = critical >= 0 ? critical : list.length - 1;
  const from = Math.max(0, Math.min(focus - 3, list.length - EVENTS_AROUND));
  const around = list
    .slice(from, from + EVENTS_AROUND)
    .map(formatEvent)
    .filter((line): line is string => line !== null);
  return {
    digest: { total: list.length, names, around },
    errors: [...errors.values()].sort((a, b) => a.at - b.at).map(({ error, count }) => ({ error, count })),
  };
}

export interface MetricsReading {
  digest: MetricsDigest;
  errors: ShakaErrorDigest[];
}

const EMPTY_METRICS: MetricsDigest = {
  state: null,
  startupMs: null,
  rebuffers: null,
  frames: null,
  liveLatencyMs: null,
  bitrateSwitches: null,
  currentTime: null,
};

/** `qa-metrics.json` (`QAMetrics`): the numbers the metric assertions are about, and the errors the player held at the end. */
export function digestMetrics(metrics: unknown): MetricsReading {
  const m = asRecord(metrics);
  if (!m) return { digest: { ...EMPTY_METRICS }, errors: [] };
  const rebuffer = asRecord(m.rebuffer);
  const frames = asRecord(m.frames);
  const live = asRecord(m.live);
  const bitrate = asRecord(m.bitrate);
  const playback = asRecord(m.playback);
  const count = asNumber(rebuffer?.count);
  const decoded = asNumber(frames?.decoded);
  return {
    digest: {
      state: asString(m.state),
      startupMs: asNumber(m.startupMs),
      rebuffers: count === null ? null : { count, totalMs: asNumber(rebuffer?.totalMs) ?? 0 },
      frames: decoded === null ? null : { decoded, dropped: asNumber(frames?.dropped) ?? 0 },
      liveLatencyMs: asNumber(live?.latencyMs),
      bitrateSwitches: asNumber(bitrate?.switches),
      currentTime: asNumber(playback?.currentTime),
    },
    errors: asArray(m.errors)
      .map(errorDigest)
      .filter((error): error is ShakaErrorDigest => error !== null),
  };
}

/** The errors of the timeline and of the metrics as one list, in order of appearance, each once. The first critical one is the primary. */
export function mergeErrors(
  fromEvents: ReadonlyArray<{ error: ShakaErrorDigest; count: number }>,
  fromMetrics: readonly ShakaErrorDigest[],
): { errors: ShakaErrorDigest[]; primary: ShakaErrorDigest | null } {
  const errors: ShakaErrorDigest[] = [];
  const seen = new Set<string>();
  for (const { error } of fromEvents) {
    seen.add(errorKey(error));
    errors.push(error);
  }
  for (const error of fromMetrics) {
    if (seen.has(errorKey(error))) continue;
    seen.add(errorKey(error));
    errors.push(error);
  }
  return { errors, primary: errors.find((error) => error.severity >= 2) ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser console and the page's own report

export function digestConsole(entries: unknown): ConsoleDigest {
  const digest: ConsoleDigest = { errors: 0, warnings: 0, pageErrors: 0, samples: [] };
  const seen = new Set<string>();
  for (const entry of asArray(entries)) {
    const item = asRecord(entry);
    const type = asString(item?.type);
    if (!item || type === null) continue;
    if (type === 'warning') digest.warnings += 1;
    else if (type === 'pageerror') digest.pageErrors += 1;
    else if (type === 'error') digest.errors += 1;
    else continue;
    if (type === 'warning') continue;
    const text = oneLine(asString(item.text) ?? '', MAX_SAMPLE_CHARS);
    if (text === '' || seen.has(text) || digest.samples.length >= MAX_CONSOLE_SAMPLES) continue;
    seen.add(text);
    digest.samples.push(text);
  }
  return digest;
}

export function digestInfo(info: unknown): {
  userAgent: string | null;
  config: string | null;
  loadMode: string | null;
} {
  const i = asRecord(info);
  return {
    userAgent: asString(i?.userAgent),
    config: asString(i?.config),
    loadMode: asString(i?.loadMode),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The server's side: the request log and the session's fault rules

/** `status 503 on segment v360 #3-5, first 2`: a fault rule as a short sentence. */
export function describeRule(rule: unknown): string {
  const r = asRecord(rule);
  if (!r) return 'a rule';
  const type = asString(r.type) ?? 'rule';
  const parameters: string[] = [];
  if (type === 'status') parameters.push(String(asNumber(r.status) ?? '?'));
  if (type === 'throttle') parameters.push(`${asNumber(r.kbps) ?? '?'} kbps`);
  if (type === 'latency') parameters.push(`${asNumber(r.ms) ?? '?'} ms`);
  if (type === 'stall')
    parameters.push(`${asNumber(r.ms) ?? '?'} ms after ${asNumber(r.afterBytes) ?? 0} bytes`);
  if (type === 'abort') parameters.push(`after ${asNumber(r.afterBytes) ?? 0} bytes`);
  if (type === 'live-stall')
    parameters.push(`at segment ${asNumber(r.atNumber) ?? '?'} for ${asNumber(r.ms) ?? '?'} ms`);
  if (type === 'manifest-stale') parameters.push(`${asNumber(r.ms) ?? '?'} ms`);
  const match = asRecord(r.match);
  const where: string[] = [];
  if (match) {
    where.push(asString(match.kind) ?? 'media');
    if (asString(match.track) && match.track !== 'any') where.push(String(match.track));
    if (asString(match.rep)) where.push(String(match.rep));
    const number = match.number;
    if (typeof number === 'number') where.push(`#${number}`);
    const range = asRecord(number);
    if (range) where.push(`#${asNumber(range.from) ?? '?'}-${asNumber(range.to) ?? '?'}`);
  }
  const limits: string[] = [];
  if (asNumber(r.times) !== null) limits.push(`first ${String(r.times)}`);
  if (asNumber(r.afterMs) !== null && r.afterMs !== 0) limits.push(`after ${String(r.afterMs)} ms`);
  if (asNumber(r.forMs) !== null) limits.push(`for ${String(r.forMs)} ms`);
  return [type, ...parameters, where.length > 0 ? `on ${where.join(' ')}` : '', limits.join(', ')]
    .filter((part) => part !== '')
    .join(' ');
}

const EMPTY_LOG: RequestLogDigest = {
  entries: 0,
  segments: 0,
  manifests: 0,
  inits: 0,
  other: 0,
  originFailures: 0,
  originFailuresWithoutFault: 0,
  clientAborted: 0,
  pending: 0,
  byStatus: {},
  failed: [],
};

/**
 * A request log as docs/CONTRACTS.md section 4 says to read it: an origin failure is a finished request with a status of 400 or more,
 * or one the origin cut (`fault-abort`, `error`); a client that hung up (`client-closed`) is the player cancelling a request, not the
 * origin failing. `SessionDetail.counters.errors` counts both, which is why it is not used.
 */
export function digestRequestLog(log: unknown): { digest: RequestLogDigest; fired: Map<string, number> } {
  const digest: RequestLogDigest = { ...EMPTY_LOG, byStatus: {}, failed: [] };
  const fired = new Map<string, number>();
  const statuses = new Map<number, number>();
  for (const raw of asArray(log)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    digest.entries += 1;
    const kind = asString(entry.kind) ?? 'other';
    if (kind === 'segment') digest.segments += 1;
    else if (kind === 'manifest') digest.manifests += 1;
    else if (kind === 'init') digest.inits += 1;
    else digest.other += 1;
    const faults = asArray(entry.faults).filter((id): id is string => typeof id === 'string');
    for (const id of faults) fired.set(id, (fired.get(id) ?? 0) + 1);
    if (entry.pending === true) {
      digest.pending += 1;
      continue;
    }
    const status = asNumber(entry.status) ?? 0;
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    const aborted = entry.aborted === true;
    const reason = asString(entry.abortReason);
    if (aborted && reason === 'client-closed') {
      digest.clientAborted += 1;
      continue;
    }
    if (status < 400 && !aborted) continue;
    digest.originFailures += 1;
    if (faults.length === 0) digest.originFailuresWithoutFault += 1;
    if (digest.failed.length < MAX_LISTED_REQUESTS) {
      const failure: RequestFailureDigest = {
        seq: asNumber(entry.seq) ?? 0,
        kind,
        rep: asString(entry.rep),
        number: asNumber(entry.number),
        status,
        abortReason: aborted ? (reason ?? 'aborted') : null,
        faults,
      };
      digest.failed.push(failure);
    }
  }
  digest.byStatus = Object.fromEntries(
    [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([status, count]) => [String(status), count]),
  );
  return { digest, fired };
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything together

/** The documents of one player and one session, by index (0 is the plain name, 1 is `-2`...). Each is the parsed JSON or absent. */
export interface AttachmentSet {
  events: unknown[];
  metrics: unknown[];
  info: unknown[];
  console: unknown[];
  sessionDetail: unknown[];
  requestLog: unknown[];
  problems: unknown;
  attached: string[];
}

const EMPTY_DIAGNOSTICS: DiagnosticsDigest = {
  attached: [],
  players: 0,
  sessions: 0,
  shakaErrors: [],
  primaryError: null,
  metrics: { ...EMPTY_METRICS },
  events: { total: 0, names: {}, around: [] },
  requestLog: null,
  faults: [],
  console: { errors: 0, warnings: 0, pageErrors: 0, samples: [] },
  problems: {},
  userAgent: null,
  config: null,
  loadMode: null,
};

export function emptyDiagnostics(): DiagnosticsDigest {
  return structuredClone(EMPTY_DIAGNOSTICS);
}

function mergeLogs(digests: RequestLogDigest[]): RequestLogDigest {
  const merged: RequestLogDigest = { ...EMPTY_LOG, byStatus: {}, failed: [] };
  const statuses = new Map<number, number>();
  for (const digest of digests) {
    merged.entries += digest.entries;
    merged.segments += digest.segments;
    merged.manifests += digest.manifests;
    merged.inits += digest.inits;
    merged.other += digest.other;
    merged.originFailures += digest.originFailures;
    merged.originFailuresWithoutFault += digest.originFailuresWithoutFault;
    merged.clientAborted += digest.clientAborted;
    merged.pending += digest.pending;
    for (const [status, count] of Object.entries(digest.byStatus)) {
      statuses.set(Number(status), (statuses.get(Number(status)) ?? 0) + count);
    }
    for (const failure of digest.failed) {
      if (merged.failed.length < MAX_LISTED_REQUESTS) merged.failed.push(failure);
    }
  }
  merged.byStatus = Object.fromEntries(
    [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([status, count]) => [String(status), count]),
  );
  return merged;
}

/** A list with holes (a second player's document without the first's) as a list without: absent ones are `undefined`, which every digest reads as empty. */
const dense = (list: readonly unknown[]): unknown[] =>
  Array.from({ length: list.length }, (_, index) => list[index]);

/** The digest of everything a failed test attached. The first player and session are the plain names; a second one is `-2`. */
export function digestDiagnostics(set: AttachmentSet): DiagnosticsDigest {
  const digest = emptyDiagnostics();
  digest.attached = [...set.attached];
  digest.players = Math.max(set.events.length, set.metrics.length, set.info.length, set.console.length);
  digest.sessions = Math.max(set.sessionDetail.length, set.requestLog.length);

  const eventErrors: Array<{ error: ShakaErrorDigest; count: number }> = [];
  const metricErrors: ShakaErrorDigest[] = [];
  const timelines = dense(set.events).map(digestEvents);
  if (timelines[0]) digest.events = timelines[0].digest;
  for (const reading of timelines) eventErrors.push(...reading.errors);
  const metrics = dense(set.metrics).map(digestMetrics);
  if (metrics[0]) digest.metrics = metrics[0].digest;
  for (const reading of metrics) metricErrors.push(...reading.errors);
  const merged = mergeErrors(eventErrors, metricErrors);
  digest.shakaErrors = merged.errors;
  digest.primaryError = merged.primary;

  const info = digestInfo(set.info[0]);
  digest.userAgent = info.userAgent;
  digest.config = info.config;
  digest.loadMode = info.loadMode;

  const consoles = dense(set.console).map(digestConsole);
  digest.console = consoles.reduce(
    (total, one) => ({
      errors: total.errors + one.errors,
      warnings: total.warnings + one.warnings,
      pageErrors: total.pageErrors + one.pageErrors,
      samples: [...total.samples, ...one.samples.filter((s) => !total.samples.includes(s))].slice(
        0,
        MAX_CONSOLE_SAMPLES,
      ),
    }),
    digest.console,
  );

  const logs = dense(set.requestLog).map(digestRequestLog);
  if (logs.length > 0) digest.requestLog = mergeLogs(logs.map((log) => log.digest));
  const details = dense(set.sessionDetail);
  const faults: FaultDigest[] = [];
  for (let index = 0; index < Math.max(details.length, logs.length); index += 1) {
    const prefix = index === 0 ? '' : `s${index + 1}/`;
    const fired = logs[index]?.fired ?? new Map<string, number>();
    const seen = new Set<string>();
    for (const rule of asArray(asRecord(details[index])?.faults)) {
      const id = asString(asRecord(rule)?.id);
      if (id === null) continue;
      seen.add(id);
      faults.push({
        id: `${prefix}${id}`,
        type: asString(asRecord(rule)?.type),
        description: describeRule(rule),
        fired: fired.get(id) ?? 0,
      });
    }
    // A rule the log names but the detail does not list (a detail that was not attached, a rule removed mid-test).
    for (const [id, count] of fired) {
      if (!seen.has(id)) faults.push({ id: `${prefix}${id}`, type: null, description: null, fired: count });
    }
  }
  digest.faults = faults;

  const problems = asRecord(set.problems);
  if (problems) {
    for (const [name, reason] of Object.entries(problems)) {
      digest.problems[name] = oneLine(String(reason), MAX_ERROR_CHARS);
    }
  }
  return digest;
}
