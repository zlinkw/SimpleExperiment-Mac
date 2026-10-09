const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("read-only result summary and diagnostics reads reuse the runtime JSON cache", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import importlib.util, json, os, types

spec = importlib.util.spec_from_file_location("cluster_agent", ${JSON.stringify(agentPath)})
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

root = "/project"
agent.AGENT_STATE_DIR = "/state"
plan = "experiments/plan.yaml"
plan_norm = agent.normalize_result_candidate(plan)
plan_path = os.path.abspath(os.path.join(root, *agent.plan_results_summary_relpath(plan_norm).split("/")))
session_path = os.path.abspath(agent.path_for(root, "agent.session.json"))
payloads = {
    plan_path: {"schemaVersion": 1, "results": [{"runKey": "run-1"}], "planFile": plan_norm},
    session_path: {"tokenConfigured": True},
}
versions = {plan_path: 1, session_path: 1}
reads = {"count": 0}
def counted(path, fallback):
    reads["count"] += 1
    return payloads.get(os.path.abspath(path), fallback)
def fake_stat(path):
    version = versions[os.path.abspath(path)]
    return types.SimpleNamespace(st_dev=1, st_ino=1, st_size=version, st_mtime=version, st_mtime_ns=version)
agent.read_json = counted
agent.os.stat = fake_stat
agent.inspect_agent = lambda value: {"agentVersion": "test", "running": True}
agent.scheduler_dependency_health = lambda value: {"ok": True}

first = agent.read_results_summary(root, plan, True)
second = agent.read_results_summary(root, plan, True)
cached_reads = reads["count"]

payloads[plan_path] = {"schemaVersion": 1, "results": [{"runKey": "run-1"}, {"runKey": "run-2"}], "planFile": plan_norm}
versions[plan_path] = 2
changed = agent.read_results_summary(root, plan, True)
invalidated_reads = reads["count"]

agent.read_results_summary(root, plan)
agent.read_results_summary(root, plan)
write_path_reads = reads["count"] - invalidated_reads

diagnostics_before = reads["count"]
first_diagnostics = agent.api_diagnostics(root)
second_diagnostics = agent.api_diagnostics(root)
diagnostics_reads = reads["count"] - diagnostics_before

print(json.dumps({
    "cachedReads": cached_reads,
    "invalidatedReads": invalidated_reads,
    "writePathReads": write_path_reads,
    "diagnosticsReads": diagnostics_reads,
    "summaryReused": first is second,
    "changedCount": len(changed["results"]),
    "planFile": first["planFile"],
    "tokenConfigured": first_diagnostics["tokenConfigured"] and second_diagnostics["tokenConfigured"],
}))
`;

  const run = spawnSync("python", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.cachedReads, 1);
  assert.equal(result.invalidatedReads, 2);
  assert.equal(result.writePathReads, 2);
  assert.equal(result.diagnosticsReads, 1);
  assert.equal(result.summaryReused, true);
  assert.equal(result.changedCount, 2);
  assert.equal(result.planFile, "experiments/plan.yaml");
  assert.equal(result.tokenConfigured, true);
});

test("result summary route reads cached while parse decisions keep uncached reads", () => {
  const source = readSource("src/clusterAgentRuntime.ts");
  assert.match(source, /def read_results_summary\(root, plan=None, cached=False\)/);
  assert.match(source, /read_summary = read_runtime_json_cached if cached else read_json/);
  assert.match(source, /read_results_summary\(root, plan or None, True\)/);
  assert.match(source, /read_runtime_json_cached\(path_for\(root, "agent\.session\.json"\), \{\}\)/);
  assert.match(source, /summary = read_results_summary\(root, plan\)\r?\n/);
});
