import { RequestBudget, RequestBudgetDeniedError, TunnelRequestPurpose } from "./RequestBudget";
import { assertLocalhost, localBaseUrl } from "./TunnelGateway";
import { TunnelHealth } from "./TunnelHealth";
import { ProgressInactivity } from "../core/ProgressInactivity";
import { readBoundedResponseText } from "./BoundedResponse";

export const tunnelActions = [
  "run-plan", "stop-experiment", "retry-experiment", "reproduce-plan", "validate-plan", "dry-run-plan",
  "stop-scheduler-operation",
  "archive-artifacts", "archive-plan-copy", "exclude-results", "sync-artifacts", "complete-three-way", "delete-artifacts", "reconcile-deletions",
  "parse-results", "save-result-policy", "refresh-results", "self-check", "rescan-results", "run-quality-gate", "run-statistics", "export-paper-table",
  "check-claim-evidence", "deploy-runtime", "restart-agent", "create-debug-bundle", "create-offline-bundle", "cancel-operation",
  "check-output-contract", "parse-case-level", "run-leakage-check", "run-subgroup-analysis", "export-case-analysis", "plan-checkpoint-retention",
  "inspect-dataset", "export-plotting-contract", "infer-config-from-run", "recover-plan-from-run", "diagnose-result-anomaly", "compare-with-best-config",
  "start-worker-task", "register-code-sync-proof", "stop-worker-task", "retry-worker-task", "delete-worker-artifacts", "archive-worker-artifacts", "finalize-worker-operation",
  "rebuild-distributed-results",
  "start-tensorboard", "stop-tensorboard", "get-tensorboard-status",
  "preview-cache-cleanup", "delete-cache-candidates",
] as const;

export type TunnelAction = typeof tunnelActions[number];

export interface ClusterSnapshot {
  gpu?: Record<string, unknown[]>;
  scheduler?: unknown;
  schedulerStates?: unknown[];
  traces?: unknown;
  experimentTraces?: unknown[];
  operations?: unknown[];
  diagnostics?: Record<string, unknown>;
  generatedAt?: string;
}

export interface TunnelEndpointConfig {
  localHost: string;
  localPort: number;
  token?: string;
  timeoutMs?: number;
  resourceServer?: string;
  resourceProjectRoot?: string;
  fileCapabilities?: { supportsUploadCancel?: boolean; [key: string]: unknown };
  capabilities?: unknown;
  // 批量能力协商字段（T2）：用于多端聚合批量
  batchCapabilities?: { gpuHistoryBatch?: boolean; diagnosticsBatch?: boolean };
}

export interface GpuHistoryQuery {
  serverId?: string;
  gpuId?: string;
  start?: string | number;
  end?: string | number;
  maxPoints?: number;
  // 批量能力协商字段（T2）：透传至 Agent 用于 bucket/retention 协商与批量聚合
  batch?: boolean;
  bucketSeconds?: number;
  retentionHours?: number;
}

export interface GpuHistoryPoint {
  serverId: string;
  gpuId: string;
  timestamp: string;
  bucketEpoch: number;
  gpuUtilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  memoryUtilPercent: number | null;
  gapBefore?: boolean;
}

export interface GpuHistorySeries {
  serverId: string;
  gpuId: string;
  points: GpuHistoryPoint[];
  rawPointCount: number;
}

export interface GpuHistoryResponse {
  schemaVersion: 1;
  bucketSeconds: number;
  retentionHours: number;
  maxPointsPerSeries: number;
  updatedAt: string;
  series: GpuHistorySeries[];
  // 批量能力协商回传（T2）：是否批量聚合
  batchApplied?: boolean;
}

