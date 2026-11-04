import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import { runReadinessCommand, runSoakCommand } from '../../../src/lab/readiness/commands.ts';
import type { CommandDeps } from '../../../src/lab/readiness/commands.ts';
import { parseReadinessReport, parseSoakReport } from '../../../src/lab/readiness/report.ts';
import type { Engine } from '../../../src/lab/readiness/soak-evaluators.ts';
import { makeScratch } from '../support/scratch.ts';
import { fakePlaywright } from './fake-playwright.ts';
import type { FakePlaywright, FakePlaywrightOptions } from './fake-playwright.ts';
import type { Script } from './fake-world.ts';

// `npm run readiness` and `npm run soak` as a person runs them: the arguments, the service, the browser, the checks, the sheet, the
// result file, the exit code, and what is stopped at the end. They run over the fake service and the fake of Playwright
// (fake-playwright.ts) on a virtual clock, so what these tests can say is about the glue, which no other test reaches: the real browsers and
// the real service are Phase B's. The sheet and the files are checked as the person would read them.

const host = {
  os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 16,
  node: 'v22',
  playwright: '1.64.1',
  git: { commit: 'abc1234', dirty: false },
} as HostInfo;

interface Rig {
  deps: CommandDeps;
  fp: FakePlaywright;
  out: string[];
  err: string[];
  root: string;
  ports: number[];
  launched: Engine[];
  stopped: { service: number; released: number };
}

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(
  options: {
    script?: Script;
    fake?: FakePlaywrightOptions;
    skip?: Engine[];
    serviceFails?: boolean;
    launchFails?: Engine[];
  } = {},
): Rig {
  const fp = fakePlaywright(options.script ?? {}, options.fake ?? {});
  const out: string[] = [];
  const err: string[] = [];
  const ports: number[] = [];
  const launched: Engine[] = [];
  const stopped = { service: 0, released: 0 };
  let reads = 0;
  const root = makeScratch('readiness-command-');
  scratches.push(root);
  const deps: CommandDeps = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    async startService(port) {
      ports.push(port);
      if (options.serviceFails)
        throw new Error('the service at http://127.0.0.1:4740 was not healthy within 30000 ms');
      return {
        service: {
          client: fp.service,
          pid: null,
          stop: async () => {
            stopped.service += 1;
          },
        },
        release: () => {
          stopped.released += 1;
        },
      };
    },
    async launch(engine) {
      launched.push(engine);
      if (options.launchFails?.includes(engine))
        throw new Error('browserType.launch: Executable does not exist');
      return fp.browser;
    },
    plan: (engine, protocol) =>
      options.skip?.includes(engine)
        ? { engine, skipped: `${engine} does not run in this environment (CODEC_MATRIX.md)` }
        : { engine, stream: 'live-cmaf', protocol },
    machine: () => ({ envId: 'test-env', host }),
    load: () => {
      reads += 1;
      return { at: `2030-01-01T00:00:0${reads}.000Z`, load1: reads, load5: 1.25, load15: 0.5, cpus: 12 };
    },
    describe: async (browser, _service, plan) => ({
      browser: { name: browser.engine, version: browser.version, userAgent: 'FakeBrowser/1' },
      stream: { id: plan.stream, protocol: plan.protocol, contentHash: 'deadbeef' },
    }),
    resultsRoot: root,
    clock: fp.harness,
  };
  return { deps, fp, out, err, root, ports, launched, stopped };
}

/** Small enough to be quick, large enough for every check to have what it needs to judge: the five joins are the criterion's own. */
const SMALL = ['--stall-runs', '1', '--window-sec', '25', '--refreshes', '11'];

