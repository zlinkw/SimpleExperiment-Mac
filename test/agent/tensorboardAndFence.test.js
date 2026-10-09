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

function runPython(script) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-test-"));
  const file = path.join(tmp, "run.py");
  fs.writeFileSync(file, script, "utf8");
  try {
    return spawnSync("python", [file], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("Worker task snapshot preserves output and config paths", () => {
  const script = `
import importlib.util, pathlib, tempfile, os
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as root:
    agent.AGENT_STATE_DIR = os.path.join(root, "state")
    scheduler = os.path.join(root, "cluster_scheduler.py")
    pathlib.Path(scheduler).write_text("# test", encoding="utf-8")
    agent.require_scheduler_dependencies = lambda *args: None
    agent.simple_runtime_python = lambda *args: "python"
    agent.tmux_available = lambda: True
    agent.start_job_in_gpu_pane = lambda *args: "%97"
    agent.exit_code_ready = lambda *args: True
    agent.read_task_exit_code = lambda *args: 0
    agent._safe_kill_pane = lambda *args: None
    targets = []
    class FakeThread:
        def __init__(self, target, **kwargs): self.target = target
        def start(self): targets.append(self.target)
    agent.threading.Thread = FakeThread
    command = {"action": "start-worker-task", "commandId": "run-test", "projectDir": root, "schedulerPath": scheduler, "plan": "experiments/plans/demo.yaml", "gpuId": "0", "condaEnv": "research", "outputDir": "work_dirs/demo/0_baseline_seed42", "configPath": "work_dirs/demo/0_baseline_seed42/job_config.yaml"}
    result = agent.execute_worker_command(root, command, "worker-a")
    assert result["status"] == "running", result
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    task = agent.read_json(snapshot, {})["tasks"][0]
    assert task["outputDir"] == command["outputDir"]
    assert task["configPath"] == command["configPath"]
    targets[0]()
    task = agent.read_json(snapshot, {})["tasks"][0]
    assert task["status"] == "completed", task
    assert task["outputDir"] == command["outputDir"]
    assert task["configPath"] == command["configPath"]
print("worker config paths persisted")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("legacy Worker task recovers config from its own persisted launch log", () => {
  const script = [
    'import importlib.util, pathlib, tempfile, os, json',
    'spec = importlib.util.spec_from_file_location("agent", pathlib.Path(' + JSON.stringify(agentPath) + '))',
    'agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)',
    'with tempfile.TemporaryDirectory() as root:',
    '    agent.AGENT_STATE_DIR = os.path.join(root, "state")',
    '    plan = pathlib.Path(root, "experiments/plans/old.yaml")',
    '    plan.parent.mkdir(parents=True)',
    '    plan.write_text("suite: changed\\ncases:\\n  - case: unrelated\\nseeds: [99]\\n", encoding="utf-8")',
    '    config_rel = "work_dirs/archive/run-43/job_config.yaml"',
    '    config = pathlib.Path(root, config_rel)',
    '    config.parent.mkdir(parents=True)',
    '    config.write_text("experiment_name: historical/run-43\\n", encoding="utf-8")',
    '    log_rel = "simple_cluster/tmp/cluster_scheduler/logs/legacy-run.log"',
    '    log = pathlib.Path(root, log_rel)',
    '    log.parent.mkdir(parents=True)',
    '    context = {"output_dir": "work_dirs/archive/run-43", "config_path": config_rel}',
    '    log.write_text("[simple-experiment-runtime] start index=6\\npython run_wrapper.py --output-dir work_dirs/archive/run-43 --context-json " + json.dumps(context) + " -- python train.py --config " + config_rel + "\\n", encoding="utf-8")',
    '    task = {"commandId": "legacy-run", "status": "completed", "planFile": "experiments/plans/old.yaml", "experimentIndex": 6, "case": "baseline", "seed": 43, "logPath": log_rel}',
    '    snapshot = agent.path_for(root, "worker_task_snapshot.json")',
    '    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [task]})',
    '    recovered = agent.api_worker_tasks(root)["tasks"][0]',
    '    assert recovered["outputDir"] == "work_dirs/archive/run-43", recovered',
    '    assert recovered["configPath"] == config_rel, recovered',
    '    persisted = agent.read_json(snapshot, {})["tasks"][0]',
    '    assert "configPath" not in persisted and "outputDir" not in persisted, persisted',
    '    assert agent.api_worker_tasks(root)["tasks"][0]["configPath"] == config_rel',
    '    other_rel = "work_dirs/other/job_config.yaml"',
    '    other = pathlib.Path(root, other_rel)',
    '    other.parent.mkdir(parents=True)',
    '    other.write_text("experiment_name: other\\n", encoding="utf-8")',
    '    log.write_text(log.read_text(encoding="utf-8") + json.dumps({"config_path": other_rel}) + "\\n", encoding="utf-8")',
    '    conflicted = agent.api_worker_tasks(root)["tasks"][0]',
    '    assert "configPath" not in conflicted and "outputDir" not in conflicted, conflicted',
    '    unsafe = dict(task, logPath="../outside.log")',
    '    assert agent.recover_worker_task_launch_paths(root, unsafe) == unsafe',
    '    external = dict(task, logPath="/tmp/outside.log")',
    '    assert agent.recover_worker_task_launch_paths(root, external) == external',
    '    current = dict(task, configPath="work_dirs/new/correct/job_config.yaml", outputDir="work_dirs/new/correct")',
    '    assert agent.recover_worker_task_launch_paths(root, current) == current',
    'print("historical launch paths recovered without current plan")',
  ].join("\n");
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("tb_tmux_session_name normalizes prefix to <normalized>_tb", () => {
  assert.match(agentSource, /def tb_tmux_session_name\(prefix\)/);
  assert.match(agentSource, /return p \+ "_tb"/);
  // TS side normalizeRemoteTmuxSessionPrefix lowercases, replaces [^a-z0-9._-] with "-", trims, slices 32
  const py = `
import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
cases = [
  ("Simple", "simple_tb"),
  ("ZLK_Test", "zlk_test_tb"),
  ("My Prefix!", "my-prefix_tb"),
  ("", "simple_tb"),
  ("-invalid", "invalid_tb"),
  ("A"*40, "a"*32 + "_tb"),
]
for inp, expected in cases:
    got = agent.tb_tmux_session_name(inp)
    assert got == expected, f"{inp!r} -> {got!r} != {expected!r}"
    assert len(got) <= 35, got
print("ok")
`;
  const r = runPython(py);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("tb_discover_launch: explicit script hit / relative discovery / logdir fallback / events dir / root fallback", () => {
  const script = `
import importlib.util, pathlib, os, tempfile, json, sys
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

def assert_discover(root, logdir_hint, port, explicit, expected_source_contains, expected_logdir_checker):
    args, source, logdir = agent.tb_discover_launch(root, logdir_hint, port, explicit)
    assert expected_source_contains in str(source), f"source {source!r} missing {expected_source_contains!r}"
    if expected_logdir_checker:
        assert expected_logdir_checker(logdir), f"logdir {logdir!r} failed checker"
    return args, source, logdir

with tempfile.TemporaryDirectory() as tmp:
    # 1) explicit relative script hit (must be within allowed project roots: tmp/start_tb.sh etc)
    explicit_rel = "tmp/my_tb.sh"
    explicit_path = os.path.join(tmp, "tmp", "my_tb.sh")
    os.makedirs(os.path.dirname(explicit_path), exist_ok=True)
    with open(explicit_path, "w") as f:
        f.write("#!/bin/bash\\ntensorboard --path_prefix /api/tensorboard/ui")
    args, src, _ = assert_discover(tmp, "work_dirs", 6006, explicit_rel, "my_tb.sh", lambda x: x is None)
    assert args[0] == "bash" and "my_tb.sh" in args[1], args

    # 1b) explicit absolute hit
    args, src, _ = assert_discover(tmp, "work_dirs", 6006, explicit_path, "my_tb.sh", lambda x: x is None)
    assert args[0] == "bash"

    # 1c) explicit given but not exists -> falls through to next discovery
    args, src, _ = assert_discover(tmp, "work_dirs", 6006, "nonexistent.sh", "tensorboard", lambda x: True)

    # 2) discovery order: tmp/start_tb.sh and simple_cluster/tmp/start_tb.sh are within allowed roots
    # start_tb.sh and scripts/start_tb.sh at root are not in safe_project_path allowlist, so they fall back to tensorboard
    for rel, should_find in [("tmp/start_tb.sh", True), ("simple_cluster/tmp/start_tb.sh", True), ("start_tb.sh", False), ("scripts/start_tb.sh", False)]:
        with tempfile.TemporaryDirectory() as tmp2:
            cand = os.path.join(tmp2, *rel.split("/"))
            # ensure parent exists (for root file, dirname is tmp2 itself)
            parent = os.path.dirname(cand)
            if parent and not os.path.exists(parent):
                os.makedirs(parent, exist_ok=True)
            with open(cand, "w") as f:
                f.write("#!/bin/bash\\ntensorboard --path_prefix /api/tensorboard/ui")
            args, src, _ = agent.tb_discover_launch(tmp2, "work_dirs", 6006, "")
            if should_find:
                assert os.path.normpath(src) == os.path.normpath(cand), f"expected {cand}, got {src}"
                assert args[0] == "bash" and os.path.normpath(args[1]) == os.path.normpath(cand)
            else:
                # safe_project_path rejects this rel, so discovery skips it and falls back to tensorboard (root or hint)
                assert src == "tensorboard", f"expected tensorboard fallback for {rel}, got {src}"

    # 3) fallback tensorboard with hint dir exists -> uses hint
    with tempfile.TemporaryDirectory() as tmp3:
        hint = os.path.join(tmp3, "work_dirs")
        os.makedirs(hint)
        args, src, logdir = agent.tb_discover_launch(tmp3, "work_dirs", 6006, "")
        assert src == "tensorboard"
        assert logdir == hint
        assert "--logdir" in args and str(6006) in args
        assert args[args.index("--path_prefix") + 1] == "/api/tensorboard/ui"
        assert args[args.index("--host") + 1] == "127.0.0.1"

    # 4) hint missing, events dir exists -> uses events dir
    with tempfile.TemporaryDirectory() as tmp4:
        # create nested events file depth 2
        ev_dir = os.path.join(tmp4, "work_dirs", "run1")
        os.makedirs(ev_dir)
        with open(os.path.join(ev_dir, "events.out.tfevents.123"), "w") as f:
            f.write("x")
        args, src, logdir = agent.tb_discover_launch(tmp4, "work_dirs", 6006, "")
        # hint work_dirs exists (as parent) -> would use hint before events search. So ensure hint does NOT exist to trigger events search
        # clean hint and use non-existing hint
        import shutil
        shutil.rmtree(os.path.join(tmp4, "work_dirs"))
        # now no hint, but events dir is still found via tb_find_events_dir bounded search
        # recreate events at depth 1 with new root
        os.makedirs(ev_dir, exist_ok=True)
        with open(os.path.join(ev_dir, "events.out.tfevents.456"), "w") as f:
            f.write("x")
        # use hint "work_dirs/missing_xyz" which is allowed (work_dirs prefix) but does not exist, so fallback to events dir
        args, src, logdir = agent.tb_discover_launch(tmp4, "work_dirs/missing_xyz", 6006, "")
        assert src == "tensorboard"
        assert logdir == ev_dir, f"expected {ev_dir}, got {logdir}"

    # 5) no hint, no events -> fallback to root
    with tempfile.TemporaryDirectory() as tmp5:
        args, src, logdir = agent.tb_discover_launch(tmp5, "work_dirs", 6006, "")
        assert src == "tensorboard"
        assert logdir == tmp5

    # 6) tb_find_events_dir respects depth <=5 and skips .git/node_modules/.venv/simple_cluster
    with tempfile.TemporaryDirectory() as tmp6:
        # create deep events beyond depth 5 -> should not be found
        deep = tmp6
        for i in range(7):
            deep = os.path.join(deep, f"d{i}")
            os.makedirs(deep, exist_ok=True)
        with open(os.path.join(deep, "events.out.tfevents.999"), "w") as f:
            f.write("x")
        found = agent.tb_find_events_dir(tmp6, max_depth=5)
        assert found is None, f"should not find deep {found}"
        # skip .git
        git_ev = os.path.join(tmp6, ".git", "ev")
        os.makedirs(git_ev, exist_ok=True)
        with open(os.path.join(git_ev, "events.out.tfevents.111"), "w") as f:
            f.write("x")
        found2 = agent.tb_find_events_dir(tmp6, max_depth=5)
        assert found2 is None or ".git" not in found2, found2

print("tb_discover_launch ok")
`;
  const r = runPython(script);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /tb_discover_launch ok/);
});

test("tensorboard actions are worker controls with no result ownership requirement", () => {
  assert.match(agentSource, /WORKER_TENSORBOARD_ACTIONS = \{"start-tensorboard", "stop-tensorboard", "get-tensorboard-status"\}/);
  assert.match(agentSource, /\*\*\{name: True for name in WORKER_TENSORBOARD_ACTIONS\}/);
  assert.match(agentSource, /\/api\/actions\/start-tensorboard/);
  assert.match(agentSource, /\/api\/actions\/stop-tensorboard/);
  assert.match(agentSource, /\/api\/actions\/get-tensorboard-status/);
  assert.match(agentSource, /if action in \("start-tensorboard", "stop-tensorboard", "get-tensorboard-status"\):\s*\n\s*return tensorboard_action/);
  // verify dist py also contains routing
  const distPy = fs.readFileSync(agentPath, "utf8");
  assert.match(distPy, /tensorboard_action\(root, action, payload/);
});

test("stop-tensorboard only kills the configured TensorBoard session", () => {
  const script = `
import importlib.util, pathlib, tempfile, types
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
calls = []
agent.tmux_session_alive = lambda session, root, env: session == 'owner_tb'
agent.subprocess.run = lambda args, **kwargs: (calls.append(args) or types.SimpleNamespace(returncode=0, stderr=''))
agent.terminal_action = lambda root, action, operation_id, op_id, status, message, extra: {'status': status, **extra}
with tempfile.TemporaryDirectory() as root:
    result = agent.tensorboard_action(root, 'stop-tensorboard', {'sessionPrefix': 'Owner'}, 'op', 'id')
assert result['status'] == 'completed' and result['running'] is False, result
assert calls == [['tmux', 'kill-session', '-t', 'owner_tb']], calls
print('ok')
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("worker Agent proxies TensorBoard pages only for an active session and valid token", () => {
  const script = `
import importlib.util, pathlib, tempfile, threading, types, urllib.request, urllib.error, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
class TensorBoard(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = b'tensorboard page'
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
tb = ThreadingHTTPServer(('127.0.0.1', 0), TensorBoard)
threading.Thread(target=tb.serve_forever, daemon=True).start()
agent.start_worker_telemetry_sampler = lambda *a, **k: None
agent.start_gpu_log_tail_sampler = lambda *a, **k: None
agent.start_worker_hub_uplink = lambda *a, **k: None
agent.start_worker_local_command_processor = lambda *a, **k: None
servers = []
class CapturedServer(ThreadingHTTPServer):
    def serve_forever(self):
        servers.append(self)
        threading.Thread(target=lambda: ThreadingHTTPServer.serve_forever(self), daemon=True).start()
agent.ThreadingHTTPServer = CapturedServer
with tempfile.TemporaryDirectory() as root:
    result_path = pathlib.Path(root) / 'experiments' / 'results' / 'concatenation.csv'
    result_path.parent.mkdir(parents=True)
    result_path.write_bytes(b'protocol_version,value\\n1,0.5\\n')
    agent.serve_http(types.SimpleNamespace(host='127.0.0.1', port=0, token='secret', mode='worker_telemetry', project_dir=root, worker_id='test'))
    local = servers[0]
    result_url = f'http://127.0.0.1:{local.server_port}/api/files/download?path=experiments%2Fresults%2Fconcatenation.csv'
    result_req = urllib.request.Request(result_url, headers={'X-Simple-Agent-Token': 'secret'})
    assert urllib.request.urlopen(result_req, timeout=5).read() == result_path.read_bytes()
    agent.tmux_session_alive = lambda *a, **k: False
    status_url = f'http://127.0.0.1:{local.server_port}/api/actions/get-tensorboard-status'
    status_req = urllib.request.Request(status_url, data=json.dumps({'opId': 'tb-status', 'sessionPrefix': 'owner'}).encode(), headers={'X-Simple-Agent-Token': 'secret', 'Content-Type': 'application/json'}, method='POST')
    status = json.load(urllib.request.urlopen(status_req, timeout=5))
    assert status['status'] == 'completed' and status['running'] is False, status
    agent.TENSORBOARD_PROXY_PORTS['owner_tb'] = tb.server_port
    url = f'http://127.0.0.1:{local.server_port}/api/tensorboard/proxy?port={tb.server_port}&sessionPrefix=owner&path=%2Fdata%2Fplugin'
    req = urllib.request.Request(url, headers={'X-Simple-Agent-Token': 'secret'})
    assert urllib.request.urlopen(req, timeout=5).read() == b'tensorboard page'
    browser_url = f'http://127.0.0.1:{local.server_port}/api/tensorboard/ui/'
    assert urllib.request.urlopen(browser_url, timeout=5).read() == b'tensorboard page'
    try:
        urllib.request.urlopen(url, timeout=5)
        raise AssertionError('missing token accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 401, exc.code
    agent.TENSORBOARD_PROXY_PORTS.clear()
    try:
        urllib.request.urlopen(req, timeout=5)
        raise AssertionError('inactive session accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 403, exc.code
    try:
        urllib.request.urlopen(browser_url, timeout=5)
        raise AssertionError('inactive browser route accepted')
    except urllib.error.HTTPError as exc:
        assert exc.code == 403, exc.code
    local.shutdown(); local.server_close()
tb.shutdown(); tb.server_close()
print('proxy ok')
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /proxy ok/);
});

test("openTensorBoardFromUi restarts <prefix>_tb, polls status, and opens the Agent tunnel URL", () => {
  // Check package.json config
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.tensorboard.port"].default, 6006);
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.tensorboard.logdir"].default, "work_dirs");
  assert.equal(packageJson.contributes.configuration.properties["simpleExperiment.tensorboard.tmuxSession"].default, "");
  // Check extension.ts logic
  assert.match(extensionSource, /async openTensorBoardFromUi/);
  assert.match(extensionSource, /postTensorboardAction/);
  assert.match(extensionSource, /start-tensorboard/);
   assert.match(extensionSource, /for \(let i = 0; i < 5; i\+\+\)/);
   assert.match(extensionSource, /await new Promise.*2000/);
  assert.match(extensionSource, /get-tensorboard-status/);
  assert.match(extensionSource, /status\.listening/);
  assert.match(extensionSource, /tunnelHttpOrigin\(endpoint\.localHost, endpoint\.localPort\)/);
  assert.match(extensionSource, /fetch\(url, \{ signal: AbortSignal\.timeout\(5000\) \}\)/);
  assert.match(extensionSource, /TB 启动失败，请检查服务器 start_tb\.sh \/ 端口占用/);
  // body contains only non-absolute fields
  assert.match(extensionSource, /sessionPrefix.*port.*logdir.*condaEnv.*tmuxSession/);
  // Verify transmission via hub or worker client (through postTensorboardAction wrapper)
  assert.match(extensionSource, /postTensorboardAction/);
  assert.match(extensionSource, /postWorkerAction|postAction/);
});

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
spec = importlib.util.spec_from_file_location("agent", agent_path)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

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
    assert zombie_sess in reaped, f"zombie should be reaped, got {reaped}"
    assert zombie_sess not in alive_sessions
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

test("stop-scheduler-operation deregisters and reaps with remaining registry, not empty set", () => {
  assert.match(agentSource, /remaining = set\(str\(e\.get\("opId"\) or ""\) for e in _read_run_plan_registry\(root\)/);
  assert.match(agentSource, /_reap_zombie_scheduler_sessions\(root, remaining, target_session\)/);
});

test("stop-scheduler-operation leaves every GPU task intact when target scheduler is absent", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, json
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
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

test("stop-scheduler-operation terminates only tasks from the selected Plan", () => {
  const script = `
import importlib.util, pathlib, tempfile, os
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as tmp:
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project"); os.makedirs(root)
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [
        {"status": "running", "planFile": "experiments/plans/current.yaml", "workflowId": "target", "workerId": "worker-a", "pid": 101, "tmuxSession": "zlk-gpu-0"},
        {"status": "running", "planFile": "experiments/plans/other.yaml", "pid": 202, "tmuxSession": "zlk-gpu-1"},
    ]})
    calls = []; probes = iter([True, False])
    def evidence(*args):
        live = next(probes)
        return {"pidAlive": False, "tmuxSessionAlive": live, "tmuxShellAlive": live, "checkedPid": 0, "checkedTmuxSession": "zlk-sch-target"}
    agent.scheduler_process_evidence = evidence
    agent.read_operation_events = lambda *args: [{"payload": {"planFile": "experiments/plans/current.yaml"}}]
    agent.tmux_session_alive = lambda session, cwd=None, env=None: True
    agent._reap_zombie_scheduler_sessions = lambda *args: []
    agent._is_pid_alive = lambda pid: True
    def fake_run(args, **kwargs):
        calls.append(tuple(args))
        class Result: returncode = 0; stderr = b""
        return Result()
    agent.subprocess.run = fake_run
    agent.os.kill = lambda pid, sig: calls.append(("kill", pid))
    result = agent.stop_scheduler_operation(root, {"targetOperationId": "target", "operationId": "stop-1", "opId": "stop-1", "planFile": "experiments/plans/current.yaml"})
    assert result["status"] == "completed", result
    assert ("kill", 101) in calls, calls
    assert ("tmux", "kill-session", "-t", "zlk-gpu-0") not in calls, calls
    assert ("tmux", "kill-session", "-t", "zlk-gpu-1") not in calls, calls
    assert ("kill", 202) not in calls, calls
    tasks = agent.read_json(snapshot, {})["tasks"]
    assert tasks[0]["status"] == "stopped" and tasks[1]["status"] == "running", tasks
print("scoped stop preserved other Plan")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("stop-scheduler-operation handles tmux pane ids and persists every matching task", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as tmp:
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project"); os.makedirs(root)
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    plan = "experiments/plans/current.yaml"
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [
        {"commandId": "run-a", "workflowId": "target", "workerId": "worker-a", "status": "running", "planFile": plan, "pid": "%97", "tmuxSession": "zlk-gpu-0"},
        {"commandId": "run-b", "workflowId": "target", "workerId": "worker-a", "status": "running", "planFile": plan, "pid": "%99", "tmuxSession": "zlk-gpu-1"},
        {"commandId": "run-other", "workflowId": "other-run", "workerId": "worker-b", "status": "running", "planFile": "experiments/plans/other.yaml", "pid": "%101", "tmuxSession": "zlk-gpu-2"},
    ]})
    probes = iter([True, False])
    def evidence(*args):
        live = next(probes)
        return {"pidAlive": False, "tmuxSessionAlive": live, "tmuxShellAlive": live, "checkedPid": 0, "checkedTmuxSession": "zlk-sch-target"}
    agent.scheduler_process_evidence = evidence
    agent.read_operation_events = lambda *args: [{"payload": {"planFile": plan}}]
    agent._reap_zombie_scheduler_sessions = lambda *args: []
    agent.tmux_session_alive = lambda *args, **kwargs: True
    calls = []
    def fake_run(args, **kwargs):
        calls.append(tuple(args))
        if args[:4] == ["tmux", "display-message", "-p", "-t"]:
            return types.SimpleNamespace(returncode=0, stdout={"%97": "zlk-gpu-0", "%99": "zlk-gpu-1", "%101": "zlk-gpu-2"}.get(args[4], ""), stderr=b"")
        return types.SimpleNamespace(returncode=0, stdout="", stderr=b"")
    agent.subprocess.run = fake_run
    agent.os.kill = lambda *args: (_ for _ in ()).throw(AssertionError("tmux pane id passed to os.kill"))
    result = agent.stop_scheduler_operation(root, {"targetOperationId": "target", "operationId": "stop-1", "opId": "stop-1", "planFile": plan})
    tasks = agent.read_json(snapshot, {})["tasks"]
    assert result["status"] == "completed", result
    assert [task["status"] for task in tasks] == ["stopped", "stopped", "running"], tasks
    assert ("tmux", "kill-pane", "-t", "%97") in calls and ("tmux", "kill-pane", "-t", "%99") in calls, calls
    assert ("tmux", "kill-pane", "-t", "%101") not in calls, calls
    assert ("tmux", "kill-session", "-t", "zlk-gpu-2") not in calls, calls
print("pane-scoped stop persisted all tasks")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("stop-scheduler-operation can finish stale Plan cleanup after its scheduler exited", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as tmp:
    agent.AGENT_STATE_DIR = os.path.join(tmp, "state")
    root = os.path.join(tmp, "project"); os.makedirs(root)
    plan = "experiments/plans/current.yaml"
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [
        {"commandId": "run-a", "workflowId": "target", "workerId": "worker-a", "status": "running", "planFile": plan, "pid": "%97", "tmuxSession": "zlk-gpu-0"},
        {"commandId": "run-other", "workflowId": "other-run", "workerId": "worker-b", "status": "running", "planFile": "experiments/plans/other.yaml", "pid": "%99", "tmuxSession": "zlk-gpu-1"},
    ]})
    agent.scheduler_process_evidence = lambda *args: {"pidAlive": False, "tmuxSessionAlive": False, "tmuxShellAlive": False, "checkedPid": 0, "checkedTmuxSession": "zlk-sch-target"}
    agent.read_operation_events = lambda *args: [{"payload": {"planFile": plan}}]
    agent._reap_zombie_scheduler_sessions = lambda *args: []
    def stale_pane(args, **kwargs):
        assert args[:4] == ["tmux", "display-message", "-p", "-t"], args
        return types.SimpleNamespace(returncode=1, stdout="", stderr=b"")
    agent.subprocess.run = stale_pane
    result = agent.stop_scheduler_operation(root, {"targetOperationId": "target", "operationId": "stop-2", "opId": "stop-2", "planFile": plan})
    tasks = agent.read_json(snapshot, {})["tasks"]
    assert result["status"] == "completed", result
    assert [task["status"] for task in tasks] == ["stopped", "running"], tasks
print("stale Plan cleanup completed")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Worker restart reconciles finished and missing tmux panes", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
with tempfile.TemporaryDirectory() as root:
    agent.AGENT_STATE_DIR = os.path.join(root, "state")
    done_path = pathlib.Path(root) / "simple_cluster" / "tmux_logs" / "done.exit_code"
    done_path.parent.mkdir(parents=True)
    done_path.write_text("0", encoding="utf-8")
    snapshot = agent.path_for(root, "worker_task_snapshot.json")
    agent.atomic_write(snapshot, {"schemaVersion": 1, "tasks": [
        {"commandId": "gone", "status": "running", "planFile": "plan.yaml", "pid": "%97", "tmuxSession": "zlk-gpu-0"},
        {"commandId": "live", "status": "running", "planFile": "plan.yaml", "pid": "%99", "tmuxSession": "zlk-gpu-1"},
        {"commandId": "done", "status": "running", "planFile": "plan.yaml", "pid": "%101", "tmuxSession": "zlk-gpu-2", "exitCodePath": "simple_cluster/tmux_logs/done.exit_code"},
    ]})
    def fake_run(args, **kwargs):
        assert args[:4] == ["tmux", "display-message", "-p", "-t"], args
        return types.SimpleNamespace(returncode=0 if args[4] == "%99" else 1, stdout="zlk-gpu-1" if args[4] == "%99" else "", stderr="")
    agent.subprocess.run = fake_run
    result = agent.reconcile_worker_tasks_after_restart(root)
    tasks = agent.read_json(snapshot, {})["tasks"]
    assert result["changed"] == 2, result
    assert [task["status"] for task in tasks] == ["failed", "running", "completed"], tasks
print("worker restart reconciliation ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("worker task API self-heals an exit code produced after Agent restart", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
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
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
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
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
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
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)
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

test("extension and agent never hardcode absolute server paths or tmux names", () => {
  // Check that tb session name is derived from prefix, not hardcoded
  assert.match(agentSource, /tb_tmux_session_name\(prefix\)/);
  assert.match(agentSource, /normalizeRemoteTmuxSessionPrefix/i);
  assert.match(extensionSource, /_tb/);
  assert.match(extensionSource, /tbSession/);
  // Ensure no absolute server path in tb_discover_launch candidates (they are relative to root)
  assert.match(agentSource, /for rel in \("tmp\/start_tb\.sh", "start_tb\.sh", "scripts\/start_tb\.sh", "simple_cluster\/tmp\/start_tb\.sh"\)/);
});

test("TensorBoard browser URL uses the existing Agent tunnel without a local listener", () => {
  assert.match(extensionSource, /\/api\/tensorboard\/ui\//);
  assert.doesNotMatch(extensionSource, /tensorboardProxy\.open\(/);
  assert.match(agentSource, /TENSORBOARD_BROWSER_PREFIX = "\/api\/tensorboard\/ui"/);
});

test("worker_tmux_session_name: single-machine degenerates to gpu-<gpu>, multi-machine keeps worker", () => {
  assert.match(agentSource, /def worker_tmux_session_name\(worker_id, gpu_id, local_worker_id=None\)/);
  const py = `
import importlib.util, pathlib, os
spec = importlib.util.spec_from_file_location("agent", pathlib.Path(${JSON.stringify(agentPath)}))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

def check(worker_id, gpu_id, local, expected):
    got = agent.worker_tmux_session_name(worker_id, gpu_id, local_worker_id=local)
    assert got == expected, f"worker={worker_id!r} gpu={gpu_id!r} local={local!r} -> {got!r} != {expected!r}"
    assert got.startswith("gpu-"), got

# single-machine signals: empty / worker / default -> degenerate to gpu-<gpu>
check("", "0", None, "gpu-0")
check("worker", "3", None, "gpu-3")
check("default", "7", None, "gpu-7")
# worker matches local id -> same machine -> degenerate
check("nodeA", "3", "nodeA", "gpu-3")
# distinct worker vs local -> multi-machine -> keep worker in name
check("Worker-1", "0", "nodeA", "gpu-worker-1-0")
# worker normalization: uppercase + spaces collapsed to dashes, lowercased; gpu stays numeric
check("My Worker!", "0", "other", "gpu-my-worker-0")
check("GPU-Node", "0", "nodeA", "gpu-gpu-node-0")
print("ok")
`;
  const r = runPython(py);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
