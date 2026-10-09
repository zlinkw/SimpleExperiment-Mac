const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const queuePath = path.join(root, "src", "features", "DistributedPlanQueue.ts");
const queueModule = new Module(queuePath, module);
queueModule.filename = queuePath;
queueModule.paths = Module._nodeModulePaths(path.dirname(queuePath));
queueModule._compile(ts.transpileModule(fs.readFileSync(queuePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, queuePath);
const queue = queueModule.exports;
const runtimePath = path.join(root, "src", "clusterAgentRuntime.legacy.ts");
const runtime = fs.readFileSync(runtimePath, "utf8");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const runtimeManifest = fs.readFileSync(path.join(root, "src", "runtime", "RuntimeManifest.ts"), "utf8");
const panelRuntime = fs.readFileSync(path.join(root, "src", "ui", "PanelHtml.legacy.ts"), "utf8");

function panelFunction(name) {
  const start = panelRuntime.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `missing actual panel helper: ${name}`);
  const next = panelRuntime.indexOf("\n    function ", start + 1);
  return panelRuntime.slice(start, next < 0 ? undefined : next);
}

function pythonDefinition(name) {
  const start = runtime.search(new RegExp(`^def ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing current Agent definition: ${name}`);
  const tail = runtime.slice(start);
  const next = tail.slice(1).search(/^(?:def |class |[A-Z][A-Z_]*\s*=)/m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function snapshot(projectId, rows, workerId = "worker-a", now = Date.now()) {
  return { workerId, capabilities: { durablePlanQueue: true, schemaVersion: 1 },
    generatedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(),
    tasks: rows.map((row) => ({ projectId, workflowId: "workflow-a", planFile: "experiments/plans/a.yaml",
      planRevision: "rev-a", codeFingerprint: "sha256-a", planJobCount: 3, enqueuedAt: new Date(now).toISOString(),
      runKey: row.commandId, workerId, ...row })) };
}

test("plugin package and runtime manifest publish one source version", () => {
  const version = runtimeManifest.match(/export const CURRENT_RUNTIME_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  assert.ok(version, "RuntimeManifest must declare its current release version");
  assert.equal(version, packageVersion, "package and runtime release versions must stay synchronized");
});

test("actual panel task helper treats remote queued jobs as active", () => {
  const context = {};
  vm.runInNewContext([
    `const PLAN_FILE_EQUIVALENCE_CACHE_LIMIT = 128;
const planFileEquivalenceCache = new Map();
const EMPTY_PLAN_FILE_EQUIVALENCE_ENTRY = Object.freeze({ keys: Object.freeze([]), keySet: new Set() });`,
    panelFunction("uniqueText"), panelFunction("normalizePlanSelectionKey"),
    panelFunction("planFileEquivalenceEntry"), panelFunction("samePlanSelection"),
    panelFunction("distributedPlanRecoveryView"), panelFunction("selectedPlanDistributedRun"),
    'globalThis.check = selectedPlanDistributedRun;',
    'globalThis.recovery = distributedPlanRecoveryView;',
  ].join("\n"), context);
  const selected = context.check({ distributedPlans: [{ planFile: "experiments/plans/demo.yaml",
    jobs: [{ index: 0, commandId: "command-a", status: "queued" }] }] }, "./experiments/plans/demo.yaml");
  assert.equal(selected.active, true, "queued durable server acceptance remains active in the selected Plan UI");
  assert.equal(selected.jobs.length, 1);
  assert.deepEqual(Array.from(selected.activeJobs, (job) => job.commandId), ["command-a"]);
  const completed = context.check({ distributedPlans: [{ planFile: "experiments/plans/demo.yaml",
    jobs: [{ index: 0, commandId: "command-a", status: "completed" }] }] }, "experiments/plans/demo.yaml");
  assert.equal(completed.active, false);
  const partialPlan = { planFile: "experiments/plans/demo.yaml", planJobCount: 6, recoveryMissingCount: 2,
    jobs: [0, 1, 2, 3].map((index) => ({ index, status: "completed" })) };
  assert.equal(context.check({ distributedPlans: [partialPlan] }, partialPlan.planFile).active, true,
    "partial server completion must remain actionable instead of presenting 4/4 complete");
  const partial = context.recovery(partialPlan);
  assert.equal(partial.expectedJobCount, 6);
  assert.equal(partial.missingCount, 2);
  assert.equal(partial.unresolved, true);
  assert.equal(context.check({ distributedPlans: [{ ...partialPlan, planJobCount: 4, recoveryMissingCount: 0,
    recoveryConflict: "conflicting server owners" }] }, partialPlan.planFile).active, true);
});

test("cold empty-cache recovery reconstructs complete server identity, caps missing jobs, and rejects stale or partial rows", () => {
  const now = Date.now();
  const projectId = queue.canonicalProjectId("C:/research/project");
  const a = { experimentIndex: 0, case: "alpha", seed: 42, attempt: 1, outputDir: "runs/a/attempts/one", commandId: "cmd-a", status: "running", gpuId: "0" };
  const b = { experimentIndex: 1, case: "alpha", seed: 43, attempt: 1, outputDir: "runs/a/attempts/two", commandId: "cmd-b", status: "completed", gpuId: "1" };
  const recovered = queue.mergeDurableWorkerSnapshots(queue.emptyDistributedQueue(), [snapshot(projectId, [a, b])], projectId, now);
  assert.equal(recovered.plans.length, 1);
  assert.equal(recovered.plans[0].planJobCount, 3);
  assert.equal(recovered.plans[0].remoteAcceptedJobCount, 2);
  assert.equal(recovered.plans[0].recoveryMissingCount, 1);
  assert.deepEqual(recovered.plans[0].jobs.map(({ index, status, workerId, projectId: owner, runKey, commandId }) =>
    ({ index, status, workerId, projectId: owner, runKey, commandId })), [
    { index: 0, status: "running", workerId: "worker-a", projectId, runKey: "cmd-a", commandId: "cmd-a" },
    { index: 1, status: "completed", workerId: "worker-a", projectId, runKey: "cmd-b", commandId: "cmd-b" },
  ]);
  const incomplete = { ...a, case: "", commandId: "" };
  const ignored = queue.mergeDurableWorkerSnapshots(queue.emptyDistributedQueue(), [
    snapshot(projectId, [incomplete]),
    { ...snapshot(projectId, [a]), generatedAt: new Date(now - 181_000).toISOString() },
    { ...snapshot(projectId, [{ ...a, projectId: projectId + "/other" }]) },
  ], projectId, now);
  assert.deepEqual(ignored.plans, []);

  const local = queue.enqueuePlan(queue.emptyDistributedQueue(), { projectId, planJobCount: 1,
    planFile: "experiments/plans/a.yaml", revision: "rev-a", codeFingerprint: "sha256-a",
    jobs: [{ index: 0, case: "alpha", seed: 42, outputDir: "runs/a/attempts/offline" }] }, "workflow-offline", new Date(now).toISOString());
  const assigned = { ...local, plans: local.plans.map((plan) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job,
    status: "running", workerId: "worker-a", commandId: "cmd-offline", runKey: "cmd-offline" })) })) };
  const noReceipt = queue.mergeDurableWorkerSnapshots(assigned, [snapshot(projectId, [], "worker-a", now)], projectId, now);
  assert.equal(noReceipt.plans[0].jobs[0].status, "unknown", "a fresh empty receipt cannot leave stale active work falsely running");
  assert.equal(noReceipt.plans[0].jobs[0].workerId, "worker-a");
  assert.equal(noReceipt.plans[0].jobs[0].commandId, "cmd-offline", "retain the original stop target while fencing a missing receipt");
});

