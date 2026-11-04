import type { ConsoleMessage, Page } from '@playwright/test';
import type {
  FrameMeasurement,
  PlayerPageParams,
  QAEvent,
  QAEventName,
  QAInfo,
  QAMetrics,
  QAWaitOptions,
} from '../../shared/qa.ts';
import { playerUrl } from '../../shared/urls.ts';
import { withTimeout } from './timeouts.ts';

// The harness's handle on the player page: a typed wrapper over `window.__qa` (src/shared/qa.ts), so that a scenario reads as what it
// measures and never sees the page boundary. It is deliberately smaller than the Playwright support library's PlayerHandle
// (tests/e2e/support/player.ts), which carries spec-only machinery (caller stacks for failure messages) that a library under src/lab
// must not depend on. Every wait is on a player event or on the media clock, with an explicit timeout; nothing here sleeps.

/** Timeout of every wait that is not given one: well above a healthy page's needs, so a stuck wait reports itself and not the run's own limit. */
export const DEFAULT_WAIT_MS = 15_000;

const MAX_CONSOLE_LINES = 40;

/** Playwright wraps what the page threw ("page.evaluate: Error: ...") and appends the page's own stack: the message is all a reader needs. */
export function readable(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^page\.(evaluate|waitForFunction): (Error: )?/, '')
    .split('\n')
    .filter((line) => !/^\s+at |^(?:\S[^\n]*)?@[^\n]*:\d+(?::\d+)?$/.test(line))
    .join('\n')
    .trimEnd();
}

/**
 * What a scenario needs from the page: the part of `QaPage` it calls. Scenarios are written against this, so that their measurement
 * logic (what is waited for, what is read, what makes a run invalid) is unit-tested with a scripted player and no browser.
 */
export interface PlayerDriver {
  open(manifest: string, params?: PlayerPageParams, timeoutMs?: number): Promise<QAInfo>;
  metrics(): Promise<QAMetrics>;
  waitFor(
    name: QAEventName,
    options?: { since?: number; timeoutMs?: number; detail?: QAWaitOptions['detail'] },
  ): Promise<QAEvent>;
  waitForMediaTime(seconds: number, timeoutMs?: number): Promise<number>;
  load(): Promise<void>;
  play(): Promise<void>;
  selectVariantByHeight(height: number): Promise<void>;
  measureFrames(mediaSeconds: number, stallTimeoutMs?: number): Promise<FrameMeasurement>;
}

export class QaPage implements PlayerDriver {
  /** What the browser complained about while this page was open (errors and warnings of the console, uncaught page errors). */
  readonly consoleLines: string[] = [];

  constructor(
    readonly page: Page,
    private readonly origin: string,
  ) {
    const remember = (line: string): void => {
      this.consoleLines.push(line);
      if (this.consoleLines.length > MAX_CONSOLE_LINES) this.consoleLines.shift();
    };
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' || message.type() === 'warning')
        remember(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => remember(`pageerror: ${error.message}`));
  }

