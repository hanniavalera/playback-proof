import { describe, expect, it } from 'vitest';
import {
  appendRun,
  canonicalJson,
  HISTORY_MAX_RUNS,
  HistoryError,
  mergeHistories,
  parseHistory,
  runsOfEnvironment,
  serializeHistory,
  trimHistory,
} from '../../../flake/history.ts';
import { parseRun, RunFormatError } from '../../../flake/run.ts';
import type { FlakeRun } from '../../../flake/run.ts';
import { record, run } from './fixtures.ts';

/** A run as loose JSON: the tests below break one field at a time, which the real types would not let them write. */
type LooseTest = { [key: string]: unknown; attempts: Array<{ [key: string]: unknown }> };
type LooseRun = { [key: string]: unknown; tests: LooseTest[] };

/** The same data with the keys of every object in the opposite order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversedKeys(item)]),
    );
  }
  return value;
}

const runs = (n: number, options: { envId?: string; start?: number } = {}): FlakeRun[] =>
  Array.from({ length: n }, (_, i) =>
    run([record({ id: 'PB-VOD-001', outcome: i % 7 === 3 ? 'flaky' : 'passed' })], {
      envId: options.envId ?? 'gha-linux-x64',
      invocationId: `${options.envId ?? 'gha-linux-x64'}-${(options.start ?? 0) + i}`,
    }),
  );

describe('PB-LAB-004 history text: JSON lines with a stable key order', () => {
  it('writes one line per run and reads the same runs back', () => {
    const history = [
      run([
        record({ id: 'PB-VOD-001', outcome: 'flaky' }),
        record({ id: 'PB-VOD-002', outcome: 'skipped', skipReason: 'documented gap in x' }),
      ]),
      run([record({ id: 'PB-VOD-001', outcome: 'failed', experimental: true })]),
    ];
    const text = serializeHistory(history);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(2);
    expect(parseHistory(text)).toEqual(history);
    expect(serializeHistory([])).toBe('');
    expect(parseHistory('')).toEqual([]);
  });

  it('writes the same line whatever the order the keys were built in', () => {
    const [a] = runs(1);
    const original = a as FlakeRun;
    const shuffled = reversedKeys(original) as FlakeRun;
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(original));
    expect(serializeHistory([shuffled])).toBe(serializeHistory([original]));
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('adds one line when a run is recorded, and removes lines only from the start when the history is full', () => {
    const before = runs(5);
    const next = run([record({ id: 'PB-VOD-001' })], { envId: 'gha-linux-x64' });
    const after = appendRun(before, next);
    expect(serializeHistory(after).startsWith(serializeHistory(before))).toBe(true);
    expect(serializeHistory(after).slice(serializeHistory(before).length)).toBe(serializeHistory([next]));

    const full = runs(HISTORY_MAX_RUNS);
    const newest = run([record({ id: 'PB-VOD-001' })], { envId: 'gha-linux-x64' });
    const grown = appendRun(full, newest);
    expect(grown).toHaveLength(HISTORY_MAX_RUNS);
    expect(serializeHistory(grown)).toBe(serializeHistory([...full.slice(1), newest]));
  });

  it('refuses a number JSON cannot hold and a value it cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/cannot serialise/);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/cannot serialise/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/cannot serialise a function/);
  });
});

describe('PB-LAB-004 history: trim, append and merge', () => {
  it('keeps the last 200 runs of every environment and leaves the others alone', () => {
    expect(HISTORY_MAX_RUNS).toBe(200);
    const mixed = [...runs(250, { envId: 'gha-linux-x64' }), ...runs(10, { envId: 'gha-macos-arm64' })];
    const trimmed = trimHistory(mixed);
    expect(runsOfEnvironment(trimmed, 'gha-linux-x64')).toHaveLength(200);
    expect(runsOfEnvironment(trimmed, 'gha-macos-arm64')).toHaveLength(10);
    // The oldest fall off: what stays is the newest 200.
    expect(runsOfEnvironment(trimmed, 'gha-linux-x64')[0]?.invocationId).toBe('gha-linux-x64-50');
    expect(runsOfEnvironment(trimmed, 'gha-linux-x64').at(-1)?.invocationId).toBe('gha-linux-x64-249');
    expect(trimHistory(mixed, 5).filter((r) => r.envId === 'gha-macos-arm64')).toHaveLength(5);
    expect(trimHistory([], 5)).toEqual([]);
  });

  it('does not count a run twice: recording the same invocation again changes nothing, and nothing already recorded is rewritten', () => {
    const [first] = runs(1);
    const history = appendRun([], first as FlakeRun);
    const again = appendRun(history, first as FlakeRun);
    expect(again).toEqual(history);
    const changed = { ...(first as FlakeRun), commit: 'f'.repeat(40) };
    expect(appendRun(history, changed)[0]?.commit).toBe((first as FlakeRun).commit);
  });

  it('puts a run in the order of the date it started, whatever the order it was recorded in', () => {
    const [a, b, c] = runs(3);
    const history = appendRun(appendRun([], c as FlakeRun), a as FlakeRun);
    const all = appendRun(history, b as FlakeRun);
    expect(all.map((r) => r.invocationId)).toEqual([a, b, c].map((r) => (r as FlakeRun).invocationId));
    // The same start keeps the order the runs were given in.
    const t = '2026-11-01T00:00:00.000Z';
    const twins = [
      { ...(a as FlakeRun), invocationId: 'x1', date: t },
      { ...(b as FlakeRun), invocationId: 'x2', date: t },
    ];
    expect(
      appendRun(appendRun([], twins[0] as FlakeRun), twins[1] as FlakeRun).map((r) => r.invocationId),
    ).toEqual(['x1', 'x2']);
  });

  it('merges histories: every invocation once, the first copy wins, in date order, trimmed', () => {
    const base = runs(6);
    const left = base.slice(0, 4);
    const right = [...base.slice(2), { ...(base[3] as FlakeRun), commit: 'e'.repeat(40) }];
    const merged = mergeHistories([right, left]);
    expect(merged.map((r) => r.invocationId)).toEqual(base.map((r) => r.invocationId));
    expect(merged[3]?.commit).toBe((base[3] as FlakeRun).commit);
    expect(mergeHistories([runs(250), runs(30, { start: 1000 })])).toHaveLength(HISTORY_MAX_RUNS);
    expect(mergeHistories([])).toEqual([]);
  });
});

describe('PB-LAB-004 reading a history: nothing is skipped silently', () => {
  const [good] = runs(1);
  const line = serializeHistory([good as FlakeRun]);

  it('ignores blank lines and names the line of every problem', () => {
    expect(parseHistory(`\n${line}\n\n${line.replace('inv-', 'inv-b-')}`)).toHaveLength(2);
    expect(() => parseHistory(`${line}{not json}\n`, 'ci-data')).toThrow(/ci-data:2: not JSON/);
    expect(() => parseHistory(`${line}<<<<<<< HEAD\n`, 'ci-data')).toThrow(
      /ci-data:2: not JSON \(a merge conflict marker/,
    );
    const wrong = JSON.parse(line) as Record<string, unknown>;
    wrong.status = 'green';
    const error = (() => {
      try {
        parseHistory(`${line}${JSON.stringify(wrong)}\n`, 'ci-data');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(HistoryError);
    expect((error as Error).message).toMatch(
      /ci-data:2: \$\.status: expected one of passed, failed, timedout, interrupted, found "green"/,
    );
  });

  it('refuses a schema version it does not know, saying so', () => {
    const future = { ...(JSON.parse(line) as object), schemaVersion: 2 };
    expect(() => parseRun(future, 'x')).toThrow(
      /x: \$\.schemaVersion: expected 1, found 2: this tool does not read that version/,
    );
  });

  it('checks the fields the tools act on', () => {
    const good = JSON.parse(line) as FlakeRun;
    const mutate = (change: (r: LooseRun) => void): unknown => {
      const copy = JSON.parse(line) as LooseRun;
      change(copy);
      return copy;
    };
    const first = (r: LooseRun): LooseTest => r.tests[0] as LooseTest;
    const cases: Array<[string, unknown, RegExp]> = [
      ['a missing run id', mutate((r) => delete r.runId), /\$\.runId: expected a non-empty string/],
      [
        'a local time',
        mutate((r) => (r.date = '2026-11-01T12:00:00+02:00')),
        /\$\.date: expected an ISO 8601 UTC time/,
      ],
      ['a date that is not one', mutate((r) => (r.date = '2026-13-45T99:00:00Z')), /\$\.date/],
      ['a negative duration', mutate((r) => (r.durationMs = -1)), /\$\.durationMs: expected a number >= 0/],
      ['a shard 3 of 2', mutate((r) => (r.shard = { current: 3, total: 2 })), /\$\.shard: shard 3 of 2/],
      [
        'tests that are not a list',
        mutate((r) => ((r as { tests: unknown }).tests = {})),
        /\$\.tests: expected a list/,
      ],
      [
        'an unknown outcome',
        mutate((r) => (first(r).outcome = 'green')),
        /tests\[0\]\.outcome: expected one of/,
      ],
      [
        'a tier its tags do not give',
        mutate((r) => (first(r).tier = 'release')),
        /tests\[0\]\.tier: says release but the tags \["@merge"\] are merge/,
      ],
      [
        'a quarantine flag that is not a boolean',
        mutate((r) => (first(r).quarantined = 'yes')),
        /quarantined: expected a boolean/,
      ],
      ['negative retries', mutate((r) => (first(r).retries = -1)), /retries: expected an integer >= 0/],
      ['no attempts', mutate((r) => (first(r).attempts = [])), /attempts: expected at least one attempt/],
      [
        'an attempt with an unknown status',
        mutate((r) => (first(r).attempts[0] = { status: 'ok', durationMs: 1 })),
        /attempts\[0\]\.status/,
      ],
      [
        'a flaky outcome with one attempt',
        mutate((r) => {
          first(r).outcome = 'flaky';
          first(r).attempts = first(r).attempts.slice(0, 1);
        }),
        /flaky needs at least two attempts/,
      ],
      [
        'an experimental flag set to false',
        mutate((r) => (first(r).experimental = false)),
        /experimental: expected true, or the field absent/,
      ],
    ];
    expect(good.tests[0]?.tags).toEqual(['@merge']);
    for (const [name, value, message] of cases) {
      expect(() => parseRun(value, 'run.json'), name).toThrow(RunFormatError);
      expect(() => parseRun(value, 'run.json'), name).toThrow(message);
    }
  });

  it('keeps the fields it does not know, so that an older tool does not erase what a newer one wrote', () => {
    const value = JSON.parse(line) as LooseRun;
    value.futureField = { a: 1 };
    (value.tests[0] as LooseTest).futureField = 'kept';
    const read = parseRun(value) as unknown as LooseRun;
    expect(read.futureField).toEqual({ a: 1 });
    expect((read.tests[0] as LooseTest).futureField).toBe('kept');
    expect(serializeHistory([read as unknown as FlakeRun])).toContain('"futureField":"kept"');
  });
});
