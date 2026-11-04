// The service reads time through a Clock so that the pure parts (rule clocks, the live edge, session expiry) are tested with a
// manual clock and never with sleeps. `now()` is epoch milliseconds: the live simulation publishes real UTC instants
// (availabilityStartTime, UTCTiming), so the service clock has to be the wall clock.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
