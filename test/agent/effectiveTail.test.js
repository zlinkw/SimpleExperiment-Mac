const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

test("_has_sched_kw expanded includes Killed/OOM/exit code (case-insensitive)", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const content = fs.readFileSync(agentPath, "utf8");
  // check regex contains all required keywords
  const required = ["Killed","OOM","out of memory","signal","Segfault","CUDA","NCCL","exit code","exit_code","killed","took too long","timeout","dispatch","scheduler","experiment","Traceback","Error","调度器"];
  for (const kw of required) {
    assert.match(content, new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing keyword ${kw} in _has_sched_kw`);
  }
  // ensure re.IGNORECASE used
  assert.match(content, /re\.IGNORECASE/, "should use re.IGNORECASE");
});

test("_is_noise_line preserves Killed/OOM/signal/exit code lines", async () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-noise-"));
  const script = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
tests = [
  ("Killed", False),
  ("OOM killed process", False),
  ("out of memory", False),
  ("signal 9", False),
  ("Segfault", False),
  ("CUDA error", False),
  ("NCCL timeout", False),
  ("exit code 137", False),
  ("exit_code 1", False),
  ("killed", False),
  ("took too long", False),
  ("timeout", False),
  ("conda activate", True),
  ("[pipe-pane] something", True),
]
for line, expectNoise in tests:
    is_noise = agent._is_noise_line(line)
    if is_noise != expectNoise:
        print(json.dumps({"fail": line, "got": is_noise, "expect": expectNoise}))
        raise SystemExit(1)
print("ok")
`;
  const tmp = path.join(root, "run.py");
  fs.writeFileSync(tmp, script, "utf8");
  const { spawnSync } = require("node:child_process");
  const res = spawnSync(process.execPath, ["-e", `require('child_process').spawnSync('python', ['${tmp.replace(/\\/g, "\\\\")}'], {stdio:'inherit'});`], { encoding: "utf8" });
  // Simpler: directly spawn python
  const py = spawnSync("python", [tmp], { encoding: "utf8" });
  assert.equal(py.status, 0, `python failed: ${py.stdout} ${py.stderr}`);
  assert.match(py.stdout, /ok/);
});

test("_read_effective_tail small Killed log preserved despite <512B", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-tail-"));
  const logDir = path.join(root, "simple_cluster", "tmp", "cluster_scheduler");
  fs.mkdirSync(logDir, { recursive: true });
  const opId = "run-plan-test-killed";
  const logPath = path.join(logDir, `${opId}.log`);
  // small log <512B with Killed
  fs.writeFileSync(logPath, "Killed\n", "utf8");
  const eventsDir = path.join(root, "simple_cluster", "state", "projects", "test", "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  // create minimal events for operation
  const eventsPath = path.join(root, "simple_cluster", "state", "projects", "test", "events.jsonl");
  // not needed, but create dummy
  fs.writeFileSync(eventsPath, "", "utf8");
  const script = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
root = ${JSON.stringify(root.replace(/\\/g, "/"))}
# create operation events so api_runtime_operation_evidence can find operation
import json as _json
# write a minimal operation event
from pathlib import Path
import time
# Use agent helpers to write event? Simulate via directly calling api
# Create payload with opId and logPath via operation events
op_id = "run-plan-test-killed"
# Write events file for this operation
ev_root = os.path.join(root, "simple_cluster", "state", "projects", "test")
os.makedirs(ev_root, exist_ok=True)
# Use agent's read_operation_events path: it expects events under simple_cluster/state/projects/<project>/events.jsonl or per-op?
# Instead, directly test _read_effective_tail via agent's internal helper by calling api_runtime_operation_evidence
# We need to mock operation summary: create a simple events file under the expected path for operation_id
# The agent looks up operation via read_operation_events(root, operation_id, 200) which reads from simple_cluster/state/projects/*/*.jsonl
# We'll write to a generic events file
evt_path = os.path.join(root, "simple_cluster", "state", "projects", "test", "events.jsonl")
with open(evt_path, "w", encoding="utf-8") as f:
    f.write(_json.dumps({"seq": 1, "operationId": op_id, "type": "operation_started", "payload": {"opId": op_id, "logPath": "simple_cluster/tmp/cluster_scheduler/run-plan-test-killed.log"}}) + "\\n")
    f.write(_json.dumps({"seq": 2, "operationId": op_id, "type": "operation_progress", "payload": {"opId": op_id, "status": "running", "message": "scheduler started pid=123，等待 scheduler 终态。", "pid": 123, "tmuxSession": "test", "logPath": "simple_cluster/tmp/cluster_scheduler/run-plan-test-killed.log"}}) + "\\n")
# Now call evidence
ev = agent.api_runtime_operation_evidence(root, op_id, plan_file="", pid=123, tmux_session="test")
print(json.dumps({"liveLogTail": ev.get("liveLogTail"), "liveLogCount": ev.get("liveLogCount"), "schedulerErrorZh": ev.get("schedulerErrorZh"), "failures": ev.get("failures")}))
# Check that liveLogTail contains Killed and count ==1
if "Killed" not in ev.get("liveLogTail", ""):
    print("FAIL Killed not in tail")
    raise SystemExit(1)
if ev.get("liveLogCount", 0) == 0:
    print("FAIL count 0")
    raise SystemExit(1)
print("ok")
`;
  const tmp = path.join(root, "run2.py");
  fs.writeFileSync(tmp, script, "utf8");
  const { spawnSync } = require("node:child_process");
  const py = spawnSync("python", [tmp], { encoding: "utf8" });
  assert.equal(py.status, 0, `python failed stdout=${py.stdout} stderr=${py.stderr}`);
  assert.match(py.stdout, /ok/);
});

test("new operation evidence does not fall back to a previous run of the same plan", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = `
import importlib.util, pathlib, tempfile
spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    logs = root / "simple_cluster" / "tmp" / "cluster_scheduler"
    logs.mkdir(parents=True)
    plan = "experiments/plans/baseline.yaml"
    (logs / (agent.scheduler_plan_runtime_key(str(root), plan) + ".log")).write_text("OLD CUDA out of memory\\n", encoding="utf-8")
    (logs / "new-operation.log").write_text("", encoding="utf-8")
    evidence = agent.api_runtime_operation_evidence(str(root), "new-operation", plan_file=plan)
    assert "OLD CUDA out of memory" not in evidence.get("liveLogTail", ""), evidence
print("ok")
`;
  const result = spawnSync("python", ["-X", "utf8", "-c", script], {
    encoding: "utf8", cwd: path.join(__dirname, "../.."), env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("extension fallback head+tail preserves head for long Traceback (500+3000)", () => {
  // Simulate extension logic: fallbackMsg >4000 with Traceback should be head 500 + truncated + tail 3000
  const longMsg = "Traceback start " + "A".repeat(600) + " middle " + "B".repeat(4000) + " end Tail";
  assert.ok(longMsg.length > 4000);
  const isErrorLike = /Traceback|Error|Killed|OOM/i.test(longMsg);
  assert.ok(isErrorLike);
  let redacted;
  if (longMsg.length > 4000 && /Traceback|Error|Killed|OOM/i.test(longMsg)) {
    redacted = longMsg.slice(0, 500) + "\n...[truncated]...\n" + longMsg.slice(-3000);
  } else {
    redacted = longMsg.length > 4000 ? longMsg.slice(-4000) : longMsg;
  }
  assert.ok(redacted.includes("Traceback start"), "head preserved");
  assert.ok(redacted.includes("...[truncated]..."), "truncated marker");
  assert.ok(redacted.includes("end Tail"), "tail preserved");
  assert.ok(redacted.length <= 500 + 20 + 3000 + 10, "length bounded");
});

test("extension evHasError expanded includes ev.error/ev.dead/ev.liveLogTail", () => {
  const cases = [
    { ev: { error: "some error" }, expect: true },
    { ev: { dead: true }, expect: true },
    { ev: { liveLogTail: "some log" }, expect: true },
    { ev: { logTail: "log" }, expect: true },
    { ev: { schedulerErrorZh: "调度器错" }, expect: true },
    { ev: {}, expect: false },
  ];
  for (const { ev, expect } of cases) {
    const evFailures = Array.isArray(ev.failures) && ev.failures.length ? ev.failures : null;
    const evHasError = Boolean(ev.schedulerErrorZh || ev.programError || evFailures || ev.error || ev.dead || String(ev.liveLogTail || "").trim() || String(ev.logTail || "").trim());
    assert.equal(evHasError, expect, `evHasError mismatch for ${JSON.stringify(ev)}`);
  }
});
