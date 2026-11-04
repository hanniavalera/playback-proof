import type { HostInfo } from '../probe/host-info.ts';
import type { BaselineMachine, PerfHost } from './baseline.ts';

// What the harness records about the machine it ran on, besides the host facts of `collectHostInfo`: the CPU model, how it was started (on
// the host or in the Playwright container, and with which CPU limit), what `perf/quiet.ts` did before it started (the wait for a quiet
// machine), and the load average at both ends of the profile. Pure: the environment is passed in.

/** The load average at the two ends of a profile: when its first batch started and when its last batch ended (batches in the order they ran). */
export function loadAround(batches: readonly { loadAverage: { before: number; after: number } }[]): {
  before: number;
  after: number;
} {
  const first = batches[0];
  const last = batches[batches.length - 1];
  return { before: first?.loadAverage.before ?? 0, after: last?.loadAverage.after ?? 0 };
}

/** `PB_QUIET_*` is what perf/quiet.ts hands to the command it starts; `PB_DOCKER_PW` and `PB_DOCKER_CPUS` are what tools/docker/pw.sh hands to the container. */
export function machineFacts(
  env: NodeJS.ProcessEnv,
  load: { before: number; after: number },
): BaselineMachine {
  const viaDocker = env.PB_DOCKER_PW === '1';
  const cpus = Number(env.PB_DOCKER_CPUS);
  const maxLoad = Number(env.PB_QUIET_MAX_LOAD);
  const hostLoad = Number(env.PB_QUIET_HOST_LOAD);
  const waitedMs = Number(env.PB_QUIET_WAITED_MS);
  const quiet =
    env.PB_QUIET_MAX_LOAD !== undefined &&
    env.PB_QUIET_HOST_LOAD !== undefined &&
    env.PB_QUIET_WAITED_MS !== undefined &&
    Number.isFinite(maxLoad) &&
    Number.isFinite(hostLoad) &&
    Number.isFinite(waitedMs)
      ? { maxLoad, hostLoad, waitedMs }
      : null;
  return {
    invokedVia: viaDocker ? 'docker:pw' : 'direct',
    dockerCpus: viaDocker && Number.isFinite(cpus) && cpus > 0 ? cpus : null,
    quiet,
    loadBeforeProfile: load.before,
    loadAfterProfile: load.after,
  };
}

/**
 * The CPU model as one line: the model of the first CPU the OS lists, trimmed and with its runs of whitespace collapsed (some firmware
 * pads the name). Undefined where the OS names none: an empty list, an empty name, or `unknown`, which is what libuv reports where
 * /proc/cpuinfo has no model name (Linux on arm64: the Playwright container on an Apple-silicon host says it). A placeholder is not a
 * model, and recording it would make "unknown" differ from a real name.
 */
export function cpuModelOf(cpus: readonly { model: string }[]): string | undefined {
  const model = (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim();
  return model === '' || model.toLowerCase() === 'unknown' ? undefined : model;
}

/** The host facts of a perf result: those of every probe, and the CPU model when the OS names one. */
export function perfHost(info: HostInfo, cpus: readonly { model: string }[]): PerfHost {
  const cpuModel = cpuModelOf(cpus);
  return cpuModel === undefined ? info : { ...info, cpuModel };
}

/** What the gate says when the CPU model of the baseline and of this machine are both known and differ. A hint, never a verdict. */
export const CPU_MODEL_DIFFERS_NOTE =
  'the CPU model differs from the one the baseline was recorded on: a difference in startup of that size may be the machine';

/** Which CPU model the baseline came from and which one this run is on, as the gate reports them in every format. */
export interface CpuModels {
  /** The model the baseline was recorded on; null when it does not say (recorded before the field existed) or there is no baseline. */
  baseline: string | null;
  /** The model of this machine; null when the OS does not name one. */
  current: string | null;
  /** Both are known and they are not the same model. */
  differs: boolean;
  /** `baseline machine: <model or 'not recorded'>; this machine: <model>`, the same words in the terminal, the Markdown and the JSON. */
  line: string;
  /** `CPU_MODEL_DIFFERS_NOTE` when `differs`, otherwise null. */
  note: string | null;
}

/** `baseline` is the host facts of the baseline the run is compared with, or null when there is none. Changes no verdict and no threshold. */
export function compareCpuModels(
  baseline: { cpuModel?: string } | null,
  current: string | undefined,
): CpuModels {
  const recorded = baseline?.cpuModel ?? null;
  const here = current ?? null;
  const differs = recorded !== null && here !== null && recorded !== here;
  const baselineText = baseline === null ? 'no baseline' : (recorded ?? 'not recorded');
  return {
    baseline: recorded,
    current: here,
    differs,
    line: `baseline machine: ${baselineText}; this machine: ${here ?? 'unknown'}`,
    note: differs ? CPU_MODEL_DIFFERS_NOTE : null,
  };
}
