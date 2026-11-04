import { describe, expect, it } from 'vitest';
import { digestShakaError } from '../../../src/player/errors.ts';

const CODES = { BAD_HTTP_STATUS: 1001, HTTP_ERROR: 1002, VIDEO_ERROR: 3016 };
const CATEGORIES = { NETWORK: 1, MEDIA: 3 };

describe('digestShakaError', () => {
  it('names the code and the category, keeps the severity, and digests the data', () => {
    const error = {
      severity: 2,
      category: 1,
      code: 1001,
      message: 'Shaka Error 1001',
      data: [
        'http://127.0.0.1:4640/s/x/vod-cmaf/seg/v360/3.m4s',
        404,
        '',
        { 'content-type': 'text/plain' },
        1,
      ],
    };
    expect(digestShakaError(error, { codes: CODES, categories: CATEGORIES })).toEqual({
      code: 1001,
      codeName: 'BAD_HTTP_STATUS',
      category: 1,
      severity: 2,
      message: 'NETWORK.BAD_HTTP_STATUS: Shaka Error 1001',
      data: [
        'http://127.0.0.1:4640/s/x/vod-cmaf/seg/v360/3.m4s',
        404,
        '',
        '{"content-type":"text/plain"}',
        1,
      ],
    });
  });

  it('works without the enums: the code is still there, the name is not invented', () => {
    expect(digestShakaError({ severity: 1, category: 3, code: 3016, message: 'Shaka Error 3016' })).toEqual({
      code: 3016,
      category: 3,
      severity: 1,
      message: 'Shaka Error 3016',
    });
  });

  it('shortens what could be large: long strings, many items, binary bodies, deep objects', () => {
    const digest = digestShakaError({
      code: 1001,
      category: 1,
      severity: 1,
      data: [
        'x'.repeat(1000),
        new Uint8Array(4096),
        new ArrayBuffer(10),
        { a: { b: 'y'.repeat(1000) } },
        1,
        2,
        3,
        4,
        5,
        6,
      ],
    });
    expect(digest.data).toHaveLength(8);
    const [text, view, buffer, nested] = digest.data as string[];
    expect(text?.length).toBeLessThanOrEqual(201);
    expect(view).toBe('[4096 bytes]');
    expect(buffer).toBe('[10 bytes]');
    expect(nested?.length).toBeLessThanOrEqual(201);
  });

  it('produces something JSON-safe for any input, including a thrown string, null and a cyclic object', () => {
    const loop: Record<string, unknown> = { code: 7001 };
    loop.data = [loop];
    for (const input of ['boom', null, undefined, 42, loop, new Error('plain')]) {
      const digest = digestShakaError(input, { codes: CODES });
      expect(JSON.parse(JSON.stringify(digest))).toEqual(digest);
      expect(typeof digest.message).toBe('string');
    }
    expect(digestShakaError('boom')).toEqual({ code: 0, category: 0, severity: 1, message: 'boom' });
  });

  it('treats a non-Shaka Error as a recoverable error of code 0 that keeps its message', () => {
    expect(digestShakaError(new TypeError('x is not a function'))).toEqual({
      code: 0,
      category: 0,
      severity: 1,
      message: 'x is not a function',
    });
  });
});
