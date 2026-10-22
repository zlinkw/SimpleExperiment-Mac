import { randomUUID } from "node:crypto";
import { cleanupRelative } from "../features/PlanCleanup";
import { PlanSubmissionBatch } from "../features/PlanSubmissionBatch";

const running = new WeakSet<object>();

/** A disposable batch of explicit inputs; every item uses the ordinary run flow. */
export async function runSelectedPlans(host: any, params: any) {
  if (!Array.isArray(params.planFiles) || !params.planFiles.length)
    throw Error("请先勾选需要运行的 PLAN；未运行全部计划。");
  return runPlanBatch(host, params, false);
}

/** Snapshot all current PLANs inside the same lock as explicit selections. */
export async function runAllPlans(host: any, params: any = {}) {
  return runPlanBatch(host, params, true);
}

async function runPlanBatch(host: any, params: any, allPlans: boolean) {
  const canonicalFiles = (files: unknown[]) => [...new Set<string>(files.map((file: unknown) => {
    if (typeof file !== "string") throw Error("PLAN 路径必须是字符串。");
    return cleanupRelative(file);
  }))];
  const selectedFiles = allPlans ? [] : canonicalFiles(params.planFiles);
  const label = allPlans ? "全部 PLAN" : "所选 PLAN";
  if (running.has(host)) throw Error("已有一批 PLAN 正在确认或提交，请等待本批结果。");
  const context = host.captureProjectContext();
  const targetKey = () => JSON.stringify([host.effectiveConnectionMode?.(), (host.workerActionTargets?.() || []).map((row: any) =>
    [row.id, row.host, row.port, row.user, row.project_dir, row.local_agent_url, row.agent_runtime_dir, row.conda_env])]);
  const targets = targetKey();
  running.add(host);
  const current = () => {
    if (!host.projectContextIsCurrent(context) || targetKey() !== targets) throw Error("工作区或连接已变化；后续 PLAN 未提交。");
  };
  const rows: any[] = [];
  let batch: PlanSubmissionBatch | undefined;
  try {
    current();
    await host.refreshLocalPlanMetadataForAction(undefined, { allPlans: true });
    current();
    const known = new Set(canonicalFiles((host.localPlanMetadata.plans || []).map((plan: any) => plan.planFile || plan.file)));
    const files = allPlans ? [...known] : selectedFiles;
    if (!files.length) throw Error("没有可运行的计划文件。");
    const missing = files.filter(file => !known.has(file));
    if (missing.length) throw Error("所选 PLAN 已不在当前工作区扫描结果中；整批未提交：" + missing.join("、"));
    const unsupported = files.filter(file => !host.distributedPlanEligible(file));
    if (unsupported.length) throw Error("以下 PLAN 不支持自动排队；整批未提交，请检查运行协议与项目配置：" + unsupported.join("、"));
    batch = new PlanSubmissionBatch(host, context, host.localPlanMetadata.plans, current, text =>
      host.postUiCommandStatus?.(params.clientActionId, "running", "runAllPlans", text));
    await batch.start();
    const submit = async (planFile: string, index: number) => {
      const message = { command: "runPlan", planFile, planId: planFile, selectedPlanId: planFile,
        debugMode: false, clientActionId: "selected-plan-" + randomUUID() };
      batch!.bind(message);
      const operationId = host.planSubmissionOperationId(message);
      let status = "unknown", detail = "";
      try {
        current();
        host.postUiCommandStatus?.(params.clientActionId, "running", "runAllPlans", `${label} 并发提交 ${index + 1}/${files.length}：${planFile}`);
        await host.runActionCommand("runPlan", message);
        current();
        const progress = host.localOperations?.[operationId];
        status = String(progress?.status || "unknown");
        detail = String(progress?.message || "未取得本次提交流程的明确结果；请查询原操作，未重复提交。");
      } catch (error) {
        const progress = host.localOperations?.[operationId];
        const code = (error as any)?.apiData?.code || (error as any)?.code;
        status = progress?.status === "cancelled" || ["REPLACEMENT_CANCELLED", "USER_CANCELLED"].includes(code) || (error as any)?.name === "UiCommandCancelled" ? "cancelled"
          : code === "REMOTE_OUTCOME_UNKNOWN" || (error as any)?.outcomeUnknown || (error as any)?.name === "UiCommandRemotePending" ? "unknown" : "failed";
        detail = error instanceof Error ? error.message : String(error);
        if (status !== "unknown" && host.projectContextIsCurrent(context) && targetKey() === targets)
          host.finishPlanSubmissionProgress?.(message, status, detail);
      }
      return { planFile, operationId, status, message: detail };
    };
    let dispatchNote = "", dispatchTask: Promise<void> | undefined, dispatchDirty = false;
    const dispatch = () => {
      if (!host.tickDistributedQueue) return;
      dispatchDirty = true;
      if (dispatchTask) return;
      dispatchTask = Promise.resolve().then(async () => {
        while (dispatchDirty) {
          dispatchDirty = false;
          try { current(); await host.tickDistributedQueue(); }
          catch (error) { dispatchNote = "队列已保留，本轮派发查询未完成：" + (error instanceof Error ? error.message : String(error)); }
        }
      }).finally(() => { dispatchTask = undefined; });
    };
    let next = 0, stopped = false;
    const lane = async () => {
      while (!stopped && next < files.length) {
        current();
        const index = next++, file = files[index];
        const row = await submit(file, index).catch(error => ({ planFile: file, operationId: "", status: "failed", message: error instanceof Error ? error.message : String(error) }));
        rows.push(row);
        if (["succeeded", "queued", "submitted"].includes(row.status)) dispatch();
        if (["failed", "cancelled"].includes(row.status)) stopped = true;
      }
    };
    // 有界并发派发保持原契约：并发只发生在各 PLAN 的准备/提交链上，跨 PLAN 校验与身份互不借用；
    // 一旦某项失败就停止尚未启动的 PLAN，已在途的如实保留，不自动回滚也不重放。
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, lane));
    rows.sort((a, b) => files.indexOf(a.planFile) - files.indexOf(b.planFile));
    const processed = rows.filter(row => ["succeeded", "queued", "submitted"].includes(row.status)).length;
    const last = rows.find(row => ["failed", "cancelled"].includes(row.status)), pending = rows.filter(row => row.status === "unknown").length, complete = processed === files.length;
    return { status: complete ? "completed" : last?.status === "cancelled" ? "cancelled" : last ? "failed" : "submitted",
      message: `${label} 已完成并发排队提交流程 ${processed}/${files.length}。` + (complete ? "空卡检测在后台继续；运行状态以任务卡片的实时查询为准。"
        : `${pending} 项原校验结果待确认；${last ? last.planFile + "：" + last.message + "；" : ""}后续 ${files.length - rows.length} 个未提交，已处理项保留，不自动回滚或重复提交。`) + dispatchNote,
      selectionOnly: !allPlans, rows, remaining: files.slice(next) };
  } finally { await batch?.close(); running.delete(host); }
}
