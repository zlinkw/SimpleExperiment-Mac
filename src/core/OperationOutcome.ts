export type OperationOutcomeCategory =
  | "succeeded"
  | "failed"
  | "user_cancelled"
  | "replaced"
  | "configuration_error"
  | "conflict"
  | "remote_unknown";

export type OperationOutcomeCertainty = "not_started" | "settled" | "unknown";

export type OperationOutcome = {
  code: string;
  category: OperationOutcomeCategory;
  retryable: boolean;
  certainty: OperationOutcomeCertainty;
};

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

export function operationOutcomeFor(error?: unknown, status?: unknown): OperationOutcome {
  const row = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const name = String(row.name || "");
  const code = String(row.code || "").trim().toUpperCase();
  const state = String(status || "").trim().toLowerCase();

  if (!error && ["completed", "success", "succeeded"].includes(state))
    return { code: "OPERATION_SUCCEEDED", category: "succeeded", retryable: false, certainty: "settled" };
  if (name === "HostOperationLeaseConflictError" || code === "RESOURCE_CONFLICT")
    return { code: "RESOURCE_CONFLICT", category: "conflict", retryable: true, certainty: "not_started" };
  // 配套 SimpleSFTP 自身仍有未完成传输/上传时，会在核对任何目标路径之前整体拒绝清理预览（ACTIVE_TRANSFER），
  // 隔离与提交都没有开始；这是可稍后重试的冲突，不能归为 PLAN 失败或不可重试。
  // 仅批次码可证明“全部 job 在核对任何路径前被拒、本轮未移动未提交”，才给 not_started 可重试。
  // 裸 ACTIVE_TRANSFER 可能发生在上传/隔离/部分任务提交之后（嵌套拒绝），那里不保证零副作用，
  // 保持默认 failed/unknown，不得升级为可自动重放；withSafeTransferRetry 也不消费本结论（仅按 command+target 单飞）。
  const apiCode = String((row.apiData && (row.apiData as Record<string, unknown>).code) || "").trim().toUpperCase();
  if (code === "RUN_OUTPUTS_TRANSFER_BUSY" || apiCode === "RUN_OUTPUTS_TRANSFER_BUSY")
    return { code: "RUN_OUTPUTS_TRANSFER_BUSY", category: "conflict", retryable: true, certainty: "not_started" };
  if (name === "RequestReplacedError" || code === "REQUEST_REPLACED")
    return { code: "REQUEST_REPLACED", category: "replaced", retryable: true, certainty: row.outcomeCertain === true ? "settled" : "unknown" };
  if (name === "UiCommandRemotePending" || row.remotePending === true || row.outcomeUnknown === true || state === "submitted")
    return { code: "REMOTE_OUTCOME_UNKNOWN", category: "remote_unknown", retryable: false, certainty: "unknown" };
  if (name === "UiCommandCancelled" || name === "AbortError" || state === "cancelled")
    return { code: "USER_CANCELLED", category: "user_cancelled", retryable: false, certainty: row.remoteSettled === true ? "settled" : "unknown" };
  if (name === "ConfigurationError" || name === "TunnelConfigurationError" || code.startsWith("CONFIG_"))
    return { code: code.startsWith("CONFIG_") ? code : "CONFIGURATION_INVALID", category: "configuration_error", retryable: false, certainty: "not_started" };
  if (NETWORK_ERROR_CODES.has(code) || ["TypeError", "TimeoutError"].includes(name))
    return { code: "COMMUNICATION_OUTCOME_UNKNOWN", category: "remote_unknown", retryable: false, certainty: "unknown" };
  return { code: code && /^[A-Z0-9_:-]{1,64}$/.test(code) ? code : "OPERATION_FAILED", category: "failed", retryable: false,
    certainty: row.remoteSettled === true ? "settled" : row.sideEffectStarted === false ? "not_started" : "unknown" };
}

export function normalizeOperationOutcome(value: unknown): OperationOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const categories: OperationOutcomeCategory[] = ["succeeded", "failed", "user_cancelled", "replaced", "configuration_error", "conflict", "remote_unknown"];
  const certainty: OperationOutcomeCertainty[] = ["not_started", "settled", "unknown"];
  if (!categories.includes(row.category as OperationOutcomeCategory) || !certainty.includes(row.certainty as OperationOutcomeCertainty)) return undefined;
  const code = String(row.code || "").trim();
  if (!/^[A-Z0-9_:-]{1,64}$/.test(code)) return undefined;
  return { code, category: row.category as OperationOutcomeCategory, retryable: row.retryable === true, certainty: row.certainty as OperationOutcomeCertainty };
}
