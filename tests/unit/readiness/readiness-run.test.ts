import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateById } from '../../../src/lab/readiness/candidates.ts';
import { renderRun } from '../../../src/lab/readiness/checklist.ts';
import type { HostInfo } from '../../../src/lab/probe/host-info.ts';
import {
  buildReadinessReport,
  evaluateConfigurations,
  loadResults,
  readinessDir,
  soakDir,
  writeReadinessReport,
  writeResult,
} from '../../../src/lab/readiness/readiness-run.ts';
import { ResultFileError, soakFileName, soakFileNameOf } from '../../../src/lab/readiness/report.ts';
import type { ReadinessReport, SoakReport } from '../../../src/lab/readiness/report.ts';
import type { Engine } from '../../../src/lab/readiness/soak-evaluators.ts';
import { worstOf } from '../../../src/lab/readiness/verdict.ts';
import type { Verdict } from '../../../src/lab/readiness/verdict.ts';
import { makeScratch } from '../support/scratch.ts';
import { fakeWorld } from './fake-world.ts';

// The orchestration of a readiness run over a world, and the committed result files read back for the checklist.

const host = {
  os: { platform: 'darwin', arch: 'arm64', release: '1', name: 'macOS 27.2' },
  cpus: 12,
  memoryGiB: 16,
  node: 'v22',
  playwright: '1.64.1',
  git: { commit: 'abc1234', dirty: false },
} as HostInfo;
const quick = {
  checks: ['PB-RDY-001', 'PB-RDY-003'] as const,
  joins: 5,
  stallRuns: 1,
  windowSec: 30,
  refreshes: 12,
};

const LIVE_SYNC = {
  id: 'live-sync',
  label: 'A plus streaming.liveSync.enabled',
  patch: { streaming: { liveSync: { enabled: true } } },
};

/** Just enough of a soak file for the reader and for the names: what the file says it is, and nothing the checklist does not read. */
function minimalSoak(
  over: {
    configuration?: { id: string; label: string; patch: unknown };
    engine?: Engine;
    minutes?: number;
    protocol?: 'dash' | 'hls';
    generatedAt?: string;
    verdict?: Verdict;
  } = {},
): SoakReport {
  const minutes = over.minutes ?? 5;
  return {
    schemaVersion: 1,
    kind: 'soak',
    envId: 'local-darwin-arm64',
    engine: over.engine ?? 'chromium',
    generatedAt: over.generatedAt ?? '2030-01-01T00:00:00.000Z',
    commit: { hash: 'abc1234', dirty: false },
    stream: { id: 'live-cmaf', protocol: over.protocol ?? 'dash', contentHash: null },
    configuration: over.configuration ?? { id: 'A', label: 'the library defaults', patch: null },
    limits: {},
    verdict: over.verdict ?? 'GO',
    length: minutes >= 30 ? 'release' : 'ci',
    options: { minutes },
    evaluations: [],
    series: { samples: [] },
  } as unknown as SoakReport;
}

function minimalReadiness(): ReadinessReport {
  return {
    schemaVersion: 1,
    kind: 'readiness',
    envId: 'local-darwin-arm64',
    engine: 'chromium',
    generatedAt: '2030-01-01T00:00:00.000Z',
    commit: { hash: 'abc1234', dirty: false },
    stream: { id: 'live-cmaf', protocol: 'dash', contentHash: null },
    limits: {},
    configurations: [{ id: 'A', verdict: 'GO', checks: [] }],
  } as unknown as ReadinessReport;
}

