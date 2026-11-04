import type { Clock } from '../../../src/server/clock.ts';

/** A clock that only moves when a test moves it: the pure parts of the service are tested without sleeping. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(startMs: number = Date.UTC(2030, 0, 1)) {
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }

  advance(ms: number): number {
    this.ms += ms;
    return this.ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }
}
