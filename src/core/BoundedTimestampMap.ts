export interface BoundedTimestampMapOptions<K> {
  limit: number;
  maxAgeMs: number;
  protectedKeys?: ReadonlySet<K>;
}

export function touchBoundedTimestampMap<K>(
  map: Map<K, number>,
  key: K,
  timestamp: number,
  options: BoundedTimestampMapOptions<K>,
): number {
  const protectedKeys = options.protectedKeys || new Set<K>();
  const limit = Math.max(1, Math.trunc(options.limit));
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || 0);
  let removed = 0;

  for (const [candidate, recordedAt] of map) {
    if (candidate === key || protectedKeys.has(candidate)) continue;
    if (timestamp - recordedAt < maxAgeMs) continue;
    map.delete(candidate);
    removed += 1;
  }

  map.delete(key);
  map.set(key, timestamp);
  for (const candidate of map.keys()) {
    if (map.size <= limit) break;
    if (candidate === key || protectedKeys.has(candidate)) continue;
    map.delete(candidate);
    removed += 1;
  }
  return removed;
}
