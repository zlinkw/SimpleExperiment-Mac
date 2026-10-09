import { RequestBudget, RequestBudgetConfig, RequestBudgetCoordinator, RequestBudgetSnapshot } from "./RequestBudget";
import { ClusterSnapshot, GpuHistoryQuery, GpuHistoryResponse, TunnelAction, TunnelEndpointConfig } from "./TunnelClient";
import { DownloadOptions, FileListResponse, FileTransferTask } from "./FileTransferTypes";
import { defaultRealtimeRefreshPolicy, RealtimeClientDiagnostics, RealtimeRefreshPolicy, RealtimeTunnelClient, StreamStatus } from "./RealtimeTunnelClient";
import { compactRealtimeLogs, createRealtimeState, RealtimeState } from "./RealtimeEventReducer";
import { mergeAuthorityRealtimeStates } from "./AuthorityMergePolicy";
import { isWorkerTelemetryAction, workerLocalSchedulerActionNames, workerResultActionNames, WorkerLocalSchedulerAction, WorkerResultAction } from "./WorkerTelemetryApi";

export interface NamedTunnelEndpointConfig extends TunnelEndpointConfig {
  id: string;
  role: "hub" | "worker";
  displayName?: string;
}

export interface MultiEndpointDiagnostics {
  streamStatus: StreamStatus | "mixed";
  lastSeq: number;
  lastHeartbeatAt?: string;
  reconnectCount: number;
  lastError?: string;
  endpoints: Array<{
    id: string;
    role: "hub" | "worker";
    displayName?: string;
    localPort: number;
    streamStatus: StreamStatus;
    lastSeq: number;
    lastHeartbeatAt?: string;
    reconnectCount: number;
    lastError?: string;
  }>;
}

export class MultiEndpointRealtimeClient {
  private readonly endpoints: NamedTunnelEndpointConfig[];
  private readonly endpointById: ReadonlyMap<string, NamedTunnelEndpointConfig>;
  private readonly clients = new Map<string, RealtimeTunnelClient>();
  private readonly budgets = new Map<string, RequestBudget>();
  private readonly requestBudgetCoordinator: RequestBudgetCoordinator;
  private mergedState: RealtimeState = createRealtimeState();
  private protectedLogKeys: string[] = [];
  private diagnosticsEndpointSources: Array<RealtimeClientDiagnostics | undefined> = [];
  private diagnosticsCache?: MultiEndpointDiagnostics;

