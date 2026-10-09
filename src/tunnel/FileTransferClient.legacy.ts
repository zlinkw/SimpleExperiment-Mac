import { HostOperationLeaseManager } from "../core/HostOperationLease";
import * as fs from "fs/promises";
import * as fsNode from "node:fs";
import * as path from "path";
import { ProgressInactivity } from "../core/ProgressInactivity";
import { RequestBudget, TunnelRequestPurpose } from "./RequestBudget";
import { readBoundedResponseText } from "./BoundedResponse";
import { localBaseUrl } from "./TunnelGateway";
import {
  DownloadOptions,
  FileListResponse,
  FileStatResponse,
  FileTransferProgressEvent,
  FileTransferTask,
  FileTransferVerifyResult,
  isSafeRemotePath,
  makeTransferId,
  UploadOptions,
} from "./FileTransferTypes";
import { sha256File, verifyLocalFileSha256 } from "./FileTransferVerifier";

export interface FileTransferClientConfig {
  localHost: string;
  localPort: number;
  token?: string;
  chunkSizeBytes?: number;
  resourceServer?: string;
  resourceProjectRoot?: string;
  fileCapabilities?: { supportsUploadCancel?: boolean; [key: string]: unknown };
}

type TransferRecord = {
  task: FileTransferTask;
  abort: AbortController;
  expectedSha256?: string;
  actualSha256?: string;
  retry?: () => Promise<FileTransferTask>;
  inactivity?: ProgressInactivity;
  lease?: any;
  settled?: Promise<void>;
  settledAt?: number;
  remoteTransferId?: string;
  remoteOutcomeUnknown?: boolean;
};

const MAX_TRANSFER_RECORDS = 256;
const MAX_TERMINAL_TRANSFER_RECORDS = 128;
const MAX_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_AUTOMATIC_TRANSFER_RETRIES = 5;
const TRANSFER_CANCEL_SETTLEMENT_TIMEOUT_MS = 30_000;
const TRANSFER_DISPOSE_SETTLEMENT_TIMEOUT_MS = 1_800;

export class FileTransferClient {
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly resourceLease = new HostOperationLeaseManager();
  private disposed = false;

  constructor(
    private readonly config: FileTransferClientConfig,
    private readonly budget: RequestBudget,
    private readonly onProgress: (event: FileTransferProgressEvent) => void = () => undefined,
  ) {}

  async list(remotePath: string): Promise<FileListResponse> {
    this.assertSafe(remotePath);
    this.assertActive();
    const result = await this.requestJson<FileListResponse>(`/api/files/list?path=${encodeURIComponent(remotePath)}`, "GET");
    return { schemaVersion: 1, path: result.path || remotePath, entries: result.entries || [] };
  }

  async stat(remotePath: string): Promise<FileStatResponse> {
    this.assertSafe(remotePath);
    this.assertActive();
    const result = await this.requestJson<FileStatResponse>(`/api/files/stat?path=${encodeURIComponent(remotePath)}`, "GET");
    return { ...result, schemaVersion: 1, path: result.path || remotePath, exists: Boolean(result.exists) };
  }

  async download(remotePath: string, localPath: string, options: DownloadOptions = {}): Promise<FileTransferTask> {
    this.assertSafe(remotePath);
    this.assertActive();
    this.ensureTransferCapacity();
    const transferId = makeTransferId("download");
    const task = this.task(transferId, "download", remotePath, localPath);
    const abort = new AbortController();
    const record: TransferRecord = { task, abort, expectedSha256: options.expectedSha256 };
    record.retry = () => this.download(remotePath, localPath, options);
    this.transfers.set(transferId, record);
    return this.track(record, () => this.withRetries(boundedRetryCount(options.maxRetries), async () => this.runDownload(record, options), abort.signal));
  }

  downloadFile(remotePath: string, localPath: string, options: DownloadOptions = {}): Promise<FileTransferTask> {
    return this.download(remotePath, localPath, options);
  }

