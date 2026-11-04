import type { PlayerHandle } from '../support/player.ts';

// Latency over a window of media time, sampled on the media clock (an event of the page, never a timer): `waitForMediaTime` to the
// next whole second, then one read of the hook. A drifting player and a jittery one both break a maximum; the series is what tells
// them apart, so a failure prints it.

export interface LatencySample {
  /** Media time of the read, seconds. */
  mediaTime: number;
  /** `metrics.live.latencyMs` at the read; null when the player had no live edge to measure against. */
  latencyMs: number | null;
}

/**
 * One sample every `stepSec` of media time for `seconds` of it, starting from media time `from` (the first read is at `from + stepSec`).
 * Resolves when the window is over; a stall inside it makes `waitForMediaTime` reject with the player's timeline.
 */
export async function sampleLatency(
  qa: Pick<PlayerHandle, 'metrics' | 'waitForMediaTime'>,
  window: { from: number; seconds: number; stepSec?: number },
): Promise<LatencySample[]> {
  const { from, seconds, stepSec = 1 } = window;
  const samples: LatencySample[] = [];
  for (let elapsed = stepSec; elapsed <= seconds; elapsed += stepSec) {
    await qa.waitForMediaTime(from + elapsed);
    const metrics = await qa.metrics();
    samples.push({ mediaTime: metrics.playback.currentTime, latencyMs: metrics.live.latencyMs });
  }
  return samples;
}

/** The values of a series that were measured, in order. */
export function measuredLatencies(samples: readonly LatencySample[]): number[] {
  return samples.flatMap((sample) => (sample.latencyMs === null ? [] : [sample.latencyMs]));
}

/** Nearest-rank percentile (`p` in 0..100) of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/** `+1 s 6150 ms, +2 s 6149 ms, ...`: the series as a line of a failure message, to be read as a plot. */
export function describeSeries(samples: readonly LatencySample[], from: number): string {
  if (samples.length === 0) return 'no samples';
  return samples
    .map(
      (sample) =>
        `+${(sample.mediaTime - from).toFixed(0)} s ${sample.latencyMs === null ? 'n/a' : `${Math.round(sample.latencyMs)} ms`}`,
    )
    .join(', ');
}
