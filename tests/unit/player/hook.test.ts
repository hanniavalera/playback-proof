import { describe, expect, it } from 'vitest';
import { PlayerHook } from '../../../src/player/hook.ts';
import type { PlayerEnvironment } from '../../../src/player/hook.ts';
import type { ShakaConfigPatch } from '../../../src/player/configs.ts';
import { PARAM_DEFAULTS } from '../../../src/player/params.ts';
import type { ResolvedPlayerParams } from '../../../src/player/params.ts';
import { FakeClock } from './fake-clock.ts';
import { FakePlayer, FakeVideo } from './fakes.ts';
import { settle, track } from './helpers.ts';

const URI = '/s/abc/vod-cmaf/dash/manifest.mpd';
const ERROR_NAMES = {
  codes: { BAD_HTTP_STATUS: 1001, VIDEO_ERROR: 3016 },
  categories: { NETWORK: 1, MEDIA: 3 },
};

function environment(player: FakePlayer, supported = true): PlayerEnvironment {
  return {
    player,
    shakaVersion: 'v5.3.3',
    supported,
    errorNames: ERROR_NAMES,
    loadModes: { notLoaded: 1, mediaSource: 2, srcEquals: 3 },
  };
}

interface HarnessOptions {
  params?: Partial<ResolvedPlayerParams>;
  paramProblems?: string[];
  patch?: ShakaConfigPatch;
  supported?: boolean;
  setup?: (player: FakePlayer, video: FakeVideo) => void;
  video?: (video: FakeVideo) => void;
}

/**
 * Builds the hook the way main.ts does: the hook first (so it listens to the element before anything else), then the
 * player inside `boot`.
 */
async function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const video = new FakeVideo();
  options.video?.(video);
  const listenerErrors: unknown[] = [];
  const hook = new PlayerHook({
    video,
    now: clock.now,
    params: { ...PARAM_DEFAULTS, ...options.params },
    paramProblems: options.paramProblems ?? [],
    userAgent: 'fake-agent/1.0',
    timers: clock.timerApi,
    onListenerError: (error) => listenerErrors.push(error),
  });
  let player!: FakePlayer;
  await hook.boot(async () => {
    player = new FakePlayer(video);
    options.setup?.(player, video);
    return environment(player, options.supported ?? true);
  }, options.patch ?? {});
  return { clock, video, player, hook, listenerErrors };
}

const names = (hook: PlayerHook) => hook.events().map((event) => event.name);

const SHAKA_ERROR = {
  severity: 2,
  category: 1,
  code: 1001,
  message: 'Shaka Error 1001',
  data: ['http://127.0.0.1:4640/s/abc/vod-cmaf/seg/v360/3.m4s', 404],
};