export interface TunnelClient {
  getHealth(options?: { userInitiated?: boolean }): Promise<TunnelHealth>;
  getSnapshot(options?: { manual?: boolean }): Promise<ClusterSnapshot>;
  getGpu(options?: { dispatch?: boolean }): Promise<unknown>;
  getGpuHistory(query?: GpuHistoryQuery): Promise<GpuHistoryResponse>;
  getScheduler(): Promise<unknown>;
  getTraces(): Promise<unknown>;
  getLiveOutput(runKey: string, since?: number, options?: { userInitiated?: boolean; signal?: AbortSignal }): Promise<unknown>;
  getResultsSummary(planFile?: string, options?: { userInitiated?: boolean; signal?: AbortSignal }): Promise<unknown>;
  getDiagnostics(): Promise<unknown>;
  getAuditTail(): Promise<unknown>;
  getOperation(operationId: string): Promise<unknown>;
  getWorkerTasks?(options?: { signal?: AbortSignal }): Promise<unknown>;
  getRunEvidence?(params: { operationId?: string; planFile?: string; pid?: number | string; tmuxSession?: string }): Promise<unknown>;
  postAction<T>(action: TunnelAction, body: unknown, options?: { signal?: AbortSignal }): Promise<T>;
  postAvailabilityBatch<T>(body: unknown): Promise<T>;
  openEventStream?(sinceSeq: number): Promise<void>;
}

const getPurposeByPath = new Map<string, TunnelRequestPurpose>([
  ["/api/health", "health"],
  ["/api/snapshot", "snapshot"],
  ["/api/gpu", "snapshot"],
  ["/api/scheduler", "snapshot"],
  ["/api/traces", "snapshot"],
  ["/api/live-output", "live_output"],
  ["/api/results/summary", "snapshot"],
  ["/api/diagnostics", "diagnostics"],
  ["/api/audit/tail", "diagnostics"],
  ["/api/runtime/evidence", "manual_refresh"],
]);

const actionPurpose: Partial<Record<TunnelAction, TunnelRequestPurpose>> = {
  "validate-plan": "run_plan",
  "dry-run-plan": "run_plan",
  "run-plan": "run_plan",
  "start-worker-task": "job_dispatch",
  "register-code-sync-proof": "job_dispatch",
  "retry-worker-task": "run_plan",
  "rebuild-distributed-results": "parse_results",
  "stop-scheduler-operation": "stop",
  "stop-experiment": "stop",
  "retry-experiment": "run_plan",
  "reproduce-plan": "run_plan",
  "parse-results": "parse_results",
  "save-result-policy": "manual_refresh",
  "refresh-results": "manual_refresh",
  "run-quality-gate": "parse_results",
  "run-statistics": "parse_results",
  "export-paper-table": "parse_results",
  "archive-artifacts": "manual_refresh",
  "sync-artifacts": "manual_refresh",
  "complete-three-way": "manual_refresh",
  "delete-artifacts": "manual_refresh",
  "reconcile-deletions": "manual_refresh",
  "self-check": "diagnostics",
  "start-tensorboard": "run_plan",
  "stop-tensorboard": "stop",
  "get-tensorboard-status": "manual_refresh",
  "create-debug-bundle": "diagnostics",
  "rescan-results": "manual_refresh",
};

function callerAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Request cancelled because no caller still needs the result.");
  error.name = "AbortError";
  return error;
}

export class HttpTunnelClient implements TunnelClient {
  private snapshotPromise?: Promise<ClusterSnapshot>;
  private readonly reads = new Map<string, { promise: Promise<unknown>; controller: AbortController; subscribers: number; settled: boolean }>();

  constructor(
    private readonly endpoint: TunnelEndpointConfig,
    private readonly budget: RequestBudget,
  ) {
    assertLocalhost(endpoint.localHost);
  }

  getHealth(options: { userInitiated?: boolean } = {}): Promise<TunnelHealth> {
    return this.requestJson<TunnelHealth>("/api/health", "health", undefined, {
      method: "GET",
      userInitiated: options.userInitiated,
    });
  }

  getSnapshot(options: { manual?: boolean; signal?: AbortSignal } = {}): Promise<ClusterSnapshot> {
    if (options.manual || options.signal) {
      return this.requestJson<ClusterSnapshot>("/api/snapshot", options.manual ? "manual_refresh" : "snapshot", undefined, {
        method: "GET",
        userInitiated: options.manual,
        signal: options.signal,
      });
    }
    if (!this.snapshotPromise) {
      this.snapshotPromise = this.requestJson<ClusterSnapshot>("/api/snapshot", "snapshot", undefined, { method: "GET" })
        .finally(() => {
          this.snapshotPromise = undefined;
        });
    }
    return this.snapshotPromise;
  }

  getGpu(options: { dispatch?: boolean } = {}): Promise<unknown> {
    return options.dispatch
      ? this.requestJson("/api/gpu", "job_dispatch", undefined, { method: "GET" })
      : this.getPath("/api/gpu");
  }

