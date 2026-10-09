export interface ClusterProfile {
  id: string;
  name: string;
  projectRoot: string;
  servers: unknown[];
  artifactHub?: string;
  settings: Record<string, unknown>;
}

export interface DiagnosticsState {
  updatedAt?: string;
  errors?: unknown[];
  warnings?: unknown[];
  runtime?: unknown;
  agent?: unknown;
}

export interface AgentRuntimeState {
  status?: "streaming" | "stale" | "restarting" | "offline" | "degraded";
  lastSeq?: number;
  lastEventAt?: string;
  detail?: string;
}
