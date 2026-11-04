import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  buildEvidence,
  excerptConsole,
  groupStages,
  parseSkippedStages,
  parseStageParents,
  parseToolVersions,
  parseWorkspaces,
  redact,
  stringifyEvidence,
  summarizeArtifacts,
  summarizePlaywright,
  worstStatus,
} from '../../../tools/lib/jenkins-evidence.ts';
import type { EvidenceInput, RawStage, StageSteps } from '../../../tools/lib/jenkins-evidence.ts';

// The evidence of a Jenkins build is what a reader trusts instead of the build: these tests keep it from leaking a credential, from
// reporting a skipped stage as a second failure, and from calling a red merge gate green (the stage view does that for a group).

const stamp = (line: string, time = '04:41:35.738'): string => `[2026-11-04T${time}Z] ${line}`;

describe('redact', () => {
  it('removes a known secret wherever it appears, as often as it appears', () => {
    const text = `login as admin with s3cret-value-1234 then s3cret-value-1234 again`;
    expect(redact(text, ['s3cret-value-1234'])).toBe(
      `login as admin with ${REDACTED} then ${REDACTED} again`,
    );
  });

  it('never blanks a log because a secret is empty', () => {
    expect(redact('plain text', [''])).toBe('plain text');
  });

  it('removes credentials by their shape: authorization, crumb, agent secret, userinfo of a URL', () => {
    const hex = 'ab'.repeat(32);
    const text = [
      'Authorization: Basic YWRtaW46aHVudGVyMg==',
      'Jenkins-Crumb: 0123456789abcdef',
      `java -jar agent.jar -name x -secret ${hex}`,
      'fetching https://admin:hunter2@example.test/repo.git',
    ].join('\n');
    const out = redact(text);
    for (const leaked of ['YWRtaW46aHVudGVyMg', '0123456789abcdef', hex, 'hunter2'])
      expect(out, leaked).not.toContain(leaked);
    expect(out).toContain('https://[redacted]@example.test/repo.git');
  });

  it('leaves what only looks similar: a secret passed as a file, a hash, a URL without userinfo', () => {
    const text =
      '-secret @/run/agent-secrets/playwright-1\nsha256 ' + 'cd'.repeat(32) + '\nhttp://jenkins:8080/login';
    expect(redact(text)).toBe(text);
  });
});

