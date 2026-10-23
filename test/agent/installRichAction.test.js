const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const agent = path.join(__dirname, "../../dist/runtime/cluster_agent.py");

test("install-rich uses only the configured environment Python and fixed requirement", () => {
  const script = `
import importlib.util, json, sys
from types import SimpleNamespace
from unittest.mock import patch
import sys
sys.path.insert(0, ${JSON.stringify(require("node:path").resolve(__dirname, "../_helpers"))})
from extractRuntimeFunctions import extract_runtime_functions
agent = extract_runtime_functions(sys.argv[1], ["install_rich_action", "os", "subprocess"])
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return SimpleNamespace(returncode=0, stdout="14.3.2\\n", stderr="")
with patch.object(agent, "simple_runtime_python", return_value="/env/bin/python"), patch.object(agent.os.path, "isfile", return_value=True), patch.object(agent.os, "access", return_value=True), patch.object(agent.subprocess, "run", fake_run), patch.object(agent, "terminal_action", lambda root, action, operation_id, op_id, status, message, result=None: {"status": status, "result": result}):
    result = agent.install_rich_action("/project", {"condaEnv": "/env"}, "op", "op")
print(json.dumps({"status": result["status"], "version": result["result"]["version"], "install": calls[0], "verify": calls[1]}))
`;
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, ["-B", (() => { const f = require("node:fs"), p = require("node:path"); const d = f.mkdtempSync(p.join(require("node:os").tmpdir(), "se-python-fixture-")); const file = p.join(d, "probe.py"); f.writeFileSync(file, script, "utf8"); console.log("kept Python fixture at " + d); return file; })(), agent], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.status, "completed");
  assert.equal(value.version, "14.3.2");
  assert.deepEqual(value.install, ["/env/bin/python", "-m", "pip", "install", "rich>=14.3,<15"]);
  assert.equal(value.verify[0], "/env/bin/python");
});
