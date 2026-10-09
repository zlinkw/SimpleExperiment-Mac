const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readSource } = require("../_helpers/sourceReader");

const root = path.resolve(__dirname, "..", "..");
const {
  GPU_HISTORY_CACHE_TTL_MS,
  GPU_HISTORY_MAX_SERIES,
  GPU_HISTORY_TOTAL_POINT_LIMIT,
  GpuHistoryStateCache,
  compactGpuHistoryResponse,
  normalizeGpuHistoryQuery,
} = require("../../dist/features/GpuHistoryState.js");
const { RequestBudgetDeniedError } = require("../../dist/tunnel/RequestBudget.js");

test("GPU history cache enforces a one-minute acquisition interval per query", async () => {
  let now = 1_000;
  let calls = 0;
  const response = { schemaVersion: 1, bucketSeconds: 60, retentionHours: 72, maxPointsPerSeries: 4320, updatedAt: "x", series: [] };
  const cache = new GpuHistoryStateCache(() => now);
  const fetcher = async () => { calls += 1; return response; };

  assert.equal(GPU_HISTORY_CACHE_TTL_MS, 60_000);
  await cache.load({ serverId: "worker-a", gpuId: "0" }, fetcher);
  now += 59_999;
  await cache.load({ serverId: "worker-a", gpuId: "0" }, fetcher);
  assert.equal(calls, 1);
  now += 2;
  await cache.load({ serverId: "worker-a", gpuId: "0" }, fetcher);
  assert.equal(calls, 2);
});

test("GPU history query and Webview payload stay bounded", () => {
  assert.deepEqual(normalizeGpuHistoryQuery({ maxPoints: 9999, start: 200, end: 100 }), { start: 100, end: 200, maxPoints: 96 });
  assert.deepEqual(normalizeGpuHistoryQuery({ serverId: " worker-a ", gpuId: "0", maxPoints: 9999 }), { serverId: "worker-a", gpuId: "0", maxPoints: 288 });

  const series = Array.from({ length: 200 }, (_, seriesIndex) => ({
    serverId: `server-${Math.floor(seriesIndex / 8)}`,
    gpuId: String(seriesIndex % 8),
    rawPointCount: 300,
    points: Array.from({ length: 300 }, (_, pointIndex) => ({
      serverId: "repeated",
      gpuId: "repeated",
      timestamp: new Date((2_000_000_000 + pointIndex * 300) * 1000).toISOString(),
      bucketEpoch: 2_000_000_000 + pointIndex * 300,
      gpuUtilPercent: pointIndex === 1 ? 120 : pointIndex % 101,
      memoryUsedMb: 500 + pointIndex,
      memoryTotalMb: 1000,
      memoryUtilPercent: 50,
      gapBefore: pointIndex === 6,
    })),
  }));
  const compact = compactGpuHistoryResponse({ schemaVersion: 1, bucketSeconds: 300, retentionHours: 72, maxPointsPerSeries: 864, updatedAt: "x", series });
  assert.equal(compact.series.length, GPU_HISTORY_MAX_SERIES);
  assert.ok(compact.totalPointCount <= GPU_HISTORY_TOTAL_POINT_LIMIT);
  assert.equal(compact.seriesOmittedCount, 72);
  assert.ok(compact.pointOmittedCount > 0);
  assert.equal(compact.series[0].points[0].bucketEpoch, 2_000_000_000);
  assert.equal(compact.series[0].points.at(-1).bucketEpoch, 2_000_000_000 + 299 * 300);
  assert.equal("serverId" in compact.series[0].points[0], false);
  assert.equal(compact.series[0].points.some((point) => point.gapBefore === true), true);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") < 2_000_000);
});

