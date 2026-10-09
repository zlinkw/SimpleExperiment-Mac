/** One active write plus one replaceable latest snapshot; no per-event queue. */
export class LatestSnapshotWriter<T> {
  private pending?: { value: T };
  private active?: Promise<void>;

  constructor(private readonly write: (value: T) => Promise<void>) {}

  enqueue(value: T): Promise<void> {
    this.pending = { value };
    if (!this.active) {
      this.active = Promise.resolve().then(async () => {
        try {
          while (this.pending) {
            const next = this.pending;
            this.pending = undefined;
            await this.write(next.value);
          }
        } finally { this.active = undefined; }
      });
    }
    return this.active;
  }

  get pendingCount(): number { return this.pending ? 1 : 0; }
}
