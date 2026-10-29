import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "../state/StateStore";
import { cleanupDigest, cleanupRelative } from "../features/PlanCleanup";
import { replaceRunOutputs, runReplacementKey } from "../features/PlanRunReplacement";
import { observationMatches, taskLifecycle } from "../features/TaskLifecycle";
import { canonicalProjectId } from "../features/DistributedPlanQueue";
import { resolvePlanExecutionSource, verifyLocalPlanSource } from "./PlanCodeScopeHost";
import { ensureProjectDirectorySnapshotsMigrated, projectStateDir, projectStateFile, withProjectStateMigrationLease } from "../features/ProjectStatePaths";

/** Local recoverable inputs, never authority for a remote process or a result. */
export class PlanRunHost {
  constructor(private readonly host: any, private readonly root: string) {}
  // r17-A: in-flight submission receipts live inside the CONSUMED project; one directory per
  // projectRoot so parallel projects never share or clean each other's receipts.
  private file(id: string) { return path.join(projectStateDir(this.root, "simple-experiment"), "run-submissions", cleanupDigest(this.root), cleanupDigest(id) + ".json"); }
  /** One-time byte-exact copy of whitelisted legacy receipts (known exact legacy directory);
   * legacy files are never modified or deleted. */
  private receiptsMigration?: Promise<void>;
  /** One fixed completion fact per (projectRoot, receipts directory) — never per-token tombstones. */
  private receiptsMigrationMarker() { return projectStateFile(this.root, "simple-experiment", "migrations", "run-submissions-" + cleanupDigest(this.root) + ".done.json"); }
  private ensureReceiptsMigrated(): Promise<void> {
    if (!this.receiptsMigration) this.receiptsMigration = ensureProjectDirectorySnapshotsMigrated(
      this.root,
      path.join(this.host.context.globalStorageUri.fsPath, "run-submissions", cleanupDigest(this.root)),
      path.join(projectStateDir(this.root, "simple-experiment"), "run-submissions", cleanupDigest(this.root)),
      /^[a-f0-9]{64}\.json$/, this.receiptsMigrationMarker()).catch((error: unknown) => { this.receiptsMigration = undefined; throw error; });
    return this.receiptsMigration;
  }
  /** r17-C lifecycle (r18 lease protocol, r20 consumer contract): a SUCCEEDED submission is the last
   * purpose of this recoverable input — the durable queue fact has replaced it. Release takes the
   * SAME marker scope lease as the migration (one lease serializes check→import→publish and
   * check→delete), re-runs migration under that lease, and only then removes the exact receipt path
   * THIS host derives for this operationId after verifying its recorded root/operationId.
   * r20 修正 r18/19 的过度判据：队列 job 的 pending/running 是远端任务生命周期，不是这份本地回执的
   * 消费者——load() 全 src 仅 resume/cancel 两个入口，面板按钮门控 retryableSubmission 从不落在
   * succeeded 记录上，且提交流的所有 save 都在队列 durable 写之前 await 完成。因此删除的唯一授权是
   * 调用方显式传入的成功提交业务结果（"submission-succeeded"，来自 finish 的真实 succeeded 分支，
   * 覆盖正常 durable、durable 短恢复与 keep_existing——后者按定义可无 workflowId/新 plan）；缺该事实、
   * failed/cancelled/queued 一律不删。failed/cancelled 回执按既有语义保留（恢复入口依赖其明确错误
   * 语义）；损坏/foreign/未落定 marker 保留；绝不扫描、改写或删 legacy 文件。 */
  async releaseSettled(id: string, successFact?: "submission-succeeded"): Promise<"released" | "not-found" | "pending-migration" | "invalid-record" | "foreign-record" | "no-success-fact"> {
    if (!id) return "not-found";
    if (successFact !== "submission-succeeded") return "no-success-fact"; // 无终态依据绝不删除：缺事实=明确保留，不默认无引用
    const marker = this.receiptsMigrationMarker();
    const file = this.file(id);
    return await withProjectStateMigrationLease(this.root, marker, "plan-receipt-release", "释放已成功的提交恢复记录", async () => {
      await this.ensureReceiptsMigrated(); // same target re-uses this lease (nested acquire reuses parent)
      if (!await fs.stat(marker).catch(() => undefined)) return "pending-migration";
      let value: any;
      try { value = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error: any) {
        if (error?.code === "ENOENT") return "not-found";
        return "invalid-record"; // 损坏记录保留：不删除读不懂的事实，交恢复语义处理
      }
      if (value?.root !== this.root || value?.operationId !== id) return "foreign-record";
      await fs.rm(file, { force: true });
      return "released";
    });
  }
  async load(id: string) {
    await this.ensureReceiptsMigrated();
    const value = JSON.parse(await fs.readFile(this.file(id), "utf8"));
    if (value.root !== this.root || value.operationId !== id) throw Error("提交恢复记录不属于当前项目。");
    return value;
  }
  async save(body: any) {
    const id = body.submissionOperationIdLocal;
    if (!id) return;
    const input: any = {};
    for (const key of ["workspace", "planFile", "selectedPlanId", "planRevision", "schedulerOwnerWorkerId", "gitProvenance", "options", "schedulingMode",
      "existingOutputCount", "existingOutputChoice", "distributedSkipJobIndices", "assignedExperimentIndices", "submissionWorkflowId"])
      if (body[key] !== undefined) input[key] = body[key];
    input.planFile = cleanupRelative(body.planFile || body.options?.planFile);
    const safeInput = JSON.parse(JSON.stringify(input, (key, item) => /token|password|credential|privateKey|authorization/i.test(key) ? undefined : item));
    const value = { root: this.root, operationId: id, input: safeInput, recovery: body.runRecovery || {}, replacement: body.runReplacement || {} };
    // Cleanup preview tokens are opaque approvals; server credentials never enter the input.
    if (value.input.options) { delete value.input.options.workers; delete value.input.options.agentToken; delete value.input.options.env; }
    await atomicWriteText(this.file(id), JSON.stringify(value));
  }
  /** Hold key normalization: empty CSV "" and undefined are equivalent, matching the declaration-key write path. */
  static holdOutputKey(output: unknown, csv: unknown): string {
    return String(output ?? "").replace(/\\/g, "/") + String.fromCharCode(0) + String(csv ?? "");
  }

