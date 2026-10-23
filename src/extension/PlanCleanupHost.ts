import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { PlanCleanup, cleanupDigest, cleanupError, type CleanupOperation, type CleanupPreview, type CleanupRemovedMetadata, type CleanupProgressSink, type CleanupJobSelection } from "../features/PlanCleanup";
import { collectPlanCleanupEvidence } from "../features/PlanCleanupEvidence";
import { distributedQueuePath, emptyDistributedQueue, canonicalProjectId, type DistributedQueue } from "../features/DistributedPlanQueue";
import { cleanupTaskEvidence, replacementEvidenceQueue, replacementJobGroups, replacementLifecycleJob } from "../features/PlanOutputReplacement";
import { planSyncLedgerStoragePath, emptyPlanSyncLedger } from "../features/PlanArtifactSync";
import { atomicWriteText } from "../state/StateStore";
import { openPlanCleanupPanel } from "./PlanCleanupPanel";
import { isUnderMachineStatePrefixes } from "../features/ProjectRootMap";
import { discoverManifestCandidates, recordedDeclarations, type ManifestDeclaration } from "../features/ManifestCleanup";
import { type IsolatedReviewEvent } from "../features/PlanIsolatedBatchLedger";
// 2026-10-23 行数门禁返修：以下四个模块是逐行原样提取的独立职责（守卫绑定/应答安全/独立审核/逐目标核验），
// 语义与错误码保持原样，本类的公开方法与行为不变。
import { collectNodeTargets, nodesForTargets, bindMachineStateByNode, managedNodes as managedNodesOf, machineStateForNode as machineStateForNodeOf } from "./PlanCleanupNodeGuards";
import { guardCleanupSftpCall } from "./PlanCleanupSftpGuard";
import { assertIsolatedReviewBinding, recordIsolatedReviewEventFor, verifyIsolatedTargetsAbsence, openIsolatedBatchReviewFlow, type IsolatedReviewContext } from "./PlanCleanupIsolatedReviews";
import { verifyDeclaredTargetsOnNodes } from "./PlanCleanupTargetVerification";

async function json(file: string, fallback: any): Promise<any> {
  const text = await fs.readFile(file, "utf8").catch((error: any) => { if (error.code === "ENOENT") return ""; throw error; });
  return text ? JSON.parse(text) : fallback;
}

