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


function runStopBoundary(group) {
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.join(__dirname,'exactWindowStopBoundary.fixture.py'),group],
    {encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.match(result.stdout,new RegExp(group+' ok'));
}
test("stop-scheduler-operation cancels the original command and preserves unrelated Plan windows",()=>runStopBoundary('native'));
test("an unhealthy controller cannot force PID or session fallback for exact legacy windows",()=>runStopBoundary('fallback'));
test("unbound historical state, foreign owners and missing targets cannot authorize window closure",()=>runStopBoundary('identity'));

test("Worker restart reconciles finished and missing tmux panes", () => {
  const script = `
import importlib.util, pathlib, tempfile, os, types
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["AGENT_STATE_DIR","atomic_write","path_for","read_json","reconcile_worker_tasks_after_restart","subprocess"])
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
