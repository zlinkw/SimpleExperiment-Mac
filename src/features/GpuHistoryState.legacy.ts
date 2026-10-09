import { RequestBudgetDeniedError } from "../tunnel/RequestBudget";
import { GpuHistoryQuery, GpuHistoryResponse } from "../tunnel/TunnelClient";

export const GPU_HISTORY_CACHE_LIMIT = 8;
export const GPU_HISTORY_CACHE_TTL_MS = 60_000;
export const GPU_HISTORY_MAX_SERIES = 128;
export const GPU_HISTORY_MAX_POINTS_PER_SERIES = 288;
export const GPU_HISTORY_OVERVIEW_POINTS_PER_SERIES = 96;
export const GPU_HISTORY_TOTAL_POINT_LIMIT = 8_000;

export interface GpuHistoryWebviewPoint {
  timestamp: string;
  bucketEpoch: number;
  gpuUtilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  memoryUtilPercent: number | null;
  gapBefore: boolean | null;
  imputed: boolean;
}

export interface GpuHistoryWebviewSeries {
  serverId: string;
  gpuId: string;
  rawPointCount: number;
  points: GpuHistoryWebviewPoint[];
}

export interface GpuHistoryWebviewData {
  schemaVersion: 1;
  bucketSeconds: number;
  retentionHours: number;
  updatedAt: string;
  series: GpuHistoryWebviewSeries[];
  seriesOmittedCount: number;
  pointOmittedCount: number;
  totalPointCount: number;
}

export interface GpuHistoryViewState {
  status: "idle" | "loading" | "ready" | "stale" | "error";
  query?: GpuHistoryQuery;
  requestedQuery?: GpuHistoryQuery;
  pendingKey?: string;
  data?: GpuHistoryWebviewData;
  fetchedAt?: string;
  error?: string;
}

type CacheEntry = {
  query: GpuHistoryQuery;
  data: GpuHistoryWebviewData;
  fetchedAt: number;
};

export class GpuHistoryStateCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<GpuHistoryWebviewData>>();
  private view: GpuHistoryViewState = { status: "idle" };
  private epoch = 0;
  private requestSequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): GpuHistoryViewState {
    return this.view;
  }

  reset(): void {
    this.epoch += 1;
    this.requestSequence += 1;
    this.entries.clear();
    this.pending.clear();
    this.view = { status: "idle" };
  }

  async load(
    input: GpuHistoryQuery,
    fetcher: (query: GpuHistoryQuery) => Promise<GpuHistoryResponse>,
    options: { force?: boolean } = {},
  ): Promise<GpuHistoryViewState> {
    const query = normalizeGpuHistoryQuery(input);
    const key = gpuHistoryQueryKey(query);
    const epoch = this.epoch;
    const sequence = ++this.requestSequence;
    const cached = this.entries.get(key);
    if (!options.force && cached && this.now() - cached.fetchedAt <= GPU_HISTORY_CACHE_TTL_MS) {
      this.touchEntry(key, cached);
      this.view = readyView(cached);
      return this.view;
    }

    const previous = this.view;
    this.view = previous.data ? {
      ...previous,
      requestedQuery: query,
      pendingKey: key,
      error: undefined,
    } : {
      ...previous,
      status: "loading",
      requestedQuery: query,
      pendingKey: key,
      error: undefined,
    };

    let request = this.pending.get(key);
    if (!request) {
      request = fetcher(query).then(compactGpuHistoryResponse);
      this.pending.set(key, request);
      void request.finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      }).catch(() => undefined);
    }

    try {
      const data = await request;
      if (epoch !== this.epoch) return this.view;
      const entry = { query, data, fetchedAt: this.now() };
      this.touchEntry(key, entry);
      if (sequence === this.requestSequence) this.view = readyView(entry);
      return this.view;
    } catch (error) {
      if (epoch === this.epoch && sequence === this.requestSequence) {
        if (previous.data && isExpectedBudgetDenial(error)) {
          this.view = { ...previous, requestedQuery: query, pendingKey: undefined, error: undefined };
          return this.view;
        }
        this.view = { ...previous, status: previous.data ? "stale" : "error", requestedQuery: query, pendingKey: undefined, error: boundedError(error) };
      }
      throw error;
    }
  }

  private touchEntry(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > GPU_HISTORY_CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}

function isExpectedBudgetDenial(error: unknown): boolean {
  return error instanceof RequestBudgetDeniedError
    && (error.decision.reason === "cooldown" || error.decision.reason === "rate_limited");
}

export function normalizeGpuHistoryQuery(input: GpuHistoryQuery = {}): GpuHistoryQuery {
  const serverId = boundedText(input.serverId, 120);
  const gpuId = boundedText(input.gpuId, 120);
  const detailed = Boolean(serverId || gpuId);
  const defaultMax = detailed ? GPU_HISTORY_MAX_POINTS_PER_SERIES : GPU_HISTORY_OVERVIEW_POINTS_PER_SERIES;
  const requested = finiteInteger(input.maxPoints);
  const maxPoints = Math.max(1, Math.min(defaultMax, requested ?? defaultMax));
  let start = normalizedTime(input.start);
  let end = normalizedTime(input.end);
  if (typeof start === "number" && typeof end === "number" && start > end) [start, end] = [end, start];
  return dropUndefined({ serverId: serverId || undefined, gpuId: gpuId || undefined, start, end, maxPoints });
}

