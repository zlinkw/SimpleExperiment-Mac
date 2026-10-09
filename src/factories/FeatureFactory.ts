/**
 * FeatureFactory - Feature 工厂
 * 管理 PlanBuilder / Results / Quality / Comparison / DraftPlans 等 FeatureHandler
 * 表驱动映射 WebviewActionCommand -> FeatureKind
 * 遵循 docs/architecture-factory-refactor-plan.md §3.5
 */

import type { FactoryContext } from "./types";

function tryRequire<T>(id: string): T | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(id) as T;
  } catch {
    return undefined;
  }
}

type FeatureModule = Record<string, unknown> & {
  execute?: (args: unknown, ctx: FactoryContext) => Promise<unknown>;
  default?: (args: unknown, ctx: FactoryContext) => Promise<unknown>;
};

// 定案：长任务超时默认不处理，由用户人工处理。run-plan/reproduce-plan 队列 timeoutMs 保持 0（禁用），不设 600s；
// OperationQueue 侧 timeoutMs=0 即禁用定时器（falsy 不设 timer），租约冲突仅阻塞提交不杀长任务（后台化），UI 提示用户手动中止/清理。
function isLongRunningPlanArgs(args: unknown): boolean {
  try {
    const text = JSON.stringify(args || "").toLowerCase();
    return text.includes("run-plan") || text.includes("reproduce-plan")
      || text.includes("runplan") || text.includes("reproduceplan");
  } catch {
    return false;
  }
}

export type FeatureKind =
  | "planBuilder"
  | "results"
  | "lifecycle"
  | "metrics"
  | "comparison"
  | "anomaly"
  | "notifications"
  | "searchTags"
  | "recycleBin"
  | "gpuHistory"
  | "topology"
  | "runOperations"
  | "draftPlans"
  | "quality"
  | "checkpoint";

export interface FeatureHandler<TArgs = unknown, TResult = unknown> {
  readonly kind: FeatureKind;
  execute(args: TArgs, ctx: FactoryContext & { signal?: AbortSignal }): Promise<TResult>;
  queueSpec?(args: TArgs): Pick<import("../core/OperationQueue").OperationSpec, "priority" | "exclusiveKeys" | "coalesceKey" | "timeoutMs">;
}

class GenericFeatureHandler implements FeatureHandler {
  public readonly kind: FeatureKind;
  private readonly impl: (args: unknown, ctx: FactoryContext) => Promise<unknown>;
  constructor(kind: FeatureKind, impl: (args: unknown, ctx: FactoryContext) => Promise<unknown>) {
    this.kind = kind;
    this.impl = impl;
  }
  async execute(args: unknown, ctx: FactoryContext & { signal?: AbortSignal }): Promise<unknown> {
    return this.impl(args, ctx);
  }
  queueSpec(args: unknown): Pick<import("../core/OperationQueue").OperationSpec, "priority" | "exclusiveKeys" | "coalesceKey" | "timeoutMs"> {
    // run-plan/reproduce-plan 长任务禁用队列超时（timeoutMs=0=禁用，用户手动中止/清理）；
    // runOperations kind 默认即长任务，其余短任务保持 30s。不设 600s 默认杀。
    const longRunning = this.kind === "runOperations" || isLongRunningPlanArgs(args);
    return { priority: 0 as unknown as import("../core/OperationQueue").OperationSpec["priority"], exclusiveKeys: [this.kind] as string[], coalesceKey: undefined, timeoutMs: longRunning ? 0 : 30000 };
  }
}

export interface FeatureFactory {
  create(kind: FeatureKind): FeatureHandler;
  createAll(): Record<FeatureKind, FeatureHandler>;
  handlerForCommand(command: string): FeatureHandler | undefined;
  createByName(name: string): FeatureHandler | undefined;
}

