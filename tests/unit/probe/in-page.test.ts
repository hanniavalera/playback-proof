import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { collectBrowserFacts, probeInPage } from '../../../src/lab/probe/in-page.ts';
import type { InPageOutcome, InPageSpec } from '../../../src/lab/probe/in-page.ts';

// The in-page probe is serialised into a browser by Playwright, so these tests evaluate its SOURCE TEXT in a bare vm context
// that contains nothing but a fake DOM: a reference to a module-level helper or import would be a ReferenceError there, exactly
// as it would be in a page. The fake engine scripts the behaviours the real engines showed (an append error followed by a
// media element error, play() rejecting, a pipeline that never answers) and the tests check the stage each one is reported in.

interface Scenario {
  hasMediaSource?: boolean;
  unsupportedTypes?: string[];
  /** The SourceBuffer errors on append; the element's own error event follows one task later (as in real engines). */
  appendError?: boolean;
  appendNeverFinishes?: boolean;
  sourceopenNeverFires?: boolean;
  /** play() rejects like Linux WebKit does: NotSupportedError while the element carries MediaError 4. */
  playRejects?: boolean;
  /** The element errors after the append stage (a decode error mid-playback). */
  elementErrorWhilePlaying?: boolean;
  timeAdvances?: boolean;
  presentFrames?: boolean;
  frameApi?: 'callback' | 'quality' | 'none';
  fetchStatus?: number;
}

const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
});