describe('boot', () => {
  it('records from the first instant: element events are on the timeline and waitable before the player exists', async () => {
    const clock = new FakeClock();
    const video = new FakeVideo();
    const hook = new PlayerHook({
      video,
      now: clock.now,
      params: PARAM_DEFAULTS,
      userAgent: 'ua',
      timers: clock.timerApi,
    });
    const ready = track(hook.ready);
    const waiting = track(hook.waitFor('playing'));
    video.fire('playing');
    await settle();
    expect(waiting.state).toBe('resolved');
    expect(ready.state).toBe('pending');
    expect(hook.info()).toMatchObject({ supported: false, shakaVersion: '', loadMode: null });

    await hook.boot(async () => environment(new FakePlayer(video)), {});
    await settle();
    expect(ready.state).toBe('resolved');
    expect(hook.info()).toMatchObject({
      supported: true,
      shakaVersion: 'v5.3.3',
      userAgent: 'ua',
      config: 'A',
    });
  });

  it('applies the configuration patch, and reports the exact overrides and what each one replaced', async () => {
    const patch = { abr: { switchInterval: 4 }, streaming: { bufferingGoal: 20 } };
    const { hook, player } = await harness({ params: { config: 'B' }, patch });
    expect(player.configureCalls).toEqual([patch]);
    expect(hook.info()).toMatchObject({
      config: 'B',
      configOverrides: patch,
      configDefaults: { abr: { switchInterval: 8 }, streaming: { bufferingGoal: 10 } },
      configured: [],
    });
  });

  it('configuration A hands nothing to Shaka', async () => {
    const { hook, player } = await harness();
    expect(player.configureCalls).toEqual([]);
    expect(hook.info()).toMatchObject({ config: 'A', configOverrides: {}, configDefaults: {} });
  });

  it('fails boot, loudly, when Shaka rejects the configuration', async () => {
    const clock = new FakeClock();
    const video = new FakeVideo();
    const hook = new PlayerHook({
      video,
      now: clock.now,
      params: PARAM_DEFAULTS,
      userAgent: 'ua',
      timers: clock.timerApi,
    });
    const player = new FakePlayer(video);
    player.rejectConfiguration = true;
    await hook.boot(async () => environment(player), { abr: { switchInterval: 4 } });
    await expect(hook.ready).rejects.toThrow(/rejected the boot configuration/);
    expect(hook.metrics().state).toBe('error');
    expect(hook.metrics().errors[0]).toMatchObject({ code: 0, severity: 2, source: 'boot' });
  });

  it('a factory that throws rejects ready and leaves the failure on the timeline', async () => {
    const clock = new FakeClock();
    const video = new FakeVideo();
    const hook = new PlayerHook({
      video,
      now: clock.now,
      params: PARAM_DEFAULTS,
      userAgent: 'ua',
      timers: clock.timerApi,
    });
    await hook.boot(async () => {
      throw new Error('constructor exploded');
    }, {});
    await expect(hook.ready).rejects.toThrow('constructor exploded');
    expect(hook.metrics().errors).toMatchObject([{ message: 'Error: constructor exploded', source: 'boot' }]);
  });

  it('turns unusable page parameters into error events from index 0, and lists them in info()', async () => {
    const problems = ['muted="yes" is not 1/0 (or true/false): using true'];
    const { hook } = await harness({ paramProblems: problems });
    expect(hook.events()[0]).toMatchObject({
      index: 0,
      name: 'error',
      detail: { code: 0, source: 'params' },
    });
    expect(hook.info().paramProblems).toEqual(problems);
    expect(hook.metrics().errors).toHaveLength(1);
  });

  it('reports the parameters as applied', async () => {
    const { hook } = await harness({
      params: { muted: false, autoplay: false, abr: false, start: 12, config: 'B', hud: true },
    });
    expect(hook.info().params).toEqual({
      config: 'B',
      autoplay: false,
      muted: false,
      start: 12,
      abr: false,
      hud: true,
    });
  });

  it('reports a ClearKey pair when the page was given one, and nothing otherwise', async () => {
    const pair = { keyId: '706c61796261636b70726f6f662d6964', key: '706c61796261636b70726f6f666b6579' };
    const { hook } = await harness({ params: { clearKey: pair } });
    expect(hook.info().params.clearKey).toEqual(pair);
    const { hook: plain } = await harness();
    expect('clearKey' in plain.info().params).toBe(false);
  });

  it('keeps the key out of the timeline even when Shaka rejects the configuration that carries it', async () => {
    const pair = { keyId: '706c61796261636b70726f6f662d6964', key: '706c61796261636b70726f6f666b6579' };
    const clock = new FakeClock();
    const video = new FakeVideo();
    const hook = new PlayerHook({
      video,
      now: clock.now,
      params: { ...PARAM_DEFAULTS, clearKey: pair },
      userAgent: 'ua',
      timers: clock.timerApi,
    });
    const player = new FakePlayer(video);
    player.rejectConfiguration = true;
    await hook.boot(async () => environment(player), { drm: { clearKeys: { [pair.keyId]: pair.key } } });
    await expect(hook.ready).rejects.toThrow(/rejected the boot configuration/);
    const timeline = JSON.stringify(hook.events());
    expect(timeline).toContain('rejected the boot configuration');
    expect(timeline).not.toContain(pair.key);
    expect(timeline).not.toContain(pair.keyId);
  });
});

