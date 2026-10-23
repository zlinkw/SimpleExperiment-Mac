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
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(pathlib.Path(${JSON.stringify(agentPath)}), ["worker_tmux_session_name"])

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
