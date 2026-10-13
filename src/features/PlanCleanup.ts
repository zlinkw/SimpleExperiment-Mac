import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "../state/StateStore";

export type CleanupNode = { id: string; kind: "local" | "remote"; root: string; host?: string; port?: number; user?: string; error?: string };
export type CleanupJobSelection = { workflowId: string; index: number; commandId: string };
export type CleanupCandidate = { nodeId: string; relativePath: string; type: "file" | "directory"; category: string;
  owners: string[]; evidence: string[]; protectedReason?: string; dependencies: string[]; expectedSha256?: string;
  expectedOwner?: { workflowId: string; commandId: string; workerId: string; outputDir: string; attempt?: number; case: string; seed: number;
    resultPathPolicy?: "declared"; globalJobId?: string; planRevision?: string; codeFingerprint?: string; index?: number; collectionResultCsv?: string; expectedState?: string } };
export type CleanupScope = { projectId: string; planKey: string; planFile: string; planHash: string; runIds: string[];
  revision: string; nodes: CleanupNode[]; candidates: CleanupCandidate[]; references?: Record<string, string[]>; job?: CleanupJobSelection;
  blockers: Array<{ code: string; nodeId?: string; detail: string }>;
  notices?: Array<{ code: string; nodeId?: string; detail: string }> };
export type CleanupRemovedMetadata = { planKey: string; planHash: string; planFile: string; runIds: string[];
  hashes: Record<string, string>; references: Record<string, string[]> };
export type CleanupProgress = { phase: string; message: string; completed?: number; total?: number };
export type CleanupProgressSink = (progress: CleanupProgress) => void;
export type CleanupRow = CleanupCandidate & { id: string; node: CleanupNode; destination: string; fingerprint?: string;
  contentFingerprint?: string; size?: number; absolutePath: string; inventory?: any[]; inode?: string; device?: string;
  backendToken?: string; backendDigest?: string; backendIndex?: number; rootIdentity?: Record<string, unknown>;
  archiveBatch?: string;
  disposition: "move" | "delete" | "restore" | "protected" | "unverified" | "absent" | "completed"; error?: string };
export type CleanupPreview = { token: string; digest: string; action: "move" | "delete" | "restore"; scope: CleanupScope;
  rows: CleanupRow[]; blockers: CleanupScope["blockers"]; verifiedOnly: boolean; expiresAt: number; confirmations: number;
  originalOperationId?: string; continuationOf?: string };
export type CleanupNodeCheck = { operationId: string; nodeId: string; checkedAt: string;
  state: "confirmation_required" | "settlement_required" | "blocked";
  targets: Array<{ id: string; absolutePath: string; state: string; code?: string }> };
export type CleanupOperation = { id: string; preview: CleanupPreview; state: "ready" | "running" | "paused" | "partial" | "completed" | "blocked";
  targets: Record<string, { state: "pending" | "executing" | "completed"; receipt?: any; error?: string }>;
  pendingNodes: string[]; error?: string; updatedAt: string; indexed?: boolean; restoredBy?: string; continuedBy?: string;
  nodeChecks?: Record<string, CleanupNodeCheck> };
export type CleanupPorts = {
  collect(planFile: string, options?: { archivedFiles: Record<string, string>; removedMetadata?: CleanupRemovedMetadata; onProgress?: CleanupProgressSink; job?: CleanupJobSelection }): Promise<CleanupScope>;
  sftp(method: string, params: any): Promise<any>;
  updateIndexes(operation: CleanupOperation, restore: boolean): Promise<void>;
  restoreGate(preview: CleanupPreview, operation?: CleanupOperation): Promise<void>;
  currentNode?(id: string): Promise<CleanupNode>;
  storageRoot: string;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const cleanupDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const cleanupJobKey = (job?: CleanupJobSelection) => cleanupDigest(job ? [job.workflowId, job.index, job.commandId] : null);
export function cleanupError(code: string, detail = code): never {
  const error = Object.assign(new Error(detail), { apiCode: code === "CONFIRM_REQUIRED" ? 2001 : 2010, apiData: { code, detail } });
  throw error;
}
export function cleanupRelative(value: string): string {
  if (!value || value.length > 4096 || /[\\:\x00-\x1f*?\[\]{}]/.test(value) || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === "..")) cleanupError("UNSAFE_PATH");
  return value;
}
const under = (base: string, file: string) => file === base || file.startsWith(base + "/");

