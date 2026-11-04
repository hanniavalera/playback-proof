import type { ConsoleMessage, Page } from '@playwright/test';
import type { SessionInfo } from '../../../src/shared/api.ts';
import type {
  FrameMeasurement,
  PlayerPageParams,
  QAEvent,
  QAEventName,
  QAInfo,
  QAMetrics,
  QAWaitOptions,
} from '../../../src/shared/qa.ts';
import { playerUrl } from '../../../src/shared/urls.ts';
import { atCaller } from './stack.ts';

// `PlayerHandle`: the one way a spec talks to the player page. It is a typed wrapper over `window.__qa` (src/shared/qa.ts), so a
// spec never writes `page.evaluate`, never sees the page boundary, and cannot wait on a timer: every wait is an event of the
// hook's timeline, with a cursor (docs/CONTRACTS.md section 6) and an explicit timeout. A predicate function cannot cross the
// boundary (and the page's CSP forbids `eval`), which is why `detail` exists: a declarative filter the hook already understands.

/**
 * Timeout of every wait that is not given one. Explicit, so that no wait is unbounded, and well below the 45 s of a test so that
 * a stuck wait fails as itself (with the event timeline in the message) and not as "Test timeout".
 */
export const DEFAULT_WAIT_MS = 15_000;

/** Keys of the event's `detail` that must be strictly equal: `{ reason: 'abr', height: 720 }`. Strings, numbers, booleans, null. */
export type DetailFilter = NonNullable<QAWaitOptions['detail']>;

export interface WaitOptions {
  /** Consider only events with `index >= since`. Default 0: the whole history, so an event that already happened still resolves the wait. Take `await player.cursor()` before an action to wait for NEW events only. */
  since?: number;
  /** Default `DEFAULT_WAIT_MS`. */
  timeoutMs?: number;
  detail?: DetailFilter;
}

/** What the browser itself complained about (a blocked script, a refused request, an uncaught error): `page-console.json`. */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'pageerror';
  text: string;
  location?: string;
}

const MAX_CONSOLE_ENTRIES = 200;

/**
 * The frames of the PAGE's stack that Playwright appends to the message of what the page threw: V8's are indented ("    at fn (url)"),
 * Firefox's are not ("fn@url:line:col", also "@debugger eval code:1:44"). The timeline lines the hook prints start with two spaces.
 */
const PAGE_FRAME = /^\s+at |^(?:\S[^\n]*)?@[^\n]*:\d+(?::\d+)?$/;

/** Playwright wraps what the page threw: "page.evaluate: Error: <message>" plus the page's stack. The message is all a reader needs. */
function readable(error: unknown): Error {
  if (!(error instanceof Error)) return atCaller(new Error(String(error)));
  const text = error.message
    .replace(/^page\.(evaluate|waitForFunction): (Error: )?/, '')
    .split('\n')
    .filter((line) => !PAGE_FRAME.test(line))
    .join('\n')
    .trimEnd();
  return atCaller(Object.assign(new Error(text), { name: error.name }));
}

function describeMessage(message: ConsoleMessage): ConsoleEntry | null {
  const type = message.type();
  if (type !== 'error' && type !== 'warning') return null;
  const { url, lineNumber } = message.location();
  return { type, text: message.text(), ...(url ? { location: `${url}:${lineNumber}` } : {}) };
}

export class PlayerHandle {
  /** The page, for the rare thing the hook does not cover (a screenshot, a CDP session). Specs do not evaluate on it. */
  readonly page: Page;
  /** The session this handle plays, or null for a handle on a bare page (`open({ manifest })`). */
  readonly session: Pick<SessionInfo, 'id' | 'manifestUrl'> | null;
  private readonly origin: string;
  private readonly console: ConsoleEntry[] = [];

  constructor(page: Page, origin: string, session: Pick<SessionInfo, 'id' | 'manifestUrl'> | null = null) {
    this.page = page;
    this.origin = origin.replace(/\/+$/, '');
    this.session = session;
    const remember = (entry: ConsoleEntry | null): void => {
      if (!entry) return;
      this.console.push(entry);
      if (this.console.length > MAX_CONSOLE_ENTRIES) this.console.shift();
    };
    page.on('console', (message) => remember(describeMessage(message)));
    page.on('pageerror', (error) => remember({ type: 'pageerror', text: error.message }));
  }

