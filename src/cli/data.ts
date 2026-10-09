import * as fs from "fs";
import * as path from "path";

export const EXPERIMENT_INDEX_REL = path.join("simple_cluster", "experiment_index.json");
export const PLAN_REGISTRY_REL = path.join("simple_cluster", "plans", "plan_registry.json");
export const RESULT_REGISTRY_REL = path.join("simple_cluster", "results", "result_registry.json");
export const RESULT_REGISTRY_LOCAL_REL = path.join("simple_cluster", "results", "result_registry.local.json");
export const DEFAULT_PLAN_DIR = path.join("experiments", "plans");
export const RUNS_DIR = path.join("experiments", "runs");

let projectRootOverride = "";

export function validProjectRoot(candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate.trim() || !path.isAbsolute(candidate.trim())) return "";
  const root = path.resolve(candidate.trim());
  try {
    return fs.statSync(root).isDirectory() ? root : "";
  } catch {
    return "";
  }
}

export function setProjectRoot(candidate: string): void {
  const root = validProjectRoot(candidate);
  if (!root) throw new Error("project root must be an existing absolute directory");
  projectRootOverride = root;
}

export function isExperimentProjectRoot(root: string): boolean {
  return fileExists(path.join(root, "simple_cluster"))
    || fileExists(path.join(root, DEFAULT_PLAN_DIR))
    || fileExists(path.join(root, "experiments", "simple_project.yaml"));
}

export function projectRoot(): string {
  if (projectRootOverride) return projectRootOverride;
  const explicit = process.env.SIMPLE_EXPERIMENT_PROJECT_ROOT;
  if (explicit !== undefined) {
    const root = validProjectRoot(explicit);
    if (!root) throw new Error("SIMPLE_EXPERIMENT_PROJECT_ROOT must be an existing absolute directory");
    return root;
  }
  return process.cwd();
}

export function resolveProjectPath(...parts: string[]): string {
  return path.resolve(projectRoot(), ...parts);
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readTextFile(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export function fileExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function listFilesRecursive(dir: string, matcher: (name: string) => boolean, depth = 3): string[] {
  if (!fileExists(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...listFilesRecursive(full, matcher, depth - 1));
    else if (matcher(name)) out.push(full);
  }
  return out;
}

export function readTail(file: string, maxLines = 20): string {
  if (!fileExists(file)) return "";
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

export function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export function packageMeta(): { name: string; version: string } {
  const candidates = [
    path.join(__dirname, "..", "..", "package.json"),
    path.join(__dirname, "..", "package.json"),
  ];
  for (const file of candidates) {
    if (!fileExists(file)) continue;
    const json = readJsonFile<Record<string, unknown>>(file, {});
    return { name: String(json.name || "simple-experiment"), version: String(json.version || "") };
  }
  return { name: "simple-experiment", version: "" };
}
