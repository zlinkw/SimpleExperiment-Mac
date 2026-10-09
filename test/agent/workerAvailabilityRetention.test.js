const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("worker availability entries remain available and stay bounded", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-availability-"));
  const script = String.raw`
import importlib.util, json, os, time

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = ${JSON.stringify(root.replace(/\\/g, "/"))}
now = time.time()
def stamp(offset):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - offset))

seed = {
    "schemaVersion": agent.SCHEMA_VERSION,
    "generatedAt": stamp(0),
    "workers": {
        "worker-fresh": {"workerId": "worker-fresh", "available": True, "updatedAt": stamp(30), "ttlSeconds": 180},
        "worker-retired": {"workerId": "worker-retired", "available": True, "updatedAt": stamp(7200), "ttlSeconds": 180},
        "worker-borderline": {"workerId": "worker-borderline", "available": False, "updatedAt": stamp(500), "ttlSeconds": 180},
        "worker-no-stamp": {"workerId": "worker-no-stamp", "available": True},
    },
}
agent.atomic_write(agent.availability_cache_path(root), seed)

result = agent.write_availability_batch(root, {
    "source": "local_aggregator",
    "ttlSeconds": 180,
    "workers": [{"workerId": "worker-a", "available": True, "availableGpuIds": ["0"]}],
})
after = agent.read_availability_cache(root)
kept = sorted(after.get("workers", {}).keys())

# A worker reported in this batch survives even if its own timestamp looks expired.
agent.write_availability_batch(root, {
    "source": "local_aggregator",
    "ttlSeconds": 180,
    "workers": [{"workerId": "worker-retired", "available": True, "updatedAt": stamp(7200)}],
})
revived = sorted(agent.read_availability_cache(root).get("workers", {}).keys())

overflow = {"schemaVersion": agent.SCHEMA_VERSION, "generatedAt": stamp(0), "workers": {}}
for index in range(agent.MAX_WORKER_AVAILABILITY_RECORDS + 40):
    key = "worker-bulk-%03d" % index
    overflow["workers"][key] = {"workerId": key, "available": True, "updatedAt": stamp(index), "ttlSeconds": 86400}
agent.atomic_write(agent.availability_cache_path(root), overflow)
agent.write_availability_batch(root, {"source": "local_aggregator", "ttlSeconds": 86400, "workers": [{"workerId": "worker-new", "available": True}]})
bounded = agent.read_availability_cache(root).get("workers", {})

print(json.dumps({
    "kept": kept,
    "revived": revived,
    "updated": result.get("updated"),
    "boundedCount": len(bounded),
    "maxRecords": agent.MAX_WORKER_AVAILABILITY_RECORDS,
    "newestSurvives": "worker-new" in bounded,
    "oldestDropped": "worker-bulk-103" not in bounded,
}))
`;

  try {
    const run = spawnSync("python", ["-c", script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.deepEqual(result.kept, ["worker-a", "worker-borderline", "worker-fresh", "worker-no-stamp", "worker-retired"]);
    assert.ok(result.revived.includes("worker-retired"), "a worker reported in the batch must be kept");
    assert.equal(result.updated, 1);
    assert.ok(result.boundedCount <= result.maxRecords, `availability grew to ${result.boundedCount}`);
    assert.equal(result.newestSurvives, true);
    assert.equal(result.oldestDropped, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
