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
spec = importlib.util.spec_from_file_location("agent_install_rich_test", sys.argv[1])
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return SimpleNamespace(returncode=0, stdout="14.3.2\\n", stderr="")
with patch.object(agent, "simple_runtime_python", return_value="/env/bin/python"), patch.object(agent.os.path, "isfile", return_value=True), patch.object(agent.os, "access", return_value=True), patch.object(agent.subprocess, "run", fake_run), patch.object(agent, "terminal_action", lambda root, action, operation_id, op_id, status, message, result=None: {"status": status, "result": result}):
    result = agent.install_rich_action("/project", {"condaEnv": "/env"}, "op", "op")
print(json.dumps({"status": result["status"], "version": result["result"]["version"], "install": calls[0], "verify": calls[1]}))
`;
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, ["-c", script, agent], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.status, "completed");
  assert.equal(value.version, "14.3.2");
  assert.deepEqual(value.install, ["/env/bin/python", "-m", "pip", "install", "rich>=14.3,<15"]);
  assert.equal(value.verify[0], "/env/bin/python");
});
