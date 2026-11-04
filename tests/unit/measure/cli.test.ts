import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeBaseline } from '../../../src/lab/measure/baseline.ts';
import { buildGateReport, serializeReport } from '../../../src/lab/measure/report.ts';
import { detectEnvId } from '../../../src/shared/env.ts';
import { HOST, STARTUP, REBUFFERING, baselineOf, rebufferBatch, startupBatch } from './fixtures.ts';

// The three commands of part 2 (perf/quiet.ts, perf/aa.ts, perf/derive.ts) run as the processes they are, against files in the
// repository's own gitignored .tmp: what the unit tests of their modules cannot show is the plumbing (the arguments, the exit codes,
// the files that come out). Nothing here starts a browser or the service.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRATCH = join(ROOT, '.tmp/pb-perf-cli-test');

function tsx(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('PB-PERF perf/quiet.ts: waiting for a quiet machine, then running the command', () => {
  it('starts the command with what the wait found in its environment, and exits with the command’s own code', () => {
    const result = tsx(
      'perf/quiet.ts',
      [
        '--max-load',
        '1000',
        '--',
        process.execPath,
        '-e',
        "console.log([process.env.PB_QUIET_MAX_LOAD, process.env.PB_DOCKER_ENV].join('|')); process.exit(7)",
      ],
      { PB_DOCKER_ENV: 'FOO' },
    );
    expect(result.status).toBe(7);
    expect(result.stdout.trim()).toBe('1000|FOO PB_QUIET_MAX_LOAD PB_QUIET_HOST_LOAD PB_QUIET_WAITED_MS');
  });

  it('gives up with exit code 2 and starts nothing when the machine does not calm down', () => {
    const result = tsx('perf/quiet.ts', [
      '--max-load',
      '0.0001',
      '--timeout-min',
      '0.001',
      '--',
      process.execPath,
      '-e',
      "console.log('started')",
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('started');
    expect(result.stderr).toMatch(/did not calm down/);
  });

  it('says what it needs and exits with 2 on a command line it cannot use', () => {
    const result = tsx('perf/quiet.ts', ['--', 'true']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--max-load is required/);
    expect(result.stderr).toMatch(/usage: npx tsx perf\/quiet\.ts/);
  });
});

describe('PB-PERF perf/aa.ts: summarizing the gate reports of an A/A check', () => {
  const baseline = baselineOf([
    { spec: STARTUP, batch: startupBatch([90, 92, 95, 98, 100, 100, 102, 105, 110, 110]) },
    { spec: REBUFFERING, batch: rebufferBatch([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  ]);
  const report = (generatedAt: string, cpuModel?: string) =>
    buildGateReport({
      envId: 'local-darwin-arm64',
      profile: 'chromium',
      generatedAt,
      result: { scenarios: [], problems: [], exitCode: 0 },
      baseline: { file: 'perf/baselines/local-darwin-arm64/chromium.json', baseline },
      host: cpuModel === undefined ? HOST : { ...HOST, cpuModel },
      browser: null,
      ffmpeg: '9.0',
      warnings: [],
    });

  it('writes the summary of the passes as JSON and Markdown under <out-dir>/<envId>/, and says how many false positives', () => {
    const files = ['pass-1', 'pass-2'].map((pass, index) => {
      const file = join(SCRATCH, 'aa', pass, 'local-darwin-arm64', 'chromium.json');
      mkdirSync(join(SCRATCH, 'aa', pass, 'local-darwin-arm64'), { recursive: true });
      writeFileSync(file, serializeReport(report(`2026-11-04T10:0${index}:00.000Z`)));
      return file;
    });
    const out = join(SCRATCH, 'aa-out');
    const result = tsx('perf/aa.ts', ['--out-dir', out, ...files]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('A/A chromium in local-darwin-arm64: 2 passes, 0 false positives');
    expect(result.stdout).toContain('CPU models of the passes: not recorded');
    const summary = JSON.parse(readFileSync(join(out, 'local-darwin-arm64', 'chromium-aa.json'), 'utf8')) as {
      passes: number;
      kind: string;
    };
    expect(summary).toMatchObject({ kind: 'perf-aa', passes: 2 });
    expect(readFileSync(join(out, 'local-darwin-arm64', 'chromium-aa.md'), 'utf8')).toContain(
      '**False positives (exit code 1): 0 of 2.**',
    );
  });

  it('takes the passes of several jobs, on several CPU models, and says how many models and which', () => {
    const models = ['AMD EPYC 9V74 80-Core Processor', 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz'];
    const files = models.map((model, index) => {
      // Two jobs: each wrote its report to the same relative place in a directory of its own.
      const dir = join(SCRATCH, 'aa-jobs', `job-${index + 1}`, 'local-darwin-arm64');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'chromium.json'),
        serializeReport(report(`2026-11-04T10:0${index}:00.000Z`, model)),
      );
      return join(dir, 'chromium.json');
    });
    const out = join(SCRATCH, 'aa-jobs-out');
    const result = tsx('perf/aa.ts', ['--out-dir', out, ...files]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `CPU models of the passes: 2 distinct (${models[0]} x 1, ${models[1]} x 1)`,
    );
    const markdown = readFileSync(join(out, 'local-darwin-arm64', 'chromium-aa.md'), 'utf8');
    expect(markdown).toContain('The passes ran on 2 distinct CPU models');
    expect(markdown).toContain(`| 1 | pass | ${models[0]} | - | - |`);
    expect(markdown).toContain(`| 2 | pass | ${models[1]} | - | - |`);
  });

  it('reports a report that is not there (a pass that died before it wrote one) and exits with 2, writing nothing', () => {
    const out = join(SCRATCH, 'aa-missing-out');
    const result = tsx('perf/aa.ts', ['--out-dir', out, join(SCRATCH, 'nowhere', 'chromium.json')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/PROBLEM: cannot read the gate report .*nowhere/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('PB-PERF perf/derive.ts: deriving the thresholds from the baselines on disk', () => {
  it('reads every baseline under the directory and writes the derivation as JSON and Markdown', () => {
    const dir = join(SCRATCH, 'baselines');
    writeBaseline(
      dir,
      baselineOf([
        { spec: STARTUP, batch: startupBatch([140, 150, 130, 160, 145, 155, 135, 150, 148, 152]) },
      ]),
    );
    const out = join(SCRATCH, 'derive-out');
    const result = tsx('perf/derive.ts', ['--baseline-dir', dir, '--out-dir', out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/startup\s+1 gated, 0 tracked/);
    const derivation = JSON.parse(readFileSync(join(out, 'threshold-derivation.json'), 'utf8')) as {
      kind: string;
      baselines: unknown[];
    };
    expect(derivation).toMatchObject({ kind: 'perf-threshold-derivation' });
    expect(derivation.baselines).toHaveLength(1);
    expect(readFileSync(join(out, 'threshold-derivation.md'), 'utf8')).toContain('## Threshold derivation');
  });

  it('exits with 2 and says so when there is no baseline to derive from: an empty directory, and one that is not there', () => {
    const empty = join(SCRATCH, 'no-baselines');
    mkdirSync(empty, { recursive: true });
    for (const dir of [empty, join(SCRATCH, 'not-there')]) {
      const result = tsx('perf/derive.ts', [
        '--baseline-dir',
        dir,
        '--out-dir',
        join(SCRATCH, 'derive-none'),
      ]);
      expect(result.status, dir).toBe(2);
      expect(result.stderr, dir).toMatch(/no baseline under/);
    }
    expect(existsSync(join(SCRATCH, 'derive-none'))).toBe(false);
  });
});

describe('PB-PERF perf/gate.ts --paired: a control that cannot be had is exit code 2, before anything is measured', () => {
  const reports = join(SCRATCH, 'paired-reports');
  const gate = (...args: string[]) =>
    tsx('perf/gate.ts', [...args, '--profile', 'chromium', '--reports-dir', reports]);
  const written = () =>
    JSON.parse(readFileSync(join(reports, detectEnvId(), 'chromium.json'), 'utf8')) as {
      exitCode: number;
      verdict: string;
      baseline: unknown;
      scenarios: unknown[];
      paired: { line: string; controlCommit: string | null; aa: boolean };
    };

  it('lists the paired options in --help', () => {
    const result = tsx('perf/gate.ts', ['--help']);
    expect(result.status).toBe(0);
    for (const flag of ['--paired', '--control-ref', '--control-dir']) expect(result.stdout).toContain(flag);
  });

  it('says how to fix a ref that is not in this checkout, and writes the report of a gate that judged nothing', () => {
    rmSync(reports, { recursive: true, force: true });
    const result = gate('--paired', '--control-ref', 'no-such-ref-for-the-test');
    expect(result.status).toBe(2);
    expect(result.stdout.split('\n')[0]).toBe(
      'paired: no control was measured on this machine; the committed baselines of this environment were not used',
    );
    expect(result.stdout).toMatch(
      /PROBLEM: the control ref "no-such-ref-for-the-test" does not name a commit in this checkout\. Fetch it \(git fetch origin main\)/,
    );
    expect(result.stdout).toContain('verdict: PROBLEM (exit code 2)');
    const report = written();
    expect(report).toMatchObject({ exitCode: 2, verdict: 'problem', baseline: null, scenarios: [] });
    expect(report.paired).toMatchObject({ controlCommit: null, aa: false });
  });

  it('exits with 2 for a control checkout that is not there, and for a directory that is not the top of a checkout', () => {
    const inside = join(SCRATCH, 'not-a-checkout');
    mkdirSync(inside, { recursive: true });
    for (const [dir, message] of [
      [join(SCRATCH, 'nowhere'), /does not exist/],
      [inside, /is not the top of a git checkout/],
    ] as const) {
      const result = gate('--paired', '--control-dir', dir);
      expect(result.status, dir).toBe(2);
      expect(result.stdout, dir).toMatch(message);
      expect(result.stdout, dir).toContain('verdict: PROBLEM (exit code 2)');
    }
  });

  it('refuses at the command line what cannot be paired, and leaves no report', () => {
    rmSync(reports, { recursive: true, force: true });
    const result = tsx('perf/gate.ts', ['--paired', '--scenario', 'PB-PERF-001']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot be combined with --scenario/);
    expect(existsSync(reports)).toBe(false);
  });
});