test("cold conflict stays visible and stale queued state cannot resurrect a local terminal ACK", () => {
  const now = Date.now();
  const projectId = queue.canonicalProjectId("C:/research/project");
  const base = { experimentIndex: 0, case: "alpha", seed: 42, attempt: 1,
    outputDir: "runs/a/attempts/one", commandId: "cmd-a", status: "queued" };
  const conflicting = queue.mergeDurableWorkerSnapshots(queue.emptyDistributedQueue(), [
    snapshot(projectId, [base]),
    snapshot(projectId, [{ ...base, planJobCount: 4 }], "worker-b"),
  ], projectId, now);
  assert.equal(conflicting.plans.length, 1, "conflicting cold Plan must remain actionable instead of disappearing");
  assert.ok(conflicting.plans[0].recoveryConflict || conflicting.plans[0].jobs.some((job) => job.status === "unknown"));

  const local = queue.enqueuePlan(queue.emptyDistributedQueue(), { projectId, planJobCount: 1,
    planFile: "experiments/plans/a.yaml", revision: "rev-a", codeFingerprint: "sha256-a",
    jobs: [{ index: 0, case: "alpha", seed: 42, outputDir: base.outputDir }] }, "workflow-a", new Date(now).toISOString());
  const assigned = { ...local, plans: local.plans.map((plan) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job,
    status: "cancelled", workerId: "worker-a", commandId: "cmd-a", runKey: "cmd-a" })) })) };
  const terminal = queue.mergeDurableWorkerSnapshots(assigned, [snapshot(projectId, [base])], projectId, now);
  assert.equal(terminal.plans[0].jobs[0].status, "unknown", "a stale queue receipt cannot overwrite a trusted cancel ACK");
  assert.equal(terminal.plans[0].jobs[0].trustedTerminalStatus, "cancelled");
  assert.equal(queue.unfinishedJobs(terminal.plans[0]), true, "the contradictory remote receipt stays fenced from redispatch");
});

