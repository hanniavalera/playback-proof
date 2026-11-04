import { describe, expect, it } from 'vitest';
import { ServiceClient } from '../../../src/lab/service-client.ts';
import type { RequestLogEntry } from '../../../src/shared/api.ts';
import type { TestSession } from '../../../tests/e2e/support/session.ts';
import {
  describeEntry,
  requestLogCursor,
  requestsFor,
  rungsFetched,
  segmentNumbersFetched,
  waitForRequest,
  waitForRequests,
} from '../../../tests/e2e/support/waiting.ts';

// Waiting on the server's request log, and reading it. The client is the real `ServiceClient` (so the real polling runs) over an
// in-memory log that the test appends to while a wait is pending.

function entry(seq: number, overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    seq,
    t: '2030-01-01T00:00:00.000Z',
    msSinceStart: seq * 100,
    method: 'GET',
    path: `/s/x/vod-cmaf/seg/v360/${seq}.m4s`,
    kind: 'segment',
    rep: 'v360',
    number: seq,
    status: 200,
    bytes: 1000,
    ttfbMs: 2,
    totalMs: 4,
    faults: [],
    ...overrides,
  };
}

class FakeClient extends ServiceClient {
  readonly entries: RequestLogEntry[] = [];
  constructor() {
    super('http://127.0.0.1:1');
  }
  override log(_id: string, since = 0): Promise<RequestLogEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.seq > since).map((e) => ({ ...e })));
  }
}

function fakeSession(): { session: TestSession; client: FakeClient } {
  const client = new FakeClient();
  const session = { id: 'sess-1', service: client } as unknown as TestSession;
  return { session, client };
}

describe('describeEntry', () => {
  it('reads like a line of the server log', () => {
    expect(describeEntry(entry(7))).toBe('#7 GET segment v360 #7 -> 200 in 4 ms');
    expect(
      describeEntry(
        entry(1, { kind: 'manifest', rep: undefined, number: undefined, status: 503, faults: ['r1'] }),
      ),
    ).toBe('#1 GET manifest -> 503 in 4 ms [faults r1]');
    expect(describeEntry(entry(3, { pending: true, status: 0 }))).toBe('#3 GET segment v360 #3 -> pending');
    expect(describeEntry(entry(4, { aborted: true }))).toBe('#4 GET segment v360 #4 -> 200 aborted in 4 ms');
  });
});

describe('requestLogCursor', () => {
  it('is 0 for an empty log and the highest seq otherwise', async () => {
    const { session, client } = fakeSession();
    await expect(requestLogCursor(session)).resolves.toBe(0);
    client.entries.push(entry(1), entry(2), entry(5));
    await expect(requestLogCursor(session)).resolves.toBe(5);
  });
});

describe('waitForRequest', () => {
  it('resolves at once with a request that is already in the log', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1), entry(2), entry(3));
    await expect(waitForRequest(session, (e) => e.number === 2)).resolves.toMatchObject({ seq: 2 });
  });

  it('only looks after the cursor, so an earlier request cannot satisfy a wait that started later', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1), entry(2));
    const since = await requestLogCursor(session);
    setTimeout(() => client.entries.push(entry(3)), 40);
    await expect(waitForRequest(session, (e) => e.kind === 'segment', { since })).resolves.toMatchObject({
      seq: 3,
    });
  });

  it('resolves on a request that has started and not finished, unless the predicate asks for the answer', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1, { number: 7, pending: true, status: 0 }));
    await expect(waitForRequest(session, (e) => e.number === 7)).resolves.toMatchObject({ pending: true });
    setTimeout(() => {
      client.entries[0] = entry(1, { number: 7 });
    }, 40);
    await expect(waitForRequest(session, (e) => e.number === 7 && !e.pending)).resolves.toMatchObject({
      status: 200,
    });
  });

  it('rejects on timeout with what it waited for and the last requests, so the failure explains itself', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1), entry(2, { status: 404 }));
    const error = await waitForRequest(session, (e) => e.number === 99, { timeoutMs: 120 }).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      'waited 120 ms for a request of session sess-1 matching (e) => e.number === 99',
    );
    expect(message).toContain('The log after the cursor has 2 entries, the last 2:');
    expect(message).toContain('#2 GET segment v360 #2 -> 404 in 4 ms');
  });

  it('says so when the log is empty', async () => {
    const { session } = fakeSession();
    const error = await waitForRequest(session, () => true, { timeoutMs: 60 }).catch((e: Error) => e);
    expect((error as Error).message).toContain('The log has no entries after the cursor.');
  });
});

