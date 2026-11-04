import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceError,
  buildEvidence,
  faultRecovery,
  marginOf,
  parseMachineRecord,
  parseRunsFile,
  renderEvidenceBlocks,
  renderMargins,
  runUrl,
  staleStall,
} from '../../../src/lab/readiness/evidence.ts';
import type { EvidenceEntry, EvidenceSource } from '../../../src/lab/readiness/evidence.ts';
import { isBusy, soakVerdictToday } from '../../../src/lab/readiness/report.ts';
import type { ReadinessReport, SoakReport } from '../../../src/lab/readiness/report.ts';
import { evaluateLatencyLevel } from '../../../src/lab/readiness/soak-evaluators.ts';
import type { FaultWindow, SoakInput } from '../../../src/lab/readiness/soak-evaluators.ts';
import { renderFromDisk, resultsDocsProblems } from '../../../tools/results-docs.ts';

// The evidence of the readiness runs on GitHub's runners (docs/results, docs/results/provenance) and the tables generated from it
// (docs/results/readiness/README.md, docs/READINESS.md). The files are real and are read from the disk: what is asserted about them is
// what the write-up says, so that a file replaced without its write-up, or a write-up that says more than its files, fails here. The
// first evidence (batch `first`, commit 0d62c1d) and the extra runs (batch `extra`, commit e0a5be3) are asserted apart: a sentence about
// one stays about it.

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const read = (path: string): Buffer => readFileSync(resolve(ROOT, path));
const source: EvidenceSource = {
  runs: read('docs/results/provenance/runs.json').toString('utf8'),
  result: (file) => read(file),
  machine: (label) => read(`docs/results/provenance/machines/${label}.txt`).toString('utf8'),
};
const { runs, entries } = buildEvidence(source);

const inBatch = (batch: string): EvidenceEntry[] => entries.filter((entry) => entry.run.batch === batch);
const readinessReports = (batch = 'first'): ReadinessReport[] =>
  inBatch(batch).flatMap(({ report }) => (report.kind === 'readiness' ? [report] : []));
const soakReports = (batch = 'first'): Array<{ entry: EvidenceEntry; report: SoakReport }> =>
  inBatch(batch).flatMap((entry) => (entry.report.kind === 'soak' ? [{ entry, report: entry.report }] : []));
const named = (file: string): EvidenceEntry => {
  const found = entries.find((entry) => entry.run.file.endsWith(`/${file}`));
  if (found === undefined) throw new Error(`no entry for ${file}`);
  return found;
};
const soakNamed = (file: string): SoakReport => {
  const { report } = named(file);
  if (report.kind !== 'soak') throw new Error(`${file} is not a soak`);
  return report;
};
const evaluationOf = (report: ReadinessReport, configuration: string, id: string) =>
  report.configurations
    .find((candidate) => candidate.id === configuration)
    ?.checks.flatMap((check) => check.evaluations)
    .find((evaluation) => evaluation.id === id);

describe('the committed evidence and its provenance', () => {
  it('holds 24 runs in two batches, 18 on commit 0d62c1d and 6 on e0a5be3, each file exactly what its job uploaded and named for what it holds', () => {
    expect(entries).toHaveLength(24);
    expect(inBatch('first')).toHaveLength(18);
    expect(inBatch('extra')).toHaveLength(6);
    expect(runs.runs.filter((run) => run.task === 'readiness' && run.batch === 'first')).toHaveLength(4);
    expect(runs.runs.filter((run) => run.task === 'readiness' && run.batch === 'extra')).toHaveLength(2);
    expect(new Set(entries.map(({ report }) => report.envId))).toEqual(
      new Set(['gha-linux-x64', 'gha-macos-arm64']),
    );
    expect(new Set(inBatch('extra').map(({ report }) => report.envId))).toEqual(new Set(['gha-linux-x64']));
    for (const { report, machine, run } of entries) {
      const hash = run.batch === 'first' ? '0d62c1d' : 'e0a5be3';
      expect(report.commit).toEqual({ hash, dirty: false });
      expect(machine.commit.startsWith(hash)).toBe(true);
    }
    expect(runUrl(runs.repository, 41876070337)).toBe(
      'https://github.com/hanniavalera/playback-proof/actions/runs/41876070337',
    );
  });

  it('keeps its generated tables up to date, so that no number in them is typed', () => {
    expect(resultsDocsProblems()).toEqual([]);
  });

  it('renames every file whose uploaded name is not the one its content gets: the 7 soaks of the candidate of the first batch and all 6 extra runs', () => {
    const base = (path: string): string => path.split('/').pop() ?? '';
    const renamed = runs.runs.filter((run) => base(run.file) !== base(run.uploadedAs));
    const first = renamed.filter((run) => run.batch === 'first');
    expect(first).toHaveLength(7);
    for (const run of first) expect(run.file).toMatch(/-live-sync\.json$/);
    expect(renamed.filter((run) => run.batch === 'extra')).toHaveLength(6);
    expect(runs.runs.filter((run) => !renamed.includes(run))).toHaveLength(11);
  });

  it('says what each extra run was dispatched with, which agrees with what its file says it ran, and nothing for the first batch', () => {
    expect(runs.runs.filter((run) => run.batch === 'first').every((run) => run.args === null)).toBe(true);
    const extra = runs.runs.filter((run) => run.batch === 'extra');
    expect(extra.map((run) => [run.label, run.runId, run.args])).toEqual([
      ['stale-webkit-ls', 41892387342, '--minutes 8 --no-stall --stale-at-minutes 2 --candidate live-sync'],
      ['stale-webkit-a', 41892396172, '--minutes 8 --no-stall --stale-at-minutes 2'],
      ['stale-chromium-ls', 41892404014, '--minutes 8 --no-stall --stale-at-minutes 2 --candidate live-sync'],
      ['stale-firefox-ls', 41892411630, '--minutes 8 --no-stall --stale-at-minutes 2 --candidate live-sync'],
      ['rdy-hls-chromium', 41892419140, '--candidate live-sync --protocol hls'],
      ['rdy-hls-webkit', 41892426392, '--candidate live-sync --protocol hls'],
    ]);
    for (const { run, report } of inBatch('extra')) {
      const argv = (run.args ?? '').split(' ');
      const after = (flag: string): string | undefined => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
      };
      const candidate = after('--candidate') ?? 'A';
      if (report.kind === 'soak') {
        expect(report.options.minutes, run.label).toBe(Number(after('--minutes')));
        expect(report.options.stallAtMinutes === null, run.label).toBe(argv.includes('--no-stall'));
        expect(report.options.staleAtMinutes, run.label).toBe(Number(after('--stale-at-minutes')));
        expect(report.configuration.id, run.label).toBe(candidate);
      } else {
        expect(report.stream.protocol, run.label).toBe(after('--protocol') ?? 'dash');
        expect(
          report.configurations.map((configuration) => configuration.id),
          run.label,
        ).toEqual(candidate === 'A' ? ['A'] : ['A', candidate]);
      }
    }
  });
});