function createEnvironment(scenario: Scenario) {
  const log: string[] = [];
  const frameApi = scenario.frameApi ?? 'callback';
  const mediaSources = new Map<string, FakeMediaSource>();
  let nextBlob = 0;

  class FakeSourceBuffer extends EventTarget {
    constructor(
      readonly type: string,
      private readonly video: FakeVideo,
    ) {
      super();
    }
    appendBuffer(): void {
      log.push(`append ${this.type}`);
      if (scenario.appendNeverFinishes) return;
      setTimeout(() => {
        if (scenario.appendError) {
          this.dispatchEvent(new Event('error'));
          setTimeout(() => {
            this.video.error = { code: 4, message: 'Failed to push buffer' };
            this.video.dispatchEvent(new Event('error'));
          }, 0);
        } else {
          this.dispatchEvent(new Event('updateend'));
        }
      }, 0);
    }
  }

  class FakeMediaSource extends EventTarget {
    static isTypeSupported(type: string): boolean {
      return !scenario.unsupportedTypes?.includes(type);
    }
    constructor() {
      super();
      log.push('new MediaSource');
    }
    addSourceBuffer(type: string): FakeSourceBuffer {
      log.push(`addSourceBuffer ${type}`);
      if (scenario.unsupportedTypes?.includes(type)) {
        throw Object.assign(new Error('The operation is not supported.'), { name: 'NotSupportedError' });
      }
      return new FakeSourceBuffer(type, video);
    }
    endOfStream(): void {
      log.push('endOfStream');
    }
  }

  class FakeVideo extends EventTarget {
    muted = false;
    playsInline = false;
    disableRemotePlayback = false;
    preload = '';
    error: { code: number; message: string } | null = null;
    currentTime = 0;
    videoWidth = 0;
    private frameCallbacks: Array<(now: number, metadata: { presentedFrames: number }) => void> = [];
    private frames = 0;
    requestVideoFrameCallback?: (
      callback: (now: number, metadata: { presentedFrames: number }) => void,
    ) => number;
    getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };

    constructor() {
      super();
      if (frameApi === 'callback') {
        this.requestVideoFrameCallback = (callback) => this.frameCallbacks.push(callback);
      } else if (frameApi === 'quality') {
        this.getVideoPlaybackQuality = () => ({ totalVideoFrames: this.frames, droppedVideoFrames: 0 });
      }
    }
    set src(value: string) {
      log.push(`src ${value.startsWith('blob:') ? 'blob' : value}`);
      const mediaSource = mediaSources.get(value);
      if (mediaSource && !scenario.sourceopenNeverFires) {
        setTimeout(() => mediaSource.dispatchEvent(new Event('sourceopen')), 0);
      }
    }
    remove(): void {}
    async play(): Promise<void> {
      log.push('play');
      if (scenario.playRejects) {
        this.error = { code: 4, message: 'Failed to push buffer' };
        throw Object.assign(new Error('The operation is not supported.'), { name: 'NotSupportedError' });
      }
      if (scenario.elementErrorWhilePlaying) {
        setTimeout(() => {
          this.error = { code: 3, message: 'decode error' };
          this.dispatchEvent(new Event('error'));
        }, 15);
      }
      timers.push(
        setInterval(() => {
          if (scenario.timeAdvances !== false) {
            this.currentTime += 0.25;
            this.dispatchEvent(new Event('timeupdate'));
          }
          if (scenario.presentFrames !== false) {
            this.videoWidth = 640;
            this.frames += 8;
            const callbacks = this.frameCallbacks.splice(0);
            for (const callback of callbacks) callback(0, { presentedFrames: this.frames });
          }
        }, 5),
      );
    }
  }

  const video = new FakeVideo();
  const sandbox = {
    __name: <T>(fn: T): T => fn,
    window: { MediaSource: scenario.hasMediaSource === false ? undefined : FakeMediaSource },
    document: { createElement: () => video, body: { appendChild: () => undefined } },
    URL: {
      createObjectURL: (mediaSource: FakeMediaSource): string => {
        const url = `blob:fake-${(nextBlob += 1)}`;
        mediaSources.set(url, mediaSource);
        return url;
      },
    },
    fetch: async (url: string) => {
      log.push(`fetch ${url.split('/').pop()}`);
      const status = scenario.fetchStatus ?? 200;
      return { ok: status === 200, status, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    setTimeout,
    clearTimeout,
  };
  return { sandbox, log, video };
}

const SPEC: InPageSpec = {
  source: {
    kind: 'mse',
    tracks: [
      { type: 'video/mp4; codecs="vp09.00.10.08"', url: 'http://probe/media/v.mp4' },
      { type: 'audio/mp4; codecs="mp4a.40.2"', url: 'http://probe/media/a.mp4' },
    ],
  },
  profile: { muted: true, prefetch: false },
  hasVideo: true,
  thresholdSec: 1,
  minFrames: 5,
  deadlineMs: 300,
};

async function probe(scenario: Scenario = {}, spec: Partial<InPageSpec> = {}) {
  const { sandbox, log, video } = createEnvironment(scenario);
  const fn = runInNewContext(`(${String(probeInPage)})`, sandbox) as (
    s: InPageSpec,
  ) => Promise<InPageOutcome>;
  const outcome = await fn({ ...SPEC, ...spec });
  return { outcome, log, video };
}

describe('probeInPage: a pipeline that works', () => {
  it('passes when media time passes the threshold and frames were presented', async () => {
    const { outcome } = await probe();
    expect(outcome.ok).toBe(true);
    expect(outcome.currentTime).toBeGreaterThanOrEqual(1);
    expect(outcome.framesPresented).toBeGreaterThanOrEqual(5);
    expect(outcome).not.toHaveProperty('stage');
    expect(outcome).not.toHaveProperty('error');
  });

  it('adds every SourceBuffer before the first append, and fetches only after they exist (like a player)', async () => {
    const { log } = await probe();
    expect(log.filter((entry) => !entry.startsWith('src'))).toEqual([
      'new MediaSource',
      'addSourceBuffer video/mp4; codecs="vp09.00.10.08"',
      'addSourceBuffer audio/mp4; codecs="mp4a.40.2"',
      'fetch v.mp4',
      'fetch a.mp4',
      'append video/mp4; codecs="vp09.00.10.08"',
      'append audio/mp4; codecs="mp4a.40.2"',
      'endOfStream',
      'play',
    ]);
  });

  it('can prefetch: the data is fetched before the MediaSource exists', async () => {
    const { log, outcome } = await probe({}, { profile: { muted: true, prefetch: true } });
    expect(outcome.ok).toBe(true);
    expect(log.indexOf('fetch a.mp4')).toBeLessThan(log.indexOf('new MediaSource'));
  });

  it('mutes the element only when the profile says so', async () => {
    expect((await probe()).video.muted).toBe(true);
    expect((await probe({}, { profile: { muted: false, prefetch: false } })).video.muted).toBe(false);
  });

  it('does not require frames for audio-only sources', async () => {
    const { outcome } = await probe(
      { presentFrames: false },
      {
        hasVideo: false,
        source: {
          kind: 'mse',
          tracks: [{ type: 'audio/webm; codecs="opus"', url: 'http://probe/media/a.webm' }],
        },
      },
    );
    expect(outcome.ok).toBe(true);
  });

  it('counts frames with getVideoPlaybackQuality where requestVideoFrameCallback is missing', async () => {
    const { outcome } = await probe({ frameApi: 'quality' });
    expect(outcome.ok).toBe(true);
    expect(outcome.framesPresented).toBeGreaterThanOrEqual(5);
  });

  it('plays a control as a plain element source, without any MediaSource', async () => {
    const { outcome, log } = await probe(
      {},
      { source: { kind: 'native', url: 'http://probe/media/v.mp4' }, hasVideo: true },
    );
    expect(outcome.ok).toBe(true);
    expect(log).toContain('src http://probe/media/v.mp4');
    expect(log).not.toContain('new MediaSource');
  });
});

describe('probeInPage: where each failure is reported', () => {
  it("reports an unsupported type at addSourceBuffer with the engine's own error", async () => {
    const { outcome } = await probe({ unsupportedTypes: ['audio/mp4; codecs="mp4a.40.2"'] });
    expect(outcome).toMatchObject({
      ok: false,
      stage: 'addSourceBuffer',
      error: 'NotSupportedError: The operation is not supported.',
    });
  });

  it('reports a missing MediaSource at setup', async () => {
    const { outcome } = await probe({ hasMediaSource: false });
    expect(outcome).toMatchObject({ ok: false, stage: 'setup' });
    expect(outcome.error).toContain('neither MediaSource nor ManagedMediaSource');
  });

  it('reports a failed fetch at fetch, with the status', async () => {
    const { outcome } = await probe({ fetchStatus: 404 });
    expect(outcome).toMatchObject({ ok: false, stage: 'fetch' });
    expect(outcome.error).toContain('HTTP 404');
  });

  it('reports a SourceBuffer error at append and still picks up the element error that follows it', async () => {
    const { outcome } = await probe({ appendError: true });
    expect(outcome).toMatchObject({
      ok: false,
      stage: 'append',
      error: 'Error: SourceBuffer error event',
      mediaError: { code: 4, message: 'Failed to push buffer' },
    });
  });

  it('reports play() rejecting (the Linux WebKit signature) at play, with the media element error attached', async () => {
    const { outcome } = await probe({ playRejects: true });
    expect(outcome).toMatchObject({
      ok: false,
      stage: 'play',
      error: 'NotSupportedError: The operation is not supported.',
      mediaError: { code: 4, message: 'Failed to push buffer' },
    });
    expect(outcome.currentTime).toBe(0);
  });

  it('ends the attempt at once on an element error during playback, in the stage playback was in', async () => {
    const started = Date.now();
    const { outcome } = await probe(
      { elementErrorWhilePlaying: true, timeAdvances: false },
      { deadlineMs: 5000 },
    );
    expect(outcome).toMatchObject({ ok: false, stage: 'currentTime', error: 'MediaError 3: decode error' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a pipeline that never opens at sourceopen, after the safety-net deadline', async () => {
    const { outcome } = await probe({ sourceopenNeverFires: true });
    expect(outcome).toMatchObject({ ok: false, stage: 'sourceopen', error: 'timeout after 300 ms' });
  });

  it('reports an append that never finishes at append', async () => {
    const { outcome } = await probe({ appendNeverFinishes: true });
    expect(outcome).toMatchObject({ ok: false, stage: 'append', error: 'timeout after 300 ms' });
  });

  it('reports media time that never advances at currentTime', async () => {
    const { outcome } = await probe({ timeAdvances: false });
    expect(outcome).toMatchObject({ ok: false, stage: 'currentTime' });
  });

  it('reports time that advances without a presented frame at frames (audio would have passed)', async () => {
    const { outcome } = await probe({ presentFrames: false });
    expect(outcome).toMatchObject({ ok: false, stage: 'frames' });
    expect(outcome.currentTime).toBeGreaterThanOrEqual(1);
    expect(outcome.framesPresented).toBe(0);
  });
});

describe('collectBrowserFacts', () => {
  function facts(options: { throws?: boolean; mediaSource?: boolean }) {
    class FakeMediaSource {
      static isTypeSupported(type: string): boolean {
        if (options.throws) throw new Error('boom');
        return type.startsWith('video/mp4');
      }
    }
    const sandbox = {
      __name: <T>(fn: T): T => fn,
      window: options.mediaSource === false ? {} : { MediaSource: FakeMediaSource },
      document: {
        createElement: () => ({ canPlayType: (type: string) => (type.includes('apple') ? 'maybe' : '') }),
      },
      navigator: { userAgent: 'Fixture/1.0' },
      HTMLVideoElement: { prototype: { requestVideoFrameCallback() {}, getVideoPlaybackQuality() {} } },
    };
    const fn = runInNewContext(`(${String(collectBrowserFacts)})`, sandbox) as typeof collectBrowserFacts;
    return fn(['video/mp4; codecs="avc1.42E01E"', 'audio/webm; codecs="opus"']);
  }

  it('reports the claims, the native HLS answers and the available APIs', () => {
    expect(facts({})).toEqual({
      userAgent: 'Fixture/1.0',
      mediaSource: 'MediaSource',
      typeSupported: { 'video/mp4; codecs="avc1.42E01E"': true, 'audio/webm; codecs="opus"': false },
      canPlayType: { 'application/vnd.apple.mpegurl': 'maybe', 'application/x-mpegURL': '' },
      requestVideoFrameCallback: true,
      getVideoPlaybackQuality: true,
    });
  });

  it('records null (no answer) when the engine has no MediaSource or isTypeSupported throws', () => {
    expect(facts({ mediaSource: false })).toMatchObject({
      mediaSource: 'none',
      typeSupported: { 'audio/webm; codecs="opus"': null },
    });
    expect(facts({ throws: true }).typeSupported).toEqual({
      'video/mp4; codecs="avc1.42E01E"': null,
      'audio/webm; codecs="opus"': null,
    });
  });
});
