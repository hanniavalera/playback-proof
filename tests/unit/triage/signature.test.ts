import { describe, expect, it } from 'vitest';
import { errorSignature, NO_MESSAGE_SIGNATURE, SIGNATURE_MAX_LENGTH } from '../../../src/lab/signature.ts';
import {
  assertionKind,
  collapseRepeats,
  failureSignature,
  formatSignature,
  isGeneric,
  meaningfulFirstLine,
  messageSignature,
  signatureKey,
  signatureParts,
} from '../../../triage/signature.ts';
import type { ShakaErrorDigest } from '../../../triage/types.ts';
import { failure } from './support.ts';

const ESC = String.fromCharCode(27);
const critical = (code: number, codeName: string): ShakaErrorDigest => ({
  code,
  codeName,
  category: Math.floor(code / 1000),
  severity: 2,
  message: codeName,
  source: 'shaka',
});
const sig = (overrides: Parameters<typeof failure>[0]): string =>
  failureSignature(failure(overrides)).signature;

describe('PB-LAB-005 triage signatures: the same cause is one signature', () => {
  // Each pair is two runs of the same failure: only what changes from run to run, or from engine to engine, differs.
  const sameCause: Array<[string, string, string]> = [
    [
      'a list of rebuffers that is one item longer, with other times',
      'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 382 ms: at media time 8.01 s for 24 ms; at media time 9.97 s for 358 ms',
      'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 3 totalling 780 ms: at media time 5.5 s for 24 ms; at media time 9.97 s for 358 ms; at media time 11.99 s for 398 ms',
    ],
    [
      'a wait that timed out with another timeout and another cursor',
      "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      "Error: qa.waitFor('firstframe') timed out after 20000 ms (looking from index 12).",
    ],
    [
      'a fault rule that is f1 in one test and f3 in the other',
      'Error: the fault rule f1 {"type":"status","status":404} named 0 of the 1 request it was waited for within 15000 ms: the player never asked for what the rule matches',
      'Error: the fault rule f3 {"type":"status","status":404} named 0 of the 1 request it was waited for within 10000 ms: the player never asked for what the rule matches',
    ],
    [
      'a refused connection, worded by Chromium, Firefox and WebKit',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      'Error: page.goto: NS_ERROR_CONNECTION_REFUSED',
    ],
    [
      'a refused connection, worded by Chromium and WebKit',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      'Error: page.goto: Could not connect to the server.',
    ],
    [
      'a reset connection, worded by Chromium and Firefox',
      'Error: page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:4655/player/',
      'Error: page.goto: NS_ERROR_NET_RESET',
    ],
    [
      'the rung each engine happened to be on',
      'Error: the segment was never delivered by another rung, v360 was asked 3 times',
      'Error: the segment was never delivered by another rung, v720 was asked 4 times',
    ],
    [
      'a page that did not boot at another port, manifest and session',
      'Error: the player page did not boot (http://127.0.0.1:4731/player/?manifest=%2Fs%2F1a2b3c4d5e6f%2Fvod.mpd): Timeout 15000ms exceeded.',
      'Error: the player page did not boot (http://127.0.0.1:4655/player/?manifest=%2Fs%2F9f8e7d6c5b4a%2Fvod.mpd): Timeout 15000ms exceeded.',
    ],
  ];

  it.each(sameCause)('%s', (_name, a, b) => {
    expect(messageSignature(a)).toBe(messageSignature(b));
    expect(sig({ message: a })).toBe(sig({ message: b }));
  });

  it('is the lab’s own error signature when none of triage’s steps applies: one normalisation, not two', () => {
    for (const message of [
      'Error: Test timeout of 45000ms exceeded.',
      "Error: ENOENT: no such file or directory, open '/Users/dev/pb/.cache/streams/vod-cmaf/manifest.mpd'",
      'Error: service answered 503 at 2026-11-03T22:19:10.045Z for request 41',
      'TypeError: Cannot read properties of undefined (reading "metrics")',
    ]) {
      expect(messageSignature(message)).toBe(errorSignature(message));
    }
  });

  it('is the same for the same cause on two machines and in three engines: only the message, the helper and the code count', () => {
    const base = {
      message: 'Error: HLS media playlists requested (request log)',
      file: 'tests/e2e/vod-start.spec.ts',
    };
    const one = sig({
      ...base,
      project: 'chromium',
      source: 'reports/chromium/playwright.json',
      envId: 'a',
      durationMs: 11787,
    });
    const two = sig({
      ...base,
      project: 'webkit',
      source: 'reports/webkit/playwright.json',
      envId: 'b',
      durationMs: 10402,
      attempts: 3,
    });
    expect(one).toBe(two);
  });
});

