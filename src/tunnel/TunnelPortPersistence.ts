import { TunnelEndpointPortAssignment } from "./TunnelPortConflict";

export interface TunnelPortMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export const tunnelPortAssignmentsKey = "simpleExperimentMac.tunnel.portAssignments";

export class TunnelPortPersistence {
  constructor(
    private readonly store: TunnelPortMemento,
    private readonly key = tunnelPortAssignmentsKey,
  ) {}

  load(): TunnelEndpointPortAssignment[] {
    const value = this.store.get<TunnelEndpointPortAssignment[]>(this.key);
    return Array.isArray(value) ? value.filter(isAssignment) : [];
  }

  async save(assignments: TunnelEndpointPortAssignment[]): Promise<void> {
    await this.store.update(this.key, assignments.filter(isAssignment));
  }
}

export function mergePersistedAssignments(
  current: TunnelEndpointPortAssignment[],
  persisted: TunnelEndpointPortAssignment[],
): TunnelEndpointPortAssignment[] {
  const map = new Map(persisted.map((assignment) => [assignment.endpointId, assignment]));
  for (const assignment of current) {
    map.set(assignment.endpointId, { ...(map.get(assignment.endpointId) || {}), ...assignment });
  }
  return [...map.values()];
}

function isAssignment(value: unknown): value is TunnelEndpointPortAssignment {
  const item = value as Partial<TunnelEndpointPortAssignment>;
  return Boolean(
    item &&
    item.endpointId &&
    (item.role === "hub_control" || item.role === "worker_telemetry") &&
    typeof item.localForwardHost === "string" && Boolean(item.localForwardHost.trim()) &&
    Number.isInteger(item.localForwardPort) &&
    typeof item.remoteBindHost === "string" && Boolean(item.remoteBindHost.trim()) &&
    Number.isInteger(item.remoteServicePort),
  );
}
