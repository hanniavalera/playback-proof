import { describe, expect, it } from 'vitest';
import {
  checklist,
  evaluationLine,
  renderChecklist,
  renderComparison,
  renderReadinessReport,
  renderRun,
  renderSoakReport,
  runVerdict,
} from '../../../src/lab/readiness/checklist.ts';
import { candidateById } from '../../../src/lab/readiness/candidates.ts';
import { runReadinessChecks } from '../../../src/lab/readiness/checks.ts';
import type { ConfigurationResult, ReadinessReport, SoakReport } from '../../../src/lab/readiness/report.ts';
import {
  ResultFileError,
  isBusy,
  limitsSnapshot,
  loadPerCpu,
  parseReadinessReport,
  parseSoakReport,
  readinessFileName,
  readinessFileNameOf,
  soakFileName,
  soakFileNameOf,
  soakIdentity,
} from '../../../src/lab/readiness/report.ts';
import type { Engine } from '../../../src/lab/readiness/soak-evaluators.ts';
import { evaluateSoak } from '../../../src/lab/readiness/soak-evaluators.ts';
import { aggregate } from '../../../src/lab/readiness/verdict.ts';
import type { Evaluation } from '../../../src/lab/readiness/verdict.ts';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import { fakeWorld } from './fake-world.ts';
import { error, soak } from './soak-fixtures.ts';

// The sheet is what a person signs, so it is tested as text: the numbers and the verdicts are on the lines, a NO-GO is explained, the
// candidate sits next to A, and the checklist says what the lab decided and what it left to the owner. The files are read back strictly.

const host = {
  os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 16,
  node: 'v22',
  playwright: '1.64.1',
  git: { commit: 'abc1234', dirty: false },
} as HostInfo;

async function configuration(
  id: string,
  patch: Record<string, unknown> | null,
): Promise<ConfigurationResult> {
  const { world } = fakeWorld();
  const checks = await runReadinessChecks(world, {
    checks: ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'],
    joins: 5,
    stallRuns: 1,
    windowSec: 30,
    refreshes: 12,
    patch: patch as never,
  });
  return {
    id,
    label: id === 'A' ? 'the library defaults' : 'A plus streaming.liveSync.enabled',
    patch: patch as never,
    hypothesis: null,
    verdict: aggregate(checks.flatMap((check) => check.evaluations)),
    checks,
  };
}

const liveSync = candidateById('live-sync')?.patch as Record<string, unknown>;

function report(
  engine: Engine,
  configurations: ConfigurationResult[],
  envId = 'local-darwin-arm64',
  hash = 'abc1234',
): ReadinessReport {
  return {
    schemaVersion: 1,
    kind: 'readiness',
    envId,
    engine,
    generatedAt: '2030-01-01T00:00:00.000Z',
    durationMs: 480_000,
    commit: { hash, dirty: false },
    host,
    browser: { name: engine, version: '156.0', userAgent: null },
    stream: { id: 'live-cmaf', protocol: 'dash', contentHash: 'deadbeef' },
    options: {
      checks: ['PB-RDY-001', 'PB-RDY-002', 'PB-RDY-003', 'PB-RDY-004'],
      joins: 5,
      stallRuns: 1,
      windowSec: 30,
      refreshes: 12,
    },
    limits: limitsSnapshot(),
    configurations,
  };
}

function soakReport(
  engine: Engine,
  minutes: number,
  extra: { errors?: ReturnType<typeof error>[]; latency?: (sec: number) => number | null } = {},
): SoakReport {
  const input = soak({ minutes, engine, ...extra });
  const evaluated = evaluateSoak(input);
  return {
    schemaVersion: 1,
    kind: 'soak',
    envId: 'local-darwin-arm64',
    engine,
    generatedAt: '2030-01-01T01:00:00.000Z',
    durationMs: minutes * 60_000,
    commit: { hash: 'abc1234', dirty: false },
    host,
    browser: { name: engine, version: '156.0', userAgent: null },
    stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
    configuration: { id: 'A', label: 'the library defaults', patch: null },
    player: { shakaVersion: '5.3.3', userAgent: 'x', config: 'A', configured: [], loadMode: 'media-source' },
    options: {
      minutes,
      warmupSec: 60,
      sampleSec: 5,
      heapEverySec: 30,
      stallAtMinutes: null,
      staleAtMinutes: null,
    },
    limits: limitsSnapshot(),
    length: evaluated.kind,
    verdict: evaluated.verdict,
    evaluations: evaluated.evaluations,
    firstFrameMs: input.firstFrameMs,
    endMs: input.endMs,
    faults: [],
    series: { sampleCount: input.samples.length, samples: [...input.samples], heap: null, harness: [] },
    episodes: [],
    errors: [],
    consoleProblems: [],
    requests: { total: 0, refusedCount: 0, byKind: {}, refused: [], repeated: [] },
    harness: { firstHeapMb: 40, lastHeapMb: 42.5, firstServiceRssMb: 150, lastServiceRssMb: 152 },
  };
}