  constructor(
    endpoints: NamedTunnelEndpointConfig[],
    budgetFactory: (endpoint: NamedTunnelEndpointConfig) => RequestBudget,
    private readonly policy: RealtimeRefreshPolicy = defaultRealtimeRefreshPolicy,
    private readonly onState: (state: RealtimeState) => void = () => undefined,
  ) {
    this.endpoints = endpoints.map((endpoint) => ({ ...endpoint }));
    this.endpointById = new Map(this.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    let sharedCoordinator: RequestBudgetCoordinator | undefined;
    for (const endpoint of this.endpoints) {
      const budget = budgetFactory(endpoint);
      if (!sharedCoordinator) sharedCoordinator = budget.createCoordinator();
      budget.attachCoordinator(sharedCoordinator, endpoint.id);
      this.budgets.set(endpoint.id, budget);
      this.clients.set(endpoint.id, new RealtimeTunnelClient(endpoint, budget, policy, (state) => {
        this.mergedState = mergeRealtimeStates(this.endpointStates(endpoint.id, state), this.endpoints, this.protectedLogKeys, this.endpointById);
        this.onState(this.mergedState);
      }));
    }
    this.requestBudgetCoordinator = sharedCoordinator || new RequestBudgetCoordinator();
  }

  async connect(_sinceSeq?: number, options: { manual?: boolean } = {}): Promise<void> {
    await mapLimitAllSettled([...this.clients.values()], 8, (client) => client.connect(client.currentState().lastSeq, options));
    this.updateMergedState();
  }

  async disconnect(reason = "manual"): Promise<void> {
    await mapLimitAllSettled([...this.clients.values()], 8, (client) => client.disconnect(reason));
    this.updateMergedState();
  }

  async reconnect(reason = "reconnect"): Promise<void> {
    const clients = [...this.clients.values()].filter(client => client.diagnostics().requiresManualReconnect || ["disconnected", "paused"].includes(client.diagnostics().streamStatus));
    await mapLimitAllSettled(clients, 8, (client) => client.reconnect(reason));
    this.updateMergedState();
  }

  async getSnapshot(): Promise<ClusterSnapshot> {
    const entries = await mapLimitAllSettled(this.endpoints, 8, async (endpoint) => {
      const snapshot = await this.clients.get(endpoint.id)?.getSnapshot();
      return snapshot ? { endpoint, snapshot } : undefined;
    });
    const snapshots = entries
      .filter((entry): entry is PromiseFulfilledResult<{ endpoint: NamedTunnelEndpointConfig; snapshot: ClusterSnapshot } | undefined> => entry.status === "fulfilled")
      .map((entry) => entry.value)
      .filter((entry): entry is { endpoint: NamedTunnelEndpointConfig; snapshot: ClusterSnapshot } => Boolean(entry));
    const snapshot = mergeClusterSnapshots(snapshots);
    this.updateMergedState(snapshot);
    return snapshot;
  }

  async getGpu(options: { dispatch?: boolean } = {}): Promise<Record<string, unknown[]>> {
    const entries = await Promise.allSettled(this.endpoints.map(async (endpoint) => {
      const value = await this.clients.get(endpoint.id)?.getGpu(options);
      return { endpoint, value };
    }));
    const fulfilled = entries.filter((entry): entry is PromiseFulfilledResult<{ endpoint: NamedTunnelEndpointConfig; value: unknown }> => entry.status === "fulfilled");
    if (!fulfilled.length) {
      const rejected = entries.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned GPU state.");
    }
    const gpu = fulfilled.reduce<Record<string, unknown[]>>((out, entry) => Object.assign(out, apiGpu(entry.value.value, entry.value.endpoint)), {});
    this.mergedState = { ...this.mergedState, gpu, lastKnownGood: { ...(this.mergedState.lastKnownGood || {}), gpu } };
    this.onState(this.mergedState);
    return gpu;
  }

  async getGpuHistory(query: GpuHistoryQuery = {}): Promise<GpuHistoryResponse> {
    const serverId = String((query as Record<string, unknown>).serverId || "").trim();
    if (serverId) {
      const target = this.endpointForGpuHistory(serverId);
      if (target) {
        const client = this.clients.get(target.id);
        if (client) {
          try {
            return await client.getGpuHistory(query);
          } catch (error) {
            if (target.id !== "hub") {
              const hub = this.clients.get("hub");
              if (hub) {
                try {
                  return await hub.getGpuHistory(query);
                } catch {}
              }
            }
            throw error;
          }
        }
      }
      // target 为空时：尝试在 enabled workers 中模糊匹配首个 worker 直连，不再直接 hubClient() 抛 Hub not configured
      const lowerKey = serverId.toLowerCase();
      const enabled = this.endpoints;
      const fuzzyFallback = enabled.find((ep) => {
        if (ep.id === "hub") return false;
        const anyEp = ep as unknown as Record<string, unknown>;
        const candidates = [
          ep.id,
          String(anyEp.workerId || anyEp.worker_id || ""),
          String(ep.displayName || ""),
          String(anyEp.sshConfigAlias || ""),
        ].map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
        return candidates.some((c) => c === lowerKey || c.includes(lowerKey) || lowerKey.includes(c));
      }) || enabled.find((ep) => ep.id !== "hub");
      if (fuzzyFallback) {
        const client = this.clients.get(fuzzyFallback.id);
        if (client) {
          try {
            return await client.getGpuHistory(query);
          } catch (error) {
            throw error;
          }
        }
      }
      throw new Error("Worker GPU历史未就绪，请检查隧道");
    }
    return this.getAggregatedGpuHistory(query);
  }

  private endpointForGpuHistory(serverId: string): NamedTunnelEndpointConfig | undefined {
    const key = String(serverId || "").trim();
    if (!key) return undefined;
    const lowerKey = key.toLowerCase();
    // case-insensitive 与 workerId 归一：toLowerCase 比较，支持 displayName/sshConfigAlias 匹配
    const byId = this.endpointById.get(key) || this.endpointById.get(lowerKey) || [...this.endpointById.entries()].find(([k]) => String(k).toLowerCase() === lowerKey)?.[1];
    if (byId) return byId;
    for (const ep of this.endpoints) {
      const anyEp = ep as unknown as Record<string, unknown>;
      const workerId = String(anyEp.workerId || anyEp.worker_id || "").trim().toLowerCase();
      if (workerId && workerId === lowerKey) return ep;
      const displayName = String(ep.displayName || "").trim().toLowerCase();
      if (displayName && displayName === lowerKey) return ep;
      const alias = String(anyEp.sshConfigAlias || "").trim().toLowerCase();
      if (alias && alias === lowerKey) return ep;
      const idLower = String(ep.id || "").toLowerCase();
      if (idLower.includes(lowerKey) || lowerKey.includes(idLower)) return ep;
      if (displayName && (displayName.includes(lowerKey) || lowerKey.includes(displayName))) return ep;
      if (alias && (alias.includes(lowerKey) || lowerKey.includes(alias))) return ep;
      if (workerId && (workerId.includes(lowerKey) || lowerKey.includes(workerId))) return ep;
    }
    return undefined;
  }

  private async getAggregatedGpuHistory(query: GpuHistoryQuery): Promise<GpuHistoryResponse> {
    const enabled = this.endpoints;
    if (!enabled.length) throw new Error("No realtime endpoint configured for GPU history.");
    const results = await Promise.allSettled(enabled.map((ep) => this.clients.get(ep.id)!.getGpuHistory(query)));
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<GpuHistoryResponse> => r.status === "fulfilled").map((r) => r.value);
    if (!fulfilled.length) {
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned GPU history.");
    }
    if (fulfilled.length === 1) return fulfilled[0];
    return mergeGpuHistoryResponses(fulfilled, query);
  }

  async getScheduler(): Promise<unknown[]> {
    const entries = await Promise.allSettled([...this.clients.values()].map((client) => client.getScheduler()));
    const fulfilled = entries.filter((entry): entry is PromiseFulfilledResult<unknown> => entry.status === "fulfilled");
    if (!fulfilled.length) {
      const rejected = entries.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned scheduler state.");
    }
    const schedulerStates = fulfilled.flatMap((entry) => apiRows(entry.value, "schedulerStates"));
    this.mergedState = { ...this.mergedState, schedulerStates, lastKnownGood: { ...(this.mergedState.lastKnownGood || {}), schedulerStates } };
    this.onState(this.mergedState);
    return schedulerStates;
  }

