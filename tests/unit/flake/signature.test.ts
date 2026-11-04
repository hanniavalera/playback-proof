import { describe, expect, it } from 'vitest';
import {
  errorSignature,
  firstLine,
  NO_MESSAGE_SIGNATURE,
  SIGNATURE_MAX_LENGTH,
  signatureOfError,
} from '../../../src/lab/signature.ts';

const ESC = String.fromCharCode(27);

describe('PB-LAB-005 error signatures: the same cause is one signature', () => {
  // Pairs of messages of the same failure on two runs: only what changes from run to run differs.
  const sameCause: Array<[string, string, string]> = [
    [
      'a timeout with a different value',
      'Test timeout of 45000ms exceeded.',
      'Test timeout of 90000ms exceeded.',
    ],
    [
      'a wait with a session id, a number and a predicate',
      'waited 15000 ms for a request of session 1a2b3c4d5e6f matching (entry) => entry.kind === "segment"',
      'waited 10000 ms for a request of session 9f8e7d6c5b4a matching (entry) => entry.kind === "segment"',
    ],
    [
      'a page that did not boot at another port and another manifest',
      'the player page did not boot (http://127.0.0.1:4731/player/?manifest=http%3A%2F%2F127.0.0.1%3A4731%2Fs%2Faaaaaaaaaaaa%2Fvod.mpd): Timeout 15000ms exceeded.',
      'the player page did not boot (http://127.0.0.1:4655/player/?manifest=http%3A%2F%2F127.0.0.1%3A4655%2Fs%2Fbbbbbbbbbbbb%2Fvod.mpd): Timeout 15000ms exceeded.',
    ],
    [
      'a refused connection to another address',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4700/player/',
    ],
    [
      'a failure on two machines (the path differs, the file does not)',
      "Error: ENOENT: no such file or directory, open '/Users/dev/repos/playback-proof/.cache/streams/vod-cmaf/manifest.mpd'",
      "Error: ENOENT: no such file or directory, open '/home/runner/work/playback-proof/playback-proof/.cache/streams/vod-cmaf/manifest.mpd'",
    ],
    [
      'a timestamp in the message',
      'service answered 503 at 2026-11-03T22:19:10.045Z for request 41',
      'service answered 503 at 2026-11-04T01:02:03Z for request 977',
    ],
    [
      'a clock time and a UUID',
      'lease 3f2b8c1e-9d4a-4e7b-8a61-0c5d2e9f7a13 expired at 22:19:10.045',
      'lease a1b2c3d4-e5f6-4789-abcd-ef0123456789 expired at 01:02:03',
    ],
    [
      'fractions of a second',
      'media time reached 2.431 s, expected at least 3 s',
      'media time reached 1.9 s, expected at least 3 s',
    ],
    [
      'a hex address and a content hash',
      'segment 0x7f3a2b1c failed the check against 9b74c9897bac770ffc029102a200c5de',
      'segment 0x11aa22bb failed the check against 0cc175b9c0f1b6a831c399e269772661',
    ],
  ];

  it.each(sameCause)('%s', (_name, a, b) => {
    expect(errorSignature(a)).toBe(errorSignature(b));
    expect(errorSignature(a)).not.toMatch(/\d{3,}/);
  });

  it('turns each kind of variable into its own placeholder', () => {
    expect(errorSignature('Test timeout of 45000ms exceeded.')).toBe('Test timeout of <n>ms exceeded.');
    expect(errorSignature('open http://127.0.0.1:4731/x?y=1 failed')).toBe('open <url> failed');
    expect(errorSignature('at 2026-11-03T22:19:10.045Z')).toBe('at <ts>');
    expect(errorSignature('at 22:19:10')).toBe('at <ts>');
    expect(errorSignature('session 1a2b3c4d5e6f gone')).toBe('session <id> gone');
    expect(errorSignature('lease 3f2b8c1e-9d4a-4e7b-8a61-0c5d2e9f7a13 expired')).toBe('lease <id> expired');
    expect(errorSignature('connect ECONNREFUSED 127.0.0.1:4731')).toBe('connect ECONNREFUSED <addr>');
    expect(errorSignature('segment 0x7f3a2b1c')).toBe('segment <hex>');
    expect(errorSignature("open '/Users/me/repo/x.json'")).toBe("open '<path>/x.json'");
    expect(errorSignature('C:\\Users\\me\\repo\\x.json missing')).toBe('<path>/x.json missing');
    expect(errorSignature('at spec.ts:42:7')).toBe('at spec.ts:<n>:<n>');
  });

  it('keeps what names a cause: catalog ids, codecs, event names, error classes and words', () => {
    expect(errorSignature('PB-ENV-001 the engine plays the selected flavour')).toBe(
      'PB-ENV-001 the engine plays the selected flavour',
    );
    expect(
      errorSignature('MediaError 4: Failed to push buffer for vp09.00.10.08 / mp4a.40.2 / avc1.64001f'),
    ).toBe('MediaError <n>: Failed to push buffer for vp09.00.10.08 / mp4a.40.2 / avc1.64001f');
    expect(
      errorSignature("waitFor('firstframe') timed out; h264 and and/or 1/2 stay words and fractions"),
    ).toBe("waitFor('firstframe') timed out; h264 and and/or <n>/<n> stay words and fractions");
    expect(errorSignature('TypeError: Cannot read properties of undefined (reading "metrics")')).toBe(
      'TypeError: Cannot read properties of undefined (reading "metrics")',
    );
  });
});

