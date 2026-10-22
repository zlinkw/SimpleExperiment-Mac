/** One submission's live preparation. Never persisted or used as remote task state. */
export class WorkerPreparation {
  readonly ready = new Set<string>();
  settled = false;
  error?: Error;
  private resolveFirst!: (id: string) => void;
  private rejectFirst!: (error: Error) => void;
  private firstReady = new Promise<string>((resolve, reject) => { this.resolveFirst = resolve; this.rejectFirst = reject; });
  readonly finished: Promise<void>;
  constructor(work: (ready: (id: string) => void) => Promise<unknown>, onReady: (id: string) => void = () => {}) {
    this.firstReady.catch(() => {});
    this.finished = Promise.resolve().then(() => work(id => {
      if (this.ready.has(id)) return;
      this.ready.add(id); this.resolveFirst(id); onReady(id);
    })).then(() => {}, error => { this.error = error instanceof Error ? error : new Error(String(error)); }).then(() => {
      this.settled = true;
      if (!this.ready.size) this.rejectFirst(this.error || new Error("没有 Worker 完成运行准备。"));
    });
  }
  first() { return this.firstReady; }
  async all() { await this.finished; if (this.error) throw this.error; }
}