describe('what the write-up says about the readiness runs', () => {
  it('has the defaults NO-GO on PB-RDY-003 and nowhere else, and the candidate GO, in all four runs', () => {
    const reports = readinessReports();
    expect(reports).toHaveLength(4);
    for (const report of reports) {
      const a = report.configurations.find((configuration) => configuration.id === 'A');
      const candidate = report.configurations.find((configuration) => configuration.id === 'live-sync');
      expect(a?.verdict).toBe('NO-GO');
      expect(a?.checks.filter((check) => check.verdict !== 'GO').map((check) => check.id)).toEqual([
        'PB-RDY-003',
      ]);
      expect(candidate?.verdict).toBe('GO');
    }
  });

  it('has the defaults end every outage 10.15 to 11.50 s behind the edge, never above a rate of 1, and the candidate 1.38 to 1.43 s above its own level', () => {
    const finals: number[] = [];
    const lost: number[] = [];
    for (const report of readinessReports()) {
      const a = evaluationOf(report, 'A', 'stall.restore');
      const candidate = evaluationOf(report, 'live-sync', 'stall.restore');
      expect(a?.detail?.['maxPlaybackRate']).toBe(1);
      expect(candidate?.detail?.['maxPlaybackRate']).toBe(1.1);
      for (const run of (a?.detail?.['runs'] ?? []) as Array<{
        finalLatencyMs: number;
        restoredAtMs: number | null;
      }>) {
        finals.push(run.finalLatencyMs);
        expect(run.restoredAtMs).toBeNull();
      }
      for (const run of (candidate?.detail?.['runs'] ?? []) as Array<{
        finalLatencyMs: number;
        latencyBeforeMs: number;
        restoredAtMs: number | null;
      }>) {
        lost.push(run.finalLatencyMs - run.latencyBeforeMs);
        expect(run.restoredAtMs).not.toBeNull();
      }
    }
    expect(finals).toHaveLength(12);
    expect(Math.min(...finals) / 1000).toBeCloseTo(10.15, 2);
    expect(Math.max(...finals) / 1000).toBeCloseTo(11.5, 2);
    expect(lost).toHaveLength(12);
    expect(Math.min(...lost) / 1000).toBeGreaterThanOrEqual(1.38);
    expect(Math.max(...lost) / 1000).toBeLessThanOrEqual(1.43);
  });

  it('has the absolute and the relative reading of "restored" agree in all 24 runs', () => {
    let runsCompared = 0;
    for (const report of readinessReports()) {
      for (const configuration of ['A', 'live-sync']) {
        const absolute = (evaluationOf(report, configuration, 'stall.restore')?.detail?.['runs'] ??
          []) as Array<{ restoredAtMs: number | null }>;
        const relative = (evaluationOf(report, configuration, 'stall.restore-relative')?.detail?.['runs'] ??
          []) as Array<{ restoredAtMs: number | null }>;
        expect(relative).toHaveLength(absolute.length);
        absolute.forEach((run, index) => {
          expect(run.restoredAtMs === null).toBe(relative[index]?.restoredAtMs === null);
          runsCompared += 1;
        });
      }
    }
    expect(runsCompared).toBe(24);
  });

  it('has the margins it quotes: the thinnest NO-GO of the absolute reading is 0.15 s, and every start is under half a second', () => {
    const margin = (report: ReadinessReport) => {
      const runsOf = (evaluationOf(report, 'A', 'stall.restore')?.detail?.['runs'] ?? []) as Array<{
        finalLatencyMs: number;
      }>;
      return Math.min(...runsOf.map((run) => run.finalLatencyMs - 10_000));
    };
    expect(Math.min(...readinessReports().map(margin)) / 1000).toBeCloseTo(0.15, 2);
    for (const report of readinessReports())
      for (const configuration of report.configurations)
        expect(evaluationOf(report, configuration.id, 'start.worst')?.value).toBeLessThan(500);
  });
});

describe('what the write-up says about the soaks', () => {
  it('has all 14 GO as measured and 8 NO-GO by the criteria of today: the 7 of A and the 30-minute candidate on WebKit on Linux', () => {
    const soaks = soakReports();
    expect(soaks).toHaveLength(14);
    expect(soaks.every(({ report }) => report.verdict === 'GO')).toBe(true);
    const nogo = soaks
      .filter(({ report }) => soakVerdictToday(report).verdict === 'NO-GO')
      .map(({ entry }) => entry.run.file.split('/').pop());
    expect(nogo).toHaveLength(8);
    expect(nogo).toContain('gha-linux-x64-webkit-30m-live-sync.json');
    expect(
      soaks
        .filter(({ report }) => report.configuration.id === 'A')
        .every(({ report }) => soakVerdictToday(report).verdict === 'NO-GO'),
    ).toBe(true);
    // the stored files are not touched by judging them again
    expect(
      soaks.every(
        ({ report }) =>
          report.evaluations.find((line) => line.id === 'soak.latency-p95')?.scope === 'advisory',
      ),
    ).toBe(true);
  });

  it('has no rebuffering, no stall, no error and a heap growth of 0.56 MB at most in all 14', () => {
    for (const { report } of soakReports()) {
      const value = (id: string): number | null =>
        report.evaluations.find((line) => line.id === id)?.value ?? null;
      expect(value('soak.rebuffer-ratio')).toBe(0);
      expect(value('soak.stalls')).toBe(0);
      expect(value('soak.critical-errors')).toBe(0);
      expect(value('soak.unexplained-critical-errors')).toBe(0);
      expect(report.errors).toEqual([]);
      const heap = value('soak.heap-growth');
      if (report.engine === 'chromium') expect(heap).toBeLessThan(0.56 + 1e-3);
      else expect(heap).toBeNull();
    }
  });

  it('has the soaks of A sit 10.62 to 12.79 s behind the edge after the faults, and the candidate 6.99 to 7.49 s except on WebKit on Linux in 30 minutes', () => {
    const levels = (configuration: string): number[] =>
      soakReports()
        .filter(({ report }) => report.configuration.id === configuration)
        .map(
          ({ report }) =>
            (report.evaluations.find((line) => line.id === 'soak.latency-p95')?.value ?? 0) / 1000,
        );
    const a = levels('A');
    expect(Math.min(...a)).toBeCloseTo(10.62, 2);
    expect(Math.max(...a)).toBeCloseTo(12.79, 2);
    const candidate = levels('live-sync').filter((level) => level < 10);
    expect(candidate).toHaveLength(6);
    expect(Math.min(...candidate)).toBeCloseTo(6.99, 2);
    expect(Math.max(...candidate)).toBeLessThan(7.43);
  });
});

