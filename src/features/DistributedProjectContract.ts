import { normalizePosixRelativePath } from "../mac/PosixPath";

export type DistributedProjectContract = {
  planPrefixes: string[];
  configPath: string;
  checkpointPath: string;
  checkpointRequired: boolean;
  resultRowsPath: string;
  fourStatePath: string;
  fragmentPaths: string[];
  requiredPaths: string[];
  mergeModule: string;
};

export function normalizeDistributedProjectContract(raw: Record<string, unknown> = {}): DistributedProjectContract {
  const relative = (value: unknown, fallback: string): string => {
    if (process.platform === "darwin") {
      const raw = value === undefined || value === "" ? fallback : value;
      try { return normalizePosixRelativePath(raw, "分布式产物相对路径"); }
      catch { throw new Error(`分布式产物相对路径无效：${String(raw)}`); }
    }
    const text = String(value || fallback).replace(/\\/g, "/").trim();
    if (!text || text.startsWith("/") || text.includes(":") || text.split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(text))
      throw new Error(`分布式产物相对路径无效：${text}`);
    return text;
  };
  const list = (value: unknown): string[] => {
    if (process.platform === "darwin" && value !== undefined
      && (!Array.isArray(value) || value.some(item => typeof item !== "string")))
      throw new Error("分布式产物相对路径无效：路径列表必须包含字符串。");
    return Array.isArray(value) ? value.map(String) : [];
  };
  // An absent filter applies to every Plan; only the project's explicit prefixes restrict it.
  const planPrefixes = list(raw.planPrefixes)
    .map((value) => `${relative(value.replace(/\/+$/, ""), "")}/`);
  const configPath = relative(raw.configPath, "job_config.yaml");
  const checkpointPath = relative(raw.checkpointPath, "best_model.pth");
  if (raw.checkpointRequired !== undefined && typeof raw.checkpointRequired !== "boolean")
    throw new Error("checkpointRequired 必须是 true 或 false");
  const checkpointRequired = raw.checkpointRequired !== false;
  const resultRowsPath = relative(raw.resultRowsPath, "test_results/formal_result_rows.csv");
  const fourStatePath = relative(raw.fourStatePath, "test_results/four_state_metrics.csv");
  const fragmentPaths = [...new Set((list(raw.fragmentPaths).length
    ? list(raw.fragmentPaths) : [configPath, resultRowsPath, fourStatePath]).map((value) => relative(value, "")))];
  const requiredPaths = [...new Set([...(list(raw.requiredPaths).length ? list(raw.requiredPaths) : fragmentPaths),
    ...(checkpointRequired ? [checkpointPath] : []), ...fragmentPaths].map((value) => relative(value, "")))];
  const mergeModule = String(raw.mergeModule || "experiments.simple_adapter.distributed_results").trim();
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(mergeModule)) throw new Error("分布式汇总模块名无效");
  return { planPrefixes, configPath, checkpointPath, checkpointRequired, resultRowsPath, fourStatePath,
    fragmentPaths, requiredPaths, mergeModule };
}
