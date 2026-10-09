import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readCsv, writeCsv, datasetPathKey, methodTableName, planDirectoryKey } from "./ProjectResultTables";
import { validateFourStateMetricPair, type MetricJob, type MetricMemoryFile } from "./FourStateMetricBundle";
import type { ProjectResultFile } from "./ProjectResultPublication";

export const isWrapperResultFile = (file: string): boolean => /\.[A-Za-z0-9]+$/.test(file)
  && !/\.(pt|pth|ckpt|safetensors|onnx|bin|py|pyc|js|ts|sh|exe|dll|lock|pid)$/i.test(file)
  && !/(?:^|\/)(?:weights?|checkpoints?|code_backup|\.git|\.runtime|__pycache__|clean_dir)(?:\/|$)/i.test(file);
export const isWrapperTextFile = (file: string) => /\.(csv|tsv|json|jsonl|ya?ml|md|txt|log|out)$/i.test(file);
export const resultHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Reuse final originals only after comparing their bytes to this sync's remote inventory. */
export async function readVerifiedLocalResult(root: string, entry: { remotePath: string; localRelativePath: string; sha256: string; bytes: number }): Promise<(MetricMemoryFile & { reused: true }) | undefined> {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(entry.sha256))
    throw new Error("wrapper 本机复用缺少大小和 SHA256");
  const parts = entry.localRelativePath.replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[:\x00-\x1f]/.test(part))) throw new Error("wrapper 本机复用路径不安全");
  let cursor = path.resolve(root);
  for (const part of ["", ...parts]) {
    if (part) cursor = path.join(cursor, part);
    const info = await fs.lstat(cursor).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return undefined;
    if (info.isSymbolicLink()) throw new Error("wrapper 映射路径包含符号链接");
  }
  const handle = await fs.open(cursor, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== entry.bytes) return undefined;
    // Bounded read even if another process grows this file while it is being checked.
    const buffer = Buffer.alloc(entry.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256.toLowerCase()) return undefined;
    return { remotePath: entry.remotePath, sha256: entry.sha256.toLowerCase(), bytes: length, reused: true,
      ...(isWrapperTextFile(entry.remotePath) ? { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
        : { text: bytes.toString("base64"), encoding: "base64" as const }) };
  } finally { await handle.close(); }
}
export function jobResultPath(value: string, outputDir: string): string {
  const output = outputDir.replace(/\\/g, "/");
  let file = String(value || "").replace(/\\/g, "/");
  if (file.startsWith("/")) {
    const marker = "/" + output;
    const at = file.lastIndexOf(marker);
    if (at < 0 || file[at + marker.length] !== "/") throw new Error("wrapper 来源不属于作业目录：" + file);
    file = file.slice(at + 1);
  } else if (!file.startsWith(output + "/")) file = output + "/" + file.replace(/^\.\//, "");
  if (!file.startsWith(output + "/") || file.includes(":") || /[\x00-\x1f]/.test(file)
    || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error("wrapper 产物路径不安全：" + file);
  return file;
}

/** Wrapper manifests may add outputs without teaching the plugin their metric names or schema. */
export function declaredWrapperResults(text: string, outputDir: string): string[] {
  const manifest = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("wrapper manifest 必须是对象");
  if (manifest.output_dir && jobResultPath(String(manifest.output_dir) + "/artifact_manifest.json", outputDir) !== outputDir + "/artifact_manifest.json")
    throw new Error("wrapper manifest 的 output_dir 不匹配");
  const files = new Set<string>();
  const visit = (value: unknown, depth: number, field = ""): void => {
    if (depth > 16) throw new Error("wrapper manifest 嵌套过深");
    if (typeof value === "string" && isWrapperResultFile(value) && (isWrapperTextFile(value) || value.includes("/") || /path|file|outputs|artifacts/i.test(field))) files.add(jobResultPath(value, outputDir));
    else if (Array.isArray(value)) value.forEach(entry => visit(entry, depth + 1, field));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => visit(entry, depth + 1, key));
    if (files.size > 1024) throw new Error("wrapper 声明超过 1024 个轻量结果文件");
  };
  visit(manifest, 0);
  return [...files].sort();
}

type ResultSource = { remotePath: string; localRelativePath: string; sha256: string; bytes: number; kind: string; format: string };
export type WrapperJobEvidence = { job: MetricJob; checkpointPath?: string; sources: ResultSource[] };
type PreparedJob = { evidence: WrapperJobEvidence; files: ProjectResultFile[];
  records: Array<{ source: ResultSource; rows?: Record<string, string>[]; value?: unknown; dataset: string; method: string }> };
export type WrapperPublication = { runId: string; status: "formal" | "preview"; expectedJobs: Array<{ case: string; seed: number }>;
  jobs: WrapperJobEvidence[]; files: ProjectResultFile[] };

function csvRecords(text: string, delimiter = ","): Record<string, string>[] {
  const parsed = readCsv(text.replace(/^\uFEFF/, ""), delimiter);
  return parsed.rows.map(cells => Object.fromEntries(parsed.header.map((name, index) => [name, cells[index]])));
}
function validateIdentity(row: Record<string, any>, job: MetricJob, source: string): string | undefined {
  for (const [field, expected] of [["case", job.case], ["seed", job.seed], ["run_id", job.runId], ["runId", job.runId], ["attempt", job.attempt]])
    if (row[field] != null && String(row[field]).trim() && String(row[field]) !== String(expected))
      throw new Error("wrapper 结果身份不匹配：" + field + "（期望 " + expected + "，实际 " + row[field] + "；来源 " + source + "）");
  for (const field of ["job_dir", "output_dir"])
    if (row[field] && jobResultPath(String(row[field]) + "/.identity", job.outputDir) !== job.outputDir + "/.identity") throw new Error("wrapper job_dir 不匹配");
  return row.checkpoint_path ? jobResultPath(String(row.checkpoint_path), job.outputDir) : undefined;
}

/** Preserve bytes and unknown fields; only the recognized four-state schema uses its stronger validator. */
export function prepareWrapperJob(job: MetricJob, inputs: MetricMemoryFile[], endpointPath: string,
  requiredPaths: string[], localPath: (file: string) => string): PreparedJob {
  if (!job.runId || !job.workerId || !job.commandId || !job.case || !Number.isInteger(job.seed) || !Number.isInteger(job.attempt) || job.attempt < 1)
    throw new Error("wrapper 结果缺少可信运行及作业身份");
  const byPath = new Map(inputs.map(file => [file.remotePath, file]));
  if (byPath.size !== inputs.length || requiredPaths.some(file => !byPath.has(file))) throw new Error("wrapper 必需结果缺失，保留原有完整结果：" + job.case + "/" + job.seed);
  const sources: ResultSource[] = [], files: ProjectResultFile[] = [], records: PreparedJob["records"] = [];
  const checkpoints = new Set<string>();
  const primaryPaths = new Set([endpointPath]);
  const declaration = byPath.get(job.outputDir + "/artifact_manifest.json");
  if (declaration) {
    // Parse role metadata only after verifying the declaration itself.
    if (resultHash(declaration.text) !== declaration.sha256.toLowerCase()) throw new Error("wrapper manifest SHA256 不符");
    const manifest = JSON.parse(declaration.text.replace(/^\uFEFF/, ""));
    for (const file of [manifest.metrics_summary, manifest.result_csv, manifest.result_rows, manifest.standard_outputs?.metrics_summary])
      if (typeof file === "string") primaryPaths.add(jobResultPath(file, job.outputDir));
  }
  for (const file of inputs.slice().sort((left, right) => left.remotePath < right.remotePath ? -1 : left.remotePath > right.remotePath ? 1 : 0)) {
    if (jobResultPath(file.remotePath, job.outputDir) !== file.remotePath || !isWrapperResultFile(file.remotePath)) throw new Error("wrapper 来源无效");
    const contents = file.encoding === "base64" ? Buffer.from(file.text, "base64") : file.text;
    if (file.encoding === "base64" && (typeof contents === "string" || contents.toString("base64") !== file.text)) throw new Error("wrapper 二进制内容编码无效");
    if (!/^[a-f0-9]{64}$/i.test(file.sha256) || createHash("sha256").update(contents).digest("hex") !== file.sha256.toLowerCase()
      || file.bytes != null && Buffer.byteLength(contents) !== file.bytes) throw new Error("wrapper SHA256 不符：" + file.remotePath);
    const format = path.posix.extname(file.remotePath).slice(1).toLowerCase();
    const source = { remotePath: file.remotePath, localRelativePath: localPath(file.remotePath), sha256: file.sha256.toLowerCase(),
      bytes: Buffer.byteLength(contents), kind: file.remotePath.slice(job.outputDir.length + 1), format };
    const rows = ["csv", "tsv"].includes(format) ? csvRecords(file.text, format === "tsv" ? "\t" : ",") : undefined;
    const value = file.encoding === "base64" ? { binary: true, sourcePath: source.localRelativePath, sha256: source.sha256 } : format === "json" ? JSON.parse(file.text.replace(/^\uFEFF/, "")) : format === "jsonl"
      ? file.text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : rows ? undefined : file.text;
    const identities = rows || (Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row))
      : value && typeof value === "object" ? [value] : []);
    const fourState = Boolean(rows?.length && Object.hasOwn(rows[0], "state") && Object.hasOwn(rows[0], "p0_value") && Object.hasOwn(rows[0], "delta_p100_minus_p0"));
    for (const row of identities) {
      // Auxiliary diagnostics may use seed/case for sampling or patients. Only a canonical
      // metric role, recognized schema, or explicit run/job anchor gives them job semantics.
      if (!primaryPaths.has(file.remotePath) && !fourState && !row.run_id && !row.runId && !row.job_dir && !row.output_dir) continue;
      const checkpoint = validateIdentity(row, job, file.remotePath); if (checkpoint) checkpoints.add(checkpoint);
    }
    if (fourState)
      validateFourStateMetricPair(job, byPath.get(endpointPath), file);
    sources.push(source); files.push({ relativePath: source.localRelativePath, contents, immutable: true });
    records.push({ source, rows, value, dataset: rows?.[0]?.dataset || "", method: rows?.[0]?.method || "" });
  }
  if (checkpoints.size > 1 || job.checkpointPath && checkpoints.size && !checkpoints.has(job.checkpointPath)) throw new Error("wrapper 端点和其它结果不是同一 checkpoint，保留旧完整结果");
  // Queue enrichment (hash caches, sync receipts) is not part of immutable job identity.
  const identity: MetricJob = { runId: job.runId, index: job.index, attempt: job.attempt, case: job.case, seed: job.seed,
    workerId: job.workerId, outputDir: job.outputDir, commandId: job.commandId,
    ...(job.ownerWorkerId ? { ownerWorkerId: job.ownerWorkerId } : {}), ...(job.checkpointPath ? { checkpointPath: job.checkpointPath } : {}) };
  const evidence: WrapperJobEvidence = { job: identity, ...(checkpoints.size ? { checkpointPath: [...checkpoints][0] } : {}), sources };
  for (const source of sources) files.push({ relativePath: source.localRelativePath + ".provenance.json",
    contents: JSON.stringify({ schemaVersion: 1, job: evidence.job, checkpointPath: evidence.checkpointPath, source }, null, 2) + "\n" });
  return { evidence, files, records };
}

