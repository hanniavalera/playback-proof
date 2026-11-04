import type { Environment } from '../../e2e/support/gaps.ts';
import { describe, expect, it } from 'vitest';
import { NO_EME_ERROR, emeGap } from '../../e2e/eme/gaps.ts';

const env = (
  engine: string,
  platform: string,
  envId: string,
): Pick<Environment, 'envId' | 'engine' | 'platform'> => ({
  envId,
  engine,
  platform,
});

describe('emeGap', () => {
  it('documents Linux WebKit: no EME, with the environment, the error and where the evidence is', () => {
    const reason = emeGap(env('webkit', 'linux', 'docker-linux-arm64'));
    expect(reason).toMatch(/^documented gap in docker-linux-arm64: webkit has no Encrypted Media Extensions/);
    expect(reason).toContain(NO_EME_ERROR);
    expect(reason).toContain('docs/decisions/e2e-eme.md');
  });

  it('is the same in every Linux environment, and names it', () => {
    expect(emeGap(env('webkit', 'linux', 'gha-linux-x64'))).toMatch(/^documented gap in gha-linux-x64:/);
  });

  it.each([
    ['chromium', 'darwin'],
    ['chromium', 'linux'],
    ['firefox', 'linux'],
    ['webkit', 'darwin'],
  ])(
    'documents nothing for %s on %s: the spec runs there and fails if it cannot play',
    (engine, platform) => {
      expect(emeGap(env(engine, platform, 'x'))).toBeNull();
    },
  );
});