  async getTraces(): Promise<unknown[]> {
    const entries = await Promise.allSettled([...this.clients.values()].map((client) => client.getTraces()));
    const fulfilled = entries.filter((entry): entry is PromiseFulfilledResult<unknown> => entry.status === "fulfilled");
    if (!fulfilled.length) {
      const rejected = entries.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned traces.");
    }
    const experimentTraces = fulfilled.flatMap((entry) => apiRows(entry.value, "experimentTraces"));
    this.mergedState = { ...this.mergedState, experimentTraces, lastKnownGood: { ...(this.mergedState.lastKnownGood || {}), experimentTraces } };
    this.onState(this.mergedState);
    return experimentTraces;
  }

  async getResultsSummary(planFile = "", options: { userInitiated?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const hub = this.clients.get("hub");
    if (hub) return hub.getResultsSummary(planFile, options);
    const workerEndpoints = this.endpoints.filter((endpoint) => endpoint.role === "worker");
    const entries = await Promise.allSettled(workerEndpoints.map(async (endpoint) => ({
      workerId: endpoint.id,
      summary: await this.clients.get(endpoint.id)?.getResultsSummary(planFile, options),
    })));
    const fulfilled = entries
      .filter((entry): entry is PromiseFulfilledResult<{ workerId: string; summary: unknown }> => entry.status === "fulfilled")
      .map((entry) => entry.value);
    if (!fulfilled.length) {
      const rejected = entries.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      throw rejected?.reason || new Error("No Worker endpoint returned a results summary.");
    }
    const merged = mergeWorkerResultsSummaries(fulfilled, planFile, workerEndpoints.map((endpoint) => endpoint.id));
    if (!Array.isArray(merged.availableWorkerIds) || !merged.availableWorkerIds.length) {
      throw new Error("No Worker endpoint returned a valid results summary for the selected Plan.");
    }
    return merged;
  }

  async getDiagnostics(): Promise<unknown> {
    return this.getAggregatedDiagnostics();
  }

  private async getAggregatedDiagnostics(): Promise<unknown> {
    const targets = this.aggregationTargets();
    if (!targets.length) throw new Error("No realtime endpoint configured for diagnostics.");
    const results = await Promise.allSettled(targets.map((ep) => this.clients.get(ep.id)!.getDiagnostics()));
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled").map((r) => r.value);
    if (!fulfilled.length) {
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned diagnostics.");
    }
    if (fulfilled.length === 1) return fulfilled[0];
    return this.mergeGenericResponses(fulfilled);
  }

  async getAuditTail(): Promise<unknown> {
    return this.getAggregatedAuditTail();
  }

  private async getAggregatedAuditTail(): Promise<unknown> {
    const targets = this.aggregationTargets();
    if (!targets.length) throw new Error("No realtime endpoint configured for audit tail.");
    const results = await Promise.allSettled(targets.map((ep) => this.clients.get(ep.id)!.getAuditTail()));
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled").map((r) => r.value);
    if (!fulfilled.length) {
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      throw rejected?.reason || new Error("No realtime endpoint returned audit tail.");
    }
    if (fulfilled.length === 1) return fulfilled[0];
    return this.mergeGenericResponses(fulfilled);
  }

  async getOperation(operationId: string): Promise<unknown> {
    return this.getAggregatedOperation(operationId);
  }

  private async getAggregatedOperation(operationId: string): Promise<unknown> {
    const id = String(operationId || "").trim();
    if (!id) throw new Error("operationId is required.");
    const targets = this.aggregationTargets();
    if (!targets.length) throw new Error("No realtime endpoint configured for operation.");
    const results = await Promise.allSettled(targets.map((ep) => this.clients.get(ep.id)!.getOperation(id)));
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled").map((r) => r.value);
    if (fulfilled.length) return fulfilled[0];
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw rejected?.reason || new Error("No realtime endpoint returned operation.");
  }

  async getWorkerOperation(workerId: string, operationId: string): Promise<unknown> {
    const client = this.clients.get(workerId);
    const endpoint = this.endpointById.get(workerId);
    if (!client || endpoint?.role !== "worker") {
      throw new Error(`Worker Agent endpoint not configured: ${workerId}`);
    }
    return client.getOperation(operationId);
  }

  async getWorkerTasks(workerId: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    const client = this.clients.get(workerId);
    const endpoint = this.endpointById.get(workerId);
    if (!client || endpoint?.role !== "worker") throw new Error(`Worker Agent endpoint not configured: ${workerId}`);
    return client.getWorkerTasks(options);
  }

  async getRunEvidence(workerId: string | undefined, params: { operationId?: string; planFile?: string; pid?: number | string; tmuxSession?: string }): Promise<unknown> {
    const client = workerId ? this.clients.get(workerId) : this.hubClient();
    const endpoint = workerId ? this.endpointById.get(workerId) : undefined;
    if (!client || (workerId && endpoint?.role !== "worker")) throw new Error(`Agent endpoint not configured: ${workerId || "hub"}`);
    return client.getRunEvidence?.(params) ?? Promise.reject(new Error("Agent runtime does not expose run evidence."));
  }

  async getLiveOutput(runKey: string, since = 0, workerId?: string, options: { userInitiated?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const client = workerId ? this.clients.get(workerId) : this.hubClient();
    const endpoint = workerId ? this.endpointById.get(workerId) : undefined;
    if (!client || (workerId && endpoint?.role !== "worker")) {
      throw new Error(`Worker Agent endpoint not configured: ${workerId}`);
    }
    const result = await client.getLiveOutput(runKey, since, options);
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const text = String(record.text || record.output || record.tail || "");
    const offset = Number(record.offset || 0);
    const previous = this.mergedState.logs?.[runKey];
    const combined = since > 0 && previous && Number(previous.offset) === since
      ? String(previous.text || "") + text : text;
    this.mergedState = {
      ...this.mergedState,
      logs: {
        ...compactRealtimeLogs({
          ...this.mergedState.logs,
          [runKey]: { text: combined.slice(-128_000), offset, seq: this.mergedState.lastSeq },
        }, undefined, undefined, this.protectedLogKeys),
      },
    };
    this.onState(this.mergedState);
    return result;
  }

  async postAction<T>(action: TunnelAction, body: unknown): Promise<T> {
    return this.getAggregatedPostAction<T>(action, body);
  }

  private async getAggregatedPostAction<T>(action: TunnelAction, body: unknown): Promise<T> {
    const isCacheClear = String(action || "").trim().toLowerCase().replace(/[-_]/g, "") === "clearcache";
    const isWorkerAction = isCacheClear || isWorkerTelemetryAction(action) || isWorkerLocalSchedulerRequest(action, body) || isWorkerOwnedResultRequest(action, body);
    if (isWorkerAction) {
      // worker 型 action（含 clearCache/clear-cache 视为 worker 本地操作）聚合到 workers（失败单端忽略），单 worker 时走 worker 端点
      const workers = this.endpoints.filter((ep) => ep.role === "worker");
      const targets = isCacheClear
        ? (this.endpoints.filter((ep) => ep.role === "worker").length ? this.endpoints.filter((ep) => ep.role === "worker") : this.aggregationTargets())
        : (workers.length ? workers : this.aggregationTargets());
      // clearCache 需要广播到所有可用端点（hub+workers）或仅 workers（hub 未配置时）；其他 worker action 保持原聚合
      if (isCacheClear) {
        const cacheTargets = this.endpoints.length ? this.endpoints : this.aggregationTargets();
        // 若存在 hub 且 workers 为空，仍走 hub；否则优先 workers，hub 未配置时仅 workers 不抛 Hub not configured
        const effectiveTargets = cacheTargets.filter((ep) => ep.role === "worker").length ? cacheTargets.filter((ep) => ep.role === "worker") : cacheTargets;
        // 当为单 worker 拓扑（无 hub）时直接扇出到 workers
        const hasHub = this.clients.has("hub");
        const fanout = hasHub ? cacheTargets : effectiveTargets;
        const results = await Promise.allSettled(fanout.map((ep) => this.clients.get(ep.id)!.postAction<T>(action, body)));
        const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<T>).value);
        if (fulfilled.length) {
          // 合并 deletedCount 以反映多端清除总量
          const merged: any = fulfilled[0];
          if (fulfilled.length > 1 && merged && typeof merged === "object") {
            const total = fulfilled.reduce((sum: number, v: any) => sum + Number((v as any)?.deletedCount ?? 0), 0);
            (merged as any).deletedCount = total;
            (merged as any)._aggregatedSources = fulfilled.length;
          }
          return merged as T;
        }
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        throw rejected?.reason || new Error("No endpoint accepted clearCache.");
      }
      const results = await Promise.allSettled(targets.map((ep) => this.clients.get(ep.id)!.postAction<T>(action, body)));
      const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<T>).value);
      if (fulfilled.length) return fulfilled[0] as T;
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw rejected?.reason || new Error("No worker endpoint accepted action.");
    }
    // hub 型 action 保持 hub 单点（避免 workers 收到不支持的 Hub 控制 API），兼容既有测试
    // 若 hub 未配置但为 clearCache 已在上方处理，此处仍抛 Hub not configured 以便上层回退
    return this.hubClient().postAction<T>(action, body);
  }

  async postWorkerAction<T>(workerId: string, action: TunnelAction, body: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    const isCacheClearWorker = String(action || "").trim().toLowerCase().replace(/[-_]/g, "") === "clearcache";
    if (!isCacheClearWorker && action !== "preview-cache-cleanup" && action !== "delete-cache-candidates" && !isWorkerTelemetryAction(action) && !isWorkerLocalSchedulerRequest(action, body) && !isWorkerOwnedResultRequest(action, body)) {
      throw new Error(`Worker Agent action not allowed: ${action}`);
    }
    const client = this.clients.get(workerId);
    const endpoint = this.endpointById.get(workerId);
    if (!client || endpoint?.role !== "worker") {
      throw new Error(`Worker Agent endpoint not configured: ${workerId}`);
    }
    return client.postAction<T>(action, body, options);
  }

  async postAvailabilityBatch<T>(body: unknown): Promise<T> {
    // postAvailabilityBatch 保持 hub 聚合（workers 先直连 HUB 再聚合），失败单端忽略；此处简化为 hub 直调以兼容既有 worker 隔离测试
    // 若需多端聚合，可改为 fanout 到 workers + hub 并合并
    return this.hubClient().postAvailabilityBatch<T>(body);
  }

  async listRemoteFiles(remotePath: string): Promise<FileListResponse> {
    return this.hubClient().listRemoteFiles(remotePath);
  }

  async downloadFile(remotePath: string, localPath: string, options: DownloadOptions = {}): Promise<FileTransferTask> {
    const task = await this.hubClient().downloadFile(remotePath, localPath, options);
    this.updateMergedState();
    return task;
  }

  async downloadWorkerFile(workerId: string, remotePath: string, localPath: string, options: DownloadOptions = {}): Promise<FileTransferTask> {
    const endpoint = this.endpointById.get(workerId);
    const client = this.clients.get(workerId);
    if (!client || endpoint?.role !== "worker") throw new Error(`Worker Agent endpoint not configured: ${workerId}`);
    const task = await client.downloadFile(remotePath, localPath, options);
    this.updateMergedState();
    return task;
  }

  async uploadFile(localPath: string, remotePath: string): Promise<FileTransferTask> {
    const task = await this.hubClient().uploadFile(localPath, remotePath);
    this.updateMergedState();
    return task;
  }

  diagnostics(): MultiEndpointDiagnostics {
    const sources = this.endpoints.map((endpoint) => this.clients.get(endpoint.id)?.diagnostics());
    if (this.diagnosticsCache
      && sources.length === this.diagnosticsEndpointSources.length
      && sources.every((source, index) => source === this.diagnosticsEndpointSources[index])) {
      return this.diagnosticsCache;
    }
    const endpoints = this.endpoints.map((endpoint, index) => {
      const item = sources[index];
      return {
        id: endpoint.id,
        role: endpoint.role,
        displayName: endpoint.displayName,
        localPort: endpoint.localPort,
        streamStatus: item?.streamStatus || "disconnected",
        lastSeq: item?.lastSeq || 0,
        lastHeartbeatAt: item?.lastHeartbeatAt,
        reconnectCount: item?.reconnectCount || 0,
        lastError: item?.lastError,
      };
    });
    const statuses = new Set(endpoints.map((endpoint) => endpoint.streamStatus));
    const diagnostics: MultiEndpointDiagnostics = {
      streamStatus: statuses.size === 1 ? endpoints[0]?.streamStatus || "disconnected" : "mixed",
      lastSeq: Math.max(0, ...endpoints.map((endpoint) => endpoint.lastSeq)),
      lastHeartbeatAt: latest(endpoints.map((endpoint) => endpoint.lastHeartbeatAt)),
      reconnectCount: endpoints.reduce((sum, endpoint) => sum + endpoint.reconnectCount, 0),
      lastError: endpoints.find((endpoint) => endpoint.lastError)?.lastError,
      endpoints,
    };
    this.diagnosticsEndpointSources = sources;
    this.diagnosticsCache = diagnostics;
    return diagnostics;
  }

  currentState(): RealtimeState {
    return this.mergedState;
  }

  setHidden(hidden: boolean): void {
    for (const client of this.clients.values()) client.setHidden(hidden);
  }

  setProtectedLogKeys(keys: string[]): void {
    this.protectedLogKeys = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || "").trim()).filter(Boolean))];
    for (const client of this.clients.values()) client.setProtectedLogKeys(this.protectedLogKeys);
    this.updateMergedState();
  }

  budgetSnapshots(): Record<string, RequestBudgetSnapshot> {
    return Object.fromEntries([...this.budgets.entries()].map(([id, budget]) => [id, budget.snapshot()]));
  }

  noteRetry(endpointId: string): void {
    this.budgets.get(String(endpointId || ""))?.noteRetry();
  }

  private endpointStates(changedEndpointId?: string, changedState?: RealtimeState): Array<{ endpoint: NamedTunnelEndpointConfig; state: RealtimeState }> {
    return this.endpoints.map((endpoint) => ({
      endpoint,
      state: changedEndpointId === endpoint.id && changedState ? changedState : this.clients.get(endpoint.id)?.currentState() || createRealtimeState(),
    }));
  }

  private updateMergedState(snapshot?: ClusterSnapshot): void {
    this.mergedState = snapshot ? createRealtimeState(snapshot) : mergeRealtimeStates(this.endpointStates(), this.endpoints, this.protectedLogKeys, this.endpointById);
    this.onState(this.mergedState);
  }

  private aggregationTargets(): NamedTunnelEndpointConfig[] {
    const hubAllowed = this.clients.has("hub");
    // 若 topology hubAllowed 则 workers->HUB 聚合（workers先直连HUB再聚合），否则直接聚合 workers；复用 getAggregatedGpuHistory 的 fanout+merge 模式
    if (hubAllowed) return this.endpoints;
    const workers = this.endpoints.filter((ep) => ep.role === "worker");
    return workers.length ? workers : this.endpoints;
  }

  private mergeGenericResponses(values: unknown[]): unknown {
    if (!values.length) return undefined;
    if (values.length === 1) return values[0];
    // array concat
    if (values.every((v) => Array.isArray(v))) return (values as unknown[][]).flat();
    const out: Record<string, unknown> = {};
    for (const v of values) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(val) && Array.isArray(out[k])) (out[k] as unknown[]).push(...(val as unknown[]));
          else if (val && typeof val === "object" && out[k] && typeof out[k] === "object" && !Array.isArray(val) && !Array.isArray(out[k])) out[k] = { ...(out[k] as Record<string, unknown>), ...(val as Record<string, unknown>) };
          else if (out[k] === undefined) out[k] = val;
          else if (k === "entries" && Array.isArray(val)) out[k] = [...(Array.isArray(out[k]) ? out[k] as unknown[] : []), ...(val as unknown[])];
        }
      }
    }
    // Include aggregated hint without breaking consumers
    if (!out._aggregatedSources) (out as Record<string, unknown>)._aggregatedSources = values.length;
    return out;
  }

  private hubClient(): RealtimeTunnelClient {
    const hub = this.clients.get("hub");
    if (!hub) throw new Error("Hub realtime endpoint not configured for current topology.");
    return hub;
  }
}

