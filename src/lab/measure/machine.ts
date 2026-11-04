import type { BaselineMachine } from './baseline.ts';

// What the harness records about the machine it ran on, besides the host facts of `collectHostInfo`: how it was started (on the host or in
// the Playwright container, and with which CPU limit), what `perf/quiet.ts` did before it started (the wait for a quiet machine), and
// the load average at both ends of the profile. Pure: the environment is passed in.

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
