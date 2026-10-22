import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteText } from "../state/StateStore";
import { FAST_CONFIRMED_BATCH_CAP, assertFastDeletePreviewSafety, chunkFastDeleteTargets, fastDeleteVerifiedBy, isFastDeleteUpgradeCode } from "./FastDeleteContract";
import { BATCH_OBSERVATION_UPGRADE_CODE, BATCH_OBSERVATION_UPGRADE_MESSAGE, createObservationRound, observeRound, type ObservationEntry, type ObservationRound, type ObserveTarget } from "./ObservationRound";

export type CleanupNode = { id: string; kind: "local" | "remote"; root: string; host?: string; port?: number; user?: string; error?: string };
export type CleanupJobSelection = { workflowId: string; index: number; commandId: string; purpose?: "replace_outputs";
  manifest?: { declarations: Array<{ index: number; case: string; seed: number; output_dir: string; result_csv: string;
    checkpoint_source?: Record<string, string> | string }>; replacement: boolean } };
export type CleanupCandidate = { nodeId: string; relativePath: string; type: "file" | "directory"; category: string;
  owners: string[]; evidence: string[]; protectedReason?: string; scopeProtectedReason?: string; dependencies: string[]; expectedSha256?: string;
  requiredInputs?: string[];
  expectedOwner?: { workflowId: string; commandId: string; workerId: string; outputDir: string; attempt?: number; case: string; seed: number;
    resultPathPolicy?: "declared"; globalJobId?: string; planRevision?: string; codeFingerprint?: string; index?: number; collectionResultCsv?: string; expectedState?: string } };
export type CleanupScope = { projectId: string; planKey: string; planFile: string; planHash: string; runIds: string[];
  authorizationMode?: "confirmed_paths";
  associationBlockers?: CleanupScope["blockers"];
  observationMode?: "managed_tmux";
  nativeDeclarations?: Array<{ index: number; case: string; seed: number; output_dir: string; result_csv: string }>;
  revision: string; nodes: CleanupNode[]; candidates: CleanupCandidate[]; references?: Record<string, string[]>; job?: CleanupJobSelection;
  blockers: Array<{ code: string; nodeId?: string; detail: string; busy?: Record<string, unknown> }>;
  notices?: Array<{ code: string; nodeId?: string; detail: string }> };
export type CleanupRemovedMetadata = { planKey: string; planHash: string; planFile: string; runIds: string[];
  hashes: Record<string, string>; references: Record<string, string[]> };
export type CleanupProgress = { phase: string; message: string; completed?: number; total?: number };
export type CleanupProgressSink = (progress: CleanupProgress) => void;
export type CleanupRow = CleanupCandidate & { id: string; node: CleanupNode; destination: string; fingerprint?: string;
  contentFingerprint?: string; size?: number; absolutePath: string; inventory?: any[]; inode?: string; device?: string;
  backendToken?: string; backendDigest?: string; backendIndex?: number; rootIdentity?: Record<string, unknown>;
  archiveBatch?: string;
  disposition: "move" | "delete" | "restore" | "isolate" | "protected" | "unverified" | "absent" | "completed"; error?: string };
export type CleanupPreview = { token: string; digest: string; action: "move" | "delete" | "restore" | "isolate"; scope: CleanupScope;
  rows: CleanupRow[]; blockers: CleanupScope["blockers"]; verifiedOnly: boolean; expiresAt: number; confirmations: number;
  originalOperationId?: string; continuationOf?: string };
export type CleanupNodeCheck = { operationId: string; nodeId: string; checkedAt: string;
  state: "confirmation_required" | "settlement_required" | "blocked";
  targets: Array<{ id: string; absolutePath: string; state: string; code?: string }> };
export type CleanupOperation = { id: string; preview: CleanupPreview; state: "ready" | "running" | "paused" | "partial" | "completed" | "blocked";
  executionRequestedAt?: string;
  targets: Record<string, { state: "pending" | "executing" | "completed"; receipt?: any; error?: string }>;
  pendingNodes: string[]; error?: string; updatedAt: string; indexed?: boolean; restoredBy?: string; continuedBy?: string;
  nodeChecks?: Record<string, CleanupNodeCheck>; retirementPendingNodes?: string[] };
export type CleanupPorts = {
  collect(planFile: string, options?: { archivedFiles: Record<string, string>; removedMetadata?: CleanupRemovedMetadata; onProgress?: CleanupProgressSink; job?: CleanupJobSelection; nativeDeclarations?: CleanupScope["nativeDeclarations"]; authorizationMode?: "confirmed_paths" }): Promise<CleanupScope>;
  sftp(method: string, params: any): Promise<any>;
  updateIndexes(operation: CleanupOperation, restore: boolean): Promise<void>;
  restoreGate(preview: CleanupPreview, operation?: CleanupOperation): Promise<void>;
  currentNode?(id: string): Promise<CleanupNode>;
  validateScope?(scope: CleanupScope): Promise<void>;
  storageRoot: string;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// SimpleSFTP bounds each local/SSH cleanup read at 60 seconds. Let that
// transport finish instead of racing it with a shorter independent deadline.
const CLEANUP_QUERY_TIMEOUT_MS = 65_000;
export const cleanupDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const cleanupJobKey = (job?: CleanupJobSelection) => cleanupDigest(job ? [job.workflowId, job.index, job.commandId, job.purpose || "failed_review"] : null);
/**
 * 只接受配套 SimpleSFTP 那份 schemaVersion:1 忙快照的形状：未知字段一律丢弃、字符串截断、队列键只有一向哈希。
 * 目的是把“是哪一类忙、各多少条”作为结构化证据带回审核链，而不是靠错误文案的字符串再解析一次。
 */
export function busyEvidenceFromError(error: any): Record<string, unknown> | undefined {
  const source = error && error.apiData && error.apiData.busy;
  if (!source || typeof source !== "object" || (source as any).schemaVersion !== 1) return undefined;
  const flag = (value: unknown) => value === true;
  const row = (value: any, fields: string[]) => value && typeof value === "object"
    ? Object.fromEntries(fields.filter(field => typeof value[field] === "string" && value[field]).map(field => [field, String(value[field]).slice(0, 40)])) : null;
  const transferList = (value: any) => Array.isArray(value) ? value.map(item => {
    const base = row(item, ["id", "status", "operation", "phase"]);
    // 只读观测标记只认真布尔：外部对象不能用字符串冒充，也不能带进其它字段。
    if (!base) return null;
    return { ...base, readOnlyObserver: flag(item.readOnlyObserver), selfAttempt: flag(item.selfAttempt) };
  }).filter(Boolean).slice(0, 12) : [];
  const list = (value: any, fields: string[]) => Array.isArray(value) ? value.map(item => row(item, fields)).filter(Boolean).slice(0, 12) : [];
  const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  const rows = transferList((source as any).activeTransfers);
  const reportedBlocking = Number.isInteger((source as any).blockingTransferCount) && Number((source as any).blockingTransferCount) >= 0;
  // 旧版配套（0.2.103 及更早）的封套里没有 blocking/observer 之分：那时每条非终态传输都真的算阻断。
  // 缺字段就按「全部在途传输都阻断」保守回退，绝不凭空报 0；同时留下 legacyBusyShape 事实，
  // 让文案说明这是旧版封套的保守口径，而不是实测出来的只读/写入拆分。
  const totalTransfers = Number.isInteger((source as any).activeTransferCount)
    ? Math.max(Number((source as any).activeTransferCount), rows.length) : rows.length;
  const queues = (source as any).uploadQueues && typeof (source as any).uploadQueues === "object" ? (source as any).uploadQueues as any : {};
  const hashes = Array.isArray(queues.keyHashes) ? queues.keyHashes.map(String).filter((key: string) => /^[0-9a-f]{6,64}$/.test(key)).slice(0, 12) : [];
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    observedAt: String((source as any).observedAt || "").slice(0, 40),
    instanceId: String((source as any).instanceId || "").slice(0, 60),
    busy: (source as any).busy === true,
    activeTransferCount: count((source as any).activeTransferCount),
    blockingTransferCount: reportedBlocking ? Number((source as any).blockingTransferCount) : totalTransfers,
    activeTransfers: rows,
    uploadOperationCount: count((source as any).uploadOperationCount),
    uploadOperations: list((source as any).uploadOperations, ["id", "stage"]),
    uploadQueueCount: count((source as any).uploadQueueCount) || hashes.length,
    uploadQueues: { count: count((source as any).uploadQueueCount) || hashes.length, keyHashes: hashes },
  };
  if ((source as any).truncated === true) evidence.truncated = true;
  // 新增计数字段缺失就整体不带：缺证据不等于 0 条，宁可让文案显示未报也不虚报。
  for (const field of ["observerTransferCount", "selfAttemptCount"] as const) {
    const value = (source as any)[field];
    if (Number.isInteger(value) && Number(value) >= 0) evidence[field] = value;
  }
  if (!reportedBlocking) evidence.legacyBusyShape = true;
  return evidence;
}

