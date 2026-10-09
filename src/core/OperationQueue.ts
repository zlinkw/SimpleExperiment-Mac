import { normalizeSimpleError, SimpleError } from "./ErrorModel";

export type OperationPriority = "user_blocking" | "manual" | "background" | "realtime";
export type OperationStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timeout" | "coalesced";

export interface OperationSpec {
  id: string;
  type: string;
  priority: OperationPriority;
  targetServers?: string[];
  targetKeys?: string[];
  cancellable?: boolean;
  exclusiveKeys?: string[];
  timeoutMs?: number;
  coalesceKey?: string;
  run(signal: AbortSignal): Promise<void>;
}

export class OperationQueueCapacityError extends Error {
  readonly code = "OPERATION_QUEUE_FULL";
  constructor(maxPending: number) {
    super(`operation queue is full (${maxPending} pending operations)`);
    this.name = "OperationQueueCapacityError";
  }
}

export class OperationAlreadyActiveError extends Error {
  readonly code = "OPERATION_ALREADY_ACTIVE";
  constructor(id: string) {
    super(`operation is already queued or running: ${id}`);
    this.name = "OperationAlreadyActiveError";
  }
}

export class OperationCancelledError extends Error {
  readonly code = "OPERATION_CANCELLED";
  constructor(id: string) {
    super(`operation cancelled before it started: ${id}`);
    this.name = "OperationCancelledError";
  }
}

export interface QueuedOperationRecord {
  id: string;
  type: string;
  priority: OperationPriority;
  status: OperationStatus;
  startedAt?: string;
  finishedAt?: string;
  targetServers: string[];
  targetKeys: string[];
  exclusiveKeys: string[];
  error?: SimpleError;
}

const priorityRank: Record<OperationPriority, number> = {
  user_blocking: 0,
  manual: 1,
  background: 2,
  realtime: 3,
};
const terminalStatuses = new Set<OperationStatus>(["succeeded", "failed", "cancelled", "timeout", "coalesced"]);

export class OperationQueue {
  private pending: Array<{ spec: OperationSpec; resolve: () => void; reject: (error: unknown) => void }> = [];
  private running = new Map<string, {
    spec: OperationSpec;
    controller: AbortController;
    cancelled: boolean;
    timedOut: boolean;
  }>();
  private coalesced = new Map<string, Promise<void>>();
  private records: QueuedOperationRecord[] = [];
  private readonly latestRecordById = new Map<string, QueuedOperationRecord>();
  private readonly activeExclusiveKeyCounts = new Map<string, number>();

  constructor(private readonly historyLimit = 500, private readonly maxPending = 256) {
    this.historyLimit = Math.max(1, Math.floor(Number(historyLimit) || 500));
    this.maxPending = Math.max(1, Math.floor(Number(maxPending) || 256));
  }

  enqueue(spec: OperationSpec): Promise<void> {
    if (!spec || !String(spec.id || "").trim()) return Promise.reject(new Error("operation id is required"));
    if (this.running.has(spec.id) || this.pending.some((item) => item.spec.id === spec.id))
      return Promise.reject(new OperationAlreadyActiveError(spec.id));
    if (spec.coalesceKey) {
      const existing = this.coalesced.get(spec.coalesceKey);
      if (existing) {
        this.record(spec, "coalesced");
        return existing;
      }
    }
    if (this.pending.length >= this.maxPending) return Promise.reject(new OperationQueueCapacityError(this.maxPending));
    const promise = new Promise<void>((resolve, reject) => {
      this.pending.push({ spec, resolve, reject });
      this.record(spec, "queued");
      this.pump();
    });
    const coalesceKey = spec.coalesceKey;
    if (coalesceKey) {
      this.coalesced.set(coalesceKey, promise);
      const clear = () => {
        if (this.coalesced.get(coalesceKey) === promise) this.coalesced.delete(coalesceKey);
      };
      // Handle both branches explicitly. A bare finally() creates a second
      // rejected Promise that can become an unhandled rejection when no caller
      // observes the coalescing registry value.
      void promise.then(clear, clear);
    }
    return promise;
  }

  cancel(id: string): boolean {
    const running = this.running.get(id);
    if (running && running.spec.cancellable) {
      running.cancelled = true;
      running.controller.abort();
      this.update(id, "cancelling");
      return true;
    }
    const index = this.pending.findIndex((item) => item.spec.id === id && item.spec.cancellable);
    if (index >= 0) {
      const [item] = this.pending.splice(index, 1);
      item.reject(new OperationCancelledError(id));
      this.update(id, "cancelled");
      this.pump();
      return true;
    }
    return false;
  }

