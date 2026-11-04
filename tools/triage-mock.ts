import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';

// A local mock of the Anthropic Messages API (`POST /v1/messages`), for the tests of the triage summarizer and for trying `npm run triage --
// --summarize` without a key. It speaks the SHAPES of the real service as the official documentation describes them (2026-11-04: the Create a
// Message reference, the errors page, the rate limits page, the Haiku 5.5 migration guide): the request headers and body, the
// `{ type: "message", content: [{ type: "text" }], stop_reason, usage }` answer, the `{ type: "error", error: { type, message }, request_id }`
// errors, `retry-after` on a 429, a `thinking` block before the text. The WORDS of its error messages are its own.
//
// WHAT IT PROVES AND WHAT IT CANNOT: that the summarizer sends what the documentation says to send, reads what the documentation says it
// gets back, and behaves when the service says no. It cannot prove that the live service accepts the request today, what a real model writes,
// or what a real rate limit feels like. No model is behind this file, and its answer says so in the first words.

/** The versions of the API the documentation lists. */
export const KNOWN_API_VERSIONS = ['2023-01-01', '2023-06-01', '2026-10-21'] as const;

/** The top-level fields of a Messages request that the reference lists. `temperature`, `top_p` and `top_k` are removed from 2026-10-21. */
const ALLOWED_FIELDS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'metadata',
  'output_config',
  'thinking',
  'stop_sequences',
  'stream',
  'service_tier',
  'speed',
  'tools',
  'tool_choice',
  'container',
  'cache_control',
  'diagnostics',
  'inference_geo',
]);
const REMOVED_FIELDS = new Set(['temperature', 'top_p', 'top_k']);
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type Behaviour =
  | {
      kind: 'ok';
      /** The text of the answer. Default: a labelled mock text built from the evidence it received. */
      text?: string;
      stopReason?: string;
      /** Put a `thinking` block before the text, as a model that thinks does. */
      thinking?: boolean;
      /** Answer with no text block at all (a model that ran out of tokens while thinking). */
      noText?: boolean;
      delayMs?: number;
    }
  | {
      kind: 'error';
      status: number;
      type: string;
      message: string;
      /** The value of the `retry-after` header, in seconds or an HTTP date. */
      retryAfter?: string;
      details?: Record<string, unknown>;
    }
  | { kind: 'slow'; delayMs: number }
  | { kind: 'malformed'; body: string; status?: number; contentType?: string }
  | { kind: 'drop' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  /** The body as JSON, or null when it was not. */
  body: Record<string, unknown> | null;
  /** What the mock found wrong with the request, as the real service would have said; empty for a request the documentation accepts. */
  problems: string[];
}

export interface MockServer {
  /** `http://127.0.0.1:<port>`: what `ANTHROPIC_BASE_URL` is set to. */
  origin: string;
  port: number;
  requests: RecordedRequest[];
  /** The most requests that were being answered at once: what a test of the concurrency limit reads. */
  readonly peakInFlight: number;
  /** What the next requests get, in order; after the script runs out, `fallback`. */
  script(...behaviours: Behaviour[]): void;
  /** What every request whose body satisfies `match` gets, whatever the script says: for a test whose requests have no order to rely on. */
  route(match: (body: Record<string, unknown>) => boolean, behaviour: Behaviour): void;
  /** What a request gets when nothing is scripted. Default: ok. */
  fallback: Behaviour;
  close(): Promise<void>;
}

export interface MockOptions {
  /** The key the mock accepts. Without it any non-empty `x-api-key` is accepted. */
  apiKey?: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
}

function readBody(request: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on('end', () => resolveBody({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }));
    request.on('error', reject);
  });
}

const headerOf = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Rejection {
  status: number;
  type: string;
  message: string;
}

