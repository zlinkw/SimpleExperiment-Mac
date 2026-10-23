const { writePythonFixture, isolatePythonRuntime } = require("../_helpers/isolatedPythonFixture");
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
  // Mac repair: each script already loads the runtime through the explicit
  // extractRuntimeFunctions AST loader, so the isolatePythonRuntime wrapper
  // ("Expected one explicit runtime loader") must not be applied on top.
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return spawnSync("python", [scriptPath], { encoding: "utf8", cwd: root, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 10000, windowsHide: true });
  } finally {
    // Keep the probe and its inputs for failure review.
  }
}

function runPython(expression) {
  const script = `
import importlib.util, json, sys
module_name = "scheduler_runtime_under_test"
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
module = extract_runtime_functions(${JSON.stringify(runtimePath)}, ["WORKER_AVAILABILITY_CLOCK_SKEW_SECONDS", "availability_is_fresh", "enqueue_worker_command", "ensure_worker_runtime", "has_running_plan", "launch_experiment", "note_availability_receipt", "now", "probe_idle_gpus", "random", "refresh_missing_worker_availability", "refresh_worker_availability_for_signal", "should_check_finished_session", "time", "urllib", "wait_for_worker_gpu_sample", "worker_gpu_sample_delay"])
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
  const signals = runPython(`
module = extract_runtime_functions(${JSON.stringify(runtimePath)}, ["scheduler_signal_requires_refresh"])
print(json.dumps([module.scheduler_signal_requires_refresh(signal) for signal in ("first_run", "task_end", "poll_tick")]))
`);
  assert.deepEqual(signals, [true, true, false]);
  // The old global event-driven dispatcher is explicitly retired. Actual protocol-2
  // admission is exercised by idleGpuDurableAdmission and dispatch integration.
  assert.match(source, /GLOBAL_SCHEDULER_REMOVED: use the Worker native tmux task queue/);
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
  const native = fs.readFileSync(path.join(root,"src/runtime/TmuxTaskLifecycle.ts"),"utf8");
  const queue = native.slice(native.indexOf("def task_queue_serve("), native.indexOf("def task_runner("));
  assert.match(queue, /rows = task_inventory\(root, execution_only=True\)/);
  assert.match(queue, /not row\["dead"\] and row\["phase"\] == "queued"/);
  assert.match(queue, /wake\.wait\(timeout=1 if queued else 5\)/);
  assert.match(queue, /wake\.set\(\)/);
  assert.match(source, /GLOBAL_SCHEDULER_REMOVED: use the Worker native tmux task queue/);
});

test("Worker consumers refresh the shared GPU frame every second in active and idle states", () => {
  const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
  const script = `
import importlib.util, json, sys
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
module = extract_runtime_functions(${JSON.stringify(agentPath)}, ["WORKER_AVAILABILITY_CLOCK_SKEW_SECONDS", "availability_is_fresh", "enqueue_worker_command", "ensure_worker_runtime", "has_running_plan", "launch_experiment", "note_availability_receipt", "now", "probe_idle_gpus", "random", "refresh_missing_worker_availability", "refresh_worker_availability_for_signal", "should_check_finished_session", "time", "urllib", "wait_for_worker_gpu_sample", "worker_gpu_sample_delay"])
module.random.random = lambda: 1.0
print(json.dumps({"running": module.worker_gpu_sample_delay(60, 30, True),
                  "idle": module.worker_gpu_sample_delay(60, 30, False)}))
`;
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.running, 1);
  assert.equal(value.idle, 1);
});

test("Worker shared-frame refresh wait stays bounded to one second", () => {
  const agentPath = path.join(root, "dist/runtime/cluster_agent.py");
  const script = `
import importlib.util, json, sys
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
module = extract_runtime_functions(${JSON.stringify(agentPath)}, ["WORKER_AVAILABILITY_CLOCK_SKEW_SECONDS", "availability_is_fresh", "enqueue_worker_command", "ensure_worker_runtime", "has_running_plan", "launch_experiment", "note_availability_receipt", "now", "probe_idle_gpus", "random", "refresh_missing_worker_availability", "refresh_worker_availability_for_signal", "should_check_finished_session", "time", "urllib", "wait_for_worker_gpu_sample", "worker_gpu_sample_delay"])
module.random.random = lambda: 1.0
slept = []
module.time.sleep = lambda duration: slept.append(duration)
module.has_running_plan = lambda root: bool(slept)
module.wait_for_worker_gpu_sample("/project", 60, 30, False)
print(json.dumps(slept))
`;
  const result = runPythonScript(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), [1]);
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
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
module = extract_runtime_functions(${JSON.stringify(runtimePath)}, ["WORKER_AVAILABILITY_CLOCK_SKEW_SECONDS", "availability_is_fresh", "enqueue_worker_command", "ensure_worker_runtime", "has_running_plan", "launch_experiment", "note_availability_receipt", "now", "probe_idle_gpus", "random", "refresh_missing_worker_availability", "refresh_worker_availability_for_signal", "should_check_finished_session", "time", "urllib", "wait_for_worker_gpu_sample", "worker_gpu_sample_delay"])
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
import pathlib, tempfile, os
commands = []
module.load_plan = lambda _: {"suite":"demo", "base_config":{"value":"fixture"}, "seeds":[42], "cases":[{"case":"baseline"}], "naming":{"sweep_dir":"work_dirs/demo"}}
module.formal_source_fingerprint = lambda _: "fixture-code"
module.Path.read_bytes = lambda _: b"mode: train_test\\n"
module.ensure_worker_runtime = lambda worker: "simple_cluster/runtime/cluster_scheduler.py"
module.enqueue_worker_command = lambda worker, command: commands.append(command)
fixture = pathlib.Path(tempfile.mkdtemp(prefix="scheduler-dispatch-declaration-"))
os.chdir(fixture)
plan = pathlib.Path("plan.yaml")
plan.write_text(json.dumps({"suite": "demo", "mode": "train", "seeds": [42],
    "runner": {"train_command": "python train.py"},
    "paper": {"result_csv": "tmp/result/{case}/seed{seed}/metrics.csv"},
    "naming": {"sweep_dir": "work_dirs/{suite}", "job_name": "{index}_{case}_seed{seed}"},
    "cases": [{"case": "baseline"}, {"case": "second"}]}), encoding="utf-8")
worker = {"id": "worker-a", "project_dir": str(fixture), "conda_env": "research"}
session = module.launch_experiment(worker, str(plan), 0, "0", fixture, workflow_id="run-plan-parent", output_dir="work_dirs/demo/0_baseline_seed42")
command = commands[0]
try:
    module.launch_experiment(worker, str(plan), 1, "0", fixture, workflow_id="run-plan-parent")
except ValueError as exc:
    missing_path_error = str(exc)
else:
    raise AssertionError("missing declared output must reject before enqueue")
assert len(commands) == 1, commands
print(json.dumps({"workflowId": command.get("workflowId"), "commandId": command["commandId"], "runKey": command["runKey"], "session": session, "outputDir": command.get("outputDir"), "configPath": command.get("configPath"), "missingPathError": missing_path_error, "policy": command["resultPathPolicy"], "globalJobId": command["globalJobId"]}))
`);
  assert.equal(value.workflowId, "run-plan-parent");
  assert.equal(value.commandId, value.session);
  assert.equal(value.runKey, value.session);
  assert.notEqual(value.commandId, value.workflowId);
  assert.equal(value.outputDir, "work_dirs/demo/0_baseline_seed42");
  assert.equal(value.configPath, "work_dirs/demo/0_baseline_seed42/job_config.yaml");
  assert.match(value.missingPathError, /FORMAL_JOB_DECLARATION_CHANGED/);
  assert.equal(value.policy, "declared");
  assert.equal(value.globalJobId, "run-plan-parent:0");
});