function mergeGpuHistoryResponses(responses: GpuHistoryResponse[], query: GpuHistoryQuery): GpuHistoryResponse {
  if (!responses.length) throw new Error("No GPU history responses to merge.");
  const bucketSeconds = Math.min(...responses.map((r) => Number(r.bucketSeconds) || 60).filter((v) => Number.isFinite(v) && v > 0)) || responses[0]!.bucketSeconds || 60;
  const retentionHours = Math.max(...responses.map((r) => Number(r.retentionHours) || 0)) || responses[0]!.retentionHours || 72;
  const maxPointsPerSeries = Math.max(...responses.map((r) => Number(r.maxPointsPerSeries) || 0)) || responses[0]!.maxPointsPerSeries || 4320;
  const updatedAt = responses.map((r) => String(r.updatedAt || "")).filter(Boolean).sort().pop() || new Date().toISOString();
  const limit = Number((query as Record<string, unknown>).maxPoints) > 0 ? Number((query as Record<string, unknown>).maxPoints) : maxPointsPerSeries;
  const grouped = new Map<string, Map<number, import("./TunnelClient").GpuHistoryPoint>>();
  const meta = new Map<string, { serverId: string; gpuId: string; rawPointCount: number }>();
  for (const resp of responses) {
    for (const series of (resp.series || [] as unknown as import("./TunnelClient").GpuHistorySeries[])) {
      if (!series || !series.serverId || !series.gpuId) continue;
      const key = `${String(series.serverId).trim()}::${String(series.gpuId).trim()}`;
      if (!grouped.has(key)) grouped.set(key, new Map());
      const bucketMap = grouped.get(key)!;
      if (!meta.has(key)) meta.set(key, { serverId: String(series.serverId).trim(), gpuId: String(series.gpuId).trim(), rawPointCount: 0 });
      const entry = meta.get(key)!;
      entry.rawPointCount += Number(series.rawPointCount || (series.points || []).length);
      for (const point of (series.points || [])) {
        const bucket = Number((point as unknown as Record<string, unknown>).bucketEpoch);
        if (!Number.isFinite(bucket)) continue;
        const existing = bucketMap.get(bucket);
        if (!existing) bucketMap.set(bucket, point as import("./TunnelClient").GpuHistoryPoint);
        else {
          // de-duplicate: keep point with higher util if both present, otherwise last wins
          const curUtil = Number((existing as unknown as Record<string, unknown>).gpuUtilPercent);
          const nextUtil = Number((point as unknown as Record<string, unknown>).gpuUtilPercent);
          if (Number.isFinite(nextUtil) && Number.isFinite(curUtil) ? nextUtil > curUtil : true) bucketMap.set(bucket, point as import("./TunnelClient").GpuHistoryPoint);
        }
      }
    }
  }
  const series: import("./TunnelClient").GpuHistorySeries[] = [];
  for (const [key, bucketMap] of grouped.entries()) {
    const info = meta.get(key)!;
    let points = Array.from(bucketMap.values()).sort((a, b) => Number((a as unknown as Record<string, unknown>).bucketEpoch) - Number((b as unknown as Record<string, unknown>).bucketEpoch));
    if (points.length > limit) points = points.slice(-limit);
    series.push({ serverId: info.serverId, gpuId: info.gpuId, points, rawPointCount: info.rawPointCount });
  }
  series.sort((a, b) => String(a.serverId).localeCompare(String(b.serverId)) || String(a.gpuId).localeCompare(String(b.gpuId)));
  return { schemaVersion: 1, bucketSeconds, retentionHours, maxPointsPerSeries, updatedAt, series };
}

