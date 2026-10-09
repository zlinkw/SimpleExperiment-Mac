export function mergeByStableKey<T>(
  previous: T[],
  incoming: T[],
  keyOf: (item: T) => string,
  mergeOne: (prev: T | undefined, next: T) => T,
): T[] {
  const order: string[] = [];
  const map = new Map<string, T>();
  for (const item of previous || []) {
    const key = keyOf(item);
    if (!key) continue;
    if (!map.has(key)) order.push(key);
    map.set(key, item);
  }
  for (const item of incoming || []) {
    const key = keyOf(item);
    if (!key) continue;
    if (!map.has(key)) order.push(key);
    map.set(key, mergeOne(map.get(key), item));
  }
  return order.map((key) => map.get(key)).filter((item): item is T => Boolean(item));
}

export const runStatusRank: Record<string, number> = {
  unknown: 0,
  queued: 1,
  pending: 1,
  scheduling: 2,
  running: 3,
  testing: 4,
  completed: 5,
  failed: 6,
  stopped: 6,
};

export const archiveStatusRank: Record<string, number> = {
  unknown: 0,
  not_archived: 1,
  archived: 2,
  delete_requested: 3,
  deleting: 4,
  delete_failed: 5,
  deleted: 6,
};

export function mergeArchiveEndpointState<T extends Record<string, any>>(prev: T | undefined, next: T): T {
  if (!prev) return next;
  const merged: Record<string, any> = { ...prev, ...next };
  for (const key of ["local_archive_state", "hub_archive_state", "worker_archive_state", "artifact_state"]) {
    const prevValue = String(prev[key] || "unknown");
    const nextValue = String(next[key] || "unknown");
    if ((archiveStatusRank[prevValue] ?? 0) > (archiveStatusRank[nextValue] ?? 0)) merged[key] = prev[key];
  }
  if (String(prev.archive_status_text || "").includes("3") && String(next.hub_archive_state || "unknown") === "unknown") {
    merged.hub_archive_state = prev.hub_archive_state;
    merged.archive_status_text = prev.archive_status_text;
  }
  return merged as T;
}

export function experimentTraceKey(row: Record<string, any>): string {
  return String(row.archive_key || row.global_job_id || row.run_id || "") + "|" + String(row.hub_job_dir || row.worker_job_dir || row.native_job_dir || "");
}

export function mergeExperimentTracesStable<T extends Record<string, any>>(previous: T[], incoming: T[]): T[] {
  return mergeByStableKey(previous, incoming, experimentTraceKey, mergeArchiveEndpointState);
}

export function schedulerRowStatusRank(value: unknown): number {
  const text = String(value || "unknown").toLowerCase();
  if (/fail|error|失败/.test(text)) return runStatusRank.failed;
  if (/stop|中止|停止/.test(text)) return runStatusRank.stopped;
  if (/complete|done|完成/.test(text)) return runStatusRank.completed;
  if (/test|测试/.test(text)) return runStatusRank.testing;
  if (/run|训练|运行/.test(text)) return runStatusRank.running;
  if (/sched|派发/.test(text)) return runStatusRank.scheduling;
  if (/queue|pending|等待/.test(text)) return runStatusRank.queued;
  return runStatusRank.unknown;
}
