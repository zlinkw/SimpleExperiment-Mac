const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/clusterAgentRuntime.ts");

function pythonDefinition(name) {
  const start = source.search(new RegExp(`^def ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing production definition: ${name}`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\\s*=)/m);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

function fixture(root) {
  const definitions = [
    "now_iso", "durable_plan_queue_path", "read_durable_plan_queue",
    "write_durable_plan_queue", "durable_plan_path", "durable_plan_value", "durable_plan_identity",
    "durable_plan_same_identity", "gpu_row_busy", "_durable_gpu_busy_reason", "accept_durable_plan_job",
    "requeue_durable_plan_job", "release_distributed_gpu_reservation",
    "durable_plan_public_task", "fence_queued_idle_gpu_admission", "drain_durable_plan_queue_once",
    "worker_recall_tombstones_path", "read_worker_recall_tombstones", "recalled_worker_command", "write_worker_recall_tombstone",
    "worker_start_claims_path", "read_worker_start_claims", "worker_start_claim", "write_worker_start_claim",
    "_legacy_recall_value", "_legacy_recall_identity", "_legacy_recall_identity_matches", "_legacy_recall_has_execution_marker",
    "_execute_worker_command_unfenced", "execute_worker_command", "action_event_fields", "handle_action", "api_worker_tasks",
  ].map(pythonDefinition);
  const identity = source.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m);
  assert.ok(identity, "missing durable identity contract");
  return String.raw`
import json, os, threading, time, math
from types import SimpleNamespace
ROOT = ${JSON.stringify(root.replace(/\\/g, "/"))}
SCHEMA_VERSION = 1
GPU_IDLE_UTIL_THRESHOLD = 5
GPU_IDLE_MEM_THRESHOLD_MB = 200
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
DISTRIBUTED_GPU_RESERVATIONS = {}
DURABLE_PLAN_QUEUE_PROCESSOR_LOCK = threading.Lock()
DURABLE_PLAN_QUEUE_PROCESSORS = {}
EVENTS = []
DRAIN_CALLS = []
GPU_PROBES = []
DISPATCH_CALLS = []
DEBUG_BLOCKED_ACTIONS = set()
INACTIVITY_ACTION_CONTEXT = SimpleNamespace(entry=None)
def path_for(root, name):
    state = os.path.join(root, ".agent")
    os.makedirs(state, exist_ok=True)
    return os.path.join(state, name)
def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle: return json.load(handle)
    except Exception: return fallback
def atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle: json.dump(payload, handle)
    os.replace(temp, path)
def replace_with_retry(source, target): os.replace(source, target)
def invalidate_runtime_json_cache(path): pass
def now_iso(): return "2026-09-29T00:00:00Z"
def append_event(root, event): EVENTS.append(event)
def append_worker_task(root, task): pass
def reconcile_worker_task_exit_codes(root): pass
def read_runtime_json_cached(path, fallback): return read_json(path, fallback)
def collect_local_gpu():
    if GPU_PROBES: return GPU_PROBES.pop(0)
    return GPU_ROWS, GPU_ERROR
def gpu_row_id(row): return str(row.get("gpuId") or row.get("id") or "")
def sync_durable_plan_task_rows(root): return read_durable_plan_queue(root)
def action_operation_fields(request=None): return {}
def action_event_fields(extra=None, request=None):
    fields = action_operation_fields(request)
    if isinstance(extra, dict): fields.update(extra)
    return fields
def terminal_action(root, action, operation_id, op_id, status, message, extra=None, request=None):
    return {"schemaVersion": SCHEMA_VERSION, "opId": op_id, "operationId": operation_id, "action": action, "status": status, "message": message, **(extra or {})}
def signal_durable_plan_queue_processor(root, worker_id): pass
def resolve_durable_code_sync_proof(root, row):
    if row.get("codeSyncProofId") == "proof-test" and row.get("manifestDigest") == row.get("codeFingerprint"):
        return {"proofId":"proof-test"}
    if isinstance(row.get("codeManifest"), dict): return {"proofId":"legacy-test"}
    raise ValueError("code-sync proof missing; code is not dispatchable")
GPU_ROWS = [{"gpuId": "0", "utilizationPercent": 1, "memoryUsedMb": 10, "processes": []}]
GPU_ERROR = ""
${identity[0]}
LEGACY_WORKER_STOP_IDENTITY_FIELDS = ("workflowId", "planRevision", "planFile", "case", "seed", "attempt", "outputDir", "workerId", "gpuId")
${definitions.join("\n\n")}
REAL_EXECUTE_WORKER_COMMAND = execute_worker_command
def execute_worker_command(root, command, worker_id):
    if command.get("action") == "start-worker-task" and command.get("durablePlanQueue") is not True:
        DISPATCH_CALLS.append((command.get("commandId"), command.get("gpuId")))
        return {"status":"running", "commandId":command.get("commandId")}
    return REAL_EXECUTE_WORKER_COMMAND(root, command, worker_id)

def verified_durable_execution_mode(root, command): return "train_test"

def make_job(command_id, gpu_id="0"):
    return {"projectId":"project-a", "workflowId":"workflow-a", "planFile":"experiments/plans/a.yaml",
        "executionMode":"train_test", "mode":"train_test", "planRevision":"rev-a", "codeFingerprint":"sha-a", "experimentIndex":0, "case":"case-a",
        "seed":44, "attempt":1, "outputDir":"experiments/runs/a/attempts/1", "runKey":command_id,
        "commandId":command_id, "workerId":"worker-a", "planJobCount":1, "durablePlanQueue":True,
        "codeSyncProofId":"proof-test", "manifestDigest":"sha-a",
        "requireIdleGpu":True, "gpuId":gpu_id, "action":"start-worker-task"}

# Real handle_action -> execute_worker_command -> durable admission envelope.
GPU_ROWS = [{"gpuId":"0", "utilizationPercent":1, "memoryUsedMb":10, "processes":[{"pid":7}]}]
busy = handle_action(ROOT, "start-worker-task", make_job("busy-1"), "op-busy", "busy-1")
assert busy.get("durableAccepted") is False and busy.get("admissionRejected") is True, repr(busy)
assert busy["status"] == "pending" and busy["reason"] == "gpu_busy"
assert busy["commandId"] == "busy-1" and busy["workerId"] == "worker-a" and busy["gpuId"] == "0"
assert read_durable_plan_queue(ROOT)["jobs"] == [], "rejected request must leave no durable owner"

# Unknown GPU telemetry must fail closed.
GPU_ROWS = [{"gpuId":"0", "processes":[]}]
unknown = accept_durable_plan_job(ROOT, make_job("unknown-1"), "worker-a")
assert unknown["admissionRejected"] is True and unknown["durableAccepted"] is False
assert read_durable_plan_queue(ROOT)["jobs"] == []
GPU_ROWS = [{"gpuId":"0", "utilizationPercent":1, "memoryUsedMb":10, "processes":[], "processCount":1}]
contradictory = accept_durable_plan_job(ROOT, make_job("contradictory-1"), "worker-a")
assert contradictory["admissionRejected"] is True
ROOT_TASK_UNKNOWN = os.path.join(ROOT, "unknown-task-owner")
os.makedirs(ROOT_TASK_UNKNOWN, exist_ok=True)
atomic_write(path_for(ROOT_TASK_UNKNOWN, "worker_task_snapshot.json"), {"tasks":[
    {"commandId":"unresolved-owner", "gpuId":"0", "status":"unknown"}]})
task_unknown = accept_durable_plan_job(ROOT_TASK_UNKNOWN, make_job("task-unknown-1"), "worker-a")
assert task_unknown["admissionRejected"] is True
assert read_durable_plan_queue(ROOT_TASK_UNKNOWN)["jobs"] == []

# Explicit reservation serializes concurrent claims; a duplicate accepted ID remains idempotent.
GPU_ROWS = [{"gpuId":"0", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
accepted = accept_durable_plan_job(ROOT, make_job("accepted-1"), "worker-a")
assert accepted["durableAccepted"] is True and accepted["status"] == "queued"
assert not DISPATCH_CALLS, "HTTP acceptance must not wait for or invoke dispatch"
assert len(drain_durable_plan_queue_once(ROOT, "worker-a")) == 1
assert next(row for row in read_durable_plan_queue(ROOT)["jobs"] if row["commandId"] == "accepted-1")["status"] == "running"
assert DISPATCH_CALLS == [("accepted-1", "0")], "accepted idle-GPU job must dispatch immediately"
GPU_ROWS = [{"gpuId":"0", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
duplicate = accept_durable_plan_job(ROOT, make_job("accepted-1"), "worker-a")
assert duplicate["durableAccepted"] is True and duplicate["commandId"] == "accepted-1" and duplicate["gpuId"] == "0"
contender = accept_durable_plan_job(ROOT, make_job("contender-1"), "worker-a")
assert contender["admissionRejected"] is True and contender["reason"] == "gpu_busy"
assert len(read_durable_plan_queue(ROOT)["jobs"]) == 1

# Per-worker cap counts occupied plugin GPU slots; exact zero thresholds remain zero.
GPU_ROWS = [{"gpuId":"1", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
capped_job = make_job("capped-1", "1")
capped_job["maxConcurrentGpus"] = 1
capped = accept_durable_plan_job(ROOT, capped_job, "worker-a")
assert capped["admissionRejected"] is True and len(read_durable_plan_queue(ROOT)["jobs"]) == 1
zero_threshold_job = make_job("zero-threshold-1", "1")
zero_threshold_job["gpuIdleUtilThreshold"] = 0
zero_threshold_job["gpuIdleMemThresholdMb"] = 0
GPU_ROWS = [{"gpuId":"1", "utilizationPercent":0, "memoryUsedMb":0, "processes":[]}]
zero_threshold = accept_durable_plan_job(ROOT, zero_threshold_job, "worker-a")
assert zero_threshold["admissionRejected"] is True

# Two simultaneous requests for one fresh GPU produce one owner and one safe rejection.
GPU_ROWS = [{"gpuId":"1", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
raced = []
def admit_racer(command_id):
    raced.append(accept_durable_plan_job(ROOT, make_job(command_id, "1"), "worker-a"))
threads = [threading.Thread(target=admit_racer, args=("race-"+str(i),)) for i in range(2)]
for thread in threads: thread.start()
for thread in threads: thread.join()
assert sum(item.get("durableAccepted") is True for item in raced) == 1
assert sum(item.get("admissionRejected") is True for item in raced) == 1

# Exact admission bypasses an older queued row and starts on its requested GPU.
ROOT_FIFO = os.path.join(ROOT, "fifo-bypass")
os.makedirs(ROOT_FIFO, exist_ok=True)
DISTRIBUTED_GPU_RESERVATIONS.clear()
GPU_ROWS = [
    {"gpuId":"0", "utilizationPercent":80, "memoryUsedMb":500, "processes":[{"pid":9}]},
    {"gpuId":"1", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]},
]
legacy_head = make_job("legacy-head")
legacy_head["requireIdleGpu"] = False
legacy_head["gpuId"] = ""
accept_durable_plan_job(ROOT_FIFO, legacy_head, "worker-a")
requested = accept_durable_plan_job(ROOT_FIFO, make_job("requested-1", "1"), "worker-a")
assert requested["status"] == "queued"
assert len(drain_durable_plan_queue_once(ROOT_FIFO, "worker-a")) == 1
assert DISPATCH_CALLS[-1] == ("requested-1", "1")
fifo_rows = read_durable_plan_queue(ROOT_FIFO)["jobs"]
assert next(item for item in fifo_rows if item["commandId"] == "legacy-head")["status"] == "queued"
assert next(item for item in fifo_rows if item["commandId"] == "requested-1")["status"] == "running"

# GPU becoming occupied after acceptance fences the exact identity as unknown.
ROOT_RACE = os.path.join(ROOT, "stale-gpu")
os.makedirs(ROOT_RACE, exist_ok=True)
DISTRIBUTED_GPU_RESERVATIONS.clear()
GPU_PROBES[:] = [
    ([{"gpuId":"1", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}], ""),
    ([{"gpuId":"1", "utilizationPercent":50, "memoryUsedMb":300, "processes":[{"pid":12}]}], ""),
]
stale = accept_durable_plan_job(ROOT_RACE, make_job("stale-1", "1"), "worker-a")
assert stale["durableAccepted"] is True and stale["status"] == "queued"
assert not DISPATCH_CALLS or DISPATCH_CALLS[-1][0] != "stale-1"
drain_durable_plan_queue_once(ROOT_RACE, "worker-a")
stale = next(row for row in read_durable_plan_queue(ROOT_RACE)["jobs"] if row["commandId"] == "stale-1")
assert stale["status"] == "unknown"
assert read_durable_plan_queue(ROOT_RACE)["jobs"][0]["status"] == "unknown"
assert DISTRIBUTED_GPU_RESERVATIONS["1"] == "stale-1"

# A missing immediate claim cannot be returned as an accepted queued job.
ROOT_UNCLAIMED = os.path.join(ROOT, "unclaimed-dispatch")
os.makedirs(ROOT_UNCLAIMED, exist_ok=True)
DISTRIBUTED_GPU_RESERVATIONS.clear()
unclaimed_job = make_job("unclaimed-1", "1")
unclaimed_job.pop("codeSyncProofId", None)
unclaimed_job.pop("manifestDigest", None)
unclaimed_job["codeManifest"] = []
GPU_ROWS = [{"gpuId":"1", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
unclaimed = accept_durable_plan_job(ROOT_UNCLAIMED, unclaimed_job, "worker-a")
assert unclaimed["durableAccepted"] is True and unclaimed["status"] == "queued"
drain_durable_plan_queue_once(ROOT_UNCLAIMED, "worker-a")
assert read_durable_plan_queue(ROOT_UNCLAIMED)["jobs"][0]["status"] == "queued"
assert read_durable_plan_queue(ROOT_UNCLAIMED)["jobs"][0]["codeBlocked"] is True
assert DISTRIBUTED_GPU_RESERVATIONS["1"] == "unclaimed-1"

snapshot = api_worker_tasks(ROOT)
assert snapshot["capabilities"]["idleGpuAdmission"] is True
assert snapshot["capabilities"]["codeSyncProof"] is True

# Exact queued-only release, idempotent proof, and running/dispatching fences.
job = make_job("queued-release")
job["requireIdleGpu"] = False
job["gpuId"] = ""
accept_durable_plan_job(ROOT, job, "worker-a")
stop = {**job, "action":"stop-worker-task", "targetCommandId":"queued-release", "commandId":"stop-op", "requeueRequested":True}
try:
    requeue_durable_plan_job(ROOT, {**stop, "gpuId":"wrong-gpu"})
    raise AssertionError("wrong GPU release must be rejected")
except ValueError:
    pass
assert next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "queued-release")["status"] == "queued"
released = execute_worker_command(ROOT, stop, "worker-a")
assert released["durableReleased"] is True and released["durableAccepted"] is True
assert released["status"] == "cancelled" and released["stopReason"] == "requeue"
assert released["commandId"] == "queued-release" and released["runKey"] == "queued-release"
again = execute_worker_command(ROOT, stop, "worker-a")
assert again["durableReleased"] is True and again["commandId"] == "queued-release"
wrapped = handle_action(ROOT, "stop-worker-task", stop, "stop-operation", "stop-handle-op")
assert wrapped["durableReleased"] is True and wrapped["status"] == "cancelled"
assert wrapped["commandId"] == "queued-release" and wrapped["stopReason"] == "requeue"
row = next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "queued-release")
assert row["status"] == "cancelled" and row["stopReason"] == "requeue"

for status in ("dispatching", "running", "unknown"):
    ROOT2 = os.path.join(ROOT, status)
    os.makedirs(ROOT2, exist_ok=True)
    DISTRIBUTED_GPU_RESERVATIONS.clear()
    GPU_ROWS = [{"gpuId":"0", "utilizationPercent":1, "memoryUsedMb":10, "processes":[]}]
    claim = make_job("fenced-" + status)
    accepted = accept_durable_plan_job(ROOT2, claim, "worker-a")
    ledger = read_durable_plan_queue(ROOT2)
    ledger["jobs"][0]["status"] = status
    write_durable_plan_queue(ROOT2, ledger)
    result = execute_worker_command(ROOT2, {**claim, "action":"stop-worker-task", "targetCommandId":claim["commandId"],
        "commandId":"stop-"+status, "requeueRequested":True}, "worker-a")
    assert result["durableReleased"] is False and result["status"] == status
    assert read_durable_plan_queue(ROOT2)["jobs"][0]["status"] == status
# Hosted queues retain local policy and capacity while the desktop is offline.
ROOT3 = os.path.join(ROOT, "hosted-capacity")
os.makedirs(ROOT3, exist_ok=True)
DISTRIBUTED_GPU_RESERVATIONS.clear()
GPU_ROWS = [{"gpuId":str(index), "utilizationPercent":1, "memoryUsedMb":10, "processes":[]} for index in (0,1)]
for index in (0,1):
    hosted = make_job("hosted-"+str(index))
    hosted.update({"requireIdleGpu":False,"gpuId":"","schedulingMode":"server_prequeue","maxConcurrentGpus":1})
    assert accept_durable_plan_job(ROOT3, hosted, "worker-a")["status"] == "queued"
assert len(drain_durable_plan_queue_once(ROOT3, "worker-a")) == 1
assert [row["status"] for row in read_durable_plan_queue(ROOT3)["jobs"]] == ["running","queued"]
print(json.dumps({"admission":True,"release":True,"fences":True}))
`;
}

test("Agent atomically admits explicit idle GPUs and proves queued-only release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gpu-admission-"));
  const scriptPath = path.join(os.tmpdir(), `idle-gpu-admission-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(scriptPath, fixture(root), "utf8");
  try {
    const run = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { admission: true, release: true, fences: true });
  } finally {
    // Retain the exact generated fixture for review; no cleanup deletion.
  }
});
