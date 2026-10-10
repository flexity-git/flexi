/** A FIFO semaphore capping how many tasks run at once. */
export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export function createLimiter(max: number): ConcurrencyLimiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`maxConcurrency must be a positive integer, got ${max}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      return;
    }
    // The slot is handed over by release() without decrementing `active`.
    await new Promise<void>((resolve) => queue.push(resolve));
  };

  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}
