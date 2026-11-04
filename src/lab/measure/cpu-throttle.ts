import type { BrowserContext, CDPSession, Page } from '@playwright/test';

// The low-end device of the lab: Chromium with a CPU slowdown. Firefox and WebKit have no equivalent, which is why the catalog's
// `@cpu` rows and the performance profile `chromium-cpu4x` say Chromium. Shared by the specs (their project's metadata gives the rate)
// and the performance harness (the profile gives it).

/**
 * Slows the page's CPU by `rate` with `Emulation.setCPUThrottlingRate`. It must be called BEFORE the page navigates, and the returned
 * session must stay attached: the emulation lasts as long as the session. Chromium only: asking for it anywhere else is a
 * configuration mistake and fails, because a silently unthrottled "low-end" run would be a lie.
 */
export async function applyCpuThrottle(options: {
  browserName: string;
  rate: number;
  context: Pick<BrowserContext, 'newCDPSession'>;
  page: Page;
}): Promise<CDPSession> {
  const { browserName, rate, context, page } = options;
  if (browserName !== 'chromium') {
    throw new Error(
      `the project asks for a ${rate}x CPU throttle, but ${browserName} has no CPU throttle (it is a Chromium DevTools command): the low-end profile is Chromium only`,
    );
  }
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
  return session;
}
