export type WorkerTelemetryEventType =
  | "agent_heartbeat"
  | "gpu_snapshot"
  | "worker_health"
  | "worker_task_snapshot"
  | "log_tail"
  | "diagnostics_updated";

export const workerTelemetryAllowedEvents: readonly WorkerTelemetryEventType[] = [
  "agent_heartbeat",
  "gpu_snapshot",
  "worker_health",
  "worker_task_snapshot",
  "log_tail",
  "diagnostics_updated",
];

export const workerTelemetryRequiredEndpoints = [
  "/api/health",
  "/api/capabilities",
  "/api/gpu",
  "/api/worker/tasks",
  "/api/results/summary",
  "/api/live-output?runKey=<key>&since=<offset>",
  "/api/diagnostics",
  "GET /api/events/sse?since=<seq>",
] as const;

export const workerTelemetryActionNames = [
  "start-worker-task",
  "register-code-sync-proof",
  "rebuild-distributed-results",
  "retry-worker-task",
  "stop-worker-task",
  "stop-worker-task-exact-pane",
  "delete-worker-artifacts",
  "archive-worker-artifacts",
  "start-tensorboard",
  "stop-tensorboard",
  "get-tensorboard-status",
  "install-rich",
  "save-result-policy",
] as const;

export const workerLocalSchedulerActionNames = [
  "validate-plan",
  "dry-run-plan",
  "run-plan",
  "reproduce-plan",
  "stop-scheduler-operation",
] as const;

export const workerResultActionNames = [
  "refresh-results",
  "rescan-results",
  "parse-results",
  "run-quality-gate",
  "run-statistics",
  "export-paper-table",
  "check-claim-evidence",
  "check-output-contract",
  "parse-case-level",
  "run-leakage-check",
  "run-subgroup-analysis",
  "export-case-analysis",
  "plan-checkpoint-retention",
  "inspect-dataset",
  "export-plotting-contract",
  "infer-config-from-run",
  "recover-plan-from-run",
  "diagnose-result-anomaly",
  "compare-with-best-config",
  "archive-artifacts",
  "archive-plan-copy",
  "exclude-results",
  "sync-artifacts",
  "complete-three-way",
] as const;

export type WorkerTelemetryAction = typeof workerTelemetryActionNames[number];
export type WorkerLocalSchedulerAction = typeof workerLocalSchedulerActionNames[number];
export type WorkerResultAction = typeof workerResultActionNames[number];

export const workerTelemetryAllowedActions = workerTelemetryActionNames.map((action) =>
  `POST /api/actions/${action}`,
);

export const workerTelemetryForbiddenEndpoints = [
  "GET /api/files/list",
  "POST /api/files/*",
  "POST /api/actions/delete-artifacts",
] as const;

/** Worker telemetry may advertise read-only download. Listing and writes stay forbidden. */
export const workerTelemetryReadOnlyFileEndpointKeys = ["fileDownload", "fileRangeDownload", "fileStat"] as const;
export const workerTelemetryForbiddenFileEndpointKeys = [
  "fileList",
  "fileUploadChunk",
  "fileUploadInit",
  "fileUploadComplete",
] as const;

export function isWorkerTelemetryAction(action: unknown): action is WorkerTelemetryAction {
  return workerTelemetryActionNames.includes(action as WorkerTelemetryAction);
}

export function isWorkerDirectAction(action: unknown): action is WorkerTelemetryAction | WorkerLocalSchedulerAction | WorkerResultAction {
  return isWorkerTelemetryAction(action)
    || workerLocalSchedulerActionNames.includes(action as WorkerLocalSchedulerAction)
    || workerResultActionNames.includes(action as WorkerResultAction);
}

export interface WorkerTaskTelemetry {
  schemaVersion: 1;
  workerId: string;
  runKey?: string;
  experimentId?: string;
  localStatus: "pid_alive" | "process_gone" | "gpu_process_alive" | "log_updating" | "unknown";
  pid?: number;
  gpuIds?: string[];
  gpuProcessInfo?: Array<{
    gpuId: string;
    pid?: number;
    usedMemoryMb?: number;
    command?: string;
  }>;
  logPath?: string;
  logOffset?: number;
  lastSeenAt: string;
}

