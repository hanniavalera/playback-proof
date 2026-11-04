import type { SessionRecord } from './types.ts';

// The metrics an A/B session yields and how each is compared. The definitions are those of docs/METRICS.md (startup time, rebuffer count,
// duration and ratio, bitrate switches, dropped frames); the one metric defined here is the SHARE of sessions with at least one rebuffer,
// which turns the count into a yes/no so that a few stalls in a few sessions cannot hide in a median of zeros.

export const METRIC_IDS = [
  'startupMs',
  'rebufferCount',
  'rebufferMs',
  'rebufferRatio',
  'rebufferShare',
  'switches',
  'droppedRatio',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricUnit = 'ms' | 'ratio' | 'count' | 'share';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  unit: MetricUnit;
  /**
   * `continuous`: one number per session, compared with the Mann-Whitney test, the Hodges-Lehmann shift (bootstrap interval) and Cliff's
   * delta. `binary`: 0 or 1 per session, compared with Fisher's exact test and the difference of the shares (Newcombe's interval).
   */
  kind: 'continuous' | 'binary';
  /** Whether the number exists only after the player has played for a while (so the session must observe more than the first frame). */
  needsPlayback: boolean;
  definition: string;
}

export const METRICS: Readonly<Record<MetricId, MetricDefinition>> = {
  startupMs: {
    id: 'startupMs',
    label: 'Startup time',
    unit: 'ms',
    kind: 'continuous',
    needsPlayback: false,
    definition: 'ms from load-requested to the first video frame presented (docs/METRICS.md)',
  },
  rebufferCount: {
    id: 'rebufferCount',
    label: 'Rebuffer count',
    unit: 'count',
    kind: 'continuous',
    needsPlayback: true,
    definition: 'stalls that began after the first frame and outside a seek (docs/METRICS.md)',
  },
  rebufferMs: {
    id: 'rebufferMs',
    label: 'Rebuffer duration',
    unit: 'ms',
    kind: 'continuous',
    needsPlayback: true,
    definition: 'sum of the durations of those stalls, ms',
  },
  rebufferRatio: {
    id: 'rebufferRatio',
    label: 'Rebuffer ratio',
    unit: 'ratio',
    kind: 'continuous',
    needsPlayback: true,
    definition: 'stalled time / (stalled time + time playing) since the first frame',
  },
  rebufferShare: {
    id: 'rebufferShare',
    label: 'Share of sessions with a rebuffer',
    unit: 'share',
    kind: 'binary',
    needsPlayback: true,
    definition: 'the share of sessions with a rebuffer count of at least 1',
  },
  switches: {
    id: 'switches',
    label: 'Rung switches',
    unit: 'count',
    kind: 'continuous',
    needsPlayback: true,
    definition: 'changes of the active video variant after the initial selection',
  },
  droppedRatio: {
    id: 'droppedRatio',
    label: 'Dropped-frame ratio',
    unit: 'ratio',
    kind: 'continuous',
    needsPlayback: true,
    definition: 'dropped / decoded video frames over the session',
  },
};

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && (METRIC_IDS as readonly string[]).includes(value);
}

/** The value of a metric in a session, or null when the session could not measure it. */
export function metricValue(session: Pick<SessionRecord, 'values'>, id: MetricId): number | null {
  if (id === 'rebufferShare') {
    const count = session.values.rebufferCount;
    return count === null || count === undefined ? null : count >= 1 ? 1 : 0;
  }
  const value = session.values[id];
  return value === null || value === undefined ? null : value;
}

/** `toFixed` without the trailing zeros of the fraction ("1.50" -> "1.5", "2.00" -> "2"), and without touching an integer ("100"). */
const trim = (value: number, digits: number): string => {
  const text = value.toFixed(digits);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

/** A value of a metric in words: `312 ms`, `0.62 %` of the time, `23.3 %` of the sessions, `0.4` rebuffers. */
export function formatValue(unit: MetricUnit, value: number): string {
  switch (unit) {
    case 'ms':
      return `${trim(value, Math.abs(value) >= 100 ? 0 : 1)} ms`;
    case 'ratio':
      return `${trim(value * 100, 2)} %`;
    case 'share':
      return `${trim(value * 100, 1)} %`;
    case 'count':
      return trim(value, 2);
  }
}

/** A DIFFERENCE between arms (B minus A), signed: `+142 ms`, `-0.50 pp` (percentage points of a ratio or a share), `+0.4`. */
export function formatDifference(unit: MetricUnit, value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const size = Math.abs(value);
  switch (unit) {
    case 'ms':
      return `${sign}${trim(size, size >= 100 ? 0 : 1)} ms`;
    case 'ratio':
    case 'share':
      return `${sign}${trim(size * 100, unit === 'share' ? 1 : 2)} pp`;
    case 'count':
      return `${sign}${trim(size, 2)}`;
  }
}