describe('PB-LAB-005 triage signatures: different causes are different signatures', () => {
  const differentCauses: Array<[string, string, string]> = [
    [
      'two events waited for',
      "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).",
    ],
    [
      'two metrics asserted',
      'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 2 totalling 382 ms: at media time 8.01 s for 24 ms',
      'Error: dropped frames (metrics.frames.dropped) against decoded frames',
    ],
    [
      'a refused connection and a reset one',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      'Error: page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:4731/player/',
    ],
    [
      'a boot failure and a refused parameter',
      'Error: the player page did not boot (http://127.0.0.1:4731/player/): Timeout 15000ms exceeded.',
      'Error: the player page could not use its parameters (http://127.0.0.1:4731/player/):',
    ],
    [
      'the same sentence about a rung outage and about an origin outage',
      'Error: the segment was never delivered by another rung, v360 was asked 3 times',
      'Error: the segment was never delivered by the origin, v360 was asked 3 times',
    ],
  ];

  it.each(differentCauses)('%s', (_name, a, b) => {
    expect(sig({ message: a })).not.toBe(sig({ message: b }));
  });

  it('separates the same message by the critical Shaka error the player ended on', () => {
    const message = 'Error: player state (metrics.state): the player is in the error state';
    const withCode = (code: number, name: string) =>
      sig({ message, diagnostics: { primaryError: critical(code, name) } });
    expect(withCode(1001, 'BAD_HTTP_STATUS')).not.toBe(withCode(3016, 'VIDEO_ERROR'));
    expect(withCode(1001, 'BAD_HTTP_STATUS')).not.toBe(sig({ message }));
    expect(withCode(1001, 'BAD_HTTP_STATUS')).toContain('{shaka 1001}');
  });

  it('does not let a recoverable error, or a code of 0 (an error of the page itself), name the cause', () => {
    const message = 'Error: x';
    const recoverable: ShakaErrorDigest = { ...critical(1001, 'BAD_HTTP_STATUS'), severity: 1 };
    expect(sig({ message, diagnostics: { shakaErrors: [recoverable], primaryError: null } })).toBe(
      sig({ message }),
    );
    expect(sig({ message, diagnostics: { primaryError: { ...critical(0, 'x'), code: 0 } } })).toBe(
      sig({ message }),
    );
  });

  it('separates the same words by the helper that threw them, and joins the specs that called the helper', () => {
    const message = 'Error: the origin did not deliver the segment';
    const helper = (fn: string, file = 'tests/e2e/rec/faults.ts') => [{ file, fn, line: 55 }];
    const spec = (file: string) => ({ file, fn: null, line: 10 });
    const one = sig({
      message,
      frames: [...helper('waitForFault'), spec('tests/e2e/recovery.spec.ts')],
      file: 'tests/e2e/recovery.spec.ts',
    });
    const other = sig({
      message,
      frames: [...helper('waitForFault'), spec('tests/e2e/abr.spec.ts')],
      file: 'tests/e2e/abr.spec.ts',
    });
    const elsewhere = sig({
      message,
      frames: [...helper('settle'), spec('tests/e2e/recovery.spec.ts')],
      file: 'tests/e2e/recovery.spec.ts',
    });
    expect(one).toBe(other);
    expect(one).not.toBe(elsewhere);
    expect(one).toContain('@ tests/e2e/rec/faults.ts:waitForFault');
  });

  it('keeps the line number out of the name: an edit above the helper does not rename the cause', () => {
    const message = 'Error: the origin did not deliver the segment';
    const at = (line: number) =>
      sig({ message, frames: [{ file: 'tests/e2e/rec/faults.ts', fn: 'waitForFault', line }] });
    expect(at(55)).toBe(at(81));
  });

  it('separates the failures of a message that has no words of its own by the spec they came from, and only those', () => {
    const generic = 'Error: expect(received).toBe(expected) // Object.is equality';
    const a = sig({
      message: generic,
      file: 'tests/e2e/abr.spec.ts',
      frames: [{ file: 'tests/e2e/abr.spec.ts', fn: null, line: 3 }],
    });
    const b = sig({
      message: generic,
      file: 'tests/e2e/live.spec.ts',
      frames: [{ file: 'tests/e2e/live.spec.ts', fn: null, line: 3 }],
    });
    const again = sig({
      message: generic,
      file: 'tests/e2e/abr.spec.ts',
      project: 'firefox',
      frames: [{ file: 'tests/e2e/abr.spec.ts', fn: null, line: 9 }],
    });
    expect(a).not.toBe(b);
    expect(a).toBe(again);
    const timeout = 'Error: Test timeout of 45000ms exceeded.';
    expect(sig({ message: timeout, file: 'tests/e2e/abr.spec.ts' })).not.toBe(
      sig({ message: timeout, file: 'tests/e2e/live.spec.ts' }),
    );
    expect(sig({ message: timeout, file: 'tests/e2e/abr.spec.ts', project: 'chromium' })).toBe(
      sig({ message: timeout, file: 'tests/e2e/abr.spec.ts', project: 'webkit' }),
    );
  });

  it('tells apart what was checked by the matcher, when the words of the message are the same', () => {
    const text = (matcher: string) =>
      `Error: media time\n\nexpect(received).${matcher}(expected)\n\nExpected: 3\nReceived: 2`;
    expect(sig({ message: text('toBeGreaterThan') })).not.toBe(sig({ message: text('toBeLessThan') }));
    expect(sig({ message: text('toBe') })).toContain('[toBe]');
  });
});

