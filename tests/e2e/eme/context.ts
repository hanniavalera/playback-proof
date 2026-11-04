import type { Browser, BrowserContext, TestInfo } from '@playwright/test';

/**
 * A browser context of its own, with the device settings of the project (the user agent decides which device class the player
 * picks, so a control must have the same one as the page it controls).
 *
 * Why the EME controls do not share the test's context: the ClearKey module of Firefox keeps the keys of a context in one table keyed
 * by key id, and the FIRST key given for a key id wins until the page that gave it is closed (measured, ADR-105): in the same
 * context a page with a wrong key plays with the right key of the page next to it, and a page with the right key fails after a page
 * with a wrong one. A new context has a table of its own (so does a page of the same context once the first page was closed, but that
 * depends on how fast the module lets go of the key, which is why the controls do not rely on it).
 */
export function newIsolatedContext(
  browser: Browser,
  use: TestInfo['project']['use'],
): Promise<BrowserContext> {
  const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } = use;
  return browser.newContext({
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
  });
}
