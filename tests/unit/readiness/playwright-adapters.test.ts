import { describe, expect, it } from 'vitest';
import { candidateById } from '../../../src/lab/readiness/candidates.ts';
import { runReadinessChecks } from '../../../src/lab/readiness/checks.ts';
import type { LaunchedBrowser } from '../../../src/lab/measure/browser.ts';
import { ReadinessPage } from '../../../src/lab/readiness/page.ts';
import { playwrightWorld } from '../../../src/lab/readiness/playwright-world.ts';
import type { PlaywrightRun } from '../../../src/lab/readiness/playwright-world.ts';
import { fakePlaywright } from './fake-playwright.ts';
import type { FakePage, FakePlaywright } from './fake-playwright.ts';
import { fakeWorld } from './fake-world.ts';

// The command line's page and world, run for real over a fake of the part of Playwright they use (fake-playwright.ts): every line of
// page.ts and playwright-world.ts, and the performance harness's QaPage under them, with the page functions evaluated from their source
// text in a scope that has the page's globals and nothing of the harness's. These tests are the nearest to a browser that a run without
// one can be: they are about the plumbing (what crosses the page boundary, in which order, what is closed, what is deleted), not about
// what a player does, which is the fake world's and the evaluators' tests.

const pageOf = (run: { page: unknown }): FakePage => run.page as FakePage;

/** The command line's world over the fake: the harness's clock is the virtual one the fake page runs on. */
const worldOf = (fp: FakePlaywright, browser: LaunchedBrowser = fp.browser) =>
  playwrightWorld({
    engine: 'chromium',
    stream: 'live-cmaf',
    protocol: 'dash',
    service: fp.service,
    browser,
    now: fp.harness.now,
  });

async function openPlayer(
  fp: FakePlaywright,
): Promise<{ player: ReadinessPage; page: FakePage; manifestUrl: string }> {
  const info = await fp.service.createSession({ stream: 'live-cmaf', protocol: 'dash', label: 'test' });
  const run = await fp.browser.newRun();
  return {
    player: new ReadinessPage(run.page, fp.service.origin, info.manifestUrl),
    page: pageOf(run),
    manifestUrl: info.manifestUrl,
  };
}

describe('the fake page is as strict as the browser, or nothing below proves anything', () => {
  it('evaluates a function from its source text: a variable of the harness is not there', async () => {
    const { page } = await openPlayer(fakePlaywright());
    const secret = 42;
    await expect(page.evaluate(() => secret)).rejects.toThrow(
      /page\.evaluate: ReferenceError: secret is not defined/,
    );
  });

  it('hides the Node globals of the harness from the page', async () => {
    const { page } = await openPlayer(fakePlaywright());
    expect(await page.evaluate(() => typeof process)).toBe('undefined');
    expect(await page.evaluate(() => typeof require)).toBe('undefined');
  });

  it('hands over the argument and the result by structured clone, which keeps what a metrics snapshot holds', async () => {
    const { page } = await openPlayer(fakePlaywright());
    expect(await page.evaluate((n: number) => n + 1, 1)).toBe(2);
    expect(await page.evaluate(() => Infinity)).toBe(Infinity);
    await expect(
      page.evaluate(
        (f: unknown) => f,
        () => 1,
      ),
    ).rejects.toThrow(/cannot cross the page boundary/);
  });

  it('evaluates a string as a script, returns its completion value, and awaits a promise', async () => {
    const { page } = await openPlayer(fakePlaywright());
    expect(await page.evaluate('1 + 1')).toBe(2);
    expect(await page.evaluate('Promise.resolve(5)')).toBe(5);
    expect(await page.evaluate('var a = 3; a * 2')).toBe(6);
    expect(await page.evaluate('performance.timeOrigin')).toBeGreaterThan(1_000_000_000_000);
  });

  it('models what Shaka does with live sync: a patch that arrives after the load started is not in force', async () => {
    const fp = fakePlaywright();
    const { player } = await openPlayer(fp);
    await player.open();
    await player.configure({ streaming: { liveSync: { enabled: true } } });
    expect(fp.observed.runs[0]?.configured).toHaveLength(1);
    expect(fp.observed.runs[0]?.liveSyncAtLoad).toBe(false);
  });

  it('says what Playwright says of a page that crashed or was closed', async () => {
    const fp = fakePlaywright();
    const crashed = (await openPlayer(fp)).page;
    crashed.crash();
    await expect(crashed.evaluate(() => 1)).rejects.toThrow('page.evaluate: Page crashed');
    const closed = (await openPlayer(fp)).page;
    await closed.close();
    await expect(closed.evaluate(() => 1)).rejects.toThrow('has been closed');
  });
});

