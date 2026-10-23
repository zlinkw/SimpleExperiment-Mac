// 隔离产物独立永久删除审核（2026-10-23 行数门禁返修：从 PlanCleanupHost 四个公开方法
// assertIsolatedReview / isolatedReviewEvent / verifyIsolatedAbsence / openIsolatedBatchReviews
// 逐行原样提取的独立职责模块；绑定校验、账本事件、absence 强证明与 QuickPick 流程、
// 全部错误码与文案保持原样。类方法以 IsolatedReviewContext 委托，行为与身份围栏不变）。
// vscode 仅经 ctx 门面注入（宿主传入其自身命名空间，行为一致）；顶层运行时 require 会绕过
// 测试侧按模块名拦截的 vscode 桩，import type 在编译期擦除、不产生运行时依赖。
import type * as vscodeNs from "vscode";
import { cleanupDigest, cleanupError, type CleanupOperation } from "../features/PlanCleanup";
import { loadIsolatedBatchLedger, eligibleIsolatedReviews, type ReviewedIsolatedBatch, type IsolatedReviewEvent } from "../features/PlanIsolatedBatchLedger";
import { resolveIsolatedBatchReview, recordIsolatedReviewEvent, assertLiveIsolatedBoundary } from "../features/PlanIsolatedReview";

export interface IsolatedReviewContext {
  host: any;
  vscode: typeof vscodeNs;
  root: string;
  service: { status(operationId: string): Promise<CleanupOperation>; registeredIsolationSource?(id: string): Promise<string | undefined> };
  assertWorkspace(): void;
  currentNode(id: string): any;
  open(planFile: string, operationId?: string, job?: any, isolatedOperationId?: string): any;
}

export async function assertIsolatedReviewBinding(ctx: IsolatedReviewContext, id: string) {
  ctx.assertWorkspace();
  const file = ctx.host.isolatedReplacementLedgerFileLocal?.();
  if (!file) cleanupError("ISOLATED_BATCH_LEDGER_UNAVAILABLE");
  const queue = await ctx.host.loadDistributedQueue(ctx.root);
  const binding = await resolveIsolatedBatchReview(file, ctx.root, id, queue, operationId => ctx.service.status(operationId));
  const original: CleanupOperation = binding?.operation || await ctx.service.status(id);
  if (original.preview.action !== "isolate" || !original.preview.rows.some(row => row.disposition === "isolate")) cleanupError("NOT_ISOLATED_OPERATION");
  for (const row of original.preview.rows.filter(row => row.disposition === "isolate")) {
    const current = ctx.currentNode(row.node.id);
    if (cleanupDigest({ ...current, error: undefined }) !== cleanupDigest({ ...row.node, error: undefined })) cleanupError("SERVER_IDENTITY_CHANGED");
  }
  ctx.assertWorkspace();
  return binding;
}

export async function recordIsolatedReviewEventFor(ctx: IsolatedReviewContext, originalId: string, kind: IsolatedReviewEvent["kind"], reviewId?: string, detail?: string) {
  const file = ctx.host.isolatedReplacementLedgerFileLocal?.();
  if (!file) cleanupError("ISOLATED_BATCH_LEDGER_UNAVAILABLE");
  const batches = await loadIsolatedBatchLedger(file);
  const matches = batches.filter(batch => batch.projectRoot === ctx.root && batch.plans.some(plan => plan.cleanup.some(record => record.cleanupOperationId === originalId)));
  if (!matches.length) return; // Standalone isolation keeps its ordinary operation history.
  if (matches.length !== 1) cleanupError("ISOLATED_OPERATION_BATCH_CONFLICT");
  await recordIsolatedReviewEvent(file, matches[0].batchId, originalId, { kind, reviewOperationId: reviewId, detail });
}

