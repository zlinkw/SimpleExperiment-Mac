import {
  defaultTunnelPorts,
  isPortInRange,
  isValidTunnelPort,
  makeTunnelPortConflict,
  normalizePortRange,
  TunnelEndpointPortAssignment,
  TunnelPortConflict,
  TunnelPortRange,
} from "./TunnelPortConflict";

export interface PortAllocationRequest {
  hub: {
    id: "hub";
    displayName?: string;
    sshConfigAlias?: string;
    host: string;
    localForwardHost?: string;
    remoteBindHost?: string;
    requestedLocalPort?: number;
    remoteAgentPort: number;
  };
  workers: Array<{
    id: string;
    displayName?: string;
    sshConfigAlias?: string;
    host: string;
    localForwardHost?: string;
    remoteBindHost?: string;
    requestedLocalPort?: number;
    remoteTelemetryPort?: number;
    enabled: boolean;
  }>;
  portRange: TunnelPortRange;
  preserveExistingAssignments: boolean;
  existingAssignments?: TunnelEndpointPortAssignment[];
}

export type PortOccupancy =
  | "available"
  | "current_tunnel"
  | "existing_tunnel"
  | "unknown_process";

export type TunnelPortProbe = (port: number, endpointId: string, localForwardHost?: string) => Promise<PortOccupancy> | PortOccupancy;

export interface PortAllocationResult {
  ok: boolean;
  assignments: TunnelEndpointPortAssignment[];
  conflicts: TunnelPortConflict[];
  warnings: string[];
}

export async function allocateTunnelPorts(
  request: PortAllocationRequest,
  probe: TunnelPortProbe = () => "available",
  now = new Date().toISOString(),
): Promise<PortAllocationResult> {
  const range = normalizePortRange(request.portRange, defaultTunnelPorts.workerLocalPortRange);
  const existing = new Map((request.existingAssignments || []).map((item) => [item.endpointId, item]));
  const conflicts: TunnelPortConflict[] = [];
  const warnings: string[] = [];
  const used = new Map<number, string>();
  const assignments: TunnelEndpointPortAssignment[] = [];

  const hubRequested = request.hub.requestedLocalPort || existing.get("hub")?.localForwardPort || defaultTunnelPorts.hubLocalPort;
  const hubPort = await reservePort({
    endpointId: "hub",
    requestedPort: hubRequested,
    role: "hub_control",
    range,
    used,
    conflicts,
    probe,
    autoStart: defaultTunnelPorts.hubLocalPort,
    source: request.hub.requestedLocalPort ? "manual" : existing.get("hub") ? "imported" : "auto",
    allowOutsideWorkerRange: true,
    localForwardHost: request.hub.localForwardHost || existing.get("hub")?.localForwardHost || "127.0.0.1",
  });
  assignments.push({
    endpointId: "hub",
    role: "hub_control",
    displayName: request.hub.displayName,
    remoteHostLabel: request.hub.host,
    sshConfigAlias: request.hub.sshConfigAlias,
    localForwardHost: request.hub.localForwardHost || existing.get("hub")?.localForwardHost || "127.0.0.1",
    localForwardPort: hubPort,
    remoteBindHost: request.hub.remoteBindHost || existing.get("hub")?.remoteBindHost || "127.0.0.1",
    remoteServicePort: normalizeServicePort(request.hub.remoteAgentPort, defaultTunnelPorts.defaultHubAgentPort),
    assignedAt: existing.get("hub")?.assignedAt || now,
    source: request.hub.requestedLocalPort ? "manual" : existing.get("hub")?.source || "auto",
  });

  let nextWorkerPort = Math.max(range.start, hubPort + 1, defaultTunnelPorts.workerLocalPortRange.start);
  for (const worker of request.workers) {
    const previous = existing.get(worker.id);
    const requested = request.preserveExistingAssignments && previous?.localForwardPort
      ? previous.localForwardPort
      : worker.requestedLocalPort;
    const candidate = requested || nextWorkerPort;
    const assigned = await reservePort({
      endpointId: worker.id,
      requestedPort: candidate,
      role: "worker_telemetry",
      range,
      used,
      conflicts,
      probe,
      autoStart: nextWorkerPort,
      source: requested ? "manual" : previous ? "imported" : "auto",
      allowOutsideWorkerRange: false,
      localForwardHost: worker.localForwardHost || previous?.localForwardHost || "127.0.0.1",
      enabled: worker.enabled,
    });
    if (assigned === defaultTunnelPorts.hubLocalPort && worker.enabled) {
      conflicts.push(makeTunnelPortConflict(
        worker.id,
        assigned,
        "reserved_for_hub",
        "error",
        `Worker ${worker.id} requested reserved Hub local port ${assigned}.`,
        "Use Repair Port Conflicts or choose a Worker port in the worker range.",
      ));
    }
    assignments.push({
      endpointId: worker.id,
      role: "worker_telemetry",
      displayName: worker.displayName,
      remoteHostLabel: worker.host,
      sshConfigAlias: worker.sshConfigAlias,
      localForwardHost: worker.localForwardHost || previous?.localForwardHost || "127.0.0.1",
      localForwardPort: assigned,
      remoteBindHost: worker.remoteBindHost || previous?.remoteBindHost || "127.0.0.1",
      remoteServicePort: normalizeServicePort(worker.remoteTelemetryPort, defaultTunnelPorts.defaultWorkerTelemetryPort),
      assignedAt: previous?.assignedAt || now,
      source: requested ? "manual" : previous?.source || "auto",
    });
    nextWorkerPort = Math.max(nextWorkerPort, assigned + 1);
  }

  const enabledAssignments = assignments.filter((item) => item.role === "hub_control" || request.workers.find((worker) => worker.id === item.endpointId)?.enabled !== false);
  const uniquePorts = new Set(enabledAssignments.map((item) => item.localForwardPort));
  if (uniquePorts.size !== enabledAssignments.length) {
    warnings.push("Local tunnel ports were de-duplicated; review the assignment table.");
  }
  return {
    ok: !conflicts.some((conflict) => conflict.severity === "error"),
    assignments,
    conflicts,
    warnings,
  };
}

