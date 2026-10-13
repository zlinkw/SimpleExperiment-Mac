import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { PlanCleanup, cleanupDigest, cleanupError, type CleanupOperation, type CleanupPreview, type CleanupRemovedMetadata, type CleanupProgressSink, type CleanupJobSelection } from "../features/PlanCleanup";
import { collectPlanCleanupEvidence } from "../features/PlanCleanupEvidence";
import { distributedQueuePath, emptyDistributedQueue } from "../features/DistributedPlanQueue";
import { planSyncLedgerStoragePath, emptyPlanSyncLedger } from "../features/PlanArtifactSync";
import { atomicWriteText } from "../state/StateStore";
import { openPlanCleanupPanel } from "./PlanCleanupPanel";

async function json(file: string, fallback: any): Promise<any> {
  const text = await fs.readFile(file, "utf8").catch((error: any) => { if (error.code === "ENOENT") return ""; throw error; });
  return text ? JSON.parse(text) : fallback;
}

/** Host adapter deliberately reads original ledgers, without refreshing/migrating project files. */
export class PlanCleanupHost {
  readonly service: PlanCleanup;
  executing = false;
  private connections = new Map<string, { online: boolean; count: number }>();
  private pendingReconnects = new Set<string>();
  private reconnectWork?: Promise<void>;
  private notices = new Set<string>();
  constructor(private readonly host: any, readonly root: string) {
    const storage = host.context.globalStorageUri.fsPath;
    this.service = new PlanCleanup({ storageRoot: path.join(storage, "plan-cleanup", cleanupDigest(root)),
      collect: (file, options) => this.collect(file, Boolean(options?.removedMetadata), options?.archivedFiles, options?.removedMetadata, options?.onProgress, options?.job),
      sftp: async (method, params) => {
        const result = await host.simpleSftpApiCall(method, params);
        if (method === "files.cleanup.preview" && (result.safety?.gitRepositoryAncestors !== true || result.safety?.readOnlyReceiptCheck !== true))
          cleanupError("SFTP_SAFE_CLEANUP_UPGRADE_REQUIRED", "当前 SimpleSFTP 缺少 Git 祖先仓库预检或只读回执核查；请更新配套插件后重新预览。");
        if (method === "files.cleanup.preview" && params.targets?.some((target: any) => target.expectedOwner?.resultPathPolicy === "declared") && result.safety?.formalJobOwner !== true)
          cleanupError("SFTP_FORMAL_OWNER_UPGRADE_REQUIRED", "需要支持正式 job 身份核验的 SimpleSFTP，尚未执行任何清理。");
        if (method === "files.cleanup.preview" && params.targets?.some((target: any) => target.archiveBatch) && result.safety?.immutableArchiveBatch !== true)
          cleanupError("SFTP_ARCHIVE_BATCH_UPGRADE_REQUIRED", "需要支持预先确定的归档批次布局的 SimpleSFTP，尚未执行任何清理。");
        return result;
      },
      restoreGate: (preview, operation) => this.restoreGate(preview, operation),
      currentNode: async id => this.currentNode(id),
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
    const target = id === "hub" ? this.host.hubCodeSyncTarget() : worker && this.host.workerCodeSyncTarget(worker);
    if (!target) cleanupError("SERVER_IDENTITY_UNVERIFIED");
    return { id, kind: "remote" as const, host: target.host, user: target.user, port: target.port, root: target.remotePath };
  }
  /** Edge-triggered on initial connection/reconnection, never on ordinary telemetry heartbeats. */
  observeConnections(endpoints: Array<{ id: string; streamStatus: string; reconnectCount?: number }>): Promise<void> {
    const present = new Set(endpoints.map(endpoint => endpoint.id));
    for (const id of this.connections.keys()) if (!present.has(id)) this.connections.delete(id);
    for (const endpoint of endpoints) {
      const online = ["websocket", "sse", "polling"].includes(endpoint.streamStatus), count = endpoint.reconnectCount || 0;
      const before = this.connections.get(endpoint.id);
      this.connections.set(endpoint.id, { online, count });
      if (online && (!before?.online || before.count !== count)) this.pendingReconnects.add(endpoint.id);
    }
    return this.drainReconnects();
  }
  private drainReconnects(): Promise<void> {
    if (this.reconnectWork) return this.reconnectWork;
    if (this.executing) return Promise.resolve();
    this.reconnectWork = (async () => {
      while (this.pendingReconnects.size && !this.executing) {
        const nodeId = this.pendingReconnects.values().next().value!; this.pendingReconnects.delete(nodeId);
        if (!this.connections.get(nodeId)?.online) continue;
        this.assertWorkspace();
        const reports = await this.service.recheckNode(nodeId);
        this.assertWorkspace();
        if (!reports.length || this.notices.has(nodeId)) continue;
        this.notices.add(nodeId);
        void Promise.resolve(vscode.window.showWarningMessage(`${nodeId} 已重连，${reports.length} 个 PLAN 的清理信号仍需审核确认。未自动移动或删除。`, "审核未完成清理", "稍后"))
          .then(async choice => {
            this.assertWorkspace();
            if (choice === "审核未完成清理") {
              const operation = await this.service.status(reports[0].operationId);
              await this.open(operation.preview.scope.planFile, operation.id, operation.preview.scope.job);
            }
          }).catch(() => undefined).finally(() => this.notices.delete(nodeId));
      }
    })().finally(() => { this.reconnectWork = undefined; });
    return this.reconnectWork;
  }
  async collect(file: string, allowMissing = false, archivedFiles?: Record<string, string>, removedMetadata?: CleanupRemovedMetadata, onProgress?: CleanupProgressSink, job?: CleanupJobSelection) {
    this.assertWorkspace();
    const storage = this.host.context.globalStorageUri.fsPath;
    const queue = await json(distributedQueuePath(storage, this.root), emptyDistributedQueue());
    const ledger = await json(planSyncLedgerStoragePath(storage, this.root), emptyPlanSyncLedger());
    const registry = await json(path.join(this.root, "simple_cluster/results/project_table_registry.json"), undefined);
    const targets: any[] = [];
    // Include disabled Workers: historical ownership never disappears with the current selection.
    for (const worker of this.host.setupConfig.workerTunnels || []) {
      try { targets.push(this.host.workerCodeSyncTarget(worker)); }
      catch { targets.push({ id: worker.id, error: "当前服务器身份或项目安全根未核实" }); }
    }
    try { if (this.host.setupConfig.agentProjectDir && this.host.setupConfig.savedSessionPath) targets.push(this.host.hubCodeSyncTarget()); }
    catch { targets.push({ id: "hub", error: "当前 Hub 身份或安全根未核实" }); }
    const nodes: any[] = [{ id: "local", kind: "local", root: this.root }, ...targets.map(target => ({ id: target.id, kind: "remote",
      host: target.host, user: target.user, port: target.port, root: target.remotePath || "", ...(target.error ? { error: target.error } : {}) }))];
    const remoteNodes = nodes.filter(node => node.kind === "remote");
    let checkedNodes = 0;
    onProgress?.({ phase: "tasks", message: "并行读取各节点当前任务与传输状态…", completed: 0, total: remoteNodes.length });
    const snapshots = await Promise.all(remoteNodes.map(async node => {
      if (node.error) { onProgress?.({ phase: "tasks", message: node.id + "：身份未核实，保留", completed: ++checkedNodes, total: remoteNodes.length }); return { workerId: node.id, error: node.error }; }
      try { return { ...await this.host.client.getWorkerTasks(node.id, { signal: AbortSignal.timeout(5000) }), workerId: node.id, fetchedAt: new Date().toISOString() }; }
      catch { return { workerId: node.id, error: "节点当前任务证据不可达" }; }
      finally { onProgress?.({ phase: "tasks", message: node.id + "：任务状态检查已返回", completed: ++checkedNodes, total: remoteNodes.length }); }
    }));
    this.assertWorkspace();
    const state = this.host.buildPlanRuntimeEvidenceState();
    const operations = Object.values(state.operations || {});
    onProgress?.({ phase: "references", message: "核对 PLAN/attempt 所有权、共享引用与受保护资产…" });
    const scope = await collectPlanCleanupEvidence({ root: this.root, planFile: file, queue, ledger, registry,
      resultDir: this.host.resultCsvDirectory || "experiments/results", nodes, snapshots, operations, allowMissing, archivedFiles, removedMetadata, job });
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
  private async restoreGate(preview: CleanupPreview, operation?: CleanupOperation) {
    const archivedFiles = Object.fromEntries(preview.rows.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && operation?.targets[row.id]?.state !== "completed")
      .map(row => [row.destination, row.relativePath]));
    const fresh = await this.collect(preview.scope.planFile, true, archivedFiles, undefined, undefined, preview.scope.job);
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
    const originalId = operation.preview.originalOperationId || operation.id;
    const restoreChain = restore ? await this.service.history(originalId) : [];
    const restoreIds = new Set(restoreChain.map(row => row.id));
    const queue = await this.host.loadDistributedQueue(this.root);
    const ids = new Set(operation.preview.scope.runIds);
    const selection = operation.preview.scope.job;
    if (selection) {
      const plan = queue.plans.find((plan: any) => plan.id === selection.workflowId);
      const job = plan?.jobs.find((job: any) => job.index === selection.index && job.commandId === selection.commandId && job.status === "failed");
      if (!job) cleanupError("JOB_SCOPE_CHANGED");
      if (restore) { if (restoreIds.has(job.cleanup?.operationId)) delete job.cleanup; }
      else job.cleanup = { operationId: operation.id, state: operation.pendingNodes.length ? "partial" : operation.preview.action === "delete" ? "deleted" : "archived",
        completedTargets: operation.preview.rows.filter(row => operation.targets[row.id]?.state === "completed").map(row => row.node.id + ":" + row.absolutePath), pendingNodes: operation.pendingNodes };
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
      const pending = this.host.distributedQueueTickPromise;
      if (pending) await pending;
      return await this.host.withHostOperationLease("cleanupPlan", "清除 PLAN 及关联产物", () => this.service.execute(id),
        { resources: [{ server: "local", project: this.root, target: this.root }] });
    } finally { this.executing = false; void this.drainReconnects().catch(() => undefined); }
  }
  open(file: string, operationId?: string, job?: CleanupJobSelection) { return openPlanCleanupPanel(this, file, operationId, job); }
  openJob(file: string, job: CleanupJobSelection) { return this.open(file, undefined, job); }
}