/** What the real service would refuse, in the order it would: credentials, then the version, then the body. */
export function validateRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown> | null,
  apiKey: string | undefined,
): Rejection | null {
  if (url.split('?')[0] !== '/v1/messages')
    return { status: 404, type: 'not_found_error', message: 'The requested resource could not be found.' };
  if (method !== 'POST')
    return {
      status: 405,
      type: 'invalid_request_error',
      message: `Method ${method} is not allowed on /v1/messages.`,
    };
  const key = headers['x-api-key'];
  if (!key || (apiKey !== undefined && key !== apiKey))
    return { status: 401, type: 'authentication_error', message: 'invalid x-api-key' };
  const version = headers['anthropic-version'];
  if (!version)
    return { status: 400, type: 'invalid_request_error', message: 'anthropic-version: header is required' };
  if (!(KNOWN_API_VERSIONS as readonly string[]).includes(version)) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: `anthropic-version: ${version} is not a version of the API`,
    };
  }
  if (!(headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
    return { status: 400, type: 'invalid_request_error', message: 'Content-Type must be application/json' };
  }
  if (body === null)
    return { status: 400, type: 'invalid_request_error', message: 'The request body is not valid JSON.' };
  for (const field of Object.keys(body)) {
    if (REMOVED_FIELDS.has(field)) {
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `${field}: this parameter is removed and may not be sent`,
      };
    }
    if (!ALLOWED_FIELDS.has(field))
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `${field}: Extra inputs are not permitted`,
      };
  }
  if (typeof body.model !== 'string' || body.model === '')
    return { status: 400, type: 'invalid_request_error', message: 'model: Field required' };
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < 0) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: 'max_tokens: must be an integer of at least 0',
    };
  }
  if (body.stream === true)
    return { status: 400, type: 'invalid_request_error', message: 'stream: this mock does not stream' };
  const system = body.system;
  if (system !== undefined && typeof system !== 'string' && !Array.isArray(system)) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: 'system: must be a string or an array of text blocks',
    };
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: 'messages: at least one message is required',
    };
  }
  for (const [index, message] of messages.entries()) {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `messages.${index}.role: must be "user" or "assistant"`,
      };
    }
    const content = message.content;
    const text = typeof content === 'string' ? content : null;
    if (text === '' || (text === null && !Array.isArray(content))) {
      return {
        status: 400,
        type: 'invalid_request_error',
        message: `messages.${index}.content: must be a non-empty string or a list of blocks`,
      };
    }
  }
  if ((messages[messages.length - 1] as Record<string, unknown>).role !== 'user') {
    return {
      status: 400,
      type: 'invalid_request_error',
      message:
        'This model does not support assistant message prefill. The conversation must end with a user message.',
    };
  }
  return null;
}

/** The mock's own answer: clearly not a model's, and built from nothing but what it received. */
function mockText(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ content: unknown }>;
  const last = messages[messages.length - 1]?.content;
  const content = typeof last === 'string' ? last : JSON.stringify(last);
  const key = /\(key ([0-9a-f]{12})\)/.exec(content)?.[1] ?? 'unknown';
  const category = /Category: ([a-z-]+)/.exec(content)?.[1] ?? 'unknown';
  return [
    `Likely root cause: [MOCK] no model wrote this: tools/triage-mock.ts answered, having read ${content.length} characters of evidence for cluster ${key} (category ${category}).`,
    'First thing to check: [MOCK] run the same command with ANTHROPIC_API_KEY set and no ANTHROPIC_BASE_URL to get a real draft.',
    'Not sure about: [MOCK] everything: this is a test double of the Messages API.',
  ].join('\n');
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'request-id': `req_mock_${Date.now().toString(36)}`,
    ...headers,
  });
  response.end(body);
}

function errorBody(rejection: Rejection, details?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'error',
    error: { type: rejection.type, message: rejection.message, ...(details ? { details } : {}) },
    request_id: 'req_mock_000000',
  });
}

