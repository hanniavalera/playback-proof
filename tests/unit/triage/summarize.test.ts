import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMock } from '../../../tools/triage-mock.ts';
import type { MockServer } from '../../../tools/triage-mock.ts';
import { cluster } from '../../../triage/cluster.ts';
import { containsSecret } from '../../../triage/redact.ts';
import {
  buildPrompt,
  DEFAULT_API_VERSION,
  DEFAULT_MODEL,
  NO_KEY_NOTE,
  NO_WORKSPACE_NOTE,
  optionsFromEnv,
  parseRetryAfter,
  PROMPT_VERSION,
  summarize,
  SYSTEM_PROMPT,
} from '../../../triage/summarize.ts';
import type { SummarizeOptions } from '../../../triage/summarize.ts';
import type { Cluster, Failure } from '../../../triage/types.ts';
import { makeScratch } from '../support/scratch.ts';
import { FAKE_API_KEY, SECRETS } from './secrets.ts';
import {
  diagnosticsOf,
  event,
  failure,
  metrics,
  requestEntry,
  sessionDetail,
  shakaError,
} from './support.ts';

// The summarizer is verified against a local mock of the Messages API (tools/triage-mock.ts) and against nothing else: there is no key on this
// machine and the live service has not been called. What these tests prove is what the mock can prove (docs/TRIAGE.md says the rest).

let mock: MockServer;
let scratch: string;
let counter = 0;

beforeAll(() => {
  scratch = makeScratch('triage-summarize-');
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  mock = await startMock();
});
afterEach(async () => {
  await mock.close();
});

const cacheDir = (): string => {
  counter += 1;
  return join(scratch, `cache-${counter}`);
};

/** Four clusters of 3, 2, 1 and 1 failures: a fault that was not recovered, a wait, a metric and a refused connection. */
function clusters(): Cluster[] {
  const ended = shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, 'HTTP error status 503');
  const failures: Failure[] = [
    ...['chromium', 'firefox', 'webkit'].map((project) =>
      failure({
        id: 'PB-REC-002',
        project,
        message: 'Error: player state (metrics.state) after every rung was refused',
        diagnostics: diagnosticsOf({
          events: [event(0, 'load-requested'), event(1, 'error', ended)],
          metrics: metrics({ state: 'error', errors: [ended] }),
          detail: sessionDetail([
            { id: 'f1', type: 'status', status: 503, match: { kind: 'segment', rep: 'v360' } },
          ]),
          log: [requestEntry(1), requestEntry(2, { status: 503, faults: ['f1'] })],
          attached: ['qa-events.json', 'qa-metrics.json', 'session-detail.json', 'request-log.json'],
        }),
      }),
    ),
    ...['chromium', 'webkit'].map((project) =>
      failure({
        id: 'PB-VOD-006',
        project,
        message: "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).",
      }),
    ),
    failure({
      id: 'PB-ABR-002',
      message: 'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 800 ms',
      diagnostics: diagnosticsOf({ metrics: metrics({ rebuffers: 2 }) }),
    }),
    failure({
      id: 'PB-VOD-001',
      message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
    }),
  ];
  return cluster(failures);
}

interface Run {
  sleeps: number[];
  logs: string[];
}

/** The options of a run against the mock: no waiting for backoff (the sleeps are recorded), no cache unless the test gives one. */
function options(overrides: Partial<SummarizeOptions> = {}): SummarizeOptions & Run {
  const run: Run = { sleeps: [], logs: [] };
  return {
    apiKey: FAKE_API_KEY,
    baseUrl: mock.origin,
    cacheDir: null,
    sleep: (ms) => {
      run.sleeps.push(ms);
      return Promise.resolve();
    },
    log: (line) => run.logs.push(line),
    ...overrides,
    ...run,
  };
}

