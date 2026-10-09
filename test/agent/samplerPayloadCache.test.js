const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent samplers compare structured payloads without comparison serialization", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-payload-cache-"));
  const script = path.join(project, "payload-cache.py");
  fs.writeFileSync(script, `
import importlib.util, inspect, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

cache = {}
first = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 10}]})
equal = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 10}]})
changed = agent.payload_cache_changed(cache, "gpu", {"rows": [{"id": 0, "util": 11}]})
independent = agent.payload_cache_changed(cache, "tasks", {"rows": [{"id": 0, "util": 11}]})
worker_source = inspect.getsource(agent.start_worker_telemetry_sampler)
hub_source = inspect.getsource(agent.start_hub_control_sampler)

print(json.dumps({
    "first": first,
    "equal": equal,
    "changed": changed,
    "independent": independent,
    "keys": sorted(cache.keys()),
    "workerSerializes": "json.dumps" in worker_source,
    "hubSerializes": "json.dumps" in hub_source,
    "workerUsesCache": "payload_cache_changed" in worker_source,
    "hubUsesCache": "payload_cache_changed" in hub_source,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
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
    hubUsesCache: true,
  });
});
