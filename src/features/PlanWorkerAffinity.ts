type RecordMap = Record<string, any>;

function planKey(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function resolvePlanWorkerAffinity(
  planFile: string,
  enabledWorkerIds: string[],
  summary: RecordMap,
  registry: RecordMap,
  operations: RecordMap,
  requestedWorkerId = "",
): string | undefined {
  const workers = new Map(enabledWorkerIds.map((id) => [id.toLowerCase(), id]));
  const available = new Set((Array.isArray(summary?.availableWorkerIds) ? summary.availableWorkerIds : []).map((id: unknown) => String(id).toLowerCase()));
  const missing = enabledWorkerIds.filter((id) => !available.has(id.toLowerCase()));
  if (missing.length) throw new Error(`重跑 Plan 前无法检查全部 Worker 的历史结果：${missing.join("、")}。请恢复对应 Agent 后重试。`);
  if (requestedWorkerId) {
    const requested = workers.get(requestedWorkerId.toLowerCase());
    if (!requested) throw new Error(`指定的 Worker ${requestedWorkerId} 未启用。`);
    return requested;
  }

  const owners = new Set<string>();
  const add = (id: unknown) => { const value = String(id || "").trim(); if (value) owners.add(value.toLowerCase()); };
  for (const row of Array.isArray(summary?.results) ? summary.results : []) add(row?.workerId || row?.resultOwnerWorkerId);
  for (const row of Array.isArray(summary?.workerSummaries) ? summary.workerSummaries : []) {
    if (Number(row?.resultCount || 0) > 0) add(row.workerId);
  }
  const plan = planKey(planFile);
  const historic = Object.entries(registry?.plans || {}).find(([key]) => planKey(key) === plan)?.[1] as RecordMap | undefined;
  for (const row of Array.isArray(historic?.records) ? historic.records : []) add(row?.workerId);
  for (const row of Object.values(operations || {})) {
    if (!row || typeof row !== "object") continue;
    const operation = row as RecordMap;
    if (planKey(operation.planFile || operation.selectedPlanId) !== plan) continue;
    if (!/^(run-plan|reproduce-plan)$/.test(String(operation.type || operation.action || ""))) continue;
    if (!/^(completed|interrupted|cancelled|running|started|waiting)$/.test(String(operation.status || "").toLowerCase())) continue;
    add(operation.schedulerOwnerWorkerId || operation.resultOwnerWorkerId || operation.workerId);
  }
  if (owners.size > 1) return undefined;
  const owner = [...owners][0];
  if (!owner) return undefined;
  return workers.get(owner);
}