describe('the sheet of a readiness run', () => {
  it('prints the measured value, the limit and the verdict of every line, and explains the NO-GO of the defaults', async () => {
    const a = await configuration('A', null);
    const text = renderReadinessReport(report('chromium', [a]));
    expect(text).toContain('Live-event readiness: chromium 156.0 on local-darwin-arm64');
    expect(text).toContain('commit abc1234, clean');
    expect(text).toMatch(/GO\s+Start time, worst of 5 joins\s+900 ms\s+<= 5\.00 s/);
    expect(text).toMatch(/GO\s+Latency, p95 over the window\s+6\.20 s\s+<= 8\.00 s/);
    expect(text).toMatch(/GO\s+Stall recovery, worst of 1\s+4\.10 s\s+<= 14\.00 s/);
    expect(text).toMatch(
      /NO-GO\s+Latency restored after the stall, worst of 1\s+>= 6\d\.\d\d s\s+<= 60\.00 s/,
    );
    expect(text).toMatch(/GO\s+Manifest refresh, median gap\s+2\.00 s\s+>= 1\.00 s/);
    expect(text).toContain('Why:');
    expect(text).toContain('Latency was not back within 10.00 s');
    expect(text).toMatch(/Configuration A: the library defaults\s+NO-GO/);
  });

  it('puts the candidate next to A, and the candidate shows GO where the defaults fail', async () => {
    const a = await configuration('A', null);
    const candidate = await configuration('live-sync', liveSync);
    const both = report('chromium', [a, candidate]);
    const comparison = renderComparison(both);
    expect(comparison).toContain('Comparison with A (chromium)');
    expect(comparison).toMatch(
      /PB-RDY-003 Latency restored after the stall, worst of 1\s+NO-GO >= 6\d\.\d\d s\s+GO [23]\.\d\d s/,
    );
    expect(comparison).toMatch(/Verdict\s+NO-GO\s+GO/);
    // The start times of A and of a candidate are read with the path they were reached by (ADR-153), and the control is named.
    expect(comparison).toContain('Start times differ by the path as well as by the configuration');
    expect(comparison).toContain('{"streaming":{"liveSync":{"enabled":false}}}');
    expect(candidate.verdict).toBe('GO');
    // The exit code is the verdict of the build as it ships: a good candidate does not make A pass.
    expect(runVerdict([both])).toBe('NO-GO');
    expect(renderComparison(report('chromium', [a]))).toBeNull();
  });

  it('marks an advisory line as one that decides nothing, and a value that is only a lower bound', () => {
    const line: Evaluation = {
      id: 'x',
      check: 'PB-RDY-001',
      label: 'Start time, p95 of 5 joins',
      value: 1200,
      unit: 'ms',
      limit: 5000,
      bound: 'at-most',
      limitKey: 'startMaxMs',
      verdict: 'GO',
      sentence: '',
      scope: 'advisory',
    };
    expect(evaluationLine(line)).toContain('Start time, p95 of 5 joins (advisory)');
    expect(
      evaluationLine({ ...line, scope: 'criterion', censored: true, value: 65_000, verdict: 'NO-GO' }),
    ).toMatch(/NO-GO\s+Start time.*>= 65\.00 s/);
    expect(evaluationLine({ ...line, value: null, verdict: 'N/A' })).toContain('n/a');
  });
});

