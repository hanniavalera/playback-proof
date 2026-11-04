import { atCaller } from '../support/stack.ts';

const HELPER_FRAME = /[\\/]tests[\\/]e2e[\\/]vod[\\/]/;

/**
 * An error whose stack starts at the line of the spec that called a helper of this folder: the frames of `tests/e2e/vod/` are removed,
 * as the support library does for its own (ADR-078), so the report's code frame is the spec's line and not the helper's.
 */
export function failure(message: string): Error {
  const error = new Error(message);
  if (typeof error.stack === 'string') {
    error.stack = error.stack
      .split('\n')
      .filter((line) => !(/^\s+at /.test(line) && HELPER_FRAME.test(line)))
      .join('\n');
  }
  return atCaller(error);
}
