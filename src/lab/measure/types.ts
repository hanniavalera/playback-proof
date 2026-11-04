import type { FaultRule } from '../../shared/faults.ts';
import type { ProfileName } from '../../shared/profiles.ts';
import type { Protocol, StreamId } from '../../shared/streams.ts';
import type { RuleKey } from './rules.ts';

// The shapes the measurement library, the baseline files, the decision logic and the reports share. Nothing here needs a browser.

/** The profiles of TEST_STRATEGY.md: one browser engine each, and the Chromium that is slowed down to stand in for a low-end television. */
export const PERF_PROFILES = ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'] as const;
export type PerfProfile = (typeof PERF_PROFILES)[number];
export type PerfEngine = 'chromium' | 'firefox' | 'webkit';

export function isPerfProfile(value: string): value is PerfProfile {
  return (PERF_PROFILES as readonly string[]).includes(value);
}

/** The Playwright engine that runs a profile. */
export function engineOf(profile: PerfProfile): PerfEngine {
  return profile === 'chromium-cpu4x' ? 'chromium' : profile;
}

/** The CPU slowdown of a profile (`Emulation.setCPUThrottlingRate`), or null when it runs at full speed. */
export function cpuThrottleOf(profile: PerfProfile): number | null {
  return profile === 'chromium-cpu4x' ? 4 : null;
}

export type MetricUnit = 'ms' | 'fps' | 'ratio' | 'count';

/** One number a scenario yields per run. */
export interface MetricSpec {
  /** The key in `RunRecord.values` and in the baseline files: `startupMs`, `fps`, `rebufferCount`... */
  id: string;
  label: string;
  unit: MetricUnit;
  /** The rule that gates it (src/lab/measure/rules.ts), or null: the metric is tracked and reported on every build but never blocks. */
  rule: RuleKey | null;
}

/** What a scenario is, as data: everything the baseline and the decision logic need, nothing that needs a browser. */
export interface ScenarioSpec {
  /** The catalog id (TEST_STRATEGY.md section 9): `PB-PERF-001`. */
  id: string;
  /** A short name for tables and file names: `startup`. */
  name: string;
  /** The catalog row's scenario, in a line. */
  title: string;
  /** The profiles the catalog says it runs on. */
  profiles: readonly PerfProfile[];
  /** The named condition of src/shared/profiles.ts the session is created with. */
  faultProfile: ProfileName;
  protocol: Protocol;
  /** The rung height the scenario holds (ABR off) for its measured window, or null when it leaves the player's own adaptation alone. */
  pinnedHeight: number | null;
  /**
   * Whether the number that matters is taken in the first seconds after load, so the rung the player STARTED on decides what it measures.
   * Then the baseline and the batch under test must have started on the same rung, or their medians are not comparable.
   */
  startRungMatters: boolean;
  metrics: readonly MetricSpec[];
}

/** One change of the active video variant, as `window.__qa` records it (`QAMetrics.bitrate.history`). */
export interface RungChange {
  t: number;
  from: number | null;
  to: number;
  height: number | null;
  reason: 'start' | 'abr' | 'manual';
}

/** One run of a scenario in a fresh browser context. */
export interface RunRecord {
  /** The value of every metric of the scenario; null when this run could not produce it (an engine without the API behind it). */
  values: Record<string, number | null>;
  /** The height of the rung the player started on (the `start` entry of the rung history), null when it was not recorded. */
  startRungHeight: number | null;
  /** Every change of the active rung during the run, in order: the start is the first entry. */
  rungs: RungChange[];
  /** Wall-clock of the run, from the session's creation to its deletion, ms. */
  durationMs: number;
  /** The Shaka error events of the run, as `code name/severity` (empty on a healthy run). */
  errors: string[];
}

/** One batch: a warm-up and N measured runs of one scenario in one browser process. */
export interface BatchMeasurement {
  scenarioId: string;
  profile: PerfProfile;
  stream: StreamId;
  protocol: Protocol;
  faultProfile: ProfileName;
  pinnedHeight: number | null;
  /** The first run of the batch, executed like the others and left out of every statistic (ADR-120). Null when the policy has none. */
  warmup: RunRecord | null;
  runs: RunRecord[];
  /** The load average (1 minute) of the machine before and after the batch: a number that says the machine was not quiet. */
  loadAverage: { before: number; after: number };
  /** Fault rules added to every session of the batch ON PURPOSE (the sensitivity check). Absent in every normal batch: a batch that has them is not a baseline. */
  injectedFaults?: FaultRule[];
  startedAt: string;
  finishedAt: string;
}
