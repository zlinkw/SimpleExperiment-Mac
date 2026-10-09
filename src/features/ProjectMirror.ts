import { PlanSyncLedger, latestPlanSyncEntry } from "./PlanArtifactSync";
import { SyncHolds, chosenSyncHash, isSyncHeld } from "./SyncResolution";

export type Inventory = Record<string, { sha256: string; size: number }>;
export type MirrorCopy = { sourceWorkerId: string; destinationWorkerId: string; path: string };
export type MirrorPlan = { copies: MirrorCopy[]; conflicts: Array<{ path: string; workers: string[] }>; protectedPaths: string[]; protectedDifferences: string[]; fileCount: number };

export function normalizeMirrorScopePaths(paths: string[]): string[] {
  if (!Array.isArray(paths)) throw new Error("服务器间同步范围必须是路径数组。");
  const selected = [...new Set(paths.map((raw) => String(raw || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")))];
  for (const relative of selected)
    if (!relative || relative !== "." && (relative.startsWith("/") || /^[a-z]:/i.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")))
      throw new Error(`服务器间同步路径不安全：${relative}`);
  for (const relative of selected) {
    if (relative === ".") continue;
    const parts = relative.toLowerCase().split("/");
    if (parts[0] === "tmp" || parts.some((part) => [".git", ".vscode", ".codex", ".agents", ".coding-tools", ".local-gpt", ".runtime", "clean_dir", "zlk_cluster", ".venv", "venv", "env", "node_modules", "__pycache__"].includes(part)) ||
      ["plan_sync_ledger.json", "project_mirror_state.json"].includes(parts.at(-1) || "") ||
      parts[0] === "experiments" && parts[1] === "results" && parts.at(-1)?.endsWith(".csv.lock") ||
      parts[0] === "work_dirs" && parts.at(-1) === ".tb_mean.lock")
      throw new Error(`服务器间同步路径属于机器状态：${relative}`);
  }
  return selected.includes(".") ? ["."] : selected.sort();
}

export function filterInventoryByScope<T>(inventory: Record<string, T>, paths: string[]): Record<string, T> {
  const selected = normalizeMirrorScopePaths(paths);
  if (selected.includes(".")) return inventory;
  return Object.fromEntries(Object.entries(inventory).filter(([relative]) => selected.some((scope) => relative === scope || relative.startsWith(`${scope}/`))));
}

function planOwned(path: string, ledger: PlanSyncLedger): boolean {
  const plans = new Set(Object.values(ledger.entries || {}).map((entry) => entry.planFile));
  for (const planFile of plans) {
    const entry = latestPlanSyncEntry(ledger, planFile);
    if (!entry) continue;
    if (entry.artifactPaths.some((item) => path === item || entry.directoryPaths.includes(item) && path.startsWith(`${item}/`))) return true;
    if ((entry.stalePaths || []).some((item) => path === item.path || item.directory && path.startsWith(`${item.path}/`))) return true;
  }
  return false;
}

export function planProjectMirror(inventories: Record<string, Inventory>, codeManifest: Record<string, { sha256: string }>, ledger: PlanSyncLedger, holds: SyncHolds = {}): MirrorPlan {
  const workers = Object.keys(inventories).sort();
  const code = new Set(Object.keys(codeManifest));
  const paths = new Set(workers.flatMap((id) => Object.keys(inventories[id] || {})));
  const copies: MirrorCopy[] = [];
  const conflicts: MirrorPlan["conflicts"] = [];
  const protectedPaths: string[] = [];
  const protectedDifferences: string[] = [];
  for (const path of [...paths].sort()) {
    if (isSyncHeld(path, holds)) continue;
    const chosenHash = chosenSyncHash(path, holds)?.toLowerCase();
    if (code.has(path) || planOwned(path, ledger) && !chosenHash) {
      protectedPaths.push(path);
      const hashes = workers.map((id) => inventories[id]?.[path]?.sha256?.toLowerCase() || "");
      if (new Set(hashes).size > 1 || hashes.some((hash) => !hash) || code.has(path) && hashes.some((hash) => hash !== codeManifest[path].sha256.toLowerCase()))
        protectedDifferences.push(path);
      continue;
    }
    if (chosenHash) {
      const sourceWorkerId = workers.find((id) => inventories[id]?.[path]?.sha256?.toLowerCase() === chosenHash);
      if (!sourceWorkerId) { conflicts.push({ path, workers: workers.filter((id) => Boolean(inventories[id]?.[path])) }); continue; }
      for (const destinationWorkerId of workers)
        if (inventories[destinationWorkerId]?.[path]?.sha256?.toLowerCase() !== chosenHash)
          copies.push({ sourceWorkerId, destinationWorkerId, path });
      continue;
    }
    const present = workers.filter((id) => inventories[id]?.[path]);
    const hashes = new Set(present.map((id) => inventories[id][path].sha256.toLowerCase()));
    if (hashes.size > 1) { conflicts.push({ path, workers: present }); continue; }
    if (!present.length) continue;
    const sourceWorkerId = present[0];
    for (const destinationWorkerId of workers)
      if (!inventories[destinationWorkerId]?.[path]) copies.push({ sourceWorkerId, destinationWorkerId, path });
  }
  for (const path of code) if (!paths.has(path) && !isSyncHeld(path, holds)) protectedDifferences.push(path);
  return { copies, conflicts, protectedPaths, protectedDifferences, fileCount: paths.size };
}
