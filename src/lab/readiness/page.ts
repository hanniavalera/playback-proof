import type { Page } from '@playwright/test';
import type { PlayerPageParams, QAEvent, QAEventName, QAInfo, QAMetrics } from '../../shared/qa.ts';
import { QaPage, readable } from '../measure/page.ts';
import type { ReadinessPlayer } from './world.ts';

// The command line's player: the performance harness's `QaPage` (a typed handle on `window.__qa` that waits on events and never sleeps),
// given the few members the readiness checks use that it does not have (a cursor, the timeline from an index, `configure`) and the
// options-object signatures of the support library's `PlayerHandle`, so that the checks cannot tell which of the two they were given.

export class ReadinessPage implements ReadinessPlayer {
  readonly qa: QaPage;

  constructor(
    readonly page: Page,
    origin: string,
    private readonly manifestUrl: string,
  ) {
    this.qa = new QaPage(page, origin);
  }

  /** What the browser console said (errors and warnings, uncaught page errors), the last few. */
  get consoleLines(): readonly string[] {
    return this.qa.consoleLines;
  }

  open(params: PlayerPageParams = {}): Promise<QAInfo> {
    return this.qa.open(this.manifestUrl, params);
  }

  metrics(): Promise<QAMetrics> {
    return this.qa.metrics();
  }

  info(): Promise<QAInfo> {
    return this.qa.info();
  }

  waitFor(name: QAEventName, options: { since?: number; timeoutMs?: number } = {}): Promise<QAEvent> {
    return this.qa.waitFor(name, options);
  }

  waitForMediaTime(seconds: number, options: { timeoutMs?: number } = {}): Promise<number> {
    return this.qa.waitForMediaTime(seconds, options.timeoutMs);
  }

  async cursor(): Promise<number> {
    return this.call('qa.cursor()', () => this.page.evaluate(() => window.__qa.cursor()));
  }

  async events(since = 0): Promise<QAEvent[]> {
    return this.call('qa.events()', () =>
      this.page.evaluate((from) => window.__qa.events().filter((event) => event.index >= from), since),
    );
  }

  /** Shaka's `player.configure()`; the hook throws when Shaka rejects the object, so a misspelt key cannot pass silently. */
  async configure(patch: Record<string, unknown>): Promise<void> {
    await this.call('qa.configure()', () =>
      this.page.evaluate((config) => window.__qa.configure(config), patch),
    );
  }

  /** Evaluates an expression in the page (the soak's sampler, which is a string: see sampler.ts). */
  async evaluate<T>(label: string, expression: string): Promise<T> {
    return this.call(label, () => this.page.evaluate(expression) as Promise<T>);
  }

  private async call<T>(label: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new Error(`${label}: ${readable(error)}`, { cause: error });
    }
  }
}
