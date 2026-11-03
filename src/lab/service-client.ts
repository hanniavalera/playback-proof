import type {
  CatalogResponse,
  HealthInfo,
  RequestLogEntry,
  SessionDetail,
  SessionInfo,
  SessionRequest,
} from '../shared/api.ts';
import type { FaultRule, FaultRuleWithId } from '../shared/faults.ts';
import { DEFAULT_PORT } from '../shared/urls.ts';

// Typed client of the test data service control API. Used by the Playwright fixtures, the performance harness, the A/B
// runner, the soak test and the tools. No dependencies: Node's global fetch.

export class ServiceClient {
  readonly origin: string;

  constructor(origin = process.env.PB_ORIGIN ?? `http://127.0.0.1:${process.env.PB_PORT ?? DEFAULT_PORT}`) {
    this.origin = origin.replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.origin + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health(): Promise<HealthInfo> {
    return this.call('GET', '/health');
  }

  async catalog(): Promise<CatalogResponse['streams']> {
    return (await this.call<CatalogResponse>('GET', '/api/streams')).streams;
  }

  createSession(request: SessionRequest): Promise<SessionInfo> {
    return this.call('POST', '/api/sessions', request);
  }

  getSession(id: string): Promise<SessionDetail> {
    return this.call('GET', `/api/sessions/${id}`);
  }

  /** Adds rules to the session. Returns the stored rules (with ids). */
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
}