function isWorkerOwnedResultRequest(action: TunnelAction, body: unknown): boolean {
  if (!workerResultActionNames.includes(action as WorkerResultAction)) return false;
  const request = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const options = request.options && typeof request.options === "object" ? request.options as Record<string, unknown> : {};
  return ["single_worker", "worker_pool"].includes(String(options.topologyMode || request.topologyMode || ""))
    && Boolean(String(options.resultOwnerWorkerId || options.schedulerOwnerWorkerId || request.resultOwnerWorkerId || request.schedulerOwnerWorkerId || "").trim())
    && options.automaticBackup === false;
}

function isWorkerLocalSchedulerRequest(action: TunnelAction, body: unknown): boolean {
  if (!workerLocalSchedulerActionNames.includes(action as WorkerLocalSchedulerAction)) return false;
  const request = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const options = request.options && typeof request.options === "object" ? request.options as Record<string, unknown> : {};
  return ["single_worker", "worker_pool"].includes(String(options.topologyMode || ""))
    && options.localWorkerScheduler === true
    && Boolean(String(options.schedulerOwnerWorkerId || request.schedulerOwnerWorkerId || "").trim());
}

export function createBudget(config: RequestBudgetConfig): RequestBudget {
  return new RequestBudget(config);
}

export function mergeRealtimeStates(
  entries: Array<{ endpoint: NamedTunnelEndpointConfig; state: RealtimeState }>,
  endpoints: NamedTunnelEndpointConfig[] = entries.map((entry) => entry.endpoint),
  protectedLogKeys: string[] = [],
  endpointById: ReadonlyMap<string, NamedTunnelEndpointConfig> = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])),
): RealtimeState {
  return mergeAuthorityRealtimeStates(entries.map(({ endpoint, state }) => ({
    endpoint: endpointById.get(endpoint.id) || endpoint,
    state,
  })), { protectedLogKeys });
}

