import type { BrowserContext, Page } from '@playwright/test';
import type { RequestLogEntry, SessionInfo, SessionRequest } from '../../../src/shared/api.ts';
import type { LaunchedBrowser, RunPage } from '../../../src/lab/measure/browser.ts';
import type { WorldService } from '../../../src/lab/readiness/playwright-world.ts';
import type { Engine } from '../../../src/lab/readiness/soak-evaluators.ts';
import type { ReadinessRun } from '../../../src/lab/readiness/world.ts';
import { AST_EPOCH, fakeWorld } from './fake-world.ts';
import type { FakeModel, Observed, Script } from './fake-world.ts';

// The part of Playwright that the command line's code uses (page.ts, playwright-world.ts, soak-driver.ts, heap.ts, the in-page sampler,
// and the performance harness's QaPage under them), made of the least that lets every line of that code run without a browser, with
// the player of fake-world.ts behind a `window.__qa` that has the synchronous members the real hook has.
//
// What makes it a test of the integration and not of the fake: the code of a page function is evaluated from its SOURCE TEXT, in a
// scope that has the page's globals and nothing of the harness's (the Node globals are hidden), as Playwright does by sending the text
// to the browser. A page function that closes over a variable of the harness, that uses `require`, or that the transformer left a
// helper in (tsx keeps function names with `__name`) fails here as it fails in the browser. Arguments and results cross by structured
// clone, so what cannot cross the boundary (a function, a class instance with methods) does not cross it here either. The CDP session
// refuses a method the protocol does not have and answers `Performance.getMetrics` with nothing before `Performance.enable`.

type Handler = (...args: unknown[]) => void;

/** The virtual clock's timers: the intervals of the page, run in order as the clock is moved. */
export class FakeTimers {
  private next = 1;
  private readonly active = new Map<number, { every: number; at: number; run: () => void }>();

  constructor(private readonly clock: { now: number }) {}

  setInterval(run: () => void, every: number): number {
    const id = this.next++;
    this.active.set(id, { every, at: this.clock.now + every, run });
    return id;
  }

  clearInterval(id: number): void {
    this.active.delete(id);
  }

  get running(): number {
    return this.active.size;
  }

  /** Moves the clock to `target`, running every interval that falls due on the way, each at its own time. */
  advanceTo(target: number): void {
    for (;;) {
      let due: { at: number; every: number; run: () => void } | undefined;
      for (const timer of this.active.values())
        if (timer.at <= target && (!due || timer.at < due.at)) due = timer;
      if (!due) break;
      this.clock.now = Math.max(this.clock.now, due.at);
      due.at += due.every;
      due.run();
    }
    this.clock.now = Math.max(this.clock.now, target);
  }
}

export interface FakeEnv {
  engine: Engine;
  clock: { now: number };
  timers: FakeTimers;
  service: FakeService;
  /** The heap the CDP session reports, MB retained after a collection and MB of garbage per second since the last one. */
  heap: { retainedMb: (clockNow: number) => number; garbageMbPerSec: number };
  pages: FakePage[];
  contexts: FakeContext[];
  cdp: FakeCdpSession[];
}

