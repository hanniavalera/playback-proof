import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// tools/docker/pw.sh runs commands in the Playwright image that matches the pinned @playwright/test. These tests keep the
// image tag and the pin from drifting apart and check the docker command line the script builds, without needing Docker:
// `--dry-run` prints the commands instead of running them.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'tools', 'docker', 'pw.sh');
const ENTRY = join(ROOT, 'tools', 'docker', 'pw-entry.sh');
const scratch = mkdtempSync(join(ROOT, '.cache', 'unit-docker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const pinned = packageJson.devDependencies['@playwright/test'] ?? '';
const scriptText = readFileSync(SCRIPT, 'utf8');
const imageMatch = /^PW_IMAGE="([^"]+)"$/m.exec(scriptText);

/** A copy of the script inside its own fake checkout, whose package.json pins the given Playwright version. */
function checkout(name: string, pin: string): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'tools', 'docker'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tools', 'docker', 'pw.sh'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': pin } }));
  return join(dir, 'tools', 'docker', 'pw.sh');
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  for (const name of ['PB_DOCKER_CPUS', 'PB_DOCKER_ENV', 'PB_ENV_ID', 'CI']) delete clean[name];
  const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...clean, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function volumeOf(script: string): string {
  const line = run(script, ['--dry-run', '--clean']).stdout.trim();
  return /^docker volume rm -f (\S+)$/.exec(line)?.[1] ?? '';
}

describe('the image tag and the Playwright pin', () => {
  it('names an image whose Playwright version is the one pinned in package.json', () => {
    expect(imageMatch, 'PW_IMAGE="..." must be a single line in tools/docker/pw.sh').not.toBeNull();
    const version = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-[a-z]+$/.exec(
      imageMatch?.[1] ?? '',
    )?.[1];
    expect(version, `unexpected image name ${imageMatch?.[1]}`).toBeDefined();
    expect(
      pinned,
      '@playwright/test must be pinned exactly (no ^ or ~): the image has exactly one version',
    ).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(pinned);
  });

  it('matches the version the lockfile installs', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    expect(lock.packages['node_modules/@playwright/test']?.version).toBe(pinned);
  });

  it('is enforced by the script itself on every run, not only by this test', () => {
    const drifted = run(checkout('drifted', '9.9.9'), ['--dry-run', 'echo', 'hi']);
    expect(drifted.status).toBe(3);
    expect(drifted.stderr).toContain("does not match the pinned @playwright/test ('9.9.9')");
    expect(drifted.stdout).toBe('');
    const ranged = run(checkout('ranged', `^${pinned}`), ['--dry-run', 'echo', 'hi']);
    expect(ranged.status).toBe(3);
    const agreeing = run(checkout('agreeing', pinned), ['--dry-run', 'echo', 'hi']);
    expect(agreeing.status).toBe(0);
  });
});

describe('the docker command line', () => {
  const script = checkout('cmdline', pinned);
  const dry = (args: string[], env?: Record<string, string>) => run(script, ['--dry-run', ...args], env);

  it('shares the host IPC namespace, limits CPUs (4 by default), mounts the checkout at /work and removes the container', () => {
    const { status, stdout } = dry(['npm', 'run', 'codec-matrix', '--', '--browsers', 'chromium']);
    expect(status).toBe(0);
    const run = stdout.split('\n').find((line) => line.startsWith('docker run')) ?? '';
    expect(run).toContain(' --rm ');
    expect(run).toContain(' --init ');
    expect(run).toContain(' --ipc=host ');
    expect(run).toContain(' --cpus=4 ');
    expect(run).toContain(' -w /work ');
    expect(run).toMatch(/ -v \S+\/cmdline:\/work /);
    expect(run).toContain(
      `mcr.microsoft.com/playwright:v${pinned}-noble bash /work/tools/docker/pw-entry.sh npm run codec-matrix -- --browsers chromium`,
    );
  });

  it('makes the CPU limit configurable, by option or by environment', () => {
    expect(dry(['--cpus', '2', 'true']).stdout).toContain(' --cpus=2 ');
    expect(dry(['--cpus=1.5', 'true']).stdout).toContain(' --cpus=1.5 ');
    expect(dry(['true'], { PB_DOCKER_CPUS: '6' }).stdout).toContain(' --cpus=6 ');
  });

  it('passes the environment id through (and only names it: docker copies the value when it is set)', () => {
    const { stdout } = dry(['true'], { PB_ENV_ID: 'custom-env' });
    expect(stdout).toContain(' -e PB_ENV_ID ');
    expect(stdout).not.toContain('custom-env');
    expect(stdout).toContain(' -e PB_DOCKER_PW=1 ');
  });

  it('runs as the host user so that files written into the mounted repository belong to it', () => {
    const { stdout } = dry(['true']);
    const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
    expect(stdout).toContain(` -e PB_HOST_UID=${uid} `);
    expect(stdout).toMatch(/ -e PB_HOST_GID=\d+ /);
  });

  it("keeps the container's node_modules in a named volume mounted over the checkout's", () => {
    const { stdout } = dry(['true']);
    const volume = /-v (pb-nm-\S+):\/work\/node_modules/.exec(stdout)?.[1];
    expect(volume).toBeDefined();
    expect(stdout).toContain(`docker volume create ${volume}`);
  });

  it('passes extra variables named in PB_DOCKER_ENV', () => {
    expect(dry(['true'], { PB_DOCKER_ENV: 'FOO BAR' }).stdout).toMatch(/ -e FOO -e BAR /);
  });

  it('refuses nonsense: no command, a bad CPU count, an unknown option', () => {
    expect(run(script, []).status).toBe(2);
    expect(dry(['--cpus', 'lots', 'true']).status).toBe(2);
    expect(dry(['--cpus', '0', 'true']).status).toBe(2);
    expect(dry(['--frobnicate', 'true']).status).toBe(2);
    expect(dry(['--frobnicate', 'true']).stderr).toContain('unknown option');
  });

  it('prints its header comment as the help text', () => {
    const { status, stdout } = run(script, ['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('npm run docker:pw -- [--cpus N] [--dry-run] [--clean]');
  });
});

describe('the node_modules volume', () => {
  it('is derived from the checkout path, so worktrees do not share one', () => {
    const a = volumeOf(checkout('worktree-a', pinned));
    const b = volumeOf(checkout('worktree-b', pinned));
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
    expect(volumeOf(checkout('worktree-a', pinned))).toBe(a);
  });

  it('is a valid docker volume name that says which checkout it belongs to', () => {
    const name = volumeOf(checkout('my repo (copy)', pinned));
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    expect(name).toMatch(/^pb-nm-my-repo--copy--[0-9a-f]{10}$/);
  });
});

describe('the scripts', () => {
  it.each([SCRIPT, ENTRY])('%s is valid bash', (file) => {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it("installs dependencies only when the lockfile (or the image's Node) changed", () => {
    const entry = readFileSync(ENTRY, 'utf8');
    expect(entry).toContain('sha256sum package-lock.json');
    expect(entry).toContain('node -v');
    expect(entry).toContain('.pb-docker-stamp');
    expect(entry).toContain('npm ci');
  });
});