describe('loading', () => {
  it('records load-requested, manifest-loaded and loaded, and the initial rung as `start`', async () => {
    const { hook } = await harness();
    await hook.load(URI);
    expect(names(hook)).toEqual(['load-requested', 'manifest-loaded', 'loaded', 'variant-changed']);
    expect(hook.events()[0]?.detail).toEqual({ uri: URI });
    expect(hook.events()[3]?.detail).toEqual({
      from: null,
      to: 2,
      bandwidth: 764_000,
      height: 360,
      reason: 'start',
    });
    expect(hook.info().manifestUri).toBe(URI);
  });

  it('passes the start position to Shaka', async () => {
    const { hook, player } = await harness({ params: { start: 12.5 } });
    await hook.load(URI);
    expect(player.loadCalls).toEqual([{ uri: URI, startTime: 12.5 }]);
  });

  it('startup runs from load-requested to the frame callback, not to `playing`', async () => {
    const { hook, video, clock } = await harness();
    await hook.load(URI);
    clock.advance(300);
    await hook.play();
    expect(names(hook)).not.toContain('firstframe');
    expect(hook.metrics().startupMs).toBeNull();
    clock.advance(40);
    video.presentFrame(0.032, 1);
    expect(hook.metrics().startupMs).toBe(340);
    expect(hook.events().find((event) => event.name === 'firstframe')?.detail).toEqual({
      source: 'requestVideoFrameCallback',
    });
  });

  it('records the first frame once, however many frames follow', async () => {
    const { hook, video } = await harness();
    await hook.load(URI);
    for (let i = 0; i < 5; i++) video.presentFrame(i / 32, 10 + i);
    expect(names(hook).filter((name) => name === 'firstframe')).toHaveLength(1);
  });

  it('without requestVideoFrameCallback the first `playing` of the load is the first frame, and presented is unknown', async () => {
    const { hook, video, clock } = await harness({
      video: (v) => {
        v.requestVideoFrameCallback = undefined;
      },
    });
    await hook.load(URI);
    clock.advance(250);
    await hook.play();
    expect(hook.events().find((event) => event.name === 'firstframe')?.detail).toEqual({ source: 'playing' });
    expect(hook.metrics().startupMs).toBe(250);
    expect(hook.metrics().frames.presented).toBeNull();
    video.fire('playing');
    expect(names(hook).filter((name) => name === 'firstframe')).toHaveLength(1);
  });

  it('a second load unloads the first, and is measured on its own', async () => {
    const { hook, video, clock, player } = await harness();
    await hook.load(URI);
    video.presentFrame(0.03, 1);
    clock.advance(5000);
    await hook.load('/s/def/vod-cmaf/dash/manifest.mpd');
    expect(player.unloadCalls).toBe(1);
    expect(names(hook)).toEqual([
      'load-requested',
      'manifest-loaded',
      'loaded',
      'variant-changed',
      'firstframe',
      'unloaded',
      'load-requested',
      'manifest-loaded',
      'loaded',
      'variant-changed',
    ]);
    expect(video.pendingFrameCallbacks).toBe(1); // the first load's callback was cancelled, the second armed
    clock.advance(180);
    video.presentFrame(0.03, 2);
    expect(hook.metrics().startupMs).toBe(180);
    expect(hook.metrics().bitrate.switches).toBe(0);
  });

  it('a load that fails is recorded once, thrown with the code name and the timeline, and puts the player in error', async () => {
    const { hook, video, player } = await harness();
    player.loadError = SHAKA_ERROR;
    await expect(hook.load(URI)).rejects.toThrow(
      /NETWORK\.BAD_HTTP_STATUS.*code 1001, severity 2.*seg\/v360\/3\.m4s/s,
    );
    expect(names(hook)).toEqual(['load-requested', 'error']);
    expect(hook.events()[1]?.detail).toMatchObject({
      code: 1001,
      codeName: 'BAD_HTTP_STATUS',
      source: 'load',
    });
    expect(hook.metrics().state).toBe('error');
    expect(video.pendingFrameCallbacks).toBe(0);
  });

  it('records an error object once even if Shaka dispatched it as an event before load() rejected with it', async () => {
    const { hook, player } = await harness();
    player.loadError = SHAKA_ERROR;
    player.emit('error', { detail: SHAKA_ERROR });
    await expect(hook.load(URI)).rejects.toThrow(/BAD_HTTP_STATUS/);
    expect(names(hook).filter((name) => name === 'error')).toHaveLength(1);
  });

  it('refuses to load without a URI, and where Shaka says the browser is unsupported', async () => {
    const plain = await harness();
    await expect(plain.hook.load()).rejects.toThrow(/no manifest URI/);
    const unsupported = await harness({ supported: false });
    await expect(unsupported.hook.load(URI)).rejects.toThrow(/isBrowserSupported\(\) is false/);
    expect(unsupported.hook.metrics().errors).toMatchObject([{ severity: 2, source: 'load' }]);
  });

  it('loads the URI of the page parameter when called with none', async () => {
    const { hook, player } = await harness({ params: { manifest: URI } });
    await hook.load();
    expect(player.loadCalls[0]?.uri).toBe(URI);
  });

  it('reports how Shaka loaded: media-source, src=, or nothing', async () => {
    const { hook, player } = await harness();
    expect(hook.info().loadMode).toBeNull();
    await hook.load(URI);
    expect(hook.info().loadMode).toBe('media-source');
    player.loadMode = 3;
    expect(hook.info().loadMode).toBe('src=');
    await hook.unload();
    expect(hook.info().loadMode).toBeNull();
  });

  it('unload records `unloaded`, returns the state to idle, and keeps the measurements readable; unloading nothing does nothing', async () => {
    const { hook, video } = await harness();
    await hook.unload();
    expect(names(hook)).toEqual([]);
    await hook.load(URI);
    video.presentFrame(0.03, 1);
    await hook.unload();
    expect(names(hook).at(-1)).toBe('unloaded');
    const metrics = hook.metrics();
    expect(metrics.state).toBe('idle');
    expect(metrics.startupMs).toBe(0);
  });
});