const PAGE_GLOBALS_HIDDEN = ['process', 'require', 'module', 'Buffer', 'global', '__dirname', '__filename'];

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name === 'Error' ? 'Error' : error.name}: ${error.message}`
    : String(error);
}

function cross<T>(value: T, what: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(`page.evaluate: ${what} cannot cross the page boundary: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export class FakePage {
  readonly gotoUrls: string[] = [];
  /** What was sent to the page: the source text of every function and expression, in order. */
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Handler[]>();
  private closed = false;
  private crashed = false;
  private readonly window: Record<string, unknown>;

  constructor(
    private readonly env: FakeEnv,
    private readonly owner: FakeContext,
  ) {
    const clock = env.clock;
    this.window = {
      location: { href: 'about:blank' },
      navigator: { userAgent: 'FakeBrowser/1' },
      performance: { timeOrigin: AST_EPOCH, now: () => clock.now - AST_EPOCH },
      setInterval: (run: () => void, every: number) => env.timers.setInterval(run, every),
      clearInterval: (id: number) => env.timers.clearInterval(id),
    };
    this.window.window = this.window;
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  /** For the tests: what the page's events would deliver. */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  console(type: string, text: string): void {
    this.emit('console', { type: () => type, text: () => text });
  }

  pageError(message: string): void {
    this.emit('pageerror', new Error(message));
  }

  crash(): void {
    this.crashed = true;
    this.emit('crash');
  }

  isClosed(): boolean {
    return this.closed;
  }

  context(): FakeContext {
    return this.owner;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private guard(what: string): void {
    if (this.crashed) throw new Error(`${what}: Page crashed`);
    if (this.closed) throw new Error(`${what}: Target page, context or browser has been closed`);
  }

  async goto(url: string): Promise<null> {
    this.guard('page.goto');
    this.gotoUrls.push(url);
    this.env.service.calls.push('goto');
    const manifest = new URL(url, 'http://127.0.0.1').searchParams.get('manifest') ?? '';
    const id = /^\/s\/([^/]+)\//.exec(manifest)?.[1];
    const model = id === undefined ? undefined : this.env.service.model(id);
    if (!model) throw new Error(`page.goto: the fake service has no session for the manifest "${manifest}"`);
    try {
      model.open();
    } catch (error) {
      throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`, { cause: error });
    }
    (this.window.location as { href: string }).href = url;
    this.window.__qa = hookOf(model, (what) => this.env.service.calls.push(what));
    return null;
  }

  /**
   * Runs a function or an expression the way the page would: from its text, in a scope that has the page's globals and hides the harness's.
   * A string is evaluated as a script and its completion value returned (Playwright's `Runtime.evaluate`); a function is called with its
   * one argument. Whatever it returns is awaited.
   */
  private async run(
    pageFunction: string | ((arg: never) => unknown),
    arg: unknown,
    what: string,
  ): Promise<unknown> {
    this.guard(what);
    const source = typeof pageFunction === 'function' ? pageFunction.toString() : pageFunction;
    this.sent.push(source);
    const scope: Record<string, unknown> = { ...this.window };
    for (const name of PAGE_GLOBALS_HIDDEN) scope[name] = undefined;
    const runner = new Function(
      '__scope',
      '__arg',
      '__source',
      typeof pageFunction === 'function'
        ? 'with (__scope) { return (eval("(" + __source + ")"))(__arg); }'
        : 'with (__scope) { return eval(__source); }',
    ) as (scope: Record<string, unknown>, arg: unknown, source: string) => unknown;
    try {
      return cross(await runner(scope, cross(arg, 'the argument'), source), 'the result');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${what}: `)) throw error;
      throw new Error(`${what}: ${describeError(error)}\n    at <anonymous>:1:1`, { cause: error });
    }
  }

  async evaluate<R, A = undefined>(pageFunction: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return (await this.run(pageFunction as string | ((arg: never) => unknown), arg, 'page.evaluate')) as R;
  }

  async waitForFunction(
    pageFunction: string | ((arg: never) => unknown),
    arg?: unknown,
    options: { timeout?: number } = {},
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.run(pageFunction, arg, 'page.waitForFunction')) return;
    }
    const error = new Error(`page.waitForFunction: Timeout ${options.timeout ?? 30_000}ms exceeded.`);
    error.name = 'TimeoutError';
    throw error;
  }
}

/** The part of the hook the readiness code reads, with the synchronous members of the real one. */
function hookOf(model: FakeModel, record: (what: string) => void): Record<string, unknown> {
  return {
    version: 1,
    ready: Promise.resolve(),
    cursor: () => model.cursor(),
    events: () => model.events(),
    metrics: () => model.metrics(),
    info: () => model.info(),
    configure: (patch: Record<string, unknown>) => {
      record('qa.configure');
      model.configure(patch);
    },
    waitFor: async (
      name: Parameters<FakeModel['waitFor']>[0],
      options?: { since?: number; timeoutMs?: number },
    ) => model.waitFor(name, options),
    waitForMediaTime: async (seconds: number, options?: { timeoutMs?: number }) =>
      model.waitForMediaTime(seconds, options),
  };
}