describe('the checklist of TEST_STRATEGY.md section 8', () => {
  it("is blocked by the NO-GO of the defaults, with the line that decided it, and leaves the owner's items open", async () => {
    const a = await configuration('A', null);
    const items = checklist({ readiness: [report('chromium', [a])], soaks: [] });
    expect(items).toHaveLength(10);
    expect(items.find((item) => item.number === 3)?.status).toBe('blocked');
    expect(items.find((item) => item.number === 5)?.status).toBe('blocked');
    expect(items.find((item) => item.number === 5)?.evidence.join(' ')).toContain(
      'Latency was not back within',
    );
    expect(items.find((item) => item.number === 4)?.status).toBe('open');
    for (const number of [2, 6, 7, 8, 9]) {
      const item = items.find((candidate) => candidate.number === number);
      expect(item?.owner).toBe(true);
      expect(item?.status).toBe('open');
    }
    expect(items.find((item) => item.number === 10)?.status).toBe('blocked');
    const text = renderChecklist({ readiness: [report('chromium', [a])], soaks: [] });
    expect(text).toContain('[!] 3.');
    expect(text).toContain('[ ] 2.');
    expect(text).toContain('LAB VERDICT: NO-GO (items 3, 5)');
  });

  it('is done only when every engine passes the four checks and every engine has a release soak that passed', async () => {
    const good = await configuration('A', liveSync);
    const three = (['chromium', 'firefox', 'webkit'] as const).map((engine) => report(engine, [good]));
    const withoutSoaks = checklist({ readiness: three, soaks: [] });
    expect(withoutSoaks.find((item) => item.number === 3)?.status).toBe('done');
    expect(withoutSoaks.find((item) => item.number === 4)?.status).toBe('open');
    const soaks = (['chromium', 'firefox', 'webkit'] as const).map((engine) => soakReport(engine, 30));
    const complete = checklist({ readiness: three, soaks });
    expect(complete.find((item) => item.number === 1)?.status).toBe('done');
    expect(complete.find((item) => item.number === 4)?.status).toBe('done');
    expect(complete.find((item) => item.number === 5)?.status).toBe('done');
    expect(renderChecklist({ readiness: three, soaks })).toContain(
      "LAB VERDICT: GO on the lab's items; the owner's items remain",
    );
  });

  it('does not count a CI soak, or a missing engine, as the release soak', async () => {
    const good = await configuration('A', liveSync);
    const three = (['chromium', 'firefox', 'webkit'] as const).map((engine) => report(engine, [good]));
    const ciOnly = checklist({
      readiness: three,
      soaks: [soakReport('chromium', 5), soakReport('firefox', 5), soakReport('webkit', 5)],
    });
    const item = ciOnly.find((candidate) => candidate.number === 4);
    expect(item?.status).toBe('open');
    expect(item?.evidence.join(' ')).toContain('CI soak only');
    expect(item?.evidence.join(' ')).toContain('no release soak (30 min) on record for chromium');
    const missing = checklist({ readiness: three.slice(0, 2), soaks: [] });
    expect(missing.find((candidate) => candidate.number === 3)?.status).toBe('open');
    expect(missing.find((candidate) => candidate.number === 3)?.evidence.join(' ')).toContain(
      'not run for webkit',
    );
  });

  it("lists a candidate's soak and does not count it: the release soak of the build as it ships is A's", async () => {
    const good = await configuration('A', liveSync);
    const three = (['chromium', 'firefox', 'webkit'] as const).map((engine) => report(engine, [good]));
    const asCandidate = (engine: Engine): SoakReport => ({
      ...soakReport(engine, 30),
      configuration: {
        id: 'live-sync',
        label: 'A plus streaming.liveSync.enabled',
        patch: liveSync as never,
      },
    });
    const onlyCandidates = checklist({
      readiness: three,
      soaks: (['chromium', 'firefox', 'webkit'] as const).map(asCandidate),
    });
    const item = onlyCandidates.find((candidate) => candidate.number === 4);
    expect(item?.status).toBe('open');
    expect(item?.evidence.join('\n')).toContain('no release soak (30 min) on record for chromium');
    expect(item?.evidence.join('\n')).toContain(
      'release soak of 30 min of the candidate live-sync: GO (evidence for a decision about the candidate, not about the build)',
    );
    // With A's soaks as well the item is done, and the candidate's soaks are still listed beside them.
    const both = checklist({
      readiness: three,
      soaks: (['chromium', 'firefox', 'webkit'] as const).flatMap((engine) => [
        soakReport(engine, 30),
        asCandidate(engine),
      ]),
    });
    expect(both.find((candidate) => candidate.number === 4)?.status).toBe('done');
    expect(both.find((candidate) => candidate.number === 4)?.evidence.join('\n')).toContain(
      'the candidate live-sync',
    );
    // A failed candidate soak does not block the build.
    const failedCandidate = {
      ...asCandidate('chromium'),
      verdict: 'NO-GO' as const,
    };
    const stillDone = checklist({
      readiness: three,
      soaks: [
        soakReport('chromium', 30),
        soakReport('firefox', 30),
        soakReport('webkit', 30),
        failedCandidate,
      ],
    });
    expect(stillDone.find((candidate) => candidate.number === 4)?.status).toBe('done');
  });

  it('says on the sheet and in the checklist that a run started on a busy machine was measured under load, and says nothing of a quiet one', async () => {
    const reading = (load1: number, cpus: number) => ({
      at: '2030-01-01T00:00:00.000Z',
      load1,
      load5: 20,
      load15: 5,
      cpus,
    });
    const busy = {
      ...soakReport('webkit', 5),
      load: { before: reading(66.4, 3), after: reading(3.07, 3) },
    };
    const text = renderSoakReport(busy);
    expect(text).toContain(
      'the machine was busy when the run started: a 1-minute load of 66.4 on 3 CPUs (22.1 per CPU)',
    );
    expect(text).not.toContain('busy when the run ended');
    expect(
      checklist({ readiness: [], soaks: [busy] })
        .find((item) => item.number === 4)
        ?.evidence.join('\n'),
    ).toContain('[busy at the start: load 66.4 on 3 CPUs]');
    const good = await configuration('A', liveSync);
    const loaded = {
      ...report('webkit', [good]),
      load: { before: reading(66.4, 3), after: reading(3.07, 3) },
    };
    expect(renderReadinessReport(loaded)).toContain('the machine was busy when the run started');
    expect(
      checklist({ readiness: [loaded], soaks: [] })
        .find((item) => item.number === 3)
        ?.evidence.join('\n'),
    ).toContain('[busy at the start: load 66.4 on 3 CPUs]');
    const quiet = { ...busy, load: { before: reading(0.5, 4), after: reading(1.0, 4) } };
    expect(renderSoakReport(quiet)).not.toContain('busy');
    // Only the start is judged: at the end the load is the run's own browser and service, which is no reason to doubt the run.
    const endsLoaded = { ...busy, load: { before: reading(0.5, 4), after: reading(9, 4) } };
    expect(renderSoakReport(endsLoaded)).not.toContain('busy');
  });

  it('calls a machine busy only when its 1-minute load is above its number of CPUs', () => {
    const at = (load1: number, cpus: number) => ({ at: 'x', load1, load5: 0, load15: 0, cpus });
    expect(isBusy(at(3, 3))).toBe(false);
    expect(isBusy(at(3.01, 3))).toBe(true);
    expect(isBusy(at(0.2, 4))).toBe(false);
    expect(isBusy(at(2.36, 4))).toBe(false);
    expect(isBusy(at(66.39, 3))).toBe(true);
    expect(loadPerCpu(at(8, 4))).toBe(2);
  });

  it('is blocked by a soak that failed, even a short one', () => {
    const failed = soakReport('chromium', 2, { errors: [error(60, 2)] });
    expect(failed.verdict).toBe('NO-GO');
    const items = checklist({ readiness: [], soaks: [failed] });
    expect(items.find((item) => item.number === 4)?.status).toBe('blocked');
  });

  it('says when the results are from more than one build', async () => {
    const good = await configuration('A', liveSync);
    const items = checklist({
      readiness: [
        report('chromium', [good], 'local-darwin-arm64', 'aaaaaaa'),
        report('webkit', [good], 'local-darwin-arm64', 'bbbbbbb'),
      ],
      soaks: [],
    });
    const item = items.find((candidate) => candidate.number === 1);
    expect(item?.status).toBe('open');
    expect(item?.evidence.join(' ')).toContain('2 different commits');
  });

  it('says what is missing when there is nothing at all', () => {
    const items = checklist({ readiness: [], soaks: [] });
    expect(items.find((item) => item.number === 1)?.evidence).toEqual(['no result files']);
    expect(items.every((item) => item.status === 'open')).toBe(true);
    expect(renderChecklist({ readiness: [], soaks: [] })).toContain(
      'LAB VERDICT: not yet decided: evidence is missing',
    );
    expect(runVerdict([])).toBe('INCONCLUSIVE');
  });

  it('prints the sheet and the checklist together for a run', async () => {
    const a = await configuration('A', null);
    const text = renderRun([report('chromium', [a])]);
    expect(text.indexOf('Live-event readiness')).toBeLessThan(text.indexOf('Go/no-go checklist'));
  });
});

