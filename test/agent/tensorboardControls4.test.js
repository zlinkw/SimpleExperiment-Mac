const test = require("node:test");

const assert = require("node:assert/strict");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const { spawnSync } = require("node:child_process");

const { readSource } = require("../_helpers/sourceReader");


const root = path.resolve(__dirname, "..", "..");

const agentPath = path.join(root, "dist", "runtime", "cluster_agent.py");

const agentSource = readSource("src/clusterAgentRuntime.ts");

const extensionSource = readSource("src/extension.ts");

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));


const wslPath = file => '/mnt/'+file[0].toLowerCase()+file.slice(2).replace(/\\/g,'/');
function runPython(script) {
  if(process.platform === 'win32') for(const file of [agentPath,root,path.resolve(__dirname,'../_helpers'),path.resolve(__dirname,'../_helpers/extractRuntimeFunctions.py')])
    script=script.replaceAll(JSON.stringify(file),JSON.stringify(wslPath(file)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-test-"));
  const file = path.join(tmp, "run.py");
  fs.writeFileSync(file, script, "utf8");
  try {
    const executable=process.platform==='win32'?'wsl.exe':'python';
    const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3','-B','-X','utf8',wslPath(file)]:[file];
    return spawnSync(executable, args, { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  } finally {
    // Preserve bounded Python probes and all failure inputs.
  }
}


test("worker task API self-heals an exit code produced after Agent restart", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","api_worker_tasks","append_event","atomic_write","path_for","reconcile_worker_tasks_after_restart","subprocess"])
with tempfile.TemporaryDirectory() as root:
    agent.AGENT_STATE_DIR = os.path.join(root, "state")
    exit_path = pathlib.Path(root) / "simple_cluster" / "tmux_logs" / "late-done.exit_code"
    exit_path.parent.mkdir(parents=True)
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    task = {"commandId": "late-done", "workerId": "worker-a", "status": "running", "pid": "%97", "tmuxSession": "zlk-gpu-2", "exitCodePath": "simple_cluster/tmux_logs/late-done.exit_code"}
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [task]})
    agent.subprocess.run = lambda *args, **kwargs: types.SimpleNamespace(returncode=0, stdout="zlk-gpu-2")
    assert agent.reconcile_worker_tasks_after_restart(root)["changed"] == 0
    events = []
    agent.append_event = lambda root, event: events.append(event)
    agent.subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("runtime reconciliation must not probe tmux"))
    assert agent.api_worker_tasks(root)["tasks"][0]["status"] == "running"
    exit_path.write_text("0", encoding="utf-8")
    completed = agent.api_worker_tasks(root)["tasks"][0]
    assert completed["status"] == "completed" and completed["exitCode"] == 0, completed
    assert completed["finishedAt"] and completed["reconciledAt"], completed
    assert agent.api_worker_tasks(root)["tasks"][0]["status"] == "completed"
    assert [event["type"] for event in events] == ["worker_task_completed"], events
print("post-restart task read repair ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /post-restart task read repair ok/);
  assert.doesNotMatch(agentSource, /start_worker_task_recovery_loop\(root/);
});


test("worker task log activity uses file mtime without hashing", () => {
  const script = `
import calendar, importlib.util, os, pathlib, tempfile
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["sha256_file","worker_task_log_updated_at"])
with tempfile.TemporaryDirectory() as root:
    log_rel = "simple_cluster/tmp/cluster_scheduler/logs/worker.log"
    path = pathlib.Path(root) / log_rel
    path.parent.mkdir(parents=True)
    path.write_text("worker output", encoding="utf-8")
    fixed_epoch = calendar.timegm((2026, 9, 24, 11, 30, 0))
    os.utime(path, (fixed_epoch, fixed_epoch))
    agent.sha256_file = lambda *_args: (_ for _ in ()).throw(AssertionError("must not hash log"))
    assert agent.worker_task_log_updated_at(root, {"logPath": log_rel}) == "2026-09-24T11:30:00Z"
    assert agent.worker_task_log_updated_at(root, {"log_path": log_rel}) == "2026-09-24T11:30:00Z"
    assert agent.worker_task_log_updated_at(root, {}) == ""
    assert agent.worker_task_log_updated_at(root, {"logPath": "simple_cluster/missing.log"}) == ""
    assert agent.worker_task_log_updated_at(root, {"logPath": "simple_cluster/../../outside.log"}) == ""
print("worker log activity mtime ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("worker exit-code reconciliation handles failure and preserves manual stop", () => {
  const script = `
import importlib.util, pathlib, tempfile, os
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","append_event","atomic_write","path_for","read_json","reconcile_worker_task_exit_codes"])
with tempfile.TemporaryDirectory() as root:
    agent.AGENT_STATE_DIR = os.path.join(root, "state")
    log_dir = pathlib.Path(root) / "simple_cluster" / "tmux_logs"
    log_dir.mkdir(parents=True)
    (log_dir / "failed.exit_code").write_text("7", encoding="utf-8")
    (log_dir / "stopped.exit_code").write_text("0", encoding="utf-8")
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [
        {"commandId": "failed", "workerId": "worker-a", "status": "running", "exitCodePath": "simple_cluster/tmux_logs/failed.exit_code"},
        {"commandId": "stopped", "status": "stopped", "manualStopType": "manual_stop", "exitCodePath": "simple_cluster/tmux_logs/stopped.exit_code"},
    ]})
    events = []
    agent.append_event = lambda root, event: events.append(event)
    assert agent.reconcile_worker_task_exit_codes(root)["changed"] == 1
    tasks = {task["commandId"]: task for task in agent.read_json(snapshot, {})["tasks"]}
    assert tasks["failed"]["status"] == "failed" and tasks["failed"]["exitCode"] == 7, tasks
    assert tasks["stopped"]["status"] == "stopped", tasks
    assert [event["type"] for event in events] == ["worker_task_failed"], events
    assert agent.reconcile_worker_task_exit_codes(root)["changed"] == 0
    assert len(events) == 1, events
print("worker exit-code reconciliation ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test("worker telemetry health reports its serving session and fresh GPU snapshot", () => {
  const script = `
import importlib.util, pathlib, tempfile, os
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","AGENT_VERSION","api_health","atomic_write","inspect_agent","now_iso","path_for","session"])
with tempfile.TemporaryDirectory() as tmp:
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project"); os.makedirs(root)
    started = agent.now_iso()
    agent.atomic_write(agent.path_for(root, "agent.session.json"), {"startedAt": started, "agentVersion": agent.AGENT_VERSION})
    agent.atomic_write(agent.path_for(root, "gpu_snapshot.json"), {"generatedAt": started, "gpu": [{"gpuId": 0}]})
    agent.inspect_agent = lambda root: {"running": False, "startedAt": ""}
    health = agent.api_health(root, "worker_telemetry")
    assert health["status"] == "ok", health
    assert health["startedAt"] == started, health
    assert health["snapshotAge"] < 5, health
    assert health["workerCount"] == 1, health
print("worker telemetry health ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
