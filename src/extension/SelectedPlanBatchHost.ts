import { randomUUID } from "node:crypto";
import { cleanupRelative } from "../features/PlanCleanup";
import { PlanSubmissionBatch } from "../features/PlanSubmissionBatch";
import { canonicalProjectId } from "../features/DistributedPlanQueue";
import { freezeBatchScope, loadIsolatedBatchLedger, markPlanTerminal, eligibleIsolatedReviews } from "../features/PlanIsolatedBatchLedger";

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
  const projectRoot = String((context as any)?.root || "");
  const targetKey = () => JSON.stringify([host.effectiveConnectionMode?.(), (host.workerActionTargets?.() || []).map((row: any) =>
    [row.id, row.host, row.port, row.user, row.project_dir, row.local_agent_url, row.agent_runtime_dir, row.conda_env])]);
  const targets = targetKey();
  running.add(host);
  // 批次身份：本批账本记录都挂在它下面；账本身份至少 {canonicalProjectId, projectRoot, planFile}。
  const isolatedBatchIdLocal = "iso-batch-" + randomUUID();
  host.currentIsolatedBatchLocal = { batchId: isolatedBatchIdLocal, projectRoot };
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
    // 每条 PLAN 的提交 operation 在入口一次性预生成（operationId=plan-submit-<clientActionId>，与 legacy 同法推导），
    // 冻结与真实提交共用同一 id——之后新增 PLAN/别批记录不可能混入本批初始集合。
    // parentClientActionId routes every per-plan stage into the batch's single
    // VS Code Notification (task ui-plan-gpu-progress-20261024 item 5).
    const planMessages = new Map<string, any>(files.map(file => [file, { command: "runPlan", planFile: file, planId: file, selectedPlanId: file,
      debugMode: false, clientActionId: "selected-plan-" + randomUUID(), parentClientActionId: params.parentClientActionId || params.clientActionId || "" }]));
    const ledgerFile = typeof host.isolatedReplacementLedgerFileLocal === "function" ? String(host.isolatedReplacementLedgerFileLocal() || "") : "";
    // 入口冻结完整初始 PLAN 集合（含稍后无隔离/隔离前失败的 PLAN）；账本损坏/被锁 → 保留原字节、审核入口关闭，
    // 但不阻断正常提交流程（失败关闭只作用于隔离区删除审核）。
    let ledgerError = "";
    if (ledgerFile) {
      try {
        await freezeBatchScope(ledgerFile, { batchId: isolatedBatchIdLocal, projectRoot,
          canonicalProjectId: projectRoot ? canonicalProjectId(projectRoot) : undefined },
        files.map(file => ({ planFile: file, submissionOperationId: host.planSubmissionOperationId(planMessages.get(file)) })));
      } catch (error) { ledgerError = error instanceof Error ? error.message : String(error); }
    }
    batch = new PlanSubmissionBatch(host, context, host.localPlanMetadata.plans, current, text =>
      host.postUiCommandStatus?.(params.clientActionId, "running", "runAllPlans", text));
    await batch.start();
    const submit = async (planFile: string, index: number) => {
      const message = planMessages.get(planFile)!;
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
    // 隔离区独立删除审核只能在「完整初始集合逐项终局 + 已登记轮询核实远端派发」之后浮出。
    // 这里只回写各行自己的终局：失败/取消 → void（永不浮出）；unknown → 未准入；成功提交的 committed
    // 由 legacy 在入队事务落盘点带真实卡/command 身份写入（本机入队 ≠ 远端已派发，绝不上报 ready）。
    let isolatedNote = "";
    const isolatedMap = host.planIsolatedReplacementsLocal;
    const hit = isolatedMap instanceof Map ? rows.filter(row => isolatedMap.has(row.operationId)) : [];
    if (isolatedMap instanceof Map) for (const row of hit) isolatedMap.delete(row.operationId);
    if (ledgerFile && !ledgerError) {
      for (const row of rows) {
        const terminalStatus = ["failed", "cancelled"].includes(row.status) ? row.status as "failed" | "cancelled"
          : !["succeeded", "queued", "submitted"].includes(row.status) ? "unknown" as const : undefined;
        if (!terminalStatus) continue; // committed 终局由 legacy 落盘点写入，这里绝不代替补写（防无身份假准入）
        try { await markPlanTerminal(ledgerFile, { batchId: isolatedBatchIdLocal }, { submissionOperationId: row.operationId, planFile: row.planFile, status: terminalStatus }); }
        catch (error) { ledgerError = ledgerError || (error instanceof Error ? error.message : String(error)); }
      }
    }
    if (hit.length) {
      if (!ledgerFile) {
        // 兼容旧宿主表面（无账本访问）：保留原一行提示，不声称存在可审核流程。
        isolatedNote = `本批 ${hit.length} 个 PLAN 的旧产物已按确认移入 clean 隔离区；隔离区的永久删除不会自动开始，需在清理入口单独两次确认后执行。本次未删除任何文件；运行状态以任务卡片实时查询为准。`;
      } else if (ledgerError) {
        isolatedNote = `隔离区删除审核账本本次不可用（${ledgerError}）；原账本文件原样保留、未覆盖，本批隔离区删除审核入口关闭（隔离区保留，不会自动删除）。运行以任务卡片实时查询为准。`;
      } else {
        try {
          const batches = await loadIsolatedBatchLedger(ledgerFile);
          const mine = batches.find(entry => entry.batchId === isolatedBatchIdLocal);
          const states = mine?.plans.map(plan => plan.state) || [];
          const awaiting = states.filter(state => state === "awaiting_dispatch" || state === "frozen").length;
          const bad = states.filter(state => state === "void" || state === "unknown").length;
          if (mine && eligibleIsolatedReviews([mine], projectRoot).length)
            isolatedNote = `本批 ${mine.plans.length} 个 PLAN 已全部核实远端派发，其旧产物的隔离引用已冻结进持久账本；隔离区永久删除不会自动开始，须经独立审核入口两次确认后执行。本次未删除任何文件。`;
          else if (mine && awaiting && !bad)
            isolatedNote = `本批 PLAN 的旧产物已按确认移入 clean 隔离区并冻结进持久账本；其中 ${awaiting} 个仍在等待已登记状态轮询核实远端派发（本机入队不等于已启动），核实完成前不浮出隔离区删除审核。本次未删除任何文件；运行状态以任务卡片实时查询为准。`;
          else
            isolatedNote = `本批有 PLAN 的旧产物移入了 clean 隔离区，但存在失败/取消/结果未知或派发未核实的项，本批整体不浮出隔离区删除审核（不会自动删除，隔离区保留）。运行状态以任务卡片实时查询为准。`;
        } catch (error) {
          isolatedNote = `隔离区删除审核账本本次不可核实（${error instanceof Error ? error.message : String(error)}）；原文件原样保留，审核入口关闭，隔离区不会被自动删除。`;
        }
      }
    }
    const processed = rows.filter(row => ["succeeded", "queued", "submitted"].includes(row.status)).length;
    const last = rows.find(row => ["failed", "cancelled"].includes(row.status)), pending = rows.filter(row => row.status === "unknown").length, complete = processed === files.length;
    return { status: complete ? "completed" : last?.status === "cancelled" ? "cancelled" : last ? "failed" : "submitted",
      message: `${label} 已完成并发排队提交流程 ${processed}/${files.length}。` + (complete ? "空卡检测在后台继续；运行状态以任务卡片的实时查询为准。"
        : `${pending} 项原校验结果待确认；${last ? last.planFile + "：" + last.message + "；" : ""}后续 ${files.length - rows.length} 个未提交，已处理项保留，不自动回滚或重复提交。`) + dispatchNote + isolatedNote,
      selectionOnly: !allPlans, rows, remaining: files.slice(next) };
  } finally { if (host.currentIsolatedBatchLocal?.batchId === isolatedBatchIdLocal) host.currentIsolatedBatchLocal = undefined; await batch?.close(); running.delete(host); }
}
