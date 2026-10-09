/**
 * GpuScore - GPU 密集表格评分模型
 * 方案一严格实现：0-100 跑得快=高分，同 plan 内 p5/p95 归一，仅成功 job 计入，卡分=均值，服务器分=卡均值，评分窗口仅7天。
 * 过期或损坏的文件只从当前评分视图排除；磁盘清理必须进入明确的路径审核流程。
 */

import * as fs from "fs";
import * as path from "path";

export const GPU_SCORE_MAX_FILES = 10_000;
export const GPU_SCORE_MAX_FILE_BYTES = 64 * 1024;
export const GPU_SCORE_MAX_SCAN_BYTES = 16 * 1024 * 1024;

export const GPU_SCORE_WINDOW_DAYS = 7;
export const GPU_SCORE_WINDOW_MS = GPU_SCORE_WINDOW_DAYS * 24 * 3600 * 1000;
export const GPU_SCORE_MIN = 0;
export const GPU_SCORE_MAX = 100;

// Job 记录（仅成功 job 参与计分）
export interface GpuJobRecord {
  planFile: string;
  planId?: string;
  jobId: string;
  serverId: string;
  gpuId: string;
  durationMs: number;
  status: string; // completed/failed etc
  finishedAt: number; // epoch ms
  metricValue?: number;
  filePath?: string; // 关联的落盘文件；过期后可进入人工清理候选
}

// p5/p95 计算
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function computeP5P95(durations: number[]): { p5: number; p95: number } {
  if (!durations.length) return { p5: 0, p95: 1 };
  const sorted = [...durations].sort((a, b) => a - b);
  return { p5: percentile(sorted, 5), p95: percentile(sorted, 95) };
}

// 单 job 分数：跑得快=高分，p5->100, p95->0，线性归一并 clamp 0-100
export function computeJobScore(durationMs: number, p5: number, p95: number): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(p5) || !Number.isFinite(p95)) return 50;
  if (p95 <= p5) return 50;
  if (durationMs <= p5) return 100;
  if (durationMs >= p95) return 0;
  const score = ((p95 - durationMs) / (p95 - p5)) * 100;
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

// 对同 plan 内成功 jobs 批量计分
export function scoreJobsByPlan(jobs: GpuJobRecord[]): Map<string, number> {
  const byPlan = new Map<string, GpuJobRecord[]>();
  for (const j of jobs) {
    if (!isSuccessfulJob(j)) continue;
    const key = String(j.planFile || j.planId || "unknown");
    if (!byPlan.has(key)) byPlan.set(key, []);
    byPlan.get(key)!.push(j);
  }
  const scoreMap = new Map<string, number>();
  for (const [, list] of byPlan) {
    const durations = list.map((x) => x.durationMs).filter((v) => Number.isFinite(v));
    const { p5, p95 } = computeP5P95(durations);
    for (const job of list) {
      scoreMap.set(job.jobId, computeJobScore(job.durationMs, p5, p95));
    }
  }
  return scoreMap;
}

export function isSuccessfulJob(job: GpuJobRecord): boolean {
  const s = String(job.status || "").toLowerCase();
  return s === "completed" || s === "success" || s === "succeeded" || s === "done";
}

// 卡分 = 卡上所有成功 job 的 jobScore 均值
export function computeCardScore(jobScores: number[]): number | null {
  const valid = jobScores.filter((v) => Number.isFinite(v));
  if (!valid.length) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Math.max(0, Math.min(100, Math.round(avg * 10) / 10));
}

// 服务器分 = 该服务器下所有卡分的均值
export function computeServerScore(cardScores: (number | null)[]): number | null {
  const valid = cardScores.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!valid.length) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Math.max(0, Math.min(100, Math.round(avg * 10) / 10));
}

// 过滤 7天窗口，仅保留窗口内记录
export function filterWindow(records: GpuJobRecord[], nowMs: number = Date.now()): GpuJobRecord[] {
  const cutoff = nowMs - GPU_SCORE_WINDOW_MS;
  return records.filter((r) => Number.isFinite(r.finishedAt) && r.finishedAt >= cutoff);
}

