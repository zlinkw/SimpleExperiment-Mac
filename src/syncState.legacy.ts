export const ARTIFACT_REGISTRY_PATH = "simple_cluster/artifact_registry.json";

export interface SchedulerEntryDeleteMatcher {
  suite?: string;
  plan?: string;
  experimentIndex: string;
  workerId?: string;
  workerHost?: string;
  schedulerSession?: string;
  session?: string;
  logPath?: string;
  startedAt?: string;
  finishedAt?: string;
  processPids?: Array<string | number>;
  stateUpdatedAt?: string;
  affectsPending?: boolean;
  deleteMode?: "row" | "log_fields";
  deletedAt?: string;
}

export interface ExperimentIndexEntry {
  global_job_id: string;
  run_id: string;
  suite: string;
  case: string;
  seed: string;
  hub_job_dir: string;
  worker_id: string;
  worker_host: string;
  worker_job_dir: string;
  synced_at: string;
  source?: string;
  native_job_dir?: string;
  config_path?: string;
  checkpoint_path?: string;
  results_csv?: string;
  hub_console_log?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  deleted_at?: string;
  local_archive_status?: string;
  hub_archive_status?: string;
  worker_archive_status?: string;
  local_archive_state?: "archived" | "not_archived" | "unknown" | "error";
  hub_archive_state?: "archived" | "not_archived" | "unknown" | "error";
  worker_archive_state?: "archived" | "not_archived" | "unknown" | "error";
  archive_any_archived?: boolean;
  archive_all_archived?: boolean;
  archive_status_text?: string;
  local_archived?: boolean;
  hub_archived?: boolean;
  worker_archived?: boolean;
  archive_key?: string;
  artifact_state?: ArtifactRecordState;
  delete_error?: string;
}

export type ArtifactRecordState = "archived" | "delete_requested" | "deleting" | "delete_failed" | "deleted";
export type EndpointDeleteState = "archived" | "delete_requested" | "deleting" | "deleted" | "delete_failed" | "unknown";

export interface EndpointState {
  state: EndpointDeleteState;
  paths: string[];
  error?: string;
  verifiedAt?: number;
}

export interface ArtifactManifest {
  archiveKey: string;
  planName: string;
  experimentName: string;
  sourceServer: string;
  localLogPaths: string[];
  localArtifactDirs: string[];
  hubArtifactDirs: string[];
  hubLogPaths: string[];
  hubIndexPaths: string[];
  hubMarkerPaths: string[];
  workerArtifactDirs: string[];
  workerLogPaths: string[];
  workerIndexPaths: string[];
  workerMarkerPaths: string[];
  markerPaths?: string[];
  registryPaths: string[];
}

export interface ArtifactRecord {
  archiveKey: string;
  planName: string;
  experimentName: string;
  sourceServer: string;
  state: ArtifactRecordState;
  manifest: ArtifactManifest;
  endpoints: {
    local: EndpointState;
    hub: EndpointState;
    worker: EndpointState;
  };
  finalizers: string[];
  version: number;
  updatedAt: number;
  deletedAt?: number;
  deleteError?: string;
}

export function normalizeComparablePath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function comparablePathVariants(value: string): string[] {
  const normalized = normalizeComparablePath(value);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  const markerIndex = normalized.indexOf("/simple_cluster/");
  if (markerIndex >= 0) variants.add(normalized.slice(markerIndex + 1));
  if (/(?:^|\/)simple_cluster\/archive\//.test(normalized)) return Array.from(variants).filter(Boolean);
  for (const prefix of ["/work_dirs/", "/cluster_runs/", "/experiments/"]) {
    const index = normalized.indexOf(prefix);
    if (index >= 0) variants.add(normalized.slice(index + 1));
  }
  return Array.from(variants).filter(Boolean);
}

// tmp/ 为主，simple_cluster/tmp 仅过渡兼容，下版本移除（与 clusterAgentRuntime.py:safe_project_path 强绑定，共13前缀）
export const MANAGED_ARTIFACT_PREFIXES = [
  "tmp/cluster_scheduler/logs/",
  "tmp/cluster_scheduler/",
  "tmp/tmux_logs/",
  "tmp/console_logs/",
  "tmp/",
  "work_dirs/",
  "cluster_runs/",
  "experiments/runs/",
  "experiments/results/",
  "simple_cluster/console_logs/",
  "simple_cluster/tmux_logs/",
  "simple_cluster/tmp/cluster_scheduler/logs/",
  "simple_cluster/tmp/cluster_scheduler/",
  "simple_cluster/tmp/tmux_logs/",
  "simple_cluster/tmp/console_logs/",
  "simple_cluster/tmp/",
];

export function isManagedArtifactPath(value: string): boolean {
  const normalized = normalizeComparablePath(value);
  if (!normalized || normalized.startsWith("[simple]")) return false;
  if (/^\[[^\]]+\]/.test(normalized)) return false;
  return comparablePathVariants(normalized).some((variant) =>
    MANAGED_ARTIFACT_PREFIXES.some((prefix) => variant.startsWith(prefix))
  );
}

export function normalizedPathSet(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const item of paths) {
    for (const variant of comparablePathVariants(item)) out.add(variant);
  }
  return out;
}