describe('the variants', () => {
  it('records the initial rung once even when Shaka announces it with an adaptation event', async () => {
    const { hook } = await harness({ setup: (player) => (player.announceInitialSelection = true) });
    await hook.load(URI);
    expect(names(hook)).toEqual(['load-requested', 'manifest-loaded', 'variant-changed', 'loaded']);
    expect(hook.events()[2]?.detail).toMatchObject({ reason: 'start', from: null, to: 2 });
  });

  it('an adaptation is `abr`, a variantchanged nobody asked for is `abr` too, and an event that changes nothing records nothing', async () => {
    const { hook, player } = await harness();
    await hook.load(URI);
    for (const track of player.tracks) track.active = track.id === 3;
    player.emit('adaptation');
    player.emit('adaptation');
    // Shaka raises `variantchanged` as well when it moves away from a rung that failed (failover): the page did not ask for it.
    for (const track of player.tracks) track.active = track.id === 1;
    player.emit('variantchanged');
    const changes = hook.events().filter((event) => event.name === 'variant-changed');
    expect(changes.map((event) => event.detail)).toEqual([
      { from: null, to: 2, bandwidth: 764_000, height: 360, reason: 'start' },
      { from: 2, to: 3, bandwidth: 1_864_000, height: 720, reason: 'abr' },
      { from: 3, to: 1, bandwidth: 364_000, height: 240, reason: 'abr' },
    ]);
    expect(hook.metrics().bitrate.switches).toBe(2);
    expect(hook.metrics().bitrate.current).toMatchObject({ id: 1, height: 240, videoCodec: 'vp09.00.10.08' });
  });

  it('only the page`s own selectVariantByHeight is `manual`, and a failover after it is `abr` again', async () => {
    const { hook, player } = await harness();
    await hook.load(URI);
    await hook.selectVariantByHeight(720);
    for (const track of player.tracks) track.active = track.id === 2;
    player.emit('variantchanged');
    const reasons = hook
      .events()
      .filter((event) => event.name === 'variant-changed')
      .map((event) => event.detail?.reason);
    expect(reasons).toEqual(['start', 'manual', 'abr']);
  });

  describe('selectVariantByHeight', () => {
    it('pins the rung, switches ABR off, and resolves when the change is on the timeline', async () => {
      const { hook, player } = await harness();
      await hook.load(URI);
      await hook.selectVariantByHeight(720);
      expect(player.configureCalls).toEqual([{ abr: { enabled: false } }]);
      expect(player.selectCalls).toHaveLength(1);
      expect(player.selectCalls[0]?.track.id).toBe(3);
      expect(hook.events().at(-1)).toMatchObject({
        name: 'variant-changed',
        detail: { to: 3, reason: 'manual' },
      });
      expect(hook.info().configured).toEqual([{ abr: { enabled: false } }]);
    });

    it('flushes the buffer before anything has played, and is seamless afterwards', async () => {
      const { hook, player } = await harness();
      await hook.load(URI);
      await hook.selectVariantByHeight(720);
      await hook.play();
      await hook.selectVariantByHeight(240);
      expect(player.selectCalls.map((call) => call.clearBuffer)).toEqual([true, false]);
      expect(player.selectCalls.map((call) => call.safeMargin)).toEqual([0, 0]);
    });

    it('resolves at once when that rung is already active, because Shaka would announce nothing', async () => {
      const { hook, player } = await harness();
      await hook.load(URI);
      await hook.selectVariantByHeight(360);
      expect(player.selectCalls).toEqual([]);
    });

    it('names the heights that exist when none matches, and says when there are no tracks at all', async () => {
      const { hook, player } = await harness();
      await hook.load(URI);
      await expect(hook.selectVariantByHeight(1080)).rejects.toThrow('Heights available: 240, 360, 720');
      player.tracks = [];
      await expect(hook.selectVariantByHeight(720)).rejects.toThrow('none (is a manifest loaded?)');
    });

    it('null gives ABR back', async () => {
      const { hook, player } = await harness();
      await hook.selectVariantByHeight(null);
      expect(player.configureCalls).toEqual([{ abr: { enabled: true } }]);
    });
  });

  it('configure and setAbr pass through and are recorded; a rejected configuration throws and is not recorded', async () => {
    const { hook, player } = await harness();
    hook.configure({ streaming: { bufferingGoal: 30 } });
    hook.setAbr(false);
    expect(hook.info().configured).toEqual([
      { streaming: { bufferingGoal: 30 } },
      { abr: { enabled: false } },
    ]);
    player.rejectConfiguration = true;
    expect(() => hook.configure({ abr: { switchIntervall: 1 } })).toThrow(
      /rejected by Shaka.*switchIntervall/,
    );
    expect(hook.info().configured).toHaveLength(2);
  });
});

