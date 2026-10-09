const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("agent telemetry APIs cache snapshots while task reads check persisted exit codes", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import importlib.util, json, types

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = "/project"
agent.AGENT_STATE_DIR = "/state"
gpu_path = agent.path_for(root, "gpu_snapshot.json")
tasks_path = agent.path_for(root, "worker_task_snapshot.json")
availability_path = agent.availability_cache_path(root)
payloads = {
    gpu_path: {"gpu": [{"index": 0}]},
    tasks_path: {"tasks": [{"id": "task-1"}]},
    availability_path: {"workers": {"worker-a": {"available": True}}},
}
versions = {gpu_path: 1, tasks_path: 1, availability_path: 1}
reads = {"count": 0}
def counted(path, fallback):
    reads["count"] += 1
    return payloads.get(path, fallback)
def fake_stat(path):
    version = versions[path]
    return types.SimpleNamespace(st_dev=1, st_ino=1, st_size=version, st_mtime=version, st_mtime_ns=version)
agent.read_json = counted
agent.os.stat = fake_stat

gpu_first = agent.api_worker_gpu(root)
gpu_second = agent.api_worker_gpu(root)
tasks_first = agent.api_worker_tasks(root)
tasks_second = agent.api_worker_tasks(root)
availability_first = agent.read_availability_cache(root, True)
availability_second = agent.read_availability_cache(root, True)
cached_reads = reads["count"]

payloads[gpu_path] = {"gpu": [{"index": 0}, {"index": 1}]}
versions[gpu_path] = 2
gpu_changed = agent.api_worker_gpu(root)
invalidated_reads = reads["count"]

agent.read_availability_cache(root)
agent.read_availability_cache(root)
write_path_reads = reads["count"] - invalidated_reads

print(json.dumps({
    "cachedReads": cached_reads,
    "invalidatedReads": invalidated_reads,
    "writePathReads": write_path_reads,
    "gpuReused": gpu_first is gpu_second,
    "tasksEquivalent": tasks_first["tasks"] == tasks_second["tasks"],
    "availabilityReused": availability_first is availability_second,
    "gpuCount": len(gpu_changed["gpu"]),
}))
`;

  const scriptPath = path.join(os.tmpdir(), `agent-runtime-json-cache-${process.pid}.py`);
  fs.writeFileSync(scriptPath, script, "utf8");
  let run;
  try {
    run = spawnSync("python", [scriptPath], { encoding: "utf8", timeout: 10000, windowsHide: true });
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.cachedReads, 7);
  assert.equal(result.invalidatedReads, 8);
  assert.equal(result.writePathReads, 2);
  assert.equal(result.gpuReused, true);
  assert.equal(result.tasksEquivalent, true);
  assert.equal(result.availabilityReused, true);
  assert.equal(result.gpuCount, 2);
});

test("hub telemetry routes use cached read-only runtime snapshots", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /read_availability_cache\(root, True\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "gpu_snapshot\.json"\), \{\}\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "cluster_snapshot\.json"\), \{\}\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "experiment_traces_snapshot\.json"\), \{\}\)/);
});
