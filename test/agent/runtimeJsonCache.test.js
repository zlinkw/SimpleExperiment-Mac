const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent reuses bounded read-only runtime JSON by file signature", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-runtime-json-"));
  const script = path.join(project, "runtime-json.py");
  fs.writeFileSync(script, `
import importlib.util, inspect, json, os, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(agent_path, ["MAX_RUNTIME_JSON_CACHE_RECORDS", "RUNTIME_JSON_CACHE", "RUNTIME_JSON_CACHE_TTL_SECONDS", "api_health", "api_snapshot", "atomic_write", "inspect_agent", "prune_runtime_json_cache", "read_runtime_json_cached"])

root = pathlib.Path(${JSON.stringify(project)})
target = root / "snapshot.json"
agent.atomic_write(target, {"value": 1})
first = agent.read_runtime_json_cached(target, {})
second = agent.read_runtime_json_cached(target, {})
replacement = root / "replacement.json"
agent.atomic_write(replacement, {"value": 2})
os.replace(replacement, target)
third = agent.read_runtime_json_cached(target, {})
target.write_text("{broken", encoding="utf-8")
broken = agent.read_runtime_json_cached(target, {"fallback": True})

agent.RUNTIME_JSON_CACHE.clear()
now_value = 10000.0
for index in range(agent.MAX_RUNTIME_JSON_CACHE_RECORDS + 5):
    agent.RUNTIME_JSON_CACHE["path-" + str(index)] = {"lastUsedAt": now_value - index, "signature": (1, index, 1, 1), "value": index}
agent.RUNTIME_JSON_CACHE["expired"] = {"lastUsedAt": now_value - agent.RUNTIME_JSON_CACHE_TTL_SECONDS - 1, "signature": (1, 99, 1, 1), "value": 99}
agent.prune_runtime_json_cache(now_value, "path-0")

print(json.dumps({
    "reusedIdentity": first is second,
    "firstValue": first["value"],
    "replacementValue": third["value"],
    "broken": broken,
    "cacheCount": len(agent.RUNTIME_JSON_CACHE),
    "keptNewest": "path-0" in agent.RUNTIME_JSON_CACHE,
    "removedExpired": "expired" not in agent.RUNTIME_JSON_CACHE,
    "snapshotUsesCache": "read_runtime_json_cached" in inspect.getsource(agent.api_snapshot),
    "healthUsesCache": "read_runtime_json_cached" in inspect.getsource(agent.api_health),
    "inspectUsesCache": "read_runtime_json_cached" in inspect.getsource(agent.inspect_agent),
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.reusedIdentity, true);
  assert.equal(result.firstValue, 1);
  assert.equal(result.replacementValue, 2);
  assert.deepEqual(result.broken, { fallback: true });
  assert.ok(result.cacheCount <= 16);
  assert.equal(result.keptNewest, true);
  assert.equal(result.removedExpired, true);
  assert.equal(result.snapshotUsesCache, true);
  assert.equal(result.healthUsesCache, true);
  assert.equal(result.inspectUsesCache, true);
});