export function mergeClusterSnapshots(entries: Array<{ endpoint: NamedTunnelEndpointConfig; snapshot: ClusterSnapshot }>): ClusterSnapshot {
  const generatedAt = latest(entries.map((entry) => entry.snapshot.generatedAt));
  const gpu = entries.reduce<Record<string, unknown[]>>((out, entry) => Object.assign(out, snapshotGpu(entry.snapshot, entry.endpoint)), {});
  const schedulerStates = mergeRows([], entries.flatMap((entry) => entry.snapshot.schedulerStates || []));
  const experimentTraces = mergeRows([], entries.flatMap((entry) => entry.snapshot.experimentTraces || []));
  const diagnostics = Object.fromEntries(entries.map((entry) => [entry.endpoint.id, entry.snapshot.diagnostics || {}]));
  return {
    generatedAt,
    gpu,
    schedulerStates,
    experimentTraces,
    diagnostics,
  };
}

function snapshotGpu(snapshot: ClusterSnapshot, endpoint: NamedTunnelEndpointConfig): Record<string, unknown[]> {
  const raw = snapshot.gpu as unknown;
  if (Array.isArray(raw)) return { [endpoint.id]: raw };
  if (raw && typeof raw === "object") return remapGpu(raw as Record<string, unknown[]>, endpoint);
  return {};
}

