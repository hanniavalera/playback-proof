import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_API_VERSIONS, startMock, validateRequest } from '../../../tools/triage-mock.ts';
import type { MockServer } from '../../../tools/triage-mock.ts';

// The mock is the instrument the summarizer's tests rely on, so it is checked against what the documentation says the service accepts and
// answers (docs/TRIAGE.md lists the pages): a mock that accepted anything would prove nothing about the request.

let mock: MockServer;
beforeEach(async () => {
  mock = await startMock({ apiKey: 'key-for-the-tests' });
});
afterEach(async () => {
  await mock.close();
});

const good = {
  model: 'claude-haiku-5-5',
  max_tokens: 2000,
  system: 'You help.',
  messages: [
    {
      role: 'user',
      content: 'Cluster 1 of 1 (key 0123456789ab)\nCategory: environment, decided by the rule x',
    },
  ],
};

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  path = '/v1/messages',
  method = 'POST',
) {
  const response = await fetch(mock.origin + path, {
    method,
    headers: {
      'x-api-key': 'key-for-the-tests',
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
      ...headers,
    },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A body that was scripted to be unreadable: the test reads `text`.
  }
  return { status: response.status, headers: response.headers, text, json };
}

describe('PB-LAB-005 triage mock: it answers as the documentation says the service does', () => {
  it('answers a good request with a message: id, role, the model asked for, a text block, a stop reason and usage', async () => {
    const { status, json, headers } = await post(good);
    expect(status).toBe(200);
    expect(headers.get('request-id')).toMatch(/^req_mock_/);
    expect(json).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) },
    });
    expect(String(json.id)).toMatch(/^msg_mock_\d{6}$/);
    const content = json.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    // It says what it is, in its first words, and reads nothing but what it was sent.
    expect(content[0]?.text).toMatch(/^Likely root cause: \[MOCK\] no model wrote this/);
    expect(content[0]?.text).toContain('cluster 0123456789ab (category environment)');
    expect(mock.requests[0]?.problems).toStrictEqual([]);
  });

  it('answers with a thinking block first when asked to, and with no text when it ran out of tokens', async () => {
    mock.script({ kind: 'ok', thinking: true }, { kind: 'ok', thinking: true, noText: true });
    const first = (await post(good)).json.content as Array<{ type: string }>;
    expect(first.map((block) => block.type)).toStrictEqual(['thinking', 'text']);
    const second = await post(good);
    expect((second.json.content as Array<{ type: string }>).map((block) => block.type)).toStrictEqual([
      'thinking',
    ]);
    expect(second.json.stop_reason).toBe('max_tokens');
  });

  it('answers the errors of the errors page in its shape: type, error.type, error.message and a request id; a 429 has retry-after', async () => {
    mock.script({ kind: 'error', status: 429, type: 'rate_limit_error', message: 'slow', retryAfter: '7' });
    const limited = await post(good);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    expect(limited.json).toStrictEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow' },
      request_id: 'req_mock_000000',
    });
    mock.script({ kind: 'error', status: 529, type: 'overloaded_error', message: 'busy' });
    expect((await post(good)).status).toBe(529);
  });

  it('refuses a missing or wrong key with a 401, and any key when none is configured', async () => {
    expect((await post(good, { 'x-api-key': 'another' })).status).toBe(401);
    const noHeader = await fetch(mock.origin + '/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      body: JSON.stringify(good),
    });
    expect(noHeader.status).toBe(401);
    expect(((await noHeader.json()) as { error: { type: string } }).error.type).toBe('authentication_error');
    const open = await startMock();
    const accepted = await fetch(open.origin + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'whatever',
        'anthropic-version': '2026-10-21',
        'content-type': 'application/json',
      },
      body: JSON.stringify(good),
    });
    expect(accepted.status).toBe(200);
    await open.close();
  });
});