const commandToKind: Record<string, FeatureKind> = {
  validatePlan: "planBuilder",
  dryRunPlan: "planBuilder",
  runPlan: "runOperations",
  stopExperiment: "lifecycle",
  retryExperiment: "lifecycle",
  reproducePlan: "planBuilder",
  parseResults: "results",
  refreshResults: "results",
  runQualityGate: "quality",
  runStatistics: "quality",
  exportPaperTable: "results",
  checkClaimEvidence: "quality",
  checkOutputContract: "quality",
  parseCaseLevel: "results",
  runLeakageCheck: "anomaly",
  runSubgroupAnalysis: "results",
  exportCaseAnalysis: "comparison",
  planCheckpointRetention: "checkpoint",
  inspectDataset: "anomaly",
  exportPlottingContract: "comparison",
  restorePlanText: "draftPlans",
  buildExperimentMatrix: "planBuilder",
  comparison: "comparison",
  metrics: "metrics",
  anomaly: "anomaly",
  notifications: "notifications",
  searchTags: "searchTags",
  recycleBin: "recycleBin",
  gpuHistory: "gpuHistory",
  topology: "topology",
  draftPlans: "draftPlans",
};

const featureImplHints: Record<FeatureKind, string> = {
  planBuilder: "features/PlanBuilder",
  results: "features/Results",
  lifecycle: "features/Lifecycle",
  metrics: "features/Metrics",
  comparison: "features/Comparison",
  anomaly: "features/Anomaly",
  notifications: "features/Notifications",
  searchTags: "features/SearchTags",
  recycleBin: "features/RecycleBin",
  gpuHistory: "features/GpuHistoryState",
  topology: "features/TopologyMode",
  runOperations: "features/RunOperations",
  draftPlans: "features/DraftPlans",
  quality: "features/Quality",
  checkpoint: "features/Checkpoint",
};

function getFeatureModule(hint: string): FeatureModule | undefined {
  return tryRequire<FeatureModule>(`../${hint}`);
}

export class DefaultFeatureFactory implements FeatureFactory {
  private readonly cache = new Map<FeatureKind, FeatureHandler>();
  private readonly deps: Record<string, unknown>;
  constructor(deps: Record<string, unknown> = {}) {
    this.deps = deps;
  }

  create(kind: FeatureKind): FeatureHandler {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    let handler: FeatureHandler | undefined;
    // 尝试按需委托旧模块（门面包裹旧实现，零行为变更）
    const hint = featureImplHints[kind];
    if (hint) {
      const mod = getFeatureModule(hint);
      // 若模块存在，包装为 FeatureHandler（保持原逻辑不变）
      if (mod) {
        handler = new GenericFeatureHandler(kind, async (args: unknown, ctx: FactoryContext) => {
          // 优先调用模块的默认导出或同名方法
          const rec = mod as Record<string, unknown>;
          const fn = (rec["execute"] as ((a: unknown, c: FactoryContext) => Promise<unknown>) | undefined)
            || (rec["default"] as ((a: unknown, c: FactoryContext) => Promise<unknown>) | undefined)
            || (rec[kind] as ((a: unknown, c: FactoryContext) => Promise<unknown>) | undefined)
            || (rec[`${kind}Handler`] as ((a: unknown, c: FactoryContext) => Promise<unknown>) | undefined);
          if (typeof fn === "function") return fn(args, ctx);
          throw new Error(`Feature ${kind} module ${hint} has no executable handler.`);
        });
      }
    }
    if (!handler) handler = new GenericFeatureHandler(kind, async () => {
      throw new Error(`Feature ${kind} is unavailable; no implementation module was loaded.`);
    });
    this.cache.set(kind, handler);
    return handler;
  }

  createAll(): Record<FeatureKind, FeatureHandler> {
    const kinds: FeatureKind[] = [
      "planBuilder", "results", "lifecycle", "metrics", "comparison",
      "anomaly", "notifications", "searchTags", "recycleBin",
      "gpuHistory", "topology", "runOperations", "draftPlans", "quality", "checkpoint",
    ];
    const record = {} as Record<FeatureKind, FeatureHandler>;
    for (const k of kinds) record[k] = this.create(k);
    return record;
  }

  handlerForCommand(command: string): FeatureHandler | undefined {
    const kind = commandToKind[command];
    if (!kind) return undefined;
    return this.create(kind);
  }

  createByName(name: string): FeatureHandler | undefined {
    const kinds = new Set<string>([
      "planBuilder", "results", "lifecycle", "metrics", "comparison",
      "anomaly", "notifications", "searchTags", "recycleBin",
      "gpuHistory", "topology", "runOperations", "draftPlans", "quality", "checkpoint",
    ]);
    if (kinds.has(name)) return this.create(name as FeatureKind);
    // 也支持按命令名查找
    return this.handlerForCommand(name);
  }
}