test("GPU history cache coalesces requests and preserves last data on failure", async () => {
  let now = 1_000;
  let calls = 0;
  let resolveRequest;
  const cache = new GpuHistoryStateCache(() => now);
  const response = {
    schemaVersion: 1,
    bucketSeconds: 300,
    retentionHours: 72,
    maxPointsPerSeries: 864,
    updatedAt: "2026-07-23T00:00:00Z",
    series: [{ serverId: "worker-a", gpuId: "0", rawPointCount: 1, points: [{ timestamp: "2026-07-23T00:00:00Z", bucketEpoch: 2_000_000_000, gpuUtilPercent: 10, memoryUsedMb: 100, memoryTotalMb: 1000, memoryUtilPercent: 10 }] }],
  };
  const fetcher = () => {
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  };
  const first = cache.load({ serverId: "worker-a", gpuId: "0" }, fetcher);
  const second = cache.load({ serverId: "worker-a", gpuId: "0" }, fetcher);
  assert.equal(calls, 1);
  assert.equal(cache.snapshot().status, "loading");
  assert.ok(cache.snapshot().pendingKey);
  resolveRequest(response);
  await Promise.all([first, second]);
  assert.equal(cache.snapshot().status, "ready");
  assert.equal(cache.snapshot().data.series[0].points.length, 1);

  now += 1_000;
  await cache.load({ serverId: "worker-a", gpuId: "0" }, () => { calls += 1; return Promise.resolve(response); });
  assert.equal(calls, 1);

  await assert.rejects(cache.load({ serverId: "missing" }, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(cache.snapshot().status, "stale");
  assert.equal(cache.snapshot().query.serverId, "worker-a");
  assert.equal(cache.snapshot().requestedQuery.serverId, "missing");
  assert.equal(cache.snapshot().data.series[0].serverId, "worker-a");
});

test("GPU history keeps successful state stable while refreshing and ignores expected budget denial", async () => {
  let resolveRefresh;
  const cache = new GpuHistoryStateCache(() => 1_000);
  const response = {
    schemaVersion: 1,
    bucketSeconds: 60,
    retentionHours: 72,
    maxPointsPerSeries: 4320,
    updatedAt: "2026-07-24T00:00:00Z",
    series: [{ serverId: "worker-a", gpuId: "0", rawPointCount: 1, points: [{ timestamp: "2026-07-24T00:00:00Z", bucketEpoch: 2_000_000_000, gpuUtilPercent: 10, memoryUsedMb: 100, memoryTotalMb: 1000, memoryUtilPercent: 10 }] }],
  };
  await cache.load({ serverId: "worker-a", gpuId: "0" }, async () => response);

  const refresh = cache.load({ serverId: "worker-b", gpuId: "1" }, () => new Promise((resolve) => { resolveRefresh = resolve; }));
  assert.equal(cache.snapshot().status, "ready");
  assert.ok(cache.snapshot().pendingKey);
  resolveRefresh(response);
  await refresh;

  const before = cache.snapshot();
  const after = await cache.load({ serverId: "worker-c", gpuId: "2" }, async () => {
    throw new RequestBudgetDeniedError("gpu_history", { allowed: false, reason: "rate_limited", retryAfterMs: 500 });
  });
  assert.equal(after.status, "ready");
  assert.equal(after.data, before.data);
  assert.equal(after.error, undefined);
});

test("GPU history reset rejects stale async success and failure state", async () => {
  let resolveOld;
  const cache = new GpuHistoryStateCache(() => 1_000);
  const response = (serverId) => ({
    schemaVersion: 1,
    bucketSeconds: 60,
    retentionHours: 72,
    maxPointsPerSeries: 4320,
    updatedAt: "2026-07-29T00:00:00Z",
    series: [{ serverId, gpuId: "0", rawPointCount: 0, points: [] }],
  });

  const oldSuccess = cache.load({ serverId: "old-worker" }, () => new Promise((resolve) => { resolveOld = resolve; }));
  cache.reset();
  await cache.load({ serverId: "new-worker" }, async () => response("new-worker"));
  resolveOld(response("old-worker"));
  await oldSuccess;
  assert.equal(cache.snapshot().status, "ready");
  assert.equal(cache.snapshot().data.series[0].serverId, "new-worker");

  let rejectOld;
  const oldFailure = cache.load({ serverId: "failed-worker" }, () => new Promise((resolve, reject) => { rejectOld = reject; }));
  cache.reset();
  rejectOld(new Error("stale failure"));
  await assert.rejects(oldFailure, /stale failure/);
  assert.deepEqual(cache.snapshot(), { status: "idle" });
});

test("Extension exposes GPU history only through explicit on-demand state", () => {
  const source = readSource("src/extension.ts");
  assert.match(source, /case "loadGpuHistory"/);
  assert.match(source, /this\.gpuHistoryState\.load\(query/);
  assert.match(source, /endpoints\.gpuHistory !== true/);
  assert.match(source, /const includePanelGpuHistory = options\.panelProjection !== true \|\| interestedSections\?\.has\("gpu"\) === true/);
  assert.match(source, /\.\.\.\(includePanelGpuHistory \? \{ gpuHistory \} : \{\}\)/);
  assert.doesNotMatch(source.match(/async manualSnapshot[\s\S]*?async manualGpuSnapshot/)?.[0] || "", /getGpuHistory/);
  assert.doesNotMatch(source.match(/private createClient[\s\S]*?private shouldPushLocalAvailabilityFromRealtime/)?.[0] || "", /getGpuHistory/);
});
