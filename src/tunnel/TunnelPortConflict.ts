export type TunnelEndpointRole = "hub_control" | "worker_telemetry";

export type TunnelPortConflictType =
  | "duplicate_in_config"
  | "occupied_by_existing_tunnel"
  | "occupied_by_unknown_process"
  | "invalid_port"
  | "reserved_for_hub"
  | "outside_allowed_range";

export interface TunnelPortRange {
  start: number;
  end: number;
}

export interface TunnelPortConflict {
  endpointId: string;
  requestedPort: number;
  conflictType: TunnelPortConflictType;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion: string;
}

export interface TunnelEndpointPortAssignment {
  endpointId: string;
  role: TunnelEndpointRole;
  displayName?: string;
  remoteHostLabel: string;
  sshConfigAlias?: string;
  localForwardHost: string;
  localForwardPort: number;
  remoteBindHost: string;
  remoteServicePort: number;
  assignedAt: string;
  source: "manual" | "auto" | "imported";
}

export const defaultTunnelPorts = {
  hubLocalPort: 18765,
  workerLocalPortRange: { start: 18766, end: 18999 } satisfies TunnelPortRange,
  defaultHubAgentPort: 18765,
  defaultWorkerTelemetryPort: 18765,
} as const;

export function isValidTunnelPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function isPortInRange(port: number, range: TunnelPortRange): boolean {
  return isValidTunnelPort(port) && port >= range.start && port <= range.end;
}

export function normalizePortRange(input: Partial<TunnelPortRange> | undefined, fallback: TunnelPortRange = defaultTunnelPorts.workerLocalPortRange): TunnelPortRange {
  const start = Number(input?.start);
  const end = Number(input?.end);
  if (!isValidTunnelPort(start) || !isValidTunnelPort(end) || start > end) return { ...fallback };
  return { start, end };
}

export function makeTunnelPortConflict(
  endpointId: string,
  requestedPort: number,
  conflictType: TunnelPortConflictType,
  severity: TunnelPortConflict["severity"],
  message: string,
  suggestion: string,
): TunnelPortConflict {
  return { endpointId, requestedPort, conflictType, severity, message, suggestion };
}
