import type { QAEvent } from '../../../src/shared/qa.ts';

// The hook's `variant-changed` events (docs/CONTRACTS.md section 6, src/player/hook.ts `syncVariant`) as typed values, and the
// sentences a failure message needs about them. `detail` is `Record<string, unknown>` on the wire: this is the one place that
// checks its shape.

export interface VariantChange {
  /** Position in the timeline (the cursor unit). */
  index: number;
  /** The page clock, ms (`performance.now()`). */
  t: number;
  /** `video.currentTime` when the change was recorded. */
  mediaTime: number;
  /** Shaka's id of the variant left (null for the initial selection) and entered. */
  from: number | null;
  to: number;
  /** Declared bandwidth of the variant entered, bits per second. */
  bandwidth: number;
  height: number;
  /** `start`: the initial selection of a load. `manual`: the page's own `selectVariantByHeight`. `abr`: anything Shaka did by itself. */
  reason: 'start' | 'abr' | 'manual';
}

const isReason = (value: unknown): value is VariantChange['reason'] =>
  value === 'start' || value === 'abr' || value === 'manual';

/** The `variant-changed` events of a timeline, in order. A malformed one is an error of the instrument, so it throws. */
export function variantChanges(events: readonly QAEvent[]): VariantChange[] {
  const changes: VariantChange[] = [];
  for (const event of events) {
    if (event.name !== 'variant-changed') continue;
    const { from, to, bandwidth, height, reason } = event.detail ?? {};
    if (
      !(from === null || typeof from === 'number') ||
      typeof to !== 'number' ||
      typeof bandwidth !== 'number' ||
      typeof height !== 'number' ||
      !isReason(reason)
    ) {
      throw new Error(
        `a variant-changed event of the hook has a detail that is not { from, to, bandwidth, height, reason }: ${JSON.stringify(event)}`,
      );
    }
    changes.push({
      index: event.index,
      t: event.t,
      mediaTime: event.mediaTime,
      from,
      to,
      bandwidth,
      height,
      reason,
    });
  }
  return changes;
}

/** `720p start at 0.00 s, 240p abr at 16.41 s`: the changes as a reader wants them in a message (the time is media time). */
export function describeVariantChanges(changes: readonly VariantChange[]): string {
  if (changes.length === 0) return 'none';
  return changes
    .map((change) => `${change.height}p ${change.reason} at ${change.mediaTime.toFixed(2)} s`)
    .join(', ');
}
