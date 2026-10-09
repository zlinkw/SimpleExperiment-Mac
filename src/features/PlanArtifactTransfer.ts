import * as path from "path";
import { PlanSyncEntry, safePlanArtifactPath } from "./PlanArtifactSync";

export type SyncTarget = { id: string; host: string; user: string; port: number; remotePath: string; networkHost?: string };
export type SftpCall = (method: string, params: Record<string, unknown>) => Promise<any>;

function checkedRoot(target: SyncTarget): string {
  const root = String(target.remotePath || "").replace(/\/+$/, "");
  if (!root.startsWith("/") || root === "/" || !target.host || !target.user || !Number.isInteger(target.port)) throw new Error(`Worker ${target.id} 缺少安全的项目路径或连接信息。`);
  return root;
}

export function directPlanSyncPreview(entry: PlanSyncEntry, source: SyncTarget, destination: SyncTarget): string[] {
  const sourceRoot = checkedRoot(source);
  const destinationRoot = checkedRoot(destination);
  const copies = entry.artifactPaths.map((raw) => {
    const relative = safePlanArtifactPath(raw);
    if (!relative) throw new Error(`Plan 产物路径不安全：${raw}`);
    return `${path.posix.join(sourceRoot, relative)} → ${path.posix.join(destinationRoot, relative)}`;
  });
  const deletes = (entry.stalePaths || []).map((item) => {
    const relative = safePlanArtifactPath(item.path);
    if (!relative) throw new Error(`旧产物路径不安全：${item.path}`);
    return `清理旧产物：${path.posix.join(destinationRoot, relative)}`;
  });
  return [...deletes, ...copies];
}

const BATCH_FILE_LIMIT = 5000;
const TASK_LABEL_LIMIT = 180;

function redactCredentialText(value: string): string {
  return value
    .replace(/(password|passwd|token|secret|privateKey|private_key|agentToken)\s*[:=]\s*\S+/gi, "$1=<已遮蔽>")
    .replace(/(Bearer)\s+\S+/gi, "$1 <已遮蔽>")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "<已遮蔽私钥>");
}

function boundedLabelPart(value: unknown, limit: number): string {
  const text = redactCredentialText(String(value ?? "")).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  if (limit < 2) return "";
  return `${text.slice(0, limit - 1)}…`;
}

function fitFlexiblePart(value: string, room: number): string {
  if (!value || room < 3) return "";
  return value.length <= room ? value : `${value.slice(0, room - 1)}…`;
}

/** Readable notification context for Worker-to-Worker fpsync. Never includes credentials. */
export function workerFpsyncTaskLabel(input: {
  action: string;
  sourceId?: string;
  destinationId?: string;
  planFile?: string;
  job?: string;
  detail?: string;
  batch?: number;
  batchCount?: number;
}): string {
  const action = boundedLabelPart(input.action, 48) || "Worker 间同步";
  const sourceId = boundedLabelPart(input.sourceId, 40);
  const destinationId = boundedLabelPart(input.destinationId, 40);
  const workers = sourceId || destinationId ? `${sourceId || "未知来源"} → ${destinationId || "未知目标"}` : "";
  const batch = Number.isInteger(input.batch) && Number.isInteger(input.batchCount) && (input.batchCount as number) > 1
    ? `批次 ${input.batch}/${input.batchCount}` : "";
  const fixed = [action, workers, batch].filter(Boolean);
  const separator = " · ";
  let room = TASK_LABEL_LIMIT - fixed.join(separator).length - (fixed.length ? separator.length : 0);
  const flexible: string[] = [];
  for (const part of [
    input.planFile ? `Plan ${boundedLabelPart(input.planFile, 80)}` : "",
    boundedLabelPart(input.job, 48),
    boundedLabelPart(input.detail, 96),
  ].filter(Boolean)) {
    const fitted = fitFlexiblePart(part, Math.max(0, room - (flexible.length ? separator.length : 0)));
    if (!fitted) continue;
    flexible.push(fitted);
    room -= fitted.length + (flexible.length > 1 ? separator.length : 0);
  }
  const core = [action];
  if (flexible.length) core.push(flexible.join(separator));
  if (workers) core.push(workers);
  if (batch) core.push(batch);
  return core.join(separator);
}

export async function transferPlanArtifacts(
  entry: PlanSyncEntry,
  source: SyncTarget,
  destination: SyncTarget,
  sftpCall: SftpCall,
): Promise<{ paths: number }> {
  checkedRoot(source);
  checkedRoot(destination);
  if (!entry.artifactPaths.length) throw new Error("Plan 没有可确认的产物路径，无法同步权重和结果。");
  const destinationTarget = { ...destination, host: destination.networkHost || destination.host };
  let paths = 0;
  for (const stale of entry.stalePaths || []) {
    const relativePath = safePlanArtifactPath(stale.path);
    if (!relativePath || (stale.directory && relativePath.split("/").length < 2)) throw new Error(`旧产物路径不安全：${stale.path}`);
    await sftpCall("sync.serverToServer", {
      source,
      destination: destinationTarget,
      relativePath,
      directory: stale.directory,
      deleteOnly: true,
      confirm: true,
      pathConfirmed: true,
    });
    paths++;
  }
  const files: string[] = [];
  for (const raw of entry.artifactPaths) {
    const relativePath = safePlanArtifactPath(raw);
    if (!relativePath) throw new Error(`Plan 产物路径不安全：${raw}`);
    const directory = entry.directoryPaths.includes(relativePath);
    if (directory && relativePath.split("/").length < 2) throw new Error(`产物目录必须限定到 Plan 独立子目录：${relativePath}`);
    if (path.posix.dirname(relativePath) === "." && !directory) throw new Error(`拒绝对项目根目录执行产物同步：${relativePath}`);
    if (directory) {
      await sftpCall("sync.serverToServerFpsync", {
        source,
        destination: destinationTarget,
        relativePath,
        directory: true,
        confirm: true,
        pathConfirmed: true,
        taskLabel: workerFpsyncTaskLabel({
          action: "Plan 完成产物同步",
          planFile: entry.planFile,
          sourceId: source.id,
          destinationId: destination.id,
          detail: `目录 ${relativePath}`,
        }),
      });
      paths++;
    } else {
      files.push(relativePath);
    }
  }
  const uniqueFiles = [...new Set(files)].sort();
  const batchCount = Math.ceil(uniqueFiles.length / BATCH_FILE_LIMIT);
  for (let offset = 0; offset < uniqueFiles.length; offset += BATCH_FILE_LIMIT) {
    const relativePaths = uniqueFiles.slice(offset, offset + BATCH_FILE_LIMIT);
    const batch = offset / BATCH_FILE_LIMIT + 1;
    const span = relativePaths.length === 1
      ? relativePaths[0]
      : `${relativePaths[0]} … ${relativePaths[relativePaths.length - 1]}（${relativePaths.length} 个文件）`;
    await sftpCall("sync.serverToServerFpsync", {
      source,
      destination: destinationTarget,
      relativePaths,
      confirm: true,
      pathConfirmed: true,
      taskLabel: workerFpsyncTaskLabel({
        action: "Plan 完成产物同步",
        planFile: entry.planFile,
        sourceId: source.id,
        destinationId: destination.id,
        detail: span,
        batch,
        batchCount,
      }),
    });
    paths += relativePaths.length;
  }
  return { paths };
}