describe('ReadinessPage over the fake page', () => {
  it('opens the player page for the session, with the parameters it is given, and returns what the page says of itself', async () => {
    const fp = fakePlaywright();
    const { player, page } = await openPlayer(fp);
    const info = await player.open({ config: 'B', autoplay: false });
    expect(info.shakaVersion).toBe('5.3.3');
    const url = page.gotoUrls[0] ?? '';
    expect(url.startsWith(`${fp.service.origin}/player/?manifest=%2Fs%2F`)).toBe(true);
    expect(url).toContain('config=B');
    expect(url).toContain('autoplay=0');
  });

  it('says why the page did not boot in the words of the navigation error', async () => {
    const fp = fakePlaywright({ openFails: true });
    const { player } = await openPlayer(fp);
    await expect(player.open()).rejects.toThrow(/net::ERR_CONNECTION_REFUSED/);
  });

  it('reads the cursor and the timeline of the hook from a page function, and filters the timeline in the page', async () => {
    const { player } = await openPlayer(fakePlaywright());
    await player.open();
    expect(await player.cursor()).toBe(0);
    await player.waitFor('firstframe');
    expect(await player.cursor()).toBe(1);
    expect((await player.events()).map((event) => event.name)).toEqual(['firstframe']);
    expect(await player.events(1)).toEqual([]);
  });

  it('opens a page without a manifest, which loads nothing, and starts the load and the play in ONE call into the page', async () => {
    const fp = fakePlaywright();
    const { player, page, manifestUrl } = await openPlayer(fp);
    const info = await player.openIdle();
    expect(info.supported).toBe(true);
    expect(page.gotoUrls).toEqual([`${fp.service.origin}/player/`]);
    // Nothing was loaded, so nothing is presented: an idle page that nothing starts must not look like a slow join.
    await expect(player.waitFor('firstframe', { timeoutMs: 800 })).rejects.toThrow(/timed out/);
    const patch = { streaming: { liveSync: { enabled: true } } };
    await player.configure(patch);
    const sentBefore = page.sent.length;
    await player.loadAndPlay(manifestUrl);
    // One round trip, not two: the startup of the join must not include the harness's own latency between the load and the play.
    expect(page.sent.length - sentBefore).toBe(1);
    expect(fp.observed.runs[0]?.calls).toEqual(['openIdle', 'configure', 'load', 'play']);
    expect(fp.observed.runs[0]?.liveSyncAtLoad).toBe(true);
    expect((await player.waitFor('firstframe')).name).toBe('firstframe');
  });

  it('leaves a failure of the load to the timeline of the page, as the page does for the manifest it was given, and does not wait for it', async () => {
    const fp = fakePlaywright();
    const { player } = await openPlayer(fp);
    await player.openIdle();
    // The fake page refuses a manifest of another session inside the page; the harness must not see it as a throw.
    await expect(player.loadAndPlay('/s/another/live-cmaf/dash/manifest.mpd')).resolves.toBeUndefined();
    expect(fp.observed.runs[0]?.calls).toEqual(['openIdle']);
    await expect(player.waitFor('firstframe', { timeoutMs: 800 })).rejects.toThrow(/timed out/);
  });

  it('says why an idle page did not boot in the words of the navigation error', async () => {
    const { player } = await openPlayer(fakePlaywright({ openFails: true }));
    await expect(player.openIdle()).rejects.toThrow(/net::ERR_CONNECTION_REFUSED/);
  });

  it('sends a configuration patch across the boundary intact, and labels a failure with the call that made it', async () => {
    const fp = fakePlaywright();
    const { player } = await openPlayer(fp);
    await player.open();
    const patch = { streaming: { liveSync: { enabled: true } } };
    await player.configure(patch);
    expect(fp.observed.runs[0]?.configured).toEqual([patch]);
    await expect(player.configure({ bad: () => 1 } as unknown as Record<string, unknown>)).rejects.toThrow(
      /^qa\.configure\(\): .*cannot cross the page boundary/,
    );
  });

  it("waits on the hook for an event and for the media clock, and a timeout is in the hook's words, not Playwright's", async () => {
    const { player } = await openPlayer(fakePlaywright());
    await player.open();
    const frame = await player.waitFor('firstframe', { timeoutMs: 5000 });
    expect(frame.name).toBe('firstframe');
    expect(await player.waitForMediaTime(3, { timeoutMs: 5000 })).toBeGreaterThanOrEqual(3);
    const failure = await player
      .waitFor('buffering-start', { timeoutMs: 800 })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^qa\.waitFor\('buffering-start'\): /);
    expect((failure as Error).message).not.toContain('page.evaluate');
  });

  it("evaluates the soak's expressions with a label that names the step that failed", async () => {
    const { player } = await openPlayer(fakePlaywright());
    await player.open();
    expect(await player.evaluate<number>('time origin', 'performance.timeOrigin')).toBeGreaterThan(0);
    await expect(player.evaluate('drain the sampler', 'window.nothing.here')).rejects.toThrow(
      /^drain the sampler: .*TypeError/,
    );
  });

  it('keeps what the console said, errors and warnings and uncaught errors, and not the rest', async () => {
    const { player, page } = await openPlayer(fakePlaywright());
    page.console('log', 'hello');
    page.console('error', 'Failed to load resource');
    page.console('warning', 'deprecated');
    page.pageError('boom');
    expect(player.consoleLines).toEqual([
      'error: Failed to load resource',
      'warning: deprecated',
      'pageerror: boom',
    ]);
  });
});