  /**
   * Apply retired marks for confirmed hold targets and report declared targets that no longer exist in the queue;
   * never silently skips a mismatch. The only exemption is a target whose own queue declaration the user already
   * confirmed cleared: a formal cleared record (resultPathPolicy "declared" as written by removeConfirmedDistributedPlan,
   * valid clearedAt, exact canonical project, same plan file) with no active receipt observed back from a Worker.
   * Such a target has no queue fact left to fence — the user-confirmed isolation is the separation fact.
   * Any unknown, incomplete, foreign-project, non-formal or reactivated record stays fail closed.
   */
  static normalizeHoldTargets(selected: Array<{ output_dir?: unknown; result_csv?: unknown }>, queue: any,
    planFile?: string, projectId?: string): { queue: any; missing: string[] } {
    const wanted = new Set((selected || []).map(row => PlanRunHost.holdOutputKey(row.output_dir, row.result_csv)));
    const matched = new Set<string>();
    const next = { ...queue, plans: (queue?.plans || []).map((old: any) => ({ ...old, jobs: (old?.jobs || []).map((job: any) => {
      const key = PlanRunHost.holdOutputKey(job.outputDir, job.collectionResultCsv);
      if (!wanted.has(key)) return job;
      matched.add(key);
      return { ...job, outputRetiredAt: job.outputRetiredAt || new Date().toISOString(), artifacts: undefined,
        mirroredWorkerIds: [], fragmentWorkerIds: [] };
    }) })) };
    const relative = (value: unknown) => String(value ?? "").replace(/\\/g, "/");
    const cleared = planFile && projectId ? new Set((queue?.clearedJobs || []).filter((row: any) => row
      && row.resultPathPolicy === "declared" && typeof row.projectId === "string" && row.projectId === projectId
      && typeof row.clearedAt === "string" && Number.isFinite(Date.parse(row.clearedAt)) && !row.activeReceiptObservedAt
      && relative(row.planFile) === relative(planFile))
      .map((row: any) => PlanRunHost.holdOutputKey(row.outputDir, row.collectionResultCsv))) : new Set<string>();
    return { queue: next, missing: [...wanted].filter(key => !matched.has(key) && !cleared.has(key)) };
  }

