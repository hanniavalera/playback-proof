import type { Page } from '@playwright/test';

// What the browser really did with Encrypted Media Extensions while a page played the ClearKey stream, observed from the outside.
//
// Why it exists: "the stream played" does not say WHO decrypted it. In Chromium and Firefox the browser's own ClearKey CDM does,
// behind EME: the init segments that reach the SourceBuffers still say `encv`/`enca`. In WebKit, Shaka 5.3.3 does not trust the
// browser's ClearKey (`hasWorkingClearKeySupport()` is false for Apple browsers), so the PLAYER decrypts every segment in JavaScript
// (WebCrypto AES-CTR) and rewrites the init segment to say `vp09`/`mp4a` before it appends anything: the EME exchange still happens
// (session, license, key status), but the browser never decrypts a byte. A spec that only asserts "first frame, 3 s, no error" would
// pass in both and claim EME for both. The decision and the measurements are ADR-105 in docs/decisions/e2e-eme.md.
//
// The page is observed with an init script (it runs before any script of the page) that wraps three browser methods and reports
// through a binding: nothing is evaluated by a spec, and nothing the page's own code sees is changed (every wrapper calls through).

/** One fact the page reports. `head` is the start of an init segment, base64. */
export type EmeNote =
  | { kind: 'session-request'; initDataType: string }
  | { kind: 'license-update'; bytes: number }
  | { kind: 'key-status'; status: string }
  | { kind: 'init-segment'; head: string };

/** The binding the page calls. */
export const BINDING = '__pbEmeNote';

/** An init segment is under 1 KB here (711 and 757 bytes); its sample entries are in the first few hundred. */
const HEAD_BYTES = 2048;

/**
 * Runs IN THE PAGE, before its scripts (Playwright serialises this function: it can refer to nothing outside its own body).
 * Wraps `SourceBuffer.appendBuffer` (reports the head of every init segment, the one that holds a `moov` box),
 * `MediaKeySession.generateRequest` (reports the session and from then on its key statuses) and `MediaKeySession.update` (reports
 * the license handed to the CDM). Every wrapper calls the original with the same arguments and returns what it returns.
 */
export function installEmeWatch(options: { binding: string; headBytes: number }): void {
  const report = (note: unknown): void => {
    try {
      const call = (window as unknown as Record<string, ((note: unknown) => Promise<void>) | undefined>)[
        options.binding
      ];
      // A closed page rejects the call: that must not become an unhandled rejection the lab's page would record as an error.
      void Promise.resolve(call?.(note)).catch(() => {});
    } catch {
      // the binding is gone: the page is going away
    }
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
    try {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const head = bytes.subarray(0, Math.min(bytes.length, options.headBytes));
      let hasMoov = false;
      for (let i = 0; i + 4 <= head.length && !hasMoov; i += 1) {
        hasMoov = head[i] === 0x6d && head[i + 1] === 0x6f && head[i + 2] === 0x6f && head[i + 3] === 0x76;
      }
      if (hasMoov) report({ kind: 'init-segment', head: btoa(String.fromCharCode(...head)) });
    } catch {
      // an instrument must never break what it watches
    }
    return appendBuffer.call(this, data);
  };

  if (typeof MediaKeySession === 'undefined') return; // no EME in this browser: nothing more to watch

  const generateRequest = MediaKeySession.prototype.generateRequest;
  MediaKeySession.prototype.generateRequest = function (
    this: MediaKeySession,
    initDataType: string,
    initData: BufferSource,
  ): Promise<void> {
    report({ kind: 'session-request', initDataType });
    this.addEventListener('keystatuseschange', () => {
      this.keyStatuses.forEach((status) => report({ kind: 'key-status', status: String(status) }));
    });
    return generateRequest.call(this, initDataType, initData);
  };

  const update = MediaKeySession.prototype.update;
  MediaKeySession.prototype.update = function (this: MediaKeySession, response: BufferSource): Promise<void> {
    report({ kind: 'license-update', bytes: response.byteLength });
    return update.call(this, response);
  };
}

