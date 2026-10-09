import { ClusterStoreState } from "../state/StateReducer";
import { selectUiState } from "../state/StateSelectors";

export function mapClusterStoreToWebview(state: ClusterStoreState): Record<string, unknown> {
  return selectUiState(state);
}

export function redactForDebugBundle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDebugBundle);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (lower.includes("passphrase") || lower.includes("password") || lower.includes("token")) {
      out[key] = "<redacted>";
    } else if (lower.includes("identityfile") || lower.includes("privatekey")) {
      const text = String(raw || "");
      out[key] = text ? text.replace(/\\/g, "/").split("/").pop() : "";
    } else {
      out[key] = redactForDebugBundle(raw);
    }
  }
  return out;
}

