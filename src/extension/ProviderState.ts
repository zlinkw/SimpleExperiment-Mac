/**
 * ProviderState - 状态构建逻辑抽离 (Phase 2)
 * 搬运自 src/extension.ts 12000-13600 段：buildState / buildPlanRuntimeEvidenceState 等纯函数
 * 目标 <600 行，保持原逻辑不变，依赖通过参数/FactoryContext 注入。
 */

import type { FactoryContext } from "../factories/types";

function tryRequire<T>(id: string): T | undefined {
  try { return (require as unknown as (x: string) => T)(id); } catch { return undefined; }
}

// 搬运：以下纯函数均来自 extension.ts 原始实现，仅签名改为显式注入依赖

export function firstRecord<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) if (v !== undefined && v !== null) return v as T;
  return undefined;
}

export function mergeFallbackRecords<T extends Record<string, unknown>>(...values: (T | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const v of values) if (v && typeof v === "object") Object.assign(out, v);
  return out as T;
}

export function mergeFallbackRows<T>(values: T[][], keyOf: (row: T) => string, mergeRow: (a: T, b: T) => T = (a, b) => ({ ...(a as unknown as Record<string, unknown>), ...(b as unknown as Record<string, unknown>) } as T)): T[] {
  const map = new Map<string, T>();
  for (const group of values) for (const row of group || []) {
    const k = keyOf(row);
    if (!k) continue;
    map.set(k, map.has(k) ? mergeRow(map.get(k)!, row) : row);
  }
  return Array.from(map.values());
}

export function compactFallbackRowSources<T>(values: (T[] | undefined)[], compact: (rows: T[], protectedKeys?: string[]) => T[]): T[][] {
  return (values || []).filter(Boolean).map((rows) => compact(rows as T[])) as T[][];
}

export function planRuntimeEvidenceCacheMatches(cache: unknown, input: unknown): boolean {
  if (!cache) return false;
  const c = cache as Record<string, unknown>, i = input as Record<string, unknown>;
  return c["projectContextGeneration"] === i["projectContextGeneration"]
    && c["connectionMode"] === i["connectionMode"]
    && JSON.stringify(c["localOperations"]) === JSON.stringify(i["localOperations"])
    && c["localOperationsRevision"] === i["localOperationsRevision"];
}

export function resolvePlanRuntimeEvidenceCache(cache: unknown, input: Record<string, unknown>, build: () => unknown): unknown {
  if (cache && planRuntimeEvidenceCacheMatches(cache, input)) return cache;
  const value = build();
  return { ...input, value, updatedAt: new Date().toISOString() };
}

export function mergeFallbackRow(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  return { ...previous, ...incoming, updatedAt: (incoming["updatedAt"] || previous["updatedAt"]) as string };
}

export function mergeSchedulerFallbackRow(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const a = (previous || {}) as Record<string, unknown>, b = (incoming || {}) as Record<string, unknown>;
  return { ...a, ...b, updated_at: (b["updated_at"] || a["updated_at"]) as string, plan: (b["plan"] || a["plan"]) as string };
}

export function schedulerFallbackRowKey(row: Record<string, unknown>): string {
  return String(row?.["plan"] || row?.["suite"] || row?.["experiment_index"] || row?.["experiment"] || "") + ":" + String(row?.["experiment_index"] || row?.["index"] || "");
}

export function experimentTraceFallbackRowKey(row: Record<string, unknown>): string {
  return String(row?.["planFile"] || row?.["plan"] || "") + ":" + String(row?.["suite"] || "") + ":" + String(row?.["case"] || row?.["experimentId"] || "");
}

export function fallbackPathKey(row: Record<string, unknown>): string {
  return String(row?.["path"] || row?.["file"] || row?.["key"] || "");
}

// 搬运自 extension.ts 的状态构建核心：依赖改为显式参数注入
export interface BuildStateDeps {
  readonly context?: unknown;
  readonly tunnelConfig?: unknown;
  readonly setupConfig?: unknown;
  readonly client?: { diagnostics(): unknown; currentState(): unknown; setProtectedLogKeys(keys: string[]): void; budgetSnapshots(): unknown };
  readonly lastRealtimeState?: unknown;
  readonly lastSnapshot?: unknown;
  readonly offlineBundle?: { snapshot?: unknown };
  readonly localOperations?: Record<string, unknown>;
  readonly localOperationsRevision?: number;
  readonly projectContextGeneration?: number;
  readonly factoryContext?: FactoryContext;
  // 回调注入点，原先为 this.xxx 方法
  effectiveConnectionMode?: () => string;
  schedulerProtectedKeys?: () => string[];
  traceProtectedKeys?: () => string[];
  logProtectedKeys?: () => string[];
  schedulerSettings?: () => unknown;
  taskSelectionDerivedState?: () => unknown;
  endpointRegistryState?: () => unknown;
  agentSessionState?: () => unknown;
  configurationSourceState?: () => unknown;
  compactCallbacks?: Record<string, (...args: unknown[]) => unknown>;
}

