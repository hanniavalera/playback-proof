// The low-end device of the lab: Chromium with a CPU slowdown. Firefox and WebKit have no equivalent, which is why the project is
// `chromium-cpu4x` and the catalog's `@cpu` rows say so. The rate comes from the project's metadata (playwright.config.ts).

// The command itself is shared with the performance harness, so it lives in src/lab/measure.
export { applyCpuThrottle } from '../../../src/lab/measure/cpu-throttle.ts';

/** The rate of `metadata.cpuThrottleRate`, or null when the project is not throttled. A value that is not a number >= 1 is a mistake in the config. */
export function throttleRateOf(metadata: Record<string, unknown>): number | null {
  const rate = metadata.cpuThrottleRate;
  if (rate === undefined || rate === null) return null;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1) {
    throw new RangeError(
      `the project's metadata.cpuThrottleRate must be a number >= 1 (1 means no slowdown), got ${JSON.stringify(rate)}`,
    );
  }
  return rate;
}
