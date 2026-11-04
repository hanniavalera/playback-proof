import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cluster, rootCauses } from '../../../triage/cluster.ts';
import { collect } from '../../../triage/collect.ts';
import type { Cluster } from '../../../triage/types.ts';

// The failures of the lab, induced on purpose in a scratch copy and run through the real specs of the merge tier (docs/results/triage/README.md
// says how), reduced by tools/triage-fixture.ts and committed. This is the regression test of the clustering on real data: what is pinned here is
// what the clusters were when the experiments were read, and a change of the signature or of a rule that moves one of them is a decision to make
// in the open (and to write in the ADR), not a side effect.

const FIXTURES = fileURLToPath(new URL('../../fixtures/triage/', import.meta.url));

interface Expected {
  size: number;
  projects: string[];
  tests: string[];
  category: string;
  rule: string;
  failureClass: string;
  cause: string | null;
  signature: string;
}

const REC_PREMISE = (times: string, tail: string): string =>
  `Error: the fault rule <rule> {…} named <n> of the <n> request${times} it was waited for within <n> ms: ${tail}`;

const EXPERIMENTS: Record<
  string,
  { failures: number; skipped: number; rootCauses: number; clusters: Expected[] }
> = {
  'service-down': {
    failures: 1,
    skipped: 0,
    rootCauses: 1,
    clusters: [
      {
        size: 1,
        projects: ['(run)'],
        tests: ['(run)'],
        category: 'environment',
        rule: 'service-not-reachable',
        failureClass: 'Environment or infrastructure',
        cause: 'the test data service cannot be reached',
        signature:
          'Error: the test data service at <url> is not answering (GET /health -> no answer ECONNREFUSED): start it with `npm run build:player && npm run serve` [thrown]',
      },
    ],
  },
  'truncated-cache': {
    failures: 1,
    skipped: 0,
    rootCauses: 1,
    clusters: [
      {
        size: 1,
        projects: ['(run)'],
        tests: ['(run)'],
        category: 'environment',
        rule: 'run-failed-before-any-test',
        failureClass: 'Environment or infrastructure',
        cause: 'the run failed before any test: a global setup threw or the web server did not start',
        signature: 'Error: Process from config.webServer was not able to start. Exit code: <n> [thrown]',
      },
    ],
  },
  'csp-blocks-scripts': {
    failures: 7,
    skipped: 3,
    rootCauses: 1,
    clusters: [
      {
        size: 5,
        projects: ['chromium', 'chromium-cpu4x', 'webkit'],
        tests: ['PB-VOD-001', 'PB-VOD-002'],
        category: 'page-boot-failure',
        rule: 'page-did-not-boot',
        failureClass: 'Functional regression',
        cause: 'the player page did not boot: a Content Security Policy blocked its scripts',
        signature: 'Error: the player page did not boot (<url>): Timeout <n>ms exceeded. [thrown]',
      },
      {
        // The environment check wraps what the player said: here, a page that did not boot. Two engines, one cluster.
        size: 2,
        projects: ['chromium', 'webkit'],
        tests: ['PB-ENV-001'],
        category: 'page-boot-failure',
        rule: 'page-did-not-boot',
        failureClass: 'Functional regression',
        cause: 'the player page did not boot: a Content Security Policy blocked its scripts',
        signature:
          'Error: <engine> <n> in <env> could not play vod-cmaf over dash through the player, and no documented gap covers it. [thrown]',
      },
    ],
  },
  'origin-503': {
    failures: 10,
    skipped: 0,
    rootCauses: 1,
    clusters: [
      {
        size: 6,
        projects: ['chromium', 'webkit'],
        tests: ['PB-VOD-001', 'PB-VOD-002', 'PB-VOD-006'],
        category: 'origin-error',
        rule: 'origin-failed-without-fault',
        failureClass: 'Environment or infrastructure',
        cause: 'the origin answered 503 on segment to requests no fault rule named',
        signature:
          "Error: qa.waitFor('firstframe') timed out after <n> ms (looking from index <n>). [thrown] {shaka 1001}",
      },
      {
        size: 2,
        projects: ['chromium', 'webkit'],
        tests: ['PB-REC-001'],
        category: 'origin-error',
        rule: 'origin-failed-without-fault',
        failureClass: 'Environment or infrastructure',
        cause: 'the origin answered 503 on segment to requests no fault rule named',
        signature: `${REC_PREMISE('', 'the player never asked for what the rule matches, so nothing after this line says how the player copes w…')} [thrown] {shaka 1001}`,
      },
      {
        size: 2,
        projects: ['chromium', 'webkit'],
        tests: ['PB-REC-002'],
        category: 'origin-error',
        rule: 'origin-failed-without-fault',
        failureClass: 'Environment or infrastructure',
        cause: 'the origin answered 503 on segment to requests no fault rule named',
        signature: `${REC_PREMISE('s', 'the player never asked for what the rule matches, so nothing after this line says how the player copes …')} [thrown] {shaka 1001}`,
      },
    ],
  },
  'corrupt-segments': {
    failures: 6,
    skipped: 0,
    rootCauses: 1,
    clusters: [
      {
        // WebKit said 3015 and Chromium 3016 for the same bytes: one cluster, by the category of the error.
        size: 6,
        projects: ['chromium', 'webkit'],
        tests: ['PB-VOD-001', 'PB-VOD-002', 'PB-VOD-006'],
        category: 'decode-or-mse-error',
        rule: 'media-error',
        failureClass: 'Functional regression',
        cause: 'the bytes arrived and the browser could not append or decode them',
        signature:
          "Error: qa.waitFor('firstframe') timed out after <n> ms (looking from index <n>). [thrown] {shaka media}",
      },
    ],
  },
  'retry-disabled': {
    failures: 4,
    skipped: 0,
    rootCauses: 1,
    clusters: [
      {
        size: 2,
        projects: ['chromium', 'webkit'],
        tests: ['PB-REC-001'],
        category: 'network-fault-not-recovered',
        rule: 'fault-fired-player-failed',
        failureClass: 'Functional regression',
        cause: 'a fault of type status fired and the player did not recover',
        signature:
          'Error: qa.waitForMediaTime(<n>) timed out after <n> ms: the media clock is at <n> s. [thrown] {shaka 1001}',
      },
      {
        size: 2,
        projects: ['chromium', 'webkit'],
        tests: ['PB-REC-002'],
        category: 'network-fault-not-recovered',
        rule: 'fault-fired-player-failed',
        failureClass: 'Functional regression',
        cause: 'a fault of type status fired and the player did not recover',
        signature: `${REC_PREMISE('s', 'the player stopped asking for what the rule matches before the rule was used up, so nothing after this …')} [thrown] {shaka 1001}`,
      },
    ],
  },
  'origin-slow': {
    failures: 2,
    skipped: 0,
    rootCauses: 2,
    clusters: [
      {
        size: 1,
        projects: ['chromium'],
        tests: ['PB-VOD-006'],
        category: 'instrument-disagreement',
        rule: 'test-premise-not-met',
        failureClass: 'Needs a person',
        cause: null,
        signature:
          'Error: premise of the test, not the behaviour under test: seconds buffered ahead of the playhead (<n> s) when the seek to <n> s is made (metrics.playback.bufferedAheadSec) [toBeGreaterThan]',
      },
      {
        size: 1,
        projects: ['chromium'],
        tests: ['PB-VOD-012'],
        category: 'metric-regression',
        rule: 'metric-assertion-failed',
        failureClass: 'Performance regression',
        cause: null,
        signature:
          'Error: rebuffers (metrics.rebuffer.count): expected none, saw <n> totalling <n> ms: at media time <n> s for <n> ms; … [toBe]',
      },
    ],
  },
};