describe('actions', () => {
  async function playing() {
    const h = await harness();
    await h.hook.load(URI);
    await h.hook.play();
    h.video.presentFrame(0.03, 1);
    return h;
  }

  it("records the element's `seeking` before the Shaka `buffering` it causes, so the seek window holds", async () => {
    const { hook } = await playing();
    const cursor = hook.cursor();
    await hook.seek(10);
    expect(
      hook
        .events()
        .slice(cursor)
        .map((event) => event.name),
    ).toEqual(['seeking', 'buffering-start', 'seeked', 'buffering-end']);
    expect(hook.metrics().rebuffer.count).toBe(0);
  });

  it('seek resolves on the seeked that follows its own seeking, and marks the seek as asked for', async () => {
    const { hook, video } = await playing();
    await hook.seek(10);
    const seeking = hook.events().findLast((event) => event.name === 'seeking');
    expect(seeking?.detail).toMatchObject({ to: 10, requested: true });
    expect(video.currentTime).toBe(10);
    video.currentTime = 20; // not through the hook
    await settle();
    expect(hook.events().findLast((event) => event.name === 'seeking')?.detail).toMatchObject({
      to: 20,
      requested: false,
    });
  });

  it('seek rejects with the timeline when the browser never completes it', async () => {
    const { hook, video, clock } = await playing();
    video.autoSeek = false;
    const seeking = track(hook.seek(5));
    await settle();
    video.fire('seeking');
    await settle();
    expect(seeking.state).toBe('pending');
    clock.advance(20_000);
    await settle();
    expect(seeking.state).toBe('rejected');
    expect(seeking.error?.message).toContain("qa.waitFor('seeked') timed out after 20000 ms");
    expect(seeking.error?.message).toContain('seeking');
  });

  it('seek refuses a bad target and an empty element at once', async () => {
    const { hook, video } = await playing();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(hook.seek(bad)).rejects.toThrow(RangeError);
    }
    video.readyState = 0;
    await expect(hook.seek(3)).rejects.toThrow(/nothing is loaded/);
  });

  it('does not let a seek mark leak when the browser fires no seeking', async () => {
    const { hook, video, clock } = await playing();
    video.autoSeek = false;
    const lost = track(hook.seek(5));
    await settle();
    clock.advance(20_000);
    await settle();
    expect(lost.state).toBe('rejected');
    video.autoSeek = true;
    video.currentTime = 7; // a seek the player made on its own
    await settle();
    expect(hook.events().findLast((event) => event.name === 'seeking')?.detail).toMatchObject({
      requested: false,
    });
  });

  it('play resolves once `playing` is recorded; a rejection is recorded and thrown with the timeline', async () => {
    const { hook, video } = await harness();
    await hook.play();
    expect(names(hook)).toEqual(['playing']);
    video.playError = new DOMException('play() failed because the user did not interact', 'NotAllowedError');
    await expect(hook.play()).rejects.toThrow(/qa\.play\(\) was rejected: NotAllowedError.*#0/s);
    expect(hook.metrics().errors).toMatchObject([
      {
        code: 0,
        codeName: 'NotAllowedError',
        source: 'play',
        message: expect.stringContaining('NotAllowedError'),
      },
    ]);
  });

  it('names a refused play() by its DOMException name, and leaves a plain Error without a code name', async () => {
    const { hook, video } = await harness();
    video.playError = new Error('boom');
    await expect(hook.play()).rejects.toThrow(/qa\.play\(\) was rejected: Error: boom/);
    video.playError = new DOMException('not supported', 'NotSupportedError');
    await expect(hook.play()).rejects.toThrow(/NotSupportedError/);
    const errors = hook.metrics().errors;
    expect(errors[0]).not.toHaveProperty('codeName');
    expect(errors[1]).toMatchObject({ codeName: 'NotSupportedError', source: 'play' });
  });

  it('pause resolves on `paused`, and returns at once when already paused', async () => {
    const { hook, video } = await harness();
    await hook.pause();
    expect(video.paused).toBe(true);
    expect(names(hook)).toEqual([]);
    await hook.play();
    await hook.pause();
    expect(names(hook)).toEqual(['playing', 'paused']);
  });

  it('waitForMediaTime is driven by timeupdate and by frame callbacks', async () => {
    const { hook, video } = await harness();
    await hook.load(URI);
    const byTimeupdate = track(hook.waitForMediaTime(2));
    video.advanceTo(1.9);
    await settle();
    expect(byTimeupdate.state).toBe('pending');
    video.advanceTo(2.1);
    await settle();
    expect(byTimeupdate.value).toBe(2.1);

    const byFrame = track(hook.waitForMediaTime(3));
    video.presentFrame(3.02, 1);
    await settle();
    expect(byFrame.value).toBe(3.02);
  });
});

