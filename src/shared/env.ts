import { existsSync } from 'node:fs';

/**
 * Identifies the machine class a measurement was taken on. Performance baselines are keyed by it: a number measured on a
 * laptop says nothing about a CI runner, so they are never compared across environments (docs/DESIGN_DECISIONS.md, ADR-004).
 *
 *   PB_ENV_ID=...                 explicit override
 *   gha-<os>-<arch>               GitHub Actions (os: linux | macos | windows, from RUNNER_OS)
 *   jenkins-<platform>-<arch>     Jenkins (JENKINS_URL is set)
 *   docker-<platform>-<arch>      any other container (/.dockerenv exists)
 *   local-<platform>-<arch>       a developer machine
 */
export function detectEnvId(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  arch = process.arch,
): string {
  if (env.PB_ENV_ID) return env.PB_ENV_ID;
  if (env.GITHUB_ACTIONS === 'true') {
    const os = (env.RUNNER_OS ?? platform).toLowerCase();
    const a = (env.RUNNER_ARCH ?? arch).toLowerCase();
    return `gha-${os}-${a}`;
  }
  if (env.JENKINS_URL) return `jenkins-${platform}-${arch}`;
  if (existsSync('/.dockerenv')) return `docker-${platform}-${arch}`;
  return `local-${platform}-${arch}`;
}