/** What a page did with EME, summarised from its notes. */
export interface EmeEvidence {
  /** The init data type of every `generateRequest`: a ClearKey pair opens its session with `keyids`. */
  sessionRequests: string[];
  /** Licenses handed to the CDM (`MediaKeySession.update`). */
  licenseUpdates: number;
  /** The distinct statuses the CDM reported for the keys of its sessions, in order of first appearance (`usable`, ...). */
  keyStatuses: string[];
  /** One entry per init segment that reached a SourceBuffer, in order: did it still say `encv`/`enca`? */
  initSegments: Array<{ protected: boolean }>;
}

/** True when the init segment still has a protected sample entry (`encv` or `enca`): what the browser's CDM needs to decrypt it. */
export function isProtectedInit(headBase64: string): boolean {
  const head = Buffer.from(headBase64, 'base64');
  return head.includes('encv', 0, 'latin1') || head.includes('enca', 0, 'latin1');
}

export function summarize(notes: readonly EmeNote[]): EmeEvidence {
  const evidence: EmeEvidence = { sessionRequests: [], licenseUpdates: 0, keyStatuses: [], initSegments: [] };
  for (const note of notes) {
    switch (note.kind) {
      case 'session-request':
        evidence.sessionRequests.push(note.initDataType);
        break;
      case 'license-update':
        evidence.licenseUpdates += 1;
        break;
      case 'key-status':
        if (!evidence.keyStatuses.includes(note.status)) evidence.keyStatuses.push(note.status);
        break;
      case 'init-segment':
        evidence.initSegments.push({ protected: isProtectedInit(note.head) });
        break;
    }
  }
  return evidence;
}

/** Who turned the encrypted samples into clear ones, from what reached MSE. */
export type Decryptor = 'browser' | 'player' | 'mixed' | 'none';

/**
 * `browser`: every init segment that reached MSE was still protected, so the browser's CDM decrypts. `player`: none was, the player
 * had already removed the protection (and decrypted with WebCrypto). `none`: nothing was appended. `mixed`: both, which nothing in
 * the lab does and which would mean the stream changed halfway.
 */
export function decryptorOf(evidence: EmeEvidence): Decryptor {
  const { initSegments } = evidence;
  if (initSegments.length === 0) return 'none';
  if (initSegments.every((init) => init.protected)) return 'browser';
  if (initSegments.every((init) => !init.protected)) return 'player';
  return 'mixed';
}

/** Who decrypts, in a sentence for the report. */
export function describeDecryptor(decryptor: Decryptor): string {
  switch (decryptor) {
    case 'browser':
      return "the browser's ClearKey CDM";
    case 'player':
      return "the player, in JavaScript (WebCrypto): the browser's CDM is not used";
    case 'mixed':
      return 'both the browser and the player (the stream changed halfway)';
    case 'none':
      return 'nobody: no init segment reached MSE';
  }
}

/**
 * Who decrypts the stream in each engine, as measured (ADR-105): the browser's own ClearKey in Chromium and Firefox, the player's
 * WebCrypto in WebKit, because Shaka 5.3.3 says Apple's ClearKey is not reliable (`AppleBrowser.hasWorkingClearKeySupport()`). A spec
 * asserts the measurement, so that a change in either direction (Shaka starts trusting WebKit, or stops trusting Chromium) fails as
 * "the evidence changed" and not as a silent change of what the test proves.
 */
export const DOCUMENTED_DECRYPTOR: Readonly<Record<string, Decryptor>> = {
  chromium: 'browser',
  firefox: 'browser',
  webkit: 'player',
};

export interface EmeWatch {
  /** What the page has reported so far. */
  evidence(): EmeEvidence;
}

/**
 * Starts watching EME on a page. Call it BEFORE the page navigates (the init script has to be there before the page's own scripts).
 * The reports arrive asynchronously: read `evidence()` after something that happened later (the media clock reaching a time).
 */
export async function watchEme(page: Page): Promise<EmeWatch> {
  const notes: EmeNote[] = [];
  await page.exposeBinding(BINDING, (_source, note: EmeNote) => {
    notes.push(note);
  });
  // The function is sent as source text. A runner that compiles with esbuild's `keepNames` (tsx does, Playwright's own loader does not)
  // wraps named arrow functions in a `__name(...)` helper that does not exist in the page: the prelude defines it as the identity.
  const options = JSON.stringify({ binding: BINDING, headBytes: HEAD_BYTES });
  await page.addInitScript({
    content: `globalThis.__name ??= (target) => target;\n(${installEmeWatch.toString()})(${options});`,
  });
  return { evidence: () => summarize(notes) };
}
