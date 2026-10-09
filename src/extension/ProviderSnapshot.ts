/**
 * ProviderSnapshot - 快照/合并逻辑抽离 (Phase 2)
 * 搬运自 src/extension.ts 中 syncState / StateMerge / compact* / manualSnapshot 相关
 * 保持原逻辑不变，依赖通过参数注入。
 */

import type { FactoryContext } from "../factories/types";
import * as syncState from "../syncState";

export interface SnapshotMergeDeps {
  readonly lastSnapshot?: Record<string, unknown>;
  readonly lastRealtimeState?: Record<string, unknown>;
  readonly offlineBundle?: { snapshot?: Record<string, unknown> };
  readonly factoryContext?: FactoryContext;
}

export function mergeRealtimeSnapshotWithFallback(deps: SnapshotMergeDeps): Record<string, unknown> {
  // 搬运自 buildPlanRuntimeEvidenceState 中的 fallback 合并策略
  const { lastSnapshot, lastRealtimeState, offlineBundle } = deps;
  const realtimeState: any = lastRealtimeState || {};
  const snapshot: any = lastSnapshot || realtimeState?.lastKnownGood;
  const offlineSnapshot: any = offlineBundle?.snapshot;
  // 优先 realtime，其次 snapshot，最后 offline
  return {
    schedulerStates: firstNonEmpty(
      realtimeState?.schedulerStates,
      snapshot?.schedulerStates,
      offlineSnapshot?.schedulerStates,
    ) || [],
    experimentTraces: firstNonEmpty(
      realtimeState?.experimentTraces,
      snapshot?.experimentTraces,
      offlineSnapshot?.experimentTraces,
    ) || [],
    gpu: firstNonEmpty(
      realtimeState?.gpu,
      snapshot?.gpu,
      offlineSnapshot?.gpu,
    ) || {},
    operations: firstNonEmpty(
      realtimeState?.operations,
      snapshot?.operations,
      offlineSnapshot?.operations,
    ) || {},
    logs: firstNonEmpty(
      realtimeState?.logs,
      snapshot?.logs,
      offlineSnapshot?.logs,
    ) || {},
  };
}

function firstNonEmpty<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) if (v !== undefined && v !== null && (Array.isArray(v) ? (v as unknown[]).length : Object.keys(v as object).length)) return v as T;
  return values.find((v) => v !== undefined && v !== null) as T | undefined;
}

export function compactMergedGpuForWebview(...gpus: unknown[]): unknown {
  // 搬运自 extension.ts compactMergedGpuForWebview 的简化版：合并去重
  const out: Record<string, unknown> = {};
  for (const g of gpus) if (g && typeof g === "object") Object.assign(out, g as Record<string, unknown>);
  return out;
}

type SyncStateModule = {
  filterExperimentIndex: (a: unknown[], b: unknown[]) => unknown[];
  filterSchedulerState: (a: Record<string, unknown>, b: unknown[]) => { state: unknown; changed: boolean };
};

export function applySyncStateFilters(
  experimentIndex: unknown[],
  schedulerState: unknown,
  deletedExperiments: unknown[],
  deletedSchedulerMatchers: unknown[],
): { filteredExperiments: unknown[]; filteredSchedulerState: unknown; changed: boolean } {
  // 委托给 syncState 纯函数，保持原逻辑不变
  const ss = syncState as unknown as SyncStateModule;
  const filteredExperiments = ss.filterExperimentIndex(
    experimentIndex as unknown[],
    deletedExperiments as unknown[],
  ) as unknown[];
  const sched = ss.filterSchedulerState(
    (schedulerState as Record<string, unknown>) || {},
    deletedSchedulerMatchers as unknown[],
  );
  return {
    filteredExperiments,
    filteredSchedulerState: sched.state,
    changed: filteredExperiments.length !== (experimentIndex as any[])?.length || sched.changed,
  };
}

export interface ManualSnapshotDeps {
  readonly provider?: {
    manualSnapshot?: () => Promise<void>;
    lastSnapshotAt?: string;
    lastSnapshot?: unknown;
  };
  readonly factoryContext?: FactoryContext;
}

export async function requestManualSnapshot(deps: ManualSnapshotDeps): Promise<{ ok: boolean; at?: string }> {
  // 搬运自 RealtimeTunnelPanelProvider.manualSnapshot() 的调用门面
  try {
    await deps.provider?.manualSnapshot?.();
    return { ok: true, at: new Date().toISOString() };
  } catch {
    return { ok: false };
  }
}

export function compactStateMergeDiagnostics(state: Record<string, unknown>): Record<string, unknown> {
  // 搬运自 extension.ts compactDiagnostics 的简化投影，供快照层复用
  return {
    schedulerRows: Array.isArray((state as Record<string, unknown>)["schedulerStates"]) ? ((state as Record<string, unknown>)["schedulerStates"] as unknown[]).length : 0,
    experimentTraces: Array.isArray((state as Record<string, unknown>)["experimentTraces"]) ? ((state as Record<string, unknown>)["experimentTraces"] as unknown[]).length : 0,
    operations: typeof (state as Record<string, unknown>)["operations"] === "object" ? Object.keys((state as Record<string, unknown>)["operations"] as object || {}).length : 0,
    timestamp: new Date().toISOString(),
  };
}

export class ProviderSnapshot {
  constructor(private readonly deps: SnapshotMergeDeps) {}
  merged(): Record<string, unknown> { return mergeRealtimeSnapshotWithFallback(this.deps); }
  diag(state: Record<string, unknown>) { return compactStateMergeDiagnostics(state); }
  filters(experiments: unknown[], schedState: unknown, deletedExps: unknown[], deletedSched: unknown[]) {
    return applySyncStateFilters(experiments, schedState, deletedExps, deletedSched);
  }
}
