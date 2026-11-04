import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BINDING,
  DOCUMENTED_DECRYPTOR,
  decryptorOf,
  describeDecryptor,
  installEmeWatch,
  isProtectedInit,
  summarize,
} from '../../e2e/eme/evidence.ts';
import type { EmeEvidence, EmeNote } from '../../e2e/eme/evidence.ts';

const base64 = (text: string): string => Buffer.from(text, 'latin1').toString('base64');

// What reaches MSE in Chromium and Firefox: the sample entry is still encrypted, and `frma` inside `sinf` still names the real format.
const PROTECTED_INIT = '....ftypisom....moov....encv....sinf....frma' + 'vp09' + '....schm....tenc';
// What Shaka hands to MSE after its own decryption: the entry renamed to the real format, `sinf` overwritten with a `free` box.
const STRIPPED_INIT = '....ftypisom....moov....vp09....free\u0000\u0000\u0000\u0000\u0000\u0000';

describe('isProtectedInit', () => {
  it('is true while the sample entry says encv or enca: the CDM of the browser has something to decrypt', () => {
    expect(isProtectedInit(base64(PROTECTED_INIT))).toBe(true);
    expect(isProtectedInit(base64('....moov....enca....sinf'))).toBe(true);
  });

  it('is false once the player has put the real format back and removed sinf, although vp09 is still in the bytes', () => {
    expect(isProtectedInit(base64(STRIPPED_INIT))).toBe(false);
    expect(isProtectedInit(base64('....moov....mp4a....'))).toBe(false);
  });

  it('is false for nothing', () => {
    expect(isProtectedInit('')).toBe(false);
  });
});

describe('summarize: the notes of a page as evidence', () => {
  const notes: EmeNote[] = [
    { kind: 'session-request', initDataType: 'keyids' },
    { kind: 'license-update', bytes: 84 },
    { kind: 'init-segment', head: base64(PROTECTED_INIT) },
    { kind: 'key-status', status: 'usable' },
    { kind: 'init-segment', head: base64(PROTECTED_INIT) },
    { kind: 'key-status', status: 'usable' },
    { kind: 'key-status', status: 'output-restricted' },
  ];

  it('counts the licenses, keeps the sessions and the statuses (each once, in order of appearance) and classifies every init segment', () => {
    expect(summarize(notes)).toEqual({
      sessionRequests: ['keyids'],
      licenseUpdates: 1,
      keyStatuses: ['usable', 'output-restricted'],
      initSegments: [{ protected: true }, { protected: true }],
    });
  });

  it('is empty for a page that did nothing', () => {
    expect(summarize([])).toEqual({
      sessionRequests: [],
      licenseUpdates: 0,
      keyStatuses: [],
      initSegments: [],
    });
  });
});

describe('decryptorOf: who decrypts, from what reached MSE', () => {
  const evidence = (...initSegments: boolean[]): EmeEvidence => ({
    sessionRequests: [],
    licenseUpdates: 0,
    keyStatuses: [],
    initSegments: initSegments.map((protectedInit) => ({ protected: protectedInit })),
  });

  it('is the browser when every init segment was still protected, the player when none was', () => {
    expect(decryptorOf(evidence(true, true))).toBe('browser');
    expect(decryptorOf(evidence(false, false))).toBe('player');
  });

  it('is mixed when the stream changed halfway, and none when nothing was appended: a missing observation is not a pass', () => {
    expect(decryptorOf(evidence(true, false))).toBe('mixed');
    expect(decryptorOf(evidence())).toBe('none');
  });

  it('has a sentence for each, and the documented table only uses decryptors that exist', () => {
    for (const decryptor of ['browser', 'player', 'mixed', 'none'] as const) {
      expect(describeDecryptor(decryptor).length).toBeGreaterThan(10);
    }
    expect(Object.values(DOCUMENTED_DECRYPTOR).every((d) => d === 'browser' || d === 'player')).toBe(true);
    expect(DOCUMENTED_DECRYPTOR).toEqual({ chromium: 'browser', firefox: 'browser', webkit: 'player' });
  });
});