describe('PB-LAB-005 error signatures: different causes are different signatures', () => {
  const differentCauses: Array<[string, string]> = [
    [
      'Test timeout of 45000ms exceeded.',
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/',
    ],
    [
      'the player page did not boot (http://127.0.0.1:4731/player/): Timeout 15000ms exceeded.',
      'the player page could not use its parameters (http://127.0.0.1:4731/player/):',
    ],
    ['Error: waitFor firstframe timed out', 'Error: waitFor seeked timed out'],
    ['TypeError: x is not a function', 'RangeError: x is not a function'],
    ['MediaError 4: Failed to push buffer', 'MediaError 3: decode error'],
    ['expected the rung 720 to be chosen', 'expected the rung 240 to be chosen after the drop'],
  ];

  it.each(differentCauses)('%s  vs  %s', (a, b) => {
    expect(errorSignature(a)).not.toBe(errorSignature(b));
  });

  it('reads only the first line: the values and the timelines below it do not split a cause', () => {
    const first = 'Error: media time reached';
    expect(errorSignature(`${first}\n\nExpected: >= 3\nReceived:    2.4`)).toBe(
      errorSignature(`${first}\n\nExpected: >= 3\nReceived:    1.1`),
    );
    expect(errorSignature(`${first}\nat spec.ts:12:3`)).toBe('Error: media time reached');
  });

  it('starts at the first line that says something, and ignores the colour of an assertion', () => {
    expect(errorSignature('\n\n   \n  Error: media time reached\nExpected: 3')).toBe(
      'Error: media time reached',
    );
    const coloured = `Error: ${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mtoBe${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m) // Object.is equality${ESC}[22m\n\nExpected: 3`;
    expect(errorSignature(coloured)).toBe('Error: expect(received).toBe(expected) // Object.is equality');
    expect(firstLine(`${ESC}[31mred${ESC}[39m\nsecond`)).toBe('red');
    expect(errorSignature('first\r\nsecond')).toBe('first');
  });
});

describe('PB-LAB-005 error signatures: edges', () => {
  it('names an error that has no message', () => {
    for (const nothing of ['', '   ', '\n\n', undefined, null]) {
      expect(errorSignature(nothing)).toBe(NO_MESSAGE_SIGNATURE);
    }
    expect(signatureOfError(null)).toBe(NO_MESSAGE_SIGNATURE);
    expect(signatureOfError({})).toBe(NO_MESSAGE_SIGNATURE);
  });

  it('cuts a long first line, the same way every time', () => {
    const long = `Error: ${'a very long explanation '.repeat(30)}`;
    const signature = errorSignature(long);
    expect(signature).toHaveLength(SIGNATURE_MAX_LENGTH);
    expect(signature.endsWith('…')).toBe(true);
    expect(errorSignature(long)).toBe(signature);
    const exactly = 'x'.repeat(SIGNATURE_MAX_LENGTH);
    expect(errorSignature(exactly)).toBe(exactly);
  });

  it('gives the signature of a signature unchanged, so that it can be applied twice', () => {
    for (const message of [
      'waited 15000 ms for a request of session 1a2b3c4d5e6f matching x',
      "open '/Users/me/repo/x.json' at 2026-11-03T22:19:10.045Z via http://127.0.0.1:4731/a",
      'at spec.ts:42:7 PB-VOD-001',
    ]) {
      const once = errorSignature(message);
      expect(errorSignature(once)).toBe(once);
    }
  });

  it('takes the message of a Playwright error, else the head of its stack, else the value that was thrown', () => {
    expect(signatureOfError({ message: 'Error: timed out after 100 ms', stack: 'Error: other\n at x' })).toBe(
      'Error: timed out after <n> ms',
    );
    expect(signatureOfError({ stack: 'Error: from the stack 5\n    at x (y.ts:1:1)' })).toBe(
      'Error: from the stack <n>',
    );
    expect(signatureOfError({ value: 'a string was thrown' })).toBe('a string was thrown');
  });
});