/** Host adapter deliberately reads original ledgers, without refreshing/migrating project files. */
export class PlanCleanupHost {
  readonly service: PlanCleanup;
  executing = false;
  private independentExecuting = false;
  get blocksTaskScheduling() { return this.executing && !this.independentExecuting; }
  constructor(private readonly host: any, readonly root: string) {
    const storage = host.context.globalStorageUri.fsPath;
    this.service = new PlanCleanup({ storageRoot: path.join(storage, "plan-cleanup", cleanupDigest(root)),
      collect: (file, options) => this.collect(file, Boolean(options?.removedMetadata), options?.archivedFiles, options?.removedMetadata, options?.onProgress, options?.job, options?.nativeDeclarations, options?.authorizationMode),
      sftp: async (method, params) => guardCleanupSftpCall(host, method, params),
      restoreGate: (preview, operation) => this.restoreGate(preview, operation),
      currentNode: async id => this.currentNode(id),
      validateScope: async scope => {
        this.assertWorkspace();
        if (scope.candidates.some(row => row.category === "PLAN 文件" && !row.scopeProtectedReason))
          cleanupError("PLAN_CLEANUP_SCOPE_CHANGED", "旧审核包含 PLAN 文件，请重新审核；本次不会处理 PLAN 或共享配置。");
        for (const row of scope.candidates.filter(row => !row.scopeProtectedReason && row.nodeId !== "pluginState")) {
          const node = scope.nodes.find(node => node.id === row.nodeId);
          const guard = this.machineStateForNode(node);
          if (guard.unknown || isUnderMachineStatePrefixes(row.relativePath, guard.prefixes, true))
            cleanupError("MACHINE_STATE_PATH_PROTECTED", row.relativePath);
        }
        const configs = scope.candidates.filter(row => !row.scopeProtectedReason && ["专用配置", "远端配置同步副本"].includes(row.category));
        if (!configs.length) return;
        const fresh = await collectPlanCleanupEvidence({ root: this.root, planFile: scope.planFile, queue: emptyDistributedQueue(),
          ledger: emptyPlanSyncLedger(), nodes: scope.nodes, snapshots: [], activityMode: "managed_tmux" });
        for (const config of configs) {
          const proof = fresh.candidates.find(row => row.nodeId === "local" && row.relativePath === config.relativePath && row.category === "专用配置");
          if (!proof || proof.protectedReason || proof.dependencies.length || proof.owners.some(owner => owner !== fresh.planKey)
            || proof.expectedSha256 !== config.expectedSha256) cleanupError("CONFIG_SCOPE_CHANGED", config.relativePath + "：配置已变化或已被其他 PLAN 引用，请重新审核");
        }
      },
      validateIsolationReview: async id => { await this.assertIsolatedReview(id); },
      updateIndexes: (operation, restore) => this.updateIndexes(operation, restore) });
  }
  private assertWorkspace() {
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (current !== this.root) cleanupError("WORKSPACE_CHANGED");
  }
  private currentNode(id: string) {
    this.assertWorkspace();
    if (id === "local") return { id, kind: "local" as const, root: this.root };
    const worker = (this.host.setupConfig.workerTunnels || []).find((row: any) => row.id === id);
    const target = worker && worker.enabled !== false && this.host.workerCodeSyncTarget(worker);
    if (!target) cleanupError("SERVER_IDENTITY_UNVERIFIED");
    return { id, kind: "remote" as const, host: target.host, user: target.user, port: target.port, root: target.remotePath };
  }
  /** Retired compatibility hook. File review is explicitly requested, never triggered by a connection. */
  observeConnections(_endpoints: Array<{ id: string; streamStatus: string; reconnectCount?: number }>): Promise<void> {
    return Promise.resolve();
  }
  /**
   * 返修（2026-10-21）P0：单 job「删除并重新排队」的逐目标不存在核验。
   * 缺失的声明目录不会进候选（ManifestCleanup 只报告存在的产物）——「候选缺失」不等于「已删除」。
   * 本方法是唯一被允许的 absence 证据来源：对原预览冻结的物理节点集合 × 完整声明路径逐一
   * files.cleanup.inspect（只读），节点身份必须先与当前配置一致（endpoint/安全根漂移即 error）；
   * 后端必须回 target.missing===true 才算 absent；任何异常/含糊应答都是 error，绝不推断不存在。
   * 它不产生删除候选、不改变审核范围，也不替代预览。
   */
  async verifyDeclaredTargets(params: { job: CleanupJobSelection; declared: Array<{ relativePath: string; type: string }>; nodes: any[] }) {
    return verifyDeclaredTargetsOnNodes({ host: this.host, assertWorkspace: () => this.assertWorkspace(), currentNode: id => this.currentNode(id) }, params);
  }
  async replacementGroups(queue: DistributedQueue, file: string, declarations: any[], projectId: string, stablePlanId: string) {
    this.assertWorkspace();
    if (this.host.taskLifecycleProtocol === 2) return declarations.map(row => [{
      workflowId: "manifest-" + cleanupDigest([file, row.output_dir]), index: Number(row.index),
      commandId: "manifest-" + cleanupDigest([file, row.output_dir, row.result_csv]), purpose: "replace_outputs" as const,
      manifest: { declarations: [row], replacement: true }
    }]);
    const workers = [...new Set((queue.clearedJobs || []).filter(entry => entry.projectId === projectId && entry.resultPathPolicy === "declared"
      && declarations.some(job => job.output_dir === entry.outputDir && job.case === entry.case && Number(job.seed) === entry.seed))
      .map(entry => entry.workerId))];
    const snapshots = await Promise.all(workers.map(async workerId => {
      const retiredCommandIds = (queue.clearedJobs || []).filter(entry => entry.workerId === workerId && entry.planFile === file).map(entry => entry.commandId);
      try { return { ...await this.host.client.getWorkerTasks(workerId, { signal: AbortSignal.timeout(5000), retiredCommandIds }), workerId, fetchedAt: new Date().toISOString() }; }
      catch { return { workerId, error: "历史 job 当前任务证据不可达" }; }
    }));
    this.assertWorkspace();
    return replacementJobGroups(replacementEvidenceQueue(queue, snapshots, projectId), file, declarations, projectId, stablePlanId);
  }
  async collect(file: string, allowMissing = false, archivedFiles?: Record<string, string>, removedMetadata?: CleanupRemovedMetadata, onProgress?: CleanupProgressSink, job?: CleanupJobSelection, nativeDeclarations?: ManifestDeclaration[], authorizationMode?: "confirmed_paths") {
    if (this.host.taskLifecycleProtocol === 2 || authorizationMode === "confirmed_paths") return this.collectManaged(file, allowMissing, archivedFiles, removedMetadata, onProgress, job, nativeDeclarations, authorizationMode);
    this.assertWorkspace();
    const storage = this.host.context.globalStorageUri.fsPath;
    const queue = await json(distributedQueuePath(storage, this.root), emptyDistributedQueue());
    const ledger = await json(planSyncLedgerStoragePath(storage, this.root), emptyPlanSyncLedger());
    const registry = await json(path.join(this.root, "simple_cluster/results/project_table_registry.json"), undefined);
    const targets = collectNodeTargets(this.host);
    const nodes = nodesForTargets(this.root, targets);
    const remoteNodes = nodes.filter(node => node.kind === "remote");
    let checkedNodes = 0;
    onProgress?.({ phase: "tasks", message: "并行读取各节点当前任务与传输状态…", completed: 0, total: remoteNodes.length });
    const snapshots = await Promise.all(remoteNodes.map(async node => {
      if (node.error) { onProgress?.({ phase: "tasks", message: node.id + "：身份未核实，保留", completed: ++checkedNodes, total: remoteNodes.length }); return { workerId: node.id, error: node.error }; }
      try { return { ...await this.host.client.getWorkerTasks(node.id, { signal: AbortSignal.timeout(5000), retiredCommandIds: job ? [job.commandId] : [] }), workerId: node.id, fetchedAt: new Date().toISOString() }; }
      catch { return { workerId: node.id, error: "节点当前任务证据不可达" }; }
      finally { onProgress?.({ phase: "tasks", message: node.id + "：任务状态检查已返回", completed: ++checkedNodes, total: remoteNodes.length }); }
    }));
    this.assertWorkspace();
    // Panel/journal rows are history, not evidence that code is still executing.
    // Use current Agent action registries and live cross-window resource leases.
    // Excluding our async call's lease lineage prevents runPlan's replacement
    // review from blocking itself; sibling/concurrent calls remain visible.
    const operations: any[] = snapshots.flatMap(snapshot => snapshot.error ? [] : (snapshot.activeOperations || [])
      .map((operation: any) => ({ ...operation, nodeId: snapshot.workerId })));
    const leases = await this.host.hostOperationLease?.inspect({ excludeCurrent: true });
    for (const lease of leases?.records || []) {
      for (const node of nodes) {
        const server = node.kind === "local" ? "local" : String(node.host).toLowerCase() + ":" + node.port;
        const spelling = (value: string) => node.kind === "local" ? value.replace(/\\/g, "/").toLowerCase() : value;
        const paths = (lease.resources || []).filter((resource: any) => String(resource.server).toLowerCase() === server
          && spelling(resource.project) === spelling(node.root)).map((resource: any) => ({ targetPath: resource.target || resource.project }));
        if (paths.length) operations.push({ nodeId: node.id, operationId: lease.leaseId, commandId: lease.leaseId, status: "running", targets: paths });
      }
    }
    onProgress?.({ phase: "references", message: "核对 PLAN/attempt 所有权、共享引用与受保护资产…" });
    const evidenceQueue = job?.purpose === "replace_outputs" ? replacementEvidenceQueue(queue, snapshots, canonicalProjectId(this.root)) : queue;
    const scope = await collectPlanCleanupEvidence({ root: this.root, planFile: file, queue: evidenceQueue, ledger, registry,
      resultDir: this.host.resultCsvDirectory || "experiments/results", nodes, snapshots: snapshots.map(cleanupTaskEvidence), operations, allowMissing, archivedFiles, removedMetadata, job });
    bindMachineStateByNode(this.host, nodes, targets, scope);
    if (job?.purpose === "replace_outputs") {
      const owner = evidenceQueue.plans.find((plan: any) => plan.id === job.workflowId)?.jobs.find((row: any) => row.commandId === job.commandId);
      const snapshot = snapshots.find(row => row.workerId === owner?.workerId);
      if (!snapshot?.error && snapshot?.capabilities?.controlStateRetirement !== 1)
        scope.blockers.push({ code: "STATE_RETIREMENT_CAPABILITY_REQUIRED", nodeId: owner?.workerId,
          detail: "原 Worker 尚不支持旧状态回收；更新 Agent 后再预览。未删除产物，不影响单独停止任务。" });
    }
    if (!job) {
    scope.nodes.push({ id: "pluginState", kind: "local", root: storage });
    for (const indexFile of [distributedQueuePath(storage, this.root), planSyncLedgerStoragePath(storage, this.root)]) {
      scope.candidates.push({ nodeId: "pluginState", relativePath: path.relative(storage, indexFile).replace(/\\/g, "/"), type: "file",
        category: "插件缓存/任务索引", owners: [scope.planKey], evidence: ["当前项目的持久化登记与清理生命周期标记"],
        dependencies: ["同项目其他 PLAN 与历史恢复证据"], protectedReason: "共享索引保留，完成后仅追加生命周期标记" });
    }
    }
    for (const document of vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === "file")) {
      const relative = path.relative(this.root, document.uri.fsPath).replace(/\\/g, "/");
      if (scope.candidates.some(row => row.nodeId === "local" && (row.relativePath === relative || relative.startsWith(row.relativePath + "/"))))
        scope.blockers.push({ code: "DIRTY_EDITOR_TARGET", detail: document.uri.fsPath });
    }
    scope.revision = cleanupDigest([scope.revision, scope.nodes, scope.candidates.filter(row => row.nodeId === "pluginState")]);
    return scope;
  }
  private managedNodes() { return managedNodesOf(this.host, this.root, id => this.currentNode(id)); }
  private async collectManaged(file: string, allowMissing: boolean, archivedFiles?: Record<string, string>, removedMetadata?: CleanupRemovedMetadata,
    onProgress?: CleanupProgressSink, job?: CleanupJobSelection, nativeDeclarations?: ManifestDeclaration[], authorizationMode?: "confirmed_paths") {
    this.assertWorkspace();
    const storage = this.host.context.globalStorageUri.fsPath;
    const queue = await json(distributedQueuePath(storage, this.root), emptyDistributedQueue());
    const ledger = await json(planSyncLedgerStoragePath(storage, this.root), emptyPlanSyncLedger());
    const registry = await json(path.join(this.root, "simple_cluster/results/project_table_registry.json"), undefined);
    const nodes = this.managedNodes();
    let declarations = nativeDeclarations || job?.manifest?.declarations;
    if (job && !declarations) {
      const plan = queue.plans.find((row: any) => row.id === job.workflowId);
      const entry = plan?.jobs.find((row: any) => row.index === job.index && row.commandId === job.commandId);
      const retired = queue.clearedJobs?.find((row: any) => row.workflowId === job.workflowId && row.commandId === job.commandId && row.experimentIndex === job.index);
      const source = entry || retired;
      if (!source) cleanupError("JOB_DECLARATIONS_UNVERIFIED");
      declarations = [{ index: job.index, case: source.case, seed: source.seed, output_dir: source.outputDir, result_csv: source.collectionResultCsv }];
    }
    onProgress?.({ phase: "manifests", message: "读取声明目录内的产物清单…" });
    const discovered = await discoverManifestCandidates(this.host, this.root, file, nodes, queue, declarations, authorizationMode === "confirmed_paths", onProgress);
    this.assertWorkspace();
    // Retain the original config/reference graph, without importing cached task activity.
    const scope = await collectPlanCleanupEvidence({ root: this.root, planFile: file, queue: emptyDistributedQueue(), ledger,
      registry, resultDir: this.host.resultCsvDirectory || "experiments/results", nodes, snapshots: [], operations: [],
      allowMissing: allowMissing || authorizationMode === "confirmed_paths", archivedFiles, removedMetadata, activityMode: "managed_tmux" });
    const configuration = scope.candidates.filter(row => ["PLAN 文件", "专用配置"].includes(row.category))
      .map(row => [row.relativePath, row.expectedSha256, row.dependencies, row.protectedReason]);
    scope.nodes = [...nodes, ...scope.nodes.filter(node => !nodes.some(row => row.id === node.id))];
    if (job) scope.candidates = [];
    else scope.candidates = scope.candidates.filter(row => ["PLAN 文件", "专用配置", "远端配置同步副本"].includes(row.category));
    for (const candidate of scope.candidates) {
      if (candidate.category === "PLAN 文件") candidate.scopeProtectedReason = "保留 PLAN；仅清理独占配置与关联产物";
      else if (candidate.protectedReason || candidate.dependencies.length || candidate.owners.some(owner => owner !== scope.planKey))
        candidate.scopeProtectedReason = candidate.protectedReason || "共享配置，保留";
    }
    const preserved = new Map(scope.candidates.map(row => [row.nodeId + ":" + row.relativePath, row]));
    for (const candidate of discovered.candidates) {
      const key = candidate.nodeId + ":" + candidate.relativePath, existing = preserved.get(key);
      if (existing) { existing.evidence.push(...candidate.evidence); continue; }
      candidate.owners = candidate.owners.length ? [scope.planKey] : [];
      for (const [reference, owners] of Object.entries(scope.references || {}))
        if (owners.some(owner => owner !== scope.planKey) && (reference === candidate.relativePath || reference.startsWith(candidate.relativePath + "/")))
          candidate.dependencies.push("其他 PLAN 引用：" + reference);
      scope.candidates.push(candidate); preserved.set(key, candidate);
    }
    scope.blockers.push(...discovered.blockers); scope.notices!.push(...discovered.notices);
    scope.associationBlockers = [...scope.blockers];
    if (authorizationMode === "confirmed_paths") {
      scope.authorizationMode = authorizationMode;
      const pathErrors = new Set(["UNSAFE_DECLARED_PATH", "NODE_UNREACHABLE", "OFFLINE_NODE"]);
      scope.notices!.push(...scope.blockers.filter(row => !pathErrors.has(row.code)));
      scope.blockers = scope.blockers.filter(row => pathErrors.has(row.code));
    }
    scope.machineStateByNode = Object.fromEntries(nodes.map(node => [String(node.id), this.machineStateForNode(node)]));
    scope.runIds = queue.plans.filter((plan: any) => plan.planFile === file).map((plan: any) => plan.id);
    scope.observationMode = "managed_tmux"; scope.nativeDeclarations = discovered.declarations;
    if (job) scope.job = { ...job, manifest: { declarations: discovered.declarations, replacement: true } };
    for (const document of vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === "file")) {
      const relative = path.relative(this.root, document.uri.fsPath).replace(/\\/g, "/");
      if (scope.candidates.some(row => !row.scopeProtectedReason && row.nodeId === "local" && (row.relativePath === relative || relative.startsWith(row.relativePath + "/")))) {
        const blocker = { code: "DIRTY_EDITOR_TARGET", detail: document.uri.fsPath };
        scope.blockers.push(blocker); scope.associationBlockers.push(blocker);
      }
    }
    scope.revision = cleanupDigest([file, scope.planHash, configuration, discovered.declarations,
      nodes.map(({ error, ...node }: any) => node)]);
    return scope;
  }
  private machineStateForNode(node: any): { prefixes: string[]; unknown: boolean } { return machineStateForNodeOf(this.host, node); }
  private async restoreGate(preview: CleanupPreview, operation?: CleanupOperation) {
    const archivedFiles = Object.fromEntries(preview.rows.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && operation?.targets[row.id]?.state !== "completed")
      .map(row => [row.destination, row.relativePath]));
    const fresh = await this.collect(preview.scope.planFile, true, archivedFiles, undefined, undefined, preview.scope.job, preview.scope.nativeDeclarations);
    if (fresh.blockers.length) cleanupError("RESTORE_PREFLIGHT_BLOCKED", JSON.stringify(fresh.blockers));
    for (const row of preview.rows) {
      const node = fresh.nodes.find(node => node.id === row.node.id);
      if (!node || cleanupDigest({ ...node, error: undefined }) !== cleanupDigest({ ...row.node, error: undefined })) cleanupError("SERVER_IDENTITY_CHANGED");
      const original = row.destination;
      if ((fresh.references?.[original] || []).some(owner => owner !== preview.scope.planKey)) cleanupError("SHARED_DEPENDENCY");
      if (fresh.candidates.some(candidate => candidate.relativePath === original && candidate.nodeId === node.id && candidate.dependencies.length))
        cleanupError("SHARED_DEPENDENCY");
    }
  }
  private async updateIndexes(operation: CleanupOperation, restore: boolean) {
    this.assertWorkspace();
    // An old registered isolation tree has no authority to retire, clear or rewrite the new PLAN/job.
    if (operation.preview.registeredIsolationOperationId) return;
    const originalId = operation.preview.originalOperationId || operation.id;
    const restoreChain = restore ? await this.service.history(originalId) : [];
    const restoreIds = new Set(restoreChain.map(row => row.id));
    const queue = await this.host.loadDistributedQueue(this.root);
    const ids = new Set(operation.preview.scope.runIds);
    const selection = operation.preview.scope.job;
    const deletedRows = (operation.preview.rows || []).filter(row => row.nodeId !== "pluginState" && row.disposition !== "protected");
    const absentDeletion = operation.preview.action === "delete" && deletedRows.length > 0 && deletedRows.every(row =>
      operation.targets[row.id]?.state === "completed" && operation.targets[row.id]?.receipt?.verifiedBy === "path_absence");
    if (operation.preview.scope.observationMode === "managed_tmux") {
      const declarations = operation.preview.scope.nativeDeclarations || [];
      const matches = (record: any) => declarations.some(row => row.output_dir === record.outputDir
        && row.result_csv === record.collectionResultCsv);
      for (const plan of queue.plans) if (plan.planFile === operation.preview.scope.planFile && (ids.has(plan.id) || selection?.workflowId === plan.id)) {
        for (const record of plan.jobs.filter(matches)) {
          if (restore) { if (restoreIds.has(record.cleanup?.operationId)) { delete record.cleanup; delete record.outputRetiredAt; } }
          else {
            record.cleanup = { operationId: operation.id, state: operation.pendingNodes.length ? "partial" : operation.preview.action === "delete" ? "deleted" : "archived",
              completedTargets: operation.preview.rows.filter(row => operation.targets[row.id]?.state === "completed").map(row => row.node.id + ":" + row.absolutePath), pendingNodes: operation.pendingNodes };
            record.outputRetiredAt = new Date().toISOString();
          }
        }
      }
      // Local lifecycle markers are audit only. No Worker acknowledgement or retired status file is required.
    } else if (selection) {
      const plan = queue.plans.find((plan: any) => plan.id === selection.workflowId);
      const job = plan?.jobs.find((job: any) => job.index === selection.index && job.commandId === selection.commandId
        && (selection.purpose === "replace_outputs" ? ["failed", "completed"].includes(job.status) : job.status === "failed"));
      const record = job || replacementLifecycleJob(queue, selection);
      if (!record && !absentDeletion) cleanupError("JOB_SCOPE_CHANGED");
      if (record && restore) { if (restoreIds.has(record.cleanup?.operationId)) { delete record.cleanup; delete record.outputRetiredAt; } }
      else if (record) {
        const retiringState = !absentDeletion && selection.purpose === "replace_outputs" && operation.preview.action === "delete";
        const ownerWorker = job?.workerId || queue.clearedJobs?.find((row: any) => row.commandId === selection.commandId && row.workflowId === selection.workflowId)?.workerId;
        record.cleanup = { operationId: operation.id, state: operation.pendingNodes.length || retiringState ? "partial" : operation.preview.action === "delete" ? "deleted" : "archived",
          completedTargets: operation.preview.rows.filter(row => operation.targets[row.id]?.state === "completed").map(row => row.node.id + ":" + row.absolutePath),
          pendingNodes: retiringState ? [...new Set([...operation.pendingNodes, ...[ownerWorker].filter(Boolean)])] : operation.pendingNodes };
        if (retiringState && !operation.pendingNodes.length && Object.values(operation.targets).every(row => row.state === "completed")) {
          operation.retirementPendingNodes = [ownerWorker].filter(Boolean);
          operation.state = "partial";
        }
      }
    } else {
    for (const plan of queue.plans) if (ids.has(plan.id)) {
      if (restore) { if (restoreIds.has(plan.cleanup?.operationId)) delete plan.cleanup; }
      else plan.cleanup = { operationId: operation.id, state: operation.pendingNodes.length ? "partial" : operation.preview.action === "delete" ? "deleted" : "archived",
        completedTargets: operation.preview.rows.filter(row => operation.targets[row.id]?.state === "completed").map(row => row.node.id + ":" + row.absolutePath), pendingNodes: operation.pendingNodes };
    }
    }
    await this.host.saveDistributedQueue(this.root, queue);
    if (!selection) await this.host.updatePlanSyncLedger(this.root, (ledger: any) => {
      for (const entry of Object.values(ledger.entries) as any[]) if (ids.has(entry.runId)) {
        if (restore) { if (restoreIds.has(entry.cleanupOperationId)) delete entry.cleanupOperationId; }
        else entry.cleanupOperationId = operation.id;
      }
      return ledger;
    });
    if (restore) {
      for (const original of restoreChain) {
        original.restoredBy = operation.id;
        const storage = path.join(this.host.context.globalStorageUri.fsPath, "plan-cleanup", cleanupDigest(this.root), original.id + ".json");
        await atomicWriteText(storage, JSON.stringify(original, null, 2));
      }
    }
    this.host.localPlanMetadataUpdatedAt = 0;
    this.host.postState();
  }
  async execute(id: string) {
    if (this.executing) cleanupError("OPERATION_BUSY");
    this.executing = true;
    try {
      const registered = await this.service.registeredIsolationSource(id);
      this.independentExecuting = Boolean(registered);
      const initial = await this.service.status(id);
      const independent = initial.preview.registeredIsolationOperationId;
      if (independent !== registered) cleanupError("ISOLATED_OPERATION_IDENTITY_CHANGED");
      if (independent) {
        await this.assertIsolatedReview(independent);
        if (initial.state === "completed") { await this.verifyIsolatedAbsence(independent); await this.isolatedReviewEvent(independent, "completed", id); return initial; }
        if (initial.state === "paused") cleanupError("ISOLATED_DELETE_RECONFIRM_REQUIRED", "该审核已取消；请重新预览并两次确认，不沿用旧授权执行。");
        if (initial.executionRequestedAt) cleanupError("ISOLATED_DELETE_QUERY_REQUIRED", "该删除请求已经发出；本次只允许刷新核实，不重复发送。重新审核仍须两次确认。");
        this.host.assertArtifactSyncPathsIdle?.(this.root, initial.preview.rows.filter(row => row.disposition === "delete").map(row => row.relativePath));
        await this.isolatedReviewEvent(independent, "executing", id);
        try {
          const result = await this.service.execute(id);
          if (result.state === "completed") await this.verifyIsolatedAbsence(independent);
          await this.isolatedReviewEvent(independent, result.state === "completed" ? "completed" : result.state === "paused" ? "cancelled"
            : /BUSY/.test(result.error || "") ? "busy" : result.state === "blocked" ? "failed" : "unknown", id, result.error);
          return result;
        } catch (error: any) {
          await this.isolatedReviewEvent(independent, /BUSY/.test(String(error?.apiData?.code || error.message)) ? "busy" : "failed", id,
            String(error.message || error)).catch(() => undefined);
          throw error;
        }
      }
      const pending = this.host.distributedQueueTickPromise;
      if (pending) await pending;
      const operation = await this.service.status(id);
      if (operation.state === "completed") return operation;
      this.host.assertArtifactSyncPathsIdle?.(this.root, operation.preview.rows
        .filter(row => ["delete", "move", "isolate"].includes(row.disposition)).map(row => row.relativePath));
      if (operation.preview.scope.observationMode === "managed_tmux") return await this.service.execute(id);
      if (operation.preview.scope.job?.purpose === "replace_outputs") {
        await this.service.preflightConfirmed(id);
        const selection = operation.preview.scope.job;
        const queue = await this.host.loadDistributedQueue(this.root);
        const job = replacementLifecycleJob(queue, selection);
        if (!job) cleanupError("JOB_SCOPE_CHANGED");
        const priorIds = new Set((await this.service.history(id)).map(row => row.id));
        if (job.cleanup?.state === "partial" && !priorIds.has(job.cleanup.operationId)) cleanupError("OUTPUT_REPLACEMENT_PENDING");
        job.outputRetiredAt ||= new Date().toISOString();
        job.cleanup = { operationId: id, state: "partial", completedTargets: [], pendingNodes: operation.preview.scope.nodes.map(node => node.id) };
        await this.host.saveDistributedQueue(this.root, queue);
      }
      const result = await this.host.withHostOperationLease("cleanupPlan", "清除 PLAN 及关联产物", () => this.service.execute(id),
        { resources: [{ server: "local", project: this.root, target: this.root }] });
      if (operation.preview.action === "delete") return await this.service.status(id);
      return result;
    } finally { this.executing = false; this.independentExecuting = false; }
  }
  private isolatedReviewContext(): IsolatedReviewContext {
    return { host: this.host, vscode, root: this.root, service: this.service,
      assertWorkspace: () => this.assertWorkspace(), currentNode: id => this.currentNode(id), open: (file, operationId, job, isolatedOperationId) => this.open(file, operationId, job, isolatedOperationId) };
  }
  async assertIsolatedReview(id: string) { return assertIsolatedReviewBinding(this.isolatedReviewContext(), id); }
  async isolatedReviewEvent(originalId: string, kind: IsolatedReviewEvent["kind"], reviewId?: string, detail?: string) {
    return recordIsolatedReviewEventFor(this.isolatedReviewContext(), originalId, kind, reviewId, detail);
  }
  async verifyIsolatedAbsence(originalId: string) { return verifyIsolatedTargetsAbsence(this.isolatedReviewContext(), originalId); }
  async openIsolatedBatchReviews() { return openIsolatedBatchReviewFlow(this.isolatedReviewContext()); }
  open(file: string, operationId?: string, job?: CleanupJobSelection, isolatedOperationId?: string) { return openPlanCleanupPanel(this, file, operationId, job, isolatedOperationId); }
  openJob(file: string, job: CleanupJobSelection) { return this.open(file, undefined, job); }
}