  snapshot(limit = 50): QueuedOperationRecord[] {
    return this.records.slice(-limit);
  }

  activeExclusiveKeys(): Set<string> {
    return new Set(this.activeExclusiveKeyCounts.keys());
  }

  private pump(): void {
    this.pending.sort((a, b) => priorityRank[a.spec.priority] - priorityRank[b.spec.priority]);
    for (;;) {
      const index = this.pending.findIndex((item) => this.canRun(item.spec));
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      void this.start(item);
    }
  }

  private canRun(spec: OperationSpec): boolean {
    const keys = spec.exclusiveKeys || [];
    if (!keys.length) return true;
    return !keys.some((key) => this.activeExclusiveKeyCounts.has(key));
  }

  private async start(item: { spec: OperationSpec; resolve: () => void; reject: (error: unknown) => void }): Promise<void> {
    const controller = new AbortController();
    const execution = { spec: item.spec, controller, cancelled: false, timedOut: false };
    this.running.set(item.spec.id, execution);
    this.addActiveExclusiveKeys(item.spec);
    this.update(item.spec.id, "running", { startedAt: new Date().toISOString() });
    let timer: NodeJS.Timeout | undefined;
    try {
      if (item.spec.timeoutMs) {
        timer = setTimeout(() => {
          execution.timedOut = true;
          controller.abort();
          this.update(item.spec.id, "cancelling", { error: normalizeSimpleError(new Error(`operation timed out; waiting for the underlying work to settle: ${item.spec.id}`)) });
        }, item.spec.timeoutMs);
        timer.unref?.();
      }
      const operation = item.spec.run(controller.signal);
      await operation;
      const finishedAt = new Date().toISOString();
      if (execution.timedOut) {
        const error = new Error(`operation timed out after the underlying work settled: ${item.spec.id}`);
        this.update(item.spec.id, "timeout", { finishedAt, error: normalizeSimpleError(error) });
        item.reject(error);
      } else {
        this.update(item.spec.id, execution.cancelled ? "cancelled" : "succeeded", { finishedAt });
        item.resolve();
      }
    } catch (error) {
      const status: OperationStatus = execution.timedOut ? "timeout" : execution.cancelled ? "cancelled" : "failed";
      const patch: Partial<QueuedOperationRecord> = { finishedAt: new Date().toISOString() };
      if (status !== "cancelled") patch.error = normalizeSimpleError(error);
      this.update(item.spec.id, status, patch);
      item.reject(error);
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(item.spec.id);
      this.removeActiveExclusiveKeys(item.spec);
      this.pump();
    }
  }

  private record(spec: OperationSpec, status: OperationStatus): void {
    const record: QueuedOperationRecord = {
      id: spec.id,
      type: spec.type,
      priority: spec.priority,
      status,
      targetServers: spec.targetServers || [],
      targetKeys: spec.targetKeys || [],
      exclusiveKeys: spec.exclusiveKeys || [],
    };
    this.records.push(record);
    this.latestRecordById.set(record.id, record);
    this.trimRecords();
  }

  private update(id: string, status: OperationStatus, patch: Partial<QueuedOperationRecord> = {}): void {
    const current = this.latestRecordById.get(id);
    if (current) Object.assign(current, patch, { status });
    this.trimRecords();
  }

  private addActiveExclusiveKeys(spec: OperationSpec): void {
    for (const key of spec.exclusiveKeys || []) {
      this.activeExclusiveKeyCounts.set(key, (this.activeExclusiveKeyCounts.get(key) || 0) + 1);
    }
  }

  private removeActiveExclusiveKeys(spec: OperationSpec): void {
    for (const key of spec.exclusiveKeys || []) {
      const next = (this.activeExclusiveKeyCounts.get(key) || 0) - 1;
      if (next > 0) this.activeExclusiveKeyCounts.set(key, next);
      else this.activeExclusiveKeyCounts.delete(key);
    }
  }

  private trimRecords(): void {
    let excess = this.records.length - this.historyLimit;
    if (excess <= 0) return;
    const remapIds = new Set<string>();
    this.records = this.records.filter((record) => {
      if (excess > 0 && terminalStatuses.has(record.status)) {
        excess -= 1;
        if (this.latestRecordById.get(record.id) === record) {
          this.latestRecordById.delete(record.id);
          remapIds.add(record.id);
        }
        return false;
      }
      return true;
    });
    for (const id of remapIds) {
      for (let index = this.records.length - 1; index >= 0; index -= 1) {
        if (this.records[index].id !== id) continue;
        this.latestRecordById.set(id, this.records[index]);
        break;
      }
    }
  }
}
