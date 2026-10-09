import { ClusterStoreState } from "./StateReducer";

export function selectUiState(state: ClusterStoreState): Record<string, unknown> {
  return {
    profileId: state.activeProfileId,
    servers: state.servers,
    gpu: state.gpu,
    schedulerStates: state.schedulerStates,
    experimentTraces: state.experimentTraces,
    liveOutputs: state.liveOutputs,
    agent: state.agent,
    operations: state.operations,
    diagnostics: state.diagnostics,
  };
}

export function selectOperationLoading(state: ClusterStoreState, targetKey: string): boolean {
  return state.operations.some((op) => ["queued", "running"].includes(op.status) && (op.targetKeys.includes(targetKey) || op.id === targetKey));
}

export function selectLastKnownGood(state: ClusterStoreState): ClusterStoreState["lastKnownGood"] {
  return state.lastKnownGood;
}