describe('the sheet of a soak', () => {
  it('prints the verdict, the criteria with their values and limits, the evidence that decides nothing, and the harness memory', () => {
    const text = renderSoakReport(soakReport('chromium', 5));
    expect(text).toContain('Soak (PB-RDY-005): chromium 156.0 on local-darwin-arm64');
    expect(text).toContain('CI soak');
    expect(text).toMatch(/Soak verdict\s+GO/);
    expect(text).toMatch(/GO\s+Unrecovered stalls\s+0\s+<= 0/);
    expect(text).toMatch(/GO\s+Rebuffer ratio\s+0\.00 %\s+<= 0\.50 %/);
    expect(text).toMatch(/GO\s+JS heap growth\s+0\.0 MB\s+<= 20\.0 MB/);
    expect(text).toContain('Evidence that decides nothing here:');
    expect(text).toContain('Manifest refresh, median gap (advisory)');
    expect(text).toContain('The harness itself: heap 40.0 MB at the first reading, 42.5 MB at the last');
  });

  it('says why a soak that failed did', () => {
    const text = renderSoakReport(
      soakReport('chromium', 5, { errors: [error(100, 2, 'MEDIA_SOURCE_OPERATION_THREW')] }),
    );
    expect(text).toMatch(/Soak verdict\s+NO-GO/);
    expect(text).toContain('Why:');
    expect(text).toContain('MEDIA_SOURCE_OPERATION_THREW');
  });

  it('calls a run shorter than the CI soak what it is', () => {
    expect(renderSoakReport(soakReport('chromium', 1))).toContain('short run: not a verdict');
  });

  it('prints the note of a line that is a GO: two estimators of the drift that disagree are on the sheet', () => {
    const text = renderSoakReport(
      soakReport('chromium', 5, { latency: (sec) => (sec === 300 ? 30_000 : 6200) }),
    );
    expect(text).toMatch(/Soak verdict\s+GO/);
    expect(text).toMatch(/GO\s+Latency drift\s+0 ms\s+<= 1\.00 s/);
    expect(text).toContain('Notes:');
    expect(text).toContain('Latency drift: The two estimators of the drift disagree');
  });

  it('explains an informational line that is not a GO, and marks it as one that decides nothing', () => {
    const text = renderSoakReport(soakReport('chromium', 5, { errors: [error(100, 1, 'HTTP_ERROR')] }));
    expect(text).toMatch(/Soak verdict\s+GO/);
    expect(text).toMatch(/NO-GO\s+Unexplained recoverable errors \(advisory\)\s+1\s+<= 0/);
    expect(text).toContain('NO-GO (advisory): 1 recoverable error that no injected fault explains');
  });
});

