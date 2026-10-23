const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readSource } = require("../_helpers/sourceReader");

test("read-only result summary and diagnostics reads reuse the runtime JSON cache", () => {
  const agentPath = path.join(__dirname, "../../dist/runtime/cluster_agent.py");
  const script = String.raw`
import json, os, stat, types

import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(${JSON.stringify(agentPath)}, ["AGENT_STATE_DIR", "api_diagnostics", "inspect_agent", "normalize_result_candidate", "os", "path_for", "plan_results_summary_relpath", "read_json", "read_results_summary", "scheduler_dependency_health", "session"])

# 085 Mac 重述：Mac 运行时把 read_results_summary(plan,...) 接入声明路径输出契约栈（os.open/fstat/read
# 直接读字节并每次校验身份，不经过 read_json；Windows .403 该分支走 read_runtime_json_cached/read_json）。
# 同一不变式在 Mac 分层保持：(a) 计划分支按当前字节返回、外来 Plan 身份必 ValueError；
# (b) 边界缓存（read_runtime_json_cached 按 stat 签名复用/失效、cached=False 必直读）用 Mac 仍在使用的
#     无计划候选摘要分支验证；(c) api_diagnostics 的会话读仍恰好一次。
root = "/project"
agent.AGENT_STATE_DIR = "/state"
plan = "experiments/plan.yaml"
plan_norm = agent.normalize_result_candidate(plan)
# Mac 声明路径：read_results_summary 严格分支读 by_plan/<key>/summary.json（须带 resultPathIdentity）。
plan_path = os.path.abspath(os.path.join(root, *agent.plan_results_summary_relpath(plan, strict_plan=True).split("/")))
session_path = os.path.abspath(agent.path_for(root, "agent.session.json"))
payloads = {
    plan_path: {"schemaVersion": 1, "resultPathIdentity": "posix-v1", "results": [{"runKey": "run-1"}], "planFile": plan_norm},
    session_path: {"tokenConfigured": True},
}
versions = {plan_path: 1, session_path: 1}
reads = {"count": 0}
def counted(path, fallback):
    reads["count"] += 1
    return payloads.get(os.path.abspath(path), fallback)

FILES = {}
HANDLES = {}
DIRS = set()
CHILDREN = {}
def rebuild_tree():
    DIRS.clear(); CHILDREN.clear()
    base = os.path.abspath(root)
    DIRS.add(base)
    for key in FILES:
        current = os.path.dirname(os.path.abspath(key))
        while current != base and current.startswith(base + os.sep):
            parent = os.path.dirname(current)
            DIRS.add(current)
            CHILDREN.setdefault(parent, set()).add(os.path.basename(current))
            current = parent
        CHILDREN.setdefault(base, set()).add(os.path.relpath(os.path.abspath(key), base).split(os.sep)[0])
        CHILDREN.setdefault(os.path.dirname(os.path.abspath(key)), set()).add(os.path.basename(key))
    CHILDREN.update({key: sorted(value) for key, value in CHILDREN.items()})
def refresh():
    for key, payload in payloads.items(): FILES[key] = json.dumps(payload).encode("utf-8")
    rebuild_tree()
refresh()
def fake_stat(path):
    key = os.path.abspath(path)
    if key in FILES:
        version = versions.get(key, 1)
        return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_dev=1, st_ino=1, st_size=len(FILES[key]),
                                     st_mtime=version, st_mtime_ns=version * 1_000_000_000, st_ctime_ns=version * 1_000_000_000)
    if key in DIRS:
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_dev=1, st_ino=2, st_size=0, st_mtime=0, st_mtime_ns=0, st_ctime_ns=0)
    raise FileNotFoundError(key)
def fake_open(path, flags, *args):
    key = os.path.abspath(path)
    if key not in FILES: raise FileNotFoundError(key)
    HANDLES[key] = [FILES[key], 0]
    return key
agent.read_json = counted
agent.os.stat = fake_stat
agent.os.lstat = fake_stat
agent.os.listdir = lambda directory: CHILDREN[os.path.abspath(directory)]
agent.os.open = fake_open
agent.os.fstat = fake_stat
agent.os.read = lambda handle, size: (lambda buf: (HANDLES.__setitem__(handle, [buf[0], buf[1] + min(size, len(buf[0]) - buf[1])]), buf[0][buf[1]:buf[1] + min(size, len(buf[0]) - buf[1])])[1])(HANDLES[handle])
agent.os.close = lambda handle: HANDLES.pop(handle, None)
agent.os.path.isfile = lambda path: os.path.abspath(path) in FILES
agent.os.path.getmtime = lambda path: versions.get(os.path.abspath(path), 1)
agent.os.path.realpath = lambda path: os.path.abspath(path)
agent.inspect_agent = lambda value: {"agentVersion": "test", "running": True}
agent.scheduler_dependency_health = lambda value: {"ok": True}

plan_reads_before = reads["count"]
declared_first = agent.read_results_summary(root, plan, True)
assert declared_first == payloads[plan_path], "declared summary must return current bytes"
assert agent.read_results_summary(root, plan, True) == payloads[plan_path]
payloads[plan_path] = {"schemaVersion": 1, "resultPathIdentity": "posix-v1", "results": [{"runKey": "run-1"}, {"runKey": "run-2"}], "planFile": plan_norm}
versions[plan_path] = 2
refresh()
assert len(agent.read_results_summary(root, plan, True)["results"]) == 2, "each declared read re-verifies current bytes"
payloads[plan_path] = {"schemaVersion": 1, "resultPathIdentity": "posix-v1", "results": [{"runKey": "run-1"}], "planFile": "experiments/other.yaml"}
refresh()
try:
    agent.read_results_summary(root, plan, True)
    raise AssertionError("declared summary with a foreign Plan identity must be rejected")
except ValueError: pass
payloads[plan_path] = {"schemaVersion": 1, "resultPathIdentity": "posix-v1", "results": [{"runKey": "run-1"}], "planFile": plan_norm}
versions[plan_path] = 1
refresh()
assert reads["count"] == plan_reads_before, "the contract stack must not consume the JSON read boundary"

candidate = os.path.abspath(os.path.join(root, "simple_cluster", "results_summary.json"))
payloads[candidate] = {"schemaVersion": 1, "results": [{"runKey": "run-1"}], "planFile": plan_norm}
versions[candidate] = 1
refresh()
first = agent.read_results_summary(root, None, True)
second = agent.read_results_summary(root, None, True)
cached_reads = reads["count"] - plan_reads_before

payloads[candidate] = {"schemaVersion": 1, "results": [{"runKey": "run-1"}, {"runKey": "run-2"}], "planFile": plan_norm}
versions[candidate] = 2
refresh()
changed = agent.read_results_summary(root, None, True)
invalidated_reads = reads["count"] - plan_reads_before

agent.read_results_summary(root, None)
agent.read_results_summary(root, None)
write_path_reads = reads["count"] - plan_reads_before - invalidated_reads

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

  const run = spawnSync("python", ["-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, script, "utf8"); console.log("kept Python fixture at " + d); return file; })()], { encoding: "utf8", timeout: 10000, windowsHide: true });
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
