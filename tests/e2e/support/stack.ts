// Errors raised by the support library should point at the line of the SPEC that made the call, not at the library's own line: the
// report's code frame is taken from the first frame of the stack, and "player.ts:54" tells a reader nothing about their test.

const SUPPORT_FRAME = /[\\/]tests[\\/]e2e[\\/]support[\\/]/;

/** `error`, with the frames of `tests/e2e/support/` removed from its stack. Returns the same error object. */
export function atCaller<E extends Error>(error: E): E {
  if (typeof error.stack !== 'string') return error;
  error.stack = error.stack
    .split('\n')
    .filter((line) => !(/^\s+at /.test(line) && SUPPORT_FRAME.test(line)))
    .join('\n');
  return error;
}

/** Runs `check`; an error it throws leaves with the library's frames removed. For the assertion helpers. */
export function checkedAtCaller(check: () => void): void {
  try {
    check();
  } catch (error) {
    throw error instanceof Error ? atCaller(error) : error;
  }
}
