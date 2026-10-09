export type OperationKind =
  | "run_plan"
  | "scan_gpu"
  | "refresh_scheduler"
  | "refresh_traces"
  | "sync_worker_results"
  | "archive_complete"
  | "archive_delete"
  | "live_output";

export type OperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale_dropped";

export interface OperationRecord {
  opId: string;
  kind: OperationKind;
  scope: "manual" | "auto" | "background";
  targetKeys: string[];
  startedAt: number;
  finishedAt?: number;
  status: OperationStatus;
  error?: string;
  serverIds?: string[];
  seq?: number;
}

export interface DiagnosticErrorRecord {
  message: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export class OperationLedger {
  private readonly records: OperationRecord[] = [];
  private readonly errors = new Map<string, DiagnosticErrorRecord>();

  begin(kind: OperationKind, scope: OperationRecord["scope"], options: Partial<Pick<OperationRecord, "targetKeys" | "serverIds" | "seq">> = {}): OperationRecord {
    const record: OperationRecord = {
      opId: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      scope,
      targetKeys: options.targetKeys || [],
      serverIds: options.serverIds,
      seq: options.seq,
      startedAt: Date.now(),
      status: "running",
    };
    this.records.unshift(record);
    this.trim();
    return record;
  }

  finish(op: OperationRecord | undefined, status: OperationStatus, error?: string): void {
    if (!op) return;
    const record = this.records.find((item) => item.opId === op.opId) || op;
    record.status = status;
    record.finishedAt = Date.now();
    if (error) {
      record.error = error;
      this.noteError(error);
    }
  }

  stale(kind: OperationKind, scope: OperationRecord["scope"], seq?: number, targetKeys: string[] = []): void {
    const record = this.begin(kind, scope, { seq, targetKeys });
    this.finish(record, "stale_dropped");
  }

  noteError(message: string): void {
    const text = String(message || "").trim();
    if (!text) return;
    const now = Date.now();
    const prev = this.errors.get(text);
    if (prev) {
      prev.count += 1;
      prev.lastAt = now;
    } else {
      this.errors.set(text, { message: text, count: 1, firstAt: now, lastAt: now });
    }
    if (this.errors.size > 50) {
      const oldest = Array.from(this.errors.values()).sort((a, b) => a.lastAt - b.lastAt)[0];
      if (oldest) this.errors.delete(oldest.message);
    }
  }

  recent(limit = 20): OperationRecord[] {
    return this.records.slice(0, limit).map((item) => ({ ...item, targetKeys: [...item.targetKeys], serverIds: item.serverIds ? [...item.serverIds] : undefined }));
  }

  recentErrors(limit = 20): DiagnosticErrorRecord[] {
    return Array.from(this.errors.values()).sort((a, b) => b.lastAt - a.lastAt).slice(0, limit).map((item) => ({ ...item }));
  }

  private trim(): void {
    this.records.splice(100);
  }
}