describe('what the write-up says about the HLS runs', () => {
  type StallRun = { latencyBeforeMs: number; finalLatencyMs: number; restoredAtMs: number | null };
  const runsOf = (report: ReadinessReport, configuration: string, id: string): StallRun[] =>
    (evaluationOf(report, configuration, id)?.detail?.['runs'] ?? []) as StallRun[];
  const hls = (engine: string): ReadinessReport => {
    const found = readinessReports('extra').find((report) => report.engine === engine);
    if (found === undefined) throw new Error(`no HLS run of ${engine}`);
    return found;
  };

  it('has the defaults NO-GO on PB-RDY-003 and nowhere else, and the candidate GO, on Chromium and on WebKit', () => {
    const reports = readinessReports('extra');
    expect(reports.map((report) => [report.engine, report.stream.protocol])).toEqual([
      ['chromium', 'hls'],
      ['webkit', 'hls'],
    ]);
    for (const report of reports) {
      const a = report.configurations.find((configuration) => configuration.id === 'A');
      const candidate = report.configurations.find((configuration) => configuration.id === 'live-sync');
      expect(a?.verdict).toBe('NO-GO');
      expect(a?.checks.filter((check) => check.verdict !== 'GO').map((check) => check.id)).toEqual([
        'PB-RDY-003',
      ]);
      expect(candidate?.verdict).toBe('GO');
      expect(evaluationOf(report, 'A', 'stall.restore')?.detail?.['maxPlaybackRate']).toBe(1);
      expect(evaluationOf(report, 'live-sync', 'stall.restore')?.detail?.['maxPlaybackRate']).toBe(1.1);
    }
  });

  it('has the defaults on WebKit end 10.17 to 10.19 s behind the edge with no run restored, and the candidate restored in every run on both engines', () => {
    const finals = runsOf(hls('webkit'), 'A', 'stall.restore').map((run) => run.finalLatencyMs / 1000);
    expect(Math.min(...finals)).toBeCloseTo(10.17, 2);
    expect(Math.max(...finals)).toBeCloseTo(10.19, 2);
    expect(runsOf(hls('webkit'), 'A', 'stall.restore').every((run) => run.restoredAtMs === null)).toBe(true);
    expect(
      runsOf(hls('webkit'), 'A', 'stall.restore-relative').every((run) => run.restoredAtMs === null),
    ).toBe(true);
    for (const engine of ['chromium', 'webkit'])
      for (const id of ['stall.restore', 'stall.restore-relative'])
        expect(runsOf(hls(engine), 'live-sync', id).every((run) => run.restoredAtMs !== null)).toBe(true);
    const ownLevel = ['chromium', 'webkit'].flatMap((engine) =>
      runsOf(hls(engine), 'live-sync', 'stall.restore-relative').map((run) => (run.restoredAtMs ?? 0) / 1000),
    );
    expect(Math.min(...ownLevel)).toBeCloseTo(19.97, 2);
    expect(Math.max(...ownLevel)).toBeCloseTo(21.02, 2);
  });

  it('has the defaults on Chromium end 8.96, 10.15 and 10.02 s behind the edge: a NO-GO that rests on two runs 0.15 and 0.02 s over the maximum, one run judged restored at 56.05 s, and the relative reading NO-GO in all three', () => {
    const absolute = runsOf(hls('chromium'), 'A', 'stall.restore');
    expect(absolute.map((run) => Number((run.finalLatencyMs / 1000).toFixed(2)))).toEqual([
      8.96, 10.15, 10.02,
    ]);
    expect(absolute.map((run) => run.restoredAtMs === null)).toEqual([false, true, true]);
    expect((absolute[0]?.restoredAtMs ?? 0) / 1000).toBeCloseTo(56.05, 2);
    expect(evaluationOf(hls('chromium'), 'A', 'stall.restore')?.verdict).toBe('NO-GO');
    const relative = runsOf(hls('chromium'), 'A', 'stall.restore-relative');
    expect(relative.every((run) => run.restoredAtMs === null)).toBe(true);
    const ceiling = (absolute[0]?.latencyBeforeMs ?? 0) + 2000;
    expect(ceiling / 1000).toBeCloseTo(8.07, 2);
    expect(absolute.map((run) => Number(((run.finalLatencyMs - ceiling) / 1000).toFixed(2)))).toEqual([
      0.89, 2.08, 1.95,
    ]);
  });

  it('has run 1 of the defaults on Chromium alternate by about a second between two reads from 57 s on, at a rate of 1, and no other run jump by half a second at a rate of 1 except run 1 of the defaults on Firefox over DASH', () => {
    type Read = { sinceResumeMs: number; latencyMs: number; playbackRate: number };
    const afterOf = (report: ReadinessReport, configuration: string): Read[][] =>
      (
        report.configurations
          .find((candidate) => candidate.id === configuration)
          ?.checks.find((check) => check.id === 'PB-RDY-003')?.samples as { runs: Array<{ after: Read[] }> }
      ).runs.map((run) => run.after);
    const jumps: string[] = [];
    for (const { run, report } of entries) {
      if (report.kind !== 'readiness') continue;
      for (const configuration of report.configurations)
        afterOf(report, configuration.id).forEach((reads, index) => {
          const found = reads.filter(
            (read, at) =>
              at > 0 &&
              read.playbackRate === 1 &&
              reads[at - 1]?.playbackRate === 1 &&
              Math.abs(read.latencyMs - (reads[at - 1]?.latencyMs ?? 0)) >= 500,
          );
          if (found.length > 0)
            jumps.push(`${run.label} ${configuration.id} run ${index + 1}: ${found.length}`);
        });
    }
    expect(jumps.map((entry) => entry.replace(/: \d+$/, ''))).toEqual([
      'rdy-firefox A run 1',
      'rdy-hls-chromium A run 1',
    ]);
    const first = afterOf(hls('chromium'), 'A')[0] ?? [];
    const from57 = first.filter((read) => read.sinceResumeMs >= 57_000);
    expect(from57.length).toBeGreaterThanOrEqual(8);
    from57.slice(1).forEach((read, at) => {
      const step = Math.abs(read.latencyMs - (from57[at]?.latencyMs ?? 0)) / 1000;
      expect(step).toBeGreaterThan(0.9);
      expect(step).toBeLessThan(1.1);
      expect(read.playbackRate).toBe(1);
    });
  });

  it('has the two readings of "restored" disagree in 1 of the 12 HLS runs, the first of the defaults on Chromium, and in none of the 24 DASH runs', () => {
    const disagreements = (reports: ReadinessReport[]): string[] =>
      reports.flatMap((report) =>
        report.configurations.flatMap((configuration) =>
          runsOf(report, configuration.id, 'stall.restore').flatMap((run, index) =>
            (run.restoredAtMs === null) !==
            (runsOf(report, configuration.id, 'stall.restore-relative')[index]?.restoredAtMs === null)
              ? [`${report.engine} ${configuration.id} run ${index + 1}`]
              : [],
          ),
        ),
      );
    expect(disagreements(readinessReports('extra'))).toEqual(['chromium A run 1']);
    expect(disagreements(readinessReports('first'))).toEqual([]);
  });

  it('has HLS starts of 86 to 525 ms, slower than DASH for the same engine and configuration, and the same latency and the same manifest cadence', () => {
    const start = (report: ReadinessReport, configuration: string): number =>
      evaluationOf(report, configuration, 'start.worst')?.value ?? 0;
    const dash = (engine: string): ReadinessReport => {
      const found = readinessReports('first').find(
        (report) => report.engine === engine && report.envId === 'gha-linux-x64',
      );
      if (found === undefined) throw new Error(`no DASH run of ${engine}`);
      return found;
    };
    const values: number[] = [];
    for (const engine of ['chromium', 'webkit'])
      for (const configuration of ['A', 'live-sync']) {
        expect(start(hls(engine), configuration), `${engine} ${configuration}`).toBeGreaterThan(
          start(dash(engine), configuration),
        );
        values.push(start(hls(engine), configuration));
        expect(
          Math.abs(
            (evaluationOf(hls(engine), configuration, 'latency.p95')?.value ?? 0) -
              (evaluationOf(dash(engine), configuration, 'latency.p95')?.value ?? 0),
          ),
        ).toBeLessThan(10);
        expect(evaluationOf(hls(engine), configuration, 'cadence.median')?.value).toBeGreaterThan(1990);
        expect(evaluationOf(hls(engine), configuration, 'cadence.longest')?.value).toBeLessThan(2050);
      }
    expect(Math.round(Math.min(...values))).toBe(86);
    expect(Math.round(Math.max(...values))).toBe(525);
  });
});

