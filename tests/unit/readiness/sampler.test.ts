import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DRAIN_EXPRESSION,
  MAX_KEPT_SAMPLES,
  STOP_EXPRESSION,
  installExpression,
  toSoakSample,
} from '../../../src/lab/readiness/sampler.ts';
import type { Drained, InstallResult, RawSample } from '../../../src/lab/readiness/sampler.ts';

// The sampler is a string that the harness evaluates in the page, so it is run here in a Node `vm` with a fake `window`: the hook, the
// page's clock and its timers are scripted, and the test ticks the interval by hand. It is the only way to test code that lives in
// another process without a browser, and it is the code that every soak read comes from.

const ORIGIN = 1_760_000_000_000;

function fakePage(metrics: (n: number) => unknown = (n) => reading(n)) {
  let clock = 1000;
  let reads = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sandbox: Record<string, unknown> = {
    performance: { now: () => clock, timeOrigin: ORIGIN },
    setInterval: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: (id: number) => {
      sandbox.cleared = id;
    },
    __qa: { metrics: () => metrics(reads++) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return {
    run: <T>(expression: string): T => vm.runInContext(expression, sandbox) as T,
    tick: (ms = 5000) => {
      clock += ms;
      timers[0]?.fn();
    },
    timers,
    sandbox,
  };
}

const reading = (n: number): unknown => ({
  state: 'playing',
  playback: { currentTime: 10 + n, playbackRate: 1, bufferedAheadSec: 6 },
  live: { latencyMs: 6200 + n, edgeSeeks: 0 },
  frames: { decoded: 30 * n, dropped: 0 },
  rebuffer: { count: 0, totalMs: 0 },
  errors: [],
});

describe('the in-page sampler', () => {
  it('takes a read at once, then one per tick, stamped with the page clock, and hands them over', () => {
    const page = fakePage();
    const installed = page.run<InstallResult>(installExpression(5000));
    expect(installed).toEqual({ timeOrigin: ORIGIN, reused: false });
    expect(page.timers).toHaveLength(1);
    expect(page.timers[0]?.ms).toBe(5000);
    page.tick();
    page.tick();
    const drained = page.run<Drained>(DRAIN_EXPRESSION);
    expect(drained.samples).toHaveLength(3);
    expect(drained.samples.map((s) => s.t)).toEqual([1000, 6000, 11_000]);
    expect(drained.samples.map((s) => s.latencyMs)).toEqual([6200, 6201, 6202]);
    expect(drained.samples[0]).toMatchObject({
      state: 'playing',
      mediaTime: 10,
      rate: 1,
      buffered: 6,
      decoded: 0,
      rebufferCount: 0,
      errors: 0,
    });
    expect(drained.lost).toBe(0);
    // Handing over empties the page's list: what the page holds stays bounded however long the soak.
    expect(page.run<Drained>(DRAIN_EXPRESSION).samples).toEqual([]);
    page.tick();
    expect(page.run<Drained>(DRAIN_EXPRESSION).samples).toHaveLength(1);
  });

  it('is installed once: a second install leaves the first sampler alone', () => {
    const page = fakePage();
    page.run(installExpression(5000));
    expect(page.run<InstallResult>(installExpression(1000))).toEqual({ timeOrigin: ORIGIN, reused: true });
    expect(page.timers).toHaveLength(1);
  });

  it('keeps going when the hook throws, and says so: a bad read is a problem, not the end of the soak', () => {
    const page = fakePage((n) => {
      if (n === 1) throw new Error('the player is gone');
      return reading(n);
    });
    page.run(installExpression(5000));
    page.tick();
    page.tick();
    const drained = page.run<Drained>(DRAIN_EXPRESSION);
    expect(drained.samples).toHaveLength(2);
    expect(drained.problems).toEqual(['the player is gone']);
  });

  it('drops the oldest reads and counts them when the harness does not collect them, instead of growing', () => {
    const page = fakePage();
    page.run(installExpression(5000, 5));
    for (let i = 0; i < 8; i++) page.tick();
    const drained = page.run<Drained>(DRAIN_EXPRESSION);
    expect(drained.samples).toHaveLength(5);
    expect(drained.lost).toBe(4);
    expect(drained.samples.at(-1)?.latencyMs).toBe(6208);
    expect(page.run<Drained>(DRAIN_EXPRESSION).lost).toBe(0);
    expect(MAX_KEPT_SAMPLES).toBeGreaterThan(300);
  });

  it('stops its timer on request, and drains nothing from a page that never had one', () => {
    const page = fakePage();
    expect(page.run(DRAIN_EXPRESSION)).toBeNull();
    expect(page.run(STOP_EXPRESSION)).toBe(false);
    page.run(installExpression(5000));
    expect(page.run(STOP_EXPRESSION)).toBe(true);
    expect(page.sandbox.cleared).toBe(1);
  });

  it('refuses a cadence that would make the sampler the load it measures', () => {
    expect(() => installExpression(50)).toThrow(RangeError);
    expect(() => installExpression(Number.NaN)).toThrow(RangeError);
  });

  it('places a read on the epoch axis with the origin the page reported', () => {
    const raw: RawSample = {
      t: 1234.5,
      mediaTime: 12,
      latencyMs: null,
      state: 'buffering',
      rate: 1.1,
      buffered: 0,
      decoded: 100,
      dropped: 2,
      rebufferCount: 1,
      rebufferMs: 3800,
      edgeSeeks: 0,
      errors: 1,
    };
    expect(toSoakSample(raw, ORIGIN)).toEqual({
      atMs: ORIGIN + 1234.5,
      mediaTime: 12,
      latencyMs: null,
      state: 'buffering',
      playbackRate: 1.1,
      bufferedAheadSec: 0,
      decodedFrames: 100,
      droppedFrames: 2,
      rebufferCount: 1,
      rebufferMs: 3800,
      edgeSeeks: 0,
      errors: 1,
    });
  });
});