describe('the result files', () => {
  it('are named by environment and engine, and a soak also by its length', () => {
    expect(readinessFileName('local-darwin-arm64', 'webkit')).toBe('local-darwin-arm64-webkit.json');
    expect(soakFileName('docker-linux-arm64', 'firefox', 30)).toBe('docker-linux-arm64-firefox-30m.json');
    expect(soakFileName('local-darwin-arm64', 'chromium', 2.5)).toBe('local-darwin-arm64-chromium-2.5m.json');
  });

  it("carry the candidate in a soak's name, and A keeps the name it always had (two soaks of one engine must not overwrite each other)", () => {
    const a = { id: 'A', patch: null };
    const liveSync = { id: 'live-sync', patch: { streaming: { liveSync: { enabled: true } } } };
    expect(soakFileName('gha-linux-x64', 'chromium', 30, { configuration: a })).toBe(
      'gha-linux-x64-chromium-30m.json',
    );
    expect(soakFileName('gha-linux-x64', 'chromium', 30, { configuration: null })).toBe(
      'gha-linux-x64-chromium-30m.json',
    );
    expect(soakFileName('gha-linux-x64', 'chromium', 30, { configuration: liveSync })).toBe(
      'gha-linux-x64-chromium-30m-live-sync.json',
    );
    expect(soakFileName('gha-linux-x64', 'chromium', 30, { configuration: liveSync })).not.toBe(
      soakFileName('gha-linux-x64', 'chromium', 30, { configuration: a }),
    );
  });

  it('carry the protocol when it is not DASH, in a readiness file and in a soak, and the order of the parts is fixed', () => {
    expect(readinessFileName('gha-linux-x64', 'webkit', 'dash')).toBe('gha-linux-x64-webkit.json');
    expect(readinessFileName('gha-linux-x64', 'webkit', 'hls')).toBe('gha-linux-x64-webkit-hls.json');
    expect(soakFileName('gha-linux-x64', 'webkit', 5, { protocol: 'hls' })).toBe(
      'gha-linux-x64-webkit-5m-hls.json',
    );
    expect(
      soakFileName('gha-linux-x64', 'webkit', 5, {
        protocol: 'hls',
        configuration: { id: 'live-sync', patch: {} },
      }),
    ).toBe('gha-linux-x64-webkit-5m-hls-live-sync.json');
  });

  it('tell two custom patches apart by a digest of the patch, which does not depend on the order of its keys', () => {
    const one = {
      id: 'custom',
      patch: { streaming: { liveSync: { enabled: false } }, abr: { enabled: false } },
    };
    const reordered = {
      id: 'custom',
      patch: { abr: { enabled: false }, streaming: { liveSync: { enabled: false } } },
    };
    const other = { id: 'custom', patch: { streaming: { liveSync: { enabled: true } } } };
    const name = (configuration: { id: string; patch: unknown }): string =>
      soakFileName('x', 'chromium', 5, { configuration });
    expect(name(one)).toMatch(/^x-chromium-5m-custom-[0-9a-f]{8}\.json$/);
    expect(name(reordered)).toBe(name(one));
    expect(name(other)).not.toBe(name(one));
  });

  it('are named from what they hold: the name of a file is a function of its content', async () => {
    const a = await configuration('A', null);
    const candidate = await configuration('live-sync', liveSync);
    const both = report('chromium', [a, candidate]);
    expect(readinessFileNameOf(both)).toBe(readinessFileName(both.envId, 'chromium'));
    const ofA = soakReport('webkit', 30);
    expect(soakFileNameOf(ofA)).toBe(
      soakFileName(ofA.envId, 'webkit', 30, { configuration: ofA.configuration }),
    );
    const ofCandidate = { ...ofA, configuration: { id: 'live-sync', label: 'x', patch: liveSync } };
    expect(soakFileNameOf(ofCandidate)).toBe(`${soakFileNameOf(ofA).replace(/\.json$/, '')}-live-sync.json`);
    expect(soakIdentity(ofCandidate)).not.toBe(soakIdentity(ofA));
  });

  it('are read back as written, and refused with the list of what is wrong when they are not valid', async () => {
    const a = await configuration('A', null);
    const original = report('chromium', [a]);
    const roundTrip = parseReadinessReport(JSON.stringify(original), 'x.json');
    expect(roundTrip.configurations[0]?.checks).toHaveLength(4);
    expect(renderReadinessReport(roundTrip)).toBe(renderReadinessReport(original));

    expect(() => parseReadinessReport('{nope', 'x.json')).toThrow(/x\.json: not JSON/);
    expect(() => parseReadinessReport('[]', 'x.json')).toThrow(ResultFileError);
    const broken = JSON.parse(JSON.stringify(original)) as {
      schemaVersion: number;
      configurations: Array<{ checks: Array<{ evaluations: Array<{ verdict?: string }> }> }>;
    };
    broken.schemaVersion = 2;
    delete broken.configurations[0]?.checks[0]?.evaluations[0]?.verdict;
    expect(() => parseReadinessReport(JSON.stringify(broken), 'x.json')).toThrow(
      /schemaVersion is 2[\s\S]*no verdict/,
    );
  });

  it('read a soak back, and refuse a readiness file where a soak is expected', () => {
    const original = soakReport('chromium', 5);
    expect(parseSoakReport(JSON.stringify(original), 'y.json').verdict).toBe('GO');
    expect(() => parseSoakReport(JSON.stringify({ ...original, kind: 'readiness' }), 'y.json')).toThrow(
      /kind is readiness, expected soak/,
    );
    expect(() => parseSoakReport(JSON.stringify({ ...original, length: 'forever' }), 'y.json')).toThrow(
      /length is not release, ci or short/,
    );
  });
});
