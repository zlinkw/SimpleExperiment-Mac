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
    "atomic_write_file", "atomic_write",
    "durable_plan_queue_path", "read_durable_plan_queue", "write_durable_plan_queue",
    "durable_plan_value", "durable_plan_identity", "durable_plan_public_task",
    "durable_plan_same_identity", "accept_durable_plan_job", "cancel_durable_plan_job",
    "durable_plan_queue_processor_key", "durable_plan_queue_wake_event", "signal_durable_plan_queue_processor",
    "start_durable_plan_queue_processor",
  ].map(pythonDefinition);
  const identity = source.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m);
  assert.ok(identity, "missing durable identity contract");
  return String.raw`
import hashlib, json, os, stat, threading, time
ROOT = ${JSON.stringify(root.replace(/\\/g, "/"))}
SCHEMA_VERSION = 1
ATOMIC_WRITE_SLOT_COUNT = 32
ATOMIC_WRITE_LOCKS = [threading.RLock() for _ in range(ATOMIC_WRITE_SLOT_COUNT)]
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
CODE_SYNC_PROOF_LOCK = threading.RLock()
DURABLE_PLAN_QUEUE_PROCESSOR_LOCK = threading.Lock()
DURABLE_PLAN_QUEUE_PROCESSORS = {}
EVENTS = []
def path_for(root, name):
    state = os.path.join(root, ".agent")
    os.makedirs(state, exist_ok=True)
    return os.path.join(state, name)
def now_iso(): return "2026-09-29T00:00:00Z"
def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle: return json.load(handle)
    except Exception: return fallback
def replace_with_retry(source, target): os.replace(source, target)
def invalidate_runtime_json_cache(path): pass
def append_event(root, event): EVENTS.append(event)
def append_worker_task(root, task): pass
def signal_durable_plan_queue_processor(root, worker_id): pass
def recalled_worker_command(root, identity): return None
${identity[0]}
${definitions.join("\n\n")}

def make_job(index, command_id):
    return {"projectId":"project-a", "workflowId":"workflow-a", "planFile":"experiments/plans/a.yaml",
        "planRevision":"revision-a", "codeFingerprint":"sha-a", "experimentIndex":index, "case":"case-a",
        "seed":40+index, "attempt":1, "outputDir":"experiments/runs/job-"+str(index)+"/attempts/1",
        "runKey":command_id, "commandId":command_id, "workerId":"worker-a", "planJobCount":3,
        "action":"start-worker-task", "durablePlanQueue":True}

first = accept_durable_plan_job(ROOT, make_job(0, "legacy-0"), "worker-a")
again = accept_durable_plan_job(ROOT, make_job(0, "legacy-0"), "worker-a")
assert first["durableAccepted"] is True and first["status"] == "queued"
assert again["commandId"] == "legacy-0" and again["durableAccepted"] is True
assert first["runKey"] == "legacy-0" and first["planJobCount"] == 3
assert len(read_durable_plan_queue(ROOT)["jobs"]) == 1

cancel = {**make_job(0, "legacy-0"), "targetCommandId":"legacy-0", "commandId":"cancel-op"}
bad = {**cancel, "seed":999}
try:
    cancel_durable_plan_job(ROOT, bad)
    raise AssertionError("mismatched cancellation identity must be rejected")
except ValueError:
    pass
cancelled = cancel_durable_plan_job(ROOT, cancel)
assert cancelled["status"] == "cancelled" and cancelled["stopReason"] == "user_cancel"
assert read_durable_plan_queue(ROOT)["jobs"][0]["status"] == "cancelled"
replay_cancel = cancel_durable_plan_job(ROOT, cancel)
assert replay_cancel is None, "ordinary cancellation semantics must remain unchanged"

# Restart fences dispatching work as unknown and never replays it.
crash = accept_durable_plan_job(ROOT, make_job(1, "legacy-crash"), "worker-a")
ledger = read_durable_plan_queue(ROOT)
next(row for row in ledger["jobs"] if row["commandId"] == "legacy-crash").update({"status":"dispatching", "gpuId":"2"})
write_durable_plan_queue(ROOT, ledger)
real_thread = threading.Thread
threads = []
class HeldThread:
    def __init__(self, *args, **kwargs): self.args=args; self.kwargs=kwargs; threads.append(self)
    def start(self): pass
threading.Thread = HeldThread
start_durable_plan_queue_processor(ROOT, "worker-a", 1)
threading.Thread = real_thread
recovered = next(row for row in read_durable_plan_queue(ROOT)["jobs"] if row["commandId"] == "legacy-crash")
assert recovered["status"] == "unknown" and recovered["recoveredAt"]
assert len(threads) == 1
assert any(event["type"] == "distributed_plan_job_accepted" for event in EVENTS)

# Acceptance acknowledges only the durable write; a slow processor cannot delay the HTTP receipt.
slow_root = os.path.join(ROOT, "slow-processor")
os.makedirs(slow_root, exist_ok=True)
slow_calls = []
def slow_drain(*args, **kwargs):
    slow_calls.append(True)
    time.sleep(2)
drain_durable_plan_queue_once = slow_drain
started = time.monotonic()
slow = accept_durable_plan_job(slow_root, make_job(2, "slow-0"), "worker-a")
elapsed = time.monotonic() - started
assert slow["durableAccepted"] is True and slow["status"] == "queued"
assert elapsed < 0.5 and not slow_calls

# The atomic queue record is the acknowledgement boundary; optional event/wake failures cannot turn it into a timeout.
ack_root = os.path.join(ROOT, "event-wake-failure")
os.makedirs(ack_root, exist_ok=True)
def broken_event(root, event): raise OSError("event storage unavailable")
def broken_signal(root, worker_id): raise RuntimeError("processor registry unavailable")
real_append_event = append_event
real_signal_durable_plan_queue_processor = signal_durable_plan_queue_processor
append_event = broken_event
signal_durable_plan_queue_processor = broken_signal
durable_ack = accept_durable_plan_job(ack_root, make_job(1, "persisted-ack"), "worker-a")
assert durable_ack["durableAccepted"] is True and durable_ack["status"] == "queued"
assert any(row["commandId"] == "persisted-ack" for row in read_durable_plan_queue(ack_root)["jobs"])
append_event = real_append_event
signal_durable_plan_queue_processor = real_signal_durable_plan_queue_processor

# A queue wake drives the single worker processor before its five-second recovery poll.
wake_root = os.path.join(ROOT, "wake-processor")
os.makedirs(wake_root, exist_ok=True)
first_drain = threading.Event()
processed = threading.Event()
def wake_drain(root, worker_id):
    first_drain.set()
    data = read_durable_plan_queue(root)
    row = next((item for item in data["jobs"] if item.get("status") == "queued"), None)
    if row:
        row["status"] = "running"
        write_durable_plan_queue(root, data)
        processed.set()
drain_durable_plan_queue_once = wake_drain
stop_processor = threading.Event()
processor = start_durable_plan_queue_processor(wake_root, "worker-a", 5, stop_processor)
assert first_drain.wait(1), "processor should perform its startup recovery scan"
assert start_durable_plan_queue_processor(wake_root, "worker-a", 5, stop_processor) is processor
accepted_wake = accept_durable_plan_job(wake_root, make_job(0, "wake-0"), "worker-a")
assert accepted_wake["status"] == "queued"
assert processed.wait(1), "enqueue signal should wake the processor before its five-second timeout"
stop_processor.set()
durable_plan_queue_wake_event(wake_root, "worker-a").set()
processor.join(1)
assert not processor.is_alive()
print(json.dumps({"legacyAccept":True,"legacyCancel":True,"restartFence":True}))
`;
}

test("durable Plan queue preserves legacy acceptance, cancellation, and restart fencing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "durable-plan-queue-"));
  const scriptPath = path.join(os.tmpdir(), `durable-plan-queue-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(scriptPath, fixture(root), "utf8");
  try {
    const run = spawnSync(process.env.PYTHON || "python", ["-X", "utf8", scriptPath], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.deepEqual(JSON.parse(run.stdout.trim()), { legacyAccept: true, legacyCancel: true, restartFence: true });
  } finally {
    fs.unlinkSync(scriptPath);
  }
});
