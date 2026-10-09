import { FileTransferTask } from "./FileTransferTypes";

export class FileTransferQueue {
  private running = 0;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly tasks = new Map<string, FileTransferTask>();

  constructor(private readonly maxConcurrent = 1) {}

  enqueue<T extends FileTransferTask>(factory: () => Promise<T>, seed: FileTransferTask): Promise<T> {
    this.tasks.set(seed.transferId, seed);
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.running += 1;
        try {
          seed.status = "running";
          const task = await factory();
          this.tasks.set(task.transferId, task);
          resolve(task);
        } catch (error) {
          seed.status = "failed";
          seed.error = error instanceof Error ? error.message : String(error);
          reject(error);
        } finally {
          this.running = Math.max(0, this.running - 1);
          this.next();
        }
      };
      this.queue.push(run);
      this.next();
    });
  }

  list(): FileTransferTask[] {
    return [...this.tasks.values()];
  }

  private next(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const run = this.queue.shift();
      if (run) void run();
    }
  }
}