function okBody(
  body: Record<string, unknown>,
  behaviour: Extract<Behaviour, { kind: 'ok' }>,
  counter: number,
): string {
  const text = behaviour.text ?? mockText(body);
  const content: Array<Record<string, unknown>> = [];
  // A model that thinks (Haiku 5.5 does by default) starts with a thinking block whose text is empty and which carries a signature.
  if (behaviour.thinking) content.push({ type: 'thinking', thinking: '', signature: 'mock-signature' });
  if (!behaviour.noText) content.push({ type: 'text', text });
  const input = Math.ceil(JSON.stringify(body.messages).length / 4);
  return JSON.stringify({
    id: `msg_mock_${String(counter).padStart(6, '0')}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: behaviour.stopReason ?? (behaviour.noText ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: input, output_tokens: Math.ceil(text.length / 4) },
  });
}

export async function startMock(options: MockOptions = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const queue: Behaviour[] = [];
  const routes: Array<{ match: (body: Record<string, unknown>) => boolean; behaviour: Behaviour }> = [];
  let counter = 0;
  const flight = { now: 0, peak: 0 };
  const sockets = new Set<Socket>();
  const state = { fallback: { kind: 'ok' } as Behaviour };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    flight.now += 1;
    flight.peak = Math.max(flight.peak, flight.now);
    response.on('close', () => {
      flight.now -= 1;
    });
    const read = await readBody(request);
    const headers: Record<string, string> = {};
    for (const name of Object.keys(request.headers)) headers[name] = headerOf(request.headers, name) ?? '';
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(read.text);
      body = isObject(parsed) ? parsed : null;
    } catch {
      body = null;
    }
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    const rejection = read.tooLarge
      ? {
          status: 413,
          type: 'request_too_large',
          message: 'Request exceeds the maximum allowed number of bytes.',
        }
      : validateRequest(method, url, headers, body, options.apiKey);
    requests.push({
      method,
      url,
      headers,
      rawBody: read.text,
      body,
      problems: rejection ? [rejection.message] : [],
    });
    counter += 1;

    const routed = body
      ? routes.find((route) => route.match(body as Record<string, unknown>))?.behaviour
      : undefined;
    const behaviour = routed ?? queue.shift() ?? state.fallback;
    if (behaviour.kind === 'drop') {
      request.socket.destroy();
      return;
    }
    if (behaviour.kind === 'error') {
      send(
        response,
        behaviour.status,
        errorBody(behaviour, behaviour.details),
        behaviour.retryAfter === undefined ? {} : { 'retry-after': behaviour.retryAfter },
      );
      return;
    }
    if (behaviour.kind === 'malformed') {
      send(response, behaviour.status ?? 200, behaviour.body, {
        'content-type': behaviour.contentType ?? 'application/json',
      });
      return;
    }
    // A request the service would refuse is refused whatever the script says about a good answer.
    if (rejection) {
      send(response, rejection.status, errorBody(rejection));
      return;
    }
    const delayMs = behaviour.kind === 'slow' ? behaviour.delayMs : (behaviour.delayMs ?? 0);
    const answer = (): void => {
      const ok = behaviour.kind === 'ok' ? behaviour : ({ kind: 'ok' } as const);
      send(response, 200, okBody(body as Record<string, unknown>, ok, counter));
    };
    if (delayMs <= 0) {
      answer();
      return;
    }
    // The timer is cleared when the client hangs up, so that a test that gave up on a slow answer leaves nothing behind.
    const timer = setTimeout(answer, delayMs);
    response.on('close', () => clearTimeout(timer));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => request.socket.destroy());
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    requests,
    get peakInFlight() {
      return flight.peak;
    },
    script: (...behaviours) => void queue.push(...behaviours),
    route: (match, behaviour) => void routes.push({ match, behaviour }),
    get fallback() {
      return state.fallback;
    },
    set fallback(value: Behaviour) {
      state.fallback = value;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line: `npx tsx tools/triage-mock.ts --port 4751 [--key <key>] [--scenario ok|rate-limit|server-error|unauthorized|slow|malformed|drop]`

const SCENARIOS: Record<string, Behaviour> = {
  ok: { kind: 'ok', thinking: true },
  'rate-limit': {
    kind: 'error',
    status: 429,
    type: 'rate_limit_error',
    message: 'This is a mock rate limit.',
    retryAfter: '1',
  },
  'server-error': {
    kind: 'error',
    status: 500,
    type: 'api_error',
    message: 'This is a mock internal error.',
  },
  overloaded: { kind: 'error', status: 529, type: 'overloaded_error', message: 'This is a mock overload.' },
  unauthorized: { kind: 'error', status: 401, type: 'authentication_error', message: 'invalid x-api-key' },
  slow: { kind: 'slow', delayMs: 60_000 },
  malformed: { kind: 'malformed', body: '{ "content": [' },
  drop: { kind: 'drop' },
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  if (args.includes('--help')) {
    console.log(
      'usage: npx tsx tools/triage-mock.ts [--port 4751] [--host 127.0.0.1] [--key <the key to accept>] [--scenario ' +
        `${Object.keys(SCENARIOS).join('|')}]\nA mock of POST /v1/messages for npm run triage -- --summarize (ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=any).\nNo model is behind it.`,
    );
    return;
  }
  const scenario = SCENARIOS[value('--scenario') ?? 'ok'];
  if (!scenario) {
    console.error(`unknown scenario ${String(value('--scenario'))}: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  const port = Number(value('--port') ?? 4751);
  const key = value('--key');
  const mock = await startMock({
    port,
    ...(key ? { apiKey: key } : {}),
    ...(value('--host') ? { host: value('--host') as string } : {}),
  });
  mock.fallback = scenario;
  console.log(
    `triage mock listening on ${mock.origin}: a test double of POST /v1/messages, no model is behind it (scenario ${value('--scenario') ?? 'ok'})`,
  );
  const stop = (): void => void mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) void main();
