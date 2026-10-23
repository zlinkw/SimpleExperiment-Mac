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


test("Worker task snapshot preserves output and config paths", () => {
  const script = `
import importlib.util, pathlib, tempfile, os
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","_safe_kill_pane","execute_worker_command","exit_code_ready","path_for","read_json","read_task_exit_code","require_scheduler_dependencies","simple_runtime_python","start_job_in_gpu_pane","threading","tmux_available"])
with tempfile.TemporaryDirectory() as root:
    agent.AGENT_STATE_DIR = os.path.join(root, "state")
    scheduler = os.path.join(root, "cluster_scheduler.py")
    pathlib.Path(scheduler).write_text("# test", encoding="utf-8")
    # Mac adapter: worker_plan_project_path(require_file=True) proves the Plan file physically
    # exists before a declared task is accepted; the fixture must create it like the real sync would.
    plan_file = pathlib.Path(root) / "experiments" / "plans" / "demo.yaml"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("suite: demo\\ncases:\\n  - case: 0_baseline_seed42\\nseeds: [42]\\n", encoding="utf-8")
    agent.require_scheduler_dependencies = lambda *args: None
    agent.verified_formal_job_command = lambda _, command: {"identity":{"workflowId":"workflow", "commandId":command["commandId"], "globalJobId":"workflow:0", "planRevision":"revision", "codeFingerprint":"sha"}}
    agent.worker_task_tmux_location = lambda *args: {"tmuxPane":"%97", "tmuxWindowId":"@97", "tmuxSession":"fixture"}
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
    command = {"action": "start-worker-task", "resultPathPolicy":"declared", "commandId": "run-test", "projectDir": root, "schedulerPath": scheduler, "plan": "experiments/plans/demo.yaml", "gpuId": "0", "condaEnv": "research", "outputDir": "work_dirs/demo/0_baseline_seed42", "configPath": "work_dirs/demo/0_baseline_seed42/job_config.yaml"}
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
    ("spec = (lambda _name, _file: __import__(\"runpy\").run_path(" + JSON.stringify(require("node:path").resolve(__dirname, "../_helpers/extractRuntimeFunctions.py")) + ")[\"extract_runtime_functions\"](_file, [\"AGENT_STATE_DIR\",\"api_worker_tasks\",\"atomic_write\",\"path_for\",\"read_json\",\"recover_worker_task_launch_paths\"]))(\"agent\", pathlib.Path(") + JSON.stringify(agentPath) + '))',
    "agent = spec; pass",
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
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["tb_tmux_session_name"])
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
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["tb_discover_launch","tb_find_events_dir"])

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