/** A DevTools session as Chromium answers it: the domains the heap probe uses, and an error for a method the protocol does not have. */
export class FakeCdpSession {
  /** Every call, in order, as `Domain.method`. */
  readonly calls: string[] = [];
  detached = false;
  private performanceEnabled = false;
  private lastCollectAt: number;
  private readonly startedAt: number;
  private metricsReads = 0;

  constructor(private readonly env: FakeEnv) {
    this.startedAt = env.clock.now;
    this.lastCollectAt = env.clock.now;
  }

  async send(method: string, _params?: Record<string, unknown>): Promise<unknown> {
    if (this.detached) throw new Error(`${method}: Session closed. Most likely the page has been closed.`);
    this.calls.push(method);
    const { clock, heap } = this.env;
    switch (method) {
      case 'Performance.enable':
        this.performanceEnabled = true;
        return {};
      case 'HeapProfiler.collectGarbage':
        this.lastCollectAt = clock.now;
        return {};
      case 'Performance.getMetrics': {
        // Chromium answers an empty list when the domain was not enabled; with it, the heap in use includes the garbage since the last collection.
        if (!this.performanceEnabled) return { metrics: [] };
        this.metricsReads += 1;
        const retainedMb = heap.retainedMb(clock.now - this.startedAt);
        const garbageMb = ((clock.now - this.lastCollectAt) / 1000) * heap.garbageMbPerSec;
        return {
          metrics: [
            { name: 'JSHeapUsedSize', value: (retainedMb + garbageMb) * 1_048_576 },
            { name: 'Nodes', value: 800 + this.metricsReads },
            { name: 'JSEventListeners', value: 120 },
            { name: 'Timestamp', value: clock.now / 1000 },
          ],
        };
      }
      default:
        throw new Error(`${method}: '${method}' wasn't found`);
    }
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

export class FakeContext {
  closed = false;
  readonly pages: FakePage[] = [];
  readonly cdpSessions: FakeCdpSession[] = [];

  constructor(private readonly env: FakeEnv) {}

  async newPage(): Promise<Page> {
    const page = new FakePage(this.env, this);
    this.pages.push(page);
    this.env.pages.push(page);
    return page as unknown as Page;
  }

  async newCDPSession(_page: unknown): Promise<FakeCdpSession> {
    if (this.env.engine !== 'chromium')
      throw new Error(
        'browserContext.newCDPSession: CDP sessions are only supported on Chromium-based browsers',
      );
    const session = new FakeCdpSession(this.env);
    this.cdpSessions.push(session);
    this.env.cdp.push(session);
    return session;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages) await page.close();
  }
}

/** The service client of the unit tests: the sessions of the fake world, answered through the interface the command line's world uses. */
export class FakeService implements WorldService {
  readonly origin = 'http://127.0.0.1:4740';
  /** Every call, in order, as `method` or `method id`. */
  readonly calls: string[] = [];
  readonly deleted: string[] = [];
  private readonly sessions = new Map<string, { run: ReadinessRun; model: FakeModel }>();

  constructor(private readonly built: { world: ReturnType<typeof fakeWorld>['world']; observed: Observed }) {}

  model(id: string): FakeModel | undefined {
    return this.sessions.get(id)?.model;
  }

  private session(id: string): { run: ReadinessRun; model: FakeModel } {
    const found = this.sessions.get(id);
    if (!found) throw new Error(`the fake service has no session ${id}`);
    return found;
  }

