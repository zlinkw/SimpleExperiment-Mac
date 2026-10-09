import { ClusterAction, ClusterStoreState, clusterReducer, createInitialClusterStoreState } from "./StateReducer";

export type StoreListener = (state: ClusterStoreState, action: ClusterAction) => void;

export class ClusterStore {
  private state: ClusterStoreState;
  private readonly listeners = new Set<StoreListener>();

  constructor(initial: ClusterStoreState = createInitialClusterStoreState()) {
    this.state = initial;
  }

  getState(): ClusterStoreState {
    return this.state;
  }

  dispatch(action: ClusterAction): void {
    this.state = clusterReducer(this.state, action);
    for (const listener of this.listeners) listener(this.state, action);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

