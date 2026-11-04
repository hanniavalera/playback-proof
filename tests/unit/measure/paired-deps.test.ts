import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { realPairedDeps } from '../../../perf/paired-deps.ts';

// The real effects of the paired gate, against real child processes and a scratch directory in the repository's own gitignored .tmp:
// what the injected tests of paired.ts cannot show is that a command ends with its exit code, that an abort or a timeout stops the WHOLE
// process group (npm and what it started), and that removing a link never touches what it points to. No browser, no git, no network.

const SCRATCH = fileURLToPath(new URL('../../../.tmp/pb-paired-deps-test/', import.meta.url));
const deps = realPairedDeps(() => undefined);

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  // The command's own output goes to the gate's stderr, which is the terminal of whoever runs these tests.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(SCRATCH, { recursive: true, force: true });
});

const node = (code: string, options: Parameters<typeof deps.run>[2] = {}) =>
  deps.run(process.execPath, ['-e', code], options);

describe('PB-PERF paired effects: running a command', () => {
  it('ends with the exit code of the command and the end of what it said, a non-zero code included', async () => {
    const ok = await node("console.log('out'); console.error('err')");
    expect(ok).toStrictEqual({ code: 0, stdout: 'out\n', stderr: 'err\n' });
    const failed = await node("console.error('PROBLEM: x'); process.exit(7)");
    expect(failed).toMatchObject({ code: 7, stderr: 'PROBLEM: x\n' });
  });

  it('runs in the directory and with the environment it is given', async () => {
    const result = await node('console.log(process.cwd() + "|" + process.env.PB_PAIRED_TEST)', {
      cwd: SCRATCH,
      env: { ...process.env, PB_PAIRED_TEST: 'yes' },
    });
    expect(result.stdout.trim().endsWith('pb-paired-deps-test|yes')).toBe(true);
  });

  it('keeps only the end of a long output', async () => {
    const result = await node("console.log('x'.repeat(40000) + 'END')");
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    expect(result.stdout.trim().endsWith('END')).toBe(true);
  });

  it('rejects when the command cannot be started', async () => {
    await expect(deps.run('definitely-not-a-command-for-the-test', [])).rejects.toThrow(/ENOENT/);
  });

  it('stops the whole process group on an abort: the command and what it started, with a code of 143', async () => {
    const controller = new AbortController();
    const pidFile = join(SCRATCH, 'child.pid');
    const running = node(
      // A parent that starts a child of its own, writes its pid where the test can read it, and waits.
      `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000)`,
      { signal: controller.signal },
    );
    for (let waited = 0; !existsSync(pidFile) && waited < 20_000; waited += 50)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    controller.abort();
    expect((await running).code).toBe(143);
    for (let waited = 0; waited < 5_000; waited += 50) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('stops a command that is already aborted, and one that takes longer than its limit', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect((await node('setInterval(() => {}, 1000)', { signal: aborted.signal })).code).toBe(143);
    const slow = await node('setInterval(() => {}, 1000)', { timeoutMs: 400 });
    expect(slow.code).toBe(143);
    expect(slow.stderr).toContain('paired: stopped after 400 ms');
  });
});

describe('PB-PERF paired effects: asking git and the file system', () => {
  it('answers a question synchronously, a failing one too', () => {
    expect(deps.runSync(process.execPath, ['-e', "console.log('hi')"])).toMatchObject({
      code: 0,
      stdout: 'hi\n',
    });
    expect(deps.runSync(process.execPath, ['-e', 'process.exit(3)'])).toMatchObject({ code: 3 });
    expect(deps.runSync('definitely-not-a-command-for-the-test', []).code).not.toBe(0);
  });

  it('removes a link as itself: what it points to is never touched', () => {
    const target = join(SCRATCH, 'head', 'node_modules');
    mkdirSync(join(target, 'esbuild'), { recursive: true });
    writeFileSync(join(target, 'esbuild', 'index.js'), 'module.exports = 1;\n');
    const link = join(SCRATCH, 'control-node-modules');
    deps.symlink(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(deps.exists(join(link, 'esbuild', 'index.js'))).toBe(true);

    deps.remove(link);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(target, 'esbuild', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('removes a directory tree and does not mind what is not there', () => {
    const tree = join(SCRATCH, 'tree');
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    writeFileSync(join(tree, 'a', 'b', 'file'), 'x');
    deps.remove(tree);
    expect(existsSync(tree)).toBe(false);
    expect(() => deps.remove(join(SCRATCH, 'never-there'))).not.toThrow();
  });

  it('makes a temporary directory and a directory path, reads the bytes of a file, and resolves a path that is not there to itself', () => {
    const made = deps.mkdtemp(join(SCRATCH, 'pb-paired-'));
    expect(existsSync(made)).toBe(true);
    deps.mkdir(join(made, 'baselines', 'deeper'));
    expect(existsSync(join(made, 'baselines', 'deeper'))).toBe(true);
    writeFileSync(join(made, 'file'), 'abc');
    expect(Buffer.from(deps.readBytes(join(made, 'file'))!).toString()).toBe('abc');
    expect(deps.readBytes(join(made, 'missing'))).toBeNull();
    expect(deps.realpath(join(made, 'missing'))).toBe(join(made, 'missing'));
    // A link to a directory that does not exist is a link.
    symlinkSync(join(made, 'nowhere'), join(made, 'dangling'), 'dir');
    deps.remove(join(made, 'dangling'));
    expect(lstatNothing(join(made, 'dangling'))).toBe(false);
  });
});

function lstatNothing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