describe('errors', () => {
  it('a Shaka error becomes an error event with the code name, a digest of its data, and severity', async () => {
    const { hook, player } = await harness();
    await hook.load(URI);
    player.emit('error', { detail: SHAKA_ERROR });
    expect(hook.events().at(-1)).toMatchObject({
      name: 'error',
      detail: {
        code: 1001,
        codeName: 'BAD_HTTP_STATUS',
        category: 1,
        severity: 2,
        source: 'shaka',
        message: 'NETWORK.BAD_HTTP_STATUS: Shaka Error 1001',
        data: ['http://127.0.0.1:4640/s/abc/vod-cmaf/seg/v360/3.m4s', 404],
      },
    });
    expect(hook.metrics().state).toBe('error');
  });

  it('a recoverable error leaves the player playing', async () => {
    const { hook, player } = await harness();
    await hook.load(URI);
    await hook.play();
    player.emit('error', { detail: { ...SHAKA_ERROR, severity: 1 } });
    expect(hook.metrics().state).toBe('playing');
    expect(hook.metrics().errors).toHaveLength(1);
  });

  it("Shaka's silent MediaSource recovery is on the timeline as a recoverable error", async () => {
    const { hook, player } = await harness();
    await hook.load(URI);
    player.emit('mediasourcerecovered');
    expect(hook.metrics().errors).toMatchObject([
      { code: 0, codeName: 'MEDIA_SOURCE_RECOVERED', severity: 1, source: 'shaka' },
    ]);
  });

  it('the page records its own exceptions and unhandled rejections as code 0', async () => {
    const { hook } = await harness();
    hook.recordPageError('window.onerror', new TypeError('x is not a function'));
    hook.recordPageError('unhandledrejection', 'plain string reason');
    expect(hook.metrics().errors).toMatchObject([
      { code: 0, severity: 1, source: 'window.onerror', message: 'TypeError: x is not a function' },
      { code: 0, severity: 1, source: 'unhandledrejection', message: 'plain string reason' },
    ]);
    expect(hook.metrics().state).toBe('idle');
  });
});