const shape = (c: Cluster): Expected => ({
  size: c.size,
  projects: c.projects,
  tests: c.tests,
  category: c.category,
  rule: c.rule.rule,
  failureClass: c.failureClass,
  cause: c.rule.cause,
  signature: c.signature,
});

describe('PB-LAB-005 triage on the real failures of the lab: one experiment at a time', () => {
  for (const [name, expected] of Object.entries(EXPERIMENTS)) {
    it(`${name}: the clusters, their categories and their root causes are the ones of the run`, () => {
      const collection = collect(`${FIXTURES}${name}`);
      expect(collection.problems).toStrictEqual([]);
      const clusters = cluster(collection.failures);
      expect(collection.failures.filter((f) => f.outcome !== 'flaky')).toHaveLength(expected.failures);
      expect(collection.skipped).toHaveLength(expected.skipped);
      expect(clusters.map(shape)).toStrictEqual(expected.clusters);
      expect(rootCauses(clusters)).toHaveLength(expected.rootCauses);
    });
  }

  it('reads every failing test with its attachments, and says nothing is missing', () => {
    for (const name of [
      'csp-blocks-scripts',
      'origin-503',
      'corrupt-segments',
      'retry-disabled',
      'origin-slow',
    ]) {
      const { failures } = collect(`${FIXTURES}${name}`);
      expect(failures.length, name).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure.file, name).toMatch(/^tests\/e2e\/[\w-]+\.spec\.ts$/);
        expect(failure.attempts, `${name} ${failure.id}`).toBe(2);
        expect(failure.failedAttempts, `${name} ${failure.id}`).toBe(2);
        expect(failure.diagnostics.attached.length, `${name} ${failure.id}`).toBeGreaterThanOrEqual(3);
        // A page that never booted has no player to read: the three documents of the player are missing, and the three of the session are there.
        const playerless = name === 'csp-blocks-scripts';
        expect(failure.missing, `${name} ${failure.id}`).toStrictEqual(
          playerless
            ? ['qa-events.json: not attached', 'qa-metrics.json: not attached', 'qa-info.json: not attached']
            : [],
        );
      }
    }
  });

  it('reads the documented gaps of this host as skips with their reason, not as failures', () => {
    const { skipped, failures } = collect(`${FIXTURES}csp-blocks-scripts`);
    expect(skipped.map((s) => s.project)).toStrictEqual(['firefox', 'firefox', 'firefox']);
    for (const skip of skipped) expect(skip.reason, skip.id).toMatch(/^documented gap in /);
    expect(failures.every((f) => f.project !== 'firefox')).toBe(true);
  });
});

