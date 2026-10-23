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


test("local TensorBoard commands use the UI handler when invoked through the API", () => {
  const actionSet = extensionSource.match(/const uiActionCommands = new Set<WebviewActionCommand>\(\[([\s\S]*?)\]\);/)?.[1] || "";
  for (const command of ["openTensorBoard", "startTensorBoard", "copyTensorBoardUrl", "openTensorBoardUrl"]) {
    assert.doesNotMatch(actionSet, new RegExp(`"${command}"`));
  }
  assert.match(extensionSource, /return await this\.withSafeTransferRetry\(command, message, \(\) => this\.handleMessageCore\(message, command\)\);/);
  assert.match(extensionSource, /case "prepareAgents":\s*await this\.prepareAgentsForFirstRun\(message\.uiMode !== true\)/);
});


test("fence_stale_run_plans: overlapping live scheduler blocks replacement without killing it", () => {
  const script = `
import importlib.util, pathlib, os, tempfile, json, time, subprocess, sys
agent_path = pathlib.Path(${JSON.stringify(agentPath)})
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(agent_path, ["AGENT_STATE_DIR","_is_pid_alive","_read_run_plan_registry","_reap_zombie_scheduler_sessions","_run_plan_registry_path","_tmux_pane_python_running","_tmux_prefix","fence_stale_run_plans","register_active_run_plan","scheduler_process_evidence","simple_tmux_name","subprocess","tmux_available","tmux_session_alive"])

def registry_path(root):
    return agent._run_plan_registry_path(root)

with tempfile.TemporaryDirectory() as tmp:
    # Isolate agent state to tmp
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project")
    os.makedirs(root, exist_ok=True)

    # Mock tmux and pid liveness to avoid real system calls
    orig_tmux_alive = agent.tmux_session_alive
    orig_pid_alive = agent._is_pid_alive
    orig_tmux_available = agent.tmux_available
    alive_sessions = set()
    alive_pids = set()
    reap_calls = []

    def fake_tmux_alive(sess, cwd=None, env=None):
        return sess in alive_sessions
    def fake_pid_alive(pid):
        return int(pid) in alive_pids
    def fake_tmux_available():
        return True
    def fake_reap(root_arg, known):
        reap_calls.append(set(known))
        return []

    agent.tmux_session_alive = fake_tmux_alive
    agent._is_pid_alive = fake_pid_alive
    agent.tmux_available = fake_tmux_available
    agent.scheduler_process_evidence = lambda root_arg, pid, session: {
        "tmuxShellAlive": session in alive_sessions,
        "tmuxSessionAlive": session in alive_sessions and int(pid) in alive_pids,
        "pidAlive": int(pid) in alive_pids,
    }
    # we want to test reap logic directly, so keep original reap for now but mock tmux ls
    # Test 1: overlapping workerIds -> block replacement
    # register old plan op-old with worker w1
    old_op = "op-old-111"
    new_op = "op-new-222"
    # simulate old entry alive
    alive_sessions.add(agent.simple_tmux_name(f"sch-{old_op}"))
    alive_pids.add(12345)
    agent.register_active_run_plan(root, old_op, 12345, agent.simple_tmux_name(f"sch-{old_op}"), ["w1"], "worker-1")
    # also register a non-overlapping old entry
    other_op = "op-other-333"
    alive_sessions.add(agent.simple_tmux_name(f"sch-{other_op}"))
    alive_pids.add(12346)
    agent.register_active_run_plan(root, other_op, 12346, agent.simple_tmux_name(f"sch-{other_op}"), ["w2"], "worker-2")

    # Mock kill to just remove from alive sets
    orig_kill = agent.subprocess.run
    orig_kill_pid = os.kill
    def fake_run(args, **kwargs):
        if args[:3] == ["tmux", "kill-session", "-t"]:
            sess = args[3]
            alive_sessions.discard(sess)
            class R: returncode=0
            return R()
        if args[:3] == ["tmux", "has-session", "-t"]:
            class R: pass
            result = R(); result.returncode = 0 if args[3] in alive_sessions else 1
            return result
        if args == ["tmux", "ls"]:
            class R:
                stdout="\\n".join(list(alive_sessions)) + "\\n"
                returncode=0
            return R()
        return orig_kill(args, **kwargs)
    agent.subprocess.run = fake_run
    def fake_os_kill(pid, sig):
        alive_pids.discard(int(pid))
    os.kill = fake_os_kill

    # New scheduler must leave old scheduler and its training tasks alone.
    result = agent.fence_stale_run_plans(root, new_op, ["w1"], "worker-1")
    assert old_op in result["blocked"], f"expected blocked {old_op}, got {result}"
    assert other_op not in result["blocked"], "non-overlapping should not be blocked"
    assert agent.simple_tmux_name(f"sch-{old_op}") in alive_sessions
    assert 12345 in alive_pids
    # other should remain
    assert agent.simple_tmux_name(f"sch-{other_op}") in alive_sessions
    # registry preserves both live schedulers
    reg = agent._read_run_plan_registry(root)
    ops = [e["opId"] for e in reg]
    assert old_op in ops
    assert other_op in ops

    # Test 2: same owner even with different workerIds -> block
    alive_sessions.add(agent.simple_tmux_name(f"sch-{other_op}"))
    # re-add old-like entry with same owner but different worker
    owner_op = "op-owner-444"
    alive_sessions.add(agent.simple_tmux_name(f"sch-{owner_op}"))
    alive_pids.add(12347)
    agent.register_active_run_plan(root, owner_op, 12347, agent.simple_tmux_name(f"sch-{owner_op}"), ["w9"], "worker-1")
    result2 = agent.fence_stale_run_plans(root, "op-new-555", ["w10"], "worker-1")
    assert owner_op in result2["blocked"], f"same owner should block, got {result2}"

    # A completed scheduler may leave its tmux shell and pid behind for logs.
    # It must not block another Plan or be killed by the fence.
    old_session = agent.simple_tmux_name(f"sch-{old_op}")
    alive_pids.discard(12345)
    result3 = agent.fence_stale_run_plans(root, "op-new-666", ["w1"], "worker-1")
    assert old_op not in result3["blocked"], result3
    assert old_op not in [e["opId"] for e in agent._read_run_plan_registry(root)]
    assert old_session in alive_sessions, "completed scheduler window must be preserved"

    # Test 3: zombie reap -> session not in registry but tmux ls shows it
    # An unregistered yet live scheduler must survive the reaper.
    live_unregistered = agent._tmux_prefix() + "-sch-starting999"
    alive_sessions.add(live_unregistered)
    agent._tmux_pane_python_running = lambda session, env: session == live_unregistered
    zombie_sess = agent._tmux_prefix() + "-sch-zombie999"
    alive_sessions.add(zombie_sess)
    # ensure zombie not in registry
    reg_before = agent._read_run_plan_registry(root)
    known = [e["opId"] for e in reg_before]
    assert "zombie999" not in known
    reaped = agent._reap_zombie_scheduler_sessions(root, known, zombie_sess)
    assert reaped == [], reaped
    assert zombie_sess in alive_sessions, "historical unbound consoles must be preserved"
    assert live_unregistered in alive_sessions

    # restore
    agent.tmux_session_alive = orig_tmux_alive
    agent._is_pid_alive = orig_pid_alive
    agent.tmux_available = orig_tmux_available
    agent.subprocess.run = orig_kill
    os.kill = orig_kill_pid

print("fence ok")
`;
  const r = runPython(script);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /fence ok/);
});


