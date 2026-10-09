export interface SelfCheckItem {
  id: string;
  scope: "local" | "hub" | "worker" | "scheduler" | "sync";
  serverId?: string;
  status: "ok" | "warning" | "failed" | "skipped";
  message: string;
  detail?: string;
  suggestion?: string;
}

export interface SelfCheckResult {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  overall: "ok" | "warning" | "failed";
  checks: SelfCheckItem[];
}

export function summarizeSelfCheck(checks: SelfCheckItem[], startedAt = new Date().toISOString(), finishedAt = new Date().toISOString()): SelfCheckResult {
  const overall = checks.some((item) => item.status === "failed")
    ? "failed"
    : checks.some((item) => item.status === "warning")
      ? "warning"
      : "ok";
  return { schemaVersion: 1, startedAt, finishedAt, overall, checks };
}

export function selfCheckText(result: SelfCheckResult): string {
  return [
    `overall=${result.overall}`,
    ...result.checks.map((item) => `[${item.status}] ${item.scope}${item.serverId ? `:${item.serverId}` : ""} ${item.id} - ${item.message}${item.suggestion ? ` (${item.suggestion})` : ""}`),
  ].join("\n");
}