describe('npm run readiness', () => {
  it('prints the usage and starts nothing for --help, and says what was wrong, with the usage, for a bad option', async () => {
    const help = rig();
    expect(await runReadinessCommand(['--help'], help.deps)).toBe(0);
    expect(help.out.join('\n')).toContain('npm run readiness');
    expect(help.ports).toEqual([]);
    const bad = rig();
    expect(await runReadinessCommand(['--candidate', 'nope'], bad.deps)).toBe(2);
    expect(bad.err.join('\n')).toContain('unknown candidate "nope"');
    expect(bad.err.join('\n')).toContain('npm run readiness');
    expect(bad.ports).toEqual([]);
  });

  it('says in its usage that only the build as it ships decides the exit code', async () => {
    const help = rig();
    await runReadinessCommand(['--help'], help.deps);
    const usage = help.out.join('\n');
    expect(usage).toContain('A candidate is evidence for a decision');
    expect(usage).toContain('never changes the exit code');
  });

  it('runs A and a candidate, prints the sheet, the comparison and the checklist, writes the file, and exits 1 for the defaults', async () => {
    const r = rig();
    const code = await runReadinessCommand(['--candidate', 'live-sync', ...SMALL], r.deps);
    const text = r.out.join('\n');
    expect(text).toContain('Live-event readiness: chromium 156.0.7000.1 on test-env');
    expect(text).toMatch(/Configuration A: the library defaults \(what ships\)\s+NO-GO/);
    expect(text).toMatch(/Configuration live-sync: A plus streaming\.liveSync\.enabled\s+GO/);
    expect(text).toContain('Comparison with A (chromium)');
    expect(text).toContain('Go/no-go checklist');
    // The exit code is the verdict of the build as it ships: a candidate that is GO does not make it so.
    expect(code).toBe(1);
    const file = join(r.root, 'readiness', 'test-env-chromium.json');
    const report = parseReadinessReport(readFileSync(file, 'utf8'), file);
    expect(report.configurations.map((c) => [c.id, c.verdict])).toEqual([
      ['A', 'NO-GO'],
      ['live-sync', 'GO'],
    ]);
    expect(report.commit).toEqual({ hash: 'abc1234', dirty: false });
    expect(report.stream.contentHash).toBe('deadbeef');
    expect(r.err.join('\n')).toContain('wrote ');
  });

  it('stops what it started: the service, the signal handlers, the browser, and every context and session of the checks', async () => {
    const r = rig();
    await runReadinessCommand(['--checks', '1,2', ...SMALL], r.deps);
    expect(r.stopped).toEqual({ service: 1, released: 1 });
    expect(r.launched).toEqual(['chromium']);
    expect(r.fp.env.contexts.length).toBeGreaterThan(0);
    expect(r.fp.env.contexts.every((context) => context.closed)).toBe(true);
    expect(r.fp.service.deleted).toHaveLength(r.fp.env.contexts.length);
  });

  it('is GO, and exits 0, when the checks that can pass pass, and passes the port to the service', async () => {
    const r = rig();
    const code = await runReadinessCommand(['--checks', '1,2,4', '--port', '4745', ...SMALL], r.deps);
    expect(code).toBe(0);
    expect(r.ports).toEqual([4745]);
    expect(r.out.join('\n')).toMatch(/Configuration A: the library defaults \(what ships\)\s+GO/);
  });

  it('records how busy the machine was before and after the run, in the file and on the sheet', async () => {
    const r = rig();
    await runReadinessCommand(['--checks', '1', ...SMALL], r.deps);
    const file = join(r.root, 'readiness', 'test-env-chromium.json');
    const report = parseReadinessReport(readFileSync(file, 'utf8'), file);
    expect(report.load?.before).toMatchObject({ load1: 1, load5: 1.25, cpus: 12 });
    expect(report.load?.after).toMatchObject({ load1: 2, cpus: 12 });
    expect(r.out.join('\n')).toContain(
      'machine load average (1, 5, 15 min): 1.00 1.25 0.50 before, 2.00 1.25 0.50 after, on 12 CPUs',
    );
  });

  it('writes nothing for --no-write, and writes to --out-dir when it is given one', async () => {
    const quiet = rig();
    await runReadinessCommand(['--checks', '1', '--no-write', ...SMALL], quiet.deps);
    expect(existsSync(join(quiet.root, 'readiness'))).toBe(false);
    const elsewhere = rig();
    const dir = join(elsewhere.root, 'elsewhere');
    await runReadinessCommand(['--checks', '1', '--out-dir', dir, ...SMALL], elsewhere.deps);
    expect(readdirSync(dir)).toEqual(['test-env-chromium.json']);
  });

  it('skips an engine that this environment cannot run, says why, and does not let a skip pass for a GO', async () => {
    const r = rig({ skip: ['firefox'] });
    const code = await runReadinessCommand(
      ['--engine', 'chromium,firefox', '--checks', '1', ...SMALL],
      r.deps,
    );
    expect(r.err.join('\n')).toContain('SKIPPED firefox: firefox does not run in this environment');
    expect(r.launched).toEqual(['chromium']);
    // The run was GO where it ran, and it did not run everywhere that was asked for: that is a run that could not judge.
    expect(code).toBe(2);
  });

  it('exits 1 for a NO-GO even when an engine was skipped: a defect found is a defect', async () => {
    const r = rig({ skip: ['firefox'] });
    const code = await runReadinessCommand(
      ['--engine', 'chromium,firefox', '--checks', '3', ...SMALL],
      r.deps,
    );
    expect(code).toBe(1);
  });

  it('exits 2, naming the browser, when it did not start, and still stops the service', async () => {
    const r = rig({ launchFails: ['chromium'] });
    const code = await runReadinessCommand(['--checks', '1', ...SMALL], r.deps);
    expect(code).toBe(2);
    expect(r.err.join('\n')).toContain('PROBLEM: the browser of chromium did not start: browserType.launch');
    expect(r.stopped).toEqual({ service: 1, released: 1 });
  });

  it("exits 2, with the service's own words, when the service did not start, and starts no browser", async () => {
    const r = rig({ serviceFails: true });
    expect(await runReadinessCommand(['--checks', '1', ...SMALL], r.deps)).toBe(2);
    expect(r.err.join('\n')).toContain('PROBLEM: the service at http://127.0.0.1:4740 was not healthy');
    expect(r.launched).toEqual([]);
  });

  it('exits 2 when a check could not run, which is a statement about the run and never a pass', async () => {
    const r = rig({ script: { openFails: true } });
    const code = await runReadinessCommand(['--checks', '2', ...SMALL], r.deps);
    expect(code).toBe(2);
    expect(r.out.join('\n')).toContain('the check could not run');
  });

  it('renders the checklist from the committed files for --from-results, running nothing', async () => {
    const r = rig();
    await runReadinessCommand(['--checks', '1,2,3,4', ...SMALL], r.deps);
    const again = rig();
    again.deps.resultsRoot = r.root;
    const code = await runReadinessCommand(['--from-results'], again.deps);
    expect(again.ports).toEqual([]);
    expect(again.out.join('\n')).toContain('Go/no-go checklist');
    expect(code).toBe(1);
    const empty = rig();
    expect(await runReadinessCommand(['--from-results'], empty.deps)).toBe(2);
    expect(empty.err.join('\n')).toContain('no result files under');
  });
});