test("retry attempts collapse to the latest receipt while overlapping older activity remains fenced", () => {
  const now = Date.now();
  const projectId = queue.canonicalProjectId("C:/research/project");
  const prior = { experimentIndex: 0, case: "alpha", seed: 42, attempt: 1,
    outputDir: "runs/a/attempts/first", commandId: "cmd-first", status: "failed" };
  const current = { experimentIndex: 0, case: "alpha", seed: 42, attempt: 2,
    outputDir: "runs/a/attempts/second", commandId: "cmd-second", status: "completed" };
  const recovered = queue.mergeDurableWorkerSnapshots(queue.emptyDistributedQueue(),
    [snapshot(projectId, [prior, current])], projectId, now);
  assert.equal(recovered.plans[0].jobs.length, 1, "one logical Plan job must not inflate into one row per retry");
  assert.equal(recovered.plans[0].jobs[0].attempt, 2);
  assert.equal(recovered.plans[0].jobs[0].status, "completed");
  assert.ok(recovered.plans[0].jobs[0].history.some((row) => row.attempt === 1 && row.status === "failed"));

  const staleActive = { ...prior, commandId: "cmd-first", status: "running" };
  const overlap = queue.mergeDurableWorkerSnapshots(queue.emptyDistributedQueue(),
    [snapshot(projectId, [staleActive, current])], projectId, now);
  assert.equal(overlap.plans[0].jobs.length, 2, "both command identities must remain available for an authorized stop");
  assert.ok(overlap.plans[0].jobs.every((job) => job.status === "unknown" && job.recoveryConflict),
    "older active work overlapping a completed retry must fence both exact attempts");
});

test("an older terminal receipt remains retry history and cannot satisfy a locally declared Plan count", () => {
  const now = Date.now();
  const projectId = queue.canonicalProjectId("C:/research/project");
  const queued = queue.enqueuePlan(queue.emptyDistributedQueue(), { projectId, planJobCount: 3,
    planFile: "experiments/plans/a.yaml", revision: "rev-a", codeFingerprint: "sha256-a",
    jobs: [{ index: 0, case: "alpha", seed: 42, outputDir: "runs/a/attempts/first" }] }, "workflow-a", new Date(now).toISOString());
  const failed = { ...queued, plans: queued.plans.map((plan) => ({ ...plan, jobs: plan.jobs.map((job) => ({ ...job,
    status: "failed", workerId: "worker-a", commandId: "cmd-first", runKey: "cmd-first" })) })) };
  const retried = queue.retryVerifiedJob(failed, "workflow-a", 0, "retry-run-1234");
  const staleTerminal = { experimentIndex: 0, case: "alpha", seed: 42, attempt: 1,
    outputDir: "runs/a/attempts/first", commandId: "cmd-first", planJobCount: 1, status: "failed" };
  const merged = queue.mergeDurableWorkerSnapshots(retried, [snapshot(projectId, [staleTerminal])], projectId, now);
  const plan = merged.plans[0];
  assert.equal(plan.planJobCount, 3, "the fresh server's smaller count cannot replace the local submitted count");
  assert.ok(plan.recoveryConflict, "count disagreement must remain fenced");
  assert.equal(plan.jobs.length, 1, "an old attempt must not inflate current jobs");
  assert.equal(plan.jobs[0].attempt, 2);
  assert.equal(plan.jobs[0].status, "pending", "old terminal state cannot complete the pending retry");
  assert.ok(plan.jobs[0].history.some((row) => row.attempt === 1 && row.commandId === "cmd-first"));
  assert.equal(plan.remoteAcceptedJobCount, 0, "only a receipt for the latest attempt counts as remote acceptance");
  assert.equal(plan.recoveryMissingCount, 2, "one current retry job remains pending locally, so only two additional jobs are missing");
});