describe('playwrightWorld', () => {
  const world = worldOf;

  it('creates the session the request describes, then a fresh context and page for it, and deletes the session when the run closes', async () => {
    const fp = fakePlaywright();
    const run = await world(fp).newRun({
      label: 'PB-RDY-005 soak 5 min',
      ttlSec: 1200,
      live: { startOffsetSec: 31.2 },
    });
    expect(fp.service.calls).toEqual(['createSession']);
    expect(fp.observed.runs[0]?.request).toMatchObject({
      label: 'PB-RDY-005 soak 5 min',
      ttlSec: 1200,
      live: { startOffsetSec: 31.2 },
    });
    expect(run.session.manifestUrl).toBe(`/s/${run.session.id}/live-cmaf/dash/manifest.mpd`);
    expect(run.session.service).toBe(fp.service);
    expect(fp.env.contexts).toHaveLength(1);
    await run.close();
    expect(fp.env.contexts[0]?.closed).toBe(true);
    expect(pageOf(run).isClosed()).toBe(true);
    expect(fp.service.deleted).toEqual([run.session.id]);
  });

  it('makes a context of its own for every run: nothing is carried over from the run before', async () => {
    const fp = fakePlaywright();
    const w = world(fp);
    const first = await w.newRun({ label: 'one' });
    const second = await w.newRun({ label: 'two' });
    expect(fp.env.contexts).toHaveLength(2);
    expect(first.context).not.toBe(second.context);
    expect(first.session.id).not.toBe(second.session.id);
    await first.close();
    expect(fp.env.contexts[1]?.closed).toBe(false);
  });

  it('deletes the session it created when the browser could not make a page, and says why', async () => {
    const fp = fakePlaywright();
    const failing = { ...fp.browser, newRun: async () => Promise.reject(new Error('launch failed')) };
    await expect(worldOf(fp, failing).newRun({ label: 'x' })).rejects.toThrow('launch failed');
    expect(fp.service.deleted).toHaveLength(1);
  });

  it('knows why a page is gone: a crash, or a close, and the first of them stays the reason', async () => {
    const fp = fakePlaywright();
    const run = await world(fp).newRun({ label: 'x' });
    expect(run.crashed()).toBeNull();
    pageOf(run).crash();
    expect(run.crashed()).toBe('the page crashed');
    await pageOf(run).close();
    expect(run.crashed()).toBe('the page crashed');
    const other = await world(fp).newRun({ label: 'y' });
    await pageOf(other).close();
    expect(other.crashed()).toBe('the page was closed');
  });

  it('keeps the console errors and uncaught errors of the page, a few dozen at most', async () => {
    const fp = fakePlaywright();
    const run: PlaywrightRun = await world(fp).newRun({ label: 'x' });
    const page = pageOf(run);
    page.console('warning', 'not an error');
    for (let i = 0; i < 60; i++) page.console('error', `failure ${i}`);
    page.pageError('uncaught');
    const problems = run.consoleProblems();
    expect(problems).toHaveLength(40);
    expect(problems[0]).toBe('console error: failure 0');
    expect(problems).not.toContain('console error: not an error');
  });
});