/** Provenance may gain schema fields, but cannot reassign a historical source to another job or digest. */
export async function assertWrapperProvenance(root: string, files: ProjectResultFile[]): Promise<void> {
  for (const file of files.filter(file => file.relativePath.endsWith('.provenance.json'))) {
    let cursor = root;
    for (const part of file.relativePath.split('/')) {
      if (!part || part === '.' || part === '..' || part.includes(':')) throw new Error('provenance 路径不安全');
      cursor = path.join(cursor, part);
      const info = await fs.lstat(cursor).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info?.isSymbolicLink()) throw new Error('provenance 路径包含符号链接');
    }
    const previous = await fs.readFile(cursor, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!previous) continue;
    const old = JSON.parse(previous), next = JSON.parse(file.contents.toString());
    const fields = ['runId','index','attempt','case','seed','workerId','ownerWorkerId','outputDir','commandId'];
    if (fields.some(field => old.job?.[field] !== next.job?.[field]) || old.checkpointPath !== next.checkpointPath
      || old.source?.sha256 !== next.source?.sha256 || old.source?.remotePath !== next.source?.remotePath
      || old.source?.localRelativePath !== next.source?.localRelativePath)
      throw new Error('历史 provenance 运行或来源身份不一致，拒绝覆盖：' + file.relativePath);
  }
}