describe('evaluateConfigurations', () => {
  it('evaluates A first, then every candidate in the order given, and gives each its own patch', async () => {
    const { world, observed } = fakeWorld();
    const lines: string[] = [];
    const results = await evaluateConfigurations(world, [candidateById('live-sync')!], {
      ...quick,
      log: (line) => lines.push(line),
    });
    expect(results.map((result) => result.id)).toEqual(['A', 'live-sync']);
    expect(results[0]?.patch).toBeNull();
    expect(results[1]?.patch).toEqual({ streaming: { liveSync: { enabled: true } } });
    // A ran without a configure call, the candidate's runs with exactly one (each configuration's start check makes a warm-up join first).
    const configured = observed.runs.map((run) => run.configured.length);
    expect(configured.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(configured.slice(7)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(results[0]?.verdict).toBe('NO-GO');
    expect(results[1]?.verdict).toBe('GO');
    expect(results[1]?.hypothesis).toContain('Rejected if');
    expect(lines.filter((line) => line.startsWith('configuration '))).toEqual([
      'configuration A: the library defaults (what ships)',
      'configuration live-sync: A plus streaming.liveSync.enabled',
    ]);
  });

  it('evaluates only A when there is no candidate', async () => {
    const { world } = fakeWorld();
    const results = await evaluateConfigurations(world, [], quick);
    expect(results.map((result) => result.id)).toEqual(['A']);
  });
});

describe('worstOf', () => {
  it('lets NO-GO win, then INCONCLUSIVE, and calls nothing at all inconclusive', () => {
    expect(worstOf(['GO', 'NO-GO', 'INCONCLUSIVE'])).toBe('NO-GO');
    expect(worstOf(['GO', 'INCONCLUSIVE'])).toBe('INCONCLUSIVE');
    expect(worstOf(['GO', 'GO'])).toBe('GO');
    expect(worstOf([])).toBe('INCONCLUSIVE');
    expect(worstOf(['N/A'])).toBe('INCONCLUSIVE');
  });
});

describe('the committed results', () => {
  const scratches: string[] = [];
  afterEach(() => {
    for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const dir = makeScratch('readiness-results-');
    scratches.push(dir);
    return dir;
  };

  async function report() {
    const { world } = fakeWorld();
    const configurations = await evaluateConfigurations(world, [candidateById('live-sync')!], quick);
    return buildReadinessReport(
      {
        envId: 'local-darwin-arm64',
        engine: 'chromium',
        generatedAt: '2030-01-01T00:00:00.000Z',
        durationMs: 60_000,
        commit: { hash: 'abc1234', dirty: false },
        host,
        browser: { name: 'chromium', version: '156.0', userAgent: null },
        stream: { id: 'live-cmaf', protocol: 'dash', contentHash: 'deadbeef' },
        options: {
          checks: ['PB-RDY-001', 'PB-RDY-003'],
          joins: 5,
          stallRuns: 1,
          windowSec: 30,
          refreshes: 12,
        },
      },
      configurations,
    );
  }

  it('writes a readiness result under its environment and engine, and reads it back to the same sheet', async () => {
    const root = scratch();
    const original = await report();
    const path = writeReadinessReport(root, original);
    expect(path).toBe(join(readinessDir(root), 'local-darwin-arm64-chromium.json'));
    const loaded = loadResults(root);
    expect(loaded.readiness).toHaveLength(1);
    expect(loaded.soaks).toEqual([]);
    expect(renderRun(loaded.readiness)).toBe(renderRun([original]));
  });

  it('reads the soaks next to the readiness results, in name order', async () => {
    const root = scratch();
    writeReadinessReport(root, await report());
    writeResult(soakDir(root), soakFileName('local-darwin-arm64', 'chromium', 5), minimalSoak());
    const loaded = loadResults(root);
    expect(loaded.soaks.map((s) => s.options.minutes)).toEqual([5]);
    expect(loaded.notes).toEqual([]);
  });

  it('reads the soak of A and the soak of a candidate as two soaks, each by its own name, without a word about names', () => {
    const root = scratch();
    const a = minimalSoak();
    const candidate = minimalSoak({ configuration: LIVE_SYNC });
    writeResult(soakDir(root), soakFileNameOf(a), a);
    writeResult(soakDir(root), soakFileNameOf(candidate), candidate);
    const loaded = loadResults(root);
    expect(loaded.soaks.map((s) => s.configuration.id).sort()).toEqual(['A', 'live-sync']);
    expect(loaded.notes).toEqual([]);
  });

  it('reads a candidate soak that was written under the name of A, as the candidate it holds, and says what the name should be', () => {
    const root = scratch();
    // How the first soaks of a candidate were named: the length, and nothing of the candidate.
    const old = minimalSoak({ configuration: LIVE_SYNC });
    writeResult(soakDir(root), soakFileName('local-darwin-arm64', 'chromium', 5), old);
    const loaded = loadResults(root);
    expect(loaded.soaks).toHaveLength(1);
    expect(loaded.soaks[0]?.configuration.id).toBe('live-sync');
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.notes[0]).toContain('soak/local-darwin-arm64-chromium-5m.json');
    expect(loaded.notes[0]).toContain('under the name of the build as it ships');
    expect(loaded.notes[0]).toContain('local-darwin-arm64-chromium-5m-live-sync.json');
  });

  it('reads a file whose name has nothing to do with its content, as what it holds, and says so', () => {
    const root = scratch();
    writeResult(soakDir(root), 'somebody-renamed-this.json', minimalSoak());
    writeResult(readinessDir(root), 'my-run.json', minimalReadiness());
    const loaded = loadResults(root);
    expect(loaded.soaks).toHaveLength(1);
    expect(loaded.readiness).toHaveLength(1);
    expect(loaded.notes).toHaveLength(2);
    expect(loaded.notes.join('\n')).toContain(
      'soak/somebody-renamed-this.json: holds the 5-minute soak of A',
    );
    expect(loaded.notes.join('\n')).toContain(
      'readiness/my-run.json: holds a readiness run of local-darwin-arm64 chromium',
    );
    expect(loaded.notes.join('\n')).toContain('read from its content');
  });

  it('does not merge two files that hold the same run: the newer is used, and the note names both', () => {
    const root = scratch();
    const older = minimalSoak({ generatedAt: '2030-01-01T00:00:00.000Z', verdict: 'NO-GO' });
    const newer = minimalSoak({ generatedAt: '2030-01-02T00:00:00.000Z', verdict: 'GO' });
    writeResult(soakDir(root), soakFileNameOf(older), older);
    writeResult(soakDir(root), 'a-copy-of-the-same-soak.json', newer);
    const loaded = loadResults(root);
    expect(loaded.soaks).toHaveLength(1);
    expect(loaded.soaks[0]?.verdict).toBe('GO');
    expect(loaded.notes.join('\n')).toContain('hold the same run');
    expect(loaded.notes.join('\n')).toContain(
      'a-copy-of-the-same-soak.json (measured 2030-01-02T00:00:00.000Z), is used',
    );
  });

  it('keeps the soaks of two protocols, of two lengths and of two engines apart', () => {
    const root = scratch();
    for (const soak of [
      minimalSoak(),
      minimalSoak({ protocol: 'hls' }),
      minimalSoak({ minutes: 30 }),
      minimalSoak({ engine: 'webkit' }),
    ])
      writeResult(soakDir(root), soakFileNameOf(soak), soak);
    const loaded = loadResults(root);
    expect(loaded.soaks).toHaveLength(4);
    expect(loaded.notes).toEqual([]);
  });

  it('refuses a file that is not a valid result, naming it, instead of reading it as no result', async () => {
    const root = scratch();
    mkdirSync(readinessDir(root), { recursive: true });
    writeFileSync(join(readinessDir(root), 'broken.json'), '{"schemaVersion": 1, "kind": "readiness"}');
    expect(() => loadResults(root)).toThrow(ResultFileError);
    expect(() => loadResults(root)).toThrow(/broken\.json is not a readiness result/);
  });

  it('refuses a soak that does not say what was soaked, because the checklist cannot tell A from a candidate without it', () => {
    const root = scratch();
    const { configuration: _gone, ...without } = minimalSoak();
    writeResult(soakDir(root), 'x.json', without as unknown as SoakReport);
    expect(() => loadResults(root)).toThrow(/no configuration\.id/);
  });

  it('finds nothing in a directory that has no results, which is not an error', () => {
    expect(loadResults(scratch())).toEqual({ readiness: [], soaks: [], notes: [] });
  });
});
