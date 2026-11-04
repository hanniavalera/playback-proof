import { describe, expect, it } from 'vitest';
import { checkLaunchOptions } from '../../../src/lab/measure/browser.ts';
import { PERF_PROFILES } from '../../../src/lab/measure/types.ts';

// The only part of the launcher that can be tested without starting a browser: what it refuses before it starts one.

describe('PB-PERF browser launch: a replaced CPU throttle is a Chromium command', () => {
  it.each(['chromium', 'chromium-cpu4x'] as const)(
    'accepts it on %s, which has the DevTools command',
    (profile) => {
      expect(() => checkLaunchOptions(profile, { cpuThrottleRate: 8 })).not.toThrow();
    },
  );

  it.each(['firefox', 'webkit'] as const)(
    'refuses it on %s, before a browser starts, and says why',
    (profile) => {
      expect(() => checkLaunchOptions(profile, { cpuThrottleRate: 4 })).toThrow(
        `a CPU throttle is a Chromium DevTools command: ${profile} cannot be given one`,
      );
    },
  );

  it('asks nothing of a launch that replaces nothing, on any profile', () => {
    for (const profile of PERF_PROFILES) expect(() => checkLaunchOptions(profile, {})).not.toThrow();
  });
});
