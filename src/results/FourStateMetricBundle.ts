import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readCsv } from "./ProjectResultTables";
import type { ProjectResultFile } from "./ProjectResultPublication";

export type MetricMemoryFile = { remotePath: string; sha256: string; text: string; bytes?: number; encoding?: "base64" };
export type MetricJob = { runId: string; index: number; attempt: number; case: string; seed: number;
  workerId: string; ownerWorkerId?: string; outputDir: string; commandId: string; checkpointPath?: string };

const fingerprint = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function relative(value: string): string {
  const text = String(value || "").replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.includes(":") || text.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("指标来源路径不安全：" + text);
  return text;
}
function sourcePath(value: string, output: string): string {
  const text = String(value || "").replace(/\\/g, "/").replace(/\/$/, "");
  if (!text || text.split("/").includes("..")) throw new Error("指标缺少可信 job_dir/checkpoint_path");
  if (text === output || text.startsWith(output + "/")) return text;
  const marker = "/" + output;
  const at = text.lastIndexOf(marker);
  if (text.startsWith("/") && at >= 0 && (text.length === at + marker.length || text[at + marker.length] === "/")) return text.slice(at + 1);
  throw new Error("指标 job_dir/checkpoint 身份与本次 attempt 不一致：" + text);
}
function csv(file: MetricMemoryFile): Record<string, string>[] {
  if (!/^[a-f0-9]{64}$/i.test(file.sha256 || "") || fingerprint(file.text) !== file.sha256.toLowerCase()
    || file.bytes != null && Buffer.byteLength(file.text, "utf8") !== file.bytes) throw new Error("指标 SHA256 不符：" + file.remotePath);
  const parsed = readCsv(file.text.replace(/^\uFEFF/, ""));
  if (!parsed.rows.length || new Set(parsed.header).size !== parsed.header.length) throw new Error("指标 CSV 为空或列重复：" + file.remotePath);
  return parsed.rows.map(cells => {
    if (cells.length !== parsed.header.length) throw new Error("指标 CSV 行列不完整：" + file.remotePath);
    return Object.fromEntries(parsed.header.map((name, index) => [name, cells[index]]));
  });
}

/** A recognized schema adds validation; generic wrapper publication owns persistence and provenance. */
export function validateFourStateMetricPair(job: MetricJob, endpoint: MetricMemoryFile | undefined, four: MetricMemoryFile | undefined): void {
  if (!endpoint || !four) throw new Error("端点或四态指标缺失，保留原有完整结果：" + job.case + "/" + job.seed);
  const output = relative(job.outputDir);
  if (!job.runId || !job.commandId || !job.workerId || !job.case || !Number.isInteger(job.seed) || !Number.isInteger(job.attempt) || job.attempt < 1)
    throw new Error("指标缺少可信 run/attempt/job 身份");
  for (const file of [endpoint, four]) if (!relative(file.remotePath).startsWith(output + "/")) throw new Error("指标来源不属于本次 attempt");
  const endpoints = csv(endpoint), states = csv(four);
  const dataset = endpoints[0].dataset, method = endpoints[0].method;
  const checkpoints = new Set<string>();
  for (const row of [...endpoints, ...states]) {
    if (String(row.seed) !== String(job.seed) || row.case && row.case !== job.case || row.run_id && row.run_id !== job.runId
      || !row.dataset || row.dataset !== dataset || !row.method || row.method !== method
      || sourcePath(row.job_dir, output) !== output) throw new Error("端点与四态的运行/Case/seed/数据集身份不一致：" + output);
    const checkpoint = sourcePath(row.checkpoint_path, output);
    if (!checkpoint.startsWith(output + "/")) throw new Error("checkpoint 不属于本次 attempt");
    if (job.checkpointPath && checkpoint !== job.checkpointPath) throw new Error("checkpoint 与作业契约不一致");
    checkpoints.add(checkpoint);
  }
  if (checkpoints.size !== 1) throw new Error("端点与四态不是同一 checkpoint，保留原有完整结果：" + output);
  const required = ["state", "metric", "value", "p0_value", "delta_p100_minus_p0", "sample_count", "checkpoint_path", "job_dir", "undefined_reason", "p0_undefined_reason"];
  if (required.some(key => !Object.hasOwn(states[0], key))) throw new Error("四态指标列不完整：" + four.remotePath);
  const protocols = new Set([...endpoints, ...states].map(row => row.protocol_version).filter(Boolean));
  if (protocols.size > 1) throw new Error("端点与四态协议不一致");
  const metrics = new Set(endpoints.map(row => row.metric).filter(Boolean));
  const byState = new Map<string, Set<string>>();
  for (const row of states) {
    if (!row.state || !row.metric || !metrics.has(row.metric)) throw new Error("四态缺少状态或端点对应指标");
    const names = byState.get(row.state) || new Set<string>();
    if (names.has(row.metric)) throw new Error("四态指标重复：" + row.state + "/" + row.metric);
    names.add(row.metric); byState.set(row.state, names);
    if (!row.sample_count.trim() || !Number.isSafeInteger(Number(row.sample_count)) || Number(row.sample_count) < 0) throw new Error("四态 sample_count 无效");
    for (const [field, reason] of [["value", row.undefined_reason], ["p0_value", row.p0_undefined_reason],
      ["delta_p100_minus_p0", row.undefined_reason || row.p0_undefined_reason]]) {
      const raw = row[field].trim();
      if ((!raw || !Number.isFinite(Number(raw))) && !reason.trim()) throw new Error("四态不可计算指标缺少原因：" + field);
      if (raw && !Number.isFinite(Number(raw)) && !/^nan$/i.test(raw)) throw new Error("四态指标数值无效：" + field);
    }
  }
  if (byState.size !== 4 || !metrics.size || [...byState.values()].some(names => names.size !== metrics.size)) throw new Error("四态状态/指标覆盖不完整");
}

/** Reject alteration of a previously collected attempt, rather than overwrite historical raw evidence. */
export async function assertImmutableMetricFiles(root: string, files: ProjectResultFile[]): Promise<void> {
  for (const file of files) {
    const parts = relative(file.relativePath).split("/");
    let parent = root;
    for (const part of parts) {
      parent = path.join(parent, part);
      const info = await fs.lstat(parent).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (info?.isSymbolicLink()) throw new Error("历史指标路径包含符号链接");
    }
    const previous = await fs.readFile(parent).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (previous && createHash("sha256").update(previous).digest("hex") !== fingerprint(file.contents))
      throw new Error("同一 attempt 的历史原始指标已变化，拒绝覆盖：" + file.relativePath);
  }
}
