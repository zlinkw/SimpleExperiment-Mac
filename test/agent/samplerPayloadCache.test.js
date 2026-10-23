const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent samplers compare structured payloads without comparison serialization", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(probe.status,0,probe.stderr || String(probe.error));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-payload-cache-"));
  const script = path.join(project, "payload-cache.py");
  fs.writeFileSync(script, `
import importlib.util, inspect, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(agent_path, ["payload_cache_changed", "start_hub_control_sampler", "start_worker_telemetry_sampler"])

cache = {}
first = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 10}]})
equal = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 10}]})
changed = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 11}]})
independent = agent.payload_cache_changed(cache, "tasks", {"rows": [{"id": 0, "util": 11}]})
worker_source = inspect.getsource(agent.start_worker_telemetry_sampler)
hub_source = inspect.getsource(agent.start_hub_control_sampler)
hub_rejected = False
try:
    agent.start_hub_control_sampler("/unused-project")
except ValueError as error:
    assert "HUB_REMOVED" in str(error)
    hub_rejected = True

print(json.dumps({
    "first": first,
    "equal": equal,
    "changed": changed,
    "independent": independent,
    "keys": sorted(cache.keys()),
    "workerSerializes": "json.dumps" in worker_source,
    "hubSerializes": "json.dumps" in hub_source,
    "workerUsesCache": "payload_cache_changed" in worker_source,
    "hubUsesCache": "payload_cache_changed" in hub_source, "hubRejected":hub_rejected,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result, {
    first: true,
    equal: false,
    changed: true,
    independent: true,
    keys: ["gpu", "tasks"],
    workerSerializes: false,
    hubSerializes: false,
    workerUsesCache: true,
    hubUsesCache: false, hubRejected: true,
  });
});