test("source Agent durably accepts idempotent sparse job identity and drains FIFO within GPU capacity", () => {
  const definitions = ["durable_plan_queue_path", "read_durable_plan_queue", "write_durable_plan_queue",
    "durable_plan_path", "durable_plan_value", "durable_plan_identity", "durable_plan_public_task", "durable_plan_same_identity",
    "accept_durable_plan_job", "cancel_durable_plan_job", "durable_plan_task_status", "record_durable_plan_task_terminal",
    "sync_durable_plan_task_rows", "drain_durable_plan_queue_once", "release_distributed_gpu_reservation", "api_worker_tasks"]
    .map(pythonDefinition);
  const identity = runtime.match(/^DURABLE_PLAN_IDENTITY_FIELDS\s*=\s*\([\s\S]*?^\)/m);
  assert.ok(identity, "missing canonical full-identity fields");
  const rootDir = path.join(os.tmpdir(), `p6-queue-agent-${process.pid}-${Date.now()}`);
  const scriptPath = path.join(os.tmpdir(), `p6-queue-agent-${process.pid}-${Date.now()}.py`);
  const py = String.raw`
import hashlib, json, os, threading, time
ROOT = ${JSON.stringify(rootDir.replace(/\\/g, "/"))}
SCHEMA_VERSION = 1
WORKER_TASK_SNAPSHOT_LOCK = threading.RLock()
DISTRIBUTED_GPU_RESERVATIONS = {}
os.makedirs(os.path.join(ROOT, "src"), exist_ok=True)
mounted = os.path.join(ROOT, "src", "version.txt")
with open(mounted, "wb") as handle: handle.write(b"source-v1")
manifest = {"src/version.txt":{"sha256":hashlib.sha256(b"source-v1").hexdigest()}}
stable = [[key, manifest[key]] for key in sorted(manifest, key=lambda value: value.encode("utf-16-be"))]
fingerprint = hashlib.sha256(json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
def path_for(root, name):
    state = os.path.join(root, ".agent")
    os.makedirs(state, exist_ok=True)
    return os.path.join(state, name)
def now_iso(): return "2026-09-29T00:00:00Z"
def recalled_worker_command(root, identity): return None
def _durable_gpu_busy_reason(root, gpu_id, command_id, gpus=None, util_threshold=None, mem_threshold=None, max_concurrent_gpus=None): return ""
def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle: return json.load(handle)
    except Exception: return fallback
def replace_with_retry(source, target): os.replace(source, target)
def invalidate_runtime_json_cache(path): pass
def append_event(root, event): pass
def signal_durable_plan_queue_processor(root, worker_id): pass
def atomic_write(path, payload, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":") if compact else None)
def resolve_durable_code_sync_proof(root, row):
    manifest = row.get("codeManifest")
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError("code-sync proof missing; code is not dispatchable")
    stable = [[key, manifest[key]] for key in sorted(manifest, key=lambda value: value.encode("utf-16-be"))]
    digest = hashlib.sha256(json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if digest != str(row.get("codeFingerprint") or ""):
        raise ValueError("legacy code manifest fingerprint mismatch")
    for relative, expected in manifest.items():
        full = os.path.abspath(os.path.join(root, *relative.split("/")))
        if os.path.commonpath([os.path.realpath(root), os.path.realpath(full)]) != os.path.realpath(root):
            raise ValueError("code manifest escapes project")
        digest = hashlib.sha256(open(full, "rb").read()).hexdigest()
        if digest != expected.get("sha256"):
            raise ValueError("mounted code changed: " + relative)
    return {"proofId": "legacy-test", "manifestDigest": row["codeFingerprint"], "runtimeGeneration": "fixture-runtime"}
def append_worker_task(root, task):
    path = path_for(root, "worker_task_snapshot.json")
    data = read_json(path, {"tasks": []})
    data["tasks"] = [row for row in data.get("tasks", []) if row.get("commandId") != task.get("commandId")] + [task]
    with open(path, "w", encoding="utf-8") as handle: json.dump(data, handle)
def append_worker_task(root, task):
    path = path_for(root, "worker_task_snapshot.json")
    data = read_json(path, {"tasks": []})
    data["tasks"] = [row for row in data.get("tasks", []) if row.get("commandId") != task.get("commandId")] + [task]
    with open(path, "w", encoding="utf-8") as handle: json.dump(data, handle)
def reconcile_worker_task_exit_codes(root): return {"changed": 0}
def read_runtime_json_cached(path, fallback): return read_json(path, fallback)
def recover_worker_task_launch_paths(root, item): return dict(item)
def worker_task_failure_message(root, item): return ""
def _resolve_tmux_prefix(*args): return "simple"
def fixed_gpu_window_name(prefix, gpu_id): return "simple-gpu-" + str(gpu_id)
def simple_tmux_name(value): return str(value)
def gpu_row_id(gpu): return str(gpu.get("gpuId") or gpu.get("id") or "")
def gpu_row_busy(gpu): return bool(gpu.get("busy"))
${identity[0]}
${definitions.join("\n\n")}
def verified_durable_execution_mode(root, command): return "train_test"

def make_job(index, count=1):
    return {"projectId":"p", "workflowId":"workflow-a", "planFile":"experiments/plans/a.yaml",
      "executionMode":"train_test", "mode":"train_test", "planRevision":"rev-a", "codeFingerprint":fingerprint, "codeManifest":manifest, "experimentIndex":index,
      "case":"alpha", "seed":42+index, "attempt":1, "outputDir":"runs/a/attempts/job-"+str(index),
      "runKey":"cmd-"+str(index), "commandId":"cmd-"+str(index), "workerId":"worker-a",
      "planJobCount":count, "enqueuedAt":now_iso()}
try:
    accept_durable_plan_job(ROOT, make_job(5, 1), "worker-a")
except ValueError as error:
    raise AssertionError("sparse selected job index must survive count-based admission: " + str(error))
accepted = accept_durable_plan_job(ROOT, make_job(5, 1), "worker-a")
assert accepted["status"] == "queued" and accepted["durableAccepted"]
cancelled = cancel_durable_plan_job(ROOT, {**make_job(5, 1), "targetCommandId":"cmd-5", "commandId":"cancel-5"})
assert cancelled["status"] == "cancelled" and cancelled["experimentIndex"] == 5
rows = [make_job(0, 3), make_job(1, 3), make_job(2, 3)]
for item in rows: accept_durable_plan_job(ROOT, item, "worker-a")
calls = []
def execute(root, command, worker_id):
    calls.append((command["commandId"], command["gpuId"]))
    return {"status":"running", "commandId":command["commandId"]}
with open(mounted, "wb") as handle: handle.write(b"source-mutated")
probe_calls = []
blocked = drain_durable_plan_queue_once(ROOT, "worker-a",
    gpu_probe=lambda: (probe_calls.append(True) or ([{"gpuId":"0"}], "")), execute=execute)
assert blocked == [] and probe_calls == [] and calls == [], "mounted source drift must block before GPU probing or execution"
assert [row["status"] for row in read_durable_plan_queue(ROOT)["jobs"][-3:]] == ["queued", "queued", "queued"]
with open(mounted, "wb") as handle: handle.write(b"source-v1")
dispatched = drain_durable_plan_queue_once(ROOT, "worker-a",
    gpu_probe=lambda: ([{"gpuId":"0"}, {"gpuId":"1"}], ""), execute=execute)
assert [row["commandId"] for row in dispatched] == ["cmd-0", "cmd-1"]
assert len({gpu for _, gpu in calls}) == 2
assert [row["status"] for row in read_durable_plan_queue(ROOT)["jobs"][-3:]] == ["running", "running", "queued"]
snapshot_path = path_for(ROOT, "worker_task_snapshot.json")
with open(snapshot_path, "w", encoding="utf-8") as handle:
    json.dump({"generatedAt":"2000-01-01T00:00:00Z", "tasks":[]}, handle)
api_tasks = api_worker_tasks(ROOT)
assert api_tasks["capabilities"] == {"durablePlanQueue":True, "codeSyncProof":True,
    "idleGpuAdmission":True, "queuedJobRecall":True, "schemaVersion":1}
assert api_tasks["generatedAt"] == now_iso(), "fresh durable queue API snapshot must not reuse a stale task snapshot date"
try:
    accept_durable_plan_job(ROOT, {**make_job(1, 3), "codeFingerprint":"different"}, "worker-a")
    raise AssertionError("command identity conflict was accepted")
except ValueError: pass
queue_file = durable_plan_queue_path(ROOT)
with open(queue_file, "wb") as handle: handle.write(b'{"schemaVersion":1,"jobs":')
corrupt_before = open(queue_file, "rb").read()
try:
    accept_durable_plan_job(ROOT, make_job(4, 3), "worker-a")
    raise AssertionError("corrupt durable ledger was silently replaced")
except (ValueError, json.JSONDecodeError): pass
assert open(queue_file, "rb").read() == corrupt_before, "fail-closed admission must preserve the original corrupt bytes"
print(json.dumps({"accepted":True,"fifo":calls,"durable":True}))
`;
  fs.writeFileSync(scriptPath, py, "utf8");
  try {
    const result = spawnSync("python", [scriptPath], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { accepted: true, fifo: [["cmd-0", "0"], ["cmd-1", "1"]], durable: true });
  } finally {
    // Retain the exact generated fixture for review; no cleanup deletion.
  }
});
