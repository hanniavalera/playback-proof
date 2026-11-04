import { atCaller } from '../support/stack.ts';

// What a failed wait means, in the catalog's terms. The hook's own message after a timeout is the last events of the timeline: exactly
// what is needed to read the failure, and nothing about what the spec was waiting for. A spec that waits on "the step down" or "the
// step up" says so first, then the hook's message follows unchanged.

const ABR_HELPER_FRAME = /[\\/]tests[\\/]e2e[\\/]abr[\\/]/;

/**
 * `wait`, and when it rejects, an error that says `explanation` and then what the wait said. Its stack starts at the spec's own line.
 * What only the page can say (the dropped frames of the load, the rung changes so far) is `addendum`, a function called only when the
 * wait failed and appended to the sentence; if it fails too (the page may be what failed) the sentence says so and goes on, so the
 * failure that is reported is always the wait's.
 */
export async function orExplain<T>(
  wait: Promise<T>,
  explanation: string,
  addendum?: () => Promise<string>,
): Promise<T> {
  try {
    return await wait;
  } catch (error) {
    throw explainedError(`${explanation}${await addendumOf(addendum)}`, error);
  }
}

/**
 * `check`, and when it throws, an error that says `explanation` and then what the check said. For the assertion helpers of the support
 * library (`expectAtMostRebuffers`), whose message says what they measured and nothing of what the spec knows about the run.
 */
export function withExplanation(check: () => void, explanation: string): void {
  try {
    check();
  } catch (error) {
    throw explainedError(explanation, error);
  }
}

function explainedError(sentence: string, cause: unknown): Error {
  const said = cause instanceof Error ? cause.message : String(cause);
  const explained = atCaller(new Error(`${sentence}\n${said}`));
  if (typeof explained.stack === 'string') {
    explained.stack = explained.stack
      .split('\n')
      .filter((line) => !(/^\s+at /.test(line) && ABR_HELPER_FRAME.test(line)))
      .join('\n');
  }
  return explained;
}

async function addendumOf(addendum: (() => Promise<string>) | undefined): Promise<string> {
  if (!addendum) return '';
  try {
    return ` ${await addendum()}`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return ` (what the page could add to this could not be read: ${why})`;
  }
}
