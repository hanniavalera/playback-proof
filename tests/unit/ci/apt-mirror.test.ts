import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, code, read } from '../support/ci-files.ts';
import { makeScratch } from '../support/scratch.ts';

// ADR-180: the setup action measures the first apt mirror of a hosted runner on one real package and puts the next one in front when it
// is slow. The script is run here for real, with a `curl` that answers from a table and the mirror list in a scratch directory, so every
// branch of the decision is checked without a network.

const SCRIPT = join(ROOT, '.github/actions/setup/apt-mirror.sh');
const AZURE = 'http://azure.archive.ubuntu.com/ubuntu/';
const ARCHIVE = 'https://archive.ubuntu.com/ubuntu/';
const SECURITY = 'https://security.ubuntu.com/ubuntu/';
const HOSTED_LIST = [AZURE, ARCHIVE, SECURITY];

const FAST = [206, 53_809_984] as const;
const SLOW = [206, 51_234] as const; // what a 15 s probe of the mirror of 4 Nov measured, about 50 kB/s
const NOT_FOUND = [404, 7_624] as const;
const UNREACHABLE = ['000', 0] as const;

const scratch = makeScratch('apt-mirror-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The stand-in for curl prints what `-w '%{http_code} %{speed_download}'` would, for the first row whose prefix starts the URL.
const CURL = `#!/usr/bin/env bash
for arg in "$@"; do url=$arg; done
printf '%s\\n' "$*" >> "$STUB_LOG"
while read -r prefix status speed; do
  case "$url" in "$prefix"*) printf '%s %s' "$status" "$speed"; exit 0 ;; esac
done < "$STUB_ANSWERS"
printf '000 0'
exit 7
`;

let n = 0;
function run(
  list: string[],
  answers: Record<string, readonly [number | string, number]>,
  env: Record<string, string> = {},
) {
  const dir = join(scratch, `case-${n++}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'curl'), CURL);
  chmodSync(join(dir, 'bin', 'curl'), 0o755);
  const mirrors = join(dir, 'apt-mirrors.txt');
  writeFileSync(mirrors, list.map((url, i) => `${url}\tpriority:${i + 1}\n`).join(''));
  writeFileSync(
    join(dir, 'answers.txt'),
    Object.entries(answers)
      .map(([prefix, [status, speed]]) => `${prefix} ${status} ${speed}\n`)
      .join(''),
  );
  const stdout = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      PB_APT_MIRRORS_FILE: mirrors,
      PB_APT_SUDO: '',
      STUB_LOG: join(dir, 'curl.log'),
      STUB_ANSWERS: join(dir, 'answers.txt'),
      ...env,
    },
  });
  const after = readFileSync(mirrors, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, 'curl.log'), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    // the script never called curl
  }
  return { stdout, after, calls };
}

describe('the apt mirror check of the setup action', () => {
  it('keeps the list when the first mirror is fast, and asks nothing of the others', () => {
    const { stdout, after, calls } = run(HOSTED_LIST, { [AZURE]: FAST });
    expect(after).toEqual(HOSTED_LIST.map((url, i) => `${url}\tpriority:${i + 1}`));
    expect(stdout).toContain('the list is kept');
    expect(calls).toHaveLength(1);
  });

  it('puts the next mirror first when the first is slow, as on 4 Nov, and keeps the order of the rest', () => {
    const { stdout, after } = run(HOSTED_LIST, { [AZURE]: SLOW, [ARCHIVE]: FAST });
    expect(after).toEqual([`${ARCHIVE}\tpriority:1`, `${AZURE}\tpriority:2`, `${SECURITY}\tpriority:3`]);
    expect(stdout).toContain(`::warning::apt mirror: ${AZURE} served the probe at ${SLOW[1]} B/s`);
    expect(stdout).toContain(`${ARCHIVE} is now the first mirror`);
  });

  it('moves past a mirror that does not answer, and past one that is as slow as the first', () => {
    const unreachable = run(HOSTED_LIST, { [AZURE]: UNREACHABLE, [ARCHIVE]: FAST });
    expect(unreachable.after[0]).toBe(`${ARCHIVE}\tpriority:1`);
    const twoSlow = run(HOSTED_LIST, { [AZURE]: SLOW, [ARCHIVE]: SLOW, [SECURITY]: FAST });
    expect(twoSlow.after).toEqual([
      `${SECURITY}\tpriority:1`,
      `${AZURE}\tpriority:2`,
      `${ARCHIVE}\tpriority:3`,
    ]);
  });

  it('keeps the list, and says so, when no mirror of it is fast: a switch would only add a probe to the wait', () => {
    const { stdout, after } = run(HOSTED_LIST, { [AZURE]: SLOW, [ARCHIVE]: SLOW, [SECURITY]: NOT_FOUND });
    expect(after[0]).toBe(`${AZURE}\tpriority:1`);
    expect(stdout).toContain('::warning::apt mirror: no other mirror of the list was fast either');
  });

  it('does not take a missing probe file for a slow mirror: an answer other than a download says nothing about the speed', () => {
    const { stdout, after } = run(HOSTED_LIST, { [AZURE]: NOT_FOUND, [ARCHIVE]: FAST });
    expect(after[0]).toBe(`${AZURE}\tpriority:1`);
    expect(stdout).toContain('says nothing about its speed');
  });

  it('has nothing to choose between with one mirror, or without a list', () => {
    expect(run([AZURE], { [AZURE]: SLOW }).stdout).toContain('nothing to choose between');
    const { stdout } = run(HOSTED_LIST, {}, { PB_APT_MIRRORS_FILE: join(scratch, 'no-such-list.txt') });
    expect(stdout).toContain('no mirror list');
  });

  it('asks for the first 4 MiB of one package, for at most the probe time, and the limit is a variable', () => {
    const { calls, after } = run(
      HOSTED_LIST,
      { [AZURE]: [206, 5_000_000], [ARCHIVE]: FAST },
      { PB_APT_MIN_BYTES_PER_S: '10000000' },
    );
    expect(after[0]).toBe(`${ARCHIVE}\tpriority:1`);
    expect(calls[0]).toContain('-r 0-4194303');
    expect(calls[0]).toContain('--max-time 15');
    expect(calls[0]).toContain(`${AZURE}pool/universe/f/fonts-wqy-zenhei/`);
  });
});

describe('the setup action', () => {
  const action = read('.github/actions/setup/action.yml');

  it('checks the apt mirror on Linux before anything uses apt', () => {
    const check = action.indexOf('bash "$GITHUB_ACTION_PATH/apt-mirror.sh"');
    expect(check).toBeGreaterThan(0);
    expect(action.slice(0, check)).toMatch(/if: runner\.os == 'Linux'/);
    expect(check).toBeLessThan(action.indexOf('- name: Install ffmpeg'));
    expect(check).toBeLessThan(action.indexOf('- name: Install the Playwright browser'));
  });

  it('kills no process to bound apt: a kill from outside left an apt-get running as root, holding the dpkg lock', () => {
    expect(code(action)).not.toMatch(/\bkill\b|\btimeout\b|\bpkill\b/);
    expect(code(read('.github/actions/setup/apt-mirror.sh'))).not.toMatch(/\bkill\b|\bpkill\b/);
  });
});
