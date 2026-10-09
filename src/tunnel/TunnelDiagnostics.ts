import { RequestBudgetSnapshot } from "./RequestBudget";

export interface TunnelDiagnostics {
  connectionMode: "xshell_tunnel_realtime" | "offline_import";
  localEndpoint: string;
  directAccessDisabled: true;
  requests: RequestBudgetSnapshot;
  lastHealth?: unknown;
  lastSnapshotAt?: string;
  lastError?: string;
}

export function redactTunnelDiagnostics<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|nonce|authorization|password|passphrase/i.test(key)) out[key] = "<redacted>";
    else if (/privateKeyPath/i.test(key)) out[key] = basename(String(item));
    else out[key] = redact(item);
  }
  return out;
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() || value;
}
