import { gpuMemoryNumbers, gpuMemoryJobLimit, memorySchedulingSettings } from "./GpuMemoryScheduling";

export const quotaDefaults = { gpuJobsPerCard: 1, gpuMinFreeMemoryGb: 22 };
export type GpuCardOverrides = Record<string, Partial<typeof quotaDefaults>>;
export type GpuQuotaSettings = typeof quotaDefaults & { gpuCardOverrides?: GpuCardOverrides; gpuMaxConcurrentCards?: number };
const present = (value: any) => value !== undefined && value !== null && value !== "";
export function cardOverrides(input: any): GpuCardOverrides {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("GPU_CARD_SETTINGS_INVALID");
  const result: GpuCardOverrides = {};
  for (const [id, row] of Object.entries(input)) {
    if (!/^(0|[1-9][0-9]*)$/.test(id) || !row || typeof row !== "object" || Array.isArray(row)) throw new Error("GPU_CARD_SETTINGS_INVALID");
    const entry: Partial<typeof quotaDefaults> = {};
    for (const key of Object.keys(quotaDefaults) as Array<keyof typeof quotaDefaults>) {
      const raw = (row as any)[key];
      if (!present(raw)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1024 || key === "gpuJobsPerCard" && !Number.isInteger(value)) throw new Error("GPU_CARD_SETTINGS_INVALID: " + id + "." + key);
      entry[key] = value;
    }
    if (Object.keys(entry).length) result[id] = entry;
  }
  if (Object.keys(result).length > 256) throw new Error("GPU_CARD_SETTINGS_INVALID: too many cards");
  return result;
}
export function cardSettings(settings: GpuQuotaSettings, id: string) {
  return { gpuJobsPerCard: settings.gpuJobsPerCard, gpuMinFreeMemoryGb: settings.gpuMinFreeMemoryGb, ...settings.gpuCardOverrides?.[id] };
}
export function quotaSettings(global: any = {}, worker: any = {}, rows: any[] = []): GpuQuotaSettings {
  // Convert an unsaved legacy override into an explicit quota for migration.
  // New values always win; legacy utilization and used-memory gates never run.
  const legacy = rows.find(row => gpuMemoryNumbers(row));
  const migrated = !worker.gpuQuotaConfigured && worker.gpuMemoryRatioEnabled === true && legacy
    ? gpuMemoryJobLimit(legacy, memorySchedulingSettings(global, worker))
    : !worker.gpuQuotaConfigured && worker.gpuMemoryRatioEnabled === false ? 1 : undefined;
  const jobs = Number(present(worker.gpuJobsPerCard) ? worker.gpuJobsPerCard : migrated ?? global.gpuJobsPerCard ?? 1);
  const free = Number(present(worker.gpuMinFreeMemoryGb) ? worker.gpuMinFreeMemoryGb : global.gpuMinFreeMemoryGb ?? 22);
  const cards = cardOverrides(worker.gpuCardOverrides);
  const cap = present(worker.gpuMaxConcurrentCards) ? Number(worker.gpuMaxConcurrentCards) : undefined;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 0 || cap > 256)) throw new Error("GPU_CARD_LIMIT_INVALID");
  return { gpuJobsPerCard: Number.isFinite(jobs) ? Math.max(1, Math.min(1024, Math.floor(jobs))) : 1,
    gpuMinFreeMemoryGb: Number.isFinite(free) ? Math.max(0, Math.min(1024, free)) : 22,
    ...(Object.keys(cards).length ? { gpuCardOverrides: cards } : {}),
    ...(cap !== undefined ? { gpuMaxConcurrentCards: cap } : {}) };
}
export function quotaOverrides(input: any) {
  const cards: any = { ...(input.gpuCardOverrides || {}) };
  for (const [key, value] of Object.entries(input)) {
    const match = /^gpuCardOverrides[.](0|[1-9][0-9]*)[.](gpuJobsPerCard|gpuMinFreeMemoryGb)$/.exec(key);
    if (match) cards[match[1]] = { ...cards[match[1]], [match[2]]: value };
  }
  const normalized = cardOverrides(cards);
  const value = quotaSettings({}, input);
  return { ...Object.fromEntries((Object.keys(quotaDefaults) as Array<keyof GpuQuotaSettings>).map(key => [key, present(input[key]) ? value[key] : undefined])),
    gpuCardOverrides: Object.keys(normalized).length ? normalized : undefined,
    gpuMaxConcurrentCards: value.gpuMaxConcurrentCards,
    gpuQuotaConfigured: input.gpuQuotaConfigured === true || Object.keys(quotaDefaults).some(key => Object.hasOwn(input, key) && input[key] !== undefined) || undefined };
}
export function quotaPlacement(rows: any[], counts: Map<string, number>, settings: GpuQuotaSettings) {
  const limits: Record<string, number> = {}, remaining = new Map<string, number>(), seen = new Set<string>();
  const active = new Set([...counts].filter(([, count]) => count > 0).map(([id]) => id));
  const cap = settings.gpuMaxConcurrentCards ?? Infinity;
  for (const row of rows) {
    const id = String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id ?? "");
    if (!id || seen.has(id)) continue;
    const policy = cardSettings(settings, id);
    seen.add(id); limits[id] = policy.gpuJobsPerCard;
    const memory = gpuMemoryNumbers(row);
    if (!memory || memory.free < policy.gpuMinFreeMemoryGb * 1024) continue;
    remaining.set(id, Math.max(0, policy.gpuJobsPerCard - Math.max(0, counts.get(id) || 0)));
  }
  // Count distinct live cards, never jobs. Retain their slots first; only open
  // another currently eligible card when the server-wide ceiling permits it.
  const admitted = new Set(active);
  for (const id of seen) {
    if (!remaining.get(id)) continue;
    if (active.size > cap || !admitted.has(id) && admitted.size >= cap) remaining.delete(id);
    else admitted.add(id);
  }
  // Spread the first round across physical cards, then fill their quotas.
  const ordered: string[] = [];
  for (let round = 0; round < Math.max(0, ...Object.values(limits)); round++) for (const id of seen)
    if ((remaining.get(id) || 0) > round) ordered.push(id);
  const weights = Object.values(limits).sort((a, b) => b - a).slice(0, Number.isFinite(cap) ? cap : undefined);
  return { slots: ordered, limits, weight: weights.reduce((sum, value) => sum + value, 0) };
}
export function quotaPreview(global: any, workers: any[], gpu: any) {
  return { global: quotaSettings(global), workers: Object.fromEntries(workers.map(worker => {
    const rows = gpu?.[worker.id]?.status === "ok" && Array.isArray(gpu[worker.id].gpus) ? gpu[worker.id].gpus : [];
    const settings = quotaSettings(global, worker, rows);
    return [worker.id, { ...settings, cards: rows.map((row: any) => ({ gpuId: String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id),
      jobs: cardSettings(settings, String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id)).gpuJobsPerCard,
      minimumFreeGb: cardSettings(settings, String(row.index ?? row.gpu_id ?? row.gpuId ?? row.id)).gpuMinFreeMemoryGb,
      freeGb: gpuMemoryNumbers(row) ? gpuMemoryNumbers(row)!.free / 1024 : undefined })) }];
  })) };
}
