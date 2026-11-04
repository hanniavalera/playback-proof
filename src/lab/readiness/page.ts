import type { Page } from '@playwright/test';
import type { PlayerPageParams, QAEvent, QAEventName, QAInfo, QAMetrics } from '../../shared/qa.ts';
import { playerUrl } from '../../shared/urls.ts';
import { DEFAULT_WAIT_MS, QaPage, readable } from '../measure/page.ts';
import type { ReadinessPlayer } from './world.ts';

// The command line's player: the performance harness's `QaPage` (a typed handle on `window.__qa` that waits on events and never sleeps),
// given the few members the readiness checks use that it does not have (a cursor, the timeline from an index, `configure`, an idle page
// and the start of a load by hand) and the options-object signatures of the support library's `PlayerHandle`, so that the checks cannot
// tell which of the two they were given.

/**
 * Opens the player page without a manifest, so that it builds Shaka and waits (`PlayerPageParams.manifest`: "without it the page boots idle").
 * `QaPage.open` and `PlayerHandle.open` always give the page a manifest, and a page that has one loads it before anything can be configured,
 * so this does what they do (a page that did not boot, a parameter it could not use, a browser Shaka does not support are failures with
 * their own message) for a page that has none. Exported for the spec's player, which wraps a `PlayerHandle` (tests/live/support.ts).
 */
export async function openIdlePage(
  page: Page,
  origin: string,
  consoleSummary: () => string = () => '',
): Promise<QAInfo> {
  const url = origin.replace(/\/+$/, '') + playerUrl({});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_WAIT_MS });
  try {
    await page.waitForFunction(
      () => window.__qa !== undefined && window.__qa.ready.then(() => true),
      undefined,
      { timeout: DEFAULT_WAIT_MS },
    );
  } catch (error) {
    throw new Error(`the player page did not boot (${url}): ${readable(error)}${consoleSummary()}`, {
      cause: error,
    });
  }
  const info = await page.evaluate(() => window.__qa.info());
  if (info.paramProblems.length > 0)
    throw new Error(
      `the player page could not use its parameters (${url}):\n  - ${info.paramProblems.join('\n  - ')}`,
    );
  if (!info.supported)
    throw new Error(
      `Shaka reports that this browser is not supported (shaka.Player.isBrowserSupported() is false): ${info.userAgent}${consoleSummary()}`,
    );
  return info;
}

/**
 * What the page's own start does for the manifest it was given (`src/player/main.ts`): `load`, then `play` when the load is done, inside
 * the page. The chain is started and not waited for, and what it throws is swallowed here because the hook has already put it on its
 * timeline as an `error` event, which is where the page's own start leaves it too. A harness that awaited the load would also wait outside
 * the check's own timeout for a load that hangs. Exported for the spec's player.
 */
export async function loadAndPlayInPage(page: Page, manifestUri: string): Promise<void> {
  await page.evaluate((uri) => {
    void window.__qa
      .load(uri)
      .then(() => window.__qa.play())
      .catch(() => undefined);
  }, manifestUri);
}

export class ReadinessPage implements ReadinessPlayer {
  readonly qa: QaPage;

  constructor(
    readonly page: Page,
    private readonly origin: string,
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

  openIdle(): Promise<QAInfo> {
    return openIdlePage(this.page, this.origin, () => this.consoleSummary());
  }

  loadAndPlay(manifestUri: string): Promise<void> {
    return this.call('qa.load()', () => loadAndPlayInPage(this.page, manifestUri));
  }

  /** The last lines the browser console said, as the failure of a page that did not boot appends them. */
  private consoleSummary(): string {
    if (this.consoleLines.length === 0) return '';
    return `\nThe browser console said:\n${this.consoleLines
      .slice(-5)
      .map((line) => `  ${line}`)
      .join('\n')}`;
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