export function allocationRequestFromAssignments(assignments: TunnelEndpointPortAssignment[]): PortAllocationRequest {
  const hub = assignments.find((item) => item.role === "hub_control");
  const workers = assignments.filter((item) => item.role === "worker_telemetry");
  return {
    hub: {
      id: "hub",
      displayName: hub?.displayName,
      sshConfigAlias: hub?.sshConfigAlias,
      host: hub?.remoteHostLabel || "hub",
      localForwardHost: hub?.localForwardHost,
      remoteBindHost: hub?.remoteBindHost,
      requestedLocalPort: hub?.localForwardPort,
      remoteAgentPort: hub?.remoteServicePort || defaultTunnelPorts.defaultHubAgentPort,
    },
    workers: workers.map((worker) => ({
      id: worker.endpointId,
      displayName: worker.displayName,
      sshConfigAlias: worker.sshConfigAlias,
      host: worker.remoteHostLabel,
      localForwardHost: worker.localForwardHost,
      remoteBindHost: worker.remoteBindHost,
      requestedLocalPort: worker.localForwardPort,
      remoteTelemetryPort: worker.remoteServicePort,
      enabled: true,
    })),
    portRange: defaultTunnelPorts.workerLocalPortRange,
    preserveExistingAssignments: true,
    existingAssignments: assignments,
  };
}

export function detectStaticTunnelPortConflicts(
  assignments: TunnelEndpointPortAssignment[],
  range: TunnelPortRange = defaultTunnelPorts.workerLocalPortRange,
): TunnelPortConflict[] {
  const conflicts: TunnelPortConflict[] = [];
  const seen = new Map<number, string>();
  const hubLocalPorts = new Set(assignments
    .filter((assignment) => assignment.role === "hub_control")
    .map((assignment) => assignment.localForwardPort));
  for (const assignment of assignments) {
    const port = assignment.localForwardPort;
    if (!isValidTunnelPort(port)) {
      conflicts.push(makeTunnelPortConflict(
        assignment.endpointId,
        port,
        "invalid_port",
        "error",
        `Endpoint ${assignment.endpointId} has invalid local port ${port}.`,
        "Use a local port between 1024 and 65535.",
      ));
      continue;
    }
    if (assignment.role === "worker_telemetry") {
      const usesReleasedHubPort = hubLocalPorts.size === 0 && port === defaultTunnelPorts.hubLocalPort;
      if (hubLocalPorts.has(port)) {
        conflicts.push(makeTunnelPortConflict(
          assignment.endpointId,
          port,
          "reserved_for_hub",
          "error",
          `Worker ${assignment.endpointId} uses the active Hub local port ${port}.`,
          "Use Repair Port Conflicts.",
        ));
      }
      if (!usesReleasedHubPort && !isPortInRange(port, range)) {
        conflicts.push(makeTunnelPortConflict(
          assignment.endpointId,
          port,
          "outside_allowed_range",
          "warning",
          `Worker ${assignment.endpointId} local port ${port} is outside ${range.start}-${range.end}.`,
          "Expand the Worker local port range or repair assignments.",
        ));
      }
    }
    const owner = seen.get(port);
    if (owner) {
      conflicts.push(makeTunnelPortConflict(
        assignment.endpointId,
        port,
        "duplicate_in_config",
        "error",
        `Endpoint ${assignment.endpointId} duplicates local port ${port} used by ${owner}.`,
        "Use Repair Port Conflicts.",
      ));
    }
    seen.set(port, assignment.endpointId);
  }
  return conflicts;
}

