/** Small ID fences survive reconnects; discarded progress payloads do not. */
export function withoutRetiredOperations(records: Record<string, any>, retired: ReadonlySet<string>): Record<string, any> {
  return Object.fromEntries(Object.entries(records || {}).filter(([key, row]) =>
    ![key, row?.operationId, row?.opId, row?.id].some(id => typeof id === "string" && retired.has(id))));
}

export function endedPlanOperationIds(records: Record<string, any>, planFile: string, exclude: ReadonlySet<string> = new Set()): string[] {
  const normalize = (value: any) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "succeeded", "stopped"]);
  return Object.entries(records || {}).flatMap(([key, row]) => {
    const id = String(row?.operationId || row?.opId || row?.id || key);
    const payload = row?.payload || row?.latestEvent?.payload || {};
    if (exclude.has(id) || !terminal.has(String(row?.status || row?.state || "").toLowerCase())
      || normalize(row?.planFile || payload.planFile) !== normalize(planFile)) return [];
    return [id];
  });
}
