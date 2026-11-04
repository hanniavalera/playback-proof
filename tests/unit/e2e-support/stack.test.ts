import { describe, expect, it } from 'vitest';
import { atCaller, checkedAtCaller } from '../../../tests/e2e/support/stack.ts';

// The report's code frame comes from the first frame of an error's stack: errors that leave the support library must start at the spec.

const STACK = [
  'Error: qa.waitFor timed out',
  'second line of the message',
  '    at readable (/repo/tests/e2e/support/player.ts:54:24)',
  '    at PlayerHandle.run (/repo/tests/e2e/support/player.ts:247:13)',
  '    at expectStartsAndPlays (/repo/tests/e2e/vod-start.spec.ts:20:3)',
  '    at /repo/tests/e2e/vod-start.spec.ts:59:5',
  '    at Object.<anonymous> (C:\\repo\\node_modules\\playwright\\lib\\x.js:1:1)',
].join('\n');

describe('atCaller', () => {
  it('removes the frames of the support library and keeps the message and every other frame', () => {
    const error = new Error('qa.waitFor timed out');
    error.stack = STACK;
    expect(atCaller(error).stack).toBe(
      [
        'Error: qa.waitFor timed out',
        'second line of the message',
        '    at expectStartsAndPlays (/repo/tests/e2e/vod-start.spec.ts:20:3)',
        '    at /repo/tests/e2e/vod-start.spec.ts:59:5',
        '    at Object.<anonymous> (C:\\repo\\node_modules\\playwright\\lib\\x.js:1:1)',
      ].join('\n'),
    );
  });

  it('recognises Windows paths, returns the same error, and leaves a message that mentions the folder alone', () => {
    const error = new Error('see tests/e2e/support/gaps.ts');
    error.stack =
      'Error: see tests/e2e/support/gaps.ts\n    at f (C:\\repo\\tests\\e2e\\support\\a.ts:1:1)\n    at g (C:\\repo\\tests\\e2e\\b.spec.ts:2:2)';
    expect(atCaller(error)).toBe(error);
    expect(error.stack).toBe(
      'Error: see tests/e2e/support/gaps.ts\n    at g (C:\\repo\\tests\\e2e\\b.spec.ts:2:2)',
    );
  });

  it('does nothing to an error without a stack', () => {
    const error = new Error('x');
    delete (error as { stack?: string }).stack;
    expect(atCaller(error).stack).toBeUndefined();
  });
});

describe('checkedAtCaller', () => {
  it('passes quietly, and rethrows what the check throws with the library frames removed', () => {
    expect(() => checkedAtCaller(() => {})).not.toThrow();
    let thrown: Error | undefined;
    try {
      checkedAtCaller(() => {
        const error = new Error('metric wrong');
        error.stack = STACK;
        throw error;
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe('metric wrong');
    expect(thrown?.stack).not.toContain('/support/');
    expect(thrown?.stack).toContain('vod-start.spec.ts:20:3');
  });

  it('rethrows something that is not an Error as it is', () => {
    expect(() =>
      checkedAtCaller(() => {
        throw 'plain';
      }),
    ).toThrow('plain');
  });
});