async function reservePort(options: {
  endpointId: string;
  requestedPort: number;
  role: "hub_control" | "worker_telemetry";
  range: TunnelPortRange;
  used: Map<number, string>;
  conflicts: TunnelPortConflict[];
  probe: TunnelPortProbe;
  autoStart: number;
  source: TunnelEndpointPortAssignment["source"];
  allowOutsideWorkerRange: boolean;
  enabled?: boolean;
  localForwardHost?: string;
}): Promise<number> {
  const enabled = options.enabled !== false;
  let requested = Math.floor(Number(options.requestedPort));
  if (!isValidTunnelPort(requested)) {
    if (enabled) {
      options.conflicts.push(makeTunnelPortConflict(
        options.endpointId,
        requested,
        "invalid_port",
        "error",
        `Endpoint ${options.endpointId} has invalid local port ${requested}.`,
        "Use a local port between 1024 and 65535.",
      ));
    }
    requested = options.autoStart;
  }
  if (options.role === "worker_telemetry" && !options.allowOutsideWorkerRange && !isPortInRange(requested, options.range)) {
    if (enabled) {
      options.conflicts.push(makeTunnelPortConflict(
        options.endpointId,
        requested,
        "outside_allowed_range",
        "warning",
        `Worker ${options.endpointId} local port ${requested} is outside ${options.range.start}-${options.range.end}.`,
        "Use Configure Tunnel Ports or expand the Worker local port range.",
      ));
    }
    requested = options.autoStart;
  }
  if (options.role === "worker_telemetry" && requested === defaultTunnelPorts.hubLocalPort && enabled) {
    options.conflicts.push(makeTunnelPortConflict(
      options.endpointId,
      requested,
      "reserved_for_hub",
      "error",
      `Worker ${options.endpointId} requested Hub reserved port ${requested}.`,
      "Assign this Worker a port from 18766 upward.",
    ));
    requested = options.autoStart;
  }
  if (options.used.has(requested) && enabled) {
    options.conflicts.push(makeTunnelPortConflict(
      options.endpointId,
      requested,
      "duplicate_in_config",
      "error",
      `Endpoint ${options.endpointId} duplicates local port ${requested} used by ${options.used.get(requested)}.`,
      "Use Repair Port Conflicts to assign a unique local port.",
    ));
    requested = options.autoStart;
  }

  let selected = requested;
  while (options.used.has(selected) || !isValidCandidate(selected, options.role, options.range, options.allowOutsideWorkerRange)) {
    selected += 1;
  }
  for (;;) {
    const bindHost = String(options.localForwardHost || "127.0.0.1").trim() || "127.0.0.1";
    const occupancy = enabled ? await options.probe(selected, options.endpointId, bindHost) : "available";
    if (occupancy === "available" || occupancy === "current_tunnel") break;
    options.conflicts.push(makeTunnelPortConflict(
      options.endpointId,
      selected,
      occupancy === "existing_tunnel" ? "occupied_by_existing_tunnel" : "occupied_by_unknown_process",
      occupancy === "existing_tunnel" ? "warning" : "error",
      `${bindHost}:${selected} is occupied by ${occupancy === "existing_tunnel" ? "another tunnel" : "an unknown process"}.`,
      "Use Repair Port Conflicts or stop the process using that port.",
    ));
    selected += 1;
    while (options.used.has(selected) || !isValidCandidate(selected, options.role, options.range, options.allowOutsideWorkerRange)) selected += 1;
    if (selected > 65535) throw new Error("No available local tunnel port.");
  }
  options.used.set(selected, options.endpointId);
  return selected;
}

function isValidCandidate(port: number, role: "hub_control" | "worker_telemetry", range: TunnelPortRange, allowOutsideWorkerRange: boolean): boolean {
  if (!isValidTunnelPort(port)) return false;
  if (role === "worker_telemetry" && !allowOutsideWorkerRange) return true;
  return true;
}

function normalizeServicePort(value: unknown, fallback: number): number {
  const port = Number(value);
  return isValidTunnelPort(port) ? port : fallback;
}