  getGpuHistory(query: GpuHistoryQuery = {}): Promise<GpuHistoryResponse> {
    const params = new URLSearchParams();
    if (query.serverId) params.set("serverId", query.serverId);
    if (query.gpuId) params.set("gpuId", query.gpuId);
    if (query.start !== undefined) params.set("start", String(query.start));
    if (query.end !== undefined) params.set("end", String(query.end));
    if (query.maxPoints !== undefined) params.set("maxPoints", String(Math.max(1, Math.min(864, Math.trunc(query.maxPoints) || 1))));
    if (query.batch !== undefined) params.set("batch", query.batch ? "1" : "0");
    if (query.bucketSeconds !== undefined) params.set("bucketSeconds", String(Math.max(1, Math.trunc(query.bucketSeconds) || 60)));
    if (query.retentionHours !== undefined) params.set("retentionHours", String(Math.max(1, Math.trunc(query.retentionHours) || 72)));
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.requestJson<GpuHistoryResponse>(`/api/gpu/history${suffix}`, "gpu_history", undefined, {
      method: "GET",
      userInitiated: false,
    });
  }

  getScheduler(): Promise<unknown> {
    return this.getPath("/api/scheduler");
  }

  getTraces(): Promise<unknown> {
    return this.getPath("/api/traces");
  }