  async replace(plan: any, body: any, validation: any) {
    // Old direct-overwrite inputs never survive a failed or cancelled isolation review.
    // The only launch authorization is the completed exact-path replacement flow.
    body.overwrite = false; body.overwriteExisting = false;
    if (body.options) { body.options.overwrite = false; body.options.overwriteExisting = false; }
    const h = this.host, cleanup = h.planCleanupHost(), jobs = validation.jobs, context = h.captureProjectContext();
    const currentNodes = () => h.workerActionTargets().map((row: any) => [row.id, row.host, row.port, row.user, row.project_dir]);
    // Health checks rebuild the client even when its physical targets stay the
    // same. Bind confirmation to the project and actual configured endpoints.
    const connectionKey = () => cleanupDigest([h.effectiveConnectionMode(), h.workerActionTargets().map((row: any) =>
      [row.id, row.host, row.port, row.user, row.project_dir, row.local_agent_url, row.agent_runtime_dir, row.conda_env])]);
    const connection = connectionKey();
    const assertCurrent = () => {
      if (context.root !== this.root || !h.projectContextIsCurrent(context) || connectionKey() !== connection)
        throw Error("工作区或服务器连接配置已变化，未继续运行。");
    };
    const planFile = cleanupRelative(body.planFile || body.options?.planFile || plan?.planFile || plan?.file);
    if (body.options?.planFile && body.options.planFile !== planFile) throw Error("提交的 PLAN 路径不一致，未删除或提交。");
    body.planFile = planFile;
    const sourcePlan = { ...plan, projectId: plan?.projectId || canonicalProjectId(this.root), planFile: body.planFile,
      revision: body.planRevision, codeFingerprint: plan?.codeFingerprint || h.lastCodeSyncState?.fingerprint };
    const sourceSignal = h.distributedSubmissionAborts?.get(body.submissionOperationIdLocal)?.signal;
    const executionSource = body.executionSource || await resolvePlanExecutionSource(h, sourcePlan, sourceSignal);
    if (executionSource) { await verifyLocalPlanSource(this.root, executionSource, h.projectFileObservationIndex?.()); body.executionSource = executionSource; }
    const expectedFingerprint = executionSource?.digest || h.lastCodeSyncState?.fingerprint || "";
    body.runReplacement ||= {};
    // A launch-ready subset cannot prove other servers' outputs absent. Query
    // every enabled Worker before deriving the missing-only deletion scope.
    if (typeof h.readWorkerTaskSnapshot === "function") {
      const declarations = jobs.map((job: any) => ({ ...job, mode: validation.execution_mode }));
      const snapshots = await Promise.all(h.workerActionTargets().map(async (worker: any) => {
        try {
          const snapshot = await h.readWorkerTaskSnapshot(worker.id, { fresh: true, inventoryOnly: true, declarations, signal: AbortSignal.timeout(15000) });
          if (!snapshot || snapshot.queryComplete !== true || snapshot.error || snapshot.pending)
            throw Error(snapshot?.error || "查询未完成");
          if ((snapshot.declaredResults || []).some((row: any) => row.error)) throw Error("声明产物查询失败");
          if (!declarations.every((job: any) => (snapshot.declaredResults || []).some((row: any) =>
            Number(row.index) === Number(job.index) && row.outputDir === job.output_dir && row.collectionResultCsv === job.result_csv)))
            throw Error("声明产物查询不完整");
          return snapshot;
        } catch (error: any) { throw Error(worker.id + "：产物状态未核实；未生成删除清单。" + String(error.message || error)); }
      }));
      assertCurrent();
      body.workerSubmissionSnapshots = snapshots;
    }
    const completed = new Set<number>();
    const tasks = (body.workerSubmissionSnapshots || []).flatMap((snapshot: any) => snapshot.tasks || []);
    const executionAllowsCompletion = (output: string, runId: string) => !tasks.some((task: any) => {
      if (task.outputDir !== output || !task.observation) return false;
      const observed = task.observation, state = taskLifecycle(observed);
      return !!observed.queryError || !!observed.tmux && !observed.tmux.dead
        || task.commandId === runId && ["failed", "unknown"].includes(state.execution);
    });
    for (const snapshot of body.workerSubmissionSnapshots || []) {
      for (const result of snapshot.declaredResults || []) if (result.completed === true && executionAllowsCompletion(result.outputDir, result.runId)) {
        const declaration = jobs.find((row: any) => Number(row.index) === result.index && row.output_dir === result.outputDir && row.result_csv === result.collectionResultCsv);
        if (declaration) completed.add(result.index);
      }
      for (const task of snapshot.tasks || []) if (task.observation && observationMatches(task.observation,
        { commandId: task.commandId, workerId: snapshot.workerId, projectId: task.projectId })
        && taskLifecycle(task.observation).status === "completed" && executionAllowsCompletion(task.outputDir, task.commandId)) {
        const declaration = jobs.find((row: any) => row.case === task.case && Number(row.seed) === Number(task.seed)
          && row.output_dir === task.outputDir && row.result_csv === task.collectionResultCsv);
        if (declaration) completed.add(Number(declaration.index));
      }
    }
    const key = runReplacementKey(body.planFile, body.planRevision, expectedFingerprint, jobs, currentNodes());
    const result = await replaceRunOutputs({
      preview: (job: any) => cleanup.service.preview({ planFile: body.planFile, action: "isolate", verifiedOnly: false, authorizationMode: "confirmed_paths",
        job: { workflowId: "manifest-" + cleanupDigest([body.planFile, job.output_dir]), commandId: "manifest-" + cleanupDigest(job), index: Number(job.index),
          purpose: "replace_outputs", manifest: { declarations: [job], replacement: true } } },
        (progress: any) => body.reportPlanStageLocal?.("任务 " + job.index + " · " + progress.message)),
      service: cleanup.service, execute: (id: string) => cleanup.execute(id),
      verify: (preview: any) => cleanup.service.assertIsolatedSourcesAbsent(preview),
      // r87 块4：隔离完成即派发；后台清理只在 rerun_all+回执齐备时被 fire-and-forget 触发，失败不进派发链。
      prepareEmptyParents: (preview: any) => cleanup.service.prepareEmptyParentCleanup(preview),
      confirmEmptyParents: (previews: any[], phase: number) => cleanup.service.confirmEmptyParentCleanup(previews, phase),
      autoDeleteIsolated: (id: string, parents: any) => cleanup.autoDeleteIsolated(id, parents),
      ask: (payload: any) => h.askRunConfirmation(payload, body.submissionOperationIdLocal),
      save: () => this.save(body),
      assertCurrent,
      beforeDelete: async () => {
        // Isolation still requires the complete batch check. Ordinary launch can
        // already use ready Workers while the remaining servers prepare.
        await body.awaitWorkerPreparationLocal?.();
        const current = { ...body }; await h.refreshLocalPlanMetadataForAction(current); h.stampPlanRevision(current);
        if (executionSource) await verifyLocalPlanSource(this.root, executionSource, h.projectFileObservationIndex?.());
        const fingerprint = executionSource?.digest || await h.localDistributedCodeFingerprint(this.root);
        if (current.planRevision !== body.planRevision || fingerprint !== (executionSource ? expectedFingerprint : h.lastCodeSyncState?.fingerprint)
          || runReplacementKey(body.planFile, body.planRevision, fingerprint, jobs, currentNodes()) !== key)
          throw Error("PLAN、代码或服务器配置已变化，请重新运行并确认路径；未移动文件或提交任务。");
        await h.assertPlanSubmissionWorkers(body, { validation });
      },
      progress: (text: string) => body.reportPlanStageLocal?.(text),
      // 批路径注入批次对话道；单 PLAN 提交没有批次道，保持原语义直接执行。
      interactive: work => (body.confirmGateLocal || ((fn: () => Promise<void>) => fn()))(work),
      // 批路径注入同批隔离机械 I/O 读写协调道（批次接线缺省时=单 PLAN/非批次，直接执行零新语义）。
      isolation: body.isolationGateLocal,
      hold: async (selected: any[]) => {
        // 归一化匹配后核实每个已确认目标都在队列声明中；真实不匹配显式失败且不写队列，禁止静默漏 retired。
        await h.saveDistributedQueue(this.root, undefined, { artifactMutation: true, mutateLatest: (queue: any) => {
          const next = PlanRunHost.normalizeHoldTargets(selected, queue, body.planFile, canonicalProjectId(this.root));
          if (next.missing.length) throw Error("HOLD_TARGET_NOT_FOUND：已确认的产物路径未在当前队列声明中找到（" + next.missing.length
            + " 项），队列未改动；请刷新后重新确认范围。");
          return next.queue;
        } });
      },
    }, body.runReplacement, body.planFile, jobs, [...completed], key);
    body.existingOutputChoice = result.choice;
    body.existingOutputCount = body.runReplacement.previews?.filter((row: any) => row.preview.rows.some((file: any) => file.disposition === "isolate")).length || 0;
    // r82：跳过清单只装"用户选择沿用完成"的 job。隔离阻断者不是有意跳过——它带着
    // runReplacement.blocked 以 pending+job 级标记入队（可见、不派发），由 planDispatchSelection
    // 在入队时统一划分；把它混进跳过清单会让它在队列里彻底消失（现场 r81 的另一半成因）。
    const isolationBlockedIndices = new Set((result.blocked || []).map((row: any) => Number(row.index)));
    body.distributedSkipJobIndices = jobs.filter((job: any) => !result.selectedIndices.includes(Number(job.index))
      && !isolationBlockedIndices.has(Number(job.index))).map((job: any) => Number(job.index));
    body.assignedExperimentIndices = result.selectedIndices;
    body.outputReplacementOperationIds = body.runReplacement.completed || [];
    body.overwrite = body.overwriteExisting = false;
    body.options = { ...body.options, overwrite: false, overwriteExisting: false };
    await this.save(body);
  }
}
