const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

function runSlotScript(body) {
  const source = fs.readFileSync(path.join(__dirname, "../../dist/runtime/cluster_agent.py"), "utf8");
  const start = source.indexOf("def acquire_worker_action_slot(");
  const end = source.indexOf("\ndef action_target_keys(", start);
  assert.ok(start >= 0 && end > start);
  const script = [
    "import json, threading, time, os",
    "WORKER_ACTION_LOCK = threading.Lock()",
    "WORKER_ACTION_INFLIGHT = {}",
    "WORKER_ACTION_LAST_AT = {}",
    "def prune_runtime_memory_state(): pass",
    source.slice(start, end), body,
  ].join("\n");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "simpleex-action-slot-"));
  const scriptPath = path.join(directory, "slot.py");
  fs.writeFileSync(scriptPath, script, "utf8");
  const run = spawnSync("python", ["-X", "utf8", scriptPath], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim());
}

test("Worker actions ignore stored intervals and ceilings without sleeping", () => {
  const result = runSlotScript([
    'def forbidden_sleep(_): raise AssertionError("must not wait")',
    'time.sleep = forbidden_sleep',
    'payload = {"options": {"workerActionMinIntervalMs": 100000, "workerActionMaxConcurrent": 1}}',
    'WORKER_ACTION_LAST_AT["w"] = int(time.time() * 1000)',
    'slots = [acquire_worker_action_slot(".", "w", payload) for _ in range(150)]',
    'active = WORKER_ACTION_INFLIGHT["w"]',
    'for release in slots: release(); release()',
    'print(json.dumps({"active": active, "remaining": WORKER_ACTION_INFLIGHT.get("w", 0)}))',
  ].join("\n"));
  assert.equal(result.active, 150);
  assert.equal(result.remaining, 0);
});

test("local Worker admission allows stop while another action remains active", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../dist/extension/legacy.js"), "utf8");
  const start = source.indexOf("    async enterWorkerActionSlot(");
  const end = source.indexOf("    recordWorkerActionAt(", start);
  assert.ok(start >= 0 && end > start);
  const harness = vm.runInNewContext("({" + source.slice(start, end) + "})");
  harness.workerActionInFlight = new Map();
  harness.recordWorkerActionAt = () => {};
  harness.notifyWorkerActionRelease = () => {};
  harness.schedulerSettings = () => ({ workerActionMaxConcurrent: 1 });
  harness.waitForWorkerActionRelease = () => { throw new Error("must not wait"); };
  const releaseFirst = await harness.enterWorkerActionSlot("w");
  const releaseStop = await harness.enterWorkerActionSlot("w");
  assert.equal(harness.workerActionInFlight.get("w"), 2);
  releaseFirst(); releaseFirst(); releaseStop();
  assert.equal(harness.workerActionInFlight.has("w"), false);
});
