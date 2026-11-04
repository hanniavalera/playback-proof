import type { AnalysisPlan } from '../../../ab/analyze.ts';
import type { MetricPlan } from '../../../ab/prereg.ts';
import { sha256Hex } from '../../../ab/prereg.ts';
import { RESULT_SCHEMA_VERSION } from '../../../ab/results.ts';
import type { RawResult } from '../../../ab/results.ts';
import type { FaultRule } from '../../../src/shared/faults.ts';
import type { Random } from '../../../ab/stats/random.ts';
import type { ArmId, SessionRecord } from '../../../ab/types.ts';
import { gaussian } from './helpers.ts';

// Synthetic sessions for the analysis, the A/A calibration and the report: values chosen by the test, so that what the pipeline should
// say is known in advance.

/** A raw results file around some sessions: the plan text, its hash, a made-up environment. */
export function buildRaw(
  prereg: { text: string; conditionId: string; rules: FaultRule[] },
  sessions: SessionRecord[],
  over: Partial<RawResult['preregistration']> = {},
): RawResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: 'ab-raw',
    preregistration: {
      path: 'ab/prereg/plan.json',
      sha256: sha256Hex(prereg.text),
      text: prereg.text,
      committed: { clean: true, commit: 'abc1234', date: '2026-11-05T08:00:00Z' },
      ...over,
    },
    environment: {
      envId: 'local-darwin-arm64',
      host: {
        os: { platform: 'darwin', arch: 'arm64', release: '27.2', name: 'macOS 27.2' },
        cpus: 12,
        memoryGiB: 16,
        node: 'v22.11.0',
        playwright: '1.64.1',
        git: { commit: 'def5678', dirty: false },
      },
      browser: { name: 'chromium', version: '156.0.8078.4', userAgent: 'Mozilla/5.0 Chrome/156' },
      ffmpeg: '9.0.2',
      streams: { 'vod-cmaf': 'f00dfeed' },
    },
    run: {
      startedAt: '2026-11-05T09:00:00.000Z',
      finishedAt: '2026-11-05T09:31:00.000Z',
      command: 'npm run ab -- --prereg ab/prereg/plan.json',
    },
    conditions: [
      {
        id: prereg.conditionId,
        rules: prereg.rules,
        stream: 'vod-cmaf',
        startedAt: '2026-11-05T09:00:00.000Z',
        finishedAt: '2026-11-05T09:31:00.000Z',
        loadAverage: { before: 1.1, after: 1.4 },
        sessions,
        aborted: null,
      },
    ],
  };
}

export function makeSession(
  index: number,
  arm: ArmId,
  values: Record<string, number | null>,
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    index,
    block: Math.floor(index / 2),
    arm,
    config: arm,
    condition: 'high-latency',
    warmup: false,
    status: 'ok',
    values,
    startRungHeight: arm === 'A' ? 720 : 240,
    rungs: [],
    errors: [],
    info: null,
    sessionId: `s${index}`,
    startedAt: '2026-11-05T09:00:00.000Z',
    durationMs: 4000,
    ...extra,
  };
}

/** The sessions of two arms as the runner interleaves them (A, B, B, A, A, B, ...), one record per value. */
export function interleaved(
  a: readonly Record<string, number | null>[],
  b: readonly Record<string, number | null>[],
  extra: (arm: ArmId, i: number) => Partial<SessionRecord> = () => ({}),
): SessionRecord[] {
  const sessions: SessionRecord[] = [];
  const blocks = Math.max(a.length, b.length);
  for (let block = 0; block < blocks; block++) {
    const order: ArmId[] = block % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    for (const arm of order) {
      const values = arm === 'A' ? a[block] : b[block];
      if (values === undefined) continue;
      sessions.push(makeSession(sessions.length, arm, values, { block, ...extra(arm, block) }));
    }
  }
  return sessions;
}

export const startupOnly = (values: readonly number[]): Record<string, number | null>[] =>
  values.map((startupMs) => ({ startupMs }));

export const startupMetric = (over: Partial<MetricPlan> = {}): MetricPlan => ({
  id: 'startupMs',
  role: 'primary',
  direction: 'lower-is-better',
  practicalThreshold: 100,
  thresholdBasis: 'A tenth of a second.',
  ...over,
});

export const shareMetric = (over: Partial<MetricPlan> = {}): MetricPlan => ({
  id: 'rebufferShare',
  role: 'primary',
  direction: 'lower-is-better',
  practicalThreshold: 0.2,
  thresholdBasis: 'One session in five.',
  ...over,
});

/** A plan with a small bootstrap, so that the unit tests do not wait for 5000 resamples of every metric. */
export function plan(metrics: MetricPlan[], over: Partial<AnalysisPlan> = {}): AnalysisPlan {
  return {
    kind: 'experiment',
    alpha: 0.05,
    confidenceLevel: 0.95,
    bootstrapResamples: 400,
    seed: 20261104,
    metrics,
    maxFailedShare: 0.1,
    ...over,
  };
}

/**
 * A pool of sessions of ONE configuration, as an A/A pilot would collect them: right-skewed startup times, rebuffer counts that are zero
 * in most sessions, a ratio that follows the count. `drift` adds that many ms of startup per session: machine load that creeps up.
 */
export function aaPool(random: Random, size: number, drift = 0): SessionRecord[] {
  const pool: SessionRecord[] = [];
  for (let i = 0; i < size; i++) {
    const [noise] = gaussian(random, 1);
    const startupMs = Math.round(900 * Math.exp(0.25 * (noise as number)) + drift * i);
    const stalls = random() < 0.25 ? 1 + Math.floor(random() * 3) : 0;
    pool.push(
      makeSession(
        i,
        i % 2 === 0 ? 'A' : 'B',
        {
          startupMs,
          rebufferCount: stalls,
          rebufferMs: stalls * Math.round(500 + random() * 1500),
          rebufferRatio: stalls === 0 ? 0 : Math.round((0.02 + random() * 0.1) * 1000) / 1000,
          switches: 1 + Math.floor(random() * 3),
          droppedRatio: 0,
        },
        { config: 'A', startRungHeight: 720 },
      ),
    );
  }
  return pool;
}
