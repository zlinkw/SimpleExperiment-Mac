import * as crypto from "crypto";
import * as path from "path";
import { normalizePosixRelativePath } from "../mac/PosixPath";

// Shared path policy and generated Python counterpart. UI consumes catalog keys only.
const SAFE_RE = "[^A-Za-z0-9._-]+";
const DEVICE_RE = "^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)";
export function datasetPathKey(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "_unassigned";
  if (raw.includes("..") || /[/\\:]/.test(raw) || ["_unassigned", "_shared"].includes(raw.toLowerCase())) throw new Error("数据集名称不安全或使用了保留分区：" + raw);
  const key = raw.replace(new RegExp(SAFE_RE, "g"), "_").replace(/^\.+|\.+$/g, "").slice(0, 80);
  if (!key || new RegExp(DEVICE_RE, "i").test(key)) throw new Error("数据集名称不能映射到安全目录：" + raw);
  return key;
}
export function datasetPartitions(values: unknown[]): { dataset: string; datasetKey: string }[] {
  const keys = new Map<string, string>();
  for (const value of values) {
    const dataset = String(value ?? "").trim();
    const key = datasetPathKey(dataset);
    const previous = keys.get(key.toLowerCase());
    if (previous !== undefined && previous !== dataset) throw new Error("不同数据集映射到同一目录：" + previous + "、" + dataset);
    keys.set(key.toLowerCase(), dataset);
  }
  return [...keys.values()].map(dataset => ({ dataset, datasetKey: datasetPathKey(dataset) }));
}
export function planDirectoryKey(planFile: string): string {
  const normalized = process.platform === "darwin" ? normalizePosixRelativePath(planFile, "结果 Plan 路径")
    : path.posix.normalize(String(planFile || "").trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) throw new Error("Plan 路径无效。");
  const stem = path.posix.basename(normalized, path.posix.extname(normalized)).replace(new RegExp(SAFE_RE, "g"), "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60) || "plan";
  return stem + "__" + crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}
export function tablePaths(datasetKey: string, name: string, kind: "final" | "method") {
  const base = kind === "final" ? `${datasetKey}/final/final` : `${datasetKey}/methods/${name}/${name}`;
  return { tableKey: kind === "final" ? `${datasetKey}/final` : `${datasetKey}/method/${name}`, relativePath: base + ".csv", markdownPath: base + ".md" };
}
export function workerDirectoryKey(workerId: string): string {
  const id = String(workerId || "").trim();
  if (!id) return "";
  return id.replace(new RegExp(SAFE_RE, "g"), "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60) + "__" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
}
export function planArtifactPath(datasetKey: string, planFile: string, kind: string, filename: string, workerId = "") {
  if (!["raw", "detail", "trace"].includes(kind)) throw new Error("结果产物类型无效。");
  return path.posix.join(datasetKey, "plans", planDirectoryKey(planFile), kind, ...(workerId ? [workerDirectoryKey(workerId)] : []), filename);
}
export const RESULT_LAYOUT_PYTHON = String.raw`
def dataset_path_key(value):
    raw = str(value if value is not None else "").strip()
    if not raw:
        return "_unassigned"
    if ".." in raw or any(char in raw for char in ("/", chr(92), ":")) or raw.lower() in ("_unassigned", "_shared"):
        raise ValueError("Unsafe or reserved dataset name: " + raw)
    key = re.sub(${JSON.stringify(SAFE_RE)}, "_", raw).strip(".")[:80]
    if not key or re.search(${JSON.stringify(DEVICE_RE)}, key, re.I):
        raise ValueError("Unsafe dataset directory: " + raw)
    return key

def dataset_partitions(values):
    keys = {}
    for value in values:
        dataset = str(value if value is not None else "").strip()
        key = dataset_path_key(dataset)
        if key.lower() in keys and keys[key.lower()] != dataset:
            raise ValueError("Dataset directory collision: " + keys[key.lower()] + ", " + dataset)
        keys[key.lower()] = dataset
    return [{"dataset": value, "datasetKey": dataset_path_key(value)} for value in keys.values()]

def result_plan_directory_key(plan_file):
    import posixpath
    normalized = plan_file
    if (not isinstance(normalized, str) or not normalized or len(normalized.encode("utf-8")) > 4096
            or normalized.startswith("/") or ":" in normalized or chr(92) in normalized
            or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
            or any(part in ("", ".", "..") for part in normalized.split("/"))):
        raise ValueError("Invalid Plan path")
    stem = re.sub(${JSON.stringify(SAFE_RE)}, "_", posixpath.splitext(posixpath.basename(normalized))[0]).strip("._")[:60] or "plan"
    return stem + "__" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
`;
