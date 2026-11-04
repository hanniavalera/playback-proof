// A seeded generator, so that a test with noise in it is a fixed set of inputs and not a dice roll: a failure can be reproduced and
// a pass means the same thing every time.

/** mulberry32: 32 bits of state, uniform on [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise with the given standard deviation (Box-Muller), from a uniform generator. */
export function normal(uniform: () => number, sd: number): () => number {
  return () => {
    const u = Math.max(uniform(), Number.MIN_VALUE);
    const v = uniform();
    return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