describe('what the write-up says about the stale-manifest soaks', () => {
  const FILES = {
    chromium: 'gha-linux-x64-chromium-8m-nostall-stale2m-live-sync.json',
    firefox: 'gha-linux-x64-firefox-8m-nostall-stale2m-live-sync.json',
    webkitCandidate: 'gha-linux-x64-webkit-8m-nostall-stale2m-live-sync.json',
    webkitDefaults: 'gha-linux-x64-webkit-8m-nostall-stale2m.json',
  } as const;

  it('are four soaks of 8 minutes with one stale manifest at minute 2 and nothing else injected, with a whole series and 67 or 68 reads to judge', () => {
    const soaks = soakReports('extra');
    expect(soaks).toHaveLength(4);
    for (const { report } of soaks) {
      expect(report.length).toBe('ci');
      expect(report.faults).toHaveLength(1);
      expect(report.faults[0]?.kind).toBe('stale-manifest');
      expect(((report.faults[0]?.startMs ?? 0) - report.firstFrameMs) / 60_000).toBeCloseTo(2, 1);
      expect(report.series.sampleCount).toBe(report.series.samples.length);
      const reads = report.evaluations.find((line) => line.id === 'soak.latency-p95')?.detail?.['reads'];
      expect([67, 68]).toContain(reads);
      expect(report.errors).toEqual([]);
    }
  });

  it("has the defaults on WebKit stay 12.63 s behind the edge after it, GO as measured and NO-GO by today's criteria", () => {
    const report = soakNamed(FILES.webkitDefaults);
    const recovery = faultRecovery(report);
    expect((recovery?.levelBeforeMs ?? 0) / 1000).toBeCloseTo(6.13, 2);
    expect((recovery?.stallMs ?? 0) / 1000).toBeCloseTo(6.49, 2);
    expect((recovery?.highestMs ?? 0) / 1000).toBeCloseTo(12.63, 2);
    expect(recovery?.underMaximumAfterSec).toBeNull();
    expect(recovery?.atOwnLevelAfterSec).toBeNull();
    expect((recovery?.levelAtEndMs ?? 0) / 1000).toBeCloseTo(12.63, 2);
    expect(report.verdict).toBe('GO');
    const today = soakVerdictToday(report);
    expect(today.verdict).toBe('NO-GO');
    expect(today.changedBy.map((line) => line.id)).toEqual(['soak.latency-p95', 'soak.latency-max']);
  });

  it('has the candidate come back on all three engines: under 10 s 30 to 36 s after the fault ended, at its own level 50 to 51 s after it, and 0.76 to 0.89 s above its level before it', () => {
    const expected = [
      [FILES.chromium, 6.1, 6.44, 12.31, 30, 50, 6.99],
      [FILES.firefox, 6.15, 6.54, 12.24, 30, 50, 7.0],
      [FILES.webkitCandidate, 6.23, 6.64, 12.61, 36, 51, 6.99],
    ] as const;
    for (const [file, before, stall, highest, under, own, end] of expected) {
      const report = soakNamed(file);
      const recovery = faultRecovery(report);
      expect((recovery?.levelBeforeMs ?? 0) / 1000, file).toBeCloseTo(before, 2);
      expect((recovery?.stallMs ?? 0) / 1000, file).toBeCloseTo(stall, 2);
      expect((recovery?.highestMs ?? 0) / 1000, file).toBeCloseTo(highest, 2);
      expect(Math.round(recovery?.underMaximumAfterSec ?? -1), file).toBe(under);
      expect(Math.round(recovery?.atOwnLevelAfterSec ?? -1), file).toBe(own);
      expect((recovery?.levelAtEndMs ?? 0) / 1000, file).toBeCloseTo(end, 2);
      expect(((recovery?.levelAtEndMs ?? 0) - (recovery?.levelBeforeMs ?? 0)) / 1000).toBeGreaterThan(0.75);
      expect(((recovery?.levelAtEndMs ?? 0) - (recovery?.levelBeforeMs ?? 0)) / 1000).toBeLessThan(0.9);
      expect(soakVerdictToday(report).verdict, file).toBe('GO');
    }
  });

  it("are judged by today's criteria from the files: the criterion's own code over the stored series gives exactly the stored lines", () => {
    for (const { report } of soakReports('extra')) {
      const input = {
        firstFrameMs: report.firstFrameMs,
        endMs: report.endMs,
        warmupMs: report.options.warmupSec * 1000,
        samples: report.series.samples,
        faults: report.faults,
      } as unknown as SoakInput;
      const [p95, max] = evaluateLatencyLevel(input);
      const stored = (id: string) => report.evaluations.find((line) => line.id === id);
      expect(p95?.value).toBe(stored('soak.latency-p95')?.value);
      expect(max?.value).toBe(stored('soak.latency-max')?.value);
      expect(p95?.detail?.['reads']).toBe(stored('soak.latency-p95')?.detail?.['reads']);
      expect(p95?.verdict).toBe(stored('soak.latency-p95')?.verdict);
      expect(stored('soak.latency-p95')?.scope).toBe('advisory');
    }
  });

  it('have the stall plus the media buffered ahead between 10.44 and 11.51 s in all ten soaks that had a stale manifest, and the stall fall as the latency before it rises', () => {
    const rows = entries.flatMap(({ report }) =>
      report.kind === 'soak'
        ? report.faults
            .filter((fault) => fault.kind === 'stale-manifest')
            .map((fault) => ({ report, stall: staleStall(report, fault) }))
        : [],
    );
    expect(rows).toHaveLength(10);
    const covered = rows.map(({ stall }) => (stall.stallMs ?? 0) / 1000 + (stall.bufferedAheadSec ?? 0));
    expect(Math.min(...covered)).toBeCloseTo(10.44, 2);
    expect(Math.max(...covered)).toBeCloseTo(11.51, 2);
    const group = (low: number, high: number) =>
      rows.filter(
        ({ stall }) => (stall.levelBeforeMs ?? 0) / 1000 >= low && (stall.levelBeforeMs ?? 0) / 1000 < high,
      );
    const stalls = (rowsOf: typeof rows) => rowsOf.map(({ stall }) => (stall.stallMs ?? 0) / 1000);
    expect(group(0, 6.5)).toHaveLength(4);
    expect(Math.min(...stalls(group(0, 6.5)))).toBeGreaterThan(6.43);
    expect(group(6.9, 7.1)).toHaveLength(3);
    expect(Math.min(...stalls(group(6.9, 7.1)))).toBeGreaterThan(5.4);
    expect(Math.max(...stalls(group(6.9, 7.1)))).toBeLessThan(6.2);
    expect(group(10, 11)).toHaveLength(3);
    expect(Math.max(...stalls(group(10, 11)))).toBeLessThan(2.25);
  });
});

