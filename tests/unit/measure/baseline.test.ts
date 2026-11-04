import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BaselineError,
  baselinePath,
  loadBaseline,
  parseBaseline,
  recordCommand,
  serializeBaseline,
  startRungOf,
  writeBaseline,
} from '../../../src/lab/measure/baseline.ts';
import type { Baseline } from '../../../src/lab/measure/baseline.ts';
import { summarize } from '../../../src/lab/measure/stats.ts';
import {
  FRAME_RATE,
  HASH,
  REBUFFERING,
  STARTUP,
  baselineOf,
  frameBatch,
  rebufferBatch,
  run,
  startupBatch,
} from './fixtures.ts';

// Scratch files live under the repository's own gitignored .tmp, never in the system temp directory.
const SCRATCH = fileURLToPath(new URL('../../../.tmp/pb-perf-baseline-test/', import.meta.url));

const STARTUPS = [140, 150, 130, 160, 145, 155, 135, 150, 148, 152];

function startupBaseline(): Baseline {
  return baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }]);
}

/** The part of the file the tests below damage, typed so that a typo in a test does not pass silently. */
interface FileShape {
  schemaVersion: number;
  kind: string;
  profile: string;
  host?: unknown;
  streams: Record<string, string>;
  scenarios: Record<
    string,
    {
      startRungHeight: number | null;
      loadAverage: { before: number | null };
      runs: Array<{ durationMs: number; values: Record<string, number | null> }>;
      metrics: Record<string, { summary: Record<string, number | null> | null; values: (number | null)[] }>;
    }
  >;
}

const startupOf = (file: FileShape): FileShape['scenarios'][string] => file.scenarios['PB-PERF-001']!;

/** The baseline as a plain JSON value, to damage one field of it the way a hand edit would. */
function damaged(change: (file: FileShape) => void): string {
  const file = JSON.parse(serializeBaseline(startupBaseline())) as FileShape;
  change(file);
  return JSON.stringify(file);
}