describe('waitForRequests', () => {
  it('waits for the count, and returns every match', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1, { kind: 'manifest', rep: undefined, number: undefined }));
    setTimeout(
      () => client.entries.push(entry(2, { kind: 'manifest', rep: undefined, number: undefined })),
      30,
    );
    setTimeout(
      () => client.entries.push(entry(3, { kind: 'manifest', rep: undefined, number: undefined })),
      60,
    );
    const found = await waitForRequests(session, (e) => e.kind === 'manifest', { count: 3 });
    expect(found.map((e) => e.seq)).toStrictEqual([1, 2, 3]);
  });

  it('names the count in the failure', async () => {
    const { session, client } = fakeSession();
    client.entries.push(entry(1));
    const error = await waitForRequests(session, () => true, { count: 5, timeoutMs: 60 }).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toContain('waited 60 ms for 5 requests');
  });

  it.each([0, 1.5, -2])('refuses a count of %s', async (count) => {
    const { session } = fakeSession();
    await expect(waitForRequests(session, () => true, { count })).rejects.toThrow(RangeError);
  });

  it('lets a service failure through unchanged: a deleted session is not "no matching request"', async () => {
    const { session, client } = fakeSession();
    client.log = () => Promise.reject(new Error('GET /api/sessions/sess-1/log -> 404 session not found'));
    await expect(waitForRequest(session, () => true, { timeoutMs: 60 })).rejects.toThrow(
      '404 session not found',
    );
  });
});

describe('reading the log', () => {
  const log: RequestLogEntry[] = [
    entry(1, {
      kind: 'manifest',
      rep: undefined,
      number: undefined,
      path: '/s/x/vod-cmaf/dash/manifest.mpd',
    }),
    entry(2, { kind: 'init', rep: 'v240', number: undefined }),
    entry(3, { kind: 'init', rep: 'a-aac', number: undefined }),
    entry(4, { rep: 'v240', number: 1 }),
    entry(5, { rep: 'a-aac', number: 1 }),
    entry(6, { rep: 'v240', number: 2 }),
    entry(7, { rep: 'v360', number: 3, status: 503 }),
    entry(8, { rep: 'v360', number: 3 }),
    entry(9, { rep: 'v360', number: 4, pending: true, status: 0 }),
    entry(10, { rep: 'v720', number: 5, aborted: true }),
    entry(11, { kind: 'manifest', rep: 'v360', number: undefined, method: 'HEAD' }),
  ];

  describe('requestsFor', () => {
    const seqs = (filter: Parameters<typeof requestsFor>[1]): number[] =>
      requestsFor(log, filter).map((e) => e.seq);

    it('filters by kind (one or several), rep (one or several), number and range', () => {
      expect(seqs({ kind: 'init' })).toStrictEqual([2, 3]);
      expect(seqs({ kind: ['init', 'manifest'] })).toStrictEqual([1, 2, 3, 11]);
      expect(seqs({ kind: 'segment', rep: 'v240' })).toStrictEqual([4, 6]);
      expect(seqs({ rep: ['v240', 'a-aac'], kind: 'segment' })).toStrictEqual([4, 5, 6]);
      expect(seqs({ kind: 'segment', number: 3 })).toStrictEqual([7, 8]);
      expect(seqs({ kind: 'segment', number: { from: 2, to: 4 } })).toStrictEqual([6, 7, 8, 9]);
    });

    it('filters by status: a code, ok, error; and an unfinished request is neither ok nor an error', () => {
      expect(seqs({ status: 503 })).toStrictEqual([7]);
      expect(seqs({ kind: 'segment', status: 'ok' })).toStrictEqual([4, 5, 6, 8, 10]);
      expect(seqs({ status: 'error' })).toStrictEqual([7, 10]);
      expect(seqs({ pending: true })).toStrictEqual([9]);
      expect(seqs({ pending: false, kind: 'segment', rep: 'v360' })).toStrictEqual([7, 8]);
    });

    it('filters by method, and returns everything for an empty filter', () => {
      expect(seqs({ method: 'HEAD' })).toStrictEqual([11]);
      expect(seqs({})).toHaveLength(11);
    });

    it('does not match a number when the entry has none', () => {
      expect(seqs({ number: 1, kind: 'init' })).toStrictEqual([]);
    });
  });

  describe('segmentNumbersFetched', () => {
    it('lists the numbers in arrival order with repeats, and ignores manifests and init segments', () => {
      expect(segmentNumbersFetched(log, 'v240')).toStrictEqual([1, 2]);
      expect(segmentNumbersFetched(log, 'v360')).toStrictEqual([3, 3, 4]);
      expect(segmentNumbersFetched(log, 'a-aac')).toStrictEqual([1]);
      expect(segmentNumbersFetched(log, 'v999')).toStrictEqual([]);
    });

    it('can keep only the delivered ones, or only the failed ones', () => {
      expect(segmentNumbersFetched(log, 'v360', { status: 'ok' })).toStrictEqual([3]);
      expect(segmentNumbersFetched(log, 'v360', { status: 'error' })).toStrictEqual([3]);
      expect(segmentNumbersFetched(log, 'v360', { pending: true })).toStrictEqual([4]);
    });
  });

  describe('rungsFetched', () => {
    it('lists the video rungs in the order of their first segment request', () => {
      expect(rungsFetched(log)).toStrictEqual(['v240', 'v360', 'v720']);
    });

    it('can list the audio, or both, and does not count a manifest or an HLS media playlist', () => {
      expect(rungsFetched(log, { track: 'audio' })).toStrictEqual(['a-aac']);
      expect(rungsFetched(log, { track: 'any' })).toStrictEqual(['v240', 'a-aac', 'v360', 'v720']);
      expect(rungsFetched([entry(1, { kind: 'manifest', rep: 'v720', number: undefined })])).toStrictEqual(
        [],
      );
      expect(rungsFetched([])).toStrictEqual([]);
    });
  });
});