describe('excerptConsole', () => {
  const log = [
    'Started by user admin',
    'Obtained Jenkinsfile from git file:///repo',
    '[Pipeline] { (Install)',
    stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof'),
    stamp('Cloning repository file:///repo'),
    stamp(' > git fetch --tags --force --progress'),
    stamp(' > git checkout -f fd6708764d7e5a0193d46c8096d671ac772ce6f7'),
    stamp(' > git config core.sparsecheckout'),
    stamp('npm warn install-scripts 2 packages have install scripts not yet covered by allowScripts'),
    stamp('added 136 packages in 2s'),
    stamp('tool-version node v24.22.1'),
    '',
    '[Pipeline] { (Unit)',
    stamp(' ✓ tests/unit/shared/profiles.test.ts (33 tests) 7ms'),
    stamp(' Test Files  66 passed (66)'),
    stamp('      Tests  1707 passed (1707)'),
    stamp('   Duration  79.11s (tests 96%, transform 2%, import 2%)'),
    '[Pipeline] { (chromium)',
    stamp('  ✓  1 [chromium] › tests/e2e/env.spec.ts:19:1 › PB-ENV-001 the engine plays (4.1s)'),
    stamp('  3 passed (21.5s)'),
    'Finished: SUCCESS',
  ].join('\n');

  it('keeps the markers, the tools and the summary of each gate, in order, and says how much it left out', () => {
    const { text, omitted } = excerptConsole(log);
    const lines = text.trimEnd().split('\n');
    expect(lines.filter((l) => !l.startsWith('[... '))).toEqual([
      'Started by user admin',
      'Obtained Jenkinsfile from git file:///repo',
      '[Pipeline] { (Install)',
      stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof'),
      stamp('added 136 packages in 2s'),
      stamp('tool-version node v24.22.1'),
      '[Pipeline] { (Unit)',
      stamp(' Test Files  66 passed (66)'),
      stamp('      Tests  1707 passed (1707)'),
      stamp('   Duration  79.11s (tests 96%, transform 2%, import 2%)'),
      '[Pipeline] { (chromium)',
      stamp('  ✓  1 [chromium] › tests/e2e/env.spec.ts:19:1 › PB-ENV-001 the engine plays (4.1s)'),
      stamp('  3 passed (21.5s)'),
      'Finished: SUCCESS',
    ]);
    // Five lines of progress between the runner line and the install summary are marked; the one line before the Unit summary is
    // not (a gap under four lines is not worth a marker), but it is counted. A blank line is not a line.
    expect(omitted).toBe(6);
    expect(lines.filter((l) => l.startsWith('[... '))).toEqual(['[... 5 lines left out ...]']);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('keeps everything that says why a build is red, and which stages were skipped', () => {
    const red = [
      stamp(' FAIL  tests/unit/probe/media.test.ts > ensureProbeMedia > generates the same bytes'),
      stamp('Stage "Streams" skipped due to earlier failure(s)'),
      stamp('  1) [chromium] › tests/e2e/vod-start.spec.ts:44:1 › PB-VOD-001 DASH VOD starts'),
      stamp(
        '    Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe(\u001b[32mexpected\u001b[39m)',
      ),
      stamp('    Expected: 4'),
      stamp('    Received: 3'),
      stamp('  1 failed'),
      stamp('Failed in branch chromium'),
      'ERROR: script returned exit code 1',
      'Finished: FAILURE',
    ].join('\n');
    const kept = excerptConsole(red).text;
    for (const needle of [
      'Stage "Streams" skipped',
      '1) [chromium]',
      'Error: expect(received).toBe(expected)',
      'Expected: 4',
      'Received: 3',
      '1 failed',
      'Failed in branch chromium',
      'ERROR: script returned exit code 1',
      'Finished: FAILURE',
    ])
      expect(kept, needle).toContain(needle);
    expect(kept).not.toContain('\u001b');
  });

  it('keeps the verdicts of the Perf, Flake and Triage stages and none of the progress of the measurement', () => {
    const later = [
      '[Pipeline] { (Perf)',
      stamp('paired: creating the control checkout of 9df85d83da21'),
      stamp(
        '[PB-PERF-004]   run 10/11: startupMs=262.4 manifestMs=110 loadedMs=157 droppedRatio=0 fps=30 start 720p, 7.9 s',
      ),
      stamp(
        'performance gate: chromium-cpu4x in gha-linux-x64, baseline of 2026-11-04 (commit 9df85d8, 10 runs per scenario)',
      ),
      stamp(
        'PB-PERF-004 low-end (chromium-cpu4x): 10 runs after a warm-up, stream vod-cmaf, clean, start rung 720p',
      ),
      stamp(
        'metric         baseline median / tail  current median / tail  change  threshold                      verdict',
      ),
      stamp(
        'startupMs      261.5 ms / 272.4 ms     247.4 ms / 283.1 ms    -5.4 %  median +30 %, and more than 20 ms  pass',
      ),
      stamp('verdict: PASS (exit code 0)'),
      stamp(
        'rebufferCount  0 / 0                   0 / 0                  +0      median +0, p90 +0                          pass',
      ),
      '[Pipeline] { (Flake)',
      stamp(
        'flake gate: FAIL (1 failure)  [gha-macos-arm64, 2026-11-04, 1 run in this build, 40 runs judged]',
      ),
      stamp(
        '| engine job | builds | executions | flaky | rate | budget | verdict | left out (quarantined) |',
      ),
      stamp('| chromium | 2 | 30 | 0 | 0.0% | 2.0% | not-enough-data | 0 |'),
      stamp('| PB-VOD-001 | chromium | 2 | 0 | 0 | 0.0% | not-enough-data | no |'),
      stamp('| PB-VOD-002 | chromium | 2 | 0 | 1 | 0.0% | not-enough-data | no |'),
      stamp('| PB-ABR-001 | webkit | 16 | 30 | 53.3% | 40.0% | over-invalid-budget | no |'),
      stamp(
        '1. [over-invalid-budget] PB-ABR-001 on webkit was an invalid run in 16 of 30 of its last scheduled executions',
      ),
      stamp('   Decision: Fix the machine (load, decode), or declare the leg a documented gap with evidence'),
      '[Pipeline] { (Triage)',
      stamp(
        'failure triage: 31 failed in 7 reports became 12 clusters of 8 root causes (clustering is deterministic)',
      ),
      stamp(
        'root cause: the origin answered 503 on segment to requests no fault rule named (10 failures in the clusters #1, #6)',
      ),
      stamp('#1  6 failures in chromium, webkit  ·  PB-VOD-001, PB-VOD-002, PB-VOD-006'),
      stamp('    category  unknown  (rule no-rule-matched)  ·  class Needs a person'),
      stamp('    evidence  no rule matched “Error: HLS media playlists requested (request log)”'),
      'Finished: FAILURE',
    ].join('\n');
    const kept = excerptConsole(later).text;
    for (const needle of [
      'paired: creating the control checkout of 9df85d83da21',
      'performance gate: chromium-cpu4x in gha-linux-x64',
      '10 runs after a warm-up',
      'startupMs      261.5 ms',
      'verdict: PASS (exit code 0)',
      'rebufferCount  0 / 0',
      'flake gate: FAIL (1 failure)',
      '| engine job | builds |',
      '| chromium | 2 | 30 |',
      '| PB-VOD-002 | chromium | 2 | 0 | 1 |',
      '| PB-ABR-001 | webkit | 16 |',
      '1. [over-invalid-budget] PB-ABR-001 on webkit',
      'Decision: Fix the machine',
      'failure triage: 31 failed in 7 reports became 12 clusters',
      'root cause: the origin answered 503',
      '#1  6 failures in chromium, webkit',
      'category  unknown  (rule no-rule-matched)',
      'evidence  no rule matched',
    ])
      expect(kept, needle).toContain(needle);
    expect(kept).not.toContain('run 10/11');
    // A test with no flake and no failure is a row of zeros, and the gate prints one for every test and engine.
    expect(kept).not.toContain('| PB-VOD-001 | chromium |');
  });

  it('produces just the newline for a log with nothing in it', () => {
    expect(excerptConsole('')).toEqual({ text: '\n', kept: 0, omitted: 0 });
  });
});

describe('parseToolVersions and parseSkippedStages', () => {
  it('reads what the tools said, with the timestamps in front, and reports only what it understood', () => {
    const log = [
      stamp('tool-version node v24.22.1'),
      stamp('tool-version npm 11.19.1'),
      stamp(
        'tool-version ffmpeg ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers',
      ),
      stamp('tool-version java openjdk version "21.0.12.1" 2026-08-18'),
      stamp('tool-version playwright Version 1.64.1'),
      stamp('tool-version git something unrecognizable'),
      stamp('tool-version npm not a version'),
    ].join('\n');
    expect(parseToolVersions(log)).toEqual({
      node: 'v24.22.1',
      npm: '11.19.1',
      ffmpeg: '6.1.1-3ubuntu5',
      java: '21.0.12.1',
      playwright: '1.64.1',
    });
    expect(parseToolVersions('no tools here')).toEqual({});
  });

  it('lists the stages that were skipped, by name', () => {
    const log = [
      'Stage "Streams" skipped due to earlier failure(s)',
      stamp('Stage "Merge gate" skipped due to earlier failure(s)'),
      'Stage "Unit" is fine',
    ].join('\n');
    expect([...parseSkippedStages(log)]).toEqual(['Streams', 'Merge gate']);
  });

  it('lists the workspaces the build ran in once each: two of them mean two executors were busy at once', () => {
    const log = [
      stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof'),
      stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof@2'),
      stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof'),
      stamp('Cloning into /home/jenkins/agent/workspace/playback-proof@3'),
    ].join('\n');
    expect(parseWorkspaces(log)).toEqual([
      '/home/jenkins/agent/workspace/playback-proof',
      '/home/jenkins/agent/workspace/playback-proof@2',
    ]);
    expect(parseWorkspaces('nothing ran')).toEqual([]);
  });
});

describe('parseStageParents', () => {
  // The markers of the pipeline of this lab as build 8 printed them: Install and Static in Checks, four stages in the parallel block
  // of Merge gate, then Perf at the top level, and Triage skipped by its condition (no marker at all).
  const log = [
    '[Pipeline] stage',
    '[Pipeline] { (Checks)',
    '[Pipeline] stage',
    '[Pipeline] { (Install)',
    stamp('Running on playwright-1 in /home/jenkins/agent/workspace/playback-proof'),
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] stage',
    '[Pipeline] { (Static)',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] stage',
    '[Pipeline] { (Merge gate)',
    '[Pipeline] parallel',
    '[Pipeline] { (Branch: chromium)',
    '[Pipeline] { (Branch: firefox)',
    '[Pipeline] stage',
    '[Pipeline] { (chromium)',
    '[Pipeline] stage',
    '[Pipeline] { (firefox)',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] }',
    '[Pipeline] // parallel',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] stage',
    '[Pipeline] { (Perf)',
    '[Pipeline] }',
    '[Pipeline] // stage',
    '[Pipeline] stage',
    'Stage "Triage" skipped due to when conditional',
    '[Pipeline] // stage',
  ].join('\n');

  it('says which stage each stage opened in: the parallel stages in the one that holds the block, the next stage at the top', () => {
    expect([...parseStageParents(log)]).toEqual([
      ['Checks', null],
      ['Install', 'Checks'],
      ['Static', 'Checks'],
      ['Merge gate', null],
      ['chromium', 'Merge gate'],
      ['firefox', 'Merge gate'],
      ['Perf', null],
    ]);
  });

  it('knows nothing of a log without markers', () => {
    expect(parseStageParents('Started by user admin\nFinished: SUCCESS').size).toBe(0);
  });

  it('reads the markers through the timestamps and the colour codes', () => {
    const stamped = stamp('\u001b[0m[Pipeline] { (Perf)');
    expect([...parseStageParents(stamped)]).toEqual([['Perf', null]]);
  });
});

