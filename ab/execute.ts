import type { HostInfo } from '../src/lab/probe/host-info.ts';
import type { StreamId } from '../src/shared/streams.ts';
import { runCondition } from './experiment.ts';
import type { ExperimentDeps } from './experiment.ts';
import type { LoadedPreregistration } from './prereg.ts';
import { RESULT_SCHEMA_VERSION } from './results.ts';
import type { BrowserRecord, ConditionResult, PreregistrationProvenance, RawResult } from './results.ts';

// The whole run of a pre-registration: its conditions one after the other, and the raw results file made of them. Everything that needs the
// machine (the service, the browser, git) arrives through `deps` and `environment`, so that this is unit-tested with fakes.

/** What a run takes from the machine: ab/harness.ts is the real one (a service child process and the engine's launcher), the tests bring fakes. */
export interface Machine {
  envId: string;
  host: HostInfo;
  ffmpeg: string;
  /** The content hash of every stream the service holds. */
  streams: Partial<Record<StreamId, string>>;
  deps: Omit<ExperimentDeps, 'onProgress'>;
  /** Stops the service. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ExecuteInput {
  loaded: LoadedPreregistration;
  /** What git said about the plan's file (see ab/provenance.ts). */
  committed: PreregistrationProvenance['committed'];
  /** The command line, for the record. */
  command: string;
  /** Run only this condition of the plan. */
  condition?: string | null;
  environment: {
    envId: string;
    host: HostInfo;
    ffmpeg: string;
    streams: Partial<Record<StreamId, string>>;
  };
}

/** Runs the conditions of the plan in order and returns the raw results. A defect of the harness (`HarnessError`) propagates: nothing partial is passed off as a result. */
export async function executeExperiment(input: ExecuteInput, deps: ExperimentDeps): Promise<RawResult> {
  const now = deps.now ?? ((): Date => new Date());
  const { prereg } = input.loaded;
  const wanted = input.condition ?? null;
  const conditions = prereg.conditions.filter((condition) => wanted === null || condition.id === wanted);
  if (conditions.length === 0)
    throw new RangeError(
      `the pre-registration has no condition "${String(wanted)}" (it has ${prereg.conditions.map((c) => c.id).join(', ')})`,
    );
  const startedAt = now().toISOString();
  const results: ConditionResult[] = [];
  let browser: BrowserRecord | null = null;
  for (const condition of conditions) {
    const run = await runCondition(prereg, condition, deps);
    results.push(run.result);
    browser ??= run.browser;
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: 'ab-raw',
    preregistration: {
      path: input.loaded.path,
      sha256: input.loaded.sha256,
      text: input.loaded.text,
      committed: input.committed,
    },
    environment: {
      envId: input.environment.envId,
      host: input.environment.host,
      browser: browser as BrowserRecord,
      ffmpeg: input.environment.ffmpeg,
      streams: input.environment.streams,
    },
    run: { startedAt, finishedAt: now().toISOString(), command: input.command },
    conditions: results,
  };
}
