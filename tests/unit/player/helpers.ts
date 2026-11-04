export interface Tracked<T> {
  state: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: Error;
}

/** Follows a promise without awaiting it, so a test can assert that it is still pending. */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const box: Tracked<T> = { state: 'pending' };
  promise.then(
    (value) => {
      box.state = 'resolved';
      box.value = value;
    },
    (error: Error) => {
      box.state = 'rejected';
      box.error = error;
    },
  );
  return box;
}

/** Lets the promise callbacks and microtasks that are already queued run. It is not time: no clock moves. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