  async downloadRange(remotePath: string, localPath: string, start: number, end?: number, options: DownloadOptions = {}): Promise<FileTransferTask> {
    this.assertSafe(remotePath);
    this.assertActive();
    if (!Number.isSafeInteger(start) || start < 0 || end !== undefined && (!Number.isSafeInteger(end) || end < start))
      throw new Error("invalid download range");
    this.ensureTransferCapacity();
    const transferId = makeTransferId("range");
    const task = this.task(transferId, "download", remotePath, localPath);
    const abort = new AbortController();
    const record: TransferRecord = { task, abort, expectedSha256: options.expectedSha256 };
    record.retry = () => this.downloadRange(remotePath, localPath, start, end, options);
    this.transfers.set(transferId, record);
    return this.track(record, () => this.withRetries(boundedRetryCount(options.maxRetries), async () => this.runDownload(record, options, start, end), abort.signal));
  }

  async upload(localPath: string, remotePath: string, options: UploadOptions = {}): Promise<FileTransferTask> {
    this.assertSafe(remotePath);
    this.assertActive();
    this.ensureTransferCapacity();
    const transferId = makeTransferId("upload");
    const task = this.task(transferId, "upload", remotePath, localPath);
    const abort = new AbortController();
    const record: TransferRecord = { task, abort, expectedSha256: options.sha256, remoteOutcomeUnknown: false };
    record.retry = () => this.upload(localPath, remotePath, options);
    this.transfers.set(transferId, record);
    return this.track(record, () => this.withRetries(boundedRetryCount(options.maxRetries), async () => this.runUpload(record, options),
      abort.signal, () => !record.remoteOutcomeUnknown && retryableTransferError(record.task.error)));
  }

  uploadFile(localPath: string, remotePath: string, options: UploadOptions = {}): Promise<FileTransferTask> {
    return this.upload(localPath, remotePath, options);
  }

  async cancel(transferId: string): Promise<void> {
    const record = this.transfers.get(transferId);
    if (!record) return;
    if (record.settledAt === undefined) {
      record.task.status = "cancelling";
      record.abort.abort();
      // Signal the remote upload immediately while the local request unwinds. A
      // chunk handler may still be writing after fetch abort; the Agent receipt
      // remains pending until that handler exits, so this does not release the
      // target for a competing upload prematurely.
      const remoteSettlement = record.task.direction === "upload" && record.remoteOutcomeUnknown
        ? this.confirmRemoteUploadSettlement(record)
        : undefined;
      const localSettlement = this.waitForLocalSettlement(record);
      const outcomes = await Promise.allSettled([localSettlement, ...(remoteSettlement ? [remoteSettlement] : [])]);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
    }
    if (record.task.direction === "upload" && record.remoteOutcomeUnknown) await this.confirmRemoteUploadSettlement(record);
  }

