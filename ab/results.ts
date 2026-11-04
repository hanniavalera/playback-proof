import type { FaultRule } from '../src/shared/faults.ts';
import type { HostInfo } from '../src/lab/probe/host-info.ts';
import type { StreamId } from '../src/shared/streams.ts';
import type { SessionRecord } from './types.ts';

// The raw results of a run: what the runner writes under docs/results/ab/ and what the report (and the A/A calibration, and the power
// analysis) read back. Everything a statistic needs is in the file, together with the pre-registration it was run under (its exact text),
// so that a report can be regenerated, and its hash checked, from this one file.

export const RESULT_SCHEMA_VERSION = 1;

export interface PreregistrationProvenance {
  /** The path of the file, relative to the repository. */
  path: string;
  /** sha256 of the exact bytes of the file the run was started from. */
  sha256: string;
  /** The exact text of the file: the plan, byte for byte. */
  text: string;
  /**
   * Whether the file was committed, unmodified, when the run started, and the commit that last touched it: the evidence that the plan was
   * fixed before the data existed. null when git could not say (a container without the repository's git directory).
   */
  committed: { clean: boolean; commit: string | null; date: string | null } | null;
}

export interface BrowserRecord {
  name: string;
  version: string;
  userAgent: string | null;
}

export interface ConditionResult {
  id: string;
  /** The rules that were sent with every session of the condition. */
  rules: FaultRule[];
  stream: StreamId;
  startedAt: string;
  finishedAt: string;
  loadAverage: { before: number; after: number };
  /** Every session of the condition, warm-up included, in the order they ran. */
  sessions: SessionRecord[];
  /** Set when the condition ended early (too many consecutive failures): the reason; the sessions that did run are all here. */
  aborted: string | null;
}

export interface RawResult {
  schemaVersion: 1;
  kind: 'ab-raw';
  preregistration: PreregistrationProvenance;
  environment: {
    envId: string;
    host: HostInfo;
    browser: BrowserRecord;
    ffmpeg: string;
    /** The content hash of the stream, by id (the streams the service reports). */
    streams: Partial<Record<StreamId, string>>;
  };
  run: {
    startedAt: string;
    finishedAt: string;
    /** The command that produced the file. */
    command: string;
  };
  conditions: ConditionResult[];
}

export class ResultFileError extends Error {
  override name = 'ResultFileError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the text of a raw results file and checks the parts everything else relies on: the version, the pre-registration it carries, and
 * the shape of every session. A file that does not check out is refused with what is wrong: a report must never be written from a damaged
 * record.
 */
export function parseRawResult(text: string, file = 'the results file'): RawResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ResultFileError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const problems: string[] = [];
  if (!isRecord(parsed)) throw new ResultFileError(`${file} must be a JSON object`);
  if (parsed.schemaVersion !== RESULT_SCHEMA_VERSION)
    problems.push(`schemaVersion must be ${RESULT_SCHEMA_VERSION}, it is ${String(parsed.schemaVersion)}`);
  if (parsed.kind !== 'ab-raw') problems.push('kind must be "ab-raw"');
  const prereg = parsed.preregistration;
  if (
    !isRecord(prereg) ||
    typeof prereg.text !== 'string' ||
    typeof prereg.sha256 !== 'string' ||
    typeof prereg.path !== 'string'
  )
    problems.push('preregistration must carry the path, the sha256 and the text of the plan');
  if (!isRecord(parsed.environment) || typeof parsed.environment.envId !== 'string')
    problems.push('environment must say which environment it was measured in');
  if (!Array.isArray(parsed.conditions) || parsed.conditions.length === 0)
    problems.push('conditions must be a non-empty array');
  else {
    for (const [index, condition] of parsed.conditions.entries()) {
      const where = `conditions[${index}]`;
      if (!isRecord(condition) || typeof condition.id !== 'string' || !Array.isArray(condition.sessions)) {
        problems.push(`${where} must have an id and its sessions`);
        continue;
      }
      for (const [s, session] of condition.sessions.entries()) {
        const at = `${where}.sessions[${s}]`;
        if (!isRecord(session)) {
          problems.push(`${at} must be an object`);
          continue;
        }
        if (session.arm !== 'A' && session.arm !== 'B') problems.push(`${at}.arm must be "A" or "B"`);
        if (session.status !== 'ok' && session.status !== 'failed')
          problems.push(`${at}.status must be "ok" or "failed"`);
        if (typeof session.warmup !== 'boolean') problems.push(`${at}.warmup must be true or false`);
        if (!isRecord(session.values)) problems.push(`${at}.values must be an object`);
      }
    }
  }
  if (problems.length > 0)
    throw new ResultFileError(`${file} is not a valid raw result:\n  - ${problems.join('\n  - ')}`);
  return parsed as unknown as RawResult;
}
