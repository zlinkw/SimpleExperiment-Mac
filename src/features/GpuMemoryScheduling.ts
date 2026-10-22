/** Placement arithmetic only. Current GPU telemetry and live task windows remain authoritative. */
export const memorySchedulingDefaults = { gpuMemoryRatioEnabled: true, gpuMemoryPerJobGb: 24,
  gpuMemoryMaxJobsPerGpu: 0, gpuMemoryReserveGb: 0, gpuMemoryTolerancePercent: 3 };
export type MemorySchedulingSettings = typeof memorySchedulingDefaults;
const finite = (value: unknown) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
export function memorySchedulingSettings(global: any = {}, worker: any = {}): MemorySchedulingSettings {
  const result: any = {};
  for (const [key, fallback] of Object.entries(memorySchedulingDefaults)) {
    const value = worker[key] ?? global[key] ?? fallback;
    result[key] = typeof fallback === "boolean" ? value === true || value === "true" : finite(value) ? Number(value) : fallback;
  }
  result.gpuMemoryPerJobGb = Math.max(1, Math.min(1024, result.gpuMemoryPerJobGb));
  result.gpuMemoryMaxJobsPerGpu = Math.max(0, Math.min(1024, Math.floor(result.gpuMemoryMaxJobsPerGpu)));
  result.gpuMemoryReserveGb = Math.max(0, Math.min(1024, result.gpuMemoryReserveGb));
  result.gpuMemoryTolerancePercent = Math.max(0, Math.min(5, result.gpuMemoryTolerancePercent));
  return result;
}
export function memorySchedulingOverrides(input: any): Partial<MemorySchedulingSettings> {
  const normalized: any = memorySchedulingSettings({}, input), result: any = {};
  for (const key of Object.keys(memorySchedulingDefaults)) result[key] = input[key] === undefined || input[key] === "" || input[key] === null ? undefined : normalized[key];
  return result;
}
export function gpuMemoryNumbers(row: any) {
  const total = row.memoryTotalMb ?? row.memory_total_mb ?? row.memoryTotal ?? row.memory_total;
  const used = row.memoryUsedMb ?? row.memory_used_mb ?? row.memoryUsed ?? row.memory_used;
  return finite(total) && finite(used) && Number(total) > 0 && Number(used) >= 0 && Number(used) <= Number(total)
    ? { total: Number(total), free: Number(total) - Number(used) } : undefined;
}
export function gpuMemoryJobLimit(row: any, settings: MemorySchedulingSettings): number {
  const memory = gpuMemoryNumbers(row);
  if (!settings.gpuMemoryRatioEnabled || !memory) return 1;
  const exact = memory.total / (settings.gpuMemoryPerJobGb * 1024), upper = Math.ceil(exact);
  const ratio = Math.max(1, exact >= upper * (1 - settings.gpuMemoryTolerancePercent / 100) ? upper : Math.floor(exact));
  return settings.gpuMemoryMaxJobsPerGpu > 0 ? Math.min(ratio, settings.gpuMemoryMaxJobsPerGpu) : ratio;
}

/** Read-only settings preview; reuse admission arithmetic, never reserve or start tasks. */
export function gpuMemorySchedulingPreview(global: any, workers: any[], gpu: any) {
  const previewJobs = (row: any, settings: MemorySchedulingSettings) =>
    gpuMemoryPlacement([{ ...row, index: 0, memoryUsedMb: 0 }], new Map(), ["0"], settings).slots.length;
  const describe = (settings: MemorySchedulingSettings, rows: any[]) => ({
    perJobGb: settings.gpuMemoryPerJobGb, enabled: settings.gpuMemoryRatioEnabled,
    customLimits: settings.gpuMemoryMaxJobsPerGpu > 0 || settings.gpuMemoryReserveGb > 0 || settings.gpuMemoryTolerancePercent !== 3,
    cards: rows.filter(row => gpuMemoryNumbers(row)).map(row => ({
      gpuId: String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id ?? ""), jobs: previewJobs(row, settings),
    })),
  });
  const settings = memorySchedulingSettings(global);
  return {
    global: { ...describe(settings, []), examples: [24, 48, 80, 96].map(gb => ({ gb,
      jobs: previewJobs({ memoryTotalMb: gb * 1024, memoryUsedMb: 0 }, settings) })) },
    workers: Object.fromEntries(workers.map(worker => [worker.id, describe(memorySchedulingSettings(global, worker),
      gpu?.[worker.id]?.status === "ok" && Array.isArray(gpu[worker.id].gpus) ? gpu[worker.id].gpus : [])])),
  };
}

export function gpuMemoryPlacement(rows: any[], counts: Map<string, number>, idleIds: string[],
  settings: MemorySchedulingSettings, maxCards = 0): { slots: string[]; weight: number; limits: Record<string, number> } {
  const candidates = rows.map(row => ({ row, id: String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id ?? "") }))
    .filter(({ id }) => id && (idleIds.includes(id) || (counts.get(id) || 0) > 0));
  // maxConcurrentGpus continues to count physical cards, not jobs sharing a card.
  candidates.sort((a, b) => Number((counts.get(b.id) || 0) > 0) - Number((counts.get(a.id) || 0) > 0));
  const allowed = maxCards > 0 ? candidates.slice(0, maxCards) : candidates;
  const unique = [...new Map(allowed.map(item => [item.id, item])).values()];
  const limits: Record<string, number> = {}, available = new Map<string, number>();
  let weight = 0;
  for (const { row, id } of unique) {
    const count = counts.get(id) || 0, cap = gpuMemoryJobLimit(row, settings), memory = gpuMemoryNumbers(row);
    limits[id] = cap; weight += cap;
    let slots = Math.max(0, cap - count);
    if (!settings.gpuMemoryRatioEnabled || !memory) slots = idleIds.includes(id) && !count ? 1 : 0;
    else {
      const unit = Math.min(settings.gpuMemoryPerJobGb * 1024, memory.total) * (1 - settings.gpuMemoryTolerancePercent / 100);
      const reserve = settings.gpuMemoryReserveGb * 1024;
      // A newly admitted task may not have allocated VRAM yet. Keep its share
      // across polls as well as checking the currently reported free memory.
      slots = Math.min(slots, Math.max(0, Math.floor((memory.free - reserve) / unit)),
        Math.max(0, Math.floor((memory.total - reserve) / unit) - count));
    }
    available.set(id, slots);
  }
  const slots: string[] = [];
  while ([...available.values()].some(count => count > 0)) for (const [id, count] of available) if (count > 0) {
    slots.push(id); available.set(id, count - 1);
  }
  return { slots, weight, limits };
}