  private async waitForLocalSettlement(record: TransferRecord): Promise<void> {
    if (!record.settled) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([record.settled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("传输已请求取消，但本地请求尚未确认退出；请等待状态结算后再重试。")), TRANSFER_CANCEL_SETTLEMENT_TIMEOUT_MS);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async retry(transferId: string): Promise<FileTransferTask> {
    const record = this.transfers.get(transferId);
    if (!record?.retry) throw new Error("Transfer cannot be retried.");
    if (record.settledAt === undefined) throw new Error("传输仍在结算，尚未确认旧请求退出；不能启动替代请求。");
    if (record.task.direction === "upload" && record.remoteOutcomeUnknown)
      throw new Error("远端上传结果尚未确认；先取消并核实远端回执，再重试以避免并发写入。");
    if (!["failed", "cancelled"].includes(record.task.status))
      throw new Error("只有已确认失败或取消的传输可以重试；已完成或结果未知的传输不会重复提交。");
    return record.retry();
  }

  async verify(transferId: string): Promise<FileTransferVerifyResult> {
    const record = this.transfers.get(transferId);
    if (!record) return { transferId, ok: false, message: "Unknown transfer." };
    if (record.settledAt === undefined) return { transferId, ok: false, message: "Transfer has not settled yet." };
    if (!record.task.localPath) return { transferId, ok: false, message: "No local file for verification." };
    return verifyLocalFileSha256(transferId, record.task.localPath, record.expectedSha256 || record.actualSha256);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.transfers.values()].filter((record) => record.settledAt === undefined);
    for (const record of active) {
      record.task.status = "cancelling";
      record.abort.abort(new Error("Extension is deactivating."));
    }
    const localSettlement = Promise.all(active.map((record) => record.settled).filter((value): value is Promise<void> => Boolean(value)));
    // Deactivation can race an upload whose local fetch has aborted while the
    // remote chunk handler is still writing. Send cancellation receipts even
    // when the local request has not yet become a settled history row.
    const remoteSettlement = Promise.allSettled(active.filter((record) => record.task.direction === "upload")
      .map((record) => this.confirmRemoteUploadSettlement(record, 2_000)));
    const settlement = Promise.all([localSettlement, remoteSettlement]);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([settlement, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(TRANSFER_DISPOSE_SETTLEMENT_TIMEOUT_MS, 2_500));
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async runDownload(record: TransferRecord, options: DownloadOptions, rangeStart = 0, rangeEnd?: number): Promise<FileTransferTask> {
    const task = record.task;
    task.status = "running";
    task.error = undefined;
    task.finishedAt = undefined;
    task.transferredBytes = 0;
    record.inactivity = new ProgressInactivity(120_000, () => record.abort.abort(new Error("文件步骤 120 秒无真实进展，已取消。")));
    const tmpPath = `${task.localPath}.simple-transfer.pending`;
    const maxBytes = Number(options.maxBytes || 0);
    let checkpointSizeBeforeRange: number | undefined;
    try {
      // Hold the target lease before probing a partial file or issuing the GET so
      // two callers cannot share, truncate, or resume the same checkpoint.
      record.lease = await this.acquireFileLease(record);
      if (rangeStart > 0) checkpointSizeBeforeRange = await existingSize(tmpPath);
      let start = rangeStart;
      if (options.resume && rangeStart === 0) start = await existingSize(tmpPath);
      const query = new URLSearchParams({ path: task.remotePath });
      if (Number.isFinite(maxBytes) && maxBytes > 0) query.set("maxBytes", String(Math.trunc(maxBytes)));
      let apiPath = "/api/files/download";
      if (start > 0 || rangeEnd !== undefined) {
        apiPath = "/api/files/download-range";
        query.set("start", String(start));
        if (rangeEnd !== undefined) query.set("end", String(rangeEnd));
      }
      const response = await this.budget.run("file_transfer", () => fetch(`${localBaseUrl(this.config)}${apiPath}?${query.toString()}`, {
        headers: this.headers(),
        signal: record.abort.signal,
      }), { userInitiated: true, signal: record.abort.signal });
      if (!response.ok) {
        const detail = await readBoundedResponseText(response, () => undefined, 16 * 1024).catch(() => "response body omitted");
        throw new Error(`download failed: HTTP ${response.status} ${detail.slice(0, 200)}`);
      }
      const contentLength = Number(response.headers.get("content-length") || 0) || undefined;
      if (contentLength && Number.isFinite(maxBytes) && maxBytes > 0 && contentLength > maxBytes) {
        throw new Error(`remote file exceeds download limit: ${contentLength} > ${Math.trunc(maxBytes)} bytes`);
      }
      const expected = options.expectedSha256 || response.headers.get("x-simple-file-sha256") || undefined;
      record.expectedSha256 = expected;
      if (contentLength && options.confirmLargeFile && !(await (async () => { record.inactivity?.pause(); try { return await options.confirmLargeFile!(contentLength); } finally { record.inactivity?.resume(); } })())) {
        throw new Error("TRANSFER_CANCELLED");
      }
      const transferred = await this.writeDownloadWithProgress(response, tmpPath, task.transferId, contentLength, start > 0);
      task.transferredBytes = start + transferred;
      task.size = contentLength ? start + contentLength : undefined;
      const verify = await verifyLocalFileSha256(task.transferId, tmpPath, expected, { signal: record.abort.signal, onBytes: (bytes) => record.inactivity?.update({ phase: "verifying", processedBytes: bytes }) });
      record.actualSha256 = verify.actualSha256;
      if (!verify.ok) throw new Error("SHA256_MISMATCH");
      await fs.mkdir(path.dirname(task.localPath || "."), { recursive: true });
      record.abort.signal.throwIfAborted();
      await record.lease?.assertHeld();
      await fs.rename(tmpPath, task.localPath || tmpPath);
      await record.lease?.release(); record.lease = undefined;
      task.status = "completed";
      record.inactivity?.dispose();
      task.finishedAt = new Date().toISOString();
      return task;
    } catch (error) {
      let finalError: unknown = error;
      let checkpointRollbackError: unknown;
      record.inactivity?.dispose();
      if (rangeStart > 0 && checkpointSizeBeforeRange !== undefined) {
        try {
          const partial = await fs.lstat(tmpPath).catch((statError: NodeJS.ErrnoException) => statError.code === "ENOENT" ? undefined : Promise.reject(statError));
          if (partial) await truncatePrivateFile(tmpPath, checkpointSizeBeforeRange);
        }
        catch (truncateError) {
          checkpointRollbackError = truncateError;
          finalError = new Error(`${error instanceof Error ? error.message : String(error)}；范围暂存回滚失败：${truncateError instanceof Error ? truncateError.message : String(truncateError)}`);
        }
      }
      await record.lease?.release(); record.lease = undefined;
      task.status = record.abort.signal.aborted ? "cancelled" : "failed";
      task.error = record.abort.signal.aborted
        ? String(record.abort.signal.reason instanceof Error ? record.abort.signal.reason.message : record.abort.signal.reason || "Transfer cancelled.")
        : finalError instanceof Error ? finalError.message : String(finalError);
      if (checkpointRollbackError) task.error += `；范围暂存回滚失败：${checkpointRollbackError instanceof Error ? checkpointRollbackError.message : String(checkpointRollbackError)}`;
      task.error += `；临时文件保留在 ${tmpPath}，可确认路径后手动清理。`;
      throw finalError;
    }
  }

  private async runUpload(record: TransferRecord, options: UploadOptions): Promise<FileTransferTask> {
    const task = record.task;
    task.status = "running";
    task.error = undefined;
    task.finishedAt = undefined;
    task.transferredBytes = 0;
    record.inactivity = new ProgressInactivity(120_000, () => record.abort.abort(new Error("文件步骤 120 秒无真实进展，已取消。")));
    try {
      record.lease = await this.acquireFileLease(record);
      const sourcePath = task.localPath || "";
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("upload source is not a private regular file");
      task.size = stat.size;
      const expectedSha256 = options.sha256 || await sha256File(sourcePath, { signal: record.abort.signal, onBytes: (bytes) => record.inactivity?.update({ phase: "hashing", processedBytes: bytes }) });
      record.expectedSha256 = expectedSha256;
      await assertPrivateFileIdentity(sourcePath, stat);
      record.remoteOutcomeUnknown = true;
      const init = await this.requestJson<{ transferId: string; chunkSize?: number; accepted?: boolean; completed?: boolean; resumeFromByte?: number; sha256?: string }>(
        "/api/files/upload-init",
        "POST",
        {
          schemaVersion: 1,
          clientTransferId: task.transferId,
          remotePath: task.remotePath,
          size: stat.size,
          sha256: expectedSha256,
          overwrite: options.overwrite || "if_same_size",
        },
        record.abort.signal,
      );
      if (init.accepted === false) { record.remoteOutcomeUnknown = false; throw new Error("upload rejected"); }
      record.remoteTransferId = init.transferId || task.transferId;
      if (init.completed === true) {
        record.abort.signal.throwIfAborted();
        await record.lease?.assertHeld();
        if (!/^[a-f0-9]{64}$/i.test(String(init.sha256 || "")) || init.sha256!.toLowerCase() !== expectedSha256.toLowerCase())
          throw new Error("远端声明上传已完成，但没有匹配的 SHA256 回执；结果保持待核实。");
        record.actualSha256 = init.sha256;
        record.inactivity?.dispose();
        await record.lease?.release(); record.lease = undefined;
        record.remoteOutcomeUnknown = false;
        task.status = "completed";
        task.transferredBytes = stat.size;
        task.finishedAt = new Date().toISOString();
        return task;
      }
      const transferId = init.transferId || task.transferId;
      let offset = Math.max(0, Number(init.resumeFromByte || 0));
      const chunkSize = Math.max(1, Math.min(MAX_TRANSFER_CHUNK_BYTES,
        init.chunkSize || this.config.chunkSizeBytes || 1024 * 1024,
        this.config.chunkSizeBytes || Number.MAX_SAFE_INTEGER));
      const file = await fs.open(sourcePath, fsNode.constants.O_RDONLY | (fsNode.constants.O_NOFOLLOW || 0));
      try {
        const opened = await file.stat();
        await assertPrivateFileIdentity(sourcePath, stat, opened);
      } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
      }
      const startedAt = task.startedAt;
      try {
        while (offset < stat.size) {
          await record.lease?.assertHeld();
          if (record.abort.signal.aborted) throw new Error("TRANSFER_CANCELLED");
          const size = Math.min(chunkSize, stat.size - offset);
          const buffer = Buffer.allocUnsafe(size);
          const read = await file.read(buffer, 0, size, offset);
          if (read.bytesRead <= 0) throw new Error("upload source ended before its recorded size");
          const body = buffer.subarray(0, read.bytesRead);
          const query = new URLSearchParams({ transferId, clientTransferId: task.transferId, offset: String(offset) });
          const result = await this.requestJson<{ receivedBytes?: number; nextOffset?: number }>(
            `/api/files/upload-chunk?${query.toString()}`,
            "POST",
            body,
            record.abort.signal,
            "application/octet-stream",
          );
          offset = Number(result.nextOffset ?? (offset + body.byteLength));
          task.transferredBytes = offset;
          record.inactivity?.update({ phase: "transferring", processedBytes: offset });
          this.onProgress(this.progress(task.transferId, offset, stat.size, startedAt));
        }
      } finally {
        await file.close();
      }
      await record.lease?.assertHeld();
      await assertPrivateFileIdentity(sourcePath, stat);
      const complete = await this.requestJson<{ status?: string; sha256?: string }>(
        "/api/files/upload-complete",
        "POST",
        { schemaVersion: 1, transferId, clientTransferId: task.transferId, sha256: expectedSha256 },
        record.abort.signal,
      );
      await record.lease?.assertHeld();
      if (String(complete.status || "").toLowerCase() !== "completed")
        throw new Error(`远端未确认上传完成（${String(complete.status || "缺少状态回执")}）；结果保持待核实。`);
      record.actualSha256 = complete.sha256;
      if (!/^[a-f0-9]{64}$/i.test(String(complete.sha256 || "")) || complete.sha256!.toLowerCase() !== expectedSha256.toLowerCase())
        throw new Error("SHA256_MISMATCH");
      record.abort.signal.throwIfAborted();
      record.inactivity?.dispose();
      await record.lease?.release(); record.lease = undefined;
      record.remoteOutcomeUnknown = false;
      task.status = "completed";
      task.transferredBytes = stat.size;
      task.finishedAt = new Date().toISOString();
      return task;
    } catch (error) {
      record.inactivity?.dispose();
      await record.lease?.release(); record.lease = undefined;
      const definitiveRemoteStatus = String(task.remoteStatus || "").toLowerCase();
      if (record.remoteOutcomeUnknown) {
        task.status = "unknown";
        task.remoteStatus = "unknown";
        task.error = error instanceof Error ? error.message : String(error);
      } else if (!["completed", "failed", "cancelled"].includes(definitiveRemoteStatus)) {
        task.status = record.abort.signal.aborted ? "cancelled" : "failed";
        task.error = record.abort.signal.aborted
          ? String(record.abort.signal.reason instanceof Error ? record.abort.signal.reason.message : record.abort.signal.reason || "Transfer cancelled.")
          : error instanceof Error ? error.message : String(error);
      } else {
        task.status = definitiveRemoteStatus as FileTransferTask["status"];
        if (task.status === "completed") task.error = undefined;
      }
      throw error;
    }
  }

  private async acquireFileLease(record: TransferRecord): Promise<any> {
    const task = record.task;
    const project = task.direction === "download"
      ? path.dirname(path.resolve(task.localPath!))
      : this.config.resourceProjectRoot || "/";
    const resources = task.direction === "download"
      ? [{ server: "local", project, target: path.resolve(task.localPath!) }]
      : [
          { server: "local", project: path.dirname(path.resolve(task.localPath!)), target: path.resolve(task.localPath!) },
          { server: this.config.resourceServer || "transport:" + localBaseUrl(this.config), project, target: path.posix.resolve(project, task.remotePath) },
        ];
    return this.resourceLease.acquire({ pluginId: "simple-local.simple-experiment", workspaceUri: project, hostProjectPath: project,
      actionType: task.direction, actionLabel: task.direction, signal: record.abort.signal, resources });
  }

  private async requestJson<T>(
    apiPath: string,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
    contentType = "application/json",
    purpose: TunnelRequestPurpose = "file_transfer",
  ): Promise<T> {
    return this.budget.run(purpose, async () => {
      const response = await fetch(`${localBaseUrl(this.config)}${apiPath}`, {
        method,
        headers: this.headers(body !== undefined, contentType),
        body: body === undefined ? undefined : (contentType === "application/json" ? JSON.stringify(body) : body as BodyInit),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      const text = await readBoundedResponseText(response, () => undefined, 4 * 1024 * 1024);
      if (!response.ok) throw new Error(`file API ${response.status}: ${text.slice(0, 200)}`);
      return text.trim() ? JSON.parse(text) as T : {} as T;
    }, { userInitiated: true, signal });
  }

  private async confirmRemoteUploadSettlement(record: TransferRecord, timeoutMs = TRANSFER_CANCEL_SETTLEMENT_TIMEOUT_MS): Promise<void> {
    if (this.config.fileCapabilities?.supportsUploadCancel !== true) {
      record.task.remoteStatus = "unknown";
      record.task.status = "unknown";
      record.task.error = "当前 Agent 未声明 upload-cancel settled 回执能力；已阻止重试以避免远端旧传输继续写入。请更新 Agent 后重新核对。";
      throw new Error(record.task.error);
    }
    const deadline = Date.now() + timeoutMs;
    let delayMs = 100;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const requestTimer = setTimeout(() => controller.abort(new Error("remote cancellation status request timed out")), Math.min(1_500, timeoutMs));
      requestTimer.unref?.();
      try {
        const result = await this.requestJson<{ transferId?: string; status?: string; settled?: boolean; sha256?: string; error?: string }>(
          "/api/files/upload-cancel", "POST", {
            transferId: record.remoteTransferId,
            clientTransferId: record.task.transferId,
            remotePath: record.task.remotePath,
          }, controller.signal, "application/json", "stop",
        );
        const status = String(result.status || "unknown").toLowerCase();
        record.task.remoteStatus = status;
        if (result.settled === true && ["completed", "failed", "cancelled"].includes(status)) {
          if (status === "completed") {
            if (!/^[a-f0-9]{64}$/i.test(String(result.sha256 || "")) || !record.expectedSha256
              || result.sha256!.toLowerCase() !== record.expectedSha256.toLowerCase()) {
              record.task.status = "failed";
              record.task.error = "远端上传已提交，但完成回执缺失或 SHA256 与源文件不符。";
              throw new Error(record.task.error);
            }
            record.actualSha256 = result.sha256;
            record.remoteOutcomeUnknown = false;
            record.task.status = "completed";
            record.task.error = undefined;
            record.task.transferredBytes = record.task.size || record.task.transferredBytes;
            record.task.finishedAt = new Date().toISOString();
            return;
          }
          record.remoteOutcomeUnknown = false;
          record.task.status = status === "failed" ? "failed" : "cancelled";
          if (status === "failed") record.task.error = result.error || "远端上传已失败。";
          return;
        }
      } catch (error) {
        if (!record.remoteOutcomeUnknown) throw error;
        if (/file API (404|405)/i.test(error instanceof Error ? error.message : String(error))) {
          record.task.remoteStatus = "unknown";
          record.task.status = "unknown";
          record.task.error = "Agent 不支持 upload-cancel 结算回执；已阻止重试以避免远端旧传输继续写入。";
          throw new Error(record.task.error);
        }
        if (record.remoteOutcomeUnknown && Date.now() + delayMs >= deadline) {
          record.task.remoteStatus = "unknown";
          record.task.status = "unknown";
          record.task.error = `远端上传停止结果未知：${error instanceof Error ? error.message : String(error)}`;
          throw new Error(record.task.error);
        }
      } finally { clearTimeout(requestTimer); }
      await new Promise((resolve) => { const timer = setTimeout(resolve, delayMs); timer.unref?.(); });
      delayMs = Math.min(750, delayMs * 2);
    }
    record.task.remoteStatus = "unknown";
    record.task.status = "unknown";
    record.task.error = "远端上传仍未确认退出；已阻止重试以避免覆盖活动传输。请恢复连接后再次取消并核对状态。";
    throw new Error(record.task.error);
  }

  private headers(hasBody = false, contentType = "application/json"): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = contentType;
    if (this.config.token) headers["X-Simple-Agent-Token"] = this.config.token;
    return headers;
  }

  private async writeDownloadWithProgress(
    response: Response,
    localPath: string,
    transferId: string,
    totalBytes?: number,
    append = false,
  ): Promise<number> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const before = await fs.lstat(localPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink > 1)) throw new Error("download checkpoint is not a private regular file");
    const flags = fsNode.constants.O_WRONLY | fsNode.constants.O_CREAT
      | (append ? fsNode.constants.O_APPEND : 0)
      | (fsNode.constants.O_NOFOLLOW || 0);
    const file = await fs.open(localPath, flags, 0o600);
    try {
      const opened = await file.stat();
      const current = await fs.lstat(localPath);
      if (!opened.isFile() || opened.nlink > 1 || !current.isFile() || current.isSymbolicLink() || current.nlink > 1
        || opened.dev !== current.dev || opened.ino !== current.ino
        || before && (before.dev !== opened.dev || before.ino !== opened.ino))
        throw new Error("download checkpoint identity changed during open");
      if (!append) await file.truncate(0);
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
    let transferredBytes = 0;
    const startedAt = new Date().toISOString();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const signal = this.transfers.get(transferId)?.abort.signal;
    let abortReader: (() => void) | undefined;
    let completed = false;
    try {
      if (!response.body) throw new Error("download response does not provide a streaming body");
      reader = response.body.getReader();
      if (signal) {
        abortReader = () => { void reader?.cancel(signal.reason).catch(() => undefined); };
        signal.addEventListener("abort", abortReader, { once: true });
      }
      while (true) {
        if (this.transfers.get(transferId)?.abort.signal.aborted) throw new Error("TRANSFER_CANCELLED");
        const chunk = await reader.read();
        if (chunk.done) { completed = true; break; }
        if (!chunk.value?.byteLength) continue;
        await writeAll(file, chunk.value);
        transferredBytes += chunk.value.byteLength;
        this.transfers.get(transferId)?.inactivity?.update({ phase: "transferring", processedBytes: transferredBytes });
        this.onProgress(this.progress(transferId, transferredBytes, totalBytes, startedAt));
      }
      await file.sync();
      return transferredBytes;
    } finally {
      if (signal && abortReader) signal.removeEventListener("abort", abortReader);
      if (!completed) await reader?.cancel().catch(() => undefined);
      await file.close();
    }
  }

