// The history of the runs, as pure functions: append a run, trim, merge, and the text form (JSON lines). The stores (store.ts) move this
// text between a file or a git branch and the program; nothing here touches either.
//
// One run per line, with the keys in a fixed order, so that recording a build adds one line to the file and a diff of the branch
// shows exactly the runs that were added (and, when the history is full, the runs that fell off its start).
import { parseRun, RunFormatError } from './run.ts';
import type { FlakeRun } from './run.ts';

/**
 * Runs kept per environment. 200 is almost seven windows of 30: enough to see how a rate moved over time, small enough that the
 * file stays a few hundred kilobytes and the branch does not grow without bound.
 */
export const HISTORY_MAX_RUNS = 200;

export class HistoryError extends Error {
  override name = 'HistoryError';
}

/** JSON with the keys of every object sorted and no white space: the same data is always the same line. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`cannot serialise the number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`cannot serialise a ${typeof value}`);
}

/** One line per run, each ending in a newline; an empty history is the empty text. */
export function serializeHistory(history: readonly FlakeRun[]): string {
  return history.map((run) => `${canonicalJson(run)}\n`).join('');
}

/** Reads the text of a history file. A line that is not a valid run is an error that names the line: nothing is skipped silently. */
export function parseHistory(text: string, source = 'history'): FlakeRun[] {
  const runs: FlakeRun[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    const where = `${source}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const merge = /^(<<<<<<<|=======|>>>>>>>)/.test(line)
        ? ' (a merge conflict marker: the file was merged as text)'
        : '';
      throw new HistoryError(`${where}: not JSON${merge}: ${(error as Error).message}`);
    }
    try {
      runs.push(parseRun(value, where));
    } catch (error) {
      if (error instanceof RunFormatError) throw new HistoryError(error.message);
      throw error;
    }
  });
  return runs;
}

/** Oldest first; runs that started at the same instant keep the order they were given in. */
function byDate(history: readonly FlakeRun[]): FlakeRun[] {
  return history
    .map((run, index) => ({ run, index, time: Date.parse(run.date) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ run }) => run);
}

/** Keeps the last `max` runs of every environment. The relative order of what stays is unchanged. */
export function trimHistory(history: readonly FlakeRun[], max = HISTORY_MAX_RUNS): FlakeRun[] {
  const seen = new Map<string, number>();
  const kept: FlakeRun[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const run = history[i] as FlakeRun;
    const count = (seen.get(run.envId) ?? 0) + 1;
    seen.set(run.envId, count);
    if (count <= max) kept.push(run);
  }
  return kept.reverse();
}

export function hasRun(history: readonly FlakeRun[], invocationId: string): boolean {
  return history.some((run) => run.invocationId === invocationId);
}

/**
 * The history with a run added, in the order of the dates the runs started, and trimmed. A run that is already in the history (the same
 * invocation: a recorded file that is recorded again) is not added a second time, and what was recorded is not rewritten.
 */
export function appendRun(history: readonly FlakeRun[], run: FlakeRun, max = HISTORY_MAX_RUNS): FlakeRun[] {
  if (hasRun(history, run.invocationId)) return trimHistory(history, max);
  return trimHistory(byDate([...history, run]), max);
}

/** Several histories as one: each invocation once (the first copy wins), in date order, trimmed. */
export function mergeHistories(
  histories: readonly (readonly FlakeRun[])[],
  max = HISTORY_MAX_RUNS,
): FlakeRun[] {
  const seen = new Set<string>();
  const all: FlakeRun[] = [];
  for (const history of histories) {
    for (const run of history) {
      if (seen.has(run.invocationId)) continue;
      seen.add(run.invocationId);
      all.push(run);
    }
  }
  return trimHistory(byDate(all), max);
}

/** The runs of one environment. A history file holds one; a merged history may hold several. */
export function runsOfEnvironment(history: readonly FlakeRun[], envId: string): FlakeRun[] {
  return history.filter((run) => run.envId === envId);
}