describe('PB-LAB-005 triage mock: it refuses what the documentation says the service refuses', () => {
  const headers = { 'x-api-key': 'k', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' };
  const check = (
    body: unknown,
    overrides: Record<string, string> = {},
    method = 'POST',
    url = '/v1/messages',
  ) => validateRequest(method, url, { ...headers, ...overrides }, body as Record<string, unknown>, undefined);

  it('accepts the request the summarizer sends', () => {
    expect(check(good)).toBeNull();
    expect(check({ ...good, system: [{ type: 'text', text: 'You help.' }] })).toBeNull();
    expect(
      check({ ...good, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    ).toBeNull();
  });

  it('wants the version header, one of the versions of the documentation, and a JSON content type', () => {
    for (const version of KNOWN_API_VERSIONS)
      expect(check(good, { 'anthropic-version': version })).toBeNull();
    expect(check(good, { 'anthropic-version': '' })?.message).toMatch(/header is required/);
    expect(check(good, { 'anthropic-version': '2024-01-01' })?.message).toMatch(
      /is not a version of the API/,
    );
    expect(check(good, { 'content-type': 'text/plain' })?.message).toMatch(/application\/json/);
  });

  it('refuses the sampling parameters that Haiku 5.5 and the version 2026-10-21 removed, and any field the reference does not list', () => {
    for (const field of ['temperature', 'top_p', 'top_k']) {
      expect(check({ ...good, [field]: 0 })).toMatchObject({ status: 400, type: 'invalid_request_error' });
    }
    expect(check({ ...good, budget: 5 })?.message).toBe('budget: Extra inputs are not permitted');
    expect(check({ ...good, stream: true })?.message).toMatch(/does not stream/);
  });

  it('wants a model, a max_tokens that is an integer from 0, and a conversation that ends with the user', () => {
    const { model: _model, ...noModel } = good;
    expect(check(noModel)?.message).toBe('model: Field required');
    for (const bad of [-1, 1.5, '2000', null])
      expect(check({ ...good, max_tokens: bad })?.message).toMatch(/max_tokens/);
    expect(check({ ...good, max_tokens: 0 })).toBeNull();
    expect(check({ ...good, messages: [] })?.message).toMatch(/at least one message/);
    expect(check({ ...good, messages: [{ role: 'system', content: 'x' }] })?.message).toMatch(/role/);
    expect(check({ ...good, messages: [{ role: 'user', content: '' }] })?.message).toMatch(/content/);
    expect(
      check({
        ...good,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'The answer is (' },
        ],
      })?.message,
    ).toMatch(/prefill/);
    expect(check({ ...good, system: 7 })?.message).toMatch(/system/);
  });

  it('answers a path it does not know with a 404, a method it does not allow with a 405, and a body that is not JSON with a 400', async () => {
    expect((await post(good, {}, '/v1/other')).status).toBe(404);
    expect((await post(good, {}, '/v1/messages', 'GET')).status).toBe(405);
    expect((await post('{ not json')).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    expect(mock.requests.at(-1)?.problems[0]).toMatch(/not valid JSON/);
  });

  it('refuses a body above the limit with a 413 and does not keep it', async () => {
    const huge = JSON.stringify({ ...good, system: 'x'.repeat(5 * 1024 * 1024 + 10) });
    const response = await post(huge);
    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({ error: { type: 'request_too_large' } });
  });

  it('refuses a request it would refuse whatever the script says about a good answer, and answers a scripted error to a good one', async () => {
    mock.script({ kind: 'ok' });
    expect((await post({ ...good, temperature: 0 })).status).toBe(400);
    mock.script({ kind: 'error', status: 500, type: 'api_error', message: 'oops' });
    expect((await post(good)).status).toBe(500);
  });
});

describe('PB-LAB-005 triage mock: the behaviours a test scripts', () => {
  it('answers a malformed body as scripted, and routes by what the request is about before the script', async () => {
    mock.script({ kind: 'malformed', body: 'not json at all', status: 200 });
    expect((await post(good)).text).toBe('not json at all');
    mock.route((body) => JSON.stringify(body.messages).includes('0123456789ab'), {
      kind: 'ok',
      text: 'routed',
    });
    mock.script({
      kind: 'error',
      status: 500,
      type: 'api_error',
      message: 'never used while the route matches',
    });
    const routed = await post(good);
    expect((routed.json.content as Array<{ text: string }>)[0]?.text).toBe('routed');
  });

  it('records every request with its headers and its raw body, and counts the most that were answered at once', async () => {
    mock.fallback = { kind: 'ok', delayMs: 60 };
    await Promise.all([post(good), post(good), post(good)]);
    expect(mock.requests).toHaveLength(3);
    expect(mock.peakInFlight).toBe(3);
    expect(mock.requests[0]?.headers['x-api-key']).toBe('key-for-the-tests');
    expect(JSON.parse(mock.requests[0]?.rawBody ?? '')).toStrictEqual(good);
  });

  it('clears the timer of a slow answer when the client gives up, and closes without waiting for it', async () => {
    mock.fallback = { kind: 'slow', delayMs: 30_000 };
    const started = Date.now();
    await expect(
      fetch(mock.origin + '/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': 'key-for-the-tests',
          'anthropic-version': '2026-10-21',
          'content-type': 'application/json',
        },
        body: JSON.stringify(good),
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toThrow();
    await mock.close();
    expect(Date.now() - started).toBeLessThan(5000);
    mock = await startMock();
  });
});
