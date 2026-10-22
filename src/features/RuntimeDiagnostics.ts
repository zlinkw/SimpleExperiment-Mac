/** Execution, artifact completeness and log evidence are independent dimensions. */
export type RuntimeDiagnostics = {
  schemaVersion: 1; commandId: string; runId: string;
  state: "clear" | "anomalous" | "unverified" | "scanning";
  count: number; scanComplete: boolean; logPath?: string; bytesRead?: number; totalBytes?: number;
  truncatedExceptions?: number;
  types?: Record<string, number>; phases?: Record<string, number>; reason?: string;
  exceptions?: Array<{ id: string; type: string; phase: string; summary: string; logPath: string;
    byteStart: number; byteEnd: number; lineStart?: number; lineEnd?: number; complete: boolean }>;
};
export type CompletionState = "verified" | "review_required" | "unverified";

export function runtimeEvidence(value: unknown, commandId: string): RuntimeDiagnostics {
  const row = value as RuntimeDiagnostics | undefined;
  if (!commandId || row?.schemaVersion !== 1 || row.commandId !== commandId || row.runId !== commandId
    || !Number.isSafeInteger(row.count) || row.count < 0
    || !["clear", "anomalous", "unverified", "scanning"].includes(row.state)
    || row.state === "clear" && (!row.scanComplete || row.count !== 0))
    return { schemaVersion: 1, commandId, runId: commandId, state: "unverified", count: 0,
      scanComplete: false, reason: "尚无本次执行的完整日志分析证据" };
  return row;
}

export function completionState(value: unknown, commandId: string): CompletionState {
  const evidence = runtimeEvidence(value, commandId);
  return evidence.count > 0 || evidence.state === "anomalous" ? "review_required"
    : evidence.state === "clear" && evidence.scanComplete ? "verified" : "unverified";
}

export function completionLabel(value: unknown, commandId: string): string {
  return { verified: "已完成", review_required: "完成但有异常，待复核", unverified: "产物完整，运行日志待核实" }[completionState(value, commandId)];
}
