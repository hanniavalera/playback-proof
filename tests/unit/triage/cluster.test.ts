import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cluster, compareFailures } from '../../../triage/cluster.ts';
import type { Cluster, Failure } from '../../../triage/types.ts';
import {
  diagnosticsOf,
  event,
  failure,
  metrics,
  requestEntry,
  sessionDetail,
  shakaError,
} from './support.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// A small seeded generator, so that a "shuffle" is the same on every machine and a failure of the test can be replayed.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = lcg(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** What names a cluster, without the run it was read from: the same for the same causes whatever the ids and the paths. */
const shape = (clusters: readonly Cluster[]) =>
  clusters.map((c) => ({
    rank: c.rank,
    key: c.key,
    signature: c.signature,
    size: c.size,
    tests: c.tests,
    projects: c.projects,
    category: c.category,
    rule: c.rule.rule,
    failureClass: c.failureClass,
  }));

describe('PB-LAB-005 triage clustering: the same cause is one cluster, with its engines listed', () => {
  it('merges the three engines of a real red build into one cluster (the Jenkins build 6 of docs/results/jenkins)', () => {
    // The evidence of a real build whose merge gate was made red on purpose (a spec that expects no HLS media playlist, which is false).
    // The digest keeps the first line of each error and the names of the attachments: that is what is rebuilt here.
    const build = JSON.parse(readFileSync(`${ROOT}docs/results/jenkins/build-6.json`, 'utf8')) as {
      playwright: Array<{
        project: string;
        results: Array<{
          id: string;
          status: string;
          error?: string;
          attachments?: string[];
          attempts?: number;
        }>;
      }>;
    };
    const failures = build.playwright.flatMap((leg) =>
      leg.results
        .filter((result) => result.status === 'failed')
        .map((result) =>
          failure({
            id: result.id,
            title: `${result.id} plays HLS`,
            project: leg.project,
            message: result.error ?? '',
            attempts: result.attempts ?? 1,
            diagnostics: { attached: (result.attachments ?? []).filter((name) => name.endsWith('.json')) },
          }),
        ),
    );
    expect(failures.map((f) => f.project)).toStrictEqual(['chromium', 'firefox', 'webkit']);
    const clusters = cluster(failures);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      rank: 1,
      size: 3,
      tests: ['PB-VOD-002'],
      projects: ['chromium', 'firefox', 'webkit'],
      outcomes: { failed: 3, timedOut: 0, flaky: 0 },
      agreement: { sameRule: 3, of: 3, otherRules: [] },
    });
    expect(clusters[0]?.signature).toBe('Error: HLS media playlists requested (request log) [thrown]');
  });

  it('merges the same cause seen from several tests when one helper threw it, and keeps the tests listed', () => {
    const message = 'Error: the origin did not deliver the segment';
    const frames = [{ file: 'tests/e2e/rec/faults.ts', fn: 'waitForFault', line: 55 }];
    const clusters = cluster([
      failure({ id: 'PB-REC-001', file: 'tests/e2e/recovery.spec.ts', message, frames }),
      failure({ id: 'PB-REC-002', file: 'tests/e2e/recovery.spec.ts', message, frames }),
      failure({ id: 'PB-ABR-003', file: 'tests/e2e/abr.spec.ts', message, frames, project: 'webkit' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      size: 3,
      tests: ['PB-ABR-003', 'PB-REC-001', 'PB-REC-002'],
      projects: ['chromium', 'webkit'],
    });
  });

  it('merges a cause whose message differs only in what changes from run to run', () => {
    const at = (port: number, session: string, rebuffers: number) =>
      failure({
        message: `Error: the player page did not boot (http://127.0.0.1:${port}/player/?manifest=%2Fs%2F${session}%2Fm.mpd): Timeout ${rebuffers}000ms exceeded.`,
      });
    const clusters = cluster([
      at(4731, '1a2b3c4d5e6f', 15),
      at(4655, '9f8e7d6c5b4a', 20),
      at(4700, 'abcdef012345', 15),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.size).toBe(3);
  });
});

describe('PB-LAB-005 triage clustering: two different causes never merge', () => {
  // Six causes, as the lab fails when each is made to happen (docs/results/triage). Their messages are real lab sentences.
  const causes: Failure[] = [
    failure({
      id: 'PB-VOD-001',
      message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
    }),
    failure({
      id: 'PB-VOD-001',
      project: 'firefox',
      message: "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).",
      diagnostics: diagnosticsOf({
        events: [event(0, 'load-requested'), event(1, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 1))],
        detail: sessionDetail([]),
        log: [requestEntry(1), requestEntry(2, { status: 503 }), requestEntry(3, { status: 503 })],
      }),
    }),
    failure({
      id: 'PB-VOD-003',
      message: 'Error: player state (metrics.state) after the end of the title',
      diagnostics: diagnosticsOf({
        events: [event(0, 'error', shakaError(3016, 'VIDEO_ERROR', 3, 2))],
        metrics: metrics({ state: 'error', errors: [shakaError(3016, 'VIDEO_ERROR', 3, 2)] }),
      }),
    }),
    failure({
      id: 'PB-ABR-002',
      message:
        'Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw 3 totalling 900 ms: at media time 4.5 s for 300 ms',
      diagnostics: diagnosticsOf({ metrics: metrics({ rebuffers: 3 }) }),
    }),
    failure({
      id: 'PB-REC-002',
      message: 'Error: player state (metrics.state) after every rung was refused',
      diagnostics: diagnosticsOf({
        events: [event(0, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 2))],
        metrics: metrics({ state: 'error', errors: [shakaError(1001, 'BAD_HTTP_STATUS', 1, 2)] }),
        detail: sessionDetail([{ id: 'f1', type: 'abort' }]),
        log: [requestEntry(1, { status: 200, aborted: true, abortReason: 'fault-abort', faults: ['f1'] })],
      }),
    }),
    failure({
      id: 'PB-ENV-001',
      message:
        'Error: the player page did not boot (http://127.0.0.1:4731/player/): Timeout 15000ms exceeded.',
    }),
  ];

  it('keeps six causes in six clusters, each with its own category', () => {
    const clusters = cluster(causes);
    expect(clusters).toHaveLength(6);
    expect(clusters.map((c) => c.category).sort()).toStrictEqual([
      'decode-or-mse-error',
      'environment',
      'metric-regression',
      'network-fault-not-recovered',
      'origin-error',
      'page-boot-failure',
    ]);
  });

  it('keeps the same symptom apart when the critical error the player ended on differs', () => {
    const symptom = (code: number, name: string) =>
      failure({
        message: 'Error: player state (metrics.state): the player is in the error state',
        diagnostics: diagnosticsOf({
          metrics: metrics({ state: 'error', errors: [shakaError(code, name, Math.floor(code / 1000), 2)] }),
        }),
      });
    const clusters = cluster([
      symptom(1001, 'BAD_HTTP_STATUS'),
      symptom(3016, 'VIDEO_ERROR'),
      symptom(1001, 'BAD_HTTP_STATUS'),
    ]);
    expect(clusters.map((c) => [c.size, c.parts.shakaCode])).toStrictEqual([
      [2, 1001],
      [1, 3016],
    ]);
  });

  it('keeps two unrelated failures that share a message with no words of its own apart, by their specs', () => {
    const generic = 'Error: expect(received).toBe(expected) // Object.is equality';
    const clusters = cluster([
      failure({ id: 'PB-ABR-001', file: 'tests/e2e/abr.spec.ts', message: generic }),
      failure({ id: 'PB-LIVE-001', file: 'tests/e2e/live.spec.ts', message: generic }),
    ]);
    expect(clusters).toHaveLength(2);
  });
});

