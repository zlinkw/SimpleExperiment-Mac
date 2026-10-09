export type SimpleErrorCode =
  | "TUNNEL_TIMEOUT"
  | "TUNNEL_UNAUTHORIZED"
  | "TUNNEL_UNAVAILABLE"
  | "AGENT_STALE"
  | "AGENT_INCOMPATIBLE"
  | "WORKER_OFFLINE"
  | "RUNTIME_DEPLOY_FAILED"
  | "STATE_SCHEMA_INVALID"
  | "SYNC_PARTIAL_FAILURE"
  | "ARTIFACT_RESIDUE"
  | "UNKNOWN";

export interface SimpleError {
  code: SimpleErrorCode;
  message: string;
  detail?: string;
  serverId?: string;
  retryable?: boolean;
  suggestion?: string;
  cause?: unknown;
}

export function simpleError(input: Partial<SimpleError> & { message: string }): SimpleError {
  return {
    code: input.code || "UNKNOWN",
    message: input.message,
    detail: input.detail,
    serverId: input.serverId,
    retryable: input.retryable,
    suggestion: input.suggestion,
    cause: input.cause,
  };
}

export function normalizeSimpleError(error: unknown, fallback = "操作失败"): SimpleError {
  if (isSimpleError(error)) return error;
  const text = error instanceof Error ? error.message : String(error || fallback);
  const lower = text.toLowerCase();
  if (lower.includes("timeout")) {
    return simpleError({ code: "TUNNEL_TIMEOUT", message: "本地隧道超时", detail: text, retryable: true, suggestion: "检查 Xshell 本地隧道和 Hub Agent。" });
  }
  if (lower.includes("unauthorized") || lower.includes("auth")) {
    return simpleError({ code: "TUNNEL_UNAUTHORIZED", message: "Hub Agent token 校验失败", detail: text, retryable: false, suggestion: "检查 token 配置。" });
  }
  if (lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return simpleError({ code: "TUNNEL_UNAVAILABLE", message: "本地隧道不可用", detail: text, retryable: true, suggestion: "启动 Xshell 本地隧道或切换 offline_import。" });
  }
  if (lower.includes("agent incompatible")) {
    return simpleError({ code: "AGENT_INCOMPATIBLE", message: "Agent 协议不兼容", detail: text, retryable: true, suggestion: "更新 Hub Agent。" });
  }
  return simpleError({ code: "UNKNOWN", message: fallback, detail: text, retryable: true });
}

export function isSimpleError(value: unknown): value is SimpleError {
  const item = value as SimpleError;
  return Boolean(item && typeof item.code === "string" && typeof item.message === "string");
}

export function userErrorMessage(error: unknown): string {
  const normalized = normalizeSimpleError(error);
  return normalized.suggestion ? `${normalized.message}：${normalized.suggestion}` : normalized.message;
}
