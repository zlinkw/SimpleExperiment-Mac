const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent reuses bounded scheduler runtime file indexes and invalidates on directory changes", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("python unavailable");
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-runtime-index-"));
  const script = path.join(project, "runtime-index.py");
  fs.writeFileSync(script, `
import importlib.util, json, os, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = pathlib.Path(${JSON.stringify(project)})
state_dir = root / "simple_cluster" / "tmp" / "cluster_scheduler"
state_dir.mkdir(parents=True)
agent.atomic_write(state_dir / "a_state.json", {"planFile": "a.yaml"})

glob_calls = 0
real_glob = agent.glob.glob
def counted_glob(pattern):
    global glob_calls
    glob_calls += 1
    return real_glob(pattern)
agent.glob.glob = counted_glob

first = agent.collect_scheduler(root)
second = agent.collect_scheduler(root)
cached_source = agent.RUNTIME_JSON_CACHE[os.path.abspath(state_dir / "a_state.json")]["value"]
agent.atomic_write(state_dir / "b_state.json", {"planFile": "b.yaml"})
third = agent.collect_scheduler(root)

agent.RUNTIME_FILE_INDEX_CACHE.clear()
now_value = 10000.0
for index in range(agent.MAX_RUNTIME_FILE_INDEX_RECORDS + 5):
    agent.RUNTIME_FILE_INDEX_CACHE["index-" + str(index)] = {"lastUsedAt": now_value - index, "signature": (1, index, 1), "paths": []}
agent.RUNTIME_FILE_INDEX_CACHE["expired"] = {"lastUsedAt": now_value - agent.RUNTIME_FILE_INDEX_TTL_SECONDS - 1, "signature": (1, 99, 1), "paths": []}
agent.prune_runtime_file_index_cache(now_value, "index-0")

print(json.dumps({
    "globCalls": glob_calls,
    "firstPlans": [item.get("planFile") for item in first],
    "secondPlans": [item.get("planFile") for item in second],
    "thirdPlans": [item.get("planFile") for item in third],
    "cachedSourceClean": "generatedAt" not in cached_source and "source" not in cached_source and "file" not in cached_source,
    "cacheCount": len(agent.RUNTIME_FILE_INDEX_CACHE),
    "keptNewest": "index-0" in agent.RUNTIME_FILE_INDEX_CACHE,
    "removedExpired": "expired" not in agent.RUNTIME_FILE_INDEX_CACHE,
}, ensure_ascii=False))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.globCalls, 2);
  assert.deepEqual(result.firstPlans, ["a.yaml"]);
  assert.deepEqual(result.secondPlans, ["a.yaml"]);
  assert.deepEqual(result.thirdPlans, ["a.yaml", "b.yaml"]);
  assert.equal(result.cachedSourceClean, true);
  assert.ok(result.cacheCount <= 8);
  assert.equal(result.keptNewest, true);
  assert.equal(result.removedExpired, true);
});
