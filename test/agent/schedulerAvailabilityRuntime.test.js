const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readSource } = require("../_helpers/sourceReader");

const root = path.join(__dirname, "../..");
const runtimePath = path.join(root, "dist/runtime/cluster_scheduler.py");

function runPythonScript(script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-availability-"));
  const scriptPath = path.join(directory, "run.py");
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return spawnSync("python", [scriptPath], {
      encoding: "utf8", cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 10000, windowsHide: true,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runPython(expression) {
  const script = `
import importlib.util, json, sys
module_name = "scheduler_runtime_under_test"
spec = importlib.util.spec_from_file_location(module_name, ${JSON.stringify(runtimePath)})
module = importlib.util.module_from_spec(spec)
sys.modules[module_name] = module
spec.loader.exec_module(module)
${expression}
`;
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("scheduler refreshes a missing availability snapshot directly from an online Agent", () => {
  const value = runPython(`
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1):
        return json.dumps({"workers": [{
            "workerId": "nwpu3",
            "available": True,
            "availableGpuIds": ["0"],
            "busyGpuIds": [],
            "ttlSeconds": 180,
        }]}).encode()
class FakeOpener:
    def __call__(self, url, timeout=1.5): return Response()
module.urllib.request.urlopen = FakeOpener()
worker = {"id": "nwpu3", "local_agent_url": "http://127.0.0.1:18766", "_availability_state_key": "/state#workers/nwpu3"}
module.refresh_missing_worker_availability([worker])
print(json.dumps({
    "agentStatus": worker.get("_agent_status"),
    "available": worker["_availability"]["available"],
    "source": worker["_availability"]["source"],
}))
`);
  assert.equal(value.agentStatus, "online");
  assert.equal(value.available, true);
  assert.equal(value.source, "worker_agent_direct_refresh");
});

test("task completion refreshes a fresh but busy snapshot before dispatch", () => {
  const value = runPython(`
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1):
        return json.dumps({"workers": [{
            "workerId": "nwpu3", "available": True,
            "availableGpuIds": ["1"], "busyGpuIds": ["0", "2", "3"],
            "updatedAt": module.now(), "ttlSeconds": 60,
        }]}).encode()
module.urllib.request.urlopen = lambda url, timeout=5: Response()
worker = {"id": "nwpu3", "local_agent_url": "http://127.0.0.1:12345",
          "_availability": {"available": False, "availableGpuIds": [],
                            "busyGpuIds": ["0", "1", "2", "3"],
                            "updatedAt": module.now(), "ttlSeconds": 60}}
module.note_availability_receipt(worker, dict(worker["_availability"]))
before = module.probe_idle_gpus(worker, {}).get("idle_gpu_ids")
module.refresh_worker_availability_for_signal([worker], force=True)
after = module.probe_idle_gpus(worker, {}).get("idle_gpu_ids")
print(json.dumps({"before": before, "after": after}))
`);
  assert.deepEqual(value.before, []);
  assert.deepEqual(value.after, ["1"]);
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(source, /_force_refresh = _pending_signal_type in \(SCHEDULER_SIGNAL_FIRST_RUN, SCHEDULER_SIGNAL_TASK_END\)/);
  assert.match(source, /_pending_signal_type = SCHEDULER_SIGNAL_TASK_END/);
  assert.match(source, /read_availability_cache\(args\.availability_path, workers, worker_status_ttl_seconds\)\s+_busy_for_probe/);
});

test("terminal Worker events bypass the periodic session check interval", () => {
  const value = runPython(`
events = {"run-1": {"type": "worker_task_completed"}}
print(json.dumps({
    "finished": module.should_check_finished_session("run-1", events, 100, 60, 101),
    "waiting": module.should_check_finished_session("run-2", events, 100, 60, 101),
    "elapsed": module.should_check_finished_session("run-2", events, 100, 60, 160),
}))
`);
  assert.deepEqual(value, { finished: true, waiting: false, elapsed: true });
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.equal((source.match(/should_check_finished_session\(sess, finished_events, last_session_check/g) || []).length, 2);
  assert.match(source, /session_check_min_seconds = max\(0\.5, float\(args\.session_check_min_seconds/);
});

test("worker telemetry samples GPU occupancy within six seconds during a plan", () => {
  const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("agent_runtime_under_test", ${JSON.stringify(agentPath)})
module = importlib.util.module_from_spec(spec)
sys.modules["agent_runtime_under_test"] = module
spec.loader.exec_module(module)
module.random.random = lambda: 1.0
print(json.dumps({"running": module.worker_gpu_sample_delay(60, 30, True),
                  "idle": module.worker_gpu_sample_delay(60, 30, False)}))
`;
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout);
  assert.ok(value.running <= 6, JSON.stringify(value));
  assert.equal(value.idle, 90);
});

test("worker sampler wakes within five seconds when a plan starts during idle wait", () => {
  const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("agent_runtime_under_test", ${JSON.stringify(agentPath)})
module = importlib.util.module_from_spec(spec)
sys.modules["agent_runtime_under_test"] = module
spec.loader.exec_module(module)
module.random.random = lambda: 1.0
slept = []
module.time.sleep = lambda duration: slept.append(duration)
module.has_running_plan = lambda root: bool(slept)
module.wait_for_worker_gpu_sample("/project", 60, 30, False)
print(json.dumps(slept))
`;
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), [5]);
});

test("scheduler recomputes raw GPU rows when cached available flag is stale", () => {
  const value = runPython(`
worker = {"id": "nwpu3", "_availability": {
    "available": False, "reason": "目前无空卡", "availableGpuIds": [],
    "busyGpuIds": ["0", "1"], "gpus": [
        {"index": 0, "utilizationPercent": 0, "memoryUsedMb": 355},
        {"index": 1, "utilizationPercent": 0, "memoryUsedMb": 10}],
    "updatedAt": module.now(), "ttlSeconds": 60}}
module.note_availability_receipt(worker, dict(worker["_availability"]))
probe = module.probe_idle_gpus(worker, {})
print(json.dumps({"idle": probe.get("idle_gpu_ids"), "error": probe.get("error")}))
`);
  assert.deepEqual(value.idle, ["1"]);
  assert.equal(value.error, "");
});

test("availability freshness uses local receipt time and rejects extreme clock skew", () => {
  const value = runPython(`
import time
from datetime import timedelta
worker = {
    "id": "nwpu3",
    "_availability": {"available": True, "updatedAt": module.now(), "ttlSeconds": 180},
}
module.note_availability_receipt(worker, dict(worker["_availability"]))
fresh = module.availability_is_fresh(worker)
worker["_availability_received_monotonic"] = time.monotonic() - 181
expired = module.availability_is_fresh(worker)
future = dict(worker)
future["_availability_received_monotonic"] = 0
future["_availability"]["updatedAt"] = module.now().replace("+", "|") if False else module.now()
from datetime import datetime
future["_availability"]["updatedAt"] = (datetime.now().astimezone() + timedelta(seconds=module.WORKER_AVAILABILITY_CLOCK_SKEW_SECONDS + 1)).isoformat()
skewed = module.availability_is_fresh(future)
print(json.dumps({"fresh": fresh, "expired": expired, "skewed": skewed}))
`);
  assert.equal(value.fresh, true);
  assert.equal(value.expired, false);
  assert.equal(value.skewed, false);
});

test("direct availability snapshots are merged through atomic state replacement", () => {
  const source = readSource("src/clusterSchedulerRuntime.ts");
  assert.match(source, /def persist_worker_availability\(path: str, row: dict\[str, Any\]\)/);
  assert.match(source, /atomic_write_json\(state_path, \{/);
  assert.match(source, /refresh_missing_worker_availability\(workers, args\.availability_path\)/);
});

test("scheduler availability reads the loopback-only unauthenticated readiness route", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /route == "\/api\/worker\/availability":/);
  assert.match(source, /if not self\.localhost_only\(\):\s*self\.send_json\(\{"error": "localhost only"\}, status=403\)/);
});

test("missing and stale availability errors expose the structured dispatch contract", () => {
  const value = runPython(`
worker = {
    "id": "nwpu3",
    "_availability_state_key": "/data/qgking/zlk/simple_cluster/worker_availability.json#workers/nwpu3",
    "worker_status_ttl_seconds": 180,
}
probe = module.probe_idle_gpus(worker, {})
stale_worker = dict(worker)
stale_worker["_availability"] = {"updatedAt": "2020-01-01T00:00:00+00:00", "ttlSeconds": 180}
stale_probe = module.probe_idle_gpus(stale_worker, {})
print(json.dumps({
    "missing": probe.get("structuredError"),
    "missingError": probe.get("error"),
    "stale": stale_probe.get("structuredError"),
}))
`);
  assert.equal(value.missing.workerId, "nwpu3");
  assert.match(value.missing.expectedStateKey, /#workers\/nwpu3$/);
  assert.equal(value.missing.lastSeenAt, null);
  assert.equal(value.missing.ttlSeconds, 180);
  assert.ok(value.missing.suggestedAction);
  assert.equal(value.stale.workerId, "nwpu3");
  assert.equal(value.stale.lastSeenAt, "2020-01-01T00:00:00+00:00");
});

test("scheduler rejects an unconfigured placeholder conda environment before launching", () => {
  const result = runPythonScript(`
import importlib.util
import sys
module_name = "scheduler_runtime_under_test"
spec = importlib.util.spec_from_file_location(module_name, ${JSON.stringify(runtimePath)})
module = importlib.util.module_from_spec(spec)
sys.modules[module_name] = module
spec.loader.exec_module(module)
try:
    module.launch_experiment({"id": "nwpu3", "conda_env": "-", "project_dir": "/tmp/project"}, "plan.yaml", 0, "0", None)
except RuntimeError as error:
    print(error.message if hasattr(error, "message") else str(error))
else:
    raise SystemExit("expected RuntimeError")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /Worker nwpu3 未配置 condaEnv/);
});

test("scheduler propagates the run-plan operation ID to Worker task commands", () => {
  const value = runPython(`
import pathlib
commands = []
module.ensure_worker_runtime = lambda worker: "simple_cluster/runtime/cluster_scheduler.py"
module.enqueue_worker_command = lambda worker, command: commands.append(command)
worker = {"id": "worker-a", "project_dir": "/tmp/project", "conda_env": "research"}
session = module.launch_experiment(worker, "experiments/plans/demo.yaml", 0, "0", pathlib.Path("/tmp"), workflow_id="run-plan-parent", output_dir="work_dirs/demo/0_baseline_seed42")
command = commands[0]
module.launch_experiment(worker, "experiments/plans/demo.yaml", 1, "0", pathlib.Path("/tmp"), workflow_id="run-plan-parent")
print(json.dumps({"workflowId": command.get("workflowId"), "commandId": command["commandId"], "runKey": command["runKey"], "session": session, "outputDir": command.get("outputDir"), "configPath": command.get("configPath"), "legacyHasPath": "configPath" in commands[1]}))
`);
  assert.equal(value.workflowId, "run-plan-parent");
  assert.equal(value.commandId, value.session);
  assert.equal(value.runKey, value.session);
  assert.notEqual(value.commandId, value.workflowId);
  assert.equal(value.outputDir, "work_dirs/demo/0_baseline_seed42");
  assert.equal(value.configPath, "work_dirs/demo/0_baseline_seed42/job_config.yaml");
  assert.equal(value.legacyHasPath, false);
});
