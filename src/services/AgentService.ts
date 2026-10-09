import { validateAgentEvent, AgentEvent } from "../agent/AgentEvent";
import { ClusterStore } from "../state/ClusterStore";

export class AgentService {
  constructor(private readonly store: ClusterStore) {}

  handleJsonLine(line: string): AgentEvent | undefined {
    const validation = validateAgentEvent(line);
    if (!validation.ok) {
      this.store.dispatch({ type: "agent/streamStateChanged", status: validation.code === "incompatible_schema" ? "degraded" : "stale", detail: validation.message });
      return undefined;
    }
    const event = validation.event;
    this.store.dispatch({ type: "agent/streamStateChanged", status: "streaming", seq: event.seq });
    if (event.type === "gpu_snapshot") this.store.dispatch({ type: "gpu/snapshotReceived", source: "hub_agent_stream", seq: event.seq, serverId: String(event.workerId || (event.payload as any)?.workerId || ""), payload: (event.payload as any)?.gpus || [] });
    if (event.type === "scheduler_snapshot") this.store.dispatch({ type: "scheduler/eventsReceived", source: "hub_agent_stream", seq: event.seq, payload: (event.payload as any)?.schedulerStates || [] });
    if (event.type === "experiment_traces") this.store.dispatch({ type: "traces/received", source: "hub_agent_stream", seq: event.seq, payload: (event.payload as any)?.experimentTraces || [] });
    if (event.type === "log_tail") this.store.dispatch({ type: "liveOutput/received", key: String(event.runKey || (event.payload as any)?.key || ""), payload: event.payload });
    return event;
  }
}

