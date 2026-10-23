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


test("TensorBoard stop resolves an exact window and rejects ambiguity or changed identity", () => {
  const script = `
import pathlib, tempfile, types
import sys
sys.path.insert(0, ${JSON.stringify(path.resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["close_tensorboard_window", "tensorboard_action"])
calls = []
mode = "normal"
list_count = 0
def run(args, **kwargs):
    global list_count
    calls.append(args)
    stdout, stderr, code = "", "", 0
    if args[1] == "list-windows":
        if "-a" in args:
            stdout = "@99\\n"
        else:
            list_count += 1
            stdout = "owner_tb|0|@7|tensorboard\\n"
            if mode == "ambiguous": stdout += "owner_tb|1|@99|research\\n"
            if mode == "changed" and list_count > 1: stdout = "owner_tb|0|@8|tensorboard\\n"
    elif args[1] == "list-panes": stdout = "%12\\n"
    elif args[1] != "kill-window": raise AssertionError(args)
    return types.SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)
agent.subprocess.run = run
agent.terminal_action = lambda root, action, operation_id, op_id, status, message, extra: {"status": status, "message": message, **extra}
root = tempfile.mkdtemp(prefix="tensorboard-window-identity-")
for mode in ("normal", "ambiguous", "changed"):
    calls.clear()
    list_count = 0
    result = agent.tensorboard_action(root, "stop-tensorboard", {"sessionPrefix": "Owner"}, "op", "id")
    mutations = [args for args in calls if args[1].startswith("kill-")]
    if mode == "normal":
        assert result["status"] == "completed" and result["closedWindowIds"] == ["@7"], result
        assert mutations == [["tmux", "kill-window", "-t", "@7"]], calls
    else:
        assert result["status"] == "failed", result
        assert mutations == [], calls
print("ok")
`;
  const result = runPython(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("worker Agent proxies TensorBoard pages only for an active session and valid token", () => {
  const script = `
import importlib.util, pathlib, tempfile, threading, types, os, urllib.request, urllib.error, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["TENSORBOARD_PROXY_PORTS","ThreadingHTTPServer","serve_http","start_gpu_log_tail_sampler","start_worker_hub_uplink","start_worker_local_command_processor","start_worker_telemetry_sampler","tmux_session_alive"])
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
# Service ownership and collector behavior have dedicated runtime tests. This
# fixture owns only its loopback HTTP servers and temporary state directory.
agent.lifecycle_service_guard = lambda args, version: (None,{"projectDir":args.project_dir,"workerId":args.worker_id})
agent.task_update_scheduler_runtime = lambda *a, **k: {}
agent.gpu_collector_ensure = lambda *a, **k: {"mode":"fixture"}
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
    agent.AGENT_STATE_DIR = os.path.join(root, 'state')
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
  assert.equal(packageJson.contributes.configuration.properties["simpleExperimentMac.tensorboard.port"].default, 6006);
  assert.equal(packageJson.contributes.configuration.properties["simpleExperimentMac.tensorboard.logdir"].default, "work_dirs");
  assert.equal(packageJson.contributes.configuration.properties["simpleExperimentMac.tensorboard.tmuxSession"].default, "");
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