// The shape of /wfapi/describe as the scratch pipeline of this lab returned it: the groups report a few milliseconds and a green status
// of their own; the two branches that waited for an executor started their step seconds after their stage.
const T0 = 1_000_000;
const stage = (
  id: string,
  name: string,
  status: string,
  start: number,
  duration: number,
  error?: string,
): RawStage => ({
  id,
  name,
  status,
  startTimeMillis: T0 + start,
  durationMillis: duration,
  ...(error ? { error: { message: error, type: 'hudson.AbortException' } } : {}),
});
const ran = (start: number): StageSteps => ({ stepCount: 2, firstStepStartMillis: T0 + start });
const group: StageSteps = { stepCount: 0, firstStepStartMillis: null };

describe('groupStages', () => {
  const stages = [
    stage('6', 'Checks', 'SUCCESS', 1_000, 196),
    stage('10', 'Install', 'SUCCESS', 1_200, 800),
    stage('15', 'Static', 'SUCCESS', 2_000, 1_200),
    stage('34', 'Merge gate', 'SUCCESS', 4_000, 58),
    stage('44', 'chromium', 'SUCCESS', 4_060, 3_900),
    stage('46', 'firefox', 'SUCCESS', 4_070, 3_900),
    stage('48', 'chromium-cpu4x', 'SUCCESS', 4_080, 7_800),
    stage('50', 'webkit', 'FAILED', 4_090, 7_800, 'script returned exit code 1'),
  ];
  const steps = new Map<string, StageSteps>([
    ['6', group],
    ['10', ran(1_250)],
    ['15', ran(2_010)],
    ['34', group],
    ['44', ran(4_100)],
    ['46', ran(4_110)],
    ['48', ran(8_000)],
    ['50', ran(8_010)],
  ]);

  it('nests the stages under the group that precedes them and gives the group the worst status of its stages', () => {
    const out = groupStages(stages, steps, T0);
    expect(out.map((s) => [s.name, s.group, s.status])).toEqual([
      ['Checks', null, 'SUCCESS'],
      ['Install', 'Checks', 'SUCCESS'],
      ['Static', 'Checks', 'SUCCESS'],
      ['Merge gate', null, 'FAILED'],
      ['chromium', 'Merge gate', 'SUCCESS'],
      ['firefox', 'Merge gate', 'SUCCESS'],
      ['chromium-cpu4x', 'Merge gate', 'SUCCESS'],
      ['webkit', 'Merge gate', 'FAILED'],
    ]);
  });

  it('gives a group the wall-clock of its stages, not the few milliseconds the stage view reports', () => {
    const out = groupStages(stages, steps, T0);
    const gate = out.find((s) => s.name === 'Merge gate');
    // From the start of the group (4 000) to the end of the last branch (4 080 + 7 800 and 4 090 + 7 800).
    expect(gate).toMatchObject({ startMs: 4_000, durationMs: 7_890 });
    expect(out.find((s) => s.name === 'Checks')).toMatchObject({ startMs: 1_000, durationMs: 2_200 });
  });

  it('keeps the stages that come after a group out of it when the console says where each one opened', () => {
    const later = [
      ...stages,
      stage('60', 'Perf', 'SUCCESS', 12_000, 5_000),
      stage('62', 'Flake', 'SUCCESS', 17_100, 300),
      // Skipped by its condition: the stage view reports it NOT_EXECUTED, and the log has no marker for it.
      stage('64', 'Triage', 'NOT_EXECUTED', 17_500, 0),
    ];
    const laterSteps = new Map(steps).set('60', ran(12_020)).set('62', ran(17_110)).set('64', ran(17_510));
    const parents = new Map<string, string | null>([
      ['Checks', null],
      ['Install', 'Checks'],
      ['Static', 'Checks'],
      ['Merge gate', null],
      ['chromium', 'Merge gate'],
      ['firefox', 'Merge gate'],
      ['chromium-cpu4x', 'Merge gate'],
      ['webkit', 'Merge gate'],
      ['Perf', null],
      ['Flake', null],
    ]);
    const out = groupStages(later, laterSteps, T0, new Set(), parents);
    expect(out.map((s) => [s.name, s.group])).toEqual([
      ['Checks', null],
      ['Install', 'Checks'],
      ['Static', 'Checks'],
      ['Merge gate', null],
      ['chromium', 'Merge gate'],
      ['firefox', 'Merge gate'],
      ['chromium-cpu4x', 'Merge gate'],
      ['webkit', 'Merge gate'],
      ['Perf', null],
      ['Flake', null],
      ['Triage', null],
    ]);
    // The wall-clock of the merge gate ends with its last branch; Perf, which ran after it, is not part of it.
    expect(out.find((s) => s.name === 'Merge gate')).toMatchObject({ startMs: 4_000, durationMs: 7_890 });
    // Without the console, the order of the stage view is all there is, and a stage after a group is taken for one of its own.
    expect(groupStages(later, laterSteps, T0).find((s) => s.name === 'Perf')?.group).toBe('Merge gate');
  });

  it('separates the wait for an executor from the time a stage ran', () => {
    const out = groupStages(stages, steps, T0);
    expect(out.map((s) => [s.name, s.waitedMs])).toEqual([
      ['Checks', 0],
      ['Install', 50],
      ['Static', 10],
      ['Merge gate', 0],
      ['chromium', 40],
      ['firefox', 40],
      ['chromium-cpu4x', 3_920],
      ['webkit', 3_920],
    ]);
  });

  it('does not report a skipped stage as a second failure, and keeps the real one', () => {
    const failed = [
      stage('12', 'Checks', 'SUCCESS', 0, 52),
      stage('28', 'Unit', 'FAILED', 100, 84_118, 'script returned exit code 1'),
      stage('33', 'Streams', 'FAILED', 84_300, 41, 'script returned exit code 1'),
      stage('49', 'Merge gate', 'SUCCESS', 84_400, 99),
      stage('60', 'chromium', 'FAILED', 84_500, 173, 'script returned exit code 1'),
    ];
    const failedSteps = new Map<string, StageSteps>([
      ['12', group],
      ['28', ran(150)],
      // A skipped stage resolves its context: one step, but it never started anything.
      ['33', ran(84_310)],
      ['49', ran(84_410)],
      ['60', ran(84_510)],
    ]);
    const out = groupStages(failed, failedSteps, T0, new Set(['Streams', 'Merge gate', 'chromium']));
    expect(out.map((s) => [s.name, s.group, s.status, s.error ?? null, s.waitedMs])).toEqual([
      ['Checks', null, 'FAILED', null, 0],
      ['Unit', 'Checks', 'FAILED', 'script returned exit code 1', 50],
      ['Streams', null, 'NOT_EXECUTED', null, 0],
      ['Merge gate', null, 'NOT_EXECUTED', null, 0],
      ['chromium', null, 'NOT_EXECUTED', null, 0],
    ]);
  });

  it('ranks statuses: a failure outweighs an abort, a skip counts for least', () => {
    expect(worstStatus(['SUCCESS', 'FAILED', 'NOT_EXECUTED'])).toBe('FAILED');
    expect(worstStatus(['SUCCESS', 'ABORTED', 'UNSTABLE'])).toBe('ABORTED');
    expect(worstStatus(['NOT_EXECUTED', 'SUCCESS'])).toBe('SUCCESS');
    expect(worstStatus(['NOT_EXECUTED', 'NOT_EXECUTED'])).toBe('NOT_EXECUTED');
  });
});