describe('PB-PERF baseline: building it from measured batches', () => {
  it('summarizes the raw per-run values of every metric and leaves the warm-up out', () => {
    const baseline = startupBaseline();
    const scenario = baseline.scenarios['PB-PERF-001']!;
    expect(scenario.metrics.startupMs!.values).toStrictEqual(STARTUPS);
    expect(scenario.metrics.startupMs!.summary).toStrictEqual(summarize(STARTUPS));
    expect(scenario.metrics.startupMs!.summary!.n).toBe(10);
    expect(scenario.metrics.startupMs!.summary!.max).toBe(160);
    expect(scenario.metrics.manifestMs!.summary!.median).toBeCloseTo(summarize(STARTUPS).median / 10, 9);
    // The batch's warm-up took 999 ms: it is recorded next to the runs and is in no statistic.
    expect(scenario.warmup?.values.startupMs).toBe(999);
    expect(scenario.metrics.startupMs!.summary!.max).toBeLessThan(999);
    expect(baseline.runsPerScenario).toBe(10);
    expect(baseline.warmupRuns).toBe(1);
  });

  it('records where and with what it was measured', () => {
    const baseline = startupBaseline();
    expect(baseline).toMatchObject({
      schemaVersion: 1,
      kind: 'perf-baseline',
      envId: 'local-darwin-arm64',
      profile: 'chromium',
      ffmpeg: '9.0',
      streams: { 'vod-cmaf': HASH },
      host: { cpus: 12, memoryGiB: 36, node: 'v22.11.0', playwright: '1.64.1', git: { commit: 'abc1234' } },
      browser: { name: 'chromium', version: '156.0.0.0', cpuThrottleRate: null },
    });
    expect(baseline.scenarios['PB-PERF-001']).toMatchObject({
      stream: 'vod-cmaf',
      protocol: 'dash',
      faultProfile: 'clean',
      startRungHeight: 720,
      loadAverage: { before: 1.5, after: 1.7 },
    });
  });

  it('keeps a baseline with several scenarios, each with its own start rung', () => {
    const baseline = baselineOf([
      { spec: STARTUP, batch: startupBatch(STARTUPS) },
      { spec: REBUFFERING, batch: rebufferBatch([0, 0, 1, 0, 0, 1, 0, 0, 0, 0]) },
      { spec: FRAME_RATE, batch: frameBatch([30, 30, 29.9, 30]) },
    ]);
    expect(Object.keys(baseline.scenarios)).toStrictEqual(['PB-PERF-001', 'PB-PERF-003', 'PB-PERF-002']);
    expect(baseline.scenarios['PB-PERF-003']!.metrics.rebufferCount!.summary).toMatchObject({
      n: 10,
      median: 0,
      max: 1,
    });
    expect(baseline.scenarios['PB-PERF-003']!.metrics.rebufferCount!.summary!.cv).not.toBeNull();
    expect(baseline.scenarios['PB-PERF-002']!.pinnedHeight).toBe(720);
  });

  it('refuses runs that did not start on the same rung where the start rung decides the number', () => {
    const mixed = startupBatch(STARTUPS);
    mixed.runs[3] = run({ startupMs: 400, manifestMs: 40 }, 360);
    const attempt = (): Baseline => baselineOf([{ spec: STARTUP, batch: mixed }]);
    expect(attempt).toThrow(BaselineError);
    expect(attempt).toThrow(/did not start on the same rung \(720p, 360p\)/);
  });

  it('accepts mixed start rungs where the window is pinned, and says nothing was recorded when it was not', () => {
    const batch = frameBatch([30, 30]);
    batch.runs[1] = run({ fps: 30, droppedRatio: 0 }, 360);
    const baseline = baselineOf([{ spec: FRAME_RATE, batch }]);
    expect(baseline.scenarios['PB-PERF-002']!.startRungHeight).toBeNull();
    expect(startRungOf([run({}, null), run({}, null)])).toMatchObject({ height: null, unanimous: true });
  });

  it('refuses a gated metric that a run did not produce, and tolerates a tracked one', () => {
    const missingGated = startupBatch(STARTUPS);
    missingGated.runs[2] = run({ startupMs: null, manifestMs: 10 });
    expect(() => baselineOf([{ spec: STARTUP, batch: missingGated }])).toThrow(
      /PB-PERF-001: run 3 did not produce startupMs, which gates/,
    );

    const missingTracked = startupBatch(STARTUPS);
    missingTracked.runs[2] = run({ startupMs: 150, manifestMs: null });
    const baseline = baselineOf([{ spec: STARTUP, batch: missingTracked }]);
    expect(baseline.scenarios['PB-PERF-001']!.metrics.manifestMs!.summary!.n).toBe(9);
    expect(baseline.scenarios['PB-PERF-001']!.metrics.manifestMs!.values[2]).toBeNull();
  });

  it('refuses a batch with no measured run', () => {
    expect(() => baselineOf([{ spec: STARTUP, batch: startupBatch([]) }])).toThrow(/no measured run/);
  });

  it('refuses a batch in which faults were injected on purpose: it is not the condition a baseline records', () => {
    const injected = { ...startupBatch(STARTUPS), injectedFaults: [{ type: 'latency' as const, ms: 150 }] };
    expect(() => baselineOf([{ spec: STARTUP, batch: injected }])).toThrow(/faults were injected on purpose/);
  });

  it('refuses a batch whose CPU throttle was replaced on purpose, for the same reason', () => {
    const injected = { ...startupBatch(STARTUPS), injectedCpuThrottle: 8 };
    expect(() => baselineOf([{ spec: STARTUP, batch: injected }])).toThrow(
      /CPU throttle was overridden on purpose \(8x\)/,
    );
  });

  it('lists every reason at once', () => {
    const batch = startupBatch(STARTUPS);
    batch.runs[0] = run({ startupMs: null, manifestMs: 1 }, 360);
    batch.runs[1] = run({ startupMs: null, manifestMs: 1 }, 720);
    expect(() => baselineOf([{ spec: STARTUP, batch }])).toThrow(
      /run 1 did not produce[\s\S]*run 2 did not produce[\s\S]*same rung/,
    );
  });
});