export function cleanupError(code: string, detail = code): never {
  const error = Object.assign(new Error(detail), { apiCode: code === "CONFIRM_REQUIRED" ? 2001 : 2010, apiData: { code, detail } });
  throw error;
}
export function cleanupRelative(value: string): string {
  if (!value || value.length > 4096 || /[\\:\x00-\x1f*?\[\]{}]/.test(value) || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === "..")) cleanupError("UNSAFE_PATH");
  return value;
}
/**
 * Isolate previews must carry the job's own declared checkpoint/config inputs as
 * requiredInputs so the frozen B guard (≤200 items, each 1..4096, POSIX relative;
 * backslash/colon/control and . or .. segments rejected) refuses parent-directory
 * isolation that would move those inputs. Values come from the PLAN job's
 * structured checkpoint_source *_path entries; root-prefixed values are anchored
 * and stripped per node, relative values anchor to that node's root. Anything the
 * chain cannot resolve safely (foreign root, drive leftover, .., forbidden chars,
 * length/count overflow) returns an explicit error so the caller pauses that job —
 * never a silent drop, research-path rewrite or input copy.
 */
export function isolateRequiredInputPaths(declaration: any, node: CleanupNode): { inputs?: string[]; error?: string } {
  const source = declaration?.checkpoint_source ?? declaration?.checkpointSource;
  if (source === undefined || source === null) return { inputs: [] };
  const entries: Array<[string, unknown]> = typeof source === "string" ? [["checkpoint_source", source]]
    : typeof source === "object" && !Array.isArray(source)
      ? Object.entries(source).filter(([key]) => key.endsWith("_path"))
      : [];
  if (!entries.length) return typeof source === "object" && !Array.isArray(source) ? { inputs: [] } : { error: "checkpoint_source 不是结构化的路径映射" };
  const root = String(node.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const fold = process.platform === "win32" || /^[a-z]:\//i.test(root);
  const startsWith = (value: string, prefix: string) => fold ? value.toLowerCase().startsWith(prefix.toLowerCase()) : value.startsWith(prefix);
  const inputs = new Set<string>();
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !value.trim()) return { error: "checkpoint_source." + key + " 不是可用的非空路径" };
    let rel = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (rel.startsWith("/") || /^[a-z]:\//i.test(rel)) {
      if (!root || !startsWith(rel, root + "/")) return { error: "checkpoint_source." + key + " 为本机无法锚定到该服务器根的路径" };
      rel = rel.slice(root.length + 1);
    }
    const parts = rel.split("/").filter(part => part !== ".");
    if (!parts.length || parts.some(part => !part || part === "..")) return { error: "checkpoint_source." + key + " 含无法安全解析的路径段" };
    rel = parts.join("/");
    if (!rel || rel.length > 4096 || /[\x00-\x1f:*?\[\]{}]/.test(rel)) return { error: "checkpoint_source." + key + " 无法表示为服务器要求的相对路径合同" };
    inputs.add(rel);
  }
  if (inputs.size > 200) return { error: "checkpoint_source 声明的输入数量超过服务器上限 200" };
  return { inputs: [...inputs].sort() };
}
const under = (base: string, file: string) => file === base || file.startsWith(base + "/");

