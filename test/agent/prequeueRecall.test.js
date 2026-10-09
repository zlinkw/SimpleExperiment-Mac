const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

const source = readSource("src/clusterAgentRuntime.ts");

function definition(name) {
  const start = source.search(new RegExp(`^def ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing production definition: ${name}`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\s*=)/m);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

function fixture(root) {
  const names = [
    "durable_plan_queue_path", "read_durable_plan_queue", "write_durable_plan_queue",
    "durable_plan_value", "durable_plan_identity", "durable_plan_public_task", "durable_plan_same_identity",
    "worker_recall_tombstones_path", "read_worker_recall_tombstones", "recalled_worker_command",
    "write_worker_recall_tombstone", "_legacy_recall_value", "_legacy_recall_identity",
    "worker_start_claims_path", "read_worker_start_claims", "worker_start_claim", "write_worker_start_claim",
    "_legacy_recall_identity_matches", "_legacy_recall_has_execution_marker", "worker_task_matches_stop_identity",
    "worker_command_checkpoint_path", "worker_command_queue_identity", "save_worker_command_checkpoint", "historical_command_is_unprocessed",
    "requeue_durable_plan_job", "execute_worker_command",
  ];
  const durable = source.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m);
  const legacy = source.match(/^LEGACY_WORKER_STOP_IDENTITY_FIELDS\s*=\s*\([^\n]+/m);
  assert.ok(durable && legacy, "missing recall identity constants");
  return String.raw`
import json, os, threading, time, hashlib
ROOT = ${JSON.stringify(root.replace(/\\/g, "/"))}
SCHEMA_VERSION = 1
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
DISTRIBUTED_GPU_RESERVATIONS = {}
EXECUTE_CALLS = []
SLOW_START = threading.Event()
ALLOW_START = threading.Event()
def path_for(root, name):
    state = os.path.join(root, ".agent")
    os.makedirs(state, exist_ok=True)
    return os.path.join(state, name)
def now_iso(): return "2026-09-29T00:00:00Z"
def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle: return json.load(handle)
    except Exception: return fallback
def atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as handle: json.dump(payload, handle)
    os.replace(path + ".tmp", path)
def replace_with_retry(source, target): os.replace(source, target)
def invalidate_runtime_json_cache(path): pass
def release_distributed_gpu_reservation(gpu, command): pass
def worker_command_path(root, worker): return path_for(root, "worker_commands_" + worker + ".jsonl")
def append_event(root, event): pass
def append_worker_task(root, task):
    path = path_for(root, "worker_task_snapshot.json")
    data = read_json(path, {"tasks": []})
    rows = [row for row in data.get("tasks", []) if row.get("commandId") != task.get("commandId")]
    rows.append(task)
    atomic_write(path, {"tasks": rows})
def write_tasks(rows): atomic_write(path_for(ROOT, "worker_task_snapshot.json"), {"tasks": rows})
def execute_stub(root, command, worker):
    EXECUTE_CALLS.append(command)
    if command.get("slow"):
        SLOW_START.set()
        ALLOW_START.wait(2)
    return {"status":"running"}
def _execute_worker_command_unfenced(root, command, worker): return execute_stub(root, command, worker)
${durable[0]}
${legacy[0]}
${names.map(definition).join("\n\n")}

def legacy(command_id, status="queued"):
    return {"commandId":command_id,"operationId":command_id,"workflowId":"w","planRevision":"r",
        "plan":"plans/a.yaml","caseName":"c","seed":4,"attempt":1,"outputDir":"runs/a",
        "workerId":"worker-a","gpuId":"0","status":status}
def recall(row, stop="stop-1"):
    return {**row,"action":"stop-worker-task","requeueRequested":True,
        "targetCommandId":row.get("commandId") or row.get("operationId"),"commandId":stop}

durable = {"schemaVersion":1,"projectId":"p","workflowId":"w","planFile":"plans/a.yaml",
    "planRevision":"rev","codeFingerprint":"sha","experimentIndex":2,"case":"c","seed":4,
    "attempt":1,"outputDir":"runs/a/attempts/1","runKey":"durable-1","commandId":"durable-1",
    "workerId":"worker-a","planJobCount":2,"gpuId":"0","status":"queued"}
atomic_write(durable_plan_queue_path(ROOT), {"schemaVersion":1,"jobs":[durable]})
durable_proof = requeue_durable_plan_job(ROOT, recall(durable))
assert durable_proof["durableAccepted"] and durable_proof["durableReleased"]
assert durable_proof["neverStartedEvidence"] == "durable_queued_row"
assert read_durable_plan_queue(ROOT)["jobs"][0]["stopReason"] == "requeue"
public_proof = durable_plan_public_task(read_durable_plan_queue(ROOT)["jobs"][0])
assert public_proof["targetCommandId"] == "durable-1" and public_proof["durableReleased"] is True
assert public_proof["neverStartedEvidence"] == "durable_queued_row"
assert execute_worker_command(ROOT, {"action":"start-worker-task","commandId":"durable-1"}, "worker-a")["recalled"]
assert not EXECUTE_CALLS

# Historical task release is exact, replayable, and blocks a later start.
old = legacy("legacy-1")
write_tasks([old])
proof = requeue_durable_plan_job(ROOT, recall(old))
assert proof["legacyReleased"] and proof["durableReleased"] and proof["neverStarted"]
assert proof["neverStartedEvidence"] == "worker_task_queued"
again = requeue_durable_plan_job(ROOT, recall(old))
assert again["legacyReleased"]
start = execute_worker_command(ROOT, {"action":"start-worker-task","commandId":"legacy-1"}, "worker-a")
assert start["recalled"] and not EXECUTE_CALLS

# Running and incomplete history cannot be released.
for status in ("running", "dispatching", "unknown", "completed", "failed", "cancelled"):
    row = legacy("fence-" + status, status)
    write_tasks([row])
    result = requeue_durable_plan_job(ROOT, recall(row, "stop-" + status))
    assert result["durableReleased"] is False and result["status"] == status
stale_queued = legacy("stale-queued")
stale_queued.update({"pid":123,"tmuxPane":"%7","tmuxSession":"gpu-0","startedAt":"then","exitCodePath":"logs/exit"})
write_tasks([stale_queued])
stale_result = requeue_durable_plan_job(ROOT, recall(stale_queued, "stop-stale"))
assert stale_result["durableReleased"] is False and stale_result["status"] == "unknown"
bad = {**legacy("mismatch"), "gpuId":"9"}
write_tasks([legacy("mismatch")])
try:
    requeue_durable_plan_job(ROOT, recall(bad, "stop-bad"))
    raise AssertionError("mismatched identity must be rejected")
except ValueError:
    pass

# Command-only history needs explicit queued evidence; missing status retains ownership.
command = legacy("command-only")
command.pop("status")
with open(worker_command_path(ROOT,"worker-a"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(command) + "\n")
write_tasks([])
result = requeue_durable_plan_job(ROOT, recall(command, "stop-command"))
assert result["durableReleased"] is False and "ownership retained" in result["message"]
command["status"] = "queued"
with open(worker_command_path(ROOT,"worker-a"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(command) + "\n")
save_worker_command_checkpoint(ROOT, "worker-a", 0)
result = requeue_durable_plan_job(ROOT, recall(command, "stop-command-queued"))
assert result["neverStartedEvidence"] == "worker_command_queued"
marked_command = legacy("marked-command")
marked_command["startedAt"] = "already-started"
with open(worker_command_path(ROOT,"worker-a"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(marked_command) + "\n")
assert requeue_durable_plan_job(ROOT, recall(marked_command, "stop-marked"))["durableReleased"] is False
processed = legacy("processed-stale-command")
with open(worker_command_path(ROOT,"worker-a"), "a", encoding="utf-8") as handle:
    handle.write(json.dumps(processed) + "\n")
save_worker_command_checkpoint(ROOT, "worker-a", 4)
assert requeue_durable_plan_job(ROOT, recall(processed, "stop-processed"))["durableReleased"] is False, "processed stale queued payload must retain ownership"
malformed_cursor = {**worker_command_queue_identity(worker_command_path(ROOT, "worker-a")),
    "schemaVersion": SCHEMA_VERSION, "queueSeq": 0, "size": 0, "prefixLength": 0,
    "prefixSha256": hashlib.sha256(b"").hexdigest()}
atomic_write(worker_command_checkpoint_path(ROOT, "worker-a"), malformed_cursor)
assert historical_command_is_unprocessed(ROOT, "worker-a", 4) is False, "malformed checkpoint must fail closed"

# A slow launch holds a durable claim while leaving the task snapshot lock available to readers.
slow = {**legacy("slow-launch"),"action":"start-worker-task","slow":True}
launch_result = []
launch_thread = threading.Thread(target=lambda: launch_result.append(execute_worker_command(ROOT, slow, "worker-a")))
launch_thread.start()
assert SLOW_START.wait(1), "slow launch did not reach the executor"
lock_available = WORKER_TASK_SNAPSHOT_LOCK.acquire(timeout=0.2)
assert lock_available, "slow launch held the worker task snapshot lock"
if lock_available: WORKER_TASK_SNAPSHOT_LOCK.release()
write_tasks([legacy("slow-launch")])
claimed = requeue_durable_plan_job(ROOT, recall(legacy("slow-launch"), "stop-slow"))
assert claimed["durableReleased"] is False and "already claimed" in claimed["message"]
ALLOW_START.set()
launch_thread.join(2)
assert not launch_thread.is_alive() and launch_result[0]["status"] == "running"

# The unchanged manual stop matcher keeps its historical optional-GPU semantics.
stop_request = {**legacy("manual"),"targetCommandId":"manual"}
stop_task = {**legacy("manual"),"commandId":"manual","operationId":"manual"}
stop_request["planFile"] = stop_request["plan"]
stop_request["case"] = stop_request["caseName"]
stop_task["case"] = stop_task["caseName"]
# Empty GPU IDs retain the baseline's unbound-worker stop semantics.
stop_request["gpuId"] = ""
stop_task["gpuId"] = ""
assert worker_task_matches_stop_identity(stop_request, stop_task)
print(json.dumps({"taskRecall":True,"tombstone":True,"failClosed":True,"commandRecall":True}))
`;
}

test("Agent releases only proven never-started work and fences replay", () => {
  const pruning = definition('prune_agent_state');
  for (const journal of ['worker_recall_tombstones.json', 'worker_start_claims.json']) {
    assert.ok(pruning.includes('"' + journal + '"'), 'recall fences must survive retention: ' + journal);
  }
  assert.match(source, /queuedJobRecall["']?\s*:\s*True/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prequeue-recall-"));
  const scriptPath = path.join(os.tmpdir(), `prequeue-recall-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(scriptPath, fixture(root), "utf8");
  const run = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    taskRecall: true,
    tombstone: true,
    failClosed: true,
    commandRecall: true,
  });
});
