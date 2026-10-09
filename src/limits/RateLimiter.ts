export class PerKeyLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  constructor(private readonly maxPerKey = 2) {}

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await task();
    } finally {
      this.release(key);
    }
  }

  private acquire(key: string): Promise<void> {
    const count = this.active.get(key) || 0;
    if (count < this.maxPerKey) {
      this.active.set(key, count + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = this.queues.get(key) || [];
      queue.push(() => {
        this.active.set(key, (this.active.get(key) || 0) + 1);
        resolve();
      });
      this.queues.set(key, queue);
    });
  }

  private release(key: string): void {
    const count = Math.max(0, (this.active.get(key) || 1) - 1);
    if (count) this.active.set(key, count);
    else this.active.delete(key);
    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (next) next();
    if (queue && !queue.length) this.queues.delete(key);
  }
}