function apiGpu(value: unknown, endpoint: NamedTunnelEndpointConfig): Record<string, unknown[]> {
  if (Array.isArray(value)) return { [endpoint.id]: value };
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  if (Array.isArray(item.gpu)) return { [endpoint.id]: item.gpu };
  if (item.gpu && typeof item.gpu === "object") return remapGpu(item.gpu as Record<string, unknown[]>, endpoint);
  if (Array.isArray(item.gpus)) return { [endpoint.id]: item.gpus };
  if (Array.isArray(item.rows)) return { [endpoint.id]: item.rows };
  return {};
}

function apiRows(value: unknown, key: "schedulerStates" | "experimentTraces"): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const primary = item[key];
  if (Array.isArray(primary)) return primary;
  if (key === "schedulerStates" && Array.isArray(item.scheduler)) return item.scheduler;
  if (key === "schedulerStates" && Array.isArray(item.scheduler_states)) return item.scheduler_states;
  if (key === "experimentTraces" && Array.isArray(item.traces)) return item.traces;
  if (key === "experimentTraces" && Array.isArray(item.experiment_traces)) return item.experiment_traces;
  if (Array.isArray(item.rows)) return item.rows;
  return [];
}

function remapGpu(gpu: Record<string, unknown[]>, endpoint: NamedTunnelEndpointConfig): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(gpu || {})) {
    const nextKey = endpoint.role === "worker" && key === "hub" ? endpoint.id : key;
    out[nextKey || endpoint.id] = Array.isArray(value) ? value : [];
  }
  return out;
}

function mergeRows(previous: unknown[], incoming: unknown[]): unknown[] {
  const map = new Map<string, unknown>();
  for (const item of previous || []) map.set(rowKey(item), item);
  for (const item of incoming || []) map.set(rowKey(item), { ...(map.get(rowKey(item)) as object || {}), ...(item as object) });
  return [...map.values()];
}

function rowKey(row: unknown): string {
  const item = row as Record<string, unknown>;
  return String(item.runKey || item.run_key || item.experimentId || item.experiment_id || item.id || item.key || JSON.stringify(row));
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter(Boolean).sort().at(-1);
}