export async function verifyIsolatedTargetsAbsence(ctx: IsolatedReviewContext, originalId: string) {
  const binding = await assertIsolatedReviewBinding(ctx, originalId);
  const original: CleanupOperation = binding?.operation || await ctx.service.status(originalId);
  for (const row of original.preview.rows.filter(row => row.disposition === "isolate")) {
    const proof = await ctx.host.simpleSftpApiCall("files.cleanup.inspect", { node: row.node,
      target: { relativePath: row.destination, type: row.type }, allowMissing: true, presenceOnly: true, observeExecutors: true });
    if (proof?.ok !== true || proof.executorsChecked !== true || !Array.isArray(proof.executors) || proof.executors.length
      || proof.target?.missing !== true || !row.rootIdentity || !proof.rootIdentity || cleanupDigest(proof.rootIdentity) !== cleanupDigest(row.rootIdentity))
      cleanupError("ISOLATED_DELETE_UNVERIFIED", "隔离目标仍存在、执行窗口未退出或身份未知；保留记录，不自动重发。");
  }
}

export async function openIsolatedBatchReviewFlow(ctx: IsolatedReviewContext) {
  ctx.assertWorkspace();
  const file = ctx.host.isolatedReplacementLedgerFileLocal?.();
  if (!file) cleanupError("ISOLATED_BATCH_LEDGER_UNAVAILABLE");
  const batches = await loadIsolatedBatchLedger(file) as ReviewedIsolatedBatch[];
  const queue = await ctx.host.loadDistributedQueue(ctx.root);
  const items: Array<{ label: string; description: string; detail: string; operationId: string; initialId: string; planFile: string }> = [];
  for (const batch of eligibleIsolatedReviews(batches, ctx.root) as ReviewedIsolatedBatch[]) {
    try { assertLiveIsolatedBoundary(batch, ctx.root, queue); } catch { continue; }
    for (const plan of batch.plans) for (const record of plan.cleanup) {
      const events = batch.reviews?.filter(event => event.cleanupOperationId === record.cleanupOperationId) || [];
      const last = events.at(-1);
      if (events.some(event => event.kind === "completed")) continue;
      // Explicitly opening this review queries only the registered destinations.
      // External removal has no delete receipt; fresh per-target absence still consumes it.
      let absent = false;
      try { await verifyIsolatedTargetsAbsence(ctx, record.cleanupOperationId); absent = true; } catch { /* Present or unknown: retain for review. */ }
      if (absent) { await recordIsolatedReviewEventFor(ctx, record.cleanupOperationId, "completed"); continue; }
      const labels: Record<string, string> = { opened: "已打开", preview: "待确认", confirmed1: "等待第二次确认", confirmed2: "已确认待执行",
        executing: "执行结果待核实", busy: "服务器忙，未自动重试", failed: "审核失败", cancelled: "已取消", unknown: "结果待核实" };
      items.push({ label: plan.planFile, description: `${record.targets.length} 项隔离产物 · ${last ? labels[last.kind] || "待审核" : "待审核"}`,
        detail: record.targets.map(target => target.nodeId + ":" + target.isolationRelativePath).join("；"),
        operationId: record.cleanupOperationId, initialId: [...events].reverse().find(event => event.reviewOperationId)?.reviewOperationId || record.cleanupOperationId, planFile: plan.planFile });
    }
  }
  if (!items.length) { await ctx.vscode.window.showInformationMessage("暂无已核实全部初始 PLAN 启动且仍待审核的隔离产物；未删除任何文件。"); return; }
  const selected = await ctx.vscode.window.showQuickPick(items, { title: "隔离产物独立永久删除审核", placeHolder: "选择已登记隔离操作；下一页显示精确节点与完整路径，删除须另行两次确认" });
  if (!selected) return;
  await assertIsolatedReviewBinding(ctx, selected.operationId);
  await recordIsolatedReviewEventFor(ctx, selected.operationId, "opened");
  return ctx.open(selected.planFile, selected.initialId, undefined, selected.operationId);
}
