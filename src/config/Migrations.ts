export const CLUSTER_STATE_SCHEMA_VERSION = 2;

export interface Migration {
  from: number;
  to: number;
  name: string;
  migrate(state: any): any;
}

export interface MigrationResult {
  state: any;
  migrated: boolean;
  from: number;
  to: number;
  applied: string[];
}

export const migrations: Migration[] = [
  {
    from: 0,
    to: 1,
    name: "base schema",
    migrate: (state) => ({ ...(state || {}), schemaVersion: 1 }),
  },
  {
    from: 1,
    to: 2,
    name: "ssh agent defaults",
    migrate: (state) => ({
      ...state,
      schemaVersion: 2,
      agentEnabled: state?.agentEnabled !== false,
      agentStreamEnabled: state?.agentStreamEnabled !== false,
      allowOneShotForBackground: Boolean(state?.allowOneShotForBackground),
      allowDirectWorkerFallbackWhenAgentStale: Boolean(state?.allowDirectWorkerFallbackWhenAgentStale),
      agentPollSeconds: Number(state?.agentPollSeconds || 3),
      agentSnapshotTtlSeconds: Number(state?.agentSnapshotTtlSeconds || 15),
      agentHeartbeatTimeoutSeconds: Number(state?.agentHeartbeatTimeoutSeconds || 10),
      agentAllowWorkerProbe: state?.agentAllowWorkerProbe !== false,
      runtime: state?.runtime || {},
    }),
  },
];

export function migrateClusterState(input: any): MigrationResult {
  let state = input && typeof input === "object" ? { ...input } : {};
  const from = Number(state.schemaVersion || 0);
  let current = from;
  const applied: string[] = [];
  while (current < CLUSTER_STATE_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.from === current);
    if (!migration) throw new Error(`missing migration from ${current}`);
    state = migration.migrate(state);
    current = migration.to;
    applied.push(migration.name);
  }
  if (current > CLUSTER_STATE_SCHEMA_VERSION) throw new Error(`unsupported future state schema ${current}`);
  state.schemaVersion = CLUSTER_STATE_SCHEMA_VERSION;
  return { state, migrated: applied.length > 0, from, to: CLUSTER_STATE_SCHEMA_VERSION, applied };
}

