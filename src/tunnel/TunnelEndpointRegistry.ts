import { XshellRealtimeTunnelConfig, XshellWorkerTunnelConfig } from "./XshellTunnelSetup";
import { defaultTunnelPorts, TunnelEndpointPortAssignment, TunnelEndpointRole } from "./TunnelPortConflict";

export interface ClusterTunnelEndpoint {
  id: string;
  role: TunnelEndpointRole;
  displayName: string;
  ssh: {
    host: string;
    user: string;
    port: number;
    sshConfigAlias?: string;
    privateKeyPath?: string;
    xshellSessionName?: string;
    savedSessionRunner?: "xshell";
    savedSessionPath?: string;
    authMethod?: "password" | "key" | "auto";
  };
  tunnel: {
    localHost: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
  };
  api: {
    mode: TunnelEndpointRole;
    expectedCapabilities: string[];
  };
  enabled: boolean;
  lastProbe?: unknown;
  lastConnectedAt?: string;
  lastError?: string;
}

export interface TunnelEndpointRegistry {
  endpoints: ClusterTunnelEndpoint[];
  hub?: ClusterTunnelEndpoint;
  workers: ClusterTunnelEndpoint[];
}

export function buildTunnelEndpointRegistry(
  config: XshellRealtimeTunnelConfig,
  probes: Record<string, unknown> = {},
): TunnelEndpointRegistry {
  const assignments = new Map((config.ports?.assignments || []).map((assignment) => [assignment.endpointId, assignment]));
  const hubAssignment = assignments.get("hub");
  const hub: ClusterTunnelEndpoint = {
    id: "hub",
    role: "hub_control",
    displayName: config.sshConfigAlias || config.hubHost || "Hub",
    ssh: {
      host: config.hubHost,
      user: config.hubUser,
      port: config.hubSshPort,
      sshConfigAlias: config.sshConfigAlias,
      privateKeyPath: config.privateKeyPath,
    },
    tunnel: {
      localHost: hubAssignment?.localForwardHost || config.localForwardHost,
      localPort: hubAssignment?.localForwardPort || config.localForwardPort || defaultTunnelPorts.hubLocalPort,
      remoteHost: hubAssignment?.remoteBindHost || config.remoteAgentHost,
      remotePort: hubAssignment?.remoteServicePort || config.remoteAgentPort || defaultTunnelPorts.defaultHubAgentPort,
    },
    api: {
      mode: "hub_control",
      expectedCapabilities: [
        "endpoints.actions",
        "endpoints.fileList",
        "endpoints.fileDownload",
        "endpoints.fileUploadChunk",
        "endpoints.scheduler",
        "endpoints.traces",
        "endpoints.resultsSummary",
      ],
    },
    enabled: true,
    lastProbe: probes.hub,
  };
  const workers = config.workerTunnels.map((worker) => workerEndpoint(worker, assignments.get(worker.id), probes[worker.id]));
  return {
    endpoints: [hub, ...workers],
    hub,
    workers,
  };
}

export function endpointAssignmentsFromConfig(config: XshellRealtimeTunnelConfig): TunnelEndpointPortAssignment[] {
  const assignedAt = new Date(0).toISOString();
  const fallback: TunnelEndpointPortAssignment[] = [
    {
      endpointId: "hub",
      role: "hub_control",
      displayName: config.sshConfigAlias || config.hubHost || "Hub",
      remoteHostLabel: config.hubHost || config.sshConfigAlias || "hub",
      sshConfigAlias: config.sshConfigAlias,
      localForwardHost: config.localForwardHost,
      localForwardPort: config.localForwardPort || defaultTunnelPorts.hubLocalPort,
      remoteBindHost: config.remoteAgentHost,
      remoteServicePort: config.remoteAgentPort || defaultTunnelPorts.defaultHubAgentPort,
      assignedAt,
      source: "imported",
    },
    ...config.workerTunnels.map((worker) => ({
      endpointId: worker.id,
      role: "worker_telemetry" as const,
      displayName: worker.displayName,
      remoteHostLabel: worker.workerHost || worker.hubHost || worker.sshConfigAlias || worker.id,
      sshConfigAlias: worker.sshConfigAlias,
      localForwardHost: worker.localForwardHost,
      localForwardPort: worker.localForwardPort,
      remoteBindHost: worker.remoteAgentHost,
      remoteServicePort: worker.remoteTelemetryPort || worker.remoteAgentPort || defaultTunnelPorts.defaultWorkerTelemetryPort,
      assignedAt,
      source: "imported" as const,
    })),
  ];
  if (!config.ports?.assignments?.length) return fallback;
  const validIds = new Set(["hub", ...config.workerTunnels.map((worker) => worker.id)]);
  const byId = new Map(config.ports.assignments.filter((assignment) => validIds.has(assignment.endpointId)).map((assignment) => [assignment.endpointId, assignment]));
  return fallback.map((assignment) => {
    const existing = byId.get(assignment.endpointId);
    return existing ? { ...existing, ...assignment, assignedAt: existing.assignedAt, source: existing.source } : assignment;
  });
}

export function releaseEndpointAssignment(assignments: TunnelEndpointPortAssignment[], endpointId: string): TunnelEndpointPortAssignment[] {
  return assignments.filter((assignment) => assignment.endpointId !== endpointId);
}

function workerEndpoint(worker: XshellWorkerTunnelConfig, assignment: TunnelEndpointPortAssignment | undefined, probe: unknown): ClusterTunnelEndpoint {
  return {
    id: worker.id,
    role: "worker_telemetry",
    displayName: worker.displayName || worker.sshConfigAlias || worker.workerHost || worker.hubHost || worker.id,
    ssh: {
      host: worker.workerHost || worker.hubHost,
      user: worker.workerUser || worker.hubUser,
      port: worker.workerSshPort || worker.hubSshPort,
      sshConfigAlias: worker.sshConfigAlias,
      privateKeyPath: worker.privateKeyPath,
    },
    tunnel: {
      localHost: assignment?.localForwardHost || worker.localForwardHost,
      localPort: assignment?.localForwardPort || worker.localForwardPort,
      remoteHost: assignment?.remoteBindHost || worker.remoteAgentHost,
      remotePort: assignment?.remoteServicePort || worker.remoteTelemetryPort || worker.remoteAgentPort || defaultTunnelPorts.defaultWorkerTelemetryPort,
    },
    api: {
      mode: "worker_telemetry",
      expectedCapabilities: [
        "endpoints.health",
        "endpoints.gpu",
        "endpoints.workerTasks",
        "endpoints.sseEvents",
        "endpoints.liveOutput",
        "endpoints.diagnostics",
      ],
    },
    enabled: worker.enabled !== false,
    lastProbe: probe,
  };
}