describe('PB-LAB-005 triage clustering: determinism', () => {
  /** Thirty failures of six causes in four engines, each with the ids and numbers a run makes up. */
  function run(salt: number): Failure[] {
    const next = lcg(salt);
    const hex = () =>
      Math.floor(next() * 0xffffff)
        .toString(16)
        .padStart(6, '0') + 'ab';
    const port = () => 4600 + Math.floor(next() * 90);
    const engines = ['chromium', 'firefox', 'webkit', 'chromium-cpu4x'];
    const out: Failure[] = [];
    engines.forEach((project, engine) => {
      const base = {
        project,
        durationMs: 1000 + Math.floor(next() * 9000),
        source: `reports/${project}/playwright.json`,
      };
      out.push(
        failure({
          ...base,
          id: 'PB-VOD-001',
          message: `Error: the player page did not boot (http://127.0.0.1:${port()}/player/?manifest=%2Fs%2F${hex()}%2Fm.mpd): Timeout 15000ms exceeded.`,
        }),
        failure({
          ...base,
          id: 'PB-VOD-002',
          message: `Error: qa.waitFor('firstframe') timed out after ${15000 + engine * 0} ms (looking from index ${Math.floor(next() * 40)}).`,
        }),
        failure({
          ...base,
          id: 'PB-ABR-002',
          message: `Error: rebuffers (metrics.rebuffer.count): expected at most 1, saw ${2 + Math.floor(next() * 3)} totalling ${Math.floor(next() * 3000)} ms: at media time 4.5 s for 300 ms`,
          diagnostics: diagnosticsOf({ metrics: metrics({ rebuffers: 2 }) }),
        }),
      );
      if (engine < 2) {
        out.push(
          failure({
            ...base,
            id: 'PB-REC-001',
            message: `Error: the fault rule f${1 + Math.floor(next() * 3)} {"type":"status"} named 0 of the 1 request it was waited for within 15000 ms: the player never asked for what the rule matches`,
          }),
        );
      }
    });
    out.push(
      failure({
        id: 'PB-EME-001',
        project: 'webkit',
        message:
          'Error: Shaka reports that this browser is not supported (shaka.Player.isBrowserSupported() is false): Mozilla/5.0',
      }),
      failure({
        id: 'PB-VOD-009',
        project: 'chromium',
        message: `Error: ${'x'.repeat(5)} unexpected ${Math.floor(next() * 1000)}`,
      }),
    );
    return out;
  }

  it('gives the same clusters in the same order for any order of the failures', () => {
    const failures = run(1);
    const expected = shape(cluster(failures));
    expect(expected.length).toBe(6);
    for (let seed = 1; seed <= 25; seed += 1) {
      expect(shape(cluster(shuffled(failures, seed)))).toStrictEqual(expected);
    }
  });

  it('gives the same clusters for the same causes made of different ids, ports, timestamps and numbers', () => {
    const a = shape(cluster(run(1)));
    for (const salt of [2, 3, 4, 99]) expect(shape(cluster(run(salt)))).toStrictEqual(a);
  });

  it('orders by size, then by the engines it was seen in, then by signature', () => {
    const clusters = cluster(run(1));
    expect(clusters.map((c) => c.rank)).toStrictEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < clusters.length; i += 1) {
      const [before, after] = [clusters[i - 1] as Cluster, clusters[i] as Cluster];
      expect(
        before.size > after.size ||
          (before.size === after.size && before.projects.length > after.projects.length) ||
          (before.size === after.size &&
            before.projects.length === after.projects.length &&
            before.signature < after.signature),
      ).toBe(true);
    }
    expect(clusters[0]?.size).toBe(4);
    expect(clusters.at(-1)?.size).toBe(1);
  });

  it('describes a cluster by its richest failure, then by engine and test: the same one every time', () => {
    const rich = failure({
      id: 'PB-VOD-003',
      project: 'webkit',
      message: 'Error: x',
      diagnostics: { attached: ['qa-events.json', 'qa-metrics.json'] },
    });
    const poor = failure({ id: 'PB-VOD-001', project: 'chromium', message: 'Error: x' });
    const alsoRich = failure({
      id: 'PB-VOD-002',
      project: 'firefox',
      message: 'Error: x',
      diagnostics: { attached: ['qa-events.json', 'qa-metrics.json'] },
    });
    for (const order of [
      [rich, poor, alsoRich],
      [poor, alsoRich, rich],
      [alsoRich, rich, poor],
    ]) {
      expect(cluster(order)[0]?.representative.id).toBe('PB-VOD-002');
    }
    expect(compareFailures(rich, rich)).toBe(0);
    expect(compareFailures(poor, rich)).toBeGreaterThan(0);
  });
});