  private async withRetries<T>(maxRetries: number, run: () => Promise<T>, signal?: AbortSignal,
    canRetry: () => boolean = () => true): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (signal?.aborted || String(error instanceof Error ? error.message : error) === "TRANSFER_CANCELLED" || !canRetry()) break;
        if (attempt < maxRetries) this.budget.noteRetry();
      }
    }
    throw lastError;
  }

  private progress(
    transferId: string,
    transferredBytes: number,
    totalBytes?: number,
    startedAt?: string,
  ): FileTransferProgressEvent {
    const start = startedAt ? Date.parse(startedAt) : Date.now();
    const elapsedSeconds = Math.max(0.001, (Date.now() - start) / 1000);
    const speedBytesPerSecond = transferredBytes / elapsedSeconds;
    const etaSeconds = totalBytes && speedBytesPerSecond > 0 ? Math.max(0, (totalBytes - transferredBytes) / speedBytesPerSecond) : undefined;
    return { transferId, transferredBytes, totalBytes, speedBytesPerSecond, etaSeconds };
  }

  private track<T extends FileTransferTask>(record: TransferRecord, work: () => Promise<T>): Promise<T> {
    let operation: Promise<T>;
    try { operation = work(); }
    catch (error) { operation = Promise.reject(error); }
    record.settled = operation.then(() => undefined, () => undefined).then(() => {
      record.settledAt = Date.now();
      if (!record.task.finishedAt) record.task.finishedAt = new Date(record.settledAt).toISOString();
      this.trimTransferHistory();
    });
    return operation;
  }

  private ensureTransferCapacity(): void {
    this.trimTransferHistory(1);
    if (this.transfers.size >= MAX_TRANSFER_RECORDS)
      throw new Error(`传输历史达到 ${MAX_TRANSFER_RECORDS} 条上限，仍有请求未结算；请等待或核对活动传输。`);
  }

  private trimTransferHistory(reserve = 0): void {
    const terminal = [...this.transfers.entries()]
      .filter(([, record]) => record.settledAt !== undefined
        && !record.remoteOutcomeUnknown
        && ["completed", "failed", "cancelled"].includes(record.task.status))
      .sort((left, right) => Number(left[1].settledAt) - Number(right[1].settledAt));
    while (terminal.length > MAX_TERMINAL_TRANSFER_RECORDS || this.transfers.size + reserve > MAX_TRANSFER_RECORDS) {
      const oldest = terminal.shift();
      if (!oldest) break;
      this.transfers.delete(oldest[0]);
    }
  }

  private task(transferId: string, direction: "download" | "upload", remotePath: string, localPath?: string): FileTransferTask {
    return { transferId, direction, remotePath, localPath, transferredBytes: 0, status: "queued", startedAt: new Date().toISOString() };
  }

  private assertSafe(remotePath: string): void {
    if (!isSafeRemotePath(remotePath)) throw new Error("SAFE_PATH_REJECTED");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("File transfer client is disposed.");
  }
}