/** Ownership is an explicit registry join. Names, modification times and prefixes are never evidence. */
export function classifyCleanupCandidates(scope: CleanupScope): CleanupCandidate[] {
  return scope.candidates.map(input => {
    const row = clone(input), rel = cleanupRelative(row.relativePath);
    // A PLAN review cannot expand into shared configuration or the PLAN itself.
    // This restriction is separate from ownership warnings on exact artifact paths.
    if (row.scopeProtectedReason) { row.protectedReason = row.scopeProtectedReason; return row; }
    if (scope.authorizationMode === "confirmed_paths" && row.nodeId !== "pluginState") {
      if (row.protectedReason) row.evidence.push("原关联提示（由用户核对路径后决定）：" + row.protectedReason);
      delete row.protectedReason;
      return row;
    }
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
  private observing = new Map<string, Promise<CleanupOperation>>();
  constructor(private readonly ports: CleanupPorts) {}
  private file(id: string) { if (!/^[a-f0-9]{48}$/.test(id)) cleanupError("INVALID_OPERATION_ID"); return path.join(this.ports.storageRoot, id + ".json"); }
  private async save(operation: CleanupOperation) {
    operation.updatedAt = new Date().toISOString();
    const record = clone(operation);
    if (record.preview.action === "delete" && record.state === "completed" && !record.pendingNodes.length && !record.retirementPendingNodes?.length) {
      // Keep only the consumed request identity. No deleted-file inventory, path
      // cache or restore/audit payload survives completion of permanent deletion.
      record.preview.rows = []; record.targets = {}; record.nodeChecks = {};
      record.preview.scope.nodes = []; record.preview.scope.candidates = [];
      record.preview.scope.references = {}; delete record.preview.scope.nativeDeclarations;
      if (record.preview.scope.job) delete record.preview.scope.job.manifest;
      record.preview.blockers = []; record.preview.scope.blockers = []; record.preview.scope.notices = [];
      delete record.preview.scope.associationBlockers;
      record.preview.digest = ""; record.preview.expiresAt = 0;
      delete record.error; delete record.executionRequestedAt;
    }
    await atomicWriteText(this.file(operation.id), JSON.stringify(record, null, 2));
  }
  async status(id: string, round?: ObservationRound): Promise<CleanupOperation> {
    const ownRound = round === undefined;
    const observationRound = round ?? this.newObservationRound();
    try {
      const originalText = await fs.readFile(this.file(id), "utf8");
      const operation = JSON.parse(originalText);
      const inspectDeletion = operation.preview.action === "delete" && operation.state !== "completed"
        && !operation.continuedBy && !operation.restoredBy && !this.busy.has(id);
      if (!inspectDeletion && (operation.preview.scope.observationMode !== "managed_tmux" || !operation.executionRequestedAt)) return operation;
      if (!this.observing.has(id)) this.observing.set(id, (async () => {
        let observed = inspectDeletion ? await this.observeDeletion(operation, observationRound) : operation;
        if (!inspectDeletion && observed.preview.scope.observationMode === "managed_tmux" && observed.executionRequestedAt)
          observed = await this.observeManaged(observed);
        if (observed.state === "completed" && !observed.indexed) {
          await this.ports.updateIndexes(observed, observed.preview.action === "restore"); observed.indexed = true;
        }
        // A late old round must never overwrite what a newer round already persisted.
        if (await fs.readFile(this.file(id), "utf8") !== originalText) return JSON.parse(await fs.readFile(this.file(id), "utf8"));
        await this.save(observed); return observed;
      })().finally(() => this.observing.delete(id)));
      return clone(await this.observing.get(id)!);
    }
    catch (error: any) { if (error.code === "ENOENT") cleanupError("OPERATION_NOT_FOUND"); throw error; }
    finally { if (ownRound) observationRound.closed = true; }
  }
  private newObservationRound(): ObservationRound {
    return createObservationRound({ sftp: (method, params) => this.ports.sftp(method, params), digest: cleanupDigest, timeoutMs: CLEANUP_QUERY_TIMEOUT_MS });
  }
  /** Build one contract observe target from a frozen row; tokens only travel with their own index. */
  private observeTargetOf(row: CleanupRow): ObserveTarget {
    const target: ObserveTarget = { key: row.id, relativePath: row.relativePath, type: row.type };
    if (row.backendToken && Number.isInteger(row.backendIndex)) { target.backendToken = row.backendToken; target.backendIndex = row.backendIndex; }
    if (row.device !== undefined) target.device = row.device;
    if (row.inode !== undefined) target.inode = row.inode;
    const isolationName = (row as { isolationName?: unknown }).isolationName;
    if (row.type === "directory" && typeof isolationName === "string" && isolationName) {
      const parent = path.posix.dirname(row.relativePath);
      target.isolationRelativePath = (parent === "." ? "" : parent + "/") + isolationName;
    }
    return target;
  }
  /** Map one real SimpleSFTP answer (status present/gone/replaced plus the narrowed token state, 42e48932) to a row verdict. */
  private roundVerdict(entry: ObservationEntry, requestedIsolation: boolean): "absent" | "present" | "executing" | "residue" | "unknown" {
    if (entry.error) return "unknown";
    if (entry.isolationStatus === "present") return "residue";
    if (requestedIsolation && entry.status === "present" && entry.isolationChecked !== true) return "unknown";
    if (entry.state === "executing" || (entry.executorsChecked === true && Boolean(entry.executors?.length))) return "executing";
    // Recovery baseline (pre-batching): a same-path entry recreated under a new identity is still on
    // disk. The narrowed token state must not collapse that into absence; only real absence settles a row.
    if (entry.status === "replaced" && entry.target && entry.target.missing === false) return "present";
    if (entry.state === "completed") return "absent";
    if (entry.state === undefined && (entry.status === "gone" || entry.status === "replaced")) return "absent";
    if (entry.state === "pending") return "present";
    if (entry.state === undefined && entry.status === "present") return "present";
    return "unknown";
  }
  private async query(row: CleanupRow, method: string, params: any, timeoutMs = CLEANUP_QUERY_TIMEOUT_MS): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = new AbortController();
    if (this.ports.currentNode && this.nodeIdentity(await this.ports.currentNode(row.node.id)) !== this.nodeIdentity(row.node))
      cleanupError("SERVER_IDENTITY_CHANGED");
    try {
      return await Promise.race([this.ports.sftp(method, { ...params, signal: params.signal ? AbortSignal.any([params.signal, read.signal]) : read.signal }), new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error(row.node.id + "：核实 " + row.absolutePath
          + " 超时；请重试查询，未重新执行文件操作。"), { apiData: { code: "CLEANUP_QUERY_TIMEOUT", nodeId: row.node.id, path: row.absolutePath, method } });
          read.abort(error); reject(error);
        }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Independent nodes query together; each node has only one read in flight. */
  private async queryRows(rows: CleanupRow[], read: (row: CleanupRow) => Promise<void>) {
    const nodes = new Map<string, CleanupRow[]>();
    for (const row of rows) { const group = nodes.get(row.node.id) || []; group.push(row); nodes.set(row.node.id, group); }
    const groups = [...nodes.values()];
    for (let offset = 0; offset < groups.length; offset += 4)
      await Promise.all(groups.slice(offset, offset + 4).map(async group => { for (const row of group) await read(row); }));
  }
  private async inspectPresence(row: CleanupRow, timeoutMs = CLEANUP_QUERY_TIMEOUT_MS, observeExecutors = false): Promise<any> {
    const proof: any = await this.query(row, "files.cleanup.inspect", { node: row.node,
      target: { relativePath: row.relativePath, type: row.type }, allowMissing: true, manifestOnly: true, presenceOnly: true, observeExecutors }, timeoutMs);
    if (typeof proof?.target?.missing !== "boolean" && !(proof?.target?.type === row.type && typeof proof?.target?.absolutePath === "string"))
      cleanupError("UNVERIFIED_RESPONSE");
    return proof;
  }
  /** A persisted deletion is an input to a fresh query, never proof that files still exist. */
  private async observeDeletion(operation: CleanupOperation, round: ObservationRound): Promise<CleanupOperation> {
    const rows = operation.preview.rows.filter(row => row.nodeId !== "pluginState" && row.disposition !== "protected");
    let executing = false, queryFailed = false;
    delete operation.error;
    if (!rows.length) return operation;
    if (operation.preview.scope.authorizationMode === "confirmed_paths") {
      // v1.10: one batched read-only observation per (node identity, root, target set), shared in the round.
      const groups = new Map<string, { node: CleanupNode; rows: CleanupRow[]; identityChanged?: boolean }>();
      for (const row of rows) {
        const key = this.nodeIdentity(row.node);
        const group = groups.get(key) || { node: row.node, rows: [] as CleanupRow[] };
        group.rows.push(row); groups.set(key, group);
      }
      if (this.ports.currentNode) for (const group of groups.values()) {
        try { for (const row of group.rows)
          if (this.nodeIdentity(await this.ports.currentNode(row.node.id)) !== this.nodeIdentity(row.node)) { group.identityChanged = true; break; } }
        catch { group.identityChanged = true; }
      }
      const entries = [...groups.values()];
      round.plannedGroups = Math.max(round.plannedGroups, entries.length);
      const outcomes = await Promise.all(entries.map(async group => {
        if (group.identityChanged) return undefined;
        const targets = group.rows.map(row => this.observeTargetOf(row));
        const rootIdentity = group.rows.map(row => row.rootIdentity).find(value => value !== undefined);
        return observeRound(round, group.node as unknown as Record<string, unknown> & { root?: string }, targets,
          rootIdentity === undefined ? {} : { rootIdentity });
      }));
      const markUnknown = (row: CleanupRow, message: string, code?: string) => {
        queryFailed = true;
        // A confirmed completion is only released by real counter-evidence, never by an unknown this round.
        if (operation.targets[row.id]?.state === "completed" && operation.targets[row.id]?.receipt?.verifiedBy) return;
        if (operation.targets[row.id]) operation.targets[row.id] = { state: "pending", error: code || message };
        operation.error ||= row.node.id + "：" + message;
      };
      for (let index = 0; index < entries.length; index++) {
        const group = entries[index]; const outcome = outcomes[index];
        for (const row of group.rows) {
          if (!outcome) { markUnknown(row, "SERVER_IDENTITY_CHANGED"); continue; }
          if (outcome.upgrade) { markUnknown(row, BATCH_OBSERVATION_UPGRADE_MESSAGE, BATCH_OBSERVATION_UPGRADE_CODE); continue; }
          if (outcome.failure) { markUnknown(row, String(outcome.failure.message), outcome.failure.code); continue; }
          const entry = outcome.byKey.get(row.id);
          if (!entry || outcome.missingKeys.includes(row.id)) { markUnknown(row, "批量观察缺少该行结果，按未知处理，不宣称不存在。", "OBSERVATION_MISSING"); continue; }
          if (entry.error) { markUnknown(row, String(entry.error.message || entry.error.code || "观察失败"), String(entry.error.code || "OBSERVATION_ERROR")); continue; }
          const verdict = this.roundVerdict(entry, this.observeTargetOf(row).isolationRelativePath !== undefined);
          if (verdict === "executing") { executing = true;
            if (operation.targets[row.id]) operation.targets[row.id] = { state: "executing" }; continue; }
          if (verdict === "residue") { markUnknown(row, "隔离名仍存在，按残留处理，未撤销已确认事实。", "ISOLATION_RESIDUE_PRESENT"); continue; }
          if (verdict === "absent") {
            // A running operation must not confirm completion without executor evidence: absence alone cannot
            // distinguish a finished deletion from a live cleanup window.
            if (operation.executionRequestedAt && entry.executorsChecked !== true) { markUnknown(row, "CLEANUP_EXECUTOR_QUERY_UNVERIFIED"); continue; }
            operation.targets[row.id] = { state: "completed",
              receipt: { source: "active_query", verifiedBy: entry.isolationStatus === "gone" ? "isolation_tree_removed" : "path_absence", rootIdentity: outcome.rootIdentity } }; continue; }
          // Counter-evidence: the frozen entry itself is still on disk (present), even when the backend state is unknown.
          const exists = verdict === "present" || (verdict === "unknown" && entry.status === "present");
          if (exists) {
            if (operation.executionRequestedAt && entry.executorsChecked !== true) { markUnknown(row, "CLEANUP_EXECUTOR_QUERY_UNVERIFIED"); continue; }
            if (operation.targets[row.id]) operation.targets[row.id] = { state: "pending",
              ...(operation.targets[row.id]?.receipt?.verifiedBy || entry.status === "replaced" ? { error: "SOURCE_RECREATED_OR_CHANGED" } : {}) };
            continue;
          }
          markUnknown(row, String(entry.isolationStatus === "unknown" ? "隔离结果未答复，按未知处理。" : "观察状态不明确，按未知处理。"), "ISOLATION_OR_STATE_UNKNOWN");
        }
      }
    }
    else await this.queryRows(rows, async row => {
      try {
        const proof = await this.inspectPresence(row, CLEANUP_QUERY_TIMEOUT_MS, Boolean(operation.executionRequestedAt));
        if (operation.executionRequestedAt && (proof.executorsChecked !== true || !Array.isArray(proof.executors)))
          cleanupError("CLEANUP_EXECUTOR_QUERY_UNVERIFIED");
        const live = Boolean(proof.executors?.length); executing ||= live;
        if (proof.target.missing === true && !live) operation.targets[row.id] = { state: "completed",
          receipt: { source: "active_query", verifiedBy: "path_absence", rootIdentity: proof.rootIdentity } };
        else if (operation.targets[row.id]) operation.targets[row.id] = { state: live ? "executing" : "pending",
          ...(operation.targets[row.id]?.receipt?.verifiedBy === "path_absence" ? { error: "SOURCE_RECREATED_OR_CHANGED" } : {}) };
      } catch (error: any) {
        queryFailed = true;
        if (operation.targets[row.id]) operation.targets[row.id] = { state: "pending", error: String(error.message || error) };
        operation.error ||= row.node.id + "：" + String(error.message || error);
      }
    });
    // Both active-query absence facts settle a row: the path is gone, or its bound isolation tree is gone.
    const absent = (row: CleanupRow) => operation.targets[row.id]?.state === "completed"
      && operation.targets[row.id]?.receipt?.source === "active_query"
      && ["path_absence", "isolation_tree_removed"].includes(operation.targets[row.id]?.receipt?.verifiedBy);
    const checkedNodes = operation.preview.scope.nodes.filter(node => rows.some(row => row.node.id === node.id)
      && rows.filter(row => row.node.id === node.id).every(absent)).map(node => node.id);
    operation.pendingNodes = operation.pendingNodes.filter(id => !checkedNodes.includes(id));
    operation.retirementPendingNodes = operation.retirementPendingNodes?.filter(id => !checkedNodes.includes(id));
    if (rows.every(absent) && !operation.pendingNodes.length && !operation.retirementPendingNodes?.length) {
      operation.state = "completed"; delete operation.error;
    } else if (executing) operation.state = "running";
    else if (queryFailed || operation.state === "running") operation.state = "partial";
    return operation;
  }
  private async managedCheck(row: CleanupRow): Promise<any> {
    return this.query(row, "files.cleanup.check", { token: row.backendToken, index: row.backendIndex });
  }
  private async observeManaged(operation: CleanupOperation): Promise<CleanupOperation> {
    let running = false, unresolved = false;
    delete operation.error;
    if (operation.preview.action === "delete" && operation.preview.scope.authorizationMode === "confirmed_paths") {
      // v1.9 fast chain: one batched active query per frozen backend batch. Pending or unknown rows
      // are reported honestly and never re-executed from an observation path.
      const groups = new Map<string, CleanupRow[]>();
      for (const row of operation.preview.rows.filter(row => operation.targets[row.id])) {
        if (operation.targets[row.id]?.receipt?.verifiedBy === "path_absence") continue;
        if (!row.backendToken) { unresolved = true; continue; }
        const group = groups.get(row.backendToken) || [];
        group.push(row); groups.set(row.backendToken, group);
      }
      for (const [backendToken, group] of groups) {
        try {
          const snapshot = await this.ports.sftp("files.cleanup.status", { token: backendToken });
          if (snapshot?.statusQueryError) { unresolved = true; operation.error = "清理批量查询未完全成功，可重新查询：" + String(snapshot.statusQueryError); }
          for (const row of group) {
            if (operation.targets[row.id]?.state === "completed" && operation.targets[row.id]?.receipt?.source === "active_query") continue;
            const observation = (snapshot?.observations || [])[row.backendIndex!] || {};
            const state = observation.state || (snapshot?.states || [])[row.backendIndex!];
            if (state === "completed") operation.targets[row.id] = { state: "completed", receipt: { source: "active_query", verifiedBy: observation.isolationStatus ? "isolation_tree_removed" : observation.status === "replaced" ? "same_name_new_data" : "path_absence", rootIdentity: snapshot?.rootIdentity } };
            else if (state === "executing" || snapshot?.batchExecuting) { running = true; operation.targets[row.id] = { state: "executing" }; }
            else { unresolved = true; operation.targets[row.id] = { state: "pending", receipt: operation.targets[row.id]?.receipt,
              error: state === "pending" ? undefined : String(observation.code || observation.isolationStatus || "ISOLATION_OR_STATE_UNKNOWN") }; }
          }
        } catch (error: any) { unresolved = true;
          group.forEach(row => { operation.targets[row.id] = { state: "pending", receipt: operation.targets[row.id]?.receipt, error: String(error.message || error) }; });
          operation.error = "清理查询失败，可重新查询：" + String(error.message || error); }
      }
      if (unresolved && !operation.error)
        operation.error = "部分目标回执未核实（隔离名残留或状态未知）；不会自动重发，可刷新实际状态后由你决定是否继续。";
    } else
    await this.queryRows(operation.preview.rows.filter(row => operation.targets[row.id]), async row => {
      if (operation.preview.action === "delete" && operation.targets[row.id]?.receipt?.verifiedBy === "path_absence") return;
      // 已核实的隔离事实由当时的主动查询回执冻结；后续注册隔离删除或查询波动不回滚完成状态。
      if (operation.preview.action === "isolate" && operation.targets[row.id]?.state === "completed") return;
      try {
        const proof = await this.managedCheck(row);
        if (proof.state === "completed") {
          operation.targets[row.id] = { state: "completed", receipt: { source: "active_query", verifiedBy: proof.verifiedBy, rootIdentity: proof.rootIdentity } };
          if (proof.executor?.exitCode !== undefined && proof.executor.exitCode !== null && proof.executor.exitCode !== 0) {
            unresolved = true; operation.error = "目标已清除，但执行器异常退出；请审核日志并重新预览剩余项。";
          }
        }
        else if (proof.state === "executing") { running = true; operation.targets[row.id] = { state: "executing" }; }
        else {
          unresolved = true; operation.targets[row.id] = { state: "pending", receipt: operation.targets[row.id]?.receipt,
            error: proof.state === "pending" ? undefined : proof.code || "CLEANUP_TARGET_CHANGED" };
        }
      } catch (error: any) { unresolved = true; operation.targets[row.id] = { state: "pending", receipt: operation.targets[row.id]?.receipt, error: String(error.message || error) };
        operation.error = "清理查询失败，可重新查询：" + String(error.message || error); }
    });
    if (operation.state !== "paused" || !unresolved && !running && !operation.pendingNodes.length)
      operation.state = running ? "running" : unresolved || operation.pendingNodes.length ? "partial" : "completed";
    return operation;
  }

  /** Apply one batched fast-verification snapshot onto frozen review rows. Never re-executes anything. */
  private applyBatchObservations(operation: CleanupOperation, group: CleanupRow[], snapshot: any): void {
    for (const row of group) {
      if (operation.targets[row.id]?.state === "completed" && operation.targets[row.id]?.receipt?.source === "active_query") continue;
      const observation = (snapshot?.observations || [])[row.backendIndex!] || {};
      const state = observation.state || (snapshot?.states || [])[row.backendIndex!];
      if (state === "completed") operation.targets[row.id] = { state: "completed", receipt: { source: "active_query", verifiedBy: fastDeleteVerifiedBy(observation), rootIdentity: snapshot?.rootIdentity } };
      else if (state === "executing" || snapshot?.batchExecuting) operation.targets[row.id] = { state: "executing" };
      else operation.targets[row.id] = { state: "pending", receipt: operation.targets[row.id]?.receipt,
        error: state === "unknown" ? String(observation.code || observation.isolationStatus || "ISOLATION_OR_STATE_UNKNOWN") : undefined };
    }
  }

  /**
   * v1.9 confirmed-path batched fast deletion: one execute and one batched active query per frozen
   * backend batch, serially. A lost execute response is resolved by the active query only — the
   * plugin never replays execute on its own; pending/unknown stay honest partial results.
   */
  private async executeConfirmedFastBatches(operation: CleanupOperation): Promise<void> {
    const groups = new Map<string, CleanupRow[]>();
    for (const row of operation.preview.rows.filter(row => operation.targets[row.id] && row.backendToken)) {
      const group = groups.get(row.backendToken!) || [];
      group.push(row); groups.set(row.backendToken!, group);
    }
    let unresolvedNote = "";
    for (const [backendToken, group] of groups) {
      const pending = () => group.filter(row => operation.targets[row.id]?.state !== "completed");
      if (this.cancelled.has(operation.id)) { operation.state = "paused"; await this.save(operation); return; }
      let snapshot: any = await this.ports.sftp("files.cleanup.status", { token: backendToken });
      this.applyBatchObservations(operation, group, snapshot);
      await this.save(operation);
      if (!pending().length) continue;
      if (this.cancelled.has(operation.id)) { operation.state = "paused"; await this.save(operation); return; }
      if (!snapshot?.batchExecuting) {
        // 取消只在执行请求发出之前生效；服务器对已接收批次整批串行执行，本端不并发第二个请求。
        group.filter(row => operation.targets[row.id]?.state !== "completed").forEach(row => { operation.targets[row.id] = { state: "executing" }; });
        await this.save(operation);
        const anchor = pending()[0];
        let sendError = "";
        try { await this.ports.sftp("files.cleanup.execute", { token: backendToken, digest: anchor.backendDigest, index: anchor.backendIndex }); }
        catch (error: any) { sendError = String(error?.message || error); }
      }
      // 执行回执只是传输证据；一轮批量主动查询解析整批事实。batchExecuting 期间继续等待，不重发。
      for (let poll = 0; poll < 240; poll++) {
        const refreshed = await this.ports.sftp("files.cleanup.status", { token: backendToken }).catch(() => undefined);
        if (refreshed) { snapshot = refreshed; this.applyBatchObservations(operation, group, snapshot); await this.save(operation); }
        if (!pending().length || !snapshot?.batchExecuting) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const unresolved = pending();
      if (unresolved.length)
        unresolvedNote = "本批 " + unresolved.length + " 个目标回执未核实（隔离名残留、状态未知或服务器仍在处理）；不会自动重发，可刷新实际状态后由你决定是否继续。";
    }
    if (unresolvedNote) operation.error = unresolvedNote;
  }


  private async executeManaged(operation: CleanupOperation): Promise<CleanupOperation> {
    if (this.busy.has(operation.id)) return this.observeManaged(operation);
    if (operation.preview.confirmations !== (operation.preview.action === "delete" ? 2 : 1)) cleanupError("CONFIRM_REQUIRED");
    await this.preflightConfirmed(operation.id);
    if (this.busy.has(operation.id)) return this.observeManaged(operation);
    this.busy.add(operation.id); this.cancelled.delete(operation.id);
    try {
      operation.executionRequestedAt ||= new Date().toISOString();
      // Standalone results precede their owning output directory and its manifest.
      const metadata = (row: CleanupRow) => ["PLAN 文件", "专用配置"].includes(row.category);
      const rows = operation.preview.rows.filter(row => operation.targets[row.id]).sort((a, b) =>
        Number(metadata(a)) - Number(metadata(b)) || Number(a.type === "directory") - Number(b.type === "directory")
        || Number(a.category === "PLAN 文件") - Number(b.category === "PLAN 文件"));
      operation.state = "running"; await this.save(operation);
      if (operation.preview.action === "delete" && operation.preview.scope.authorizationMode === "confirmed_paths") {
        // v1.9：确认路径删除按冻结后端批次整批执行，一次执行 + 批量主动查询，绝不逐文件往返。
        await this.executeConfirmedFastBatches(operation);
        if ((operation.state as string) === "paused") return operation;
      } else
      for (const row of rows) {
        if (this.cancelled.has(operation.id)) { operation.state = "paused"; await this.save(operation); return operation; }
        let proof = await this.managedCheck(row);
        if (proof.state === "completed") { operation.targets[row.id] = { state: "completed", receipt: { source: "active_query" } }; continue; }
        if (!["pending", "executing"].includes(proof.state)) throw new Error("CLEANUP_TARGET_CHANGED：剩余目标须重新预览");
        if (proof.state === "pending") {
          operation.targets[row.id] = { state: "executing" }; await this.save(operation);
          if (operation.preview.action === "isolate") {
            // 隔离是快速重命名事务：错误（如必需输入重叠、目标冲突）必须直接回传，仅排除相关 job；服务器端注册映射保证重试不重复移动。
            try { await this.ports.sftp("files.cleanup.execute", { token: row.backendToken, digest: row.backendDigest, index: row.backendIndex }); }
            catch (error) { operation.targets[row.id] = { state: "pending" }; await this.save(operation); throw error; }
          } else {
            // Do not wait for execute transport completion. The fixed capability makes retries idempotent.
            void this.ports.sftp("files.cleanup.execute", { token: row.backendToken, digest: row.backendDigest, index: row.backendIndex }).catch(() => undefined);
          }
        }
        const started = Date.now();
        while (true) {
          proof = await this.managedCheck(row);
          if (proof.state === "completed") { operation.targets[row.id] = { state: "completed", receipt: { source: "active_query", verifiedBy: proof.verifiedBy } }; await this.save(operation);
            if (proof.executor?.exitCode !== undefined && proof.executor.exitCode !== null && proof.executor.exitCode !== 0)
              throw new Error("目标已清除，但执行器异常退出；已停止后续目标，请审核日志并重新预览剩余项。");
            break; }
          if (!["pending", "executing"].includes(proof.state)) throw new Error("CLEANUP_TARGET_CHANGED：未重复执行，剩余目标须重新预览");
          if (proof.state === "pending" && Date.now() - started > 5000) throw new Error("未发现对应清理执行器，目标未变；可主动核查后恢复");
          if (this.cancelled.has(operation.id)) { operation.state = "paused"; await this.save(operation); return operation; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      operation = await this.observeManaged(operation);
      if (operation.state === "completed" && !operation.indexed) { await this.ports.updateIndexes(operation, operation.preview.action === "restore"); operation.indexed = true; }
      await this.save(operation); return clone(operation);
    } catch (error: any) {
      operation.state = "partial"; operation.error = String(error.message || error); await this.save(operation); return clone(operation);
    } finally { this.busy.delete(operation.id); }
  }
  async list(): Promise<Array<Pick<CleanupOperation, "id" | "state" | "updatedAt" | "pendingNodes" | "continuedBy" | "restoredBy" | "nodeChecks"> & { planFile: string; action: string; job?: CleanupJobSelection }>> {
    const names = await fs.readdir(this.ports.storageRoot).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; });
    const rows = [];
    for (const name of names.filter(name => /^[a-f0-9]{48}\.json$/.test(name))) {
      // History is a local index, not a request to scan every past remote operation.
      const operation: CleanupOperation = JSON.parse(await fs.readFile(this.file(name.slice(0, -5)), "utf8"));
      if (operation.preview.action === "delete" && operation.state === "completed" && !operation.pendingNodes.length) continue;
      rows.push({ id: operation.id, state: operation.state, updatedAt: operation.updatedAt, pendingNodes: [...new Set([...operation.pendingNodes, ...(operation.retirementPendingNodes || [])])],
        planFile: operation.preview.scope.planFile, action: operation.preview.action, job: operation.preview.scope.job,
        continuedBy: operation.continuedBy, restoredBy: operation.restoredBy, nodeChecks: operation.nodeChecks });
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async history(id: string, round?: ObservationRound): Promise<CleanupOperation[]> {
    const rows: CleanupOperation[] = [], seen = new Set<string>();
    while (id) {
      if (seen.has(id) || rows.length >= 32) cleanupError("INVALID_CONTINUATION_CHAIN");
      seen.add(id); const operation = await this.status(id, round); rows.push(operation);
      id = operation.preview.continuationOf || "";
    }
    return rows;
  }
  private nodeIdentity(node: CleanupNode) { return cleanupDigest({ ...node, error: undefined }); }
  private async completedHistory(history: CleanupOperation[], round?: ObservationRound): Promise<CleanupRow[]> {
    const completed = new Map<string, CleanupRow>();
    const observationRound = round ?? this.newObservationRound();
    try {
    for (const operation of history) for (const row of operation.preview.rows) {
      const state = operation.targets[row.id]?.state;
      const fastConfirmed = operation.preview.action === "delete" && operation.preview.scope.authorizationMode === "confirmed_paths"
        && operation.preview.scope.observationMode === "managed_tmux" && state !== undefined;
      if (fastConfirmed) {
        // v1.10: completion evidence comes from this round's batched observation, never a per-row verify.
        if (operation.targets[row.id]?.receipt?.source === "active_query" && state !== "completed") cleanupError("SOURCE_RECREATED_OR_CHANGED");
        if (state === "completed" || state === "executing") {
          const entry = await this.roundVerifyEntry(observationRound, row);
          const verdict = this.roundVerdict(entry, this.observeTargetOf(row).isolationRelativePath !== undefined);
          if (state === "completed") {
            if (verdict === "absent") completed.set(row.id, { ...row, disposition: "completed" });
            else if (verdict === "present") cleanupError("SOURCE_RECREATED_OR_CHANGED");
            else cleanupError("DELETE_RECEIPT_UNCERTAIN");
          } else if (verdict === "absent") completed.set(row.id, { ...row, disposition: "completed" });
          else if (verdict === "executing" || verdict === "present") { /* still running or pending: not completed yet */ }
          else cleanupError("DELETE_RECEIPT_UNCERTAIN");
        }
        continue;
      }
      if (operation.preview.scope.observationMode === "managed_tmux" && operation.targets[row.id]?.receipt?.source === "active_query" && state !== "completed") {
        await this.ports.sftp("files.cleanup.verify", { token: row.backendToken, index: row.backendIndex });
        cleanupError("SOURCE_RECREATED_OR_CHANGED");
      }
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
    } finally { if (!round) observationRound.closed = true; }
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
    const round = this.newObservationRound();
    try {
      const original = await this.status(id, round);
      if (original.continuedBy || original.restoredBy || original.preview.action === "restore" || this.busy.has(id)) cleanupError("NOT_CONTINUABLE");
      return await this.preview({ planFile: original.preview.scope.planFile, action: original.preview.action,
        verifiedOnly: params.verifiedOnly, continuationOf: id, job: original.preview.scope.job, authorizationMode: original.preview.scope.authorizationMode }, onProgress, round);
    } finally { round.closed = true; }
  }
  /** Reconnection observes receipts and source presence only. It never settles or executes a mutation. */
  async recheckNode(nodeId: string): Promise<CleanupNodeCheck[]> {
    const reports: CleanupNodeCheck[] = [];
    const round = this.newObservationRound();
    try {
    for (const item of await this.list()) {
      if (item.state === "completed" && !item.pendingNodes.length) continue;
      const operation = await this.status(item.id, round);
      if (operation.continuedBy || operation.restoredBy || operation.preview.action === "restore" || this.busy.has(item.id)) continue;
      const rows = operation.preview.rows.filter(row => row.node.id === nodeId
        && (operation.targets[row.id] && operation.targets[row.id].state !== "completed"
          || operation.pendingNodes.includes(nodeId) && row.disposition !== "completed"
          || operation.retirementPendingNodes?.includes(nodeId) && operation.targets[row.id]?.state === "completed"));
      if (!rows.length) continue;
      const report: CleanupNodeCheck = { operationId: item.id, nodeId, checkedAt: new Date().toISOString(), state: "confirmation_required", targets: [] };
      for (const row of rows) {
        try {
          if (this.ports.currentNode && this.nodeIdentity(await this.ports.currentNode(nodeId)) !== this.nodeIdentity(row.node)) cleanupError("SERVER_IDENTITY_CHANGED");
          if (row.disposition === "protected") { report.targets.push({ id: row.id, absolutePath: row.absolutePath, state: "protected" }); continue; }
          const proof = operation.preview.action === "delete"
            ? operation.preview.scope.authorizationMode === "confirmed_paths"
              ? await this.roundDeleteObservation(round, row, Boolean(operation.executionRequestedAt))
              : await this.inspectPresence(row, CLEANUP_QUERY_TIMEOUT_MS, Boolean(operation.executionRequestedAt))
            : row.backendToken
            ? await this.ports.sftp("files.cleanup.check", { token: row.backendToken, index: row.backendIndex })
            : await this.ports.sftp("files.cleanup.inspect", { node: row.node, target: { relativePath: row.relativePath, type: row.type }, allowMissing: true });
          const state = proof.executors?.length ? "executing" : proof.state || (proof.target.missing ? "absent" : "pending");
          report.targets.push({ id: row.id, absolutePath: row.absolutePath, state });
          if (state === "completed" && report.state !== "blocked") report.state = "settlement_required";
          if (state === "absent_unverified") { report.state = "blocked"; report.targets.at(-1)!.code = "DELETE_RECEIPT_UNCERTAIN"; }
        } catch (error: any) {
          report.state = "blocked"; report.targets.push({ id: row.id, absolutePath: row.absolutePath, state: "unverified", code: error.apiData?.code || error.code || "NODE_UNREACHABLE" });
        }
      }
      if (operation.preview.action === "delete" && report.state !== "blocked" && report.targets.length && report.targets.every(row => ["absent", "completed", "executing"].includes(row.state))) continue;
      if (operation.retirementPendingNodes?.includes(nodeId) && report.state !== "blocked") report.state = "confirmation_required";
      const fresh = await this.status(item.id, round);
      if (this.busy.has(item.id) || fresh.continuedBy || fresh.restoredBy) continue;
      (fresh.nodeChecks ||= {})[nodeId] = report; await this.save(fresh); reports.push(report);
    }
    return reports;
    } finally { round.closed = true; }
  }
  /** Direct confirmed-path recheck evidence comes from this round's batched observation, never a new per-row RPC. */
  private async roundDeleteObservation(round: ObservationRound, row: CleanupRow, executionRequested: boolean): Promise<any> {
    const entry = await this.roundVerifyEntry(round, row);
    const verdict = this.roundVerdict(entry, this.observeTargetOf(row).isolationRelativePath !== undefined);
    if (verdict === "residue" || verdict === "unknown") return { target: { missing: false }, state: "absent_unverified" };
    if (verdict === "executing") return { executors: entry.executors?.length ? entry.executors : [{ windowId: "observed-executing" }],
      executorsChecked: true, target: { missing: false }, state: "executing" };
    if (verdict === "absent" && executionRequested && entry.executorsChecked !== true) cleanupError("CLEANUP_EXECUTOR_QUERY_UNVERIFIED");
    if (verdict === "absent") return { executors: [], executorsChecked: true, target: { missing: true, type: row.type } };
    // A present entry may not claim an idle executor without executor evidence.
    if (executionRequested && entry.executorsChecked !== true) cleanupError("CLEANUP_EXECUTOR_QUERY_UNVERIFIED");
    return { executors: entry.executors ?? [], executorsChecked: entry.executorsChecked === true, target: entry.target ?? { missing: false, type: row.type } };
  }
  /** One shared observation entry for a row; failures surface as errors instead of per-row fallback queries. */
  private async roundVerifyEntry(round: ObservationRound, row: CleanupRow): Promise<any> {
    // Carry the row's frozen root identity so this probe shares exactly the same full request identity
    // as the group observation; without it the same target could silently borrow another root's answer.
    const outcome = await observeRound(round, row.node as unknown as Record<string, unknown> & { root?: string },
      [this.observeTargetOf(row)], row.rootIdentity === undefined ? {} : { rootIdentity: row.rootIdentity });
    if (outcome.upgrade) cleanupError(BATCH_OBSERVATION_UPGRADE_CODE);
    if (outcome.failure) throw Object.assign(new Error(outcome.failure.message), { apiData: { code: outcome.failure.code } });
    const entry = outcome.byKey.get(row.id);
    if (!entry || outcome.missingKeys.includes(row.id) || entry.error) cleanupError("DELETE_RECEIPT_UNCERTAIN");
    return entry;
  }
  async preview(params: { planFile: string; action?: "move" | "delete" | "isolate"; verifiedOnly?: boolean; continuationOf?: string; job?: CleanupJobSelection; authorizationMode?: "confirmed_paths";
    reuseToken?: string; exactPaths?: Array<{ nodeId: string; relativePath: string; type: "file" | "directory" }> }, onProgress?: CleanupProgressSink, round?: ObservationRound): Promise<CleanupPreview> {
    // UI observations cannot change the frozen preview or authorize execution.
    const notify: CleanupProgressSink = progress => { try { onProgress?.(progress); } catch {} };
    notify({ phase: "discovery", message: params.reuseToken ? "复用本页路径，核对所选处理方式…" : "读取 PLAN 声明及实际产物清单…" });
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 512) cleanupError("CLEANUP_PREVIEW_CAPACITY_EXCEEDED");
    const action = params.action || "move";
    if (!["move", "delete", "isolate"].includes(action)) cleanupError("INVALID_ACTION");
    if (params.authorizationMode && !["delete", "isolate"].includes(action)) cleanupError("INVALID_ACTION");
    // 配套引擎的确认路径链只授权永久删除（B cleanup-file-api.js:248：pathOnly && action !== "delete" → INVALID_ACTION）。
    // 隔离与移动只保留本机确认路径语义，出站请求永不带 authorizationMode；永久删除的确认链不变。
    const backendAuthorizationModeFor = (authorized?: "confirmed_paths") => action === "delete" ? authorized : undefined;
    const history = params.continuationOf ? await this.history(params.continuationOf, round) : [];
    if (history[0]?.continuedBy || history[0]?.restoredBy || history.some(row => row.preview.action !== action)) cleanupError("NOT_CONTINUABLE");
    const completed = await this.completedHistory(history, round);
    const token = randomBytes(24).toString("hex");
    let scope: CleanupScope;
    if (params.reuseToken) {
      const previous = this.previews.get(params.reuseToken);
      if (!previous || previous.scope.planFile !== params.planFile || previous.continuationOf || params.continuationOf
        || cleanupJobKey(previous.scope.job) !== cleanupJobKey(params.job)) cleanupError("PREVIEW_CHANGED");
      const prior: CleanupOperation | undefined = await fs.readFile(this.file(previous.token), "utf8").then(JSON.parse, (error: any) => {
        if (error.code === "ENOENT") return undefined; throw error;
      });
      if (prior && (prior.executionRequestedAt || prior.continuedBy || prior.restoredBy || this.busy.has(prior.id)
        || Object.values(prior.targets).some(row => row.state !== "pending"))) cleanupError("PREVIEW_CHANGED", "已开始处理文件，请刷新实际状态。");
      scope = clone(previous.scope);
      if (this.ports.currentNode) for (const node of scope.nodes) {
        if (!node.error && this.nodeIdentity(await this.ports.currentNode(node.id)) !== this.nodeIdentity(node)) cleanupError("SERVER_IDENTITY_CHANGED");
      }
      scope.authorizationMode = params.authorizationMode;
      scope.blockers = clone(scope.associationBlockers || scope.blockers);
      if (scope.authorizationMode === "confirmed_paths") scope.blockers = scope.blockers.filter(row =>
        ["UNSAFE_DECLARED_PATH", "NODE_UNREACHABLE", "OFFLINE_NODE", "DIRTY_EDITOR_TARGET"].includes(row.code));
      this.previews.delete(previous.token);
      if (prior) { prior.continuedBy = token; prior.state = "blocked"; prior.error = "处理方式已变化，原确认失效"; await this.save(prior); }
    } else if (params.authorizationMode === "confirmed_paths" && params.exactPaths?.length) {
      // The GET methodOptions maxTargets=500 describes the retired generic chain. The confirmed fast path
      // publishes a 5000-target public cap per request; larger selections become finite batches downstream.
      if (params.exactPaths.length > FAST_CONFIRMED_BATCH_CAP * 5 || !this.ports.currentNode) cleanupError("INVALID_EXACT_PATHS");
      for (const row of params.exactPaths) {
        if (!["file", "directory"].includes(row.type) || row.nodeId === "pluginState") cleanupError("INVALID_EXACT_PATHS");
        cleanupRelative(row.relativePath);
      }
      scope = await this.ports.collect(cleanupRelative(params.planFile), { archivedFiles: {}, job: params.job, authorizationMode: params.authorizationMode });
      const classified = classifyCleanupCandidates(scope);
      for (const row of params.exactPaths) if (!classified.some(candidate => candidate.nodeId === row.nodeId
        && candidate.relativePath === row.relativePath && candidate.type === row.type && !candidate.protectedReason))
        cleanupError("OUTSIDE_PLAN_CLEANUP_SCOPE", row.relativePath + "：不属于可清理的独占配置或关联产物");
      scope.candidates = scope.candidates.filter(candidate => candidate.scopeProtectedReason || params.exactPaths!.some(row => row.nodeId === candidate.nodeId
        && row.relativePath === candidate.relativePath && row.type === candidate.type));
    } else scope = await this.ports.collect(cleanupRelative(params.planFile), { archivedFiles: action === "move" ? this.archivedMetadata(completed) : {},
      removedMetadata: this.removedMetadata(history, completed), onProgress: notify, job: params.job, authorizationMode: params.authorizationMode });
    if (cleanupJobKey(scope.job) !== cleanupJobKey(params.job)
        || history.length && cleanupJobKey(scope.job) !== cleanupJobKey(history[0].preview.scope.job)) cleanupError("JOB_SCOPE_CHANGED");
    if (history.length && scope.authorizationMode !== "confirmed_paths" && (scope.planKey !== history[0].preview.scope.planKey || scope.planHash !== history[0].preview.scope.planHash)) cleanupError("PREVIEW_CHANGED");
    for (const original of history[0]?.preview.scope.nodes || []) {
      const current = scope.nodes.find(node => node.id === original.id);
      if (!current || this.nodeIdentity(current) !== this.nodeIdentity(original)) cleanupError("SERVER_IDENTITY_CHANGED");
    }
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
    // 隔离目标必须携带 job 自己声明的必需输入，服务器端 requiredInputs 守卫
    // 才会阻止父目录隔离连同 checkpoint/配置；无法安全解析 → 明确暂停该 job，
    // 不静默忽略、不改科研路径、不复制输入。
    if (action === "isolate" && scope.job?.purpose === "replace_outputs") {
      const declaration = (scope.job?.manifest?.declarations || [])[0];
      const unresolved = new Map<string, string>();
      for (const row of result.rows) if (row.disposition === action) {
        const resolved = isolateRequiredInputPaths(declaration, row.node);
        if (resolved.error) unresolved.set(row.node.id, resolved.error);
        else if (resolved.inputs && resolved.inputs.length) row.requiredInputs = resolved.inputs;
      }
      for (const [nodeId, detail] of unresolved) result.blockers.push({ code: "ISOLATE_REQUIRED_INPUTS_UNRESOLVED", nodeId, detail });
    }
    const physical = new Map<string, CleanupRow>();
    const backendReads = await Promise.allSettled(scope.nodes.map(async node => {
      const rows = result.rows.filter(row => row.node.id === node.id && row.disposition === action);
      if (node.error || !rows.length) return undefined;
      // Confirmed fast deletion travels one public preview request per ≤5000-target batch, serially per node;
      // the server chunks engine entry checks internally. Never one request per file.
      // 隔离不得泄露确认路径授权；隔离按引擎非确认链的每请求 500 目标上限分批。
      const backendAuthorizationMode = backendAuthorizationModeFor(scope.authorizationMode);
      const chunks = backendAuthorizationMode === "confirmed_paths" ? chunkFastDeleteTargets(rows)
        : action === "isolate" ? chunkFastDeleteTargets(rows, 500) : [rows];
      notify({ phase: "nodes", message: node.id + "：只读预检 " + rows.length + " 个精确目标" + (chunks.length > 1 ? "（" + chunks.length + " 个有界批次）" : "") + "…", total: scope.nodes.length });
      const reads: any[] = [];
      for (const [index, chunk] of chunks.entries()) {
        if (chunks.length > 1) notify({ phase: "nodes", message: node.id + "：分批只读预检 " + (index + 1) + "/" + chunks.length + "…", total: scope.nodes.length });
        reads.push(await this.ports.sftp("files.cleanup.preview", { node, action, observationMode: scope.observationMode, authorizationMode: backendAuthorizationMode,
          targets: chunk.map(row => ({ relativePath: row.relativePath, type: row.type, destination: row.destination,
            expectedSha256: row.expectedSha256, expectedOwner: row.expectedOwner, archiveBatch: row.archiveBatch, requiredInputs: row.requiredInputs })) }));
      }
      return { chunks, reads };
    }));
    for (const [index, node] of scope.nodes.entries()) {
      const rows = result.rows.filter(row => row.node.id === node.id && row.disposition === action);
      const progress = { phase: "nodes", completed: index, total: scope.nodes.length };
      notify({ ...progress, message: node.id + "：检查身份、SHA256 与目标冲突（" + rows.length + " 个目标）…" });
      if (node.error) { result.blockers.push({ code: "OFFLINE_NODE", nodeId: node.id, detail: node.error });
        notify({ ...progress, completed: index + 1, message: node.id + "：离线，保留未处理信号" }); continue; }
      if (!rows.length) { notify({ ...progress, completed: index + 1, message: node.id + "：无可处理的独占目标" }); continue; }
      try {
        const read = backendReads[index];
        if (read.status === "rejected") throw read.reason;
        const { chunks, reads } = read.value!;
        for (const [chunkIndex, chunkRows] of chunks.entries()) {
          const backend = reads[chunkIndex];
          if (scope.job?.purpose === "replace_outputs" && !(Number(backend.safety?.batchPreviewCapacity) >= 4096))
            cleanupError("SFTP_BATCH_PREVIEW_UPGRADE_REQUIRED", "需要 SimpleSFTP 0.2.79 的批次预览保留能力");
          if (action === "isolate" && !(Number(backend.safety?.isolateFast) === 1 && Number(backend.safety?.requiredInputGuard) === 1
            && Number(backend.safety?.registeredIsolationDeletion) === 1 && Number(backend.safety?.subtreeSingleWriter) === 1))
            cleanupError("SFTP_ISOLATE_UPGRADE_REQUIRED", "当前 SimpleSFTP 不支持受控快速隔离或注册隔离删除；请更新配套插件后重新预览，未执行任何移动，不会回退旧删除链。");
          // The confirmed fast chain is proven by its answer itself: missing fast flags or a refusal
          // (UNKNOWN_ACTION / UPDATE_REQUIRED) is one unified upgrade requirement, never an empty success.
          if (scope.authorizationMode === "confirmed_paths" && action === "delete") assertFastDeletePreviewSafety(backend.safety, chunkRows.length);
          chunkRows.forEach((row, chunkOffset) => {
            const info = backend.targets[chunkOffset];
            Object.assign(row, { ...info, relativePath: row.relativePath, destination: row.destination,
              backendToken: backend.token, backendDigest: backend.digest, backendIndex: chunkOffset, rootIdentity: backend.rootIdentity });
            if (info.handleWarnings?.length) {
              const detail = row.absolutePath + "：" + info.handleWarnings.length + " 个同用户进程的 /proc 不可读；句柄扫描覆盖可见进程，未证明这些进程访问目标。当前作业/传输与资源锁仍独立检查。";
              row.evidence.push(detail);
              (scope.notices ||= []).push({ code: "PROC_VISIBILITY_LIMIT", nodeId: node.id, detail });
            }
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
          const approved = chunkRows.filter(row => row.disposition === action);
          if (approved.length && chunkRows.some(row => row.disposition === "protected")) {
            const exact = await this.ports.sftp("files.cleanup.preview", { node, action, observationMode: scope.observationMode, authorizationMode: backendAuthorizationModeFor(scope.authorizationMode),
              targets: approved.map(row => ({ relativePath: row.relativePath, type: row.type, destination: row.destination,
                expectedSha256: row.expectedSha256, expectedOwner: row.expectedOwner, archiveBatch: row.archiveBatch, requiredInputs: row.requiredInputs })) });
            if (scope.authorizationMode === "confirmed_paths" && action === "delete") assertFastDeletePreviewSafety(exact.safety, approved.length);
            if (cleanupDigest(exact.rootIdentity) !== cleanupDigest(backend.rootIdentity)
              || exact.targets.length !== approved.length
              || approved.some((row, position) => exact.targets[position].fingerprint !== row.fingerprint)) cleanupError("PREVIEW_CHANGED");
            approved.forEach((row, position) => Object.assign(row, { backendToken: exact.token, backendDigest: exact.digest, backendIndex: position }));
          }
        }
      } catch (error: any) {
        let code = error.apiData?.code || error.code || "NODE_PREFLIGHT_FAILED";
        // 统一快删升级映射只属于确认删除链；隔离保留自身错误语义，不贴快删文案。
        if (scope.authorizationMode === "confirmed_paths" && action === "delete" && isFastDeleteUpgradeCode(code)) {
          code = "SFTP_FAST_DELETE_UPGRADE_REQUIRED";
          error = Object.assign(new Error("当前 SimpleSFTP 不支持确认路径的批量快速删除；请更新配套插件后重新预览，未执行任何删除，不会回退旧删除链。"), { apiData: { code } });
        }
        // 配套插件在拒绝瞬间给出的忙快照按结构保留（不是从字符串里再猜）：事后集合清空也不能改写当时看到什么。
        const busy = busyEvidenceFromError(error);
        result.blockers.push(busy ? { code, nodeId: node.id, detail: String(error.message || code), busy } : { code, nodeId: node.id, detail: String(error.message || code) });
        rows.forEach(row => { row.disposition = "unverified"; row.error = code; });
      } finally {
        notify({ ...progress, completed: index + 1, message: node.id + "：节点预检已结束，异常会列入审核表" });
      }
    }
    // 能力缺口是全局升级问题，不能按 job 静默绕开，也不能回退旧删除；直接显式提示升级。
    if (action === "isolate" || (action === "delete" && scope.authorizationMode === "confirmed_paths")) {
      const upgrade = result.blockers.find(row => row.code.startsWith("SFTP_"));
      if (upgrade) cleanupError(upgrade.code, upgrade.detail);
    }
    // Shared/unknown targets remain visible, with hashes when read-only inspection is possible.
    const protectedRows = result.rows.filter(row => row.disposition === "protected" && !row.scopeProtectedReason && !row.fingerprint && row.node.root && !row.node.error);
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
    const prior = await fs.readFile(this.file(preview.token), "utf8").then(JSON.parse, (error: any) => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (prior?.continuedBy || prior?.restoredBy) cleanupError("OPERATION_SUPERSEDED");
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
    if (!operation?.executionRequestedAt) await this.ports.validateScope?.(preview.scope);
    if (preview.scope.authorizationMode === "confirmed_paths") {
      // The user authorizes these frozen paths, not a historical PLAN/task revision.
      // One batched active query per frozen backend batch re-checks every entry identity;
      // this never degrades into one remote call per file and never re-authorizes a new selection.
      const groups = new Map<string, CleanupRow[]>();
      for (const row of preview.rows.filter(row => ["delete", "isolate"].includes(row.disposition) && row.backendToken)) {
        const group = groups.get(row.backendToken!) || [];
        group.push(row); groups.set(row.backendToken!, group);
      }
      for (const [backendToken, group] of groups) {
        let snapshot: any;
        try { snapshot = await this.ports.sftp("files.cleanup.status", { token: backendToken }); }
        catch (error: any) { cleanupError("CLEANUP_TARGET_CHANGED", "确认前批量核查未完成：" + String(error?.message || error)); }
        for (const row of group) {
          const observation = (snapshot?.observations || [])[row.backendIndex!] || {};
          const state = observation.state || (snapshot?.states || [])[row.backendIndex!];
          if (!["pending", "executing", "completed"].includes(state))
            cleanupError("CLEANUP_TARGET_CHANGED", row.absolutePath + "：文件已变化，请重新核对路径");
        }
      }
      return;
    }
    const prior = preview.continuationOf ? await this.history(preview.continuationOf) : [];
    const completed = await this.completedHistory(prior);
    const archivedFiles = { ...(preview.action === "move" ? this.archivedMetadata(completed) : {}), ...Object.fromEntries(preview.rows.filter(row => row.node.kind === "local" && ["PLAN 文件", "专用配置"].includes(row.category)
      && operation?.targets[row.id]?.state === "completed" && preview.action === "move").map(row => [row.relativePath, row.destination])) };
    const ownCompleted = operation && preview.scope.observationMode === "managed_tmux"
      ? preview.rows.filter(row => operation.targets[row.id]?.state === "completed") : [];
    const fresh = await this.ports.collect(preview.scope.planFile, { archivedFiles, removedMetadata: this.removedMetadata(operation ? [operation, ...prior] : prior, [...completed, ...ownCompleted]), job: preview.scope.job,
      nativeDeclarations: preview.scope.nativeDeclarations });
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
    const current = await this.status(id);
    if (current.state === "completed") return current;
    if (current.preview.scope.observationMode === "managed_tmux") return this.executeManaged(current);
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
        if (check.targets[0].fingerprint !== row.fingerprint || cleanupDigest(check.rootIdentity) !== cleanupDigest(row.rootIdentity)) cleanupError("PREVIEW_CHANGED", "PREVIEW_CHANGED：" + row.absolutePath + "：目标内容或安全根已变化，请重新核对路径");
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
  /** Batch replacement checks every confirmed operation before its first deletion. */
  async setStateRetirement(id: string, nodes: string[], error?: string): Promise<void> {
    const operation = await this.status(id);
    if (operation.preview.action === "delete" && operation.state === "completed") return;
    if (operation.preview.action !== "delete" || operation.preview.scope.job?.purpose !== "replace_outputs"
      || operation.pendingNodes.length || Object.values(operation.targets).some(row => row.state !== "completed")
      || nodes.some(id => !operation.preview.scope.nodes.some(node => node.id === id && node.kind === "remote"))) cleanupError("INVALID_STATE_RETIREMENT_PHASE");
    operation.retirementPendingNodes = [...new Set(nodes)]; operation.state = nodes.length ? "partial" : "completed";
    if (error) operation.error = error; else delete operation.error;
    await this.save(operation);
  }
  async preflightConfirmed(id: string): Promise<void> {
    const operation = await this.status(id);
    if (operation.preview.confirmations !== (operation.preview.action === "delete" ? 2 : 1)) cleanupError("CONFIRM_REQUIRED");
    if (operation.state === "completed") return;
    if (operation.continuedBy || operation.restoredBy || this.busy.has(id)) cleanupError("OPERATION_SUPERSEDED");
    await this.revalidate(operation.preview, operation);
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
      const backend = await this.ports.sftp("files.cleanup.preview", { node: row.node, action: "restore", observationMode: preview.scope.observationMode,
        targets: [{ relativePath: row.destination, type: row.type, destination: row.relativePath, archiveBatch: row.archiveBatch }] });
      if (backend.targets[0].contentFingerprint !== row.contentFingerprint || backend.targets[0].inode !== row.inode) cleanupError("CONTENT_CHANGED");
      preview.rows.push({ ...row, ...backend.targets[0], relativePath: row.destination, destination: row.relativePath, disposition: "restore",
        backendToken: backend.token, backendDigest: backend.digest, backendIndex: 0, rootIdentity: backend.rootIdentity });
    }
    if (!preview.rows.length) cleanupError("NO_VERIFIED_TARGETS");
    preview.digest = cleanupDigest(preview.rows); this.previews.set(preview.token, clone(preview)); return preview;
  }
  /** 隔离完成后主动核实原输出路径已可新建（只读查询，不产生写入）；失败只排除相关 job。 */
  async assertIsolatedSourcesAbsent(preview: CleanupPreview): Promise<void> {
    for (const row of preview.rows.filter(row => row.disposition === "isolate")) {
      let proof: any;
      try { proof = await this.inspectPresence(row); }
      catch (error: any) { cleanupError("SOURCE_PATH_UNVERIFIED", row.absolutePath + "：隔离后无法主动核实原路径，未准入该 job：" + String(error.message || error)); }
      if (proof?.target?.missing !== true) cleanupError("SOURCE_PATH_UNAVAILABLE", row.absolutePath + "：隔离后原路径仍被占用，未准入该 job，未提交任务。");
    }
  }
  /** 隔离目标的永久删除预览：只接受已完成隔离操作冻结的目的路径；对外仍是 delete/confirmed_paths 双确认受管流程。 */
  async isolatedDeletePreview(id: string, verifiedOnly = false): Promise<CleanupPreview> {
    const original = await this.status(id);
    if (original.preview.action !== "isolate" || original.continuedBy || original.restoredBy) cleanupError("NOT_ISOLATED_OPERATION");
    if (this.busy.has(id)) cleanupError("OPERATION_BUSY");
    const sources = original.preview.rows.filter(row => row.disposition === "isolate");
    if (!sources.length) cleanupError("NO_VERIFIED_TARGETS");
    const token = randomBytes(24).toString("hex");
    const preview: CleanupPreview = { token, digest: "", action: "delete", scope: clone(original.preview.scope), rows: [],
      blockers: [], verifiedOnly, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0 };
    for (const source of sources) {
      const row: CleanupRow = { ...clone(source), id: cleanupDigest([source.node.id, source.node.root, source.destination, source.type, id]),
        relativePath: source.destination, destination: source.destination, disposition: "delete", archiveBatch: undefined,
        backendToken: undefined, backendDigest: undefined, backendIndex: undefined, rootIdentity: undefined, fingerprint: undefined, contentFingerprint: undefined,
        evidence: [...source.evidence, "隔离批次 " + (source.archiveBatch || "") + "，原路径 " + source.relativePath],
        protectedReason: undefined, error: undefined,
        absolutePath: source.node.kind === "local" ? path.join(source.node.root, source.destination) : path.posix.join(source.node.root, source.destination) };
      if (original.targets[source.id]?.state !== "completed") {
        row.disposition = "unverified"; row.error = "ISOLATE_NOT_SETTLED";
        preview.blockers.push({ code: "ISOLATE_NOT_SETTLED", nodeId: source.node.id, detail: source.destination + "：隔离未完成确认，请先刷新实际状态" });
        preview.rows.push(row); continue;
      }
      try {
        const backend = await this.ports.sftp("files.cleanup.preview", { node: source.node, action: "delete", observationMode: "managed_tmux",
          authorizationMode: "confirmed_paths", targets: [{ relativePath: source.destination, destination: source.destination, type: source.type }] });
        if (Number(backend.safety?.registeredIsolationDeletion) !== 1)
          cleanupError("SFTP_ISOLATE_DELETE_UPGRADE_REQUIRED", "当前 SimpleSFTP 不支持注册隔离目标的受管永久删除；请更新配套插件后重试，未执行任何删除。");
        const info = backend.targets[0];
        if (info.missing) row.disposition = "absent";
        else Object.assign(row, { fingerprint: info.fingerprint, size: info.size, backendToken: backend.token, backendDigest: backend.digest,
          backendIndex: 0, rootIdentity: backend.rootIdentity });
      } catch (error: any) {
        const code = error.apiData?.code || error.code || "NODE_PREFLIGHT_FAILED";
        if (verifiedOnly && ["NODE_UNREACHABLE", "OFFLINE_NODE"].includes(code)) {
          preview.blockers.push({ code, nodeId: source.node.id, detail: source.destination }); continue;
        }
        if (code.startsWith("SFTP_")) cleanupError(code, String(error.message || code));
        preview.blockers.push({ code, nodeId: source.node.id, detail: String(error.message || code) });
        row.disposition = "unverified"; row.error = code;
      }
      preview.rows.push(row);
    }
    if (!preview.rows.some(row => row.disposition === "delete")) cleanupError("NO_VERIFIED_TARGETS");
    preview.digest = cleanupDigest({ action: preview.action, scope: preview.scope, rows: preview.rows, verifiedOnly });
    this.previews.set(token, clone(preview));
    return clone(preview);
  }
}