describe("the four checks through the command line's world", () => {
  const options = {
    checks: ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'] as const,
    joins: 5,
    stallRuns: 2,
    windowSec: 30,
    refreshes: 12,
  };
  const summary = (results: Awaited<ReturnType<typeof runReadinessChecks>>) =>
    results.map((result) => ({
      id: result.id,
      verdict: result.verdict,
      evaluations: result.evaluations.map((e) => [e.id, e.verdict, e.value]),
    }));

  it('give the verdicts and the numbers that the fake world gives them directly: the adapters add nothing and lose nothing', async () => {
    const fp = fakePlaywright();
    const viaPlaywright = await runReadinessChecks(worldOf(fp), { ...options, checks: [...options.checks] });
    const direct = await runReadinessChecks(fakeWorld().world, { ...options, checks: [...options.checks] });
    expect(summary(viaPlaywright)).toEqual(summary(direct));
    expect(viaPlaywright.find((r) => r.id === 'PB-RDY-003')?.verdict).toBe('NO-GO');
    // The defaults are opened as a viewer's page opens: with the manifest, which the page loads by itself, and nothing configured.
    expect(fp.observed.runs.every((run) => run.calls.join() === 'open' && run.configured.length === 0)).toBe(
      true,
    );
    for (const page of fp.env.pages) expect(page.gotoUrls[0]).toContain('/player/?manifest=');
    // Every run was closed: no context and no session left behind.
    expect(fp.env.contexts.every((context) => context.closed)).toBe(true);
    expect(fp.service.deleted).toHaveLength(fp.env.contexts.length);
  });

  it('apply the candidate BEFORE the player loads: an idle page, the patch whole, then the load and the play; and the player catches up', async () => {
    const fp = fakePlaywright();
    const candidate = candidateById('live-sync');
    const results = await runReadinessChecks(worldOf(fp), {
      ...options,
      checks: ['PB-RDY-003'],
      patch: candidate?.patch ?? null,
    });
    expect(results[0]?.verdict).toBe('GO');
    expect(fp.observed.runs.every((run) => run.configured.length === 1)).toBe(true);
    expect(fp.observed.runs[0]?.configured[0]).toEqual(candidate?.patch);
    // Shaka reads `streaming.liveSync.enabled` in load(): the page was opened without a manifest, configured, and only then told to load.
    for (const run of fp.observed.runs) {
      expect(run.calls).toEqual(['openIdle', 'configure', 'load', 'play']);
      expect(run.liveSyncAtLoad).toBe(true);
    }
    for (const page of fp.env.pages) expect(page.gotoUrls).toEqual([`${fp.service.origin}/player/`]);
    expect(fp.service.calls.filter((call) => call.startsWith('qa.'))).toEqual(
      fp.observed.runs.flatMap(() => ['qa.configure', 'qa.load', 'qa.play']),
    );
  });

  it("report a page that cannot boot as a check that could not run, with the browser's words, and close what they opened", async () => {
    const fp = fakePlaywright({ openFails: true });
    const results = await runReadinessChecks(worldOf(fp), { ...options, checks: ['PB-RDY-002'] });
    expect(results[0]?.verdict).toBe('INCONCLUSIVE');
    expect(results[0]?.error).toContain('net::ERR_CONNECTION_REFUSED');
    expect(fp.env.contexts.every((context) => context.closed)).toBe(true);
    expect(fp.service.deleted).toHaveLength(1);
  });
});
