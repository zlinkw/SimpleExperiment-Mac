const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");

test("aggregate history points stay under the total budget", () => {
  const script = String.raw`
import importlib.util, json

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

def build(series_count, points_per_series):
    servers = {}
    for index in range(series_count):
        servers.setdefault("server-%d" % (index // 8), {})["gpu-%d" % index] = [
            {"bucketEpoch": step * 60, "gpuUtilPercent": step % 100} for step in range(points_per_series)
        ]
    return servers

over = build(32, 4320)
before = sum(len(points) for gpus in over.values() for points in gpus.values())
after = agent.enforce_gpu_history_total_budget(over)
newest_kept = over["server-0"]["gpu-0"][-1]["bucketEpoch"]
oldest_kept = over["server-0"]["gpu-0"][0]["bucketEpoch"]

under = build(4, 100)
under_total = agent.enforce_gpu_history_total_budget(under)

empty_total = agent.enforce_gpu_history_total_budget({})

tiny = build(3, 50)
tiny_total = agent.enforce_gpu_history_total_budget(tiny, 2)

print(json.dumps({
    "before": before,
    "after": after,
    "budget": agent.GPU_HISTORY_MAX_TOTAL_POINTS,
    "seriesKept": sum(len(gpus) for gpus in over.values()),
    "newestKept": newest_kept,
    "keptNewestTail": oldest_kept > 0,
    "underTotal": under_total,
    "underUnchanged": len(under["server-0"]["gpu-0"]),
    "emptyTotal": empty_total,
    "tinyTotal": tiny_total,
}))
`;
  const run = spawnSync("python", ["-c", script], { encoding: "utf8", timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());

  assert.equal(result.before, 32 * 4320);
  assert.ok(result.after <= result.budget, `kept ${result.after} points, budget is ${result.budget}`);
  assert.equal(result.seriesKept, 32, "trimming must not drop whole series");
  assert.equal(result.newestKept, (4320 - 1) * 60, "the newest sample must survive");
  assert.equal(result.keptNewestTail, true, "trimming must drop the oldest points, not the newest");
  assert.equal(result.underTotal, 400, "a series set under budget is untouched");
  assert.equal(result.underUnchanged, 100);
  assert.equal(result.emptyTotal, 0);
  assert.ok(result.tinyTotal <= 3, "each series keeps at least one point");
});

test("recorded history survives a round trip through the compact writer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-gpu-history-"));
  const script = String.raw`
import importlib.util, json, os

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(root.replace(/\\/g, "/"))}
gpu_by_server = {"worker-a": [{"index": 0, "utilizationPercent": 42, "memoryUsedMb": 1024, "memoryTotalMb": 8192}]}
first = agent.record_gpu_history(root, gpu_by_server, 1785000000)
second = agent.record_gpu_history(root, gpu_by_server, 1785000060)

path = agent.gpu_history_path(root)
text = open(path, "r", encoding="utf-8").read()
reloaded = json.loads(text)
points = reloaded["servers"]["worker-a"]["0"]

print(json.dumps({
    "pointCount": len(points),
    "utilization": points[-1]["gpuUtilPercent"],
    "memoryUsed": points[-1]["memoryUsedMb"],
    "compact": "\n  " not in text,
    "bytes": len(text),
    "updatedAt": reloaded.get("updatedAt", ""),
}))
`;
  try {
    const run = spawnSync("python", ["-c", script], { encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.pointCount, 2, "consecutive buckets must both persist");
    assert.equal(result.utilization, 42);
    assert.equal(result.memoryUsed, 1024);
    assert.equal(result.compact, true, "the history file must be written without indentation");
    assert.ok(result.bytes < 1200, `history payload was ${result.bytes} bytes`);
    assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
