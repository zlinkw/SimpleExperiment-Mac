import { mergeVersionedState } from "../agent/AgentStateReducer";
import { QueuedOperationRecord } from "../core/OperationQueue";
import { AgentRuntimeState, ClusterProfile, DiagnosticsState } from "../core/DomainTypes";

export interface ClusterStoreState {
  clusterConfig: Record<string, unknown>;
  profiles: ClusterProfile[];
  activeProfileId: string;
  servers: any[];
  gpu: Record<string, any[]>;
  schedulerStates: any[];
  experimentTraces: any[];
  liveOutputs: Record<string, any>;
  agent: AgentRuntimeState;
  operations: QueuedOperationRecord[];
  diagnostics: DiagnosticsState;
  lastKnownGood: {
    gpu: Record<string, any[]>;
    schedulerStates: any[];
    experimentTraces: any[];
    liveOutputs: Record<string, any>;
  };
}

export type ClusterAction =
  | { type: "profile/loaded"; profile: ClusterProfile; state?: Partial<ClusterStoreState> }
  | { type: "gpu/snapshotReceived"; source: string; seq?: number; serverId: string; payload: any[] }
  | { type: "scheduler/eventsReceived"; source: string; seq?: number; payload: any[] }
  | { type: "traces/received"; source: string; seq?: number; payload: any[] }
  | { type: "liveOutput/received"; key: string; payload: any }
  | { type: "agent/streamStateChanged"; status: AgentRuntimeState["status"]; detail?: string; seq?: number }
  | { type: "operations/updated"; operations: QueuedOperationRecord[] }
  | { type: "diagnostics/updated"; diagnostics: DiagnosticsState };

export function createInitialClusterStoreState(projectRoot = ""): ClusterStoreState {
  const profile: ClusterProfile = { id: "default", name: "Default", projectRoot, servers: [], settings: {} };
  return {
    clusterConfig: {},
    profiles: [profile],
    activeProfileId: profile.id,
    servers: [],
    gpu: {},
    schedulerStates: [],
    experimentTraces: [],
    liveOutputs: {},
    agent: {},
    operations: [],
    diagnostics: {},
    lastKnownGood: { gpu: {}, schedulerStates: [], experimentTraces: [], liveOutputs: {} },
  };
}

export function clusterReducer(state: ClusterStoreState, action: ClusterAction): ClusterStoreState {
  switch (action.type) {
    case "profile/loaded":
      return {
        ...state,
        ...(action.state || {}),
        profiles: upsertProfile(state.profiles, action.profile),
        activeProfileId: action.profile.id,
        servers: action.profile.servers as any[],
      };
    case "gpu/snapshotReceived": {
      const gpu = { ...state.gpu, [action.serverId]: action.payload };
      return { ...state, gpu, lastKnownGood: { ...state.lastKnownGood, gpu } };
    }
    case "scheduler/eventsReceived": {
      const schedulerStates = mergeRows(state.schedulerStates, action.payload, action.seq);
      return { ...state, schedulerStates, lastKnownGood: { ...state.lastKnownGood, schedulerStates } };
    }
    case "traces/received": {
      const experimentTraces = mergeRows(state.experimentTraces, action.payload, action.seq);
      return { ...state, experimentTraces, lastKnownGood: { ...state.lastKnownGood, experimentTraces } };
    }
    case "liveOutput/received": {
      const liveOutputs = { ...state.liveOutputs, [action.key]: action.payload };
      return { ...state, liveOutputs, lastKnownGood: { ...state.lastKnownGood, liveOutputs } };
    }
    case "agent/streamStateChanged":
      return { ...state, agent: { ...state.agent, status: action.status, detail: action.detail, lastSeq: action.seq ?? state.agent.lastSeq, lastEventAt: new Date().toISOString() } };
    case "operations/updated":
      return { ...state, operations: action.operations };
    case "diagnostics/updated":
      return { ...state, diagnostics: { ...state.diagnostics, ...action.diagnostics, updatedAt: new Date().toISOString() } };
    default:
      return state;
  }
}

function upsertProfile(profiles: ClusterProfile[], profile: ClusterProfile): ClusterProfile[] {
  const rest = profiles.filter((item) => item.id !== profile.id);
  return [...rest, profile];
}

function mergeRows(previous: any[], incoming: any[], seq?: number): any[] {
  const map = new Map<string, any>();
  for (const row of previous || []) map.set(rowKey(row), row);
  for (const row of incoming || []) {
    const next = { ...row, seq: row.seq ?? seq };
    map.set(rowKey(next), mergeVersionedState(map.get(rowKey(next)), next));
  }
  return Array.from(map.values());
}

function normalizeRowKey(row: any): string | undefined {
  const runKey = row.runKey || row.run_key || row.run_id || row.global_job_id;
  const sessionId = row.sessionId || row.session_id;
  if (runKey) return String(runKey);
  if (sessionId) return String(sessionId);
  const stable = row.file || row.key || row.id;
  if (stable) return String(stable);
  return undefined;
}

function rowKey(row: any): string {
  const normalized = normalizeRowKey(row);
  if (normalized) return normalized;
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[StateReducer] missing row key, row dropped from merge (runKey/run_key/run_id/sessionId/file/key/id all absent).");
    }
  } catch { /* ignore logging failure */ }
  return "__missing_row_key__";
}