  async createSession(request: SessionRequest): Promise<SessionInfo> {
    this.calls.push('createSession');
    const run = await this.built.world.newRun({
      label: request.label ?? '',
      ...(request.live === undefined ? {} : { live: request.live }),
      ...(request.faults === undefined ? {} : { faults: request.faults }),
      ...(request.ttlSec === undefined ? {} : { ttlSec: request.ttlSec }),
    });
    const model = this.built.observed.runs.at(-1)?.model as FakeModel;
    const { service: _service, ...info } = run.session;
    const session: SessionInfo = { ...info, manifestUrl: `/s/${info.id}/live-cmaf/dash/manifest.mpd` };
    this.sessions.set(session.id, { run, model });
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    this.calls.push(`deleteSession ${id}`);
    this.deleted.push(id);
    await this.session(id).run.close();
  }

  detail(id: string): ReturnType<WorldService['detail']> {
    this.calls.push(`detail ${id}`);
    return this.session(id).run.session.service.detail(id);
  }

  addFaults(
    id: string,
    rules: Parameters<WorldService['addFaults']>[1],
  ): ReturnType<WorldService['addFaults']> {
    this.calls.push(`addFaults ${id}`);
    return this.session(id).run.session.service.addFaults(id, rules);
  }

  async log(id: string, since?: number): Promise<RequestLogEntry[]> {
    this.calls.push(`log ${id}`);
    // As the service answers `?since=N`: the requests that arrived after the one numbered N.
    return (await this.session(id).run.session.service.log(id, since)).filter(
      (entry) => entry.seq > (since ?? 0),
    );
  }

  waitForLog(
    id: string,
    predicate: Parameters<WorldService['waitForLog']>[1],
    options?: Parameters<WorldService['waitForLog']>[2],
  ): ReturnType<WorldService['waitForLog']> {
    this.calls.push(`waitForLog ${id}`);
    return this.session(id).run.session.service.waitForLog(id, predicate, options);
  }

  streams(): ReturnType<WorldService['streams']> {
    this.calls.push('streams');
    const first = [...this.sessions.values()][0];
    if (first) return first.run.session.service.streams();
    return Promise.resolve([
      { id: 'live-cmaf', reps: [{ id: 'a-aac', track: 'audio' }] } as unknown as Awaited<
        ReturnType<WorldService['streams']>
      >[number],
    ]);
  }
}

export interface FakePlaywrightOptions {
  engine?: Engine;
  /** Heap retained after a collection, MB, given the ms since the DevTools session began. Default: 12 MB, flat. */
  retainedMb?: (sinceMs: number) => number;
  /** Garbage the page makes, MB per second: what a reading without a collection would add. Default 0.2. */
  garbageMbPerSec?: number;
}

export interface FakePlaywright {
  service: FakeService;
  browser: LaunchedBrowser;
  clock: { now: number };
  timers: FakeTimers;
  observed: Observed;
  env: FakeEnv;
  /** The harness's clock and sleep on the virtual clock, which also runs the page's timers. */
  harness: { now(): number; sleep(ms: number): Promise<void> };
}

export function fakePlaywright(script: Script = {}, options: FakePlaywrightOptions = {}): FakePlaywright {
  const built = fakeWorld(script);
  const { clock } = built;
  const timers = new FakeTimers(clock);
  const service = new FakeService(built);
  const retainedMb = options.retainedMb ?? ((): number => 12);
  const env: FakeEnv = {
    engine: options.engine ?? 'chromium',
    clock,
    timers,
    service,
    heap: { retainedMb, garbageMbPerSec: options.garbageMbPerSec ?? 0.2 },
    pages: [],
    contexts: [],
    cdp: [],
  };
  const browser: LaunchedBrowser = {
    profile: env.engine,
    engine: env.engine,
    version: '156.0.7000.1',
    cpuThrottleRate: null,
    async newRun(): Promise<RunPage> {
      const context = new FakeContext(env);
      env.contexts.push(context);
      const page = await context.newPage();
      return { page, context: context as unknown as BrowserContext, close: () => context.close() };
    },
    async userAgent() {
      return 'FakeBrowser/1';
    },
    async close() {
      for (const context of env.contexts) await context.close();
    },
  };
  return {
    service,
    browser,
    clock,
    timers,
    observed: built.observed,
    env,
    harness: {
      now: () => clock.now,
      sleep: async (ms) => {
        timers.advanceTo(clock.now + ms);
      },
    },
  };
}