// 评分窗口只影响内存视图。磁盘候选由统一的人工路径审核处理。
export function pruneExpired(records: GpuJobRecord[], nowMs: number = Date.now()): { kept: GpuJobRecord[]; pruned: GpuJobRecord[] } {
  const cutoff = nowMs - GPU_SCORE_WINDOW_MS;
  const kept: GpuJobRecord[] = [];
  const pruned: GpuJobRecord[] = [];
  for (const r of records) {
    if (!Number.isFinite(r.finishedAt) || r.finishedAt < cutoff) {
      pruned.push(r);
    } else {
      kept.push(r);
    }
  }
  return { kept, pruned };
}

/** @deprecated Kept as a source-compatible alias; this helper no longer deletes files. */
export function pruneExpiredAndUnlink(records: GpuJobRecord[], nowMs: number = Date.now()): { kept: GpuJobRecord[]; pruned: GpuJobRecord[] } {
  return pruneExpired(records, nowMs);
}

// 有界磁盘扫描；损坏、过期和超限文件均保留在原位，只从评分视图排除。
export function loadAndPruneScoreDir(dir: string, nowMs: number = Date.now()): GpuJobRecord[] {
  let files: fs.Dirent[] = [];
  try { files = fs.readdirSync(dir, { withFileTypes: true }).slice(0, GPU_SCORE_MAX_FILES); } catch { return []; }
  const records: GpuJobRecord[] = [];
  let scannedBytes = 0;
  for (const entry of files) {
    if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > GPU_SCORE_MAX_FILE_BYTES
        || scannedBytes + stat.size > GPU_SCORE_MAX_SCAN_BYTES) continue;
      scannedBytes += stat.size;
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      const rec: GpuJobRecord = {
        planFile: String(raw.planFile || raw.plan || ""),
        planId: raw.planId ? String(raw.planId) : undefined,
        jobId: String(raw.jobId || raw.id || entry.name),
        serverId: String(raw.serverId || raw.server || ""),
        gpuId: String(raw.gpuId || raw.gpu_id || ""),
        durationMs: Number(raw.durationMs ?? raw.duration ?? 0),
        status: String(raw.status || "completed"),
        finishedAt: Number(raw.finishedAt ?? raw.finished_at ?? Date.parse(raw.finishedAt || "") ?? nowMs),
        filePath: full,
      };
      records.push(rec);
    } catch {
      // Keep malformed records on disk for explicit inspection and cleanup.
    }
  }
  const { kept } = pruneExpired(records, nowMs);
  return kept;
}

// 便捷：计算某次全量记录的卡/服务器分映射（供 UI 消费）
export function buildScoreMaps(jobs: GpuJobRecord[]): { jobScores: Map<string, number>; cardScores: Map<string, number | null>; serverScores: Map<string, number | null> } {
  const windowed = filterWindow(jobs);
  const jobScores = scoreJobsByPlan(windowed);
  const byCard = new Map<string, number[]>();
  const byServer = new Map<string, Set<string>>(); // server -> set of card keys
  for (const j of windowed) {
    if (!isSuccessfulJob(j)) continue;
    const sc = jobScores.get(j.jobId);
    if (sc === undefined) continue;
    const cardKey = `${j.serverId}::${j.gpuId}`;
    if (!byCard.has(cardKey)) byCard.set(cardKey, []);
    byCard.get(cardKey)!.push(sc);
    if (!byServer.has(j.serverId)) byServer.set(j.serverId, new Set());
    byServer.get(j.serverId)!.add(cardKey);
  }
  const cardScores = new Map<string, number | null>();
  for (const [k, arr] of byCard) cardScores.set(k, computeCardScore(arr));
  const serverScores = new Map<string, number | null>();
  for (const [serverId, cardKeys] of byServer) {
    const scores: (number | null)[] = [];
    for (const ck of cardKeys) scores.push(cardScores.get(ck) ?? null);
    serverScores.set(serverId, computeServerScore(scores));
  }
  return { jobScores, cardScores, serverScores };
}
