// Shrinking a series that is kept in full in memory to the size that is sensible to commit, without losing the thing a soak is read for:
// the spike. Plain thinning (every n-th point) would drop a 15 s latency reading between two kept ones and the committed file would
// show a smooth line over a stall.

/**
 * At most `maxPoints` of `items`, in their original order, always including the first and the last. The rest is split into equal
 * stretches and each keeps the item with the largest value and the one with the smallest, so a peak or a trough survives. Items whose
 * value is null (no reading) are kept only when a stretch has nothing else to show.
 */
export function decimate<T>(items: readonly T[], maxPoints: number, value: (item: T) => number | null): T[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 2)
    throw new RangeError(`decimate: maxPoints must be an integer of at least 2, got ${String(maxPoints)}`);
  if (items.length <= maxPoints) return [...items];

  const kept = new Set<number>([0, items.length - 1]);
  const interior = items.length - 2;
  const stretches = Math.max(1, Math.floor((maxPoints - 2) / 2));
  for (let s = 0; s < stretches; s++) {
    const from = 1 + Math.floor((s * interior) / stretches);
    const to = 1 + Math.floor(((s + 1) * interior) / stretches); // exclusive
    let low = -1;
    let high = -1;
    for (let i = from; i < to; i++) {
      const v = value(items[i] as T);
      if (v === null) continue;
      if (low === -1 || v < (value(items[low] as T) as number)) low = i;
      if (high === -1 || v > (value(items[high] as T) as number)) high = i;
    }
    if (low === -1 && from < to) low = from;
    for (const i of [low, high]) if (i !== -1) kept.add(i);
  }
  // At most two items per stretch plus the two ends: never more than `maxPoints`.
  return [...kept].sort((a, b) => a - b).map((i) => items[i] as T);
}
