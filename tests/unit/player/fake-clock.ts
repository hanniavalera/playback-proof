import type { Timers } from '../../../src/player/timeline.ts';

/**
 * A page clock that only moves when a test moves it: `performance.now()`, `video.currentTime` and the safety-net timers
 * of the waiters, so the player's unit tests never wait for real time.
 */
export class FakeClock {
  private ms = 1000;
  /** What `video.currentTime` reads. */
  media = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  readonly now = (): number => this.ms;
  readonly mediaTime = (): number => this.media;

  readonly timerApi: Timers = {
    setTimeout: (run, delay) => {
      const handle = this.nextHandle++;
      this.timers.set(handle, { at: this.ms + delay, run });
      return handle;
    },
    clearTimeout: (handle) => {
      this.timers.delete(handle as number);
    },
  };

  /** Timers that have not fired and have not been cleared. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves the clock, firing the timers that fall due in order. */
  advance(delta: number): void {
    const target = this.ms + delta;
    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.ms = Math.max(this.ms, next[1].at);
      next[1].run();
    }
    this.ms = target;
  }
}
