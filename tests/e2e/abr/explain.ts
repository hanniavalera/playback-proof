import { atCaller } from '../support/stack.ts';

// What a failed wait means, in the catalog's terms. The hook's own message after a timeout is the last events of the timeline: exactly
// what is needed to read the failure, and nothing about what the spec was waiting for. A spec that waits on "the step down" or "the
// step up" says so first, then the hook's message follows unchanged.

const ABR_HELPER_FRAME = /[\\/]tests[\\/]e2e[\\/]abr[\\/]/;

/** `wait`, and when it rejects, an error that says `explanation` and then what the wait said. Its stack starts at the spec's own line. */
export async function orExplain<T>(wait: Promise<T>, explanation: string): Promise<T> {
  try {
    return await wait;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    const explained = atCaller(new Error(`${explanation}\n${said}`));
    if (typeof explained.stack === 'string') {
      explained.stack = explained.stack
        .split('\n')
        .filter((line) => !(/^\s+at /.test(line) && ABR_HELPER_FRAME.test(line)))
        .join('\n');
    }
    throw explained;
  }
}
