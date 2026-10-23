const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");
const toRuntimePath = value => process.platform === "win32"
  ? value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => "/mnt/" + drive.toLowerCase()) : value;

test("agent telemetry APIs cache snapshots while task reads check persisted exit codes", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import json, os, sys, tempfile, time, types

# The shared collector frame replaced the gpu_snapshot.json read path, so the
# state root is pointed at a real per-run directory BEFORE the module loads and
# the frame is written by the PRODUCTION writers. The read_json/stat fake stays
# exact: any resurrected gpu_snapshot.json read on the HTTP surface KeyErrors
# red instead of silently counting.
state_root = tempfile.mkdtemp(prefix="rt-cache-state-")
os.environ["SIMPLE_EXPERIMENT_WORKER_STATE_DIR"] = state_root
sys.path.insert(0, ${JSON.stringify(toRuntimePath(path.join(__dirname, "../_helpers")))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(${JSON.stringify(toRuntimePath(agentPath))}, [
    "api_worker_gpu", "api_worker_tasks", "TASK_LIFECYCLE_PROTOCOL", "task_execution_inventory", "read_availability_cache",
    "gpu_collector_binding", "gpu_collector_frame_path", "gpu_collector_register_path", "atomic_write"])

root = "/project"
agent.AGENT_STATE_DIR = "/state"
tasks_path = agent.path_for(root, "worker_task_snapshot.json")
availability_path = agent.availability_cache_path(root)
payloads = {
    tasks_path: {"tasks": [{"id": "task-1"}]},
    availability_path: {"workers": {"worker-a": {"available": True}}},
}
versions = {tasks_path: 1, availability_path: 1}
reads = {"count": 0}
def counted(path, fallback):
    reads["count"] += 1
    return payloads.get(path, fallback)
real_stat = os.stat
def fake_stat(path):
    # Intercept ONLY the synthetic snapshot namespaces; a snapshot path the test
    # does not model (e.g. a resurrected gpu_snapshot.json read) stays a hard
    # KeyError. The real per-run frame/state directory uses the real os.stat.
    if not str(path).startswith(("/project", "/state")):
        return real_stat(path)
    version = versions[path]
    return types.SimpleNamespace(st_dev=1, st_ino=1, st_size=version, st_mtime=version, st_mtime_ns=version)
agent.read_json = counted
agent.os.stat = fake_stat

worker_id = str(os.environ.get("SIMPLE_EXPERIMENT_WORKER_ID") or "worker").strip() or "worker"
epoch = "cache-test-epoch-1"
frame_path = agent.gpu_collector_frame_path(worker_id, root)
os.makedirs(os.path.dirname(frame_path), exist_ok=True)
binding = agent.gpu_collector_binding(worker_id, frame_path, epoch)
binding["genStartedMonotonicMs"] = int(time.monotonic() * 1000)
agent.atomic_write(agent.gpu_collector_register_path(worker_id, root), binding)
def write_frame(seq, gpus):
    agent.atomic_write(frame_path, {"schemaVersion": 1, "frameSource": agent.GPU_COLLECTOR_SOURCE,
        "workerId": worker_id, "epoch": epoch, "seq": seq, "collectedAt": agent.now_iso(),
        "collectedMonotonicMs": int(time.monotonic() * 1000), "status": "ok", "error": "",
        "completeness": "full", "runtimeVersion": agent.RUNTIME_VERSION, "gpu": gpus, "gpus": gpus})
write_frame(1, [{"index": 0}])

gpu_first = agent.api_worker_gpu(root)
gpu_reads_after_first = reads["count"]
gpu_second = agent.api_worker_gpu(root)
gpu_reads = reads["count"] - gpu_reads_after_first
tasks_reads_before = reads["count"]
tasks_first = agent.api_worker_tasks(root)
tasks_second = agent.api_worker_tasks(root)
tasks_reads = reads["count"] - tasks_reads_before
avail_reads_before = reads["count"]
availability_first = agent.read_availability_cache(root, True)
availability_second = agent.read_availability_cache(root, True)
avail_reads = reads["count"] - avail_reads_before

write_frame(2, [{"index": 0}, {"index": 1}])
agent.WORKER_GPU_SAMPLE_CACHE["sample"] = (time.monotonic() - 2.0, agent.WORKER_GPU_SAMPLE_CACHE["sample"][1])
gpu_changed = agent.api_worker_gpu(root)
invalidated_reads = reads["count"]

agent.read_availability_cache(root)
agent.read_availability_cache(root)
write_path_reads = reads["count"] - invalidated_reads

print(json.dumps({
    "gpuFrameReads": gpu_reads,
    "gpuReused": gpu_first == gpu_second,
    "gpuNotAliased": gpu_first is not gpu_second,
    "gpuMode": gpu_first.get("collectorMode"),
    "gpuSeq": int(gpu_changed.get("seq") or 0),
    "gpuCount": len(gpu_changed["gpu"]),
    "tasksEquivalent": tasks_first["tasks"] == tasks_second["tasks"],
    "tasksReads": tasks_reads,
    "availabilityReused": availability_first is availability_second,
    "availabilityReads": avail_reads,
    "writePathReads": write_path_reads,
}))
`;

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-json-cache-"));
  const scriptPath = path.join(fixtureRoot, "probe.py");
  fs.writeFileSync(scriptPath, script, "utf8");
  const args = process.platform === "win32"
    ? ["--distribution", process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex", "--exec", "/usr/bin/python3", "-B", toRuntimePath(scriptPath)]
    : ["-B", scriptPath];
  const run = spawnSync(process.platform === "win32" ? "wsl.exe" : "python", args,
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  console.log("kept runtime JSON cache fixture at " + fixtureRoot);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  // GPU telemetry answers from the shared collector frame + its 1s sample cache:
  // it must never touch the retired gpu_snapshot.json read path again (the fake
  // would KeyError on any resurrected read), and two calls inside the cache
  // window return equal-but-unaliased copies.
  assert.equal(result.gpuFrameReads, 0, result);
  assert.equal(result.gpuMode, "fresh", result);
  assert.equal(result.gpuReused, true, result);
  assert.equal(result.gpuNotAliased, true, result);
  // After the cache window expires, the NEW frame generation is what's served.
  assert.equal(result.gpuSeq, 2, result);
  assert.equal(result.gpuCount, 2, result);
  assert.equal(result.tasksEquivalent, true);
  // Task snapshots may be served from the in-process cache; repeated reads
  // must never turn into per-call snapshot storms (≤2 reads for 2 calls).
  assert.ok(result.tasksReads <= 2, `tasks reads: ${result.tasksReads}`);
  assert.equal(result.availabilityReused, true);
  assert.equal(result.availabilityReads, 1, `cached availability must read exactly once: ${result.availabilityReads}`);
  assert.equal(result.writePathReads, 2, "uncached availability calls must each really read");
});

test("hub telemetry routes use cached read-only runtime snapshots", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /read_availability_cache\(root, True\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "gpu_snapshot\.json"\), \{\}\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "cluster_snapshot\.json"\), \{\}\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "experiment_traces_snapshot\.json"\), \{\}\)/);
});