/** All seed/job identities must belong to one generation before advancing formal tables. */
export function prepareWrapperPublication(runId: string, expectedJobs: Array<{ case: string; seed: number }>, prepared: PreparedJob[], preview = false): WrapperPublication {
  const key = (job: { case: string; seed: number }) => job.case + "\0" + job.seed;
  const expected = new Set(expectedJobs.map(key)), actual = new Set(prepared.map(item => key(item.evidence.job)));
  if (!expected.size || expected.size !== expectedJobs.length || actual.size !== prepared.length || !prepared.length
    || prepared.some(item => item.evidence.job.runId !== runId || !expected.has(key(item.evidence.job)))) throw new Error("wrapper 发布运行或作业清单不一致");
  if (!preview && actual.size !== expected.size) throw new Error("种子/作业不完整，仅可预览，保留原有完整结果");
  return { runId, status: preview ? "preview" : "formal", expectedJobs, jobs: prepared.map(item => item.evidence), files: prepared.flatMap(item => item.files) };
}

/** Lossless per-kind collection, not scientific aggregation. Adapters remain responsible for statistics. */
export function wrapperMergedFiles(resultDir: string, planFile: string, publication: WrapperPublication, prepared: PreparedJob[]): ProjectResultFile[] {
  const groups = new Map<string, { dataset: string; method: string; kind: string; rows: Record<string, string>[]; values: unknown[] }>();
  for (const item of prepared) for (const record of item.records) {
    const entries = record.rows?.length ? record.rows : [undefined];
    for (const row of entries) {
      const dataset = row?.dataset || record.dataset || "_unassigned", method = row?.method || record.method || path.posix.basename(planFile, path.posix.extname(planFile));
      const key = JSON.stringify([dataset, method, record.source.kind]);
      if (!groups.has(key)) groups.set(key, { dataset, method, kind: record.source.kind, rows: [], values: [] });
      const group = groups.get(key)!;
      const provenance = { simple_run_id: publication.runId, simple_attempt: String(item.evidence.job.attempt), simple_case: item.evidence.job.case,
        simple_seed: String(item.evidence.job.seed), simple_worker: item.evidence.job.workerId, simple_source_path: record.source.remotePath,
        simple_source_sha256: record.source.sha256, simple_status: publication.status };
      if (row) {
        if (Object.keys(provenance).some(name => Object.hasOwn(row, name))) throw new Error("wrapper 列与保留 provenance 列冲突");
        group.rows.push({ ...row, ...provenance });
      } else group.values.push({ provenance, content: record.value });
    }
  }
  return [...groups.values()].map(group => {
    const token = group.kind.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) + "__" + resultHash(group.kind).slice(0, 8);
    const datasetKey = group.dataset === "_unassigned" ? "_unassigned" : datasetPathKey(group.dataset);
    const base = publication.status === "formal" ? path.posix.join(datasetKey, "methods", methodTableName(group.method), "wrapper", planDirectoryKey(planFile))
      : path.posix.join(datasetKey, "plans", planDirectoryKey(planFile), "trace", "preview__" + resultHash(publication.runId).slice(0, 16));
    const header = [...new Set(group.rows.flatMap(row => Object.keys(row)))];
    return { relativePath: path.posix.join(resultDir, base, token + (group.rows.length ? ".csv" : ".json")),
      contents: group.rows.length ? writeCsv(header, group.rows.map(row => header.map(name => row[name] ?? "")))
        : JSON.stringify({ schemaVersion: 1, status: publication.status, runId: publication.runId, expectedJobs: publication.expectedJobs, kind: group.kind, results: group.values }, null, 2) + "\n" };
  });
}
