import { describe, expect, it } from 'vitest';
import { LOG_CAPACITY } from '../../../src/server/constants.ts';
import { RequestLog } from '../../../src/server/requestlog.ts';
import type { LogStart } from '../../../src/server/requestlog.ts';

const start = (path: string, extra: Partial<LogStart> = {}): LogStart => ({
  method: 'GET',
  path,
  kind: 'segment',
  arrivedAtMs: 10_500,
  sessionStartMs: 10_000,
  ...extra,
});

describe('RequestLog', () => {
  it('numbers requests from 1 in arrival order and says what the next number will be', () => {
    const log = new RequestLog();
    expect(log.peekNextSeq()).toBe(1);
    expect(log.begin(start('/a')).seq).toBe(1);
    expect(log.begin(start('/b')).seq).toBe(2);
    expect(log.peekNextSeq()).toBe(3);
    expect(log.lastSequence).toBe(2);
  });

  it('lists a request from its arrival, pending, and completes it in place', () => {
    const log = new RequestLog();
    const entry = log.begin(start('/s/x/vod/seg/v240/3.m4s', { rep: 'v240', number: 3 }));
    expect(log.since()[0]).toMatchObject({
      seq: 1,
      method: 'GET',
      kind: 'segment',
      rep: 'v240',
      number: 3,
      status: 0,
      bytes: 0,
      pending: true,
      msSinceStart: 500,
      t: new Date(10_500).toISOString(),
    });
    Object.assign(entry, { status: 200, bytes: 75_000, ttfbMs: 4, totalMs: 40, pending: false });
    expect(log.since()[0]).toMatchObject({ status: 200, bytes: 75_000, pending: false });
  });

  it('returns only entries after the cursor, in seq order, so a late completion cannot be skipped by a cursor', () => {
    const log = new RequestLog();
    const slow = log.begin(start('/slow'));
    log.begin(start('/fast'));
    const cursor = log.lastSequence; // 2: taken while /slow is still in flight
    log.begin(start('/after'));
    expect(log.since(cursor).map((e) => e.path)).toEqual(['/after']);
    expect(log.since(0).map((e) => e.path)).toEqual(['/slow', '/fast', '/after']);
    slow.status = 200;
    slow.pending = false;
    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('hands out copies: a reader never sees an entry change under it, and cannot corrupt the log', () => {
    const log = new RequestLog();
    const entry = log.begin(start('/a'));
    const snapshot = log.since()[0]!;
    entry.status = 200;
    expect(snapshot.status).toBe(0);
    snapshot.faults.push('tampered');
    snapshot.path = '/changed';
    expect(log.since()[0]).toMatchObject({ path: '/a', faults: [] });
  });

  it('keeps the last LOG_CAPACITY entries and keeps numbering', () => {
    const log = new RequestLog(5);
    for (let i = 1; i <= 8; i++) log.begin(start(`/r${i}`));
    expect(log.size).toBe(5);
    expect(log.since().map((e) => e.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(log.peekNextSeq()).toBe(9);
    expect(LOG_CAPACITY).toBe(5000);
  });

  it('clamps a negative msSinceStart (a clock step) to 0', () => {
    const log = new RequestLog();
    log.begin(start('/a', { arrivedAtMs: 9000 }));
    expect(log.since()[0]!.msSinceStart).toBe(0);
  });
});