export function mergeWorkerResultsSummaries(
  entries: Array<{ workerId: string; summary: unknown }>,
  requestedPlanFile = "",
  expectedWorkerIds: readonly string[] = [],
): Record<string, unknown> {
  const requestedPlan = normalizePlanPath(requestedPlanFile);
  const accepted = entries.flatMap(({ workerId, summary }) => {
    const item = summary && typeof summary === "object" && !Array.isArray(summary) ? summary as Record<string, unknown> : undefined;
    if (!item) return [];
    const summaryPlan = normalizePlanPath(item.planFile || item.plan_file);
    if (requestedPlan && summaryPlan && summaryPlan !== requestedPlan) return [];
    return [{ workerId: String(workerId || "").trim(), summary: item }];
  }).filter((entry) => entry.workerId);
  const results = accepted.flatMap(({ workerId, summary }) => {
    const rows = Array.isArray(summary.results)
      ? summary.results
      : [...(Array.isArray(summary.finalResults) ? summary.finalResults : []), ...(Array.isArray(summary.pendingReviewRecords) ? summary.pendingReviewRecords : [])];
    return rows.map((row) => stampWorkerResultOwnership(row, workerId));
  });
  const finalResults = results.filter((row) => String(row.finalEvidenceState || row.final_evidence_state || "").toLowerCase() === "archived");
  const pendingReviewRecords = results.filter((row) => String(row.finalEvidenceState || row.final_evidence_state || "").toLowerCase() !== "archived");
  const revisions = [...new Set(accepted.map(({ summary }) => String(summary.planRevision || summary.plan_revision || "").trim()).filter(Boolean))];
  const workerIds = [...new Set(accepted.map((entry) => entry.workerId))].sort((a, b) => a.localeCompare(b));
  const expectedWorkers = [...new Set((expectedWorkerIds.length ? expectedWorkerIds : entries.map((entry) => entry.workerId))
    .map((workerId) => String(workerId || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const unavailableWorkerIds = expectedWorkers.filter((workerId) => !workerIds.includes(workerId));
  const incompleteAggregate = unavailableWorkerIds.length > 0;
  const workerSetRevisions = [...new Set(accepted.map(({ summary }) => String(summary.workerSetRevision || "").trim()).filter(Boolean))];
  const workerResultTables = accepted.map(({ workerId, summary }) => ({
    workerId,
    rawResultCsvPath: String(summary.rawResultCsvPath || ""),
    datasetResultTables: (Array.isArray(summary.datasetResultTables) ? summary.datasetResultTables : []).map((row: any) => ({ ...row, workerId })),
    projectDatasetTables: (Array.isArray(summary.projectDatasetTables) ? summary.projectDatasetTables : []).map((row: any) => ({ ...row, workerId })),
    paperDatasetTables: (Array.isArray(summary.paperDatasetTables) ? summary.paperDatasetTables : []).map((row: any) => ({ ...row, workerId })),
    aggregateCsvPath: String(summary.aggregateCsvPath || ""),
    projectAggregateCsvPath: String(summary.projectAggregateCsvPath || ""),
    finalCsvPath: String(summary.finalCsvPath || ""),
    finalMarkdownPath: String(summary.finalMarkdownPath || ""),
    finalRowCount: Number(summary.finalRowCount || 0),
    projectFinalCsvPath: String(summary.projectFinalCsvPath || ""),
    projectFinalMarkdownPath: String(summary.projectFinalMarkdownPath || ""),
    aggregateStatus: String(summary.aggregateStatus || ""),
    aggregateMessage: String(summary.aggregateMessage || ""),
    columnMappingPreview: summary.columnMappingPreview || {},
  }));
  const singleTables = workerResultTables.length === 1 ? workerResultTables[0] : undefined;
  return {
    schemaVersion: 1,
    generatedAt: latest(accepted.map(({ summary }) => String(summary.generatedAt || summary.generated_at || "") || undefined)),
    planFile: requestedPlan || normalizePlanPath(accepted[0]?.summary.planFile || accepted[0]?.summary.plan_file),
    ...(revisions.length === 1 ? { planRevision: revisions[0] } : {}),
    ...(workerSetRevisions.length === 1 ? { workerSetRevision: workerSetRevisions[0] } : {}),
    topologyMode: expectedWorkers.length > 1 ? "worker_pool" : "single_worker",
    workerIds,
    workerResultTables,
    paperTableResultCount: accepted.reduce((total, entry) => total + Number(entry.summary.paperTableResultCount || 0), 0),
    datasetResultTables: workerResultTables.flatMap(row => row.datasetResultTables),
    projectDatasetTables: workerResultTables.flatMap(row => row.projectDatasetTables),
    paperDatasetTables: workerResultTables.flatMap(row => row.paperDatasetTables),
    ...(singleTables ? {
      rawResultCsvPath: singleTables.rawResultCsvPath,
      aggregateCsvPath: singleTables.aggregateCsvPath,
      projectAggregateCsvPath: singleTables.projectAggregateCsvPath,
      finalCsvPath: singleTables.finalCsvPath,
      finalMarkdownPath: singleTables.finalMarkdownPath,
      finalRowCount: singleTables.finalRowCount,
      projectFinalCsvPath: singleTables.projectFinalCsvPath,
      projectFinalMarkdownPath: singleTables.projectFinalMarkdownPath,
      aggregateStatus: singleTables.aggregateStatus,
      aggregateMessage: singleTables.aggregateMessage,
      columnMappingPreview: singleTables.columnMappingPreview,
      resultOwnerWorkerId: singleTables.workerId,
    } : {}),
    expectedWorkerIds: expectedWorkers,
    availableWorkerIds: workerIds,
    unavailableWorkerIds,
    incompleteAggregate,
    aggregateCoverage: `${workerIds.length}/${expectedWorkers.length}`,
    resultCount: results.length,
    parsedResults: results.length,
    previewResultCount: results.length,
    finalResultCount: finalResults.length,
    effectiveArchivedResultCount: finalResults.length,
    pendingReviewCount: pendingReviewRecords.length,
    results,
    finalResults,
    final_results: finalResults,
    pendingReviewRecords,
    pending_review_records: pendingReviewRecords,
    sources: accepted.flatMap(({ workerId, summary }) => (Array.isArray(summary.sources) ? summary.sources : []).map((source) => ({ workerId, path: String(source || "") }))),
    workerSummaries: accepted.map(({ workerId, summary }) => ({
      workerId,
      summaryPath: String(summary.summaryPath || ""),
      resultCount: Number(summary.resultCount || 0),
      finalResultCount: Number(summary.finalResultCount || summary.effectiveArchivedResultCount || 0),
      generatedAt: String(summary.generatedAt || summary.generated_at || ""),
    })),
    inclusionPolicy: "archived_only",
    analysisSource: "worker_archived_final_results",
    displayAggregateOnly: true,
    authoritative: false,
    mixedPlanRevision: revisions.length > 1,
    message: incompleteAggregate
      ? `仅合并 ${workerIds.length}/${expectedWorkers.length} 个 Worker 的结果摘要；缺少 ${unavailableWorkerIds.join("、")}，当前数字不是全局结果。`
      : `${workerIds.length} 个 Worker 的结果摘要已只读合并；远端状态和归档仍由各 Worker 独立保存。`,
  };
}

function stampWorkerResultOwnership(value: unknown, workerId: string): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const provenance = row.provenance && typeof row.provenance === "object" && !Array.isArray(row.provenance) ? row.provenance as Record<string, unknown> : {};
  const identity = String(row.resultId || row.result_id || row.runKey || row.run_key || row.experimentId || row.experiment_id || row.sourceFile || row.source || "result");
  return {
    ...row,
    workerId,
    resultOwnerWorkerId: workerId,
    resultOwnershipKey: `${workerId}:${identity}`,
    provenance: { ...provenance, workerId, resultOwnerWorkerId: workerId },
  };
}

function normalizePlanPath(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

async function mapLimitAllSettled<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}
