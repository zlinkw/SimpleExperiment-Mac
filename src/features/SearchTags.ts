export interface ExperimentTag {
  experimentId: string;
  tag: string;
  color?: string;
  createdAt: string;
}

export interface ExperimentSearchQuery {
  suite?: string;
  dataset?: string;
  status?: string;
  worker?: string;
  tag?: string;
  metricRange?: { metric: string; min?: number; max?: number };
  includeDeleted?: boolean;
}

export function upsertTag(tags: ExperimentTag[], tag: ExperimentTag): ExperimentTag[] {
  return [...tags.filter((item) => !(item.experimentId === tag.experimentId && item.tag === tag.tag)), tag];
}

export function searchExperiments(rows: any[], query: ExperimentSearchQuery, tags: ExperimentTag[] = []): any[] {
  const tagged = new Map<string, Set<string>>();
  for (const tag of tags) {
    const set = tagged.get(tag.experimentId) || new Set<string>();
    set.add(tag.tag);
    tagged.set(tag.experimentId, set);
  }
  return rows.filter((row) => {
    const id = String(row.experimentId || row.runKey || row.run_id || "");
    if (!query.includeDeleted && ["deleted", "deleting"].includes(String(row.status || row.archive_state || ""))) return false;
    if (query.suite && row.suite !== query.suite) return false;
    if (query.dataset && row.dataset !== query.dataset) return false;
    if (query.status && row.status !== query.status) return false;
    if (query.worker && row.workerId !== query.worker && row.worker_id !== query.worker) return false;
    if (query.tag && !tagged.get(id)?.has(query.tag)) return false;
    if (query.metricRange) {
      const value = Number(row.metrics?.[query.metricRange.metric] ?? row[query.metricRange.metric]);
      if (!Number.isFinite(value)) return false;
      if (query.metricRange.min !== undefined && value < query.metricRange.min) return false;
      if (query.metricRange.max !== undefined && value > query.metricRange.max) return false;
    }
    return true;
  });
}

