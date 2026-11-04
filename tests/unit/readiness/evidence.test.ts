import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceError,
  buildEvidence,
  marginOf,
  parseMachineRecord,
  parseRunsFile,
  renderEvidenceBlocks,
  renderMargins,
  runUrl,
} from '../../../src/lab/readiness/evidence.ts';
import type { EvidenceEntry, EvidenceSource } from '../../../src/lab/readiness/evidence.ts';
import { isBusy, soakVerdictToday } from '../../../src/lab/readiness/report.ts';
import type { ReadinessReport, SoakReport } from '../../../src/lab/readiness/report.ts';
import { renderFromDisk, resultsDocsProblems } from '../../../tools/results-docs.ts';

// The evidence of the first readiness runs on GitHub's runners (docs/results, docs/results/provenance) and the tables generated from it
// (docs/results/readiness/README.md, docs/READINESS.md). The files are real and are read from the disk: what is asserted about them is
// what the write-up says, so that a file replaced without its write-up, or a write-up that says more than its files, fails here.

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const read = (path: string): Buffer => readFileSync(resolve(ROOT, path));
const source: EvidenceSource = {
  runs: read('docs/results/provenance/runs.json').toString('utf8'),
  result: (file) => read(file),
  machine: (label) => read(`docs/results/provenance/machines/${label}.txt`).toString('utf8'),
};
const { runs, entries } = buildEvidence(source);

const readinessReports = (): ReadinessReport[] =>
  entries.flatMap(({ report }) => (report.kind === 'readiness' ? [report] : []));
const soakReports = (): Array<{ entry: EvidenceEntry; report: SoakReport }> =>
  entries.flatMap((entry) => (entry.report.kind === 'soak' ? [{ entry, report: entry.report }] : []));
const named = (file: string): EvidenceEntry => {
  const found = entries.find((entry) => entry.run.file.endsWith(`/${file}`));
  if (found === undefined) throw new Error(`no entry for ${file}`);
  return found;
};
const evaluationOf = (report: ReadinessReport, configuration: string, id: string) =>
  report.configurations
    .find((candidate) => candidate.id === configuration)
    ?.checks.flatMap((check) => check.evaluations)
    .find((evaluation) => evaluation.id === id);

describe('the committed evidence and its provenance', () => {
  it('holds 18 runs of one commit in two environments, each file exactly what its job uploaded and named for what it holds', () => {
    expect(entries).toHaveLength(18);
    expect(runs.runs.filter((run) => run.task === 'readiness')).toHaveLength(4);
    expect(new Set(entries.map(({ report }) => report.envId))).toEqual(
      new Set(['gha-linux-x64', 'gha-macos-arm64']),
    );
    for (const { report, machine } of entries) {
      expect(report.commit).toEqual({ hash: '0d62c1d', dirty: false });
      expect(machine.commit.startsWith('0d62c1d')).toBe(true);
    }
    expect(runUrl(runs.repository, 41876070337)).toBe(
      'https://github.com/hanniavalera/playback-proof/actions/runs/41876070337',
    );
  });

  it('keeps its generated tables up to date, so that no number in them is typed', () => {
    expect(resultsDocsProblems()).toEqual([]);
  });

  it('puts the seven soaks of the candidate under names of their own and keeps the names of A', () => {
    const renamed = runs.runs.filter((run) => !run.file.endsWith(run.uploadedAs.replace(/^[a-z]+\//, '')));
    expect(renamed).toHaveLength(7);
    for (const run of renamed) expect(run.file).toMatch(/-live-sync\.json$/);
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
    for (const [name, text] of Object.entries(blocks)) {
      const found = sections(text);
      expect(found.length, name).toBeGreaterThanOrEqual(2);
      for (const section of found)
        for (const file of section.rows.flatMap((row) => row.match(/`(gha-[a-z0-9-]+\.json)`/g) ?? []))
          expect(file, `${name}, ${section.environment}`).toContain(`\`${section.environment}-`);
    }
    const rowsOf = (block: string, environment: string): number =>
      sections(blocks[block as keyof typeof blocks]).find((section) => section.environment === environment)
        ?.rows.length ?? 0;
    expect([
      rowsOf('READINESS_VERDICTS', 'gha-linux-x64'),
      rowsOf('READINESS_VERDICTS', 'gha-macos-arm64'),
    ]).toEqual([6, 2]);
    expect([
      rowsOf('READINESS_SOAKS', 'gha-linux-x64'),
      rowsOf('READINESS_SOAKS', 'gha-macos-arm64'),
    ]).toEqual([12, 2]);
    for (const { run } of entries) {
      const file = run.file.split('/').pop() ?? '';
      const rows = blocks.EVIDENCE_MANIFEST.split('\n').filter((line) =>
        line.startsWith(`| \`${file}\` | [`),
      );
      expect(rows, file).toHaveLength(1);
    }
  });

  it('says both verdicts of a soak whose verdict changed with the criteria, and one when it did not', () => {
    const manifest = renderEvidenceBlocks(entries, runs.repository).EVIDENCE_MANIFEST;
    expect(manifest).toMatch(/gha-linux-x64-chromium-5m\.json`.*GO as measured, NO-GO by today's criteria/);
    expect(manifest).toMatch(/gha-linux-x64-chromium-5m-live-sync\.json`.*\| GO \|/);
    expect(manifest).toMatch(
      /gha-linux-x64-webkit-30m-live-sync\.json`.*GO as measured, NO-GO by today's criteria/,
    );
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
  it('renders the same five blocks as the entries it read', () => {
    const { blocks, repository } = renderFromDisk();
    expect(repository).toBe('hanniavalera/playback-proof');
    expect(Object.keys(blocks).sort()).toEqual(
      [
        'EVIDENCE_MANIFEST',
        'READINESS_MARGINS',
        'READINESS_RESTORE',
        'READINESS_SOAKS',
        'READINESS_VERDICTS',
      ].sort(),
    );
  });
});
