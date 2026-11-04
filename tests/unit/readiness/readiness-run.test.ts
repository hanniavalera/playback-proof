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
import { ResultFileError, soakFileName } from '../../../src/lab/readiness/report.ts';
import type { SoakReport } from '../../../src/lab/readiness/report.ts';
import { worstOf } from '../../../src/lab/readiness/verdict.ts';
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
    const soak = {
      schemaVersion: 1,
      kind: 'soak',
      envId: 'local-darwin-arm64',
      engine: 'chromium',
      generatedAt: '2030-01-01T00:00:00.000Z',
      commit: { hash: 'abc1234', dirty: false },
      limits: {},
      verdict: 'GO',
      length: 'ci',
      options: { minutes: 5 },
      evaluations: [],
      series: { samples: [] },
    } as unknown as SoakReport;
    writeResult(soakDir(root), soakFileName('local-darwin-arm64', 'chromium', 5), soak);
    const loaded = loadResults(root);
    expect(loaded.soaks.map((s) => s.options.minutes)).toEqual([5]);
  });

  it('refuses a file that is not a valid result, naming it, instead of reading it as no result', async () => {
    const root = scratch();
    mkdirSync(readinessDir(root), { recursive: true });
    writeFileSync(join(readinessDir(root), 'broken.json'), '{"schemaVersion": 1, "kind": "readiness"}');
    expect(() => loadResults(root)).toThrow(ResultFileError);
    expect(() => loadResults(root)).toThrow(/broken\.json is not a readiness result/);
  });

  it('finds nothing in a directory that has no results, which is not an error', () => {
    expect(loadResults(scratch())).toEqual({ readiness: [], soaks: [] });
  });
});