export function gpuHistoryQueryKey(query: GpuHistoryQuery): string {
  const normalized = normalizeGpuHistoryQuery(query);
  return JSON.stringify([normalized.serverId || "", normalized.gpuId || "", normalized.start ?? "", normalized.end ?? "", normalized.maxPoints]);
}

export function compactGpuHistoryResponse(value: GpuHistoryResponse): GpuHistoryWebviewData {
  const source = record(value);
  const rawSeries = Array.isArray(source.series) ? source.series : [];
  const limitedSeries = rawSeries.slice(0, GPU_HISTORY_MAX_SERIES).map(compactSeries).filter((item): item is GpuHistoryWebviewSeries => Boolean(item));
  const initialPointCount = limitedSeries.reduce((sum, item) => sum + item.points.length, 0);
  let series = limitedSeries;
  if (initialPointCount > GPU_HISTORY_TOTAL_POINT_LIMIT && series.length) {
    const perSeries = Math.max(2, Math.floor(GPU_HISTORY_TOTAL_POINT_LIMIT / series.length));
    series = series.map((item) => ({ ...item, points: evenlySampleHistoryPoints(item.points, perSeries) }));
  }
  const totalPointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  const rawPointTotal = series.reduce((sum, item) => sum + item.rawPointCount, 0);
  return {
    schemaVersion: 1,
    bucketSeconds: boundedNumber(source.bucketSeconds, 1, 86_400, 60),
    retentionHours: boundedNumber(source.retentionHours, 1, 24 * 31, 72),
    updatedAt: boundedText(source.updatedAt, 64),
    series,
    seriesOmittedCount: Math.max(0, rawSeries.length - limitedSeries.length),
    pointOmittedCount: Math.max(0, rawPointTotal - totalPointCount),
    totalPointCount,
  };
}

function compactSeries(value: unknown): GpuHistoryWebviewSeries | undefined {
  const item = record(value);
  const serverId = boundedText(item.serverId, 120);
  const gpuId = boundedText(item.gpuId, 120);
  if (!serverId || !gpuId) return undefined;
  const rawPoints = Array.isArray(item.points) ? item.points : [];
  const byBucket = new Map<number, GpuHistoryWebviewPoint>();
  for (const raw of rawPoints) {
    const point = compactPoint(raw);
    if (point) byBucket.set(point.bucketEpoch, point);
  }
  const points = evenlySampleHistoryPoints([...byBucket.values()].sort((a, b) => a.bucketEpoch - b.bucketEpoch), GPU_HISTORY_MAX_POINTS_PER_SERIES);
  return {
    serverId,
    gpuId,
    rawPointCount: Math.max(points.length, finiteInteger(item.rawPointCount) ?? rawPoints.length),
    points,
  };
}

function compactPoint(value: unknown): GpuHistoryWebviewPoint | undefined {
  const item = record(value);
  const bucketEpoch = finiteNumber(item.bucketEpoch);
  if (bucketEpoch === undefined || bucketEpoch < 0) return undefined;
  const timestamp = boundedText(item.timestamp, 64) || new Date(bucketEpoch * 1000).toISOString();
  return {
    timestamp,
    bucketEpoch: Math.trunc(bucketEpoch),
    gpuUtilPercent: nullablePercent(item.gpuUtilPercent),
    memoryUsedMb: nullableNonNegative(item.memoryUsedMb),
    memoryTotalMb: nullableNonNegative(item.memoryTotalMb),
    memoryUtilPercent: nullablePercent(item.memoryUtilPercent),
    gapBefore: typeof item.gapBefore === "boolean" ? item.gapBefore : null,
    imputed: item.imputed === true,
  };
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit <= 1) return [items[items.length - 1]];
  const out: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(index * (items.length - 1) / (limit - 1));
    if (out[out.length - 1] !== items[sourceIndex]) out.push(items[sourceIndex]);
  }
  return out;
}

function evenlySampleHistoryPoints(items: GpuHistoryWebviewPoint[], limit: number): GpuHistoryWebviewPoint[] {
  if (items.length <= limit) return items;
  const critical = items
    .map((point, index) => ({ point, index }))
    .filter(({ point, index }) => point.gapBefore === true || (index > 0 && point.imputed !== items[index - 1].imputed))
    .map(({ index }) => index);
  if (critical.length >= limit) return evenlySample(critical, limit).map((index) => items[index]);
  const selected = new Set(critical);
  const real = items.map((point, index) => ({ point, index })).filter(({ point }) => point.imputed === false).map(({ index }) => index);
  if (real.length <= limit - selected.size) real.forEach((index) => selected.add(index));
  const sampled = evenlySample(items.map((_, index) => index), limit);
  for (const index of [0, items.length - 1, ...sampled]) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map((index) => items[index]);
}

function readyView(entry: CacheEntry): GpuHistoryViewState {
  return {
    status: "ready",
    query: entry.query,
    requestedQuery: entry.query,
    data: entry.data,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
  };
}

function normalizedTime(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = boundedText(value, 64);
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function nullablePercent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === undefined ? null : Math.max(0, Math.min(100, number));
}

function nullableNonNegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === undefined ? null : Math.max(0, number);
}

function finiteInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = finiteNumber(value);
  return number === undefined ? fallback : Math.max(min, Math.min(max, number));
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "GPU history query failed")).slice(0, 480);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