/** Ownership is an explicit registry join. Names, modification times and prefixes are never evidence. */
export function classifyCleanupCandidates(scope: CleanupScope): CleanupCandidate[] {
  return scope.candidates.map(input => {
    const row = clone(input), rel = cleanupRelative(row.relativePath);
    const protectedParts = new Set([".git", "clean_dir", "models", "trainers", "encoders", "data", "datasets", "paper", "splits", "clean", "low_quality", "biomedclip"]);
    if (rel.split("/").some(part => protectedParts.has(part.toLowerCase()))) row.protectedReason ||= "受保护资产";
    if (!row.evidence.length || !row.owners.length || row.owners.some(owner => owner !== scope.planKey)) row.protectedReason ||= "所有权不唯一或证据不足";
    if (row.dependencies.length) row.protectedReason ||= "存在外部引用：" + row.dependencies.join("；");
    return row;
  });
}

/** Shared coordinator for Webview and JSON-RPC. Preview remains entirely read-only. */
export class PlanCleanup {
  private previews = new Map<string, CleanupPreview>();
  private busy = new Set<string>();
  private cancelled = new Set<string>();
  constructor(private readonly ports: CleanupPorts) {}
  private file(id: string) { if (!/^[a-f0-9]{48}$/.test(id)) cleanupError("INVALID_OPERATION_ID"); return path.join(this.ports.storageRoot, id + ".json"); }
  private async save(operation: CleanupOperation) {
    operation.updatedAt = new Date().toISOString();
    await atomicWriteText(this.file(operation.id), JSON.stringify(operation, null, 2));
  }
  async status(id: string): Promise<CleanupOperation> {
    try { return JSON.parse(await fs.readFile(this.file(id), "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") cleanupError("OPERATION_NOT_FOUND"); throw error; }
  }
  async list(): Promise<Array<Pick<CleanupOperation, "id" | "state" | "updatedAt" | "pendingNodes" | "continuedBy" | "restoredBy" | "nodeChecks"> & { planFile: string; action: string; job?: CleanupJobSelection }>> {
    const names = await fs.readdir(this.ports.storageRoot).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
    const rows = [];
    for (const name of names.filter(name => /^[a-f0-9]{48}\.json$/.test(name))) {
      const operation = await this.status(name.slice(0, -5));
      rows.push({ id: operation.id, state: operation.state, updatedAt: operation.updatedAt, pendingNodes: operation.pendingNodes,
        planFile: operation.preview.scope.planFile, action: operation.preview.action, job: operation.preview.scope.job,
        continuedBy: operation.continuedBy, restoredBy: operation.restoredBy, nodeChecks: operation.nodeChecks });
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async history(id: string): Promise<CleanupOperation[]> {
    const rows: CleanupOperation[] = [], seen = new Set<string>();
    while (id) {
      if (seen.has(id) || rows.length >= 32) cleanupError("INVALID_CONTINUATION_CHAIN");
      seen.add(id); const operation = await this.status(id); rows.push(operation);
      id = operation.preview.continuationOf || "";
    }
    return rows;
  }
  private nodeIdentity(node: CleanupNode) { return cleanupDigest({ ...node, error: undefined }); }
  private async completedHistory(history: CleanupOperation[]): Promise<CleanupRow[]> {
    const completed = new Map<string, CleanupRow>();
    for (const operation of history) for (const row of operation.preview.rows) {
      const state = operation.targets[row.id]?.state;
      if (state === "completed") {
        await this.ports.sftp("files.cleanup.verify", { token: row.backendToken, index: row.backendIndex });
        completed.set(row.id, { ...row, disposition: "completed" });
      } else if (state === "executing") {
        const proof = await this.ports.sftp("files.cleanup.check", { token: row.backendToken, index: row.backendIndex });
        if (proof.state === "completed") completed.set(row.id, { ...row, disposition: "completed" });
        else if (proof.state !== "pending") cleanupError("DELETE_RECEIPT_UNCERTAIN");
      } else if (row.disposition === "absent" && operation.indexed) {
        const proof = await this.ports.sftp("files.cleanup.inspect", { node: row.node,
          target: { relativePath: row.relativePath, type: row.type }, allowMissing: true });
        if (!proof.target.missing) cleanupError("SOURCE_RECREATED_OR_CHANGED");
        completed.set(row.id, { ...row, disposition: "completed" });
      }
    }
    return [...completed.values()];
  }
  private archivedMetadata(rows: CleanupRow[]) {
    return Object.fromEntries(rows.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && row.fingerprint).map(row => [row.relativePath, row.destination]));
  }
  private removedMetadata(history: CleanupOperation[], completed: CleanupRow[]): CleanupRemovedMetadata | undefined {
    if (history[0]?.preview.action !== "delete") return;
    const scope = history[0].preview.scope;
    const hashes = Object.fromEntries(completed.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && row.expectedSha256).map(row => [row.relativePath, row.expectedSha256!]));
    return { planKey: scope.planKey, planHash: scope.planHash, planFile: scope.planFile, runIds: scope.runIds, hashes, references: scope.references || {} };
  }
  async continuePreview(id: string, params: { verifiedOnly?: boolean } = {}, onProgress?: CleanupProgressSink): Promise<CleanupPreview> {
    const original = await this.status(id);
    if (original.continuedBy || original.restoredBy || original.preview.action === "restore" || this.busy.has(id)) cleanupError("NOT_CONTINUABLE");
    return this.preview({ planFile: original.preview.scope.planFile, action: original.preview.action,
      verifiedOnly: params.verifiedOnly, continuationOf: id, job: original.preview.scope.job }, onProgress);
  }
  /** Reconnection observes receipts and source presence only. It never settles or executes a mutation. */
  async recheckNode(nodeId: string): Promise<CleanupNodeCheck[]> {
    const reports: CleanupNodeCheck[] = [];
    for (const item of await this.list()) {
      const operation = await this.status(item.id);
      if (operation.continuedBy || operation.restoredBy || operation.preview.action === "restore" || this.busy.has(item.id)) continue;
      const rows = operation.preview.rows.filter(row => row.node.id === nodeId
        && (operation.targets[row.id] && operation.targets[row.id].state !== "completed"
          || operation.pendingNodes.includes(nodeId) && row.disposition !== "completed"));
      if (!rows.length) continue;
      const report: CleanupNodeCheck = { operationId: item.id, nodeId, checkedAt: new Date().toISOString(), state: "confirmation_required", targets: [] };
      for (const row of rows) {
        try {
          if (this.ports.currentNode && this.nodeIdentity(await this.ports.currentNode(nodeId)) !== this.nodeIdentity(row.node)) cleanupError("SERVER_IDENTITY_CHANGED");
          if (row.disposition === "protected") { report.targets.push({ id: row.id, absolutePath: row.absolutePath, state: "protected" }); continue; }
          const proof = row.backendToken
            ? await this.ports.sftp("files.cleanup.check", { token: row.backendToken, index: row.backendIndex })
            : await this.ports.sftp("files.cleanup.inspect", { node: row.node, target: { relativePath: row.relativePath, type: row.type }, allowMissing: true });
          const state = proof.state || (proof.target.missing ? "absent" : "pending");
          report.targets.push({ id: row.id, absolutePath: row.absolutePath, state });
          if (state === "completed" && report.state !== "blocked") report.state = "settlement_required";
          if (state === "absent_unverified") { report.state = "blocked"; report.targets.at(-1)!.code = "DELETE_RECEIPT_UNCERTAIN"; }
        } catch (error: any) {
          report.state = "blocked"; report.targets.push({ id: row.id, absolutePath: row.absolutePath, state: "unverified", code: error.apiData?.code || error.code || "NODE_UNREACHABLE" });
        }
      }
      const fresh = await this.status(item.id);
      if (this.busy.has(item.id) || fresh.continuedBy || fresh.restoredBy) continue;
      (fresh.nodeChecks ||= {})[nodeId] = report; await this.save(fresh); reports.push(report);
    }
    return reports;
  }
  async preview(params: { planFile: string; action?: "move" | "delete"; verifiedOnly?: boolean; continuationOf?: string; job?: CleanupJobSelection }, onProgress?: CleanupProgressSink): Promise<CleanupPreview> {
    // UI observations cannot change the frozen preview or authorize execution.
    const notify: CleanupProgressSink = progress => { try { onProgress?.(progress); } catch {} };
    notify({ phase: "discovery", message: "读取 PLAN、历史登记与完成回执…" });
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 16) this.previews.delete(this.previews.keys().next().value!);
    const action = params.action || "move";
    if (!["move", "delete"].includes(action)) cleanupError("INVALID_ACTION");
    const history = params.continuationOf ? await this.history(params.continuationOf) : [];
    if (history[0]?.continuedBy || history[0]?.restoredBy || history.some(row => row.preview.action !== action)) cleanupError("NOT_CONTINUABLE");
    const completed = await this.completedHistory(history);
    const scope = await this.ports.collect(cleanupRelative(params.planFile), { archivedFiles: action === "move" ? this.archivedMetadata(completed) : {},
      removedMetadata: this.removedMetadata(history, completed), onProgress: notify, job: params.job });
    if (cleanupJobKey(scope.job) !== cleanupJobKey(params.job)
        || history.length && cleanupJobKey(scope.job) !== cleanupJobKey(history[0].preview.scope.job)) cleanupError("JOB_SCOPE_CHANGED");
    if (history.length && (scope.planKey !== history[0].preview.scope.planKey || scope.planHash !== history[0].preview.scope.planHash)) cleanupError("PREVIEW_CHANGED");
    for (const original of history[0]?.preview.scope.nodes || []) {
      const current = scope.nodes.find(node => node.id === original.id);
      if (!current || this.nodeIdentity(current) !== this.nodeIdentity(original)) cleanupError("SERVER_IDENTITY_CHANGED");
    }
    const token = randomBytes(24).toString("hex");
    const archiveBatch = scope.job ? history[0]?.preview.rows.find(row => row.archiveBatch)?.archiveBatch || "job-" + token : undefined;
    const result: CleanupPreview = { token, digest: "", action, scope, rows: [], blockers: clone(scope.blockers),
      verifiedOnly: params.verifiedOnly === true, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0,
      ...(params.continuationOf ? { continuationOf: params.continuationOf } : {}) };
    const candidates = classifyCleanupCandidates(scope).filter(row => !completed.some(done => done.nodeId === row.nodeId && done.relativePath === row.relativePath))
      .map(row => { const previous = history.flatMap(operation => operation.preview.rows).find(previous => previous.nodeId === row.nodeId && previous.relativePath === row.relativePath && previous.protectedReason);
        if (previous) row.protectedReason ||= previous.protectedReason; return row; });
    for (const candidate of candidates) {
      const node = scope.nodes.find(row => row.id === candidate.nodeId);
      if (!node) { result.blockers.push({ code: "SERVER_IDENTITY_UNVERIFIED", nodeId: candidate.nodeId, detail: candidate.relativePath }); continue; }
      const absolutePath = node.kind === "local" ? path.join(node.root, candidate.relativePath) : path.posix.join(node.root, candidate.relativePath);
      const row: CleanupRow = { ...candidate, id: cleanupDigest([node.id, node.root, candidate.relativePath, candidate.type]), node,
        absolutePath, destination: "clean_dir/" + (archiveBatch ? archiveBatch + "/" : "") + candidate.relativePath, ...(archiveBatch ? { archiveBatch } : {}),
        disposition: candidate.protectedReason ? "protected" : node.error ? "unverified" : action };
      result.rows.push(row);
    }
    if (scope.job) result.rows.sort((a, b) => Number(a.type === "directory") - Number(b.type === "directory"));
    // Parent targets absorb exact registered children only; evidence is preserved in the parent review.
    for (const row of result.rows) if (row.disposition === action) {
      const child = result.rows.filter(other => other !== row && other.node.id === row.node.id && under(row.relativePath, other.relativePath));
      if (child.some(other => other.disposition === "protected")) { row.disposition = "protected"; row.protectedReason = "包含受保护资产"; }
    }
    for (const row of result.rows) if (row.disposition === action && result.rows.some(parent => parent !== row && parent.node.id === row.node.id
      && parent.type === "directory" && parent.disposition === action && under(parent.relativePath, row.relativePath))) {
      row.disposition = "protected"; row.protectedReason = "由同批精确父目录处理（保留逐项证据）";
    }
    const physical = new Map<string, CleanupRow>();
    for (const [index, node] of scope.nodes.entries()) {
      const rows = result.rows.filter(row => row.node.id === node.id && row.disposition === action);
      const progress = { phase: "nodes", completed: index, total: scope.nodes.length };
      notify({ ...progress, message: node.id + "：检查身份、SHA256 与目标冲突（" + rows.length + " 个目标）…" });
      if (node.error) { result.blockers.push({ code: "OFFLINE_NODE", nodeId: node.id, detail: node.error });
        notify({ ...progress, completed: index + 1, message: node.id + "：离线，保留未处理信号" }); continue; }
      if (!rows.length) { notify({ ...progress, completed: index + 1, message: node.id + "：无可处理的独占目标" }); continue; }
      try {
        const backend = await this.ports.sftp("files.cleanup.preview", { node, action, targets: rows.map(row => ({ relativePath: row.relativePath, type: row.type,
          destination: row.destination, expectedSha256: row.expectedSha256, expectedOwner: row.expectedOwner, archiveBatch: row.archiveBatch })) });
        rows.forEach((row, index) => {
          const info = backend.targets[index];
          Object.assign(row, { ...info, relativePath: row.relativePath, destination: row.destination,
            backendToken: backend.token, backendDigest: backend.digest, backendIndex: index, rootIdentity: backend.rootIdentity });
          if (info.missing) { row.disposition = "absent"; return; }
          const key = cleanupDigest([backend.rootIdentity, info.device, info.inode]);
          const previous = physical.get(key);
          if (previous) { row.disposition = "protected"; row.protectedReason = "同一物理目标，已由 " + previous.node.id + " 处理"; }
          else physical.set(key, row);
          for (const ref of info.references || []) if (!under(row.relativePath, ref.path) && !result.rows.some(other => other.node.id === node.id && other.relativePath === ref.path)) {
            result.rows.push({ nodeId: node.id, node, relativePath: ref.path, type: ref.type, category: ref.field === "code_backup_ref" || ref.field === "code_backup_path" ? "代码备份引用" : "配置/checkpoint 外部引用",
              owners: [scope.planKey], evidence: ["manifest=" + ref.manifest + " SHA256=" + ref.manifestSha256], dependencies: ["外部共享引用尚未完整证明"],
              protectedReason: "缺少该引用的独占所有权证明", disposition: "protected", id: cleanupDigest([node.id, ref.path]),
              absolutePath: node.kind === "local" ? path.join(node.root, ref.path) : path.posix.join(node.root, ref.path), destination: "clean_dir/" + ref.path });
          }
        });
        // A physical alias may share a backend batch with unique targets. Freeze
        // a new capability containing only the paths the user can approve here.
        const approved = rows.filter(row => row.disposition === action);
        if (approved.length && rows.some(row => row.disposition === "protected")) {
          const exact = await this.ports.sftp("files.cleanup.preview", { node, action,
            targets: approved.map(row => ({ relativePath: row.relativePath, type: row.type, destination: row.destination,
              expectedSha256: row.expectedSha256, expectedOwner: row.expectedOwner, archiveBatch: row.archiveBatch })) });
          if (cleanupDigest(exact.rootIdentity) !== cleanupDigest(backend.rootIdentity)
            || exact.targets.length !== approved.length
            || approved.some((row, index) => exact.targets[index].fingerprint !== row.fingerprint)) cleanupError("PREVIEW_CHANGED");
          approved.forEach((row, index) => Object.assign(row, { backendToken: exact.token, backendDigest: exact.digest, backendIndex: index }));
        }
      } catch (error: any) {
        const code = error.apiData?.code || error.code || "NODE_PREFLIGHT_FAILED";
        result.blockers.push({ code, nodeId: node.id, detail: String(error.message || code) });
        rows.forEach(row => { row.disposition = "unverified"; row.error = code; });
      } finally {
        notify({ ...progress, completed: index + 1, message: node.id + "：节点预检已结束，异常会列入审核表" });
      }
    }
    // Shared/unknown targets remain visible, with hashes when read-only inspection is possible.
    const protectedRows = result.rows.filter(row => row.disposition === "protected" && !row.fingerprint && row.node.root && !row.node.error);
    for (const [index, row] of protectedRows.entries()) {
      const progress = { phase: "protected", completed: index, total: protectedRows.length };
      notify({ ...progress, message: row.node.id + "：只读核对受保护条目，保持原样…" });
      try {
        const info = await this.ports.sftp("files.cleanup.inspect", { node: row.node, target: { relativePath: row.relativePath, type: row.type, expectedOwner: row.expectedOwner } });
        Object.assign(row, info.target);
      } catch { row.error ||= "受保护目标未读取或不存在；不会处理"; }
      notify({ ...progress, completed: index + 1, message: "受保护条目核对完成，保持原样" });
    }
    for (const row of result.rows.filter(row => row.disposition === action && row.fingerprint)) {
      const previous = history.flatMap(operation => operation.preview.rows).find(previous => previous.id === row.id && previous.fingerprint);
      if (previous && previous.fingerprint !== row.fingerprint) cleanupError("SOURCE_RECREATED_OR_CHANGED");
    }
    result.rows.push(...completed);
    result.digest = cleanupDigest({ action, scope, rows: result.rows, verifiedOnly: result.verifiedOnly });
    this.previews.set(token, clone(result));
    notify({ phase: "complete", message: "预览检查完成，尚未执行清理" });
    return clone(result);
  }
  private assertAllowed(preview: CleanupPreview) {
    if (preview.blockers.some(row => !(preview.verifiedOnly && ["OFFLINE_NODE", "NODE_UNREACHABLE"].includes(row.code))))
      cleanupError("PREFLIGHT_BLOCKED", JSON.stringify(preview.blockers));
    if (!preview.rows.some(row => row.disposition === preview.action)
      && !(preview.continuationOf && preview.rows.some(row => ["absent", "completed"].includes(row.disposition)))) cleanupError("NO_VERIFIED_TARGETS");
  }
  async confirm(params: { token: string; digest: string; phase: number; confirm: boolean; exactTargets: string[] }): Promise<CleanupOperation> {
    let preview = this.previews.get(params.token);
    if (!preview) preview = (await this.status(params.token)).preview;
    if (Date.now() > preview.expiresAt) cleanupError("PREVIEW_EXPIRED");
    this.assertAllowed(preview);
    const exact = preview.rows.filter(row => row.disposition === preview.action).map(row => row.node.id + ":" + row.absolutePath);
    if (params.confirm !== true || params.digest !== preview.digest || cleanupDigest(params.exactTargets) !== cleanupDigest(exact)
      || params.phase !== preview.confirmations + 1 || params.phase > (preview.action === "delete" ? 2 : 1)) cleanupError("CONFIRM_REQUIRED");
    await this.revalidate(preview);
    if (preview.continuationOf) {
      const previous = await this.status(preview.continuationOf);
      if (previous.continuedBy && previous.continuedBy !== preview.token || previous.restoredBy || this.busy.has(previous.id)) cleanupError("NOT_CONTINUABLE");
    }
    for (const [backendToken, row] of new Map(preview.rows.filter(row => row.disposition === preview!.action).map(row => [row.backendToken!, row]))) {
      const backend = await this.ports.sftp("files.cleanup.status", { token: backendToken });
      await this.ports.sftp("files.cleanup.confirm", { token: backendToken, digest: row.backendDigest, phase: params.phase,
        confirm: true, exactTargets: backend.targets.filter((target: any) => !target.missing).map((target: any) => target.absolutePath) });
    }
    preview.confirmations = params.phase;
    const operation: CleanupOperation = { id: preview.token, preview: clone(preview), state: "ready", targets: Object.fromEntries(
      preview.rows.filter(row => row.disposition === preview!.action).map(row => [row.id, { state: "pending" }])),
      pendingNodes: [...new Set(preview.blockers.map(row => row.nodeId).filter(Boolean))] as string[], updatedAt: "" };
    await this.save(operation); this.previews.set(preview.token, clone(preview));
    if (preview.continuationOf) {
      const previous = await this.status(preview.continuationOf); previous.continuedBy = operation.id; await this.save(previous);
    }
    return clone(operation);
  }
  private async revalidate(preview: CleanupPreview, operation?: CleanupOperation) {
    if (preview.action === "restore") { await this.ports.restoreGate(preview, operation); return; }
    const prior = preview.continuationOf ? await this.history(preview.continuationOf) : [];
    const completed = await this.completedHistory(prior);
    const archivedFiles = { ...(preview.action === "move" ? this.archivedMetadata(completed) : {}), ...Object.fromEntries(preview.rows.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && operation?.targets[row.id]?.state === "completed" && preview.action === "move").map(row => [row.relativePath, row.destination])) };
    const fresh = await this.ports.collect(preview.scope.planFile, { archivedFiles, removedMetadata: this.removedMetadata(prior, completed), job: preview.scope.job });
    if (fresh.revision !== preview.scope.revision || fresh.planHash !== preview.scope.planHash) cleanupError("PREVIEW_CHANGED");
    const allowedOffline = new Set(preview.verifiedOnly ? preview.blockers.filter(row => ["OFFLINE_NODE", "NODE_UNREACHABLE"].includes(row.code)).map(row => row.nodeId) : []);
    if (fresh.blockers.some(row => !allowedOffline.has(row.nodeId))) cleanupError("ACTIVE_OR_UNVERIFIED_NODE", JSON.stringify(fresh.blockers));
    for (const row of preview.rows.filter(row => row.disposition === "protected" && row.fingerprint && !row.node.error)) {
      if (operation && preview.rows.some(parent => operation.targets[parent.id]?.state === "completed"
        && (parent.node.id === row.node.id && under(parent.relativePath, row.relativePath)
          || parent.inode === row.inode && parent.device === row.device && cleanupDigest(parent.rootIdentity) === cleanupDigest(row.rootIdentity)))) continue;
      const current = await this.ports.sftp("files.cleanup.inspect", { node: row.node, target: { relativePath: row.relativePath, type: row.type, expectedOwner: row.expectedOwner } });
      if (current.target.fingerprint !== row.fingerprint) cleanupError("DEPENDENCY_CHANGED");
    }
  }
  async execute(id: string): Promise<CleanupOperation> {
    if (this.busy.has(id)) cleanupError("OPERATION_BUSY");
    const operation = await this.status(id), preview = operation.preview;
    if (operation.continuedBy || operation.restoredBy) cleanupError("OPERATION_SUPERSEDED");
    if (preview.confirmations !== (preview.action === "delete" ? 2 : 1)) cleanupError("CONFIRM_REQUIRED");
    if (operation.state === "completed") return operation;
    this.busy.add(id); this.cancelled.delete(id);
    try {
      // A moved PLAN/config can disappear before its response reaches us. Settle
      // that frozen receipt first; this endpoint cannot launch another move.
      for (const row of preview.rows.filter(row => operation.targets[row.id]?.state === "executing")) {
        const response = await this.ports.sftp("files.cleanup.settle", { token: row.backendToken, digest: row.backendDigest, index: row.backendIndex });
        if (!["completed", "pending"].includes(response.state)) cleanupError("RECEIPT_UNVERIFIED");
        operation.targets[row.id] = response.state === "completed" ? { state: "completed", receipt: response.receipt } : { state: "pending" };
        await this.save(operation);
      }
      for (const row of preview.rows.filter(row => operation.targets[row.id]?.state === "completed"))
        await this.ports.sftp("files.cleanup.verify", { token: row.backendToken, index: row.backendIndex });
      if (preview.continuationOf || Object.values(operation.targets).some(target => target.state !== "completed")) await this.revalidate(preview, operation);
      for (const row of preview.rows.filter(row => row.disposition === "absent")) {
        const check = await this.ports.sftp("files.cleanup.preview", { node: row.node, action: preview.action,
          targets: [{ relativePath: row.relativePath, destination: row.destination, type: row.type, archiveBatch: row.archiveBatch, expectedOwner: row.expectedOwner }] });
        if (!check.targets[0].missing || cleanupDigest(check.rootIdentity) !== cleanupDigest(row.rootIdentity)) cleanupError("PREVIEW_CHANGED");
      }
      // Recheck every unprocessed node before any mutation; successful targets are never resent.
      for (const row of preview.rows.filter(row => operation.targets[row.id]?.state === "pending")) {
        const check = await this.ports.sftp("files.cleanup.preview", { node: row.node, action: preview.action,
          targets: [{ relativePath: row.relativePath, destination: row.destination, type: row.type, archiveBatch: row.archiveBatch, expectedOwner: row.expectedOwner }] });
        if (check.targets[0].fingerprint !== row.fingerprint || cleanupDigest(check.rootIdentity) !== cleanupDigest(row.rootIdentity)) cleanupError("PREVIEW_CHANGED");
      }
      if (preview.continuationOf) for (const previous of await this.history(preview.continuationOf)) {
        for (const row of previous.preview.rows.filter(row => previous.targets[row.id]?.state === "executing"
          && preview.rows.some(done => done.id === row.id && done.disposition === "completed"))) {
          const response = await this.ports.sftp("files.cleanup.settle", { token: row.backendToken, digest: row.backendDigest, index: row.backendIndex });
          if (response.state !== "completed") cleanupError("RECEIPT_UNVERIFIED");
          previous.targets[row.id] = { state: "completed", receipt: response.receipt }; await this.save(previous);
        }
      }
      operation.state = "running"; delete operation.error; await this.save(operation);
      for (const row of preview.rows.filter(row => operation.targets[row.id])) {
        const state = operation.targets[row.id];
        if (state.state === "completed") continue;
        if (this.cancelled.has(id) || (await this.status(id)).state === "paused") { operation.state = "paused"; await this.save(operation); return operation; }
        state.state = "executing"; await this.save(operation);
        const response = await this.ports.sftp("files.cleanup.execute", { token: row.backendToken, digest: row.backendDigest, index: row.backendIndex });
        state.state = "completed"; state.receipt = response.receipt; delete state.error; await this.save(operation);
      }
      operation.state = operation.pendingNodes.length ? "partial" : "completed";
      if (!operation.indexed) { await this.ports.updateIndexes(operation, preview.action === "restore"); operation.indexed = true; }
      await this.save(operation); return clone(operation);
    } catch (error: any) {
      operation.state = "blocked"; operation.error = String(error.message || error);
      await this.save(operation); throw Object.assign(error, { apiData: { ...error.apiData, operationId: id, state: operation.state } });
    } finally { this.busy.delete(id); }
  }
  async cancel(id: string) {
    const operation = await this.status(id); this.cancelled.add(id);
    if (operation.state !== "completed") { operation.state = "paused"; await this.save(operation); }
    return operation;
  }
  async restorePreview(id: string): Promise<CleanupPreview> {
    const original = await this.status(id);
    if (original.preview.action !== "move" || original.restoredBy || original.continuedBy) cleanupError("NOT_RESTORABLE");
    // Dependencies and live activity remain gates; original PLAN may be absent after a successful move.
    const preview = clone(original.preview); preview.token = randomBytes(24).toString("hex"); preview.action = "restore";
    delete preview.continuationOf;
    preview.originalOperationId = id; preview.confirmations = 0; preview.expiresAt = Date.now() + 30 * 60 * 1000;
    preview.blockers = [];
    preview.rows = [];
    for (const row of (await this.completedHistory(await this.history(id))).filter(row => row.fingerprint)) {
      const backend = await this.ports.sftp("files.cleanup.preview", { node: row.node, action: "restore",
        targets: [{ relativePath: row.destination, type: row.type, destination: row.relativePath, archiveBatch: row.archiveBatch }] });
      if (backend.targets[0].contentFingerprint !== row.contentFingerprint || backend.targets[0].inode !== row.inode) cleanupError("CONTENT_CHANGED");
      preview.rows.push({ ...row, ...backend.targets[0], relativePath: row.destination, destination: row.relativePath, disposition: "restore",
        backendToken: backend.token, backendDigest: backend.digest, backendIndex: 0, rootIdentity: backend.rootIdentity });
    }
    if (!preview.rows.length) cleanupError("NO_VERIFIED_TARGETS");
    preview.digest = cleanupDigest(preview.rows); this.previews.set(preview.token, clone(preview)); return preview;
  }
}
