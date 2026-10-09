const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const agentPath = path.join(root, "src/clusterAgentRuntime.legacy.ts");
const fixturePath = path.join(__dirname, "stop_scheduler_identity_fixture.py");
const source = fs.readFileSync(agentPath, "utf8");

test("stop target requires an exact recorded operation and Plan identity", () => {
  const result = spawnSync("python", ["-X", "utf8", fixturePath], {
    input: source,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /stop identity ok/);
});

test("stop never trusts caller PID and legacy admin routes cannot execute broad kills", () => {
  const stopStart = source.indexOf("def stop_scheduler_operation(root, payload):");
  const stopEnd = source.indexOf("\ndef recent_operations(", stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = source.slice(stopStart, stopEnd);
  assert.match(stop, /scheduler_stop_record_identity\(wanted, requested_plan, latest_event\)/);
  assert.match(stop, /registry_entry = next\(/);
  assert.doesNotMatch(stop, /payload\.get\("pid"\)|payload\.get\("tmuxSession"\)/);
  assert.match(stop, /process_start_identity\(before\["checkedPid"\]\) != expected_pid_start/);

  const routeStart = source.indexOf("if route in (\"/api/admin/kill-stale-runtime\", \"/api/admin/exec\"):");
  const routeEnd = source.indexOf("if route.startswith(\"/api/files/\"):", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /route == "\/api\/admin\/exec"/);
  assert.match(route, /arbitrary remote shell execution is disabled/);
  assert.match(route, /targetOperationId and planFile are required/);
  assert.match(route, /stop_scheduler_operation\(root, scoped_payload\)/);
  assert.doesNotMatch(route, /shell=True|pkill|kill_cmd/);
});