describe('faultRecovery and staleStall, over series that say what they must', () => {
  const t0 = 1_000_000;
  const fault: FaultWindow = { kind: 'stale-manifest', startMs: t0 + 120_000, endMs: t0 + 130_000 };
  /** A soak sampled every 5 s for 480 s: `latency` and `buffer` are functions of the second, in ms and in s. */
  const soak = (
    latency: (sec: number) => number | null,
    extra: {
      episodes?: Array<{ startMs: number; durationMs: number }>;
      thinned?: boolean;
      buffer?: (sec: number) => number;
    } = {},
  ): SoakReport => {
    const samples = Array.from({ length: 97 }, (_, index) => {
      const sec = index * 5;
      return { atMs: t0 + sec * 1000, latencyMs: latency(sec), bufferedAheadSec: extra.buffer?.(sec) ?? 5 };
    });
    return {
      firstFrameMs: t0,
      endMs: t0 + 480_000,
      faults: [fault],
      episodes: extra.episodes ?? [],
      options: { warmupSec: 60, sampleSec: 5 },
      series: { sampleCount: extra.thinned === true ? 120 : samples.length, samples },
    } as unknown as SoakReport;
  };
  // 6 s before the fault (20 s in the warm-up, which is left out), 12.5 s when the fault ends and 0.1 s per second back to 7 s.
  const cameBack = (sec: number): number =>
    sec < 60 ? 20_000 : sec < 130 ? 6000 : Math.max(7000, 12_500 - 100 * (sec - 130));

  it('reads a player that came back: its level before, the stall, the highest read, and from when it stayed under the maximum and within a segment of its own level', () => {
    const recovery = faultRecovery(
      soak(cameBack, { episodes: [{ startMs: fault.startMs + 6000, durationMs: 6500 }] }),
    );
    expect(recovery).toMatchObject({
      levelBeforeMs: 6000,
      stallMs: 6500,
      highestMs: 12_500,
      underMaximumAfterSec: 25,
      atOwnLevelAfterSec: 45,
      levelAtEndMs: 7000,
      sampleSec: 5,
    });
  });

  it('says null at both times for a player that did not come back, and its last minute where it sits', () => {
    const recovery = faultRecovery(soak((sec) => (sec < 130 ? 6000 : 12_500)));
    expect(recovery?.underMaximumAfterSec).toBeNull();
    expect(recovery?.atOwnLevelAfterSec).toBeNull();
    expect(recovery?.levelAtEndMs).toBe(12_500);
    expect(recovery?.stallMs).toBeNull();
  });

  it('counts from the last read that was outside, so that one read that left again later moves the time, and says null when the last read is outside', () => {
    const left = faultRecovery(soak((sec) => (sec === 300 ? 10_500 : cameBack(sec))));
    expect(left?.underMaximumAfterSec).toBe(175);
    const last = faultRecovery(soak((sec) => (sec === 480 ? 10_500 : cameBack(sec))));
    expect(last?.underMaximumAfterSec).toBeNull();
    expect(last?.atOwnLevelAfterSec).toBeNull();
  });

  it('holds a read exactly at a line within it: the limits are inclusive', () => {
    const recovery = faultRecovery(soak((sec) => (sec < 130 ? 6000 : 10_000)));
    expect(recovery?.underMaximumAfterSec).toBe(0);
    expect(recovery?.atOwnLevelAfterSec).toBeNull();
    const atLevel = faultRecovery(soak((sec) => (sec < 130 ? 6000 : 8000)));
    expect(atLevel?.atOwnLevelAfterSec).toBe(0);
  });

  it('says nothing for a thinned series, a soak without a fault, or a fault with no read before it', () => {
    expect(faultRecovery(soak(cameBack, { thinned: true }))).toBeNull();
    expect(faultRecovery({ ...soak(cameBack), faults: [] })).toBeNull();
    const noBefore = faultRecovery(soak((sec) => (sec < 130 ? null : 12_500)));
    expect(noBefore?.levelBeforeMs).toBeNull();
    expect(noBefore?.atOwnLevelAfterSec).toBeNull();
    expect(noBefore?.underMaximumAfterSec).toBeNull();
  });

  it('reads the stall of a stale manifest with the medians of the 25 s before it, and the longest stall of the window it explains', () => {
    const report = soak((sec) => 6000 + sec, {
      buffer: (sec) => ({ 95: 4, 100: 5, 105: 3, 110: 6, 115: 5 })[sec] ?? 9,
      episodes: [
        { startMs: t0 + 50_000, durationMs: 9000 },
        { startMs: fault.startMs + 6000, durationMs: 6500 },
        { startMs: fault.endMs + 15_000, durationMs: 4000 },
      ],
    });
    const stall = staleStall(report, fault);
    expect(stall.stallMs).toBe(6500);
    expect(stall.levelBeforeMs).toBe(6000 + 105);
    expect(stall.bufferedAheadSec).toBe(5);
    expect(staleStall({ ...report, episodes: [] } as SoakReport, fault).stallMs).toBeNull();
  });
});