describe('live', () => {
  async function liveHarness() {
    const h = await harness({ setup: (player) => (player.live = true) });
    await h.hook.load(URI);
    h.video.advanceTo(100);
    h.video.presentFrame(100, 1); // the first frame arms the latency maximum
    return h;
  }

  it('measures the distance to the newest published segment, its maximum since the first frame, and the delay', async () => {
    const { hook, video, player } = await liveHarness();
    video.advanceTo(100);
    expect(hook.metrics().live).toEqual({
      isLive: true,
      latencyMs: 6000,
      latencyMaxMs: 6000,
      presentationDelayMs: 6000,
      edgeSeeks: 0,
    });
    player.availabilityEnd = 111; // the edge moves 5 s while the playhead moves 1 s
    video.advanceTo(101);
    player.availabilityEnd = 112; // the player catches up: playhead 108
    video.advanceTo(108);
    expect(hook.metrics().live).toMatchObject({ latencyMs: 4000, latencyMaxMs: 10_000 });
  });

  it("asks Shaka for its manifest once per load, not at every sample: getManifest() logs a warning each time (found in WebKit's console)", async () => {
    const { hook, video, player } = await liveHarness();
    for (let t = 100; t < 105; t += 0.25) video.advanceTo(t);
    hook.metrics();
    hook.metrics();
    expect(player.manifestCalls).toBe(1);
    await hook.load(URI); // a new load is a new presentation
    video.advanceTo(100);
    hook.metrics();
    expect(player.manifestCalls).toBe(2);
  });

  it('is null for VOD, with no delay', async () => {
    const { hook, video } = await harness();
    await hook.load(URI);
    video.presentFrame(0.03, 1);
    expect(hook.metrics().live).toEqual({
      isLive: false,
      latencyMs: null,
      latencyMaxMs: null,
      presentationDelayMs: null,
      edgeSeeks: 0,
    });
  });

  it('counts a forward jump to the edge that nobody asked for, and not the ones the viewer asked for', async () => {
    const { hook, video, player } = await liveHarness();
    const cursor = hook.cursor();
    player.seekEnd = 117;
    video.currentTime = 116; // the player jumps by itself
    await settle();
    expect(
      hook
        .events()
        .slice(cursor)
        .map((event) => event.name),
    ).toEqual(['seeking', 'live-edge-seek', 'buffering-start', 'seeked', 'buffering-end']);
    expect(hook.events()[cursor + 1]?.detail).toEqual({ from: 100, to: 116, jumpSec: 16 });
    expect(hook.metrics().live.edgeSeeks).toBe(1);

    await hook.seekToLiveEdge();
    expect(player.goToLiveCalls).toBe(1);
    expect(hook.metrics().live.edgeSeeks).toBe(1);
  });

  it('measures the jump from the position before the seek, even if a timeupdate fires after the assignment and before `seeking`', async () => {
    const { hook, video, player } = await liveHarness();
    player.seekEnd = 117;
    video.currentTime = 116; // `currentTime` already reads 116 and video.seeking is true
    video.fire('timeupdate');
    await settle();
    expect(hook.metrics().live.edgeSeeks).toBe(1);
  });

  it('does not count the positioning before the first frame', async () => {
    const { hook, video, player } = await harness({ setup: (p) => (p.live = true) });
    await hook.load(URI);
    player.seekEnd = 117;
    video.currentTime = 116;
    await settle();
    expect(hook.metrics().live.edgeSeeks).toBe(0);
  });

  it('seekToLiveEdge refuses a VOD presentation', async () => {
    const { hook } = await harness();
    await hook.load(URI);
    await expect(hook.seekToLiveEdge()).rejects.toThrow(/not live/);
  });
});

describe('metrics()', () => {
  it('assembles the element snapshot, the frame counters and the active variant', async () => {
    const { hook, video } = await harness();
    await hook.load(URI);
    await hook.play();
    video.buffered = { length: 1, start: () => 0, end: () => 12 };
    video.totalVideoFrames = 200;
    video.droppedVideoFrames = 3;
    for (let i = 0; i < 3; i++) video.presentFrame(5 + i / 32, 700 + i);
    video.advanceTo(5);
    const metrics = hook.metrics();
    expect(metrics.playback).toEqual({
      currentTime: 5,
      duration: 60,
      paused: false,
      ended: false,
      playbackRate: 1,
      bufferedAheadSec: 7,
      readyState: 4,
    });
    expect(metrics.frames).toEqual({ decoded: 200, dropped: 3, droppedRatio: 0.015, presented: 3 });
    expect(metrics.bitrate.current).toMatchObject({ id: 2, height: 360, width: 640 });
    expect(metrics.state).toBe('playing');
  });

  it('reports a stall that is still going on, with the duration so far', async () => {
    const { hook, video, player, clock } = await harness();
    await hook.load(URI);
    await hook.play();
    video.presentFrame(0.03, 1);
    clock.advance(1000);
    player.emit('buffering', { buffering: true });
    clock.advance(700);
    expect(hook.metrics().rebuffer).toMatchObject({ count: 1, totalMs: 700, events: [{ ongoing: true }] });
    expect(hook.metrics().state).toBe('buffering');
    clock.advance(300);
    player.emit('buffering', { buffering: false });
    expect(hook.metrics().rebuffer).toMatchObject({ count: 1, totalMs: 1000, events: [{ ongoing: false }] });
  });
});

