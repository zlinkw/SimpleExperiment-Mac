export const TOPOLOGY_MODES = ["single_worker", "worker_pool", "hub_worker"] as const;

const TOPOLOGY_ALIASES: Record<string, TopologyMode> = {
  standalone: "single_worker",
  "single-worker": "single_worker",
  single: "single_worker",
  worker_only: "worker_pool",
  workeronly: "worker_pool",
  "worker-only": "worker_pool",
  multi_worker: "worker_pool",
  workers: "worker_pool",
  hub_available: "hub_worker",
  "hub-available": "hub_worker",
  hub: "hub_worker",
};

export type TopologyMode = typeof TOPOLOGY_MODES[number];
export type TopologyModeSource = "explicit" | "legacy_hub_worker" | "unconfirmed" | "invalid";

export interface TopologyInventory {
  hubConfigured: boolean;
  enabledWorkerIds?: readonly string[];
  enabledWorkerCount?: number;
}

export interface TopologyAssessment {
  mode?: TopologyMode;
  source: TopologyModeSource;
  valid: boolean;
  requiresConfirmation: boolean;
  hubAllowed: boolean;
  workerCount: number;
  schedulerOwner: string;
  stateOwner: string;
  issues: string[];
}

export function normalizeTopologyMode(value: unknown): TopologyMode | undefined {
  const mode = String(value || "").trim();
  if ((TOPOLOGY_MODES as readonly string[]).includes(mode)) return mode as TopologyMode;
  return TOPOLOGY_ALIASES[mode.toLowerCase()];
}

export function assessProjectTopology(configuredMode: unknown, inventory: TopologyInventory): TopologyAssessment {
  const rawMode = String(configuredMode || "").trim();
  const explicitMode = normalizeTopologyMode(rawMode);
  const workerCount = topologyWorkerCount(inventory);
  const hubConfigured = inventory.hubConfigured === true;

  if (rawMode && !explicitMode) {
    return assessment(undefined, "invalid", workerCount, false, [`不支持的拓扑模式：${rawMode}`]);
  }
  if (explicitMode) {
    return assessment(explicitMode, "explicit", workerCount, hubConfigured, topologyIssues(explicitMode, hubConfigured, workerCount));
  }
  if (hubConfigured && workerCount >= 1) {
    return assessment("hub_worker", "legacy_hub_worker", workerCount, true, []);
  }
  return assessment(undefined, "unconfirmed", workerCount, hubConfigured, [
    workerCount > 0
      ? "仅 Worker 项目需要先明确选择单 Worker或仅多 Worker模式。"
      : "需要先选择拓扑模式并配置对应的 Worker。",
  ]);
}

export function topologyIssues(mode: TopologyMode, hubConfigured: boolean, workerCount: number): string[] {
  const issues: string[] = [];
  if (mode === "single_worker") {
    if (hubConfigured) issues.push("单 Worker模式不能启用 Hub。");
    if (workerCount !== 1) issues.push(`单 Worker模式需要恰好一台启用的 Worker，当前为 ${workerCount} 台。`);
  } else if (mode === "worker_pool") {
    if (hubConfigured) issues.push("仅多 Worker模式不能启用 Hub。");
    if (workerCount < 2) issues.push(`仅多 Worker模式需要至少两台启用的 Worker，当前为 ${workerCount} 台。`);
  } else {
    if (!hubConfigured) issues.push("Hub 可用模式需要配置 Hub。");
    if (workerCount < 1) issues.push("Hub 可用模式需要至少一台启用的 Worker。");
  }
  return issues;
}

function topologyWorkerCount(inventory: TopologyInventory): number {
  if (Array.isArray(inventory.enabledWorkerIds)) {
    return new Set(inventory.enabledWorkerIds.map((value) => String(value || "").trim()).filter(Boolean)).size;
  }
  const count = Number(inventory.enabledWorkerCount || 0);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function assessment(
  mode: TopologyMode | undefined,
  source: TopologyModeSource,
  workerCount: number,
  hubConfigured: boolean,
  issues: string[],
): TopologyAssessment {
  const hubAllowed = mode === "hub_worker";
  const schedulerOwner = mode === "single_worker"
    ? "Worker 本机调度"
    : mode === "worker_pool"
      ? "各 Worker 独立分片调度"
      : mode === "hub_worker"
        ? "Hub 全局调度"
        : "尚未确认";
  const stateOwner = mode === "hub_worker" ? "Hub 汇总索引" : mode ? "Worker 本机项目目录" : "尚未确认";
  return {
    mode,
    source,
    valid: issues.length === 0,
    requiresConfirmation: source === "unconfirmed" || source === "invalid",
    hubAllowed,
    workerCount,
    schedulerOwner,
    stateOwner,
    issues,
  };
}