describe('PB-LAB-005 triage on the real failures of the lab: the seven experiments read as one build', () => {
  const collection = collect(FIXTURES);
  const clusters = cluster(collection.failures);
  const causes = rootCauses(clusters);

  it('keeps every failure and groups the clusters of one experiment, never those of two', () => {
    expect(collection.problems).toStrictEqual([]);
    expect(collection.sources).toHaveLength(7);
    expect(collection.failures).toHaveLength(31);
    expect(clusters.reduce((sum, c) => sum + c.size, 0)).toBe(31);
    // 1 + 1 + 2 + 3 + 1 + 2 + 2 clusters, as the experiments make them alone: none merged across them, none split by being read together.
    expect(clusters).toHaveLength(12);
    expect(causes).toHaveLength(8);
    const alone = Object.values(EXPERIMENTS).flatMap((e) => e.clusters.map((c) => c.signature));
    expect(new Set(clusters.map((c) => c.signature))).toStrictEqual(new Set(alone.filter((s) => s !== '')));
  });

  it('has one root cause per induced cause, and two for the slow origin, whose evidence names no cause', () => {
    // Root causes of the same size are ordered by their key, a hash: the pinned list orders them by rule instead.
    const bySizeThenRule = [...causes].sort((a, b) => b.size - a.size || (a.rule < b.rule ? -1 : 1));
    expect(bySizeThenRule.map((c) => [c.size, c.category, c.rule, c.clusters.length])).toStrictEqual([
      [10, 'origin-error', 'origin-failed-without-fault', 3],
      [7, 'page-boot-failure', 'page-did-not-boot', 2],
      [6, 'decode-or-mse-error', 'media-error', 1],
      [4, 'network-fault-not-recovered', 'fault-fired-player-failed', 2],
      [1, 'metric-regression', 'metric-assertion-failed', 1],
      [1, 'environment', 'run-failed-before-any-test', 1],
      [1, 'environment', 'service-not-reachable', 1],
      [1, 'instrument-disagreement', 'test-premise-not-met', 1],
    ]);
  });

  it('is the same whatever order the reports are read in', () => {
    const reversed = cluster([...collection.failures].reverse());
    expect(reversed.map((c) => c.key)).toStrictEqual(clusters.map((c) => c.key));
    expect(rootCauses(reversed)).toStrictEqual(causes);
  });
});
