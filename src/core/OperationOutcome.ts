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
