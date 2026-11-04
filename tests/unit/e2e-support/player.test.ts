import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAEvent, QAInfo } from '../../../src/shared/qa.ts';
import { DEFAULT_WAIT_MS, PlayerHandle } from '../../../tests/e2e/support/player.ts';

// PlayerHandle is glue: what matters is that every call reaches the hook with the arguments the spec gave (and an explicit timeout),
// that a page that cannot be used fails `open()` with the reason, and that the page's errors arrive readable. A fake page runs the
// functions the handle evaluates against a fake `window.__qa`; the real hook in real engines is exercised by the specs.

const INFO: QAInfo = {
  shakaVersion: '5.3.3',
  userAgent: 'Fixture/1.0',
  config: 'A',
  configOverrides: {},
  configDefaults: {},
  configured: [],
  manifestUri: null,
  supported: true,
  loadMode: null,
  params: { config: 'A', autoplay: true, muted: true, start: null, abr: true, hud: false },
  paramProblems: [],
};
const EVENT: QAEvent = { index: 4, t: 10, name: 'firstframe', mediaTime: 0.04 };

function fakeQa(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const note =
    <T>(name: string, value?: T) =>
    async (...args: unknown[]): Promise<T | undefined> => {
      calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`);
      return value;
    };
  const qa = {
    ready: Promise.resolve(),
    cursor: () => 7,
    events: () => [
      { index: 0, t: 1, name: 'load-requested', mediaTime: 0 },
      { index: 1, t: 2, name: 'loaded', mediaTime: 0 },
      { index: 2, t: 3, name: 'firstframe', mediaTime: 0.04 },
    ],
    metrics: () => ({ state: 'playing' }),
    info: () => INFO,
    waitFor: note('waitFor', EVENT),
    waitForMediaTime: note('waitForMediaTime', 3.04),
    load: note('load'),
    play: note('play'),
    pause: note('pause'),
    seek: note('seek'),
    seekToLiveEdge: note('seekToLiveEdge'),
    selectVariantByHeight: note('selectVariantByHeight'),
    setAbr: (enabled: boolean) => void calls.push(`setAbr(${enabled})`),
    configure: (config: unknown) => void calls.push(`configure(${JSON.stringify(config)})`),
    measureFrames: note('measureFrames', {
      presented: 90,
      dropped: 0,
      decoded: 90,
      mediaSeconds: 3,
      fps: 30,
    }),
    unload: note('unload'),
    ...overrides,
  };
  return { qa, calls };
}

type Listener = (arg: unknown) => void;

function fakePage(qa: unknown, options: { bootFails?: Error } = {}) {
  const listeners = new Map<string, Listener[]>();
  const gotos: Array<{ url: string; options: unknown }> = [];
  return {
    gotos,
    emit: (event: string, arg: unknown) => (listeners.get(event) ?? []).forEach((listener) => listener(arg)),
    on: (event: string, listener: Listener) =>
      void listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    goto: async (url: string, goOptions: unknown) => void gotos.push({ url, options: goOptions }),
    waitForFunction: async (fn: () => unknown) => {
      if (options.bootFails) throw options.bootFails;
      const result = await fn();
      if (!result) throw new Error('page.waitForFunction: predicate returned a falsy value');
    },
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    qa,
  };
}

const SESSION = { id: 'abc', manifestUrl: '/s/abc/vod-cmaf/dash/manifest.mpd' };

function handleFor(qaOverrides: Record<string, unknown> = {}, pageOptions: { bootFails?: Error } = {}) {
  const { qa, calls } = fakeQa(qaOverrides);
  const page = fakePage(qa, pageOptions);
  (globalThis as unknown as { window: unknown }).window = { __qa: qa };
  const handle = new PlayerHandle(page as never, 'http://127.0.0.1:4650/', SESSION);
  return { handle, page, calls };
}

beforeEach(() => {
  delete (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('PlayerHandle.open', () => {
  it("navigates to the player page for the session's manifest, with the page parameters of the call", async () => {
    const { handle, page } = handleFor();
    await expect(handle.open({ autoplay: false, config: 'B', start: 12 })).resolves.toBe(handle);
    expect(page.gotos).toStrictEqual([
      {
        url: 'http://127.0.0.1:4650/player/?manifest=%2Fs%2Fabc%2Fvod-cmaf%2Fdash%2Fmanifest.mpd&config=B&autoplay=0&start=12',
        options: { waitUntil: 'domcontentloaded', timeout: DEFAULT_WAIT_MS },
      },
    ]);
  });

  it("lets a manifest in the parameters replace the session's, and opens a bare page without one", async () => {
    const { handle, page } = handleFor();
    await handle.open({ manifest: '/s/other/live-cmaf/hls/master.m3u8' });
    expect(page.gotos[0]?.url).toBe(
      'http://127.0.0.1:4650/player/?manifest=%2Fs%2Fother%2Flive-cmaf%2Fhls%2Fmaster.m3u8',
    );
    const bare = new PlayerHandle(page as never, 'http://127.0.0.1:4650');
    await bare.open();
    expect(page.gotos[1]?.url).toBe('http://127.0.0.1:4650/player/');
  });

  it("fails with the page's own words when it could not use a parameter: a typo must fail the test, not change what is measured", async () => {
    const { handle } = handleFor({
      info: () => ({
        ...INFO,
        paramProblems: [
          'muted="maybe" is not 1/0 (or true/false): using true',
          'start=-3 is not a number of seconds >= 0',
        ],
      }),
    });
    await expect(handle.open()).rejects.toThrow(
      /could not use its parameters[\s\S]*- muted="maybe" is not 1\/0[\s\S]*- start=-3 is not a number of seconds >= 0/,
    );
  });

  it('fails when Shaka says the browser is not supported, with the user agent', async () => {
    const { handle } = handleFor({ info: () => ({ ...INFO, supported: false }) });
    await expect(handle.open()).rejects.toThrow(/not supported[\s\S]*Fixture\/1\.0/);
  });

  it('fails when the page does not boot, with the reason and what the browser console said', async () => {
    const { handle, page } = handleFor(
      {},
      { bootFails: new Error('page.waitForFunction: Timeout 15000ms exceeded.') },
    );
    page.emit('console', {
      type: () => 'error',
      text: () => 'Refused to load the script',
      location: () => ({ url: 'http://x/player.js', lineNumber: 1 }),
    });
    await expect(handle.open()).rejects.toThrow(
      /the player page did not boot \(http:\/\/127\.0\.0\.1:4650\/player\/\?manifest=[^)]*\): Timeout 15000ms exceeded\.\nThe browser console said:\n {2}error: Refused to load the script/,
    );
  });
});

describe('PlayerHandle: calls reach the hook', () => {
  it('passes every action its arguments', async () => {
    const { handle, calls } = handleFor();
    await handle.load('/m.mpd');
    await handle.load();
    await handle.play();
    await handle.pause();
    await handle.seek(30);
    await handle.seekToLiveEdge();
    await handle.selectVariantByHeight(720);
    await handle.selectVariantByHeight(null);
    await handle.setAbr(false);
    await handle.configure({ streaming: { bufferingGoal: 20 } });
    await handle.unload();
    expect(calls).toStrictEqual([
      'load("/m.mpd")',
      'load()',
      'play()',
      'pause()',
      'seek(30)',
      'seekToLiveEdge()',
      'selectVariantByHeight(720)',
      'selectVariantByHeight(null)',
      'setAbr(false)',
      'configure({"streaming":{"bufferingGoal":20}})',
      'unload()',
    ]);
  });

  it('reads the cursor, the info and the metrics, and the timeline from a cursor on', async () => {
    const { handle } = handleFor();
    await expect(handle.cursor()).resolves.toBe(7);
    await expect(handle.info()).resolves.toStrictEqual(INFO);
    await expect(handle.metrics()).resolves.toStrictEqual({ state: 'playing' });
    await expect(handle.events()).resolves.toHaveLength(3);
    await expect(handle.events(2)).resolves.toStrictEqual([
      { index: 2, t: 3, name: 'firstframe', mediaTime: 0.04 },
    ]);
  });

  it('gives every wait an explicit timeout, and the whole history as its default cursor', async () => {
    const { handle, calls } = handleFor();
    await handle.waitFor('firstframe');
    await handle.waitFor('seeked', { since: 9, timeoutMs: 2000, detail: { reason: 'abr', height: 720 } });
    await handle.waitForMediaTime(3);
    await handle.waitForMediaTime(8, { timeoutMs: 30000 });
    await handle.measureFrames(5);
    expect(calls).toStrictEqual([
      `waitFor("firstframe", {"since":0,"timeoutMs":${DEFAULT_WAIT_MS}})`,
      'waitFor("seeked", {"since":9,"timeoutMs":2000,"detail":{"reason":"abr","height":720}})',
      `waitForMediaTime(3, {"timeoutMs":${DEFAULT_WAIT_MS}})`,
      'waitForMediaTime(8, {"timeoutMs":30000})',
      'measureFrames(5, {})',
    ]);
    await expect(handle.waitFor('firstframe')).resolves.toStrictEqual(EVENT);
  });

  it('keeps every wait shorter than the 45 s of a test, so a stuck wait fails as itself', () => {
    expect(DEFAULT_WAIT_MS).toBeLessThan(45_000 / 2);
  });
});

describe('PlayerHandle: errors', () => {
  const pageError = new Error(
    "page.evaluate: Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).\n3 events so far, the last 3:\n  #0 t=1.0 media=0.000 load-requested\n  #1 t=2.0 media=0.000 loaded\n    at eval (eval at evaluate (:313:29), <anonymous>:3:21)\n    at UtilityScript.evaluate (<anonymous>:290:18)",
  );

  it("hands the page's message to the spec without Playwright's prefix and the page's stack, keeping the timeline", async () => {
    const { handle } = handleFor({ waitFor: () => Promise.reject(pageError) });
    const error = await handle.waitFor('firstframe').catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).\n3 events so far, the last 3:\n  #0 t=1.0 media=0.000 load-requested\n  #1 t=2.0 media=0.000 loaded",
    );
    expect((error as Error).stack).not.toMatch(/tests[\\/]e2e[\\/]support[\\/]/);
    expect((error as Error).stack).toContain('player.test.ts');
  });

  it('applies to every call, not only waits', async () => {
    const { handle } = handleFor({
      seek: () =>
        Promise.reject(new Error('page.evaluate: Error: qa.seek(): nothing is loaded (readyState 0).')),
    });
    await expect(handle.seek(5)).rejects.toThrow(/^qa\.seek\(\): nothing is loaded \(readyState 0\)\.$/);
  });
});

describe('PlayerHandle: what the browser console said', () => {
  it('keeps errors, warnings and uncaught page errors, and nothing else', () => {
    const { handle, page } = handleFor();
    const message = (type: string, text: string) => ({
      type: () => type,
      text: () => text,
      location: () => ({ url: 'http://x/a.js', lineNumber: 4 }),
    });
    page.emit('console', message('log', 'hello'));
    page.emit('console', message('warning', 'a warning'));
    page.emit('console', message('error', 'an error'));
    page.emit('console', {
      type: () => 'error',
      text: () => 'no location',
      location: () => ({ url: '', lineNumber: 0 }),
    });
    page.emit('pageerror', new Error('Uncaught TypeError: x is not a function'));
    expect(handle.consoleEntries()).toStrictEqual([
      { type: 'warning', text: 'a warning', location: 'http://x/a.js:4' },
      { type: 'error', text: 'an error', location: 'http://x/a.js:4' },
      { type: 'error', text: 'no location' },
      { type: 'pageerror', text: 'Uncaught TypeError: x is not a function' },
    ]);
  });

  it('keeps the last 200 entries of a page that never stops complaining', () => {
    const { handle, page } = handleFor();
    for (let i = 0; i < 250; i++) page.emit('pageerror', new Error(`error ${i}`));
    const entries = handle.consoleEntries();
    expect(entries).toHaveLength(200);
    expect(entries[0]?.text).toBe('error 50');
    expect(entries[199]?.text).toBe('error 249');
  });
});
