// Small timing helpers of the harness. They are for the harness's own safety nets (a run that must end, a child process that must
// answer), never for waiting on the player: everything the player does is waited for on its events (src/lab/measure/page.ts).

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects when `promise` has not settled within `ms`. The work behind it is not cancelled: the caller closes what it started. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
