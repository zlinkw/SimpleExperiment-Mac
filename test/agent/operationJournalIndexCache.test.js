const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");

test("agent shares a bounded operation index for one journal version", (t) => {
  const python = process.env.PYTHON || "python";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(probe.status,0,probe.stderr || String(probe.error));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "simple-experiment-operation-index-"));
  const script = path.join(project, "operation-index.py");
  fs.writeFileSync(script, `
import importlib.util, json, pathlib
agent_path = pathlib.Path(${JSON.stringify(path.join(root, "dist", "runtime", "cluster_agent.py"))})
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(agent_path, ["MAX_OPERATION_JOURNAL_CACHE_RECORDS", "OPERATION_JOURNAL_CACHE", "OPERATION_JOURNAL_CACHE_TTL_SECONDS", "path_for", "prune_operation_journal_cache", "read_operation_events", "recent_operations"])

root = ${JSON.stringify(project)}
journal = pathlib.Path(agent.path_for(root, "events.jsonl"))
journal.parent.mkdir(parents=True, exist_ok=True)
def event(seq, operation_id, status):
    return {"schemaVersion": 1, "seq": seq, "type": "operation_" + status, "operationId": operation_id, "generatedAt": f"2026-07-26T00:00:{seq:02d}Z", "payload": {"status": status}}
with journal.open("w", encoding="utf-8") as handle:
    handle.write(json.dumps(event(1, "op-a", "started")) + "\\n")
    handle.write("{broken\\n")
    handle.write(json.dumps(event(2, "op-b", "completed")) + "\\n")

first = agent.recent_operations(root, 10)
cache_path = str(journal.resolve())
first_groups = agent.OPERATION_JOURNAL_CACHE[cache_path]["groups"]
details = agent.read_operation_events(root, "op-a", 10)
reused_groups = agent.OPERATION_JOURNAL_CACHE[cache_path]["groups"]
with journal.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(event(3, "op-a", "completed")) + "\\n")
second = agent.recent_operations(root, 10)
second_groups = agent.OPERATION_JOURNAL_CACHE[cache_path]["groups"]

with journal.open("w", encoding="utf-8") as handle:
    handle.write(json.dumps(event(4, "op-c", "completed")) + "\\n")
third = agent.recent_operations(root, 10)
third_groups = agent.OPERATION_JOURNAL_CACHE[cache_path]["groups"]
agent.OPERATION_JOURNAL_CACHE.clear()
cache_now = 5000
for index in range(agent.MAX_OPERATION_JOURNAL_CACHE_RECORDS + 4):
    agent.OPERATION_JOURNAL_CACHE[f"path-{index}"] = {"lastUsedAt": cache_now - index}
agent.OPERATION_JOURNAL_CACHE["active-old"] = {"lastUsedAt": cache_now - agent.OPERATION_JOURNAL_CACHE_TTL_SECONDS - 1}
agent.prune_operation_journal_cache(cache_now, "active-old")

print(json.dumps({
    "firstIds": [row["operationId"] for row in first],
    "details": [row["seq"] for row in details],
    "reused": first_groups is reused_groups,
    "incremental": second_groups is first_groups,
    "truncatedInvalidated": third_groups is not second_groups, "thirdIds":[row["operationId"] for row in third],
    "secondStatus": next(row["status"] for row in second if row["operationId"] == "op-a"),
    "secondEvents": [row["seq"] for row in second_groups["op-a"]],
    "cacheCount": len(agent.OPERATION_JOURNAL_CACHE),
    "cacheNewest": "path-0" in agent.OPERATION_JOURNAL_CACHE,
    "cacheOldInactive": f"path-{agent.MAX_OPERATION_JOURNAL_CACHE_RECORDS + 3}" in agent.OPERATION_JOURNAL_CACHE,
    "cacheActive": "active-old" in agent.OPERATION_JOURNAL_CACHE,
}))
`, "utf8");
  const run = spawnSync(python, [script], { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.firstIds, ["op-b", "op-a"]);
  assert.deepEqual(result.details, [1]);
  assert.equal(result.reused, true);
  assert.equal(result.incremental, true);
  assert.equal(result.truncatedInvalidated,true);assert.deepEqual(result.thirdIds,["op-c"]);
  assert.equal(result.secondStatus, "completed");
  assert.deepEqual(result.secondEvents, [1, 3]);
  assert.equal(result.cacheCount, 8);
  assert.equal(result.cacheNewest, true);
  assert.equal(result.cacheOldInactive, false);
  assert.equal(result.cacheActive, true);
});