describe('the macOS runs and the load', () => {
  it('marks the three jobs of the booting macOS runner as busy at the start and none of the Linux ones', () => {
    const busy = entries.filter(({ report }) => report.load !== undefined && isBusy(report.load.before));
    expect(busy.map(({ report }) => report.envId)).toEqual([
      'gha-macos-arm64',
      'gha-macos-arm64',
      'gha-macos-arm64',
    ]);
    const blocks = renderEvidenceBlocks(entries, runs.repository);
    expect(blocks.EVIDENCE_MANIFEST.match(/busy at the start/g)).toHaveLength(3);
  });
});

describe('the tables', () => {
  it('never put a result of one environment under another: a file is listed once, in the table of its own environment', () => {
    const blocks = renderEvidenceBlocks(entries, runs.repository);
    // A section is the bold name of an environment and the table under it; the manifest has three tables, each split by environment.
    const sections = (text: string): Array<{ environment: string; rows: string[] }> =>
      [...text.matchAll(/\*\*(gha-[a-z0-9-]+)\*\* \([^)]*\):\n\n((?:\|.*(?:\n|$))+)/g)].map((match) => ({
        environment: match[1] ?? '',
        rows: (match[2] ?? '').trim().split('\n').slice(2),
      }));
    const bothEnvironments = new Set([
      'EVIDENCE_MANIFEST',
      'READINESS_VERDICTS',
      'READINESS_RESTORE',
      'READINESS_SOAKS',
      'READINESS_MARGINS',
    ]);
    for (const [name, text] of Object.entries(blocks)) {
      const found = sections(text);
      expect(found.length, name).toBeGreaterThanOrEqual(bothEnvironments.has(name) ? 2 : 1);
      for (const section of found)
        for (const file of section.rows.flatMap((row) => row.match(/`(gha-[a-z0-9-]+\.json)`/g) ?? []))
          expect(file, `${name}, ${section.environment}`).toContain(`\`${section.environment}-`);
    }
    const rowsOf = (block: string, environment: string): number =>
      sections(blocks[block as keyof typeof blocks]).find((section) => section.environment === environment)
        ?.rows.length ?? 0;
    // the first evidence and the extra runs are tables of their own: a sentence about the first stays about it
    expect([
      rowsOf('READINESS_VERDICTS', 'gha-linux-x64'),
      rowsOf('READINESS_VERDICTS', 'gha-macos-arm64'),
    ]).toEqual([6, 2]);
    expect([
      rowsOf('READINESS_SOAKS', 'gha-linux-x64'),
      rowsOf('READINESS_SOAKS', 'gha-macos-arm64'),
    ]).toEqual([12, 2]);
    expect(rowsOf('EXTRA_VERDICTS', 'gha-linux-x64')).toBe(4);
    expect(rowsOf('EXTRA_RESTORE', 'gha-linux-x64')).toBe(4);
    expect(rowsOf('EXTRA_SOAKS', 'gha-linux-x64')).toBe(4);
    expect(rowsOf('EXTRA_STALE_RECOVERY', 'gha-linux-x64')).toBe(4);
    expect(rowsOf('EXTRA_STALE_STALLS', 'gha-linux-x64')).toBe(10);
    expect(blocks.EXTRA_VERDICTS).not.toContain('gha-macos-arm64');
    for (const { run } of entries) {
      const file = run.file.split('/').pop() ?? '';
      const rows = blocks.EVIDENCE_MANIFEST.split('\n').filter((line) =>
        line.startsWith(`| \`${file}\` | [`),
      );
      expect(rows, file).toHaveLength(1);
    }
  });

  it('says both verdicts of a soak whose verdict changed with the criteria, and one when it did not, and what each soak injected', () => {
    const manifest = renderEvidenceBlocks(entries, runs.repository).EVIDENCE_MANIFEST;
    expect(manifest).toMatch(/gha-linux-x64-chromium-5m\.json`.*GO as measured, NO-GO by today's criteria/);
    expect(manifest).toMatch(/gha-linux-x64-chromium-5m-live-sync\.json`.*\| GO \|/);
    expect(manifest).toMatch(
      /gha-linux-x64-webkit-30m-live-sync\.json`.*GO as measured, NO-GO by today's criteria/,
    );
    expect(manifest).toMatch(
      /gha-linux-x64-webkit-8m-nostall-stale2m\.json`.*8 min \(ci\); stale manifest at minute 2\.0 \| GO as measured, NO-GO by today's criteria/,
    );
    expect(manifest).toMatch(
      /gha-linux-x64-webkit-8m-nostall-stale2m-live-sync\.json`.*stale manifest at minute 2\.0 \| GO \|/,
    );
    expect(manifest).toMatch(
      /gha-linux-x64-webkit-30m\.json`.*outage at minute 9\.9 and stale manifest at minute 20\.0/,
    );
    expect(manifest).toMatch(/gha-linux-x64-chromium-5m\.json`.*5 min \(ci\); outage at minute 2\.5/);
  });

  it('reads a margin as the room under an at-most limit and over an at-least limit, and says "over by" when there is none', () => {
    expect(marginOf({ value: 4000, limit: 5000, bound: 'at-most' })).toBe(1000);
    expect(marginOf({ value: 6000, limit: 5000, bound: 'at-most' })).toBe(-1000);
    expect(marginOf({ value: 2000, limit: 1000, bound: 'at-least' })).toBe(1000);
    expect(marginOf({ value: 900, limit: 1000, bound: 'at-least' })).toBe(-100);
    expect(marginOf({ value: null, limit: 1000, bound: 'at-least' })).toBeNull();
    const margins = renderMargins(entries);
    expect(margins).toContain('at least 65.97 s (over by at least 5.97 s)');
    expect(margins).toContain('2.00 s (margin 1.00 s)');
    expect(margins).toContain('10.15 to 10.20 s (over by 0.15 to 0.20 s)');
  });

  it('prints no negative zero and no "1,000 ms"', () => {
    const text = Object.values(renderEvidenceBlocks(entries, runs.repository)).join('\n');
    expect(text).not.toMatch(/-0(\.0)? ms/);
    expect(text).not.toContain('1,000 ms');
  });
});

describe('the join is refused when it does not hold', () => {
  const tampered = (overrides: Partial<EvidenceSource>): EvidenceSource => ({ ...source, ...overrides });

  it('refuses a result file that is not what the job uploaded, and says that a file is never edited', () => {
    const file = 'docs/results/soak/gha-linux-x64-chromium-5m.json';
    expect(() =>
      buildEvidence(
        tampered({
          result: (path) => (path === file ? Buffer.concat([read(path), Buffer.from(' ')]) : read(path)),
        }),
      ),
    ).toThrow(/is not what the job uploaded.*never edited/);
  });

  it('refuses a name that is not the one its content gets, and two entries for one file', () => {
    const wrong = source.runs.replace(
      '"file": "docs/results/soak/gha-linux-x64-chromium-5m-live-sync.json"',
      '"file": "docs/results/soak/gha-linux-x64-chromium-5m.json"',
    );
    expect(() => parseRunsFile(wrong)).toThrow(/used twice/);
    const renamedAway = source.runs.replace(
      '"file": "docs/results/soak/gha-linux-x64-chromium-5m-live-sync.json"',
      '"file": "docs/results/soak/gha-linux-x64-chromium-5m-other.json"',
    );
    expect(() =>
      buildEvidence(
        tampered({
          runs: renamedAway,
          result: (path) => read(path.replace('-other.json', '-live-sync.json')),
        }),
      ),
    ).toThrow(/the name is not the one its content gets \(gha-linux-x64-chromium-5m-live-sync\.json\)/);
  });

  it('refuses a machine record of another environment or of another commit', () => {
    const label = 'rdy-chromium';
    const record = source.machine(label);
    expect(() =>
      buildEvidence(
        tampered({
          machine: (name) =>
            name === label ? record.replace('gha-linux-x64', 'gha-macos-arm64') : source.machine(name),
        }),
      ),
    ).toThrow(/the machine record of rdy-chromium says gha-macos-arm64/);
    expect(() =>
      buildEvidence(
        tampered({
          machine: (name) =>
            name === label ? record.replace('0d62c1d0d4', 'ffffffffff') : source.machine(name),
        }),
      ),
    ).toThrow(/the job checked out ffffffffff/);
  });

  it("refuses a machine record that is another job's or has no uptime at the end", () => {
    const record = source.machine('rdy-chromium');
    expect(() => parseMachineRecord(record, 'rdy-firefox')).toThrow(
      /the record says it is for "rdy-chromium"/,
    );
    const lines = record.split('\n').filter((line) => !line.startsWith('uptime:') || line.includes('17:17'));
    expect(() => parseMachineRecord(lines.join('\n'), 'rdy-chromium')).toThrow(
      /expected the uptime at the start and at the end/,
    );
  });

  it('reads both uptime formats, Linux and macOS, with the runner up time and the three loads', () => {
    const linux = parseMachineRecord(source.machine('rdy-chromium'), 'rdy-chromium');
    expect(linux.uptimeAtStart).toMatchObject({ up: '1 min', load1: 1.89, load5: 0.84, load15: 0.31 });
    expect(linux.uptimeAtEnd).toMatchObject({ up: '11 min', load1: 0.96 });
    expect(linux).toMatchObject({
      cpus: 4,
      cpu: 'AMD EPYC 9V45 96-Core Processor',
      image: 'ubuntu24 20261026.354.1',
      environmentId: 'gha-linux-x64',
    });
    const macos = parseMachineRecord(source.machine('soakci-webkit-macos-a'), 'soakci-webkit-macos-a');
    expect(macos.uptimeAtStart).toMatchObject({ up: '1 min', load1: 88.23, load5: 37.02, load15: 14.68 });
    expect(macos).toMatchObject({ cpus: 3, cpu: 'Apple M1 (Virtual)', environmentId: 'gha-macos-arm64' });
  });

  it('refuses a provenance file with a duplicate label, a bad digest or a file outside its directory', () => {
    const base = JSON.parse(source.runs) as { runs: Array<Record<string, unknown>> };
    const withRun = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...base, runs: [{ ...base.runs[0], ...patch }, ...base.runs.slice(1)] });
    expect(() => parseRunsFile(withRun({ label: base.runs[1]?.['label'] }))).toThrow(
      /the label .* is used twice/,
    );
    expect(() => parseRunsFile(withRun({ sha256: 'abc' }))).toThrow(/sha256 must be 64/);
    expect(() => parseRunsFile(withRun({ file: 'docs/results/soak/x.json' }))).toThrow(
      /file must be docs\/results\/readiness/,
    );
    expect(() => parseRunsFile('{}')).toThrow(EvidenceError);
  });

  it('puts an entry without a batch in the first one and without arguments, and refuses a batch that is not lower-case words or arguments that are empty', () => {
    const base = JSON.parse(source.runs) as { runs: Array<Record<string, unknown>> };
    const withRun = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...base, runs: [{ ...base.runs[0], ...patch }, ...base.runs.slice(1)] });
    expect(parseRunsFile(source.runs).runs[0]).toMatchObject({ batch: 'first', args: null });
    expect(parseRunsFile(withRun({ batch: 'third-run', args: '--minutes 8' })).runs[0]).toMatchObject({
      batch: 'third-run',
      args: '--minutes 8',
    });
    expect(() => parseRunsFile(withRun({ batch: 'Extra' }))).toThrow(/batch must be lower-case words/);
    expect(() => parseRunsFile(withRun({ args: '' }))).toThrow(/"args" must be a non-empty string/);
  });
});

describe('the fields the generators may rely on (docs/READINESS.md, "Reading the result files")', () => {
  const doc = readFileSync(resolve(ROOT, 'docs/READINESS.md'), 'utf8');

  it('are in every committed file, with the types the document says', () => {
    for (const { report } of entries) {
      expect(report.schemaVersion).toBe(1);
      expect(['readiness', 'soak']).toContain(report.kind);
      expect(typeof report.envId).toBe('string');
      expect(['chromium', 'firefox', 'webkit']).toContain(report.engine);
      expect(typeof report.browser.version).toBe('string');
      expect(['dash', 'hls']).toContain(report.stream.protocol);
      expect(typeof report.commit.hash).toBe('string');
      expect(typeof report.commit.dirty).toBe('boolean');
      expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
      expect(report.durationMs).toBeGreaterThan(0);
      expect(report.host.cpus).toBeGreaterThan(0);
      expect(report.load?.before.load1).toEqual(expect.any(Number));
      expect(report.load?.after.cpus).toEqual(expect.any(Number));
      expect(report.limits['latencyMaxMs']).toBe(10_000);
    }
  });

  it('name every line id the files contain, and every id in the document is in a file', () => {
    const ids = new Set<string>();
    for (const { report } of entries) {
      const lines =
        report.kind === 'readiness'
          ? report.configurations.flatMap((configuration) =>
              configuration.checks.flatMap((check) => check.evaluations),
            )
          : report.evaluations;
      for (const line of lines) {
        ids.add(line.id);
        expect(['criterion', 'advisory']).toContain(line.scope);
        expect(['GO', 'NO-GO', 'INCONCLUSIVE', 'N/A']).toContain(line.verdict);
        expect(['at-most', 'at-least']).toContain(line.bound);
        expect(['ms', 'ratio', 'count', 'MB', 'min']).toContain(line.unit);
      }
    }
    for (const id of ids) expect(doc, id).toContain(`\`${id}\``);
    const quoted = [...doc.matchAll(/`((?:soak|start|latency|stall|cadence)\.[a-z0-9-]+)`/g)].map(
      (match) => match[1] ?? '',
    );
    for (const id of quoted) expect(ids.has(id), id).toBe(true);
  });

  it("say that a soak's verdict is the one of its time, and how to get the one of today", () => {
    expect(doc).toContain('soakVerdictToday');
    expect(doc).toContain('`series.samples` is thinned');
    expect(doc).toContain('**The CPU model is not in the file**');
    expect(named('gha-linux-x64-chromium-30m.json').report.kind).toBe('soak');
  });
});

describe('rendering from the disk', () => {
  it('renders the same eleven blocks as the entries it read: five for the first evidence and the manifest, six for the extra runs', () => {
    const { blocks, repository } = renderFromDisk();
    expect(repository).toBe('hanniavalera/playback-proof');
    expect(Object.keys(blocks).sort()).toEqual(
      [
        'EVIDENCE_MANIFEST',
        'EXTRA_MARGINS',
        'EXTRA_RESTORE',
        'EXTRA_SOAKS',
        'EXTRA_STALE_RECOVERY',
        'EXTRA_STALE_STALLS',
        'EXTRA_VERDICTS',
        'READINESS_MARGINS',
        'READINESS_RESTORE',
        'READINESS_SOAKS',
        'READINESS_VERDICTS',
      ].sort(),
    );
  });
});