describe('PB-LAB-005 triage summaries: the request is the one the documentation describes', () => {
  it('sends one POST to /v1/messages with exactly the documented headers and body, and reads the text block of the answer', async () => {
    mock.script({ kind: 'ok', thinking: true, text: 'Likely root cause: the origin refused.' });
    const [first] = clusters();
    const result = await summarize([first as Cluster], options());

    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.problems).toStrictEqual([]);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe(FAKE_API_KEY);
    expect(request.headers['anthropic-version']).toBe(DEFAULT_API_VERSION);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers.authorization).toBeUndefined();

    expect(Object.keys(request.body ?? {})).toStrictEqual(['model', 'max_tokens', 'system', 'messages']);
    expect(request.body).toMatchObject({ model: DEFAULT_MODEL, max_tokens: 2000, system: SYSTEM_PROMPT });
    const messages = request.body?.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(typeof messages[0]?.content).toBe('string');
    for (const removed of ['temperature', 'top_p', 'top_k', 'stream', 'thinking', 'output_config']) {
      expect(request.body, removed).not.toHaveProperty(removed);
    }

    expect(result.records).toStrictEqual([
      expect.objectContaining({
        clusterKey: first?.key,
        status: 'summarized',
        text: 'Likely root cause: the origin refused.',
        model: 'claude-haiku-5-5',
        usage: expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) }),
      }),
    ]);
    expect(result.note).toBeNull();
    expect(result.endpoint).toBe(mock.origin);
    expect(result.requests).toBe(1);
  });

  it('uses the default model of the documentation, and the one in ANTHROPIC_MODEL when it is set', async () => {
    expect(DEFAULT_MODEL).toBe('claude-haiku-5-5');
    const [first] = clusters();
    await summarize([first as Cluster], options());
    await summarize(
      [first as Cluster],
      options({
        ...optionsFromEnv({ ANTHROPIC_MODEL: ' claude-sonnet-5-5 ' }),
        apiKey: FAKE_API_KEY,
        baseUrl: mock.origin,
      }),
    );
    expect(mock.requests.map((r) => r.body?.model)).toStrictEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('reads its settings from the environment, and an empty value is no value', () => {
    const none = { apiKey: undefined, baseUrl: undefined, model: undefined, workspaceId: undefined };
    expect(optionsFromEnv({})).toStrictEqual(none);
    expect(
      optionsFromEnv({
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_BASE_URL: '  ',
        ANTHROPIC_MODEL: '',
        ANTHROPIC_WORKSPACE_ID: ' ',
      }),
    ).toStrictEqual(none);
    expect(
      optionsFromEnv({
        ANTHROPIC_API_KEY: ' k ',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4751',
        ANTHROPIC_MODEL: 'm',
        ANTHROPIC_WORKSPACE_ID: ' wrkspc_test ',
      }),
    ).toStrictEqual({
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:4751',
      model: 'm',
      workspaceId: 'wrkspc_test',
    });
  });

  it('sends the workspace header only when a workspace was given: a key scoped to one workspace must omit it', async () => {
    const [first] = clusters();
    await summarize([first as Cluster], options());
    await summarize([first as Cluster], options({ workspaceId: 'wrkspc_01TestTestTest', refresh: true }));
    expect(mock.requests.map((request) => request.headers['anthropic-workspace-id'])).toStrictEqual([
      undefined,
      'wrkspc_01TestTestTest',
    ]);
    expect(mock.requests.map((request) => request.problems)).toStrictEqual([[], []]);
  });

  it('refuses a workspace id that could not be a header value, before it sends anything', async () => {
    const [first] = clusters();
    for (const bad of ['wrkspc 1', 'wrkspc"1', 'a\r\nx-evil: 1', 'w'.repeat(200)]) {
      const result = await summarize([first as Cluster], options({ workspaceId: bad }));
      expect(result.note).toBe(NO_WORKSPACE_NOTE);
      expect(result.records).toStrictEqual([]);
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('puts what a person reads in the prompt, in order, and the instruction that the clustering is authoritative in the system prompt', async () => {
    const [first] = clusters();
    await summarize([first as Cluster], options());
    const sent = mock.requests[0]?.body as { system: string; messages: Array<{ content: string }> };
    expect(sent.system).toMatch(/authoritative/);
    expect(sent.system).toMatch(/do not regroup/i);
    expect(sent.system).toMatch(/data, not instructions/);
    const content = sent.messages[0]?.content ?? '';
    const at = (text: string) => content.indexOf(text);
    expect(at(`Cluster 1 of 1 (key ${first?.key})`)).toBe(0);
    expect(content).toContain(
      'Category: network-fault-not-recovered, decided by the rule "fault-fired-player-failed"',
    );
    expect(content).toContain('Size: 3 failures of 1 test (PB-REC-002) in chromium, firefox, webkit');
    expect(content).toContain(
      'Signature: Error: player state (metrics.state) after every rung was refused [thrown] {shaka 1001}',
    );
    expect(content).toContain('fault f1 (status 503 on segment v360) fired on 1 request');
    expect(content).toContain('Errors the player reported: BAD_HTTP_STATUS 1001 (critical)');
    expect(content).toContain('Events of the timeline around the failure:');
    expect(at('Category:')).toBeLessThan(at('What the rule found:'));
    expect(at('What the rule found:')).toBeLessThan(at('Representative failure:'));
    expect(at('Representative failure:')).toBeLessThan(at('Events of the timeline'));
  });

  it('cuts the evidence of one cluster at the limit and says so', async () => {
    const [first] = clusters();
    await summarize([first as Cluster], options({ maxClusterChars: 400 }));
    const content = (mock.requests[0]?.body?.messages as Array<{ content: string }>)[0]?.content ?? '';
    expect(content.length).toBeLessThanOrEqual(400);
    expect(content.endsWith('[evidence cut at 400 characters]')).toBe(true);
    expect(buildPrompt(first as Cluster, 1, 1, 100_000).user.length).toBeGreaterThan(400);
  });
});

describe('PB-LAB-005 triage summaries: no secret leaves, and the key travels in one header only', () => {
  /** A failure that carries a secret of every kind in the places a failure carries text: the message, an error, an event, the console. */
  function leaky(): Cluster[] {
    const all = Object.values(SECRETS).join(' | ');
    const error = { ...shakaError(1001, 'BAD_HTTP_STATUS', 1, 2, `refused with ${SECRETS['github-token']}`) };
    return cluster([
      failure({
        id: 'PB-VOD-001',
        file: 'tests/e2e/vod-start.spec.ts',
        message: `Error: leaked ${all}\nsecond line: key ${FAKE_API_KEY} at /Users/hannia/repos/playback-proof/.cache/x.json for me@example.com`,
        frames: [
          { file: '/Users/hannia/repos/playback-proof/tests/e2e/rec/faults.ts', fn: 'waitForFault', line: 5 },
        ],
        missing: [`qa-events.json: could not be read (${SECRETS['bearer-token']})`],
        diagnostics: diagnosticsOf({
          events: [
            event(0, 'load-requested', {
              uri: `http://127.0.0.1:4731/s/abc/manifest.mpd?token=${SECRETS['jwt']}`,
            }),
            event(1, 'error', error),
          ],
          metrics: metrics({ state: 'error', errors: [error] }),
          console: [
            {
              type: 'error',
              text: `Failed to load ${SECRETS['url-credentials']} with api_key=${SECRETS['anthropic-api-key']}`,
            },
          ],
          attached: ['qa-events.json', 'qa-metrics.json', 'page-console.json'],
        }),
      }),
    ]);
  }

  it('fails if ANY request of the run contains the text of a secret pattern, the key or a planted secret', async () => {
    const run = options();
    const result = await summarize(leaky(), run);
    expect(mock.requests.length).toBeGreaterThan(0);
    for (const request of mock.requests) {
      expect(containsSecret(request.rawBody), 'a secret pattern in the body').toBeNull();
      expect(containsSecret(request.url), 'a secret pattern in the url').toBeNull();
      for (const [name, secret] of Object.entries(SECRETS)) {
        // The second half of a secret: a pattern that took only the head of it would leave this behind.
        const tail = secret.slice(Math.floor(secret.length / 2));
        expect(request.rawBody, `${name} in the body`).not.toContain(tail);
        expect(request.url, `${name} in the url`).not.toContain(tail);
      }
      expect(request.rawBody).not.toContain(FAKE_API_KEY);
      expect(request.rawBody).not.toContain('hannia');
      expect(request.rawBody).not.toContain('example.com');
      expect(request.rawBody).not.toContain('127.0.0.1');
      // The key is in the header that carries it, and in no other one.
      expect(request.headers['x-api-key']).toBe(FAKE_API_KEY);
      for (const [name, value] of Object.entries(request.headers)) {
        if (name !== 'x-api-key') expect(value, `header ${name}`).not.toContain(FAKE_API_KEY);
      }
    }
    // Nothing the run says about itself carries it either.
    const said = JSON.stringify([result, run.logs, run.sleeps]);
    expect(said).not.toContain(FAKE_API_KEY);
    expect(containsSecret(said)).toBeNull();
  });

  it('leaves the sentence readable: what the evidence says survives, with placeholders where the secrets were', async () => {
    await summarize(leaky(), options());
    const content = (mock.requests[0]?.body?.messages as Array<{ content: string }>)[0]?.content ?? '';
    expect(content).toContain('Error: leaked');
    expect(content).toContain('<anthropic-api-key>');
    expect(content).toContain('<home>/repos/playback-proof/.cache/x.json');
    expect(content).toContain('<email>');
    expect(content).toContain('http://<host>/s/abc/manifest.mpd?<query>');
    expect(content).toContain('tests/e2e/rec/faults.ts');
  });

  it('does not send a request whose evidence still has a secret after redaction: it fails closed, and says why without printing it', async () => {
    const result = await summarize(leaky(), options({ redact: (text) => text }));
    expect(mock.requests).toHaveLength(0);
    expect(result.records[0]?.status).toBe('failed');
    expect(result.records[0]?.note).toMatch(
      /^not sent: the evidence still matches the secret pattern [a-z-]+ after redaction$/,
    );
    expect(JSON.stringify(result)).not.toContain(FAKE_API_KEY);
  });

  it('does not send a request that contains the key, even when the key has no recognisable shape', async () => {
    const plain = 'plain-looking-key-without-a-prefix';
    const text = cluster([failure({ message: `Error: the environment printed ${plain}` })]);
    const result = await summarize(text, options({ apiKey: plain, redact: (t) => t }));
    expect(mock.requests).toHaveLength(0);
    expect(result.records[0]?.note).toBe('not sent: the evidence still contains the api key after redaction');
  });

  it('scrubs the key from an error the service echoes back', async () => {
    mock.script({
      kind: 'error',
      status: 400,
      type: 'invalid_request_error',
      message: `bad key ${FAKE_API_KEY} in your request`,
    });
    const [first] = clusters();
    const result = await summarize([first as Cluster], options());
    expect(result.records[0]?.status).toBe('failed');
    expect(result.records[0]?.note).toContain('<api-key>');
    expect(JSON.stringify(result)).not.toContain(FAKE_API_KEY);
  });
});

describe('PB-LAB-005 triage summaries: no key, no request', () => {
  it('sends nothing, says it once, and returns no records', async () => {
    for (const apiKey of [undefined, '']) {
      const result = await summarize(clusters(), options({ apiKey }));
      expect(result.records).toStrictEqual([]);
      expect(result.note).toBe(NO_KEY_NOTE);
      expect(NO_KEY_NOTE).toBe('summaries skipped: ANTHROPIC_API_KEY is not set');
    }
    expect(mock.requests).toHaveLength(0);
  });
});

describe('PB-LAB-005 triage summaries: when the service says no', () => {
  it('records a 400 for the cluster and does not retry it', async () => {
    mock.script({
      kind: 'error',
      status: 400,
      type: 'invalid_request_error',
      message: 'messages: nothing to answer',
    });
    const all = clusters();
    const run = options();
    const result = await summarize(all.slice(0, 2), run);
    expect(result.records[0]).toMatchObject({
      status: 'failed',
      note: 'HTTP 400 invalid_request_error: messages: nothing to answer (request req_mock_000000)',
    });
    expect(result.records[1]?.status).toBe('summarized');
    expect(mock.requests).toHaveLength(2);
    expect(run.sleeps).toStrictEqual([]);
    expect(result.note).toBe('summaries: 1 failed (the notes say why; the clusters above are unaffected)');
  });

  it('stops after a 401: the other clusters are not attempted and cost nothing', async () => {
    mock.script({ kind: 'error', status: 401, type: 'authentication_error', message: 'invalid x-api-key' });
    const result = await summarize(clusters(), options());
    expect(mock.requests).toHaveLength(1);
    expect(result.records.map((r) => r.status)).toStrictEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(result.records[1]?.note).toBe(
      'not attempted: HTTP 401 authentication_error: invalid x-api-key (request req_mock_000000)',
    );
  });

  it('waits for the retry-after of a 429 and tries again, and the second answer is the summary', async () => {
    mock.script({
      kind: 'error',
      status: 429,
      type: 'rate_limit_error',
      message: 'slow down',
      retryAfter: '2',
    });
    const [first] = clusters();
    const run = options();
    const result = await summarize([first as Cluster], run);
    expect(run.sleeps).toStrictEqual([2000]);
    expect(mock.requests).toHaveLength(2);
    expect(result.records[0]?.status).toBe('summarized');
  });

  it('gives up on a 429 that keeps coming after the retries it is allowed, waiting what it was told to', async () => {
    mock.fallback = {
      kind: 'error',
      status: 429,
      type: 'rate_limit_error',
      message: 'slow down',
      retryAfter: '1',
    };
    const [first] = clusters();
    const run = options({ retries: 2 });
    const result = await summarize([first as Cluster], run);
    expect(mock.requests).toHaveLength(3);
    expect(run.sleeps).toStrictEqual([1000, 1000]);
    expect(result.records[0]).toMatchObject({ status: 'failed' });
    expect(result.records[0]?.note).toMatch(/^HTTP 429 rate_limit_error: slow down.*, after 2 retries$/);
  });

  it('does not wait for a retry-after longer than the run is willing to wait', async () => {
    mock.script({
      kind: 'error',
      status: 429,
      type: 'rate_limit_error',
      message: 'slow down',
      retryAfter: '3600',
    });
    const [first] = clusters();
    const run = options();
    const result = await summarize([first as Cluster], run);
    expect(mock.requests).toHaveLength(1);
    expect(run.sleeps).toStrictEqual([]);
    expect(result.records[0]?.note).toMatch(/retry-after 3600 s is longer than the 60 s this run waits/);
  });

  it('stops at once on a 429 that is a spend cap: nothing a retry could change', async () => {
    mock.script({
      kind: 'error',
      status: 429,
      type: 'rate_limit_error',
      message: 'You have reached your API usage limits',
      details: { error_code: 'enforced_spend_limit_reached' },
    });
    const run = options();
    const result = await summarize(clusters(), run);
    expect(mock.requests).toHaveLength(1);
    expect(run.sleeps).toStrictEqual([]);
    expect(result.records.map((r) => r.status)).toStrictEqual(['failed', 'skipped', 'skipped', 'skipped']);
  });

  it('backs off exponentially on 5xx and 529, and a later answer is the summary', async () => {
    mock.script(
      { kind: 'error', status: 500, type: 'api_error', message: 'oops' },
      { kind: 'error', status: 529, type: 'overloaded_error', message: 'busy' },
    );
    const [first] = clusters();
    const run = options();
    const result = await summarize([first as Cluster], run);
    expect(run.sleeps).toStrictEqual([1000, 2000]);
    expect(mock.requests).toHaveLength(3);
    expect(result.records[0]?.status).toBe('summarized');
  });

  it('caps the backoff, and gives up after the retries with the last error', async () => {
    mock.fallback = { kind: 'error', status: 503, type: 'api_error', message: 'unavailable' };
    const [first] = clusters();
    const run = options({ retries: 5, backoffMs: 4000, maxBackoffMs: 10_000 });
    const result = await summarize([first as Cluster], run);
    expect(run.sleeps).toStrictEqual([4000, 8000, 10_000, 10_000, 10_000]);
    expect(mock.requests).toHaveLength(6);
    expect(result.records[0]?.note).toMatch(/^HTTP 503 api_error: unavailable.*, after 5 retries$/);
  });

  it('times out a slow answer, retries it, and records the failure with the time it waited', async () => {
    mock.fallback = { kind: 'slow', delayMs: 5000 };
    const [first] = clusters();
    const run = options({ timeoutMs: 60, retries: 1 });
    const result = await summarize([first as Cluster], run);
    expect(mock.requests).toHaveLength(2);
    expect(run.sleeps).toStrictEqual([1000]);
    expect(result.records[0]?.note).toBe('no answer within 60 ms, after 1 retry');
  });

  it('retries a connection that is dropped', async () => {
    mock.script({ kind: 'drop' });
    const [first] = clusters();
    const run = options();
    const result = await summarize([first as Cluster], run);
    expect(mock.requests).toHaveLength(2);
    expect(result.records[0]?.status).toBe('summarized');
  });

  it('records an endpoint that nobody listens on without throwing', async () => {
    const [first] = clusters();
    const run = options({ baseUrl: 'http://127.0.0.1:1', retries: 0 });
    const result = await summarize([first as Cluster], run);
    expect(result.records[0]?.status).toBe('failed');
    expect(result.records[0]?.note).toMatch(/^could not reach http:\/\/127\.0\.0\.1:1/);
  });

  it('does not take a body it cannot read for a summary: a 200 that is not JSON, one with no content list, one with no text', async () => {
    mock.script(
      { kind: 'malformed', body: '{ "content": [' },
      { kind: 'malformed', body: JSON.stringify({ type: 'message', content: 'not a list' }) },
      { kind: 'ok', thinking: true, noText: true },
      { kind: 'ok', stopReason: 'refusal', text: 'I cannot help with that' },
    );
    const result = await summarize(clusters(), options());
    expect(result.records.map((r) => r.status)).toStrictEqual(['failed', 'failed', 'failed', 'failed']);
    expect(result.records.map((r) => r.note)).toStrictEqual([
      'the answer is not JSON (a 200 with a body that cannot be read)',
      'the answer has no content list',
      'the answer has no text: it used its whole token budget before writing text (stop_reason max_tokens)',
      'the model declined to answer (stop_reason refusal)',
    ]);
    expect(mock.requests).toHaveLength(4);
  });

  it('describes an error body that is not the documented shape by its status', async () => {
    mock.script(
      { kind: 'malformed', status: 502, body: '<html>Bad gateway</html>', contentType: 'text/html' },
      { kind: 'ok' },
    );
    const [first] = clusters();
    const result = await summarize([first as Cluster], options());
    expect(result.records[0]?.status).toBe('summarized');
    mock.script({ kind: 'malformed', status: 400, body: '<html>nope</html>', contentType: 'text/html' });
    const failed = await summarize([first as Cluster], options());
    expect(failed.records[0]?.note).toBe('HTTP 400 error: <html>nope</html>');
  });

  it('keeps the part of the answer that is text when the model thought first, and marks a draft that was cut', async () => {
    mock.script({ kind: 'ok', thinking: true, text: 'Likely root cause: x', stopReason: 'max_tokens' });
    const [first] = clusters();
    const result = await summarize([first as Cluster], options());
    expect(result.records[0]).toMatchObject({
      status: 'summarized',
      text: 'Likely root cause: x',
      note: 'the draft was cut at the token limit',
    });
  });

  it('removes control characters from what a model wrote, keeps its line breaks, and cuts it to a paragraph', async () => {
    mock.script({ kind: 'ok', text: `Likely\u0007 root\u001b[31m cause\nsecond line ${'x'.repeat(3000)}` });
    const [first] = clusters();
    const result = await summarize([first as Cluster], options());
    const text = result.records[0]?.text ?? '';
    expect(text.startsWith('Likely root[31m cause\nsecond line x')).toBe(true);
    expect(
      [...text].filter((char) => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\t'),
    ).toStrictEqual([]);
    expect(text.length).toBeLessThanOrEqual(1500);
  });
});

describe('PB-LAB-005 triage summaries: the budget', () => {
  it('summarizes the largest clusters first and only as many as the cap says, recording the rest', async () => {
    const all = clusters();
    const result = await summarize(all, options({ maxClusters: 2 }));
    expect(mock.requests).toHaveLength(2);
    const asked = mock.requests.map(
      (r) => (r.body?.messages as Array<{ content: string }>)[0]?.content.split('\n')[0],
    );
    expect(asked).toStrictEqual([
      `Cluster 1 of 2 (key ${all[0]?.key})`,
      `Cluster 2 of 2 (key ${all[1]?.key})`,
    ]);
    expect(result.records.map((r) => r.status)).toStrictEqual([
      'summarized',
      'summarized',
      'skipped',
      'skipped',
    ]);
    expect(result.records[2]?.note).toBe('not summarized: the run is capped at 2 clusters');
  });

  it('stops asking when the requests of the run are spent, retries included', async () => {
    mock.fallback = { kind: 'error', status: 500, type: 'api_error', message: 'oops' };
    const result = await summarize(clusters(), options({ maxRequests: 3, retries: 5 }));
    expect(mock.requests).toHaveLength(3);
    expect(result.records[0]?.status).toBe('skipped');
    expect(result.records[0]?.note).toMatch(
      /^not summarized: the budget of the run is spent \(3 requests, \d+ characters of 3 and 60000\)$/,
    );
  });

  it('stops asking when the characters of the run are spent', async () => {
    const all = clusters();
    const one = buildPrompt(all[0] as Cluster, 1, all.length, 6000).user.length;
    const result = await summarize(all, options({ maxInputChars: one * 2 }));
    expect(mock.requests.length).toBeLessThan(all.length);
    expect(result.records.at(-1)?.status).toBe('skipped');
    expect(result.records.at(-1)?.note).toMatch(/the budget of the run is spent/);
  });

  it('asks one request at a time by default and two at most, whatever is asked for', async () => {
    mock.fallback = { kind: 'ok', delayMs: 80 };
    await summarize(clusters(), options());
    expect(mock.peakInFlight).toBe(1);
    const two = await startMock();
    two.fallback = { kind: 'ok', delayMs: 80 };
    await summarize(clusters(), options({ baseUrl: two.origin, concurrency: 2 }));
    expect(two.peakInFlight).toBe(2);
    const many = await startMock();
    many.fallback = { kind: 'ok', delayMs: 80 };
    await summarize(clusters(), options({ baseUrl: many.origin, concurrency: 9 }));
    expect(many.peakInFlight).toBe(2);
    await Promise.all([two.close(), many.close()]);
  });

  it('keeps the records in the order of the clusters, whichever answer comes first', async () => {
    // Routed by what the request is about, not by the order they arrive in: two requests in flight have no order the test could rely on.
    mock.route((body) => JSON.stringify(body.messages).includes('Cluster 1 of 2'), {
      kind: 'ok',
      delayMs: 150,
      text: 'first',
    });
    mock.route((body) => JSON.stringify(body.messages).includes('Cluster 2 of 2'), {
      kind: 'ok',
      text: 'second',
    });
    const all = clusters().slice(0, 2);
    const result = await summarize(all, options({ concurrency: 2 }));
    expect(result.records.map((r) => [r.clusterKey, r.text])).toStrictEqual([
      [all[0]?.key, 'first'],
      [all[1]?.key, 'second'],
    ]);
  });
});

describe('PB-LAB-005 triage summaries: the cache, by cluster signature', () => {
  it('makes the second run cost nothing: the drafts come from the cache and no request is sent', async () => {
    const dir = cacheDir();
    const all = clusters();
    const first = await summarize(all, options({ cacheDir: dir }));
    expect(mock.requests).toHaveLength(4);
    expect(first.records.every((r) => r.status === 'summarized')).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(4);

    const second = await summarize(all, options({ cacheDir: dir }));
    expect(mock.requests).toHaveLength(4);
    expect(second.cacheHits).toBe(4);
    expect(second.requests).toBe(0);
    expect(second.records.map((r) => [r.status, r.text])).toStrictEqual(
      first.records.map((r) => ['cached', r.text]),
    );
  });

  it('asks again when told to, when the model changes, and when the file is not a draft of this cluster', async () => {
    const dir = cacheDir();
    const [one] = clusters();
    await summarize([one as Cluster], options({ cacheDir: dir }));
    expect(mock.requests).toHaveLength(1);

    await summarize([one as Cluster], options({ cacheDir: dir, refresh: true }));
    expect(mock.requests).toHaveLength(2);

    await summarize([one as Cluster], options({ cacheDir: dir, model: 'claude-sonnet-5-5' }));
    expect(mock.requests).toHaveLength(3);

    const file = join(dir, `${one?.key}-claude-haiku-5-5-p${PROMPT_VERSION}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      clusterKey: one?.key,
      signature: one?.signature,
      model: 'claude-haiku-5-5',
      promptVersion: PROMPT_VERSION,
    });
    writeFileSync(file, '{ not json');
    await summarize([one as Cluster], options({ cacheDir: dir }));
    expect(mock.requests).toHaveLength(4);
    writeFileSync(
      file,
      JSON.stringify({
        clusterKey: 'another',
        signature: 'x',
        model: 'claude-haiku-5-5',
        promptVersion: PROMPT_VERSION,
        text: 'stale',
      }),
    );
    await summarize([one as Cluster], options({ cacheDir: dir }));
    expect(mock.requests).toHaveLength(5);
  });

  it('keeps nothing of a failure, and nothing at all when it has no cache directory', async () => {
    const dir = cacheDir();
    mock.fallback = { kind: 'error', status: 400, type: 'invalid_request_error', message: 'no' };
    const [one] = clusters();
    await summarize([one as Cluster], options({ cacheDir: dir }));
    expect(() => readdirSync(dir)).toThrow();
    mock.fallback = { kind: 'ok' };
    await summarize([one as Cluster], options({ cacheDir: null }));
    expect(() => readdirSync(dir)).toThrow();
  });

  it('survives a cache directory that cannot be written', async () => {
    const blocked = join(scratch, 'not-a-directory');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(blocked, 'a file where a directory should be');
    const [one] = clusters();
    const result = await summarize([one as Cluster], options({ cacheDir: join(blocked, 'cache') }));
    expect(result.records[0]?.status).toBe('summarized');
  });
});

describe('PB-LAB-005 triage summaries: retry-after', () => {
  it('is a number of seconds, or an HTTP date, or nothing', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(
      parseRetryAfter('Wed, 04 Nov 2026 05:00:30 GMT', Date.parse('Wed, 04 Nov 2026 05:00:00 GMT')),
    ).toBe(30_000);
    expect(
      parseRetryAfter('Wed, 04 Nov 2026 05:00:30 GMT', Date.parse('Wed, 04 Nov 2026 06:00:00 GMT')),
    ).toBe(0);
    for (const nothing of [null, '', '  ', 'soon', '-3']) expect(parseRetryAfter(nothing)).toBeNull();
  });
});