  /**
   * Navigates to the player page for `manifest` and resolves when the player is built and configured (`qa.ready`). Rejects when the page
   * could not use what it was asked (a typo in a parameter would silently change what is measured), when it did not boot, or when
   * Shaka reports the browser unsupported. It does not wait for the load: the startup of the player is what a scenario measures.
   */
  async open(manifest: string, params: PlayerPageParams = {}, timeoutMs = DEFAULT_WAIT_MS): Promise<QAInfo> {
    const url = this.origin + playerUrl({ ...params, manifest });
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
      await this.page.waitForFunction(
        () => window.__qa !== undefined && window.__qa.ready.then(() => true),
        undefined,
        { timeout: timeoutMs },
      );
    } catch (error) {
      throw new Error(`the player page did not boot (${url}): ${readable(error)}${this.consoleSummary()}`, {
        cause: error,
      });
    }
    const info = await this.info();
    if (info.paramProblems.length > 0)
      throw new Error(
        `the player page could not use its parameters (${url}):\n  - ${info.paramProblems.join('\n  - ')}`,
      );
    if (!info.supported)
      throw new Error(
        `Shaka reports that this browser is not supported (shaka.Player.isBrowserSupported() is false): ${info.userAgent}${this.consoleSummary()}`,
      );
    return info;
  }

  private async run<T>(label: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new Error(`${label}: ${readable(error)}`, { cause: error });
    }
  }

  info(): Promise<QAInfo> {
    return this.run('qa.info()', () => this.page.evaluate(() => window.__qa.info()));
  }

  metrics(): Promise<QAMetrics> {
    return this.run('qa.metrics()', () => this.page.evaluate(() => window.__qa.metrics()));
  }

  events(): Promise<QAEvent[]> {
    return this.run('qa.events()', () => this.page.evaluate(() => window.__qa.events()));
  }

  /** Resolves with the first event called `name` (the whole history is searched, so an event that already happened resolves it). */
  waitFor(
    name: QAEventName,
    options: { since?: number; timeoutMs?: number; detail?: QAWaitOptions['detail'] } = {},
  ): Promise<QAEvent> {
    const wait: QAWaitOptions = {
      since: options.since ?? 0,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    };
    return this.run(`qa.waitFor('${name}')`, () =>
      this.page.evaluate((arg) => window.__qa.waitFor(arg.name, arg.wait), { name, wait }),
    );
  }

  /** Resolves with the media time reached once `video.currentTime >= seconds`. Driven by the media element's events, not by a timer. */
  waitForMediaTime(seconds: number, timeoutMs = DEFAULT_WAIT_MS): Promise<number> {
    return this.run(`qa.waitForMediaTime(${seconds})`, () =>
      this.page.evaluate((arg) => window.__qa.waitForMediaTime(arg.seconds, { timeoutMs: arg.timeoutMs }), {
        seconds,
        timeoutMs,
      }),
    );
  }

  /** `qa.load()` of the page's own manifest, without playing. */
  load(): Promise<void> {
    return this.run('qa.load()', () => this.page.evaluate(() => window.__qa.load()));
  }

  play(): Promise<void> {
    return this.run('qa.play()', () => this.page.evaluate(() => window.__qa.play()));
  }

  /** Pins the rung of that height (ABR off). Before anything has played the buffer is flushed, so the pinned rung is what plays first. */
  selectVariantByHeight(height: number): Promise<void> {
    return this.run(`qa.selectVariantByHeight(${height})`, () =>
      this.page.evaluate((h) => window.__qa.selectVariantByHeight(h), height),
    );
  }

  /** Counts the frames presented and dropped while the media clock advances by `mediaSeconds` (docs/METRICS.md, "Effective fps"). */
  measureFrames(mediaSeconds: number, stallTimeoutMs?: number): Promise<FrameMeasurement> {
    return this.run(`qa.measureFrames(${mediaSeconds})`, () =>
      this.page.evaluate((arg) => window.__qa.measureFrames(arg.mediaSeconds, arg.options), {
        mediaSeconds,
        options: stallTimeoutMs === undefined ? {} : { stallTimeoutMs },
      }),
    );
  }

  private consoleSummary(): string {
    if (this.consoleLines.length === 0) return '';
    return `\nThe browser console said:\n${this.consoleLines
      .slice(-5)
      .map((line) => `  ${line}`)
      .join('\n')}`;
  }

  /** What to attach to a failed run: the recent timeline of the player and the console, each as far as the page can still tell it. */
  async diagnostics(): Promise<string> {
    const parts: string[] = [];
    try {
      const events = await withTimeout(this.events(), 3000, 'qa.events()');
      const origin = events[0]?.t ?? 0;
      parts.push(
        'the last events of the player:',
        ...events.slice(-12).map((event) => {
          const detail = event.detail ? ` ${JSON.stringify(event.detail)}` : '';
          return `  #${event.index} +${(event.t - origin).toFixed(0)} ms media ${event.mediaTime.toFixed(2)} ${event.name}${detail}`.slice(
            0,
            200,
          );
        }),
      );
    } catch (error) {
      parts.push(`the page's timeline is not available (${readable(error)})`);
    }
    const browserSaid = this.consoleSummary().trim();
    if (browserSaid) parts.push(browserSaid);
    return parts.join('\n');
  }
}
