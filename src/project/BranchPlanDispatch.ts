import { callPluginRpc, resolveInstanceByWorkspace } from "../cli/LocalApiClient";

/**
 * 块C：管理窗口把 PLAN 选择/提交/进度路由到目标分支实例。路由只走 A 块已验证的
 * 实例握手通道（resolveInstanceByWorkspace → callPluginRpc 显式 discoveryPath+workspace
 * pin），绝不按记录时间猜实例、绝不向未确认存活的实例发送请求；提交只调用分支窗口
 * 自己的既有 workflow.plan/workflow.run 已验证入口（参数形状取自其真实实现），产物
 * 冲突等确认仍留在该分支窗口内进行。本模块不做任何 Git/远端写操作。
 */

export interface BranchRoute {
  /** 已握手实例身份（pid:startedAt），作为每次 RPC 的 pin。 */
  instanceId: string;
  workspace: string;
  discoveryPath: string;
}

export type BranchRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** 唯一存活实例解析：歧义/离线/超预算一律如实抛错（继承 LocalApiClient 的拒绝语义）。 */
export async function resolveBranchRoute(workspace: string): Promise<BranchRoute> {
  const row = await resolveInstanceByWorkspace("experiment", workspace);
  return { instanceId: String(row.instanceId), workspace, discoveryPath: row.discoveryPath };
}

/** 绑定路由的 RPC 通道：每条请求都做真实握手并核对 pin 与工作区一致。 */
export function branchRpc(route: BranchRoute): BranchRpc {
  return (method, params) => callPluginRpc("experiment", method, params, route.instanceId,
    { discoveryPath: route.discoveryPath, workspace: route.workspace }) as Promise<unknown>;
}

export interface BranchPlanRef {
  planFile: string;
  planId: string;
  updatedAt: string;
  metadataTruncated: boolean;
}

/** 分支窗口的本地 PLAN 元数据（plans.list 原样行 → 选择所需的最小字段）。 */
export async function listBranchPlans(rpc: BranchRpc): Promise<BranchPlanRef[]> {
  const value = await rpc("plans.list", {}) as { plans?: unknown };
  const rows = Array.isArray(value?.plans) ? value.plans : [];
  const out = new Map<string, BranchPlanRef>();
  for (const raw of rows) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const planFile = String(row.planFile || row.file || "");
    if (!planFile || out.has(planFile)) continue;
    out.set(planFile, { planFile, planId: String(row.planId || planFile), updatedAt: String(row.updatedAt || ""), metadataTruncated: row.metadataTruncated === true });
  }
  return [...out.values()];
}

export interface BranchRunPreview {
  /** true 仅当分支窗口明确给出可提交结论；VALIDATION_REQUIRED 单独放行（提交后由该窗口执行校验流程）。 */
  ready: boolean;
  /** 需要向用户如实展示的下一步说明（blocker.recommendedAction/nextAction 原文）。 */
  guidance: string;
  /** 提交后分支窗口仍可能要求的确认提示（校验/产物），绝不静默略过。 */
  needsValidation: boolean;
  raw: unknown;
}

/** workflow.plan（不带 autoPrepare/confirm）= 只读路由预览；本模块绝不代为 prepare。 */
export async function previewBranchRun(rpc: BranchRpc, workspace: string, plan: BranchPlanRef): Promise<BranchRunPreview> {
  const value = await rpc("workflow.plan", { workspace, planFile: plan.planFile, planId: plan.planId }) as Record<string, any>;
  const blocker = (value && typeof value.blocker === "object" && value.blocker) || {};
  if (value?.ok === true) return { ready: true, guidance: "", needsValidation: false, raw: value };
  const code = String(blocker.code || "");
  const guidance = String(blocker.recommendedAction || value?.nextAction || code || "分支窗口未给出可执行结论。");
  // workflow.run(forRun=true) 不要求先跑 plan.validate；其余缺件（基础设施/PLAN 未选定）在 run 里同样拒绝。
  const needsValidation = code === "VALIDATION_REQUIRED";
  return { ready: needsValidation, guidance: needsValidation ? `该 PLAN 尚未校验：提交后由分支窗口执行校验流程（${guidance}）` : guidance, needsValidation, raw: value };
}

export type BranchRunOutcome =
  | { kind: "started"; operationId: string; raw: unknown }
  | { kind: "notStarted"; reason: string; raw: unknown }
  | { kind: "unknown"; error: string };

/**
 * workflow.run 的真实参数形状来自其实现（workspace/planFile/planId/debugMode）。
 * JSON-RPC 业务错误=确定未启动（可复述原因）；传输层失败/超时=结果未知，本模块绝不重发，
 * 调用方必须提示到分支窗口或稍后用运行状态核实。
 */
export async function submitBranchRun(rpc: BranchRpc, workspace: string, plan: BranchPlanRef): Promise<BranchRunOutcome> {
  let value: unknown;
  try {
    value = await rpc("workflow.run", { workspace, planFile: plan.planFile, planId: plan.planId, debugMode: false });
  } catch (error) {
    const deterministic = Boolean(error && typeof error === "object" && (error as { apiCode?: unknown }).apiCode !== undefined);
    const text = error instanceof Error ? error.message : String(error);
    if (deterministic) return { kind: "notStarted", reason: text || "分支窗口拒绝了本次提交。", raw: (error as { apiData?: unknown })?.apiData };
    return { kind: "unknown", error: text };
  }
  const row = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  if (row.ok === true && row.started === true && String(row.operationId || ""))
    return { kind: "started", operationId: String(row.operationId), raw: value };
  const blocker = (row.blocker && typeof row.blocker === "object" && row.blocker) || {};
  return { kind: "notStarted", reason: String(blocker.code || blocker.recommendedAction || row.message || "分支窗口未启动该 PLAN。"), raw: value };
}

export interface BranchRunRow {
  operationId: string;
  type: string;
  status: string;
  message: string;
  planFile: string;
  startedAt: string;
  finishedAt: string;
}

/** 该分支实例最近的操作记录（operations.list 已按时间倒序）；只取有界前若干条展示。 */
export async function branchRunProgress(rpc: BranchRpc, limit = 8): Promise<BranchRunRow[]> {
  const value = await rpc("operations.list", { limit: 200 }) as { records?: unknown };
  const rows = Array.isArray(value?.records) ? value.records : [];
  return rows.slice(0, Math.max(1, Math.min(50, limit))).map((raw) => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      operationId: String(row.operationId || ""),
      type: String(row.type || ""),
      status: String(row.status ?? row.state ?? ""),
      message: String(row.message || "").slice(0, 200),
      planFile: String(row.planFile || ""),
      startedAt: String(row.startedAt || ""),
      finishedAt: String(row.finishedAt || ""),
    };
  });
}
