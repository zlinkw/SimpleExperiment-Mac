export type FileTransferDirection = "download" | "upload";
export type FileTransferStatus = "queued" | "running" | "cancelling" | "paused" | "completed" | "failed" | "cancelled" | "unknown";

export interface FileTransferTask {
  transferId: string;
  direction: FileTransferDirection;
  remotePath: string;
  localPath?: string;
  size?: number;
  transferredBytes: number;
  status: FileTransferStatus;
  remoteStatus?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface FileTransferProgressEvent {
  transferId: string;
  transferredBytes: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}

export interface RemoteFileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: string;
}

export interface FileListResponse {
  schemaVersion: number;
  path: string;
  entries: RemoteFileEntry[];
}

export interface FileStatResponse extends RemoteFileEntry {
  schemaVersion: number;
  path: string;
  exists: boolean;
}

export interface DownloadOptions {
  expectedSha256?: string;
  maxRetries?: number;
  maxBytes?: number;
  resume?: boolean;
  confirmLargeFile?: (size: number) => Promise<boolean> | boolean;
}

export interface UploadOptions {
  sha256?: string;
  maxRetries?: number;
  overwrite?: "never" | "if_same_size" | "always";
}

export interface FileTransferVerifyResult {
  transferId: string;
  ok: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  message: string;
}

const ROOT_RESULT_FILES: ReadonlySet<string> = new Set([
  "metrics_summary.csv", "metrics_case.csv", "results.csv", "result.csv", "metrics.csv", "summary.csv", "scores.csv", "score.csv",
  "detailed_metrics.csv", "test_metrics.csv", "classification_report.csv", "metrics.json", "summary.json", "result.json", "results.json",
  "classification_report.json", "summary.txt", "result.txt", "results.txt", "classification_report.txt", "stdout.log", "stderr.log",
  "train.log", "test.log", "console.log", "output.out",
]);

const ALLOWED_REMOTE_PATH_ROOTS: ReadonlySet<string> = new Set([
  "simple_cluster", "work_dirs", "experiments", "exports", "results", "paper", "outputs", "runs", "logs", "test_results",
  "lightning_logs", "custom_results", "reports", "artifacts", "evals", "eval", "evaluation", "predictions", "submissions",
]);

export function isSafeRemotePath(remotePath: string): boolean {
  const normalized = remotePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.includes("\0")) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  const segments = normalized.split("/");
  if (segments.some((part) => part === "..")) return false;
  if (segments.some((part) => /^(id_rsa|id_ed25519|known_hosts|\.ssh)(\.|$)/i.test(part) || /\.(pem|key)$/i.test(part))) return false;
  const parts = segments.filter((part) => part && part !== ".");
  if (!parts.length) return false;
  if (parts.length === 1) return ROOT_RESULT_FILES.has(parts[0].toLowerCase());
  return ALLOWED_REMOTE_PATH_ROOTS.has(parts[0].toLowerCase());
}

export function makeTransferId(prefix = "transfer"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
