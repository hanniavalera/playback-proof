import { describe, expect, it } from 'vitest';
import { applyCpuThrottle, throttleRateOf } from '../../../tests/e2e/support/cpu-throttle.ts';

// The wiring of the low-end profile: where the rate comes from, and what is sent to Chromium. A fake CDP session records the commands.

function fakeContext() {
  const calls: string[] = [];
  const session = {
    send: async (method: string, params: unknown) => {
      calls.push(`send ${method} ${JSON.stringify(params)}`);
    },
  };
  const context = {
    newCDPSession: async (page: unknown) => {
      calls.push(`newCDPSession ${(page as { name: string }).name}`);
      return session;
    },
  };
  return { calls, session, context };
}

describe('throttleRateOf', () => {
  it('reads the rate from the project metadata, and is null for a project that is not throttled', () => {
    expect(throttleRateOf({ cpuThrottleRate: 4 })).toBe(4);
    expect(throttleRateOf({ cpuThrottleRate: 1 })).toBe(1);
    expect(throttleRateOf({ cpuThrottleRate: 6.5 })).toBe(6.5);
    expect(throttleRateOf({})).toBeNull();
    expect(throttleRateOf({ somethingElse: 4 })).toBeNull();
    expect(throttleRateOf({ cpuThrottleRate: null })).toBeNull();
  });

  it.each([0, 0.5, -4, Number.NaN, Number.POSITIVE_INFINITY, '4', true])(
    'refuses %s: a mistake in the config must not become an unthrottled "low-end" run',
    (rate) => {
      expect(() => throttleRateOf({ cpuThrottleRate: rate })).toThrow(
        /cpuThrottleRate must be a number >= 1/,
      );
    },
  );
});

describe('applyCpuThrottle', () => {
  it('opens a CDP session on the page and sets the rate, in that order, and hands the session back to be kept attached', async () => {
    const { calls, session, context } = fakeContext();
    const page = { name: 'page-1' };
    const returned = await applyCpuThrottle({
      browserName: 'chromium',
      rate: 4,
      context: context as never,
      page: page as never,
    });
    expect(calls).toStrictEqual(['newCDPSession page-1', 'send Emulation.setCPUThrottlingRate {"rate":4}']);
    expect(returned).toBe(session);
  });

  it.each(['firefox', 'webkit'])(
    'fails in %s, which has no CPU throttle, and opens no session',
    async (browserName) => {
      const { calls, context } = fakeContext();
      await expect(
        applyCpuThrottle({ browserName, rate: 4, context: context as never, page: { name: 'p' } as never }),
      ).rejects.toThrow(new RegExp(`4x CPU throttle, but ${browserName} has no CPU throttle`));
      expect(calls).toStrictEqual([]);
    },
  );
});