  getLiveOutput(runKey: string, since = 0, options: { userInitiated?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const params = new URLSearchParams({ runKey, since: String(Math.max(0, since)) });
    return this.requestJson(`/api/live-output?${params.toString()}`, "live_output", undefined, {
      method: "GET",
      userInitiated: options.userInitiated,
      signal: options.signal,
    });
  }

  getResultsSummary(planFile = "", options: { userInitiated?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const path = "/api/results/summary" + (planFile ? "?planFile=" + encodeURIComponent(planFile) : "");
    return this.requestJson(path, options.userInitiated ? "manual_refresh" : "snapshot", undefined, {
      method: "GET",
      userInitiated: options.userInitiated,
      signal: options.signal,
    });
  }

  getDiagnostics(): Promise<unknown> {
    return this.getPath("/api/diagnostics");
  }

  getAuditTail(): Promise<unknown> {
    return this.getPath("/api/audit/tail");
  }

  getOperation(operationId: string): Promise<unknown> {
    const id = String(operationId || "").trim();
    if (!id) throw new Error("operationId is required.");
    return this.requestJson(`/api/operations/${encodeURIComponent(id)}`, "diagnostics", undefined, {
      method: "GET",
      userInitiated: true,
    });
  }

  getWorkerTasks(options: { signal?: AbortSignal } = {}): Promise<unknown> {
    return this.requestJson("/api/worker/tasks", "job_reconcile", undefined, {
      method: "GET",
      userInitiated: true,
      signal: options.signal,
    });
  }

  getRunEvidence(params: { operationId?: string; planFile?: string; pid?: number | string; tmuxSession?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const text = String(value || "").trim();
      if (text) query.set(key, text);
    }
    return this.requestJson(`/api/runtime/evidence?${query.toString()}`, "manual_refresh", undefined, {
      method: "GET",
      userInitiated: true,
    });
  }

  async postAction<T>(action: TunnelAction, body: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (!body || typeof body !== "object" || !("opId" in body) || !String((body as { opId?: unknown }).opId || "").trim()) {
      throw new Error("Tunnel action requires opId.");
    }
    return this.requestJson<T>(`/api/actions/${action}`, actionPurpose[action] || "manual_refresh", body, {
      method: "POST",
      userInitiated: true,
      timeoutMs: action === "rebuild-distributed-results" ? 330_000 : undefined,
      signal: options.signal,
    });
  }

  postAvailabilityBatch<T>(body: unknown): Promise<T> {
    return this.requestJson<T>("/api/worker/availability/batch", "manual_refresh", body, {
      method: "POST",
      userInitiated: false,
    });
  }

  async openEventStream(): Promise<void> {
    throw new RequestBudgetDeniedError("events", { allowed: false, reason: "offline" });
  }

  private getPath(path: string): Promise<unknown> {
    const purpose = getPurposeByPath.get(path.split("?", 1)[0]);
    if (!purpose) throw new Error(`API path not allowed: ${path}`);
    return this.requestJson(path, purpose, undefined, { method: "GET" });
  }

  private async requestJson<T>(
    apiPath: string,
    purpose: TunnelRequestPurpose,
    body: unknown,
    options: { method: "GET" | "POST"; userInitiated?: boolean; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (options.method === "GET") return this.subscribeRead<T>(apiPath, purpose, body, options);
    return this.executeRequestJson<T>(apiPath, purpose, body, options);
  }

  private subscribeRead<T>(
    apiPath: string,
    purpose: TunnelRequestPurpose,
    body: unknown,
    options: { method: "GET" | "POST"; userInitiated?: boolean; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(callerAbortError(options.signal));
    const readKey = `${purpose}\0${options.userInitiated === true ? "user" : "background"}\0${apiPath}`;
    let shared = this.reads.get(readKey);
    if (shared) {
      this.budget.noteCoalescedRequest();
    } else {
      const controller = new AbortController();
      const created = { promise: Promise.resolve(undefined) as Promise<unknown>, controller, subscribers: 0, settled: false };
      created.promise = Promise.resolve().then(() => this.executeRequestJson<T>(apiPath, purpose, body, {
        ...options, signal: controller.signal,
      })).finally(() => {
        created.settled = true;
        if (this.reads.get(readKey) === created) this.reads.delete(readKey);
      });
      shared = created;
      this.reads.set(readKey, created);
    }

    shared.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const detach = () => {
        options.signal?.removeEventListener("abort", onAbort);
        shared!.subscribers = Math.max(0, shared!.subscribers - 1);
        if (!shared!.settled && shared!.subscribers === 0) shared!.controller.abort(options.signal?.reason);
      };
      const onAbort = () => {
        if (finished) return;
        finished = true;
        detach();
        reject(callerAbortError(options.signal));
      };
      if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
      shared!.promise.then((value) => {
        if (finished) return;
        finished = true;
        detach();
        resolve(value as T);
      }, (error) => {
        if (finished) return;
        finished = true;
        detach();
        reject(error);
      });
    });
  }

  private async executeRequestJson<T>(
    apiPath: string, purpose: TunnelRequestPurpose, body: unknown,
    options: { method: "GET" | "POST"; userInitiated?: boolean; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (!apiPath.startsWith("/api/")) throw new Error("Only Hub Agent API paths are allowed.");
    const base = localBaseUrl(this.endpoint);
    return this.budget.run(
        purpose,
        async () => {
          const controller = new AbortController();
          const configuredTimeoutMs = Number(options.timeoutMs ?? this.endpoint.timeoutMs ?? 30_000);
          const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(1, configuredTimeoutMs) : 30_000;
          const timeoutText = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
          const inactivity = new ProgressInactivity(timeoutMs, () => controller.abort(new Error(`${timeoutText}无有效响应，执行结果待确认。实时连接会自动重试；请刷新运行状态核对，勿重复执行。`)));
          const abortFromCaller = () => controller.abort(options.signal?.reason);
          if (options.signal) {
            if (options.signal.aborted) abortFromCaller();
            else options.signal.addEventListener("abort", abortFromCaller, { once: true });
          }
          try {
            const response = await fetch(`${base}${apiPath}`, {
              method: options.method,
              signal: controller.signal,
              headers: this.headers(body !== undefined),
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await readBoundedResponseText(response, received => inactivity.update({ processedBytes: received }));
            if (!response.ok) {
              let detail = text;
              try {
                const failure = JSON.parse(text);
                const message = failure?.message || failure?.error?.message || failure?.error;
                if (typeof message === "string" && message.trim()) detail = message;
              } catch { /* Keep a bounded plain-text reason for non-JSON responses. */ }
              throw new Error(`Hub Agent HTTP ${response.status}: ${detail.slice(0, 2000)}`);
            }
            if (!text.trim()) return {} as T;
            return JSON.parse(text) as T;
          } finally {
            inactivity.dispose();
            options.signal?.removeEventListener("abort", abortFromCaller);
          }
        },
        { userInitiated: options.userInitiated, signal: options.signal },
      );
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.endpoint.token) headers["X-Simple-Agent-Token"] = this.endpoint.token;
    return headers;
  }
}