describe('PB-LAB-005 triage clustering: what a cluster says', () => {
  it('counts the outcomes and lists the members by test and engine', () => {
    const message = "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).";
    const [one] = cluster([
      failure({ id: 'PB-VOD-006', project: 'webkit', outcome: 'timedOut', message }),
      failure({ id: 'PB-VOD-006', project: 'chromium', outcome: 'failed', message }),
      failure({ id: 'PB-VOD-005', project: 'chromium', outcome: 'flaky', message }),
    ]);
    expect(one?.outcomes).toStrictEqual({ failed: 1, timedOut: 1, flaky: 1 });
    expect(one?.members.map((m) => `${m.id}/${m.project}`)).toStrictEqual([
      'PB-VOD-005/chromium',
      'PB-VOD-006/chromium',
      'PB-VOD-006/webkit',
    ]);
  });

  it('describes a cluster by what its richest failure shows, and says which rules fired for the others when they differ', () => {
    // The same wait timed out in two engines. Chromium attached its log, which shows the origin failing with no fault on it and the player
    // noticing; WebKit attached nothing. A recoverable error is not part of the signature, so they are one cluster, and the rules differ.
    const message = "Error: qa.waitFor('firstframe') timed out after 15000 ms (looking from index 0).";
    const withLog = diagnosticsOf({
      events: [event(0, 'load-requested'), event(1, 'error', shakaError(1001, 'BAD_HTTP_STATUS', 1, 1))],
      detail: sessionDetail([]),
      log: [requestEntry(1), requestEntry(2, { status: 503 }), requestEntry(3, { status: 503 })],
      attached: ['qa-events.json', 'session-detail.json', 'request-log.json'],
    });
    const [one] = cluster([
      failure({ id: 'PB-VOD-001', project: 'webkit', message }),
      failure({ id: 'PB-VOD-001', project: 'chromium', message, diagnostics: withLog }),
    ]);
    expect(one?.size).toBe(2);
    expect(one?.representative.project).toBe('chromium');
    expect(one?.rule.rule).toBe('origin-failed-without-fault');
    expect(one?.agreement).toStrictEqual({ sameRule: 1, of: 2, otherRules: ['hook-wait-timed-out'] });
  });

  it('calls a cluster of failures that all passed on a retry a flake, and says what to do; one that failed for good is not', () => {
    const message = "Error: qa.waitFor('seeked') timed out after 15000 ms (looking from index 0).";
    const [flaky] = cluster([
      failure({ outcome: 'flaky', message }),
      failure({ outcome: 'flaky', project: 'webkit', message }),
    ]);
    expect(flaky?.failureClass).toBe('Flake');
    expect(flaky?.firstCheck).toMatch(/^Do not rerun the job: it passed on the retry/);
    const [mixed] = cluster([
      failure({ outcome: 'flaky', message }),
      failure({ outcome: 'failed', project: 'webkit', message }),
    ]);
    expect(mixed?.failureClass).toBe('Functional regression');
    expect(mixed?.firstCheck).not.toMatch(/^Do not rerun/);
  });

  it('keeps an environment failure an environment failure even when it passed on a retry', () => {
    const [one] = cluster([
      failure({
        outcome: 'flaky',
        message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4731/player/',
      }),
    ]);
    expect(one?.failureClass).toBe('Environment or infrastructure');
    expect(one?.firstCheck).not.toMatch(/^Do not rerun/);
  });

  it('has no clusters for no failures', () => {
    expect(cluster([])).toStrictEqual([]);
  });

  it('turns an error of the run into a cluster of its own, in the environment', () => {
    const [one] = cluster([
      failure({
        scope: 'run',
        id: '(run)',
        project: '(run)',
        file: '',
        message:
          'Error: the test data service at http://127.0.0.1:4750 is not answering (fetch failed): start it with `npm run build:player && npm run serve`',
      }),
    ]);
    expect(one).toMatchObject({ category: 'environment', projects: ['(run)'], size: 1 });
    expect(one?.parts.location).toBeNull();
  });
});