export function pathMatchesAny(value: string, candidates: Set<string>): boolean {
  for (const variant of comparablePathVariants(value)) {
    for (const candidate of candidates) {
      const variantArchived = /(?:^|\/)simple_cluster\/archive\//.test(variant);
      const candidateArchived = /(?:^|\/)simple_cluster\/archive\//.test(candidate);
      if (variantArchived !== candidateArchived) continue;
      if (variant === candidate) return true;
      if (variant.startsWith(candidate + "/")) return true;
      if (candidate.startsWith(variant + "/")) return true;
      if (variant.endsWith("/" + candidate)) return true;
      if (candidate.endsWith("/" + variant)) return true;
    }
  }
  return false;
}

export function experimentEntryMatchesDeletion(_entry: ExperimentIndexEntry, _matcher: Partial<ExperimentIndexEntry>): boolean {
  return false;
}

export function filterExperimentIndex(entries: ExperimentIndexEntry[], _blocklist: Partial<ExperimentIndexEntry>[]): ExperimentIndexEntry[] {
  return entries;
}

export function collectDeletedPaths(_blocklist: Partial<ExperimentIndexEntry>[]): string[] {
  return [];
}

export function cleanManagedArtifactPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const value of paths) {
    const normalized = normalizeComparablePath(value);
    if (normalized && isManagedArtifactPath(normalized)) out.add(normalized);
  }
  return Array.from(out);
}

export function schedulerEntryDeleteMatcher(entry: ExperimentIndexEntry): SchedulerEntryDeleteMatcher | undefined {
  const experimentIndex = inferExperimentIndexFromEntry(entry);
  if (!experimentIndex) return undefined;
  return {
    suite: String(entry.suite || "").trim() || undefined,
    experimentIndex,
    workerId: String(entry.worker_id || "").trim() || undefined,
    workerHost: String(entry.worker_host || "").trim() || undefined,
    deleteMode: "row",
  };
}

export function schedulerRowIdentity(state: any, row: any): SchedulerEntryDeleteMatcher | undefined {
  const experimentIndex = String(row.experiment_index ?? row.experiment ?? "").trim();
  if (!/^\d+$/.test(experimentIndex)) return undefined;
  const pids = normalizePidList(row.gpu_process_pids || row.process_pids || row.pids);
  return {
    suite: String(row.suite || inferSuiteFromPlan(String(state?.plan || row.plan || "")) || "").trim() || undefined,
    plan: String(state?.plan || row.plan || "").trim() || undefined,
    experimentIndex,
    workerId: String(row.worker_id || row.workerId || "").trim() || undefined,
    workerHost: String(row.worker_host || row.worker_name || row.server || "").trim() || undefined,
    schedulerSession: String(state?.scheduler_session || row.schedulerSession || "").trim() || undefined,
    session: String(row.session || "").trim() || undefined,
    logPath: String(row.log_path || row.logPath || "").trim() || undefined,
    startedAt: String(row.started_at || row.startedAt || row.testing_started_at || "").trim() || undefined,
    finishedAt: String(row.finished_at || row.finishedAt || "").trim() || undefined,
    processPids: pids.length ? pids : undefined,
    stateUpdatedAt: String(state?.updated_at || row.updated || "").trim() || undefined,
    deleteMode: "row",
  };
}

export function inferExperimentIndexFromEntry(entry: ExperimentIndexEntry): string {
  const values = [
    entry.run_id,
    entry.global_job_id,
    basename(String(entry.hub_job_dir || "")),
    basename(String(entry.worker_job_dir || "")),
    basename(String(entry.native_job_dir || "")),
    basename(dirname(String(entry.config_path || ""))),
  ];
  for (const value of values) {
    const match = String(value || "").match(/^(\d+)(?:[_-]|$)/);
    if (match) return match[1];
  }
  return "";
}

export function filterSchedulerState(state: any, _matchers: SchedulerEntryDeleteMatcher[]): { state: any; changed: boolean } {
  return { state, changed: false };
}

export function schedulerMatcherMatchesPlan(_plan: string, _matcher: SchedulerEntryDeleteMatcher): boolean {
  return false;
}

export function schedulerMatcherMatchesPending(_plan: string, _state: any, _index: any, _matcher: SchedulerEntryDeleteMatcher): boolean {
  return false;
}

export function schedulerMatcherMatchesItem(_plan: string, _item: any, _matcher: SchedulerEntryDeleteMatcher, _state?: any): boolean {
  return false;
}

// 服务器去重收敛说明（提交二）：服务器列表唯一收敛入口为
// tunnel/XshellTunnelSetup.dedupeWorkerTunnels（按 host|user|port + savedSessionPath 合并）；
// GPU 侧 normalizeServerGpu/mergeGpuServers 与诊断侧 dedupeAnomalies 各自保留，
// 本文件通用 JSON 去重已删除，避免多源去重打架（删除台账合并改走调用方显式 Map 去重）。

function schedulerRowKeys(): string[] {
  return ["running_experiments", "testing_experiments", "completed_experiments", "failed_experiments", "stopped_experiments"];
}

function normalizePidList(value: any): string[] {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return raw.map((item) => String(item || "").trim()).filter(Boolean);
}

function parseTime(value: any): number | undefined {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowComparableTime(item: any, state?: any): number | undefined {
  const values = [item.finished_at, item.finishedAt, item.testing_started_at, item.started_at, item.startedAt, state?.updated_at];
  for (const value of values) {
    const parsed = parseTime(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function inferSuiteFromPlan(plan: string): string {
  const normalized = normalizeComparablePath(plan);
  const base = normalized.split("/").pop() || "";
  return base.replace(/\.(ya?ml|json)$/i, "");
}

function basename(value: string): string {
  const normalized = normalizeComparablePath(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function dirname(value: string): string {
  const normalized = normalizeComparablePath(value);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
