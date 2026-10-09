// Only the webview projection is bounded; runtime evidence and persisted history stay intact.
const cache = new WeakMap<object, Record<string, unknown>>();
const identityKeys = new Set(["operationId", "opId", "id", "type", "action", "status", "state", "planFile", "planRevision", "workerId", "schedulerOwnerWorkerId", "resultOwnerWorkerId", "runKey", "runId", "experimentId", "archiveKey", "tmuxSession", "tmuxTarget", "tmuxPane", "pid", "startedAt", "updatedAt", "finishedAt", "localSubmissionProgress", "reconcileEvidenceActive"]);

export function compactOperationsForWebview(input: Record<string, unknown>): Record<string, unknown> {
  if (cache.has(input)) return cache.get(input)!;
  const output: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { output[id] = value; continue; }
    let characters = 8192;
    let nodes = 128;
    let omitted = false;
    const seen = new WeakSet<object>();
    const compact = (item: unknown, depth: number): unknown => {
      if (--nodes < 0) { omitted = true; return undefined; }
      if (typeof item === "string") {
        const limit = Math.max(0, Math.min(depth === 0 ? 4096 : 1024, characters));
        characters -= Math.min(item.length, limit);
        if (item.length > limit) { omitted = true; return limit ? item.slice(-limit) : ""; }
        return item;
      }
      if (!item || typeof item !== "object") return item;
      if (depth >= 4 || seen.has(item)) { omitted = true; return undefined; }
      seen.add(item);
      if (Array.isArray(item)) {
        if (item.length > 4) omitted = true;
        return item.slice(-4).map((row) => compact(row, depth + 1)).filter((row) => row !== undefined);
      }
      const result: Record<string, unknown> = {};
      const entries = Object.entries(item).sort(([a], [b]) => Number(identityKeys.has(b)) - Number(identityKeys.has(a)));
      if (entries.length > 24) omitted = true;
      for (const [key, row] of entries.slice(0, 24)) {
        const next = compact(row, depth + 1);
        if (next !== undefined) result[key] = next;
      }
      return result;
    };
    const row: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = identityKeys.has(key) && (item === null || typeof item !== "object") ? item : compact(item, 0);
      if (next !== undefined) row[key] = next;
    }
    if (omitted) row.webviewDetailsOmitted = true;
    output[id] = row;
  }
  cache.set(input, output);
  return output;
}
