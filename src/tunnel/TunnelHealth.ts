export type TunnelHealthState =
  | "unknown"
  | "not_configured"
  | "xshell_not_found"
  | "local_port_closed"
  | "agent_unreachable"
  | "agent_ok"
  | "stream_connected"
  | "stream_stale"
  | "file_api_unavailable"
  | "stale"
  | "paused"
  | "rate_limited";

export interface TunnelHealth {
  state: TunnelHealthState;
  status?: TunnelHealthState;
  localForwardPort?: number;
  remoteAgentPort?: number;
  latencyMs?: number;
  agentVersion?: string;
  startedAt?: string;
  serverTime?: string;
  snapshotAge?: number;
  workerCount?: number;
  lastHeartbeatAt?: string;
  lastSeq?: number;
  fileApiOk?: boolean;
  checkedAt: string;
  message?: string;
}

export function classifyTunnelHealth(input: {
  configured: boolean;
  paused?: boolean;
  rateLimited?: boolean;
  response?: Partial<TunnelHealth>;
  error?: unknown;
  staleAfterSeconds?: number;
}): TunnelHealth {
  const checkedAt = new Date().toISOString();
  if (!input.configured) return { state: "not_configured", status: "not_configured", checkedAt, message: "Tunnel is not configured." };
  if (input.paused) return { state: "paused", status: "paused", checkedAt, message: "Network activity paused." };
  if (input.rateLimited) return { state: "rate_limited", status: "rate_limited", checkedAt, message: "Request budget limit reached." };
  if (input.error) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const localClosed = /ECONNREFUSED|fetch failed|connection refused|closed|AbortError/i.test(message);
    const state = localClosed ? "local_port_closed" : "agent_unreachable";
    return { state, status: state, checkedAt, message };
  }
  const snapshotAge = Number(input.response?.snapshotAge ?? 0);
  const staleAfterSeconds = input.staleAfterSeconds ?? 300;
  const state = snapshotAge > staleAfterSeconds ? "stale" : (input.response?.state || input.response?.status || "agent_ok");
  return {
    state,
    status: state,
    checkedAt,
    ...input.response,
    snapshotAge,
  };
}
