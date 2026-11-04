import { expect } from '@playwright/test';
import type { QAError, QAMetrics } from '../../../src/shared/qa.ts';
import type { PlayerHandle } from './player.ts';
import { checkedAtCaller } from './stack.ts';

// Readable assertions over the hook's metrics. Each names the metric (as the property a reader would look up in docs/METRICS.md) and
// the value it saw, so a red test says what was wrong without opening the report. Playwright's `expect` underneath: the failure
// carries the expected and received values. The failure leaves with the library's frames removed, so the report's code frame is the
// line of the spec that called the helper.

/** `BAD_HTTP_STATUS (code 1001, severity 2, shaka): HTTP error status 404`. */
export function describeError(error: QAError): string {
  return `${error.codeName ?? 'error'} (code ${error.code}, severity ${error.severity}, ${error.source ?? 'shaka'}): ${error.message}`;
}

/** No error of any severity: what a clean network must produce. */
export function expectNoErrors(metrics: QAMetrics): void {
  checkedAtCaller(() => {
    expect(metrics.errors.map(describeError), 'player errors (metrics.errors): expected none').toEqual([]);
  });
}

/**
 * The player is playing and the instrument says so: no critical error (severity 2), the state is not `error`, the startup time is
 * defined (a first frame was presented) and frames were decoded. Recoverable errors are allowed here (use `expectNoErrors` to forbid them).
 */
export function expectHealthyPlayback(metrics: QAMetrics): void {
  checkedAtCaller(() => {
    const critical = metrics.errors.filter((error) => error.severity >= 2).map(describeError);
    expect(critical, 'critical player errors (metrics.errors with severity 2): expected none').toEqual([]);
    expect(metrics.state, 'player state (metrics.state): the player is in the error state').not.toBe('error');
    expect(
      metrics.startupMs,
      'startup time (metrics.startupMs) is null: the first frame was never presented',
    ).not.toBeNull();
    expect(
      metrics.frames.decoded,
      'decoded frames (metrics.frames.decoded): the player decoded nothing',
    ).toBeGreaterThan(0);
  });
}

function describeRebuffers(metrics: QAMetrics): string {
  const { count, totalMs, events } = metrics.rebuffer;
  if (count === 0) return 'none';
  const list = events.map(
    (event) =>
      `at media time ${event.mediaTime.toFixed(2)} s for ${Math.round(event.durationMs)} ms${event.ongoing ? ' (ongoing)' : ''}`,
  );
  return `${count} totalling ${Math.round(totalMs)} ms: ${list.join('; ')}`;
}

/** No rebuffer after the first frame outside a seek (docs/METRICS.md, "Rebuffer event"). */
export function expectNoRebuffer(metrics: QAMetrics): void {
  checkedAtCaller(() => {
    expect(
      metrics.rebuffer.count,
      `rebuffers (metrics.rebuffer.count): expected none, saw ${describeRebuffers(metrics)}`,
    ).toBe(0);
  });
}

export function expectAtMostRebuffers(metrics: QAMetrics, limit: number): void {
  checkedAtCaller(() => {
    expect(
      metrics.rebuffer.count,
      `rebuffers (metrics.rebuffer.count): expected at most ${limit}, saw ${describeRebuffers(metrics)}`,
    ).toBeLessThanOrEqual(limit);
  });
}

/**
 * Lets the player play `mediaSeconds` of media from where it is now and resolves with the media time reached. Resumes playback first when the
 * element is paused. Waits on the media clock (the hook's `waitForMediaTime`), never on the wall clock: a slow runner makes it take longer, not fail.
 */
export async function playFor(
  player: Pick<PlayerHandle, 'metrics' | 'play' | 'waitForMediaTime'>,
  mediaSeconds: number,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  if (!Number.isFinite(mediaSeconds) || mediaSeconds <= 0) {
    throw new RangeError(`playFor: mediaSeconds must be a number above 0, got ${String(mediaSeconds)}`);
  }
  const { playback } = await player.metrics();
  if (playback.paused) await player.play();
  return player.waitForMediaTime(playback.currentTime + mediaSeconds, options);
}
