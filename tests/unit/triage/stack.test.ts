import { describe, expect, it } from 'vitest';
import { applicationFrames, isSpecFile, MAX_FRAMES, repoRelative } from '../../../triage/stack.ts';

const ROOT = '/home/runner/work/playback-proof/playback-proof/tests';

describe('PB-LAB-005 triage stacks: the lab’s own frames, the same on every machine', () => {
  it('keeps the application frames, top first, and drops node_modules, Playwright and Node', () => {
    const stack = [
      'Error: the origin refused',
      '    at waitForFault (/home/runner/work/playback-proof/playback-proof/tests/e2e/rec/faults.ts:55:11)',
      '    at async /home/runner/work/playback-proof/playback-proof/tests/e2e/recovery.spec.ts:130:5',
      '    at async /home/runner/work/playback-proof/playback-proof/node_modules/playwright/lib/worker/testInfo.js:337:9',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    expect(applicationFrames(stack, { rootDir: ROOT })).toStrictEqual([
      { file: 'tests/e2e/rec/faults.ts', fn: 'waitForFault', line: 55 },
      { file: 'tests/e2e/recovery.spec.ts', fn: null, line: 130 },
    ]);
  });

  it('names a method as Class.method, drops `new` and the anonymous names', () => {
    const stack = [
      '    at new TestSession (/r/tests/e2e/support/session.ts:3:3)',
      '    at PlayerHandle.run (/r/tests/e2e/support/player.ts:300:14)',
      '    at Object.<anonymous> (/r/tests/e2e/a.spec.ts:9:1)',
      '    at async (/r/tests/e2e/b.spec.ts:2:2)',
    ].join('\n');
    expect(applicationFrames(stack).map((frame) => frame.fn)).toStrictEqual([
      'TestSession',
      'PlayerHandle.run',
      null,
      null,
    ]);
  });

  it('does not mistake a line of the message for a frame', () => {
    const stack = [
      'Error: media time',
      '    at 22:19:10 the clock stopped',
      '    at /r/tests/e2e/a.spec.ts:9:1',
    ].join('\n');
    expect(applicationFrames(stack)).toHaveLength(1);
    expect(applicationFrames('Error: x\n    at 12:30:45')).toStrictEqual([]);
  });

  it('is empty for no stack, and cuts at the limit', () => {
    expect(applicationFrames(undefined)).toStrictEqual([]);
    expect(applicationFrames('')).toStrictEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `    at f${i} (/r/tests/e2e/x${i}.ts:1:1)`).join('\n');
    expect(applicationFrames(many)).toHaveLength(MAX_FRAMES);
    expect(applicationFrames(many, { max: 2 })).toHaveLength(2);
  });

  it('reads Windows paths and file URLs', () => {
    const stack = [
      '    at check (C:\\work\\playback-proof\\tests\\e2e\\vod\\seeking.ts:88:5)',
      '    at file:///work/playback-proof/src/lab/gaps.ts:10:3',
    ].join('\n');
    expect(applicationFrames(stack)).toStrictEqual([
      { file: 'tests/e2e/vod/seeking.ts', fn: 'check', line: 88 },
      { file: 'src/lab/gaps.ts', fn: null, line: 10 },
    ]);
  });
});

describe('PB-LAB-005 triage stacks: paths relative to the repository', () => {
  it('uses the report’s rootDir: Playwright’s test directory, whose parent is the repository', () => {
    expect(repoRelative(`${ROOT}/e2e/vod-start.spec.ts`, ROOT)).toBe('tests/e2e/vod-start.spec.ts');
    expect(repoRelative('/home/runner/work/playback-proof/playback-proof/src/shared/qa.ts', ROOT)).toBe(
      'src/shared/qa.ts',
    );
    expect(repoRelative('/other/root/tests/e2e/a.ts', '/Users/me/pb/tests')).toBe('tests/e2e/a.ts');
  });

  it('without a rootDir, names the root by the last tests/ or src/ segment: right when the checkout lives under a `src` directory', () => {
    expect(repoRelative('/Users/me/src/playback-proof/tests/e2e/a.ts')).toBe('tests/e2e/a.ts');
    expect(repoRelative('/home/jenkins/agent/workspace/pb/src/lab/gaps.ts')).toBe('src/lab/gaps.ts');
    expect(repoRelative('/x/tests/live/series.ts')).toBe('tests/live/series.ts');
    expect(repoRelative('/x/live/readiness.ts')).toBe('live/readiness.ts');
    expect(repoRelative('/somewhere/else/helper.ts')).toBe('somewhere/else/helper.ts');
  });

  it('tells a spec file from a helper', () => {
    expect(isSpecFile('tests/e2e/abr.spec.ts')).toBe(true);
    expect(isSpecFile('tests/e2e/abr/agreement.ts')).toBe(false);
    expect(isSpecFile('tests/e2e/support/fixtures.ts')).toBe(false);
  });
});
