// The one source of randomness of the A/B harness: the bootstrap, the A/A splits and the power simulations all draw from a generator that
// is seeded, so a result can be reproduced from the seed that the pre-registration fixed (ab/prereg.ts) and nothing else.

/** A function that returns a float in [0, 1) every time it is called. */
export type Random = () => number;

/**
 * mulberry32 (Tommy Ettinger): a 32-bit generator with one word of state, a period of 2^32 and good enough equidistribution for resampling.
 * The state is kept in 32 bits on every step (`>>> 0`), so the sequence stays the published one however many numbers are drawn; the same
 * seed always gives the same sequence, in every Node version.
 */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 32-bit seed derived from words and numbers (FNV-1a over their text, joined with a separator that cannot occur in them). It gives
 * every use of randomness its own stream out of the one seed of an experiment (`seedFrom(seed, 'bootstrap', 'startupMs')`), so adding a
 * metric or a split never changes the numbers of another.
 */
export function seedFrom(...parts: ReadonlyArray<string | number>): number {
  const text = parts.map((part) => String(part)).join('\u0001');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** An integer drawn uniformly from 0 to n - 1. */
export function randomInt(random: Random, n: number): number {
  return Math.floor(random() * n);
}

/** Fisher-Yates: shuffles `items` in place (every order equally likely) and returns it. */
export function shuffleInPlace<T>(items: T[], random: Random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(random, i + 1);
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}