describe('PB-PERF baseline: the file', () => {
  it('survives a round trip through JSON unchanged', () => {
    const baseline = baselineOf([
      { spec: STARTUP, batch: startupBatch(STARTUPS) },
      { spec: REBUFFERING, batch: rebufferBatch([0, 1, 0, 0]) },
    ]);
    expect(parseBaseline(serializeBaseline(baseline), 'x.json')).toStrictEqual(baseline);
  });

  it('is plain, indented, newline-terminated JSON that a person can read in a pull request', () => {
    const text = serializeBaseline(startupBaseline());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "scenarios": {');
  });

  it('keeps how the profile was started and the load around it, and stays valid without them', () => {
    const machine = {
      invokedVia: 'docker:pw' as const,
      dockerCpus: 4,
      quiet: { maxLoad: 3, hostLoad: 1.4, waitedMs: 65_000 },
      loadBeforeProfile: 0.8,
      loadAfterProfile: 2.1,
    };
    const recorded = baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }], { machine });
    expect(recorded.machine).toStrictEqual(machine);
    expect(parseBaseline(serializeBaseline(recorded), 'x.json')).toStrictEqual(recorded);

    const unknown = parseBaseline(serializeBaseline(startupBaseline()), 'x.json');
    expect(unknown).not.toHaveProperty('machine');
    const direct = baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }], {
      machine: { ...machine, invokedVia: 'direct', dockerCpus: null, quiet: null },
    });
    expect(parseBaseline(serializeBaseline(direct), 'x.json').machine?.quiet).toBeNull();
  });

  it.each([
    [
      'an unknown way of starting',
      (m: Record<string, unknown>) => (m.invokedVia = 'ssh'),
      /\$\.machine\.invokedVia/,
    ],
    [
      'a load that is not a number',
      (m: Record<string, unknown>) => (m.loadAfterProfile = null),
      /loadAfterProfile/,
    ],
    [
      'a wait without its duration',
      (m: Record<string, unknown>) => (m.quiet = { maxLoad: 3, hostLoad: 1 }),
      /\$\.machine\.quiet\.waitedMs/,
    ],
  ])('refuses a machine record with %s', (_name, damage, message) => {
    const file = JSON.parse(
      serializeBaseline(
        baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }], {
          machine: {
            invokedVia: 'direct',
            dockerCpus: null,
            quiet: { maxLoad: 3, hostLoad: 1, waitedMs: 0 },
            loadBeforeProfile: 0.5,
            loadAfterProfile: 0.6,
          },
        }),
      ),
    ) as { machine: Record<string, unknown> };
    damage(file.machine);
    expect(() => parseBaseline(JSON.stringify(file), 'x.json')).toThrow(message);
  });

  it.each([
    ['text that is not JSON', 'not json', /not valid JSON/],
    [
      'a file of another schema version',
      damaged((f) => (f.schemaVersion = 2)),
      /schemaVersion is 2, this harness reads 1/,
    ],
    ['a file of another kind', damaged((f) => (f.kind = 'ab-report')), /\$\.kind: expected "perf-baseline"/],
    ['an unknown profile', damaged((f) => (f.profile = 'opera')), /\$\.profile: unknown profile "opera"/],
    [
      'a stream hash that is not sha256',
      damaged((f) => (f.streams['vod-cmaf'] = 'abc')),
      /expected a sha256 content hash/,
    ],
    ['a missing host', damaged((f) => delete f.host), /\$\.host: expected an object/],
    [
      'a negative duration',
      damaged((f) => (startupOf(f).runs[0]!.durationMs = -1)),
      /a duration cannot be negative/,
    ],
    [
      'a null where a number is required',
      damaged((f) => (startupOf(f).loadAverage.before = null)),
      /loadAverage\.before: expected a finite number/,
    ],
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseBaseline(text, 'x.json')).toThrow(message);
  });

  it('refuses a summary that does not follow from the raw values (a hand-edited number)', () => {
    const text = damaged((f) => (startupOf(f).metrics.startupMs!.summary!.median = 120));
    expect(() => parseBaseline(text, 'x.json')).toThrow(
      /summary\.median: is 120 but the raw values give 149: was the file edited by hand/,
    );
    const cv = damaged((f) => (startupOf(f).metrics.startupMs!.summary!.cv = 0.5));
    expect(() => parseBaseline(cv, 'x.json')).toThrow(/summary\.cv: is 0\.5 but the raw values give/);
  });

  it('refuses raw values that disagree with the runs they came from, or that are not one per run', () => {
    const edited = damaged((f) => (startupOf(f).metrics.startupMs!.values[0] = 1));
    expect(() => parseBaseline(edited, 'x.json')).toThrow(/values\[0\]: is 1 but run 1 says 140/);
    const short = damaged((f) => startupOf(f).metrics.startupMs!.values.pop());
    expect(() => parseBaseline(short, 'x.json')).toThrow(/9 values for 10 runs/);
  });

  it('refuses a start rung that the runs do not support, and a summary of nothing', () => {
    const rung = damaged((f) => (startupOf(f).startRungHeight = 360));
    expect(() => parseBaseline(rung, 'x.json')).toThrow(
      /startRungHeight: is 360 but every run started on 720/,
    );
    const ghost = damaged((f) => {
      for (const run of startupOf(f).runs) run.values.manifestMs = null;
      startupOf(f).metrics.manifestMs!.values = new Array<number | null>(10).fill(null);
    });
    expect(() => parseBaseline(ghost, 'x.json')).toThrow(
      /manifestMs\.summary: is not null although no run produced a value/,
    );
  });
});