describe('measureFrames', () => {
  const FRAME = 1 / 32; // exact in binary, so the window completes on the frame it should

  async function measuring() {
    const h = await harness();
    await h.hook.load(URI);
    h.video.presentFrame(10, 300); // the first frame of the load
    return h;
  }

  it('counts the frames presented while the media clock advances by the window, and the decoded and dropped of that window', async () => {
    const { hook, video } = await measuring();
    video.totalVideoFrames = 300;
    video.droppedVideoFrames = 1;
    const result = hook.measureFrames(1);
    for (let i = 0; i <= 32; i++) {
      video.totalVideoFrames += 1;
      if (i === 5) video.droppedVideoFrames += 1;
      video.presentFrame(10 + i * FRAME, 301 + i);
    }
    await expect(result).resolves.toEqual({
      presented: 32,
      decoded: 32,
      dropped: 1,
      mediaSeconds: 1,
      fps: 32,
    });
    expect(video.pendingFrameCallbacks).toBe(1); // only the page's own frame loop is left
  });

  it('rejects, with the timeline, when frames stop arriving: a stall during the window is reported', async () => {
    const { hook, video, clock } = await measuring();
    const result = track(hook.measureFrames(5, { stallTimeoutMs: 2000 }));
    for (let i = 0; i < 3; i++) video.presentFrame(10 + i * FRAME, 301 + i);
    clock.advance(1999);
    await settle();
    expect(result.state).toBe('pending');
    clock.advance(1);
    await settle();
    expect(result.state).toBe('rejected');
    expect(result.error?.message).toMatch(/no video frame for 2000 ms.*readyState 4/s);
    expect(video.pendingFrameCallbacks).toBe(1);
  });

  it('rejects when the media clock jumps inside the window, because the number would mean nothing', async () => {
    const { hook, video } = await measuring();
    const result = hook.measureFrames(5);
    video.presentFrame(10 + FRAME, 301);
    video.presentFrame(40, 302);
    await expect(result).rejects.toThrow(/media clock jumped from 10\.031 s to 40\.000 s/);
  });

  it('with no frame callbacks it reports decoded and dropped, but no presented count and no fps', async () => {
    const { hook, video } = await harness({
      video: (v) => {
        v.requestVideoFrameCallback = undefined;
      },
    });
    await hook.load(URI);
    video.totalVideoFrames = 10;
    const result = hook.measureFrames(1);
    video.advanceTo(10);
    video.totalVideoFrames = 40;
    video.advanceTo(11);
    await expect(result).resolves.toMatchObject({
      presented: null,
      fps: null,
      decoded: 30,
      dropped: 0,
      mediaSeconds: 1,
    });
  });

  it('refuses a window or a timeout that is not a positive number', async () => {
    const { hook } = await measuring();
    await expect(hook.measureFrames(0)).rejects.toThrow(RangeError);
    await expect(hook.measureFrames(1, { stallTimeoutMs: 0 })).rejects.toThrow(RangeError);
  });
});

describe('destroy', () => {
  it('fails the pending waits with the timeline, stops recording, and refuses further actions', async () => {
    const { hook, video, player } = await harness();
    await hook.load(URI);
    const pending = track(hook.waitFor('ended'));
    await hook.destroy();
    expect(player.destroyCalls).toBe(1);
    expect(pending.state).toBe('rejected');
    expect(pending.error?.message).toContain('aborted, the player page was destroyed');
    const before = hook.events().length;
    expect(names(hook).at(-1)).toBe('unloaded');
    video.fire('playing');
    player.emit('buffering', { buffering: true });
    expect(hook.events()).toHaveLength(before);
    await expect(hook.load(URI)).rejects.toThrow(/destroyed/);
    await hook.destroy();
    expect(player.destroyCalls).toBe(1);
  });

  it('can be called before the player is built', async () => {
    const clock = new FakeClock();
    const video = new FakeVideo();
    const hook = new PlayerHook({
      video,
      now: clock.now,
      params: PARAM_DEFAULTS,
      userAgent: 'ua',
      timers: clock.timerApi,
    });
    const destroyed = track(hook.destroy());
    await settle();
    await hook.boot(async () => environment(new FakePlayer(video)), {});
    await settle();
    expect(destroyed.state).toBe('resolved');
  });
});
