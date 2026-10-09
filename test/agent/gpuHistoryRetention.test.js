const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent GPU history is bucketed, bounded, recoverable, and downsampled", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-gpu-history-"));
  const script = path.join(project, "gpu-history.py");
  fs.writeFileSync(script, `
import importlib.util, json, os, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(project)}
agent.AGENT_STATE_DIR = os.path.join(root, "agent-state")
base = 1999999800

def gpu(util, used, total=1000):
    return {"index": 0, "utilizationPercent": util, "memoryUsedMb": used, "memoryTotalMb": total}

history = agent.update_gpu_history({}, {"server-a": [gpu(10, 500)]}, base)
history = agent.update_gpu_history(history, {"server-a": [gpu(55, 750)]}, base + 20)
history = agent.update_gpu_history(history, {"server-a": [gpu(80, 900)]}, base + 600)
points = history["servers"]["server-a"]["0"]

many = []
source_point_count = agent.GPU_HISTORY_MAX_POINTS_PER_SERIES + 120
for index in range(source_point_count):
    epoch = base - (source_point_count - 1 - index) * agent.GPU_HISTORY_BUCKET_SECONDS
    many.append({
        "serverId": "server-a",
        "gpuId": "0",
        "bucketEpoch": epoch,
        "timestamp": agent.gpu_history_iso(epoch),
        "gpuUtilPercent": index % 101,
        "memoryUsedMb": 500,
        "memoryTotalMb": 1000,
        "memoryUtilPercent": 50,
    })
bounded = agent.update_gpu_history({"servers": {"server-a": {"0": many}}}, {}, base)
bounded_points = bounded["servers"]["server-a"]["0"]
agent.atomic_write(agent.gpu_history_path(root), bounded)
query = agent.query_gpu_history(root, "server-a", "0", end=base, max_points=12)
filled = agent.fill_gpu_history_points([
    {"serverId": "server-a", "gpuId": "0", "bucketEpoch": base, "timestamp": agent.gpu_history_iso(base), "gpuUtilPercent": 10},
    {"serverId": "server-a", "gpuId": "0", "bucketEpoch": base + 5 * agent.GPU_HISTORY_BUCKET_SECONDS, "timestamp": agent.gpu_history_iso(base + 5 * agent.GPU_HISTORY_BUCKET_SECONDS), "gpuUtilPercent": 40},
], "server-a", "0", base, base + 5 * agent.GPU_HISTORY_BUCKET_SECONDS)
filled_sample = agent.downsample_gpu_history_points(filled, 3)
gap_query = agent.downsample_gpu_history_points([
    {"bucketEpoch": base, "gpuUtilPercent": 10},
    {"bucketEpoch": base + agent.GPU_HISTORY_BUCKET_SECONDS, "gpuUtilPercent": 20},
    {"bucketEpoch": base + agent.GPU_HISTORY_BUCKET_SECONDS * 4, "gpuUtilPercent": 30},
    {"bucketEpoch": base + agent.GPU_HISTORY_BUCKET_SECONDS * 5, "gpuUtilPercent": 40},
], 3)

series_history = {"servers": {}}
for index in range(agent.GPU_HISTORY_MAX_SERIES + 12):
    series_history["servers"]["server-" + str(index)] = {"0": [{"bucketEpoch": base - index * 60, "gpuUtilPercent": index}]}
bounded_series = agent.normalize_gpu_history(series_history)
normalized_imputed = agent.normalize_gpu_history({"servers": {"server-x": {"0": [{"bucketEpoch": base, "imputed": True}]}}})

history_path = agent.gpu_history_path(root)
with open(history_path, "w", encoding="utf-8") as handle:
    handle.write("{broken")
recovered = agent.record_gpu_history(root, {"server-b": [{"gpu_id": "3", "gpu_util": 33, "memory_used_mb": 200, "memory_total_mb": 800}]}, base)

print(json.dumps({
    "sameBucketCount": len(points),
    "sameBucketLatestUtil": points[0]["gpuUtilPercent"],
    "sameBucketMemoryUtil": points[0]["memoryUtilPercent"],
    "gapSeconds": points[1]["bucketEpoch"] - points[0]["bucketEpoch"],
    "bucketSeconds": agent.GPU_HISTORY_BUCKET_SECONDS,
    "maxPointsPerSeries": agent.GPU_HISTORY_MAX_POINTS_PER_SERIES,
    "boundedCount": len(bounded_points),
    "boundedOldest": bounded_points[0]["bucketEpoch"],
    "querySeries": len(query["series"]),
    "queryPoints": len(query["series"][0]["points"]),
    "queryRawPoints": query["series"][0]["rawPointCount"],
    "querySampledPoints": query["series"][0]["sampledPointCount"],
    "queryImputed": sum(1 for point in query["series"][0]["points"] if point.get("imputed") is True),
    "filledValues": [point.get("gpuUtilPercent") for point in filled],
    "filledDefaults": [[point.get("gpuUtilPercent"), point.get("memoryUsedMb"), point.get("memoryTotalMb"), point.get("memoryUtilPercent")] for point in filled if point.get("imputed") is True],
    "filledImputed": [point.get("imputed") for point in filled],
    "filledSampleReal": [point.get("gpuUtilPercent") for point in filled_sample if point.get("imputed") is not True],
    "queryGapMarkers": [point.get("gapBefore") for point in gap_query],
    "boundedSeries": sum(len(gpus) for gpus in bounded_series["servers"].values()),
    "normalizedStoredImputed": "imputed" in normalized_imputed["servers"]["server-x"]["0"][0],
    "recovered": recovered.get("recoveredFromCorruption") is True,
    "recoveredServers": sorted(recovered["servers"].keys()),
    "recoveredGpuIds": sorted(recovered["servers"]["server-b"].keys()),
}, ensure_ascii=False))
`, "utf8");

  const run = spawnSync(python, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.sameBucketCount, 2);
  assert.equal(result.sameBucketLatestUtil, 55);
  assert.equal(result.sameBucketMemoryUtil, 75);
  assert.equal(result.gapSeconds, 600);
  assert.equal(result.bucketSeconds, 60);
  assert.equal(result.maxPointsPerSeries, 4320);
  assert.equal(result.boundedSeries, 128);
  assert.equal(result.normalizedStoredImputed, false);
  assert.equal(result.boundedCount, 4320);
  assert.equal(result.boundedOldest, 1999999800 - 4319 * 60);
  assert.equal(result.querySeries, 1);
  assert.equal(result.queryPoints, 12);
  assert.equal(result.queryRawPoints, 4320);
  assert.equal(result.querySampledPoints, 4320);
  assert.equal(result.queryImputed, 0);
  assert.deepEqual(result.filledValues, [10, 40]);
  assert.deepEqual(result.filledDefaults, []);
  assert.deepEqual(result.filledImputed, [false, false]);
  assert.deepEqual(result.filledSampleReal, [10, 40]);
  assert.deepEqual(result.queryGapMarkers, [false, true, false]);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.recoveredServers, ["server-b"]);
  assert.deepEqual(result.recoveredGpuIds, ["3"]);
});