describe('PB-PERF baseline: finding the baseline of this environment', () => {
  beforeEach(() => mkdirSync(SCRATCH, { recursive: true }));
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it('keeps one file per environment and profile', () => {
    expect(baselinePath('perf/baselines', 'local-darwin-arm64', 'chromium-cpu4x')).toBe(
      'perf/baselines/local-darwin-arm64/chromium-cpu4x.json',
    );
  });

  it('writes the file where the loader looks for it, and reads it back', () => {
    const baseline = startupBaseline();
    const path = writeBaseline(SCRATCH, baseline);
    expect(path).toBe(baselinePath(SCRATCH, 'local-darwin-arm64', 'chromium'));
    expect(loadBaseline({ dir: SCRATCH, envId: 'local-darwin-arm64', profile: 'chromium' })).toStrictEqual(
      baseline,
    );
  });

  it('fails a missing baseline with the exact command that creates it', () => {
    const attempt = (): Baseline =>
      loadBaseline({ dir: SCRATCH, envId: 'local-darwin-arm64', profile: 'webkit' });
    expect(attempt).toThrow(BaselineError);
    expect(attempt).toThrow(/there is no performance baseline for webkit in local-darwin-arm64/);
    expect(attempt).toThrow(/with: npm run perf:baseline -- --profile webkit$/);
    try {
      attempt();
    } catch (error) {
      expect((error as BaselineError).problem).toBe('missing');
    }
  });

  it('names the Docker command where the environment is a container', () => {
    expect(recordCommand('docker-linux-arm64', 'firefox')).toBe(
      'npm run docker:pw -- --cpus 3 npm run perf:baseline -- --profile firefox',
    );
    expect(recordCommand('gha-linux-x64', 'chromium')).toBe('npm run perf:baseline -- --profile chromium');
  });

  it('refuses a baseline recorded in another environment, even when the file sits in this one', () => {
    const foreign = baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }], {
      envId: 'gha-linux-x64',
    });
    const copied = baselinePath(SCRATCH, 'local-darwin-arm64', 'chromium');
    mkdirSync(dirname(copied), { recursive: true });
    writeFileSync(copied, serializeBaseline(foreign));
    const attempt = (): Baseline =>
      loadBaseline({ dir: SCRATCH, envId: 'local-darwin-arm64', profile: 'chromium' });
    expect(attempt).toThrow(
      /was recorded in gha-linux-x64 and this is local-darwin-arm64: baselines are never compared across environments/,
    );
    expect(attempt).toThrow(/Record one here with: npm run perf:baseline -- --profile chromium/);
  });

  it('refuses a baseline of another profile, and a file that does not validate', () => {
    const other = baselineOf([{ spec: STARTUP, batch: startupBatch(STARTUPS) }], { profile: 'webkit' });
    const path = baselinePath(SCRATCH, 'local-darwin-arm64', 'chromium');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeBaseline(other));
    expect(() => loadBaseline({ dir: SCRATCH, envId: 'local-darwin-arm64', profile: 'chromium' })).toThrow(
      /is the baseline of webkit, not of chromium/,
    );
    writeFileSync(path, '{ broken');
    expect(() => loadBaseline({ dir: SCRATCH, envId: 'local-darwin-arm64', profile: 'chromium' })).toThrow(
      /not valid JSON/,
    );
  });
});