describe('summarizePlaywright', () => {
  const ansiError = '\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 4\nReceived: 3';
  const report = {
    stats: { duration: 21_534.4 },
    suites: [
      {
        specs: [],
        suites: [
          {
            specs: [
              {
                title: 'PB-ENV-001 the engine plays the selected flavour',
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'expected',
                    annotations: [
                      {
                        type: 'environment',
                        description: 'jenkins-linux-arm64: chromium 156.0.8078.4; evidence: none',
                      },
                    ],
                    results: [{ duration: 4_100.2 }],
                  },
                ],
              },
              {
                title: 'PB-VOD-001 DASH VOD starts',
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'unexpected',
                    results: [
                      {
                        duration: 9_000,
                        error: { message: ansiError },
                        attachments: [{ name: 'qa-events.json' }, { name: 'screenshot' }],
                      },
                      {
                        duration: 8_000,
                        error: { message: ansiError },
                        attachments: [{ name: 'qa-events.json' }, { name: 'request-log.json' }],
                      },
                    ],
                  },
                ],
              },
              {
                title: 'PB-VOD-002 HLS VOD starts',
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'flaky',
                    results: [{ duration: 3_000, error: { message: 'timeout' } }, { duration: 2_000 }],
                  },
                ],
              },
              {
                title: 'PB-VOD-003 something skipped',
                tests: [{ projectName: 'chromium', status: 'skipped', results: [{ duration: 0 }] }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('counts what happened per project, with the id, the attempts, the first line of the failure and the attachments', () => {
    const [summary] = summarizePlaywright(report);
    expect(summary).toMatchObject({
      project: 'chromium',
      tests: 4,
      passed: 1,
      failed: 1,
      flaky: 1,
      skipped: 1,
      runDurationMs: 21_534,
      environment: 'jenkins-linux-arm64: chromium 156.0.8078.4; evidence: none',
    });
    expect(summary?.results).toEqual([
      { id: 'PB-ENV-001', status: 'passed', durationMs: 4_100 },
      {
        id: 'PB-VOD-001',
        status: 'failed',
        durationMs: 17_000,
        attempts: 2,
        error: 'Error: expect(received).toBe(expected)',
        attachments: ['qa-events.json', 'screenshot', 'request-log.json'],
      },
      { id: 'PB-VOD-002', status: 'flaky', durationMs: 5_000, attempts: 2, error: 'timeout' },
      { id: 'PB-VOD-003', status: 'skipped', durationMs: 0 },
    ]);
  });

  it('yields nothing for a document that is not a Playwright report', () => {
    expect(summarizePlaywright(null)).toEqual([]);
    expect(summarizePlaywright({ unrelated: true })).toEqual([]);
  });
});

describe('summarizeArtifacts', () => {
  it('keeps the reports and groups what a failing test left by the directory of the test', () => {
    const dir = 'test-results/vod-start-PB-VOD-002-HLS-VOD-starts-a1b2c-chromium';
    const paths = [
      'reports/chromium/playwright.json',
      'reports/chromium/html/index.html',
      'reports/chromium/html/data/abcdef.zip',
      'test-results/.last-run.json',
      `${dir}/qa-events.json`,
      `${dir}/request-log.json`,
      `${dir}-retry1/qa-events.json`,
    ];
    expect(summarizeArtifacts(paths)).toEqual({
      count: 7,
      reports: ['reports/chromium/playwright.json', 'reports/chromium/html/index.html'],
      failureFiles: {
        [dir]: ['qa-events.json', 'request-log.json'],
        [`${dir}-retry1`]: ['qa-events.json'],
      },
    });
  });

  it('is empty for a build that archived nothing', () => {
    expect(summarizeArtifacts([])).toEqual({ count: 0, reports: [], failureFiles: {} });
  });
});

describe('buildEvidence', () => {
  const base: EvidenceInput = {
    job: 'playback-proof',
    build: 3,
    label: 'test',
    expected: 'SUCCESS',
    result: 'SUCCESS',
    startedAtMs: Date.UTC(2026, 10, 4, 5, 0, 0),
    durationMs: 600_000,
    queuedMs: 4,
    collectedAtMs: Date.UTC(2026, 10, 4, 5, 30, 0),
    commit: 'fd67087',
    branch: 'p4/jenkins',
    jenkinsVersion: '2.580.2',
    controllerExecutors: 0,
    plugins: { git: '5.11.0', 'configuration-as-code': '2144.ve8c697101488' },
    agents: [{ name: 'playwright-1', executors: 2, labels: ['playwright'] }],
    workspaces: ['/home/jenkins/agent/workspace/playback-proof'],
    tools: { node: 'v24.22.1' },
    stages: [
      { name: 'Merge gate', group: null, status: 'SUCCESS', startMs: 100, durationMs: 9_000, waitedMs: 0 },
      {
        name: 'chromium',
        group: 'Merge gate',
        status: 'SUCCESS',
        startMs: 100,
        durationMs: 4_000,
        waitedMs: 500,
      },
      {
        name: 'firefox',
        group: 'Merge gate',
        status: 'SUCCESS',
        startMs: 100,
        durationMs: 4_500,
        waitedMs: 100,
      },
      {
        name: 'webkit',
        group: 'Merge gate',
        status: 'SUCCESS',
        startMs: 4_600,
        durationMs: 4_500,
        waitedMs: 4_000,
      },
    ],
    playwright: [],
    artifacts: ['reports/chromium/playwright.json'],
  };

  it('compares the merge gate with the same engines run one after the other', () => {
    const evidence = buildEvidence(base);
    expect(evidence.mergeGate).toEqual({
      wallClockMs: 9_000,
      branchesMs: 3_500 + 4_400 + 500,
      waitedMs: 4_600,
      branches: 3,
    });
    expect(evidence).toMatchObject({
      asExpected: true,
      startedAt: '2026-11-04T05:00:00.000Z',
      collectedAt: '2026-11-04T05:30:00.000Z',
    });
    expect(evidence.failure).toBeUndefined();
    expect(Object.keys(evidence.jenkins)).toEqual([
      'version',
      'executorsOnController',
      'pluginCount',
      'plugins',
    ]);
    expect(evidence.jenkins.plugins).toEqual(['configuration-as-code:2144.ve8c697101488', 'git:5.11.0']);
    expect(evidence.jenkins.pluginCount).toBe(2);
  });

  it('names the stage and the tests of a red build, and says whether red was the point', () => {
    const red = buildEvidence({
      ...base,
      result: 'FAILURE',
      expected: 'FAILURE',
      stages: [
        { name: 'Merge gate', group: null, status: 'FAILED', startMs: 100, durationMs: 9_000, waitedMs: 0 },
        {
          name: 'chromium',
          group: 'Merge gate',
          status: 'FAILED',
          startMs: 100,
          durationMs: 4_000,
          waitedMs: 0,
          error: 'script returned exit code 1',
        },
        {
          name: 'firefox',
          group: 'Merge gate',
          status: 'SUCCESS',
          startMs: 100,
          durationMs: 4_500,
          waitedMs: 0,
        },
      ],
      playwright: [
        {
          project: 'chromium',
          tests: 2,
          passed: 1,
          failed: 1,
          flaky: 0,
          skipped: 0,
          runDurationMs: 8_000,
          environment: null,
          results: [
            { id: 'PB-ENV-001', status: 'passed', durationMs: 1 },
            { id: 'PB-VOD-001', status: 'failed', durationMs: 2, attachments: ['qa-events.json'] },
          ],
        },
      ],
    });
    expect(red.asExpected).toBe(true);
    expect(red.failure).toEqual({
      stage: 'chromium',
      group: 'Merge gate',
      message: 'script returned exit code 1',
      tests: [
        {
          project: 'chromium',
          test: { id: 'PB-VOD-001', status: 'failed', durationMs: 2, attachments: ['qa-events.json'] },
        },
      ],
    });
    expect(buildEvidence({ ...base, result: 'FAILURE' }).asExpected).toBe(false);
  });

  it('counts a red build as the one that was planned only when it is red where it was meant to be', () => {
    const stages = (failedName: string): EvidenceInput['stages'] => [
      {
        name: 'Unit',
        group: 'Checks',
        status: failedName === 'Unit' ? 'FAILED' : 'SUCCESS',
        startMs: 0,
        durationMs: 10,
        waitedMs: 0,
      },
      { name: 'Merge gate', group: null, status: 'FAILED', startMs: 20, durationMs: 90, waitedMs: 0 },
      {
        name: 'chromium',
        group: 'Merge gate',
        status: failedName === 'chromium' ? 'FAILED' : 'SUCCESS',
        startMs: 20,
        durationMs: 90,
        waitedMs: 0,
      },
    ];
    const red = (failedName: string, expectedStage?: string) =>
      buildEvidence({
        ...base,
        result: 'FAILURE',
        expected: 'FAILURE',
        ...(expectedStage === undefined ? {} : { expectedStage }),
        stages: stages(failedName),
      });
    expect(red('chromium', 'Merge gate').asExpected).toBe(true);
    expect(red('chromium', 'chromium').asExpected).toBe(true);
    expect(red('chromium').asExpected).toBe(true);
    // The unplanned red: the unit stage failed first, so the merge gate never had its turn.
    expect(red('Unit', 'Merge gate').asExpected).toBe(false);
    expect(red('Unit', 'Merge gate').failure).toMatchObject({ stage: 'Unit', group: 'Checks' });
    expect(red('chromium', 'Unit').asExpected).toBe(false);
    expect(buildEvidence({ ...base, expectedStage: 'Merge gate' }).asExpected).toBe(true);
  });
});

describe('stringifyEvidence', () => {
  it('writes what fits on one line on one line, and expands the rest', () => {
    const value = {
      a: [1, 2, 3],
      b: { c: 'x' },
      rows: [
        { name: 'chromium', status: 'SUCCESS', startMs: 100, durationMs: 4_000, waitedMs: 500 },
        { name: 'firefox', status: 'SUCCESS', startMs: 100, durationMs: 4_500, waitedMs: 100 },
      ],
    };
    const text = stringifyEvidence(value);
    expect(text).toContain('  "a": [1, 2, 3],');
    expect(text).toContain('  "b": { "c": "x" },');
    expect(text).toContain(
      '    { "name": "chromium", "status": "SUCCESS", "startMs": 100, "durationMs": 4000, "waitedMs": 500 },',
    );
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(value);
  });

  it('fills a long list of strings line by line, within 120 columns, so that the plugins stay short', () => {
    const plugins = Array.from({ length: 40 }, (_, i) => `plugin-number-${i}:1.${i}.0-abcdef`);
    const text = stringifyEvidence({ jenkins: { plugins } });
    const lines = text.split('\n');
    expect(lines.length).toBeLessThan(plugins.length * 0.75);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(120);
    expect(JSON.parse(text)).toEqual({ jenkins: { plugins } });
  });

  it('drops undefined members like JSON does, and keeps null', () => {
    const text = stringifyEvidence({ keep: null, drop: undefined, list: [undefined, 1] });
    expect(JSON.parse(text)).toEqual({ keep: null, list: [null, 1] });
  });
});
