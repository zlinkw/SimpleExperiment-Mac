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
  const next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\s*=)/m);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

function makeFixtureScript(root) {
  const definitions = [
    "durable_plan_queue_path",
    "read_durable_plan_queue",
    "write_durable_plan_queue",
    "durable_plan_path", "durable_plan_value",
    "durable_plan_identity",
    "durable_plan_public_task",
    "durable_plan_same_identity",
    "durable_code_manifest_digest",
    "code_sync_proof_runtime_generation",
    "code_sync_proof_id",
    "code_sync_proof_document",
    "_code_sync_stat_record",
    "verify_code_sync_proof_record",
    "_store_code_sync_proof",
    "register_code_sync_proof",
    "_legacy_durable_code_sync_proof",
    "resolve_durable_code_sync_proof",
    "renew_code_sync_proof_runtime",
    "_durable_gpu_busy_reason",
    "accept_durable_plan_job",
    "worker_recall_tombstones_path",
    "read_worker_recall_tombstones",
    "recalled_worker_command",
    "cancel_durable_plan_job",
    "worker_task_matches_stop_identity",
    "durable_plan_task_status",
    "record_durable_plan_task_terminal",
    "sync_durable_plan_task_rows",
    "drain_durable_plan_queue_once",
    "durable_plan_queue_processor_key",
    "durable_plan_queue_wake_event",
    "signal_durable_plan_queue_processor",
    "start_durable_plan_queue_processor",
    "release_distributed_gpu_reservation",
    "worker_task_snapshot_key",
    "retain_worker_task_snapshot",
    "append_worker_task",
    "api_worker_tasks",
  ].map(pythonDefinition);
  const identity = source.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m);
  assert.ok(identity, "missing production durable identity fields");
  const legacyIdentity = source.match(/^LEGACY_WORKER_STOP_IDENTITY_FIELDS\s*=.*$/m);
  assert.ok(legacyIdentity, "missing production legacy stop identity fields");
  return String.raw`
import json, os, threading, time, math, hashlib, re

ROOT = ${JSON.stringify(root.replace(/\\/g, "/"))}
SCHEMA_VERSION = 1
GPU_IDLE_UTIL_THRESHOLD = 5
GPU_IDLE_MEM_THRESHOLD_MB = 200
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
CODE_SYNC_PROOF_LOCK = threading.RLock()
DURABLE_PLAN_QUEUE_PROCESSOR_LOCK = threading.Lock()
DURABLE_PLAN_QUEUE_PROCESSORS = {}
DISTRIBUTED_GPU_RESERVATIONS = {}
EVENTS = []
AGENT_VERSION = "agent-test"
RUNTIME_VERSION = "runtime-test"
PLUGIN_VERSION = "plugin-test"

def path_for(root, name):
    state = os.path.join(root, ".agent")
    os.makedirs(state, exist_ok=True)
    return os.path.join(state, name)

def now_iso():
    return "2026-09-29T00:00:00Z"

def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return fallback

def atomic_write(path, payload, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".test-tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)

def replace_with_retry(source, target):
    os.replace(source, target)

def invalidate_runtime_json_cache(path):
    pass

def append_event(root, event):
    EVENTS.append(event)

def reconcile_worker_task_exit_codes(root):
    return {"changed": 0}

def read_runtime_json_cached(path, fallback):
    return read_json(path, fallback)

def recover_worker_task_launch_paths(root, item):
    return dict(item)

def worker_task_failure_message(root, item):
    return ""

def _resolve_tmux_prefix(*args):
    return "simple"

def fixed_gpu_window_name(prefix, gpu_id):
    return "simple-gpu-" + str(gpu_id)

def simple_tmux_name(value):
    return str(value)

def gpu_row_id(gpu):
    return str(gpu.get("gpuId") or gpu.get("id") or "")

def gpu_row_busy(gpu, **kwargs):
    return bool(gpu.get("busy"))

def idle_gpu(gpu_id):
    return {"gpuId": gpu_id, "utilizationPercent": 1, "memoryUsedMb": 10, "processes": []}

${identity[0]}
${legacyIdentity[0]}

${definitions.join("\n\n")}

REAL_RESOLVE_DURABLE_CODE_SYNC_PROOF = resolve_durable_code_sync_proof
def resolve_durable_code_sync_proof(root, row):
    if row.get("codeSyncProofId") == "fixture-proof" and row.get("manifestDigest") == row.get("codeFingerprint"):
        return {"proofId":"fixture-proof"}
    return REAL_RESOLVE_DURABLE_CODE_SYNC_PROOF(root, row)

def verified_durable_execution_mode(root, command): return "train_test"

def make_job(index, command_id=None):
    return {
        "projectId": r"D:\\workspace\\project",
        "workflowId": "workflow-1",
        "planFile": "experiments/plans/p.yaml",
        "executionMode": "train_test", "mode": "train_test", "planRevision": "revision-a",
        "codeFingerprint": "sha256-a",
        "experimentIndex": index,
        "case": "case-a",
        "seed": 40 + index,
        "attempt": 1,
        "outputDir": "experiments/runs/job-" + str(index) + "/attempts/1",
        "runKey": command_id or "command-" + str(index),
        "commandId": command_id or "command-" + str(index),
        "workerId": "worker-a",
        "planJobCount": 4,
        "action": "start-worker-task",
        "durablePlanQueue": True,
        "codeSyncProofId": "fixture-proof",
        "manifestDigest": "sha256-a",
        "distributedResults": True,
    }

def persist_task(job, status, gpu_id=""):
    task = {**durable_plan_identity(job), "planJobCount": job["planJobCount"],
            "enqueuedAt": job.get("enqueuedAt"), "status": status, "gpuId": gpu_id}
    append_worker_task(ROOT, task)

legacy_running_stop = {"targetCommandId": "legacy-1", "workflowId": "workflow-1", "planRevision": "revision-a", "planFile": "experiments/plans/p.yaml", "case": "case-a", "seed": "41", "attempt": "1", "outputDir": "experiments/runs/job-1/attempts/1", "workerId": "worker-a", "gpuId": "1"}
legacy_running_task = {"commandId": "legacy-1", "workflowId": "workflow-1", "planRevision": "revision-a", "plan": "experiments/plans/p.yaml", "case": "case-a", "seed": 41, "attempt": 1, "outputDir": "experiments/runs/job-1/attempts/1", "workerId": "worker-a", "gpuId": "1"}
assert worker_task_matches_stop_identity(legacy_running_stop, legacy_running_task), "legacy stop callers must keep working without newer queue identity fields"
assert not worker_task_matches_stop_identity({**legacy_running_stop, "seed": 42}, legacy_running_task)
results = {}
first = accept_durable_plan_job(ROOT, make_job(0), "worker-a")
replay = accept_durable_plan_job(ROOT, make_job(0), "worker-a")
assert first["durableAccepted"] is True and first["status"] == "queued"
assert replay["commandId"] == first["commandId"] and replay["status"] == "queued"
assert all(first.get(key) == make_job(0).get(key) for key in DURABLE_PLAN_IDENTITY_FIELDS)
assert first["projectId"] == make_job(0)["projectId"] and first["planJobCount"] == 4 and first["enqueuedAt"]
assert "gpuId" not in read_durable_plan_queue(ROOT)["jobs"][0] or read_durable_plan_queue(ROOT)["jobs"][0]["gpuId"] == ""
assert read_durable_plan_queue(ROOT)["jobs"][0]["enqueuedAt"]
try:
    accept_durable_plan_job(ROOT, {**make_job(0), "codeFingerprint": "sha256-other"}, "worker-a")
    raise AssertionError("identity collision was accepted")
except ValueError:
    pass
try:
    accept_durable_plan_job(ROOT, {key: value for key, value in make_job(1).items() if key != "planJobCount"}, "worker-a")
    raise AssertionError("job without Plan count was accepted")
except ValueError:
    pass

snapshot = api_worker_tasks(ROOT)
row = next(item for item in snapshot["tasks"] if item["commandId"] == first["commandId"])
assert snapshot["capabilities"]["durablePlanQueue"] is True and snapshot["capabilities"]["schemaVersion"] == 1
assert row["status"] == "queued" and row["planJobCount"] == 4
assert row["enqueuedAt"] and row["projectId"] == make_job(0)["projectId"]

for index in (1, 2, 3):
    accept_durable_plan_job(ROOT, make_job(index), "worker-a")
persist_task({**make_job(99), "commandId": "existing"}, "running", "0")
calls = []
def execute(root, command, worker_id):
    calls.append((command["commandId"], command["gpuId"]))
    task = {**durable_plan_identity(command), "planJobCount": command["planJobCount"],
            "enqueuedAt": command["enqueuedAt"], "status": "running", "gpuId": command["gpuId"]}
    append_worker_task(root, task)
    return {"status": "running", "commandId": command["commandId"]}
import hashlib
manifest = {"train.py": {"size": 11, "sha256": hashlib.sha256(b"version-one").hexdigest()}}
fingerprint = hashlib.sha256(json.dumps([["train.py", manifest["train.py"]]], separators=(",", ":")).encode("utf-8")).hexdigest()
guard_root = os.path.join(ROOT, "code-guard")
os.makedirs(guard_root, exist_ok=True)
with open(os.path.join(guard_root, "train.py"), "w", encoding="utf-8") as handle: handle.write("version-two")
guard_job = {key: value for key, value in {**make_job(0), "commandId": "code-guard", "runKey": "code-guard", "codeManifest": manifest, "codeFingerprint": fingerprint}.items()
    if key not in ("codeSyncProofId", "manifestDigest")}
accept_durable_plan_job(guard_root, guard_job, "worker-a")
guard_calls = []
assert not drain_durable_plan_queue_once(guard_root, "worker-a", gpu_probe=lambda: ([idle_gpu("9")], ""),
    execute=lambda *args: guard_calls.append(True))
assert not guard_calls and read_durable_plan_queue(guard_root)["jobs"][0]["status"] == "queued"
with open(os.path.join(guard_root, "train.py"), "w", encoding="utf-8") as handle: handle.write("version-one")
guard_dispatch = drain_durable_plan_queue_once(guard_root, "worker-a", gpu_probe=lambda: ([idle_gpu("9")], ""),
    execute=lambda *args: {"status": "completed"})
assert len(guard_dispatch) == 1 and guard_dispatch[0]["status"] == "completed"

# Replay the reported failure through the real durable queue and proof verifier.
runtime_root = os.path.join(ROOT, "runtime-renewal")
os.makedirs(runtime_root, exist_ok=True)
with open(os.path.join(runtime_root, "train.py"), "w", encoding="utf-8") as handle: handle.write("version-one")
runtime_proof = register_code_sync_proof(runtime_root, {
    "projectId": guard_job["projectId"], "workerId": "worker-a", "codeFingerprint": fingerprint,
    "manifestDigest": fingerprint, "scopeSignature": hashlib.sha256(b"original-scope").hexdigest(),
    "codeManifest": manifest}, "worker-a")
runtime_job = {**make_job(0), "commandId": "runtime-waiting", "runKey": "runtime-waiting",
    "codeFingerprint": fingerprint, "codeSyncProofId": runtime_proof["proofId"], "manifestDigest": fingerprint}
accept_durable_plan_job(runtime_root, runtime_job, "worker-a")
runtime_queue = read_durable_plan_queue(runtime_root)
runtime_queue["jobs"][0].update({"codeBlocked":True,"error":"code-sync proof identity mismatch or stale runtime generation"})
write_durable_plan_queue(runtime_root, runtime_queue)
AGENT_VERSION = "upgraded-agent"
runtime_calls = []
runtime_busy = lambda: ([{"gpuId":"9","processes":[{}]}], "")
assert not drain_durable_plan_queue_once(runtime_root, "worker-a", gpu_probe=runtime_busy, execute=lambda *args: runtime_calls.append(True))
renewed_row = read_durable_plan_queue(runtime_root)["jobs"][0]
assert renewed_row["status"] == "queued" and not runtime_calls
assert renewed_row["codeSyncProofId"] != runtime_proof["proofId"]
assert renewed_row["codeSyncProofRuntimeGeneration"] == code_sync_proof_runtime_generation()
assert not renewed_row.get("codeBlocked") and not renewed_row.get("error"), "busy GPU must not retain an obsolete code error"
assert durable_plan_same_identity(renewed_row, runtime_job), "runtime refresh must not create an attempt or change job provenance"
public_row = next(row for row in api_worker_tasks(runtime_root)["tasks"] if row["commandId"] == runtime_job["commandId"])
assert public_row["status"] == "queued" and not public_row.get("error"), "Host snapshot must see the cleared blocker"
def runtime_execute(root, command, worker_id):
    runtime_calls.append((command["commandId"],command["attempt"],command["outputDir"]))
    return {"status":"running"}
assert len(drain_durable_plan_queue_once(runtime_root, "worker-a", gpu_probe=lambda: ([idle_gpu("9")], ""), execute=runtime_execute)) == 1
assert runtime_calls == [(runtime_job["commandId"],runtime_job["attempt"],runtime_job["outputDir"])]
assert not drain_durable_plan_queue_once(runtime_root, "worker-a", gpu_probe=lambda: ([idle_gpu("9")], ""), execute=runtime_execute)
assert len(runtime_calls) == 1, "repeated polling cannot start another copy"

ledger_path = durable_plan_queue_path(guard_root)
with open(ledger_path, "w", encoding="utf-8") as handle: handle.write("{broken")
try:
    accept_durable_plan_job(guard_root, {**guard_job, "commandId": "other", "runKey": "other"}, "worker-a")
    raise AssertionError("corrupt ledger must never be silently overwritten")
except json.JSONDecodeError: pass
with open(ledger_path, "r", encoding="utf-8") as handle: assert handle.read() == "{broken"

waiting = drain_durable_plan_queue_once(
    ROOT, "worker-a", gpu_probe=lambda: ([{"gpuId": "0", "processes": [{}]}, {"gpuId": "1", "processes": [{}]}, {"gpuId": "2", "processes": [{}]}], ""), execute=execute)
assert waiting == [] and calls == []
assert all(row.get("gpuId") == "" for row in read_durable_plan_queue(ROOT)["jobs"])
dispatched = drain_durable_plan_queue_once(
    ROOT, "worker-a", gpu_probe=lambda: ([idle_gpu("0"), idle_gpu("1"), idle_gpu("2")], ""), execute=execute)
assert calls == [("command-0", "1"), ("command-1", "2")]
assert [item["status"] for item in dispatched] == ["running", "running"]
ledger = read_durable_plan_queue(ROOT)["jobs"]
assert [item["status"] for item in ledger] == ["running", "running", "queued", "queued"]
assert len({item["gpuId"] for item in ledger if item["gpuId"]}) == 2
assert ledger[2]["gpuId"] == ledger[3]["gpuId"] == "", "waiting Plan jobs must not reserve a GPU"

terminal = next(item for item in ledger if item["commandId"] == "command-0")
persist_task(terminal, "completed", terminal["gpuId"])
sync_durable_plan_task_rows(ROOT)
assert next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "command-0")["status"] == "completed"
drain_durable_plan_queue_once(
    ROOT, "worker-a", gpu_probe=lambda: ([{"gpuId": "0", "processes": [{}]}, idle_gpu("1"), {"gpuId": "2", "processes": [{}]}], ""), execute=execute)
assert calls == [("command-0", "1"), ("command-1", "2"), ("command-2", "1")]
assert next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "command-2")["status"] == "running"

cancel_job = make_job(3)
try:
    cancel_durable_plan_job(ROOT, {**cancel_job, "targetCommandId": cancel_job["commandId"], "projectId": "D:\\wrong", "commandId": "bad-stop"})
    raise AssertionError("queued cancellation with conflicting project identity was accepted")
except ValueError:
    pass
cancelled = cancel_durable_plan_job(ROOT, {**cancel_job, "targetCommandId": cancel_job["commandId"], "commandId": "stop-2"})
assert cancelled["status"] == "cancelled" and cancelled["gpuId"] == ""
assert not drain_durable_plan_queue_once(ROOT, "worker-a", gpu_probe=lambda: ([idle_gpu("1")], ""), execute=execute)
assert all(command_id != "command-3" for command_id, _ in calls)

dispatching_job = accept_durable_plan_job(ROOT, {**make_job(2), "commandId": "crash-job", "runKey": "crash-job"}, "worker-a")
queue = read_durable_plan_queue(ROOT)
queue["jobs"][-1].update({"status": "dispatching", "gpuId": "1"})
write_durable_plan_queue(ROOT, queue)
probe_calls = []
assert not drain_durable_plan_queue_once(ROOT, "worker-a", gpu_probe=lambda: (probe_calls.append(True) or [idle_gpu("1")], ""), execute=execute)
assert not probe_calls, "dispatching jobs must stay fenced from automatic replay"
real_thread = threading.Thread
threads = []
def capture_thread(*args, **kwargs):
    thread = real_thread(*args, **kwargs)
    threads.append(thread)
    return thread
threading.Thread = capture_thread
processor_calls = []
def stop_after_first_drain(root, worker_id):
    processor_calls.append(worker_id)
    raise SystemExit()
drain_durable_plan_queue_once = stop_after_first_drain
start_durable_plan_queue_processor(ROOT, "worker-a", 1)
threads[-1].join(2)
assert not threads[-1].is_alive() and processor_calls == ["worker-a"]
assert next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "crash-job")["status"] == "unknown"

conflict = next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "command-1")
bad_task = {**durable_plan_identity(conflict), "codeFingerprint": "wrong", "status": "completed", "gpuId": conflict["gpuId"]}
atomic_write(path_for(ROOT, "worker_task_snapshot.json"), {"tasks": [bad_task]})
sync_durable_plan_task_rows(ROOT)
conflict_after = next(item for item in read_durable_plan_queue(ROOT)["jobs"] if item["commandId"] == "command-1")
assert conflict_after["status"] == "unknown" and conflict_after["identityConflict"] is True
print(json.dumps({"accepted": True, "fifo": calls, "offlineDrained": True, "cancelled": cancelled["commandId"], "conflict": True}))
`;
}

test("server Agent durably accepts, drains, cancels, and fences Plan jobs", () => {
  const root = path.join(os.tmpdir(), `server-plan-queue-${process.pid}-${Date.now()}`);
  const scriptPath = path.join(os.tmpdir(), `server-plan-queue-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(scriptPath, makeFixtureScript(root), "utf8");
  try {
    const run = spawnSync("python", [scriptPath], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.accepted, true);
    assert.deepEqual(result.fifo, [["command-0", "1"], ["command-1", "2"], ["command-2", "1"]]);
    assert.equal(result.offlineDrained, true);
    assert.equal(result.cancelled, "command-3");
    assert.equal(result.conflict, true);
  } finally {
    // Retain the exact generated fixture for review; no cleanup deletion.
  }
});

test("durable Plan ledger is exempt from Agent state age and byte pruning", () => {
  assert.match(source, /"distributed_plan_queue\.json"/);
  assert.match(source, /protected_entry\s*=\s*base in protected/);
});
