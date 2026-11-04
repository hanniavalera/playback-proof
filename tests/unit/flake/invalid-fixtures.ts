import { engineGap, resolveEnvironment } from '../../../src/lab/gaps.ts';
import type { FlakeRun, Outcome, TestRecord } from '../../../flake/run.ts';
import { probedEngine, resultFile } from '../probe/fixtures.ts';
import { record, run } from './fixtures.ts';

// Fixtures for the invalid-run budget. Two of them are the real thing: the outcomes of two collections of PB-ABR-002 on WebKit on the
// GitHub macOS runner (macos-15, 3 vCPU, Apple M1 virtual), 40 repetitions each, one worker, one retry, `tools/flake-collect.ts`, commit
// 8f2073cd (fix/abr002-forced-change), 2026-11-04. Each character is one repetition, in order: `p` the test passed on its first
// attempt, `s` the attempt was ended as an invalid run. The heads are the first sentence of the reason of each of those skips, as
// recorded (the rest of the reason is the same paragraph every time, with the time of the climb); the history files of the two
// collections are 59 KB of which this is the part the budget reads. The numbers that matter: 8 of 40 and 6 of 40.

export interface RealCollection {
  label: string;
  /** One character per repetition. */
  outcomes: string;
  /** The reasons of the `s` repetitions, in order. */
  heads: readonly string[];
  /** The CI run id of the repetition n is `${runId}-${n}`. */
  runId: string;
}

export const ABR002_FIX: RealCollection = {
  label: 'abr002-fix: the classifier of ADR-106, tracing on',
  outcomes: 'spsppppppppppppppppspppspppspssppppppspp',
  heads: [
    'invalid run: forced climb to 360p 3.3 s after the step down, 13 of 1104 frames dropped.',
    'invalid run: forced climb to 720p 2.0 s after the step down, 80 of 1020 frames dropped.',
    'invalid run: forced climb to 360p 6.0 s after the step down, 25 of 964 frames dropped.',
    'invalid run: forced climb to 360p 4.0 s after the step down, 17 of 960 frames dropped.',
    'invalid run: forced climb to 360p 3.3 s after the step down, 73 of 1104 frames dropped.',
    'invalid run: forced climb to 360p 3.5 s after the step down, 31 of 1099 frames dropped.',
    'invalid run: forced climb to 360p 3.5 s after the step down, 19 of 1098 frames dropped.',
    'invalid run: forced climb to 360p 6.0 s after the step down, 16 of 964 frames dropped.',
  ],
  runId: 'collect-20261104T172346Z-8c529b',
};

export const ABR002_TRACEOFF: RealCollection = {
  label: 'abr002-traceoff: the same code, tracing off',
  outcomes: 'spppsppsppppsspppppppppppppppspppppppppp',
  heads: [
    'invalid run: forced climb to 720p 4.0 s after the step down, 79 of 1056 frames dropped.',
    'invalid run: forced climb to 360p 3.3 s after the step down, 62 of 1104 frames dropped.',
    'invalid run: forced climb to 360p 5.8 s after the step down, 41 of 1210 frames dropped.',
    'invalid run: forced climb to 360p 3.4 s after the step down, 63 of 1102 frames dropped.',
    'invalid run: forced climb to 720p 4.0 s after the step down, 28 of 1020 frames dropped.',
    'invalid run: forced climb to 360p 3.8 s after the step down, 38 of 1209 frames dropped.',
  ],
  runId: 'collect-20261104T172156Z-b06307',
};

const REAL_TITLE =
  'PB-ABR-002 downshifts when bandwidth drops mid-playback (bandwidth-drop): at most one rebuffer, settles on a rung the network can carry';

/** The first `upTo` repetitions of a real collection as runs: one run of one test each, as the collector recorded them. */
export function realHistory(collection: RealCollection, upTo = collection.outcomes.length): FlakeRun[] {
  let skips = 0;
  return [...collection.outcomes].slice(0, upTo).map((outcome, index) => {
    const reason = outcome === 's' ? collection.heads[skips++] : undefined;
    const test: TestRecord = {
      ...record({
        id: 'PB-ABR-002',
        project: 'webkit',
        outcome: outcome === 's' ? 'skipped' : 'passed',
        ...(reason === undefined ? {} : { skipReason: reason }),
      }),
      title: REAL_TITLE,
      file: 'tests/e2e/abr.spec.ts',
      tags: ['@dash', '@merge'],
    };
    return run([test], { runId: `${collection.runId}-${index + 1}`, envId: 'gha-macos-arm64' });
  });
}

/** A reason of the classifier, the first one the real fix collection recorded. */
export const INVALID_REASON = ABR002_FIX.heads[0] as string;

/** A real documented-gap reason: the one `src/lab/gaps.ts` builds for an engine that does not start in an environment. */
export const GAP_REASON: string = (() => {
  const evidence = resultFile('fixture-no-webkit', {
    chromium: probedEngine({ version: '100.0' }),
    firefox: probedEngine({ version: '200.0' }),
    webkit: { launchFailed: 'Failed to launch the browser process.' },
  });
  const reason = engineGap(
    resolveEnvironment({ envId: evidence.envId, engine: 'webkit', evidence, runInLinuxWebKit: false }),
  );
  if (reason === null) throw new Error('the fixture environment must have a documented gap');
  return reason;
})();

/** A `test.skip` that is neither an invalid run nor a documented gap. */
export const OTHER_SKIP_REASON = 'needs a hardware decoder, which the runner does not have';

export interface PatternOptions {
  project?: string;
  tier?: 'merge' | 'release' | null;
  quarantined?: boolean;
  retries?: number;
  envId?: string;
  runIdPrefix?: string;
  /** Used for every `i`. */
  reason?: string;
}

const KINDS: Record<string, { outcome: Outcome; reason?: string | null }> = {
  p: { outcome: 'passed' },
  f: { outcome: 'flaky' },
  F: { outcome: 'failed' },
  i: { outcome: 'skipped', reason: null },
  g: { outcome: 'skipped', reason: GAP_REASON },
  s: { outcome: 'skipped', reason: OTHER_SKIP_REASON },
  n: { outcome: 'skipped' },
  x: { outcome: 'interrupted' },
};

/**
 * One run per character of `chars`, oldest first, each holding one test: `p` passed, `f` flaky, `F` failed, `i` an invalid run, `g` a
 * documented-gap skip (the real reason of gaps.ts), `s` another skip with a reason, `n` a skip with no reason, `x` interrupted.
 */
export function pattern(id: string, chars: string, options: PatternOptions = {}): FlakeRun[] {
  return [...chars].map((char, index) => {
    const kind = KINDS[char];
    if (!kind) throw new Error(`no kind of execution for ${JSON.stringify(char)}`);
    const reason = kind.reason === null ? (options.reason ?? INVALID_REASON) : kind.reason;
    return run(
      [
        record({
          id,
          project: options.project ?? 'webkit',
          outcome: kind.outcome,
          ...(options.tier === undefined ? {} : { tier: options.tier }),
          ...(options.quarantined === undefined ? {} : { quarantined: options.quarantined }),
          ...(options.retries === undefined ? {} : { retries: options.retries }),
          ...(reason === undefined ? {} : { skipReason: reason }),
        }),
      ],
      {
        ...(options.runIdPrefix === undefined ? {} : { runId: `${options.runIdPrefix}-${index + 1}` }),
        ...(options.envId === undefined ? {} : { envId: options.envId }),
      },
    );
  });
}