describe('npm run soak', () => {
  it('prints the usage and starts nothing for --help, and for a bad option exits 2 with the reason', async () => {
    const help = rig();
    expect(await runSoakCommand(['--help'], help.deps)).toBe(0);
    expect(help.out.join('\n')).toContain('npm run soak');
    const bad = rig();
    expect(await runSoakCommand(['--minutes', 'abc'], bad.deps)).toBe(2);
    expect(bad.err.join('\n')).toContain('--minutes must be a number above 0');
    expect(bad.ports).toEqual([]);
  });

  it('runs the CI soak, prints the summary, writes the file named by environment, engine and length, and exits 0', async () => {
    const r = rig();
    const code = await runSoakCommand(['--minutes', 'ci'], r.deps);
    expect(code).toBe(0);
    const text = r.out.join('\n');
    expect(text).toContain('Soak (PB-RDY-005): chromium 156.0.7000.1 on test-env, A');
    expect(text).toMatch(/Soak verdict\s+GO/);
    expect(text).toContain('The harness itself: heap');
    const file = join(r.root, 'soak', 'test-env-chromium-5m.json');
    const report = parseSoakReport(readFileSync(file, 'utf8'), file);
    expect(report.length).toBe('ci');
    expect(report.verdict).toBe('GO');
    expect(report.faults).toHaveLength(1);
    expect(report.configuration.id).toBe('A');
    expect(r.stopped).toEqual({ service: 1, released: 1 });
    expect(r.fp.env.contexts.every((context) => context.closed)).toBe(true);
    expect(r.fp.service.deleted).toHaveLength(1);
    // The banner says what is injected, in words that read the same when nothing is.
    expect(r.err.join('\n')).toContain('an outage at minute 2.5, no stale manifest');
  });

  it('says in the banner that nothing is injected when it is not', async () => {
    const r = rig();
    await runSoakCommand(['--minutes', 'ci', '--no-stall', '--no-write'], r.deps);
    expect(r.err.join('\n')).toContain('no outage, no stale manifest');
  });

  it('records how busy the machine was around a soak, in the file and on the summary', async () => {
    const r = rig();
    await runSoakCommand(['--minutes', 'ci'], r.deps);
    const file = join(r.root, 'soak', 'test-env-chromium-5m.json');
    const report = parseSoakReport(readFileSync(file, 'utf8'), file);
    expect(report.load?.before.load1).toBeLessThan(report.load?.after.load1 ?? 0);
    expect(r.out.join('\n')).toContain('machine load average (1, 5, 15 min):');
  });

  it('reports a run shorter than the CI soak as what it is: written, printed, and not a verdict (exit 2)', async () => {
    const r = rig();
    const code = await runSoakCommand(['--minutes', '1', '--warmup-sec', '15'], r.deps);
    expect(code).toBe(2);
    expect(r.out.join('\n')).toContain('short run: not a verdict');
    const file = join(r.root, 'soak', 'test-env-chromium-1m.json');
    expect(parseSoakReport(readFileSync(file, 'utf8'), file).length).toBe('short');
  });

  it('exits 1 for a soak that found a leak, and prints why', async () => {
    const r = rig({ fake: { retainedMb: (sinceMs) => 12 + (sinceMs / 60_000) * 10 } });
    const code = await runSoakCommand(['--minutes', 'ci', '--no-write'], r.deps);
    expect(code).toBe(1);
    expect(r.out.join('\n')).toContain('NO-GO: The JS heap after a forced collection went from');
    expect(existsSync(join(r.root, 'soak'))).toBe(false);
  });

  it('soaks a candidate configuration when it is asked to, and the file says which', async () => {
    const r = rig();
    await runSoakCommand(['--minutes', 'ci', '--candidate', 'live-sync'], r.deps);
    expect(r.fp.observed.runs[0]?.configured).toHaveLength(1);
    const file = join(r.root, 'soak', 'test-env-chromium-5m.json');
    expect(parseSoakReport(readFileSync(file, 'utf8'), file).configuration.id).toBe('live-sync');
  });

  it('asks for no heap outside Chromium, and says the criterion does not apply', async () => {
    const r = rig({ fake: { engine: 'webkit' } });
    const code = await runSoakCommand(['--minutes', 'ci', '--engine', 'webkit', '--no-write'], r.deps);
    expect(code).toBe(0);
    expect(r.fp.env.cdp).toHaveLength(0);
    expect(r.out.join('\n')).toMatch(/n\/a\s+JS heap growth|N\/A\s+JS heap growth/);
  });

  it('exits 2 for an engine this environment cannot run, with the reason, before it starts anything', async () => {
    const r = rig({ skip: ['firefox'] });
    expect(await runSoakCommand(['--minutes', 'ci', '--engine', 'firefox'], r.deps)).toBe(2);
    expect(r.err.join('\n')).toContain('SKIPPED firefox');
    expect(r.ports).toEqual([]);
  });

  it('stops the service it started when the browser does not start, and when the service does not start says so', async () => {
    const noBrowser = rig({ launchFails: ['chromium'] });
    expect(await runSoakCommand(['--minutes', 'ci'], noBrowser.deps)).toBe(2);
    expect(noBrowser.stopped).toEqual({ service: 1, released: 1 });
    expect(noBrowser.err.join('\n')).toContain('PROBLEM: the browser of chromium did not start');
    const noService = rig({ serviceFails: true });
    expect(await runSoakCommand(['--minutes', 'ci'], noService.deps)).toBe(2);
    expect(noService.launched).toEqual([]);
  });
});