async function existingSize(file: string): Promise<number> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error("download checkpoint is not a private regular file");
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw error;
  }
}

async function writeAll(file: fs.FileHandle, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await file.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("download write made no progress");
    offset += result.bytesWritten;
  }
}

async function assertPrivateFileIdentity(filePath: string, expected: import("node:fs").Stats, opened?: import("node:fs").Stats): Promise<void> {
  const current = await fs.lstat(filePath);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink > 1
    || current.dev !== expected.dev || current.ino !== expected.ino
    || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs
    || opened && (!opened.isFile() || opened.nlink > 1 || opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs))
    throw new Error("upload source identity changed during transfer");
}

async function truncatePrivateFile(filePath: string, size: number): Promise<void> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) throw new Error("range checkpoint is not a private regular file");
  const handle = await fs.open(filePath, fsNode.constants.O_WRONLY | (fsNode.constants.O_NOFOLLOW || 0));
  try {
    await assertPrivateFileIdentity(filePath, before, await handle.stat());
    await handle.truncate(size);
    await handle.sync();
  } finally { await handle.close(); }
}

function boundedRetryCount(value: unknown): number {
  const retries = Number(value ?? 0);
  return Number.isFinite(retries) ? Math.max(0, Math.min(MAX_AUTOMATIC_TRANSFER_RETRIES, Math.floor(retries))) : 0;
}

function retryableTransferError(value: unknown): boolean {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = String(row.code || "").toUpperCase();
  const message = String(row.message || value || "");
  return ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(code)
    || /(?:fetch failed|network error|socket hang up|HTTP (?:408|425|429|5\d\d)\b|file API (?:408|425|429|5\d\d)\b)/i.test(message);
}
