import type {
  CatalogResponse,
  HealthInfo,
  RequestLogEntry,
  SessionDetail,
  SessionInfo,
  SessionRequest,
} from '../shared/api.ts';
import type { FaultRule, FaultRuleWithId } from '../shared/faults.ts';
import type { StreamId } from '../shared/streams.ts';
import { DEFAULT_PORT } from '../shared/urls.ts';

// Typed client of the test data service control API (docs/CONTRACTS.md section 4). Used by the Playwright fixtures, the performance
// harness, the A/B runner, the soak test and the tools. No dependencies: Node's global fetch.

/** The service refused a call, or could not be reached (`status` 0). `details` are the problems the service listed, if any. */
export class ServiceError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly details: string[];

  constructor(method: string, path: string, status: number, message: string, details: string[] = []) {
    const listed = details.length > 0 ? `: ${details.join('; ')}` : '';
    super(`${method} ${path} -> ${status || 'no answer'} ${message}${listed}`);
    this.name = 'ServiceError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.details = details;
  }
}

export interface ServiceClientOptions {
  /** A call that has not been answered after this long fails with status 0. Default 30 s. */
  requestTimeoutMs?: number;
}

export interface WaitOptions {
  /** Default 30 s for the service, 10 s for the log. */
  timeoutMs?: number;
  /** Time between two polls. Default 100 ms for the service, 25 ms for the log. */
  intervalMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ServiceClient {
  readonly origin: string;
  private readonly requestTimeoutMs: number;

  constructor(
    origin = process.env.PB_ORIGIN ?? `http://127.0.0.1:${process.env.PB_PORT ?? DEFAULT_PORT}`,
    options: ServiceClientOptions = {},
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(this.origin + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ServiceError(method, path, 0, cause?.code ?? cause?.message ?? (err as Error).message);
    }
    if (!res.ok) {
      let message = text.slice(0, 300);
      let details: string[] = [];
      try {
        const parsed = JSON.parse(text) as { error?: unknown; details?: unknown };
        if (typeof parsed.error === 'string') message = parsed.error;
        if (Array.isArray(parsed.details)) details = parsed.details.map(String);
      } catch {
        // not a JSON error: the text is the message
      }
      throw new ServiceError(method, path, res.status, message, details);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health(): Promise<HealthInfo> {
    return this.call('GET', '/health');
  }

  /** The streams that are ready, with their catalog data (durations, representations, content hash, DRM test key). */
  async streams(): Promise<CatalogResponse['streams']> {
    return (await this.call<CatalogResponse>('GET', '/api/streams')).streams;
  }

  /** @deprecated the old name of `streams()`. */
  catalog(): Promise<CatalogResponse['streams']> {
    return this.streams();
  }

  createSession(request: SessionRequest): Promise<SessionInfo> {
    return this.call('POST', '/api/sessions', request);
  }

  /** The session with its rules and counters. A ServiceError with status 404 when it does not exist or has expired. */
  detail(id: string): Promise<SessionDetail> {
    return this.call('GET', `/api/sessions/${id}`);
  }

  /** @deprecated the old name of `detail()`. */
  getSession(id: string): Promise<SessionDetail> {
    return this.detail(id);
  }

  /** Adds rules to the session and returns the stored rules (with ids). Invalid rules: a ServiceError 400 listing the problems. */
  addFaults(id: string, rules: FaultRule[]): Promise<FaultRuleWithId[]> {
    return this.call('POST', `/api/sessions/${id}/faults`, { rules });
  }

  /** Replaces every rule of the session. */
  setFaults(id: string, rules: FaultRule[]): Promise<FaultRuleWithId[]> {
    return this.call('PUT', `/api/sessions/${id}/faults`, { rules });
  }

  removeFault(id: string, ruleId: string): Promise<void> {
    return this.call('DELETE', `/api/sessions/${id}/faults/${ruleId}`);
  }

  /** The requests of the session with `seq` greater than `since` (default: all), in arrival order, the ones in flight included. */
  log(id: string, since = 0): Promise<RequestLogEntry[]> {
    return this.call('GET', `/api/sessions/${id}/log?since=${since}`);
  }

  deleteSession(id: string): Promise<void> {
    return this.call('DELETE', `/api/sessions/${id}`);
  }

  /** Absolute URL for a service path. */
  url(path: string): string {
    return this.origin + path;
  }

  /**
   * Resolves with the health of the service once it answers `ok` (and, if `ready` is given, once those streams are ready); rejects
   * with the last problem when it does not within `timeoutMs`. For a harness that has just started the service.
   */
  async waitUntilHealthy(options: WaitOptions & { ready?: readonly StreamId[] } = {}): Promise<HealthInfo> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 100;
    const deadline = performance.now() + timeoutMs;
    let last: string;
    for (;;) {
      try {
        const health = await this.call<HealthInfo>('GET', '/health', undefined, Math.min(2000, timeoutMs));
        const missing = (options.ready ?? []).filter((id) => health.streams[id] !== 'ready');
        if (health.status === 'ok' && missing.length === 0) return health;
        last = missing.length > 0 ? `streams not ready: ${missing.join(', ')}` : `status ${health.status}`;
      } catch (err) {
        last = (err as Error).message;
      }
      if (performance.now() + intervalMs > deadline)
        throw new Error(`the service at ${this.origin} was not healthy within ${timeoutMs} ms (${last})`);
      await sleep(intervalMs);
    }
  }

  /**
   * Polls the request log of a session until `predicate` holds for the entries after `since`, and returns them. This is how a test
   * waits on the server ("a request for segment 7 has started") without a fixed sleep. Entries in flight are included.
   */
  async waitForLog(
    id: string,
    predicate: (entries: RequestLogEntry[]) => boolean,
    options: WaitOptions & { since?: number } = {},
  ): Promise<RequestLogEntry[]> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 25;
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const entries = await this.log(id, options.since ?? 0);
      if (predicate(entries)) return entries;
      if (performance.now() + intervalMs > deadline) {
        const seen = entries.map((e) => `#${e.seq} ${e.kind} ${e.status}${e.pending ? ' pending' : ''}`);
        throw new Error(
          `the request log of session ${id} did not reach the expected state within ${timeoutMs} ms: [${seen.join(', ')}]`,
        );
      }
      await sleep(intervalMs);
    }
  }
}