  /**
   * Navigates to the player page for the session's manifest (`playerUrl({ manifest, ...params })`) and resolves once the player is
   * built and configured (`qa.ready`). `params` are the page parameters of `PlayerPageParams`: `autoplay: false` loads without playing,
   * `muted: false`, `config: 'B'`, `start`, `abr: false`, `hud`. A manifest in `params` replaces the session's.
   *
   * Rejects when the page cannot be used as asked: a parameter it could not apply (`paramProblems`: a typo must fail the test, not
   * quietly change what is measured), a boot failure, or a browser that Shaka reports as unsupported. It does NOT wait for the load:
   * the startup of the player is what specs measure and wait on (`waitFor('firstframe')`).
   */
  async open(params: PlayerPageParams = {}): Promise<this> {
    const manifest = params.manifest ?? this.session?.manifestUrl;
    const url = this.origin + playerUrl({ ...params, ...(manifest === undefined ? {} : { manifest }) });
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_WAIT_MS });
    try {
      // One bounded wait for both: the hook exists synchronously, `ready` resolves when Shaka is built, configured and attached.
      await this.page.waitForFunction(
        () => window.__qa !== undefined && window.__qa.ready.then(() => true),
        undefined,
        {
          timeout: DEFAULT_WAIT_MS,
        },
      );
    } catch (error) {
      throw atCaller(
        new Error(
          `the player page did not boot (${url}): ${readable(error).message}${this.consoleSummary()}`,
        ),
      );
    }
    const info = await this.info();
    if (info.paramProblems.length > 0) {
      throw atCaller(
        new Error(
          `the player page could not use its parameters (${url}):\n  - ${info.paramProblems.join('\n  - ')}`,
        ),
      );
    }
    if (!info.supported) {
      throw atCaller(
        new Error(
          `Shaka reports that this browser is not supported (shaka.Player.isBrowserSupported() is false): ${info.userAgent}${this.consoleSummary()}`,
        ),
      );
    }
    return this;
  }

  private consoleSummary(): string {
    if (this.console.length === 0) return '';
    const last = this.console.slice(-5).map((entry) => `  ${entry.type}: ${entry.text}`);
    return `\nThe browser console said:\n${last.join('\n')}`;
  }

  /** What the browser complained about so far (errors and warnings of the console, uncaught page errors). */
  consoleEntries(): ConsoleEntry[] {
    return [...this.console];
  }

  /** The index the next event will get. Take it before an action; wait for events `since` it. */
  async cursor(): Promise<number> {
    return this.run(() => this.page.evaluate(() => window.__qa.cursor()));
  }

  /** The timeline from `since` (default: all of it). */
  async events(since = 0): Promise<QAEvent[]> {
    return this.run(() =>
      this.page.evaluate((from) => window.__qa.events().filter((event) => event.index >= from), since),
    );
  }

  /** A snapshot of the metrics of docs/METRICS.md, for the latest load. */
  async metrics(): Promise<QAMetrics> {
    return this.run(() => this.page.evaluate(() => window.__qa.metrics()));
  }

  /** The configuration letter, the exact overrides, the load mode, the page parameters as applied and the user agent. */
  async info(): Promise<QAInfo> {
    return this.run(() => this.page.evaluate(() => window.__qa.info()));
  }

  /**
   * Resolves with the first event called `name` (with the given `detail`) at or after `since`. Rejects on timeout with the recent
   * timeline in the message. The history is searched first, so an event that has already happened resolves it.
   */
  async waitFor(name: QAEventName, options: WaitOptions = {}): Promise<QAEvent> {
    const wait: QAWaitOptions = {
      since: options.since ?? 0,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    };
    return this.run(() =>
      this.page.evaluate((arg) => window.__qa.waitFor(arg.name, arg.wait), { name, wait }),
    );
  }

  /** Resolves with the media time reached once `video.currentTime >= seconds` (driven by `timeupdate` and video frames, not by a timer). */
  async waitForMediaTime(seconds: number, options: { timeoutMs?: number } = {}): Promise<number> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
    return this.run(() =>
      this.page.evaluate((arg) => window.__qa.waitForMediaTime(arg.seconds, { timeoutMs: arg.timeoutMs }), {
        seconds,
        timeoutMs,
      }),
    );
  }

  /** `qa.load()`: loads a manifest (default: the page's own) without playing. Rejects with the error and the timeline when the load fails. */
  async load(manifestUri?: string): Promise<void> {
    await this.run(() => this.page.evaluate((uri) => window.__qa.load(uri), manifestUri));
  }

  async play(): Promise<void> {
    await this.run(() => this.page.evaluate(() => window.__qa.play()));
  }

  /** Resolves on the `paused` event. */
  async pause(): Promise<void> {
    await this.run(() => this.page.evaluate(() => window.__qa.pause()));
  }

  /** Resolves on the `seeked` that follows this seek's own `seeking`. */
  async seek(seconds: number): Promise<void> {
    await this.run(() => this.page.evaluate((to) => window.__qa.seek(to), seconds));
  }

  /** Live only. Resolves on the `seeked` of the jump. */
  async seekToLiveEdge(): Promise<void> {
    await this.run(() => this.page.evaluate(() => window.__qa.seekToLiveEdge()));
  }

  /** Pins the rung of that height (ABR off) and resolves on its `variant-changed`. `null` turns ABR back on. */
  async selectVariantByHeight(height: number | null): Promise<void> {
    await this.run(() => this.page.evaluate((h) => window.__qa.selectVariantByHeight(h), height));
  }

  async setAbr(enabled: boolean): Promise<void> {
    await this.run(() => this.page.evaluate((on) => window.__qa.setAbr(on), enabled));
  }

  /** Shaka's `player.configure()`. Rejects when Shaka does not accept the object (a misspelt key must not pass silently). */
  async configure(partial: Record<string, unknown>): Promise<void> {
    await this.run(() => this.page.evaluate((config) => window.__qa.configure(config), partial));
  }

  /** Counts the frames presented and dropped while the media clock advances by `mediaSeconds` (docs/METRICS.md, "Effective fps"). */
  async measureFrames(
    mediaSeconds: number,
    options: { stallTimeoutMs?: number } = {},
  ): Promise<FrameMeasurement> {
    return this.run(() =>
      this.page.evaluate((arg) => window.__qa.measureFrames(arg.mediaSeconds, arg.options), {
        mediaSeconds,
        options,
      }),
    );
  }

  async unload(): Promise<void> {
    await this.run(() => this.page.evaluate(() => window.__qa.unload()));
  }

  private async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw readable(error);
    }
  }
}
