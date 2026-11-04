import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_NAMES,
  attachDiagnostics,
  attachmentName,
} from '../../../tests/e2e/support/diagnostics.ts';
import type { DiagnosticSources } from '../../../tests/e2e/support/diagnostics.ts';

// The attachments of a failed test are the input of failure triage, so their names, their count and their content are pinned here
// over a fake TestInfo and fake sources: nothing needs a browser.

interface Attached {
  name: string;
  body: string;
  contentType: string | undefined;
}

function fakeTestInfo() {
  const attached: Attached[] = [];
  return {
    attached,
    names: () => attached.map((a) => a.name),
    json: (name: string): unknown => JSON.parse(attached.find((a) => a.name === name)?.body ?? 'null'),
    attach: async (name: string, options?: { body?: string | Buffer; contentType?: string }) => {
      attached.push({ name, body: String(options?.body), contentType: options?.contentType });
    },
  };
}

const events = [{ index: 0, t: 1, name: 'load-requested', mediaTime: 0 }];
const metrics = { state: 'error', startupMs: null };
const info = { config: 'A', loadMode: 'media-source', userAgent: 'Fixture/1.0' };
const consoleEntries = [{ type: 'error', text: 'Refused to load the script' }];

function player(overrides: Record<string, () => Promise<unknown>> = {}) {
  return {
    events: () => Promise.resolve(events),
    metrics: () => Promise.resolve(metrics),
    info: () => Promise.resolve(info),
    consoleEntries: () => consoleEntries,
    ...overrides,
  } as unknown as DiagnosticSources['players'][number];
}

function service(overrides: Record<string, () => Promise<unknown>> = {}) {
  return {
    detail: (id: string) => Promise.resolve({ id, faults: [], counters: { requests: 3 } }),
    log: (id: string, since: number) => Promise.resolve([{ seq: 1, path: `/s/${id}/x`, since }]),
    ...overrides,
  } as unknown as DiagnosticSources['service'];
}

describe('attachmentName', () => {
  it('keeps the plain name for the first, and numbers the others from 2', () => {
    expect(attachmentName('qa-events.json', 0)).toBe('qa-events.json');
    expect(attachmentName('qa-events.json', 1)).toBe('qa-events-2.json');
    expect(attachmentName('request-log.json', 2)).toBe('request-log-3.json');
  });
});

describe('attachDiagnostics', () => {
  it('attaches the six documents of a failed test, under their fixed names, as JSON', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, { service: service(), sessions: [{ id: 's1' }], players: [player()] });
    expect(testInfo.names().sort()).toStrictEqual([
      'page-console.json',
      'qa-events.json',
      'qa-info.json',
      'qa-metrics.json',
      'request-log.json',
      'session-detail.json',
    ]);
    expect(testInfo.attached.every((a) => a.contentType === 'application/json')).toBe(true);
    expect(testInfo.json('qa-events.json')).toStrictEqual(events);
    expect(testInfo.json('qa-metrics.json')).toStrictEqual(metrics);
    expect(testInfo.json('qa-info.json')).toStrictEqual(info);
    expect(testInfo.json('page-console.json')).toStrictEqual(consoleEntries);
    expect(testInfo.json('session-detail.json')).toMatchObject({ id: 's1', counters: { requests: 3 } });
  });

  it('reads the whole request log, not a window of it', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, { service: service(), sessions: [{ id: 's1' }], players: [] });
    expect(testInfo.json('request-log.json')).toStrictEqual([{ seq: 1, path: '/s/s1/x', since: 0 }]);
  });

  it('names the attachments of a second player and a second session with -2, and keeps the first ones plain', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, {
      service: service(),
      sessions: [{ id: 's1' }, { id: 's2' }],
      players: [player(), player()],
    });
    expect(testInfo.names()).toContain('qa-events.json');
    expect(testInfo.names()).toContain('qa-events-2.json');
    expect(testInfo.names()).toContain('session-detail-2.json');
    expect(testInfo.json('request-log-2.json')).toStrictEqual([{ seq: 1, path: '/s/s2/x', since: 0 }]);
    expect(testInfo.names()).toHaveLength(12);
  });

  it('attaches nothing for a test that never opened a player or created a session', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, { service: service(), sessions: [], players: [] });
    expect(testInfo.names()).toStrictEqual([]);
  });

  it('keeps the other attachments when one read fails, and says which and why', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, {
      service: service({
        detail: () => Promise.reject(new Error('GET /api/sessions/s1 -> 404 session not found')),
      }),
      sessions: [{ id: 's1' }],
      players: [
        player({
          events: () =>
            Promise.reject(new Error('page.evaluate: Target page, context or browser has been closed')),
        }),
      ],
    });
    expect(testInfo.names()).not.toContain('qa-events.json');
    expect(testInfo.names()).not.toContain('session-detail.json');
    for (const kept of ['qa-metrics.json', 'qa-info.json', 'page-console.json', 'request-log.json']) {
      expect(testInfo.names()).toContain(kept);
    }
    expect(testInfo.json(ATTACHMENT_NAMES.problems)).toStrictEqual({
      'qa-events.json': 'page.evaluate: Target page, context or browser has been closed',
      'session-detail.json': 'GET /api/sessions/s1 -> 404 session not found',
    });
  });

  it('gives up on a read that never answers (a page whose main thread is stuck) and still attaches the rest', async () => {
    const testInfo = fakeTestInfo();
    const stuck = () => new Promise<never>(() => {});
    await attachDiagnostics(
      testInfo,
      { service: service(), sessions: [{ id: 's1' }], players: [player({ metrics: stuck, events: stuck })] },
      { readTimeoutMs: 30 },
    );
    expect(testInfo.names().sort()).toStrictEqual([
      'diagnostics-problems.json',
      'page-console.json',
      'qa-info.json',
      'request-log.json',
      'session-detail.json',
    ]);
    expect(testInfo.json(ATTACHMENT_NAMES.problems)).toStrictEqual({
      'qa-events.json': 'no answer within 30 ms',
      'qa-metrics.json': 'no answer within 30 ms',
    });
  });

  it('attaches no problems file when every read worked', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, { service: service(), sessions: [{ id: 's1' }], players: [player()] });
    expect(testInfo.names()).not.toContain(ATTACHMENT_NAMES.problems);
  });

  it('writes the JSON indented, for a person who opens the file', async () => {
    const testInfo = fakeTestInfo();
    await attachDiagnostics(testInfo, { service: service(), sessions: [], players: [player()] });
    expect(testInfo.attached.find((a) => a.name === 'qa-info.json')?.body).toBe(
      JSON.stringify(info, null, 2),
    );
  });

  it('does not throw when the attachment itself cannot be stored: the failure being explained must stay the failure', async () => {
    const testInfo = {
      attach: () => Promise.reject(new Error('disk full')),
    };
    await expect(
      attachDiagnostics(testInfo, { service: service(), sessions: [{ id: 's1' }], players: [player()] }),
    ).resolves.toBeUndefined();
  });
});