// The init script is plain browser code that Playwright serialises, so it is tested here by running the same function against
// fakes of the three browser classes it wraps.
describe('installEmeWatch, run against fakes of what it wraps', () => {
  class FakeSourceBuffer {
    readonly appended: unknown[] = [];
    appendBuffer(data: unknown): void {
      this.appended.push(data);
    }
  }
  class FakeSession {
    readonly keyStatuses = new Map<string, string>();
    readonly requests: unknown[][] = [];
    readonly updates: unknown[] = [];
    private readonly listeners = new Map<string, Array<() => void>>();
    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    fire(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
    generateRequest(type: string, data: unknown): Promise<void> {
      this.requests.push([type, data]);
      return Promise.resolve();
    }
    update(response: unknown): Promise<void> {
      this.updates.push(response);
      return Promise.resolve();
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Installs the watch over fresh fakes (each call wraps the prototypes once) and returns what the page reported. */
  function install(binding?: (note: unknown) => unknown, headBytes = 64) {
    const notes: EmeNote[] = [];
    vi.stubGlobal('window', {
      [BINDING]:
        binding ??
        ((note: EmeNote) => {
          notes.push(note);
          return Promise.resolve();
        }),
    });
    class Buffers extends FakeSourceBuffer {}
    class Sessions extends FakeSession {}
    vi.stubGlobal('SourceBuffer', Buffers);
    vi.stubGlobal('MediaKeySession', Sessions);
    installEmeWatch({ binding: BINDING, headBytes });
    return { notes, buffer: new Buffers(), session: new Sessions() };
  }

  const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'));

  it('reports the head of an init segment (the one that holds a moov box) and passes the very same bytes on', () => {
    const { notes, buffer } = install();
    const init = bytes(PROTECTED_INIT);
    buffer.appendBuffer(init);
    expect(buffer.appended).toEqual([init]);
    expect(buffer.appended[0]).toBe(init);
    expect(notes).toEqual([{ kind: 'init-segment', head: Buffer.from(init).toString('base64') }]);
  });

  it('reports nothing for a media segment, but still appends it', () => {
    const { notes, buffer } = install();
    const media = bytes('....styp....moof....mdat....');
    buffer.appendBuffer(media);
    expect(buffer.appended).toEqual([media]);
    expect(notes).toEqual([]);
  });

  it('reads an ArrayBuffer and a view with an offset as the bytes they show, and never more than headBytes of them', () => {
    const { notes, buffer } = install(undefined, 24);
    const whole = bytes(`${'x'.repeat(8)}....moov....encv${'y'.repeat(40)}`);
    const view = whole.subarray(8);
    buffer.appendBuffer(view);
    buffer.appendBuffer(whole.buffer);
    const [fromView, fromBuffer] = notes as Array<Extract<EmeNote, { kind: 'init-segment' }>>;
    expect(Buffer.from(fromView?.head ?? '', 'base64')).toEqual(Buffer.from(view.subarray(0, 24)));
    expect(Buffer.from(fromBuffer?.head ?? '', 'base64')).toEqual(Buffer.from(whole.subarray(0, 24)));
  });

  it('does not see a moov box that starts after the head it keeps (an init segment is small: the limit is documented)', () => {
    const { notes, buffer } = install(undefined, 16);
    buffer.appendBuffer(bytes(`${'x'.repeat(32)}moov`));
    expect(notes).toEqual([]);
  });

  it('reports the session with its init data type, then its key statuses whenever they change, and passes the request on', () => {
    const { notes, session } = install();
    const initData = bytes('{"kids":[]}');
    void session.generateRequest('keyids', initData);
    expect(session.requests).toEqual([['keyids', initData]]);
    expect(notes).toEqual([{ kind: 'session-request', initDataType: 'keyids' }]);

    session.keyStatuses.set('kid-1', 'usable');
    session.fire('keystatuseschange');
    expect(notes.slice(1)).toEqual([{ kind: 'key-status', status: 'usable' }]);
  });

  it('reports a license by its size and passes it on', () => {
    const { notes, session } = install();
    const license = bytes('{"keys":[]}');
    void session.update(license);
    expect(session.updates).toEqual([license]);
    expect(notes).toEqual([{ kind: 'license-update', bytes: license.byteLength }]);
  });

  it('never breaks what it watches: a binding that throws, one that rejects, and none at all', async () => {
    for (const binding of [
      () => {
        throw new Error('the page is going away');
      },
      () => Promise.reject(new Error('the page is going away')),
    ]) {
      const { buffer, session } = install(binding);
      const init = bytes(PROTECTED_INIT);
      expect(() => buffer.appendBuffer(init)).not.toThrow();
      expect(buffer.appended).toEqual([init]);
      await expect(session.generateRequest('keyids', init)).resolves.toBeUndefined();
      await Promise.resolve();
    }
    vi.stubGlobal('window', {});
    class Buffers extends FakeSourceBuffer {}
    vi.stubGlobal('SourceBuffer', Buffers);
    vi.stubGlobal('MediaKeySession', FakeSession);
    installEmeWatch({ binding: BINDING, headBytes: 64 });
    expect(() => new Buffers().appendBuffer(bytes(PROTECTED_INIT))).not.toThrow();
  });

  it('watches the segments and nothing else in a browser without EME (Linux WebKit): no MediaKeySession, no error', () => {
    const notes: EmeNote[] = [];
    vi.stubGlobal('window', { [BINDING]: (note: EmeNote) => Promise.resolve(notes.push(note)) });
    class Buffers extends FakeSourceBuffer {}
    vi.stubGlobal('SourceBuffer', Buffers);
    vi.stubGlobal('MediaKeySession', undefined);
    expect(() => installEmeWatch({ binding: BINDING, headBytes: 64 })).not.toThrow();
    new Buffers().appendBuffer(bytes(PROTECTED_INIT));
    expect(notes).toHaveLength(1);
  });
});