describe('PB-LAB-005 triage signatures: the parts', () => {
  it('reads the matcher of an expect, with its `not`, through the colours of a terminal', () => {
    const coloured = `Error: x\n\n${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mnot${ESC}[2m.${ESC}[22mtoBe${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m)${ESC}[22m`;
    expect(assertionKind(coloured)).toBe('not.toBe');
    expect(assertionKind('Error: x\n\nexpect(locator).toHaveText(expected)')).toBe('toHaveText');
    expect(assertionKind('Error: Test timeout of 45000ms exceeded.')).toBe('test-timeout');
    expect(assertionKind('Error: the origin refused')).toBe('thrown');
    expect(assertionKind('')).toBe('thrown');
  });

  it('knows when a message has nothing to say for itself', () => {
    expect(isGeneric(NO_MESSAGE_SIGNATURE, 'thrown')).toBe(true);
    expect(isGeneric('Error: expect(received).toBe(expected) // Object.is equality', 'toBe')).toBe(true);
    expect(isGeneric('Error: Timeout <n>ms exceeded.', 'thrown')).toBe(true);
    expect(isGeneric('Test timeout of <n>ms exceeded.', 'test-timeout')).toBe(true);
    expect(
      isGeneric('Error: rebuffers (metrics.rebuffer.count): expected at most <n>', 'toBeLessThanOrEqual'),
    ).toBe(false);
  });

  it('joins a bare error class with the line after it, and says so when there is no message at all', () => {
    expect(meaningfulFirstLine('Error:\n\nthe origin refused')).toBe('Error: the origin refused');
    expect(meaningfulFirstLine('\n\n  TypeError: x is not a function\nat y')).toBe(
      'TypeError: x is not a function',
    );
    expect(meaningfulFirstLine('Error:')).toBe('Error:');
    expect(messageSignature('')).toBe(NO_MESSAGE_SIGNATURE);
    expect(messageSignature(undefined)).toBe(NO_MESSAGE_SIGNATURE);
  });

  it('collapses identical items of a list, the first one included, and nothing else', () => {
    expect(collapseRepeats('saw <n>: at <n> s; at <n> s; at <n> s')).toBe('saw <n>: at <n> s; …');
    expect(collapseRepeats('saw <n>: at <n> s')).toBe('saw <n>: at <n> s');
    expect(collapseRepeats('a; b; a')).toBe('a; b; a');
    expect(collapseRepeats('x: a; a; b; b; b')).toBe('x: a; …; b; …');
    expect(collapseRepeats('no list here')).toBe('no list here');
  });

  it('cuts a long message like the lab’s signature does, after collapsing', () => {
    const long = `Error: ${'a very long explanation '.repeat(30)}`;
    expect(messageSignature(long)).toHaveLength(SIGNATURE_MAX_LENGTH);
    const list = `Error: rebuffers: ${Array.from({ length: 40 }, (_, i) => `at media time ${i}.5 s for ${i} ms`).join('; ')}`;
    expect(messageSignature(list)).toBe('Error: rebuffers: at media time <n> s for <n> ms; …');
  });

  it('leaves the location out of a run-level failure, and names the code of the critical error only', () => {
    expect(
      signatureParts(failure({ scope: 'run', file: '', message: 'Error: Test timeout of 45000ms exceeded.' }))
        .location,
    ).toBeNull();
    const parts = signatureParts(failure({ diagnostics: { primaryError: critical(3016, 'VIDEO_ERROR') } }));
    expect(parts.shakaCode).toBe(3016);
    expect(formatSignature({ message: 'm', assertion: 'thrown', location: 'a.ts:f', shakaCode: 1001 })).toBe(
      'm [thrown] @ a.ts:f {shaka 1001}',
    );
    expect(formatSignature({ message: 'm', assertion: 'toBe', location: null, shakaCode: null })).toBe(
      'm [toBe]',
    );
  });

  it('has a key that names the signature: short, stable, and different for different signatures', () => {
    const a = failureSignature(failure({ message: 'Error: a' }));
    const b = failureSignature(failure({ message: 'Error: b' }));
    expect(a.key).toMatch(/^[0-9a-f]{12}$/);
    expect(a.key).toBe(signatureKey(a.signature));
    expect(a.key).not.toBe(b.key);
    expect(failureSignature(failure({ message: 'Error: a' })).key).toBe(a.key);
  });
});
