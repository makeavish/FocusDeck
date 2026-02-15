import { ACTION_RATE_LIMIT_MS } from "@/shared/constants";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export class ActionDispatcher {
  private queue: Promise<void> = Promise.resolve();
  private lastActionAt = 0;

  constructor(private readonly minIntervalMs = ACTION_RATE_LIMIT_MS) {}

  dispatch<T>(action: () => T | Promise<T>): Promise<T> {
    const task = async () => {
      const now = Date.now();
      const delay = Math.max(0, this.lastActionAt + this.minIntervalMs - now);

      if (delay > 0) {
        await sleep(delay);
      }

      this.lastActionAt = Date.now();
      return action();
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}