test("stop-scheduler-operation delegates the original command and never reaps unrelated history", () => {
  const start=agentSource.indexOf('def stop_scheduler_operation('),end=agentSource.indexOf('def recent_operations(',start);
  const stop=agentSource.slice(start,end);
  assert.match(stop,/task_stop\(root, command, worker\)/);
  assert.doesNotMatch(stop,/_reap_|os\.kill|kill-session|scheduler_process_evidence/);
});


test("stop-scheduler-operation leaves every GPU task intact when target scheduler is absent", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, json
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","_is_pid_alive","atomic_write","os","path_for","read_json","scheduler_process_evidence","stop_scheduler_operation","subprocess"])
with tempfile.TemporaryDirectory() as tmp:
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project"); os.makedirs(root)
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    original = {"schemaVersion": 1, "tasks": [{"status": "running", "planFile": "experiments/plans/other.yaml", "pid": 321, "tmuxSession": "zlk-gpu-0"}]}
    agent.atomic_write(snapshot, original)
    agent.scheduler_process_evidence = lambda *args: {"pidAlive": False, "tmuxSessionAlive": False, "tmuxShellAlive": False, "checkedPid": 0, "checkedTmuxSession": "zlk-sch-target"}
    agent._is_pid_alive = lambda pid: True
    def forbidden(*args, **kwargs): raise AssertionError("unrelated process terminated")
    agent.subprocess.run = forbidden
    agent.os.kill = forbidden
    result = agent.stop_scheduler_operation(root, {"targetOperationId": "target", "operationId": "stop-1", "opId": "stop-1", "planFile": "experiments/plans/current.yaml"})
    assert result["status"] == "failed", result
    assert result["matchedOperations"] == [], result
    assert agent.read_json(snapshot, {})["tasks"] == original["tasks"]
print("unmatched stop preserved GPU tasks")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
