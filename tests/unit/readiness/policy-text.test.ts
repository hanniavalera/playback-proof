import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkGeneratedBlocks, strategyBlocks } from '../../../tools/check-docs.ts';
import { RESTORE_HOLD_MS } from '../../../src/lab/readiness/evaluators.ts';
import { LIVE_READINESS } from '../../../src/shared/criteria.ts';

// The numbers an evaluator applies that the policy text has to say, and the generated block of the strategy that carries the policy text:
// what the sheet claims it measured must be what the evaluators do.

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

describe('the policy text of the live criteria', () => {
  it('says the hold that the restoration check applies', () => {
    expect(LIVE_READINESS.latencyRestoreMaxMs.measure).toContain(
      `stays there for ${RESTORE_HOLD_MS / 1000} s`,
    );
  });

  it('is what TEST_STRATEGY.md prints in its generated block', () => {
    const markdown = readFileSync(join(ROOT, 'TEST_STRATEGY.md'), 'utf8');
    const live = strategyBlocks().filter((block) => block.name === 'LIVE_CRITERIA');
    expect(live).toHaveLength(1);
    expect(checkGeneratedBlocks(markdown, live)).toEqual([]);
  });

  it('describes the drift the way the evaluator measures it: a robust slope with least squares beside it, not a difference of medians', () => {
    expect(LIVE_READINESS.maxLatencyDriftMs.measure).toContain('Theil-Sen slope');
    expect(LIVE_READINESS.maxLatencyDriftMs.measure).toContain('least squares');
    expect(LIVE_READINESS.maxLatencyDriftMs.measure).toContain('outside the injected faults');
  });
});