export interface MultiWorkerRealtimePolicy {
  connectHubOnStartup: boolean;
  connectWorkersOnStartup: boolean;
  keepHubStreamAlive: boolean;
  keepWorkerStreamsAlive: boolean;
  workerGpuRealtime: boolean;
  workerTaskTelemetryRealtime: boolean;
  workerHealthRealtime: boolean;
  logTailMode: "selected_run_only" | "running_runs_limited" | "disabled";
  maxConcurrentLogTails: number;
  workerReconnectInitialDelaySeconds: number;
  workerReconnectMaxDelaySeconds: number;
  staleWorkerTelemetrySeconds: number;
}

export const defaultMultiWorkerRealtimePolicy: MultiWorkerRealtimePolicy = {
  connectHubOnStartup: true,
  connectWorkersOnStartup: true,
  keepHubStreamAlive: true,
  keepWorkerStreamsAlive: true,
  workerGpuRealtime: true,
  workerTaskTelemetryRealtime: true,
  workerHealthRealtime: true,
  logTailMode: "selected_run_only",
  maxConcurrentLogTails: 1,
  workerReconnectInitialDelaySeconds: 3,
  workerReconnectMaxDelaySeconds: 60,
  staleWorkerTelemetrySeconds: 180,
};

export interface WorkerTelemetryCapabilities {
  schemaVersion: 1;
  apiVersion: string;
  agentVersion: string;
  mode: "worker_telemetry";
  endpoints: {
    health: boolean;
    capabilities: boolean;
    gpu: boolean;
    workerTasks: boolean;
    codeSyncProof?: boolean;
    liveOutput: boolean;
    diagnostics: boolean;
    resultsSummary?: boolean;
    websocketEvents: boolean;
    sseEvents: boolean;
    actions?: boolean;
    fileList?: boolean;
    fileStat?: boolean;
    fileDownload?: boolean;
    fileRangeDownload?: boolean;
    fileUploadInit?: boolean;
    fileUploadChunk?: boolean;
    fileUploadComplete?: boolean;
  };
  actionEndpoints?: Record<string, boolean>;
}

export function isWorkerTelemetryEventType(type: unknown): type is WorkerTelemetryEventType {
  return workerTelemetryAllowedEvents.includes(type as WorkerTelemetryEventType);
}

export function validateWorkerTelemetryCapabilities(value: unknown): { ok: boolean; warnings: string[] } {
  const caps = value as Partial<WorkerTelemetryCapabilities>;
  const warnings: string[] = [];
  if (!caps || caps.schemaVersion !== 1 || caps.mode !== "worker_telemetry" || !caps.endpoints) {
    return { ok: false, warnings: ["Worker Telemetry capability schema 无效。"] };
  }
  for (const key of ["health", "gpu", "workerTasks", "diagnostics"] as const) {
    if (!caps.endpoints[key]) warnings.push(`Worker Telemetry 缺少端点：${key}`);
  }
  if (caps.endpoints.actions) {
    const actions = caps.actionEndpoints || {};
    for (const action of Object.keys(actions)) {
      if (!isWorkerDirectAction(action) && actions[action]) {
        warnings.push(`Worker Telemetry 暴露了不允许的控制动作：${action}`);
      }
    }
  }
  const endpoints = caps.endpoints;
  const readOnlyFiles = new Set<string>(workerTelemetryReadOnlyFileEndpointKeys);
  const forbiddenFiles = workerTelemetryForbiddenFileEndpointKeys.filter((key) => Boolean(endpoints[key]) && !readOnlyFiles.has(key));
  if (forbiddenFiles.length) {
    warnings.push(`Worker Telemetry 暴露了不允许的文件写入或列表端点：${forbiddenFiles.join("、")}。`);
  }
  return { ok: warnings.every((warning) => !warning.includes("缺少端点") && !warning.includes("不允许")), warnings };
}
