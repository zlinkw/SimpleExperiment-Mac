import type { ScopeStatus } from "./SyncScopeTree";

export type LatestMergeItem = { path: string; sourceId: string; destinationIds: string[] };

/** Plan/manual authority wins; otherwise use a unique newest Worker timestamp. */
export function planLatestWorkerMerge(statuses: Record<string, ScopeStatus>, workerIds: string[]): { items: LatestMergeItem[]; skipped: string[] } {
  const ids = [...new Set(workerIds)];
  const items: LatestMergeItem[] = [];
  const skipped: string[] = [];
  for (const [path, status] of Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b))) {
    if (path === "." || status.copies || status.state === "same" || status.detail === "当前同步范围外") continue;
    const versions = status.versions || {};
    if (status.unverified || status.state === "unknown") { skipped.push(`${path}：版本未校验`); continue; }
    const choices = ids.filter((id) => versions[id]?.sha256 && ["manual", "plan", "candidate", "same"].includes(versions[id].latest || ""));
    const priority: Record<string, number> = { manual: 0, plan: 1, candidate: 2, same: 3 };
    choices.sort((a, b) => priority[versions[a].latest!] - priority[versions[b].latest!] || a.localeCompare(b));
    const sourceId = choices[0];
    if (!sourceId) { skipped.push(`${path}：没有可靠的最新版`); continue; }
    const sourceHash = versions[sourceId].sha256.toLowerCase();
    const destinationIds = ids.filter((id) => id !== sourceId && versions[id]?.sha256?.toLowerCase() !== sourceHash);
    if (destinationIds.length) items.push({ path, sourceId, destinationIds });
  }
  return { items, skipped };
}