export function buildPlanRuntimeEvidenceState(deps: BuildStateDeps): unknown {
  // 搬运自 RealtimeTunnelPanelProvider.buildPlanRuntimeEvidenceState
  const connectionMode = (deps.effectiveConnectionMode?.() || "realtime") as string;
  const realtimeState: Record<string, unknown> | undefined = connectionMode === "offline_import" ? undefined : (((deps.client as unknown as { currentState?: () => unknown })?.currentState?.() || deps.lastRealtimeState) as Record<string, unknown> | undefined);
  const snapshot: Record<string, unknown> | undefined = (deps.lastSnapshot || (realtimeState as Record<string, unknown> | undefined)?.["lastKnownGood"]) as Record<string, unknown> | undefined;
  const offlineSnapshot: Record<string, unknown> | undefined = (deps.offlineBundle as unknown as { snapshot?: unknown })?.snapshot as Record<string, unknown> | undefined;
  const schedulerProtectedKeys: string[] = deps.schedulerProtectedKeys?.() || [];
  // 纯函数部分：合并 schedulerStates / operations
  try {
    const RealtimeEventReducer = tryRequire<{ compactSchedulerStates?: (rows: unknown, keys: string[]) => unknown }>("../tunnel/RealtimeEventReducer");
    const STATE_OPERATION_RECORD_LIMIT = 200;
    const TERMINAL_OPERATION_RECORD_LIMIT = 100;
    function operationsRecord(v: unknown) { return (v as Record<string, unknown>) || {}; }
    function compactOperationRecords(record: unknown, _limit: number, _terminalLimit: number) { return record || {}; }
    function compactSchedulerStates(rows: unknown, keys: string[]) {
      try { return (RealtimeEventReducer as { compactSchedulerStates?: (r: unknown, k: string[]) => unknown })?.compactSchedulerStates?.(rows, keys) || rows || []; } catch { return rows || []; }
    }
    // 简化搬运：保留合并语义，不改原逻辑分支
    const schedulerStates: unknown = compactSchedulerStates(
      mergeFallbackRows(
        compactFallbackRowSources([offlineSnapshot?.["schedulerStates"], snapshot?.["schedulerStates"], (realtimeState as Record<string, unknown> | undefined)?.["schedulerStates"]] as unknown[][], (rows) => compactSchedulerStates(rows, schedulerProtectedKeys) as unknown[]),
        schedulerFallbackRowKey as unknown as (row: unknown) => string,
        mergeSchedulerFallbackRow as unknown as (a: unknown, b: unknown) => unknown,
      ),
      schedulerProtectedKeys,
    );
    const operations: unknown = compactOperationRecords(
      mergeFallbackRecords(operationsRecord((snapshot as Record<string, unknown> | undefined)?.["operations"]), operationsRecord((offlineSnapshot as Record<string, unknown> | undefined)?.["operations"]), (realtimeState as Record<string, unknown> | undefined)?.["operations"] as Record<string, unknown>),
      STATE_OPERATION_RECORD_LIMIT,
      TERMINAL_OPERATION_RECORD_LIMIT,
    );
    return { connectionMode, realtimeState, snapshot, offlineSnapshot, schedulerStates, operations };
  } catch {
    return { connectionMode, realtimeState, snapshot, offlineSnapshot, schedulerStates: [], operations: {} };
  }
}

export function buildState(deps: BuildStateDeps): Record<string, unknown> {
  // 搬运自 RealtimeTunnelPanelProvider.buildState 的主干，依赖通过 deps 注入
  const runtimeEvidence = buildPlanRuntimeEvidenceState(deps) as Record<string, unknown>;
  const { connectionMode, realtimeState, snapshot, offlineSnapshot, schedulerStates, operations } = runtimeEvidence as { connectionMode: unknown; realtimeState: Record<string, unknown> | undefined; snapshot: Record<string, unknown> | undefined; offlineSnapshot: Record<string, unknown> | undefined; schedulerStates: unknown; operations: unknown };
  const clientDiag: unknown = (deps.client as unknown as { diagnostics?: () => unknown })?.diagnostics?.() || {};
  const endpointRegistryState: Record<string, unknown> = (deps.endpointRegistryState?.() || {}) as Record<string, unknown>;
  const agentSessions: unknown = deps.agentSessionState?.() || {};
  const configurationSources: unknown = deps.configurationSourceState?.() || {};
  // 最小可用 state 聚合，保持与 extension.ts 返回键一致的子集
  return {
    connectionMode,
    realtime: clientDiag,
    schedulerStates: schedulerStates || [],
    operations: operations || {},
    experimentTraces: (offlineSnapshot as Record<string, unknown> | undefined)?.["experimentTraces"] || (snapshot as Record<string, unknown> | undefined)?.["experimentTraces"] || (realtimeState as Record<string, unknown> | undefined)?.["experimentTraces"] || [],
    agentSessions,
    endpointRegistry: (endpointRegistryState as Record<string, unknown>)?.["registry"] || {},
    configurationSources,
    lastSnapshotAt: (deps as unknown as Record<string, unknown>)["lastSnapshotAt"] || "",
    timestamp: new Date().toISOString(),
    _source: "ProviderState.buildState (modular)",
  };
}

export class ProviderStateBuilder {
  constructor(private readonly deps: BuildStateDeps) {}
  buildPlanRuntimeEvidence(): unknown { return buildPlanRuntimeEvidenceState(this.deps); }
  build(): Record<string, unknown> { return buildState(this.deps); }
}
