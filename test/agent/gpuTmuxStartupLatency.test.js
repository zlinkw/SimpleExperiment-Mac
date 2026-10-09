const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const agent = path.join(__dirname, "../../dist/runtime/cluster_agent.py");

test("GPU tmux startup does not sleep for idle shell or Conda activation", () => {
  const script = `
import importlib.util, pathlib, sys, tempfile
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("agent_gpu_latency", sys.argv[1])
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
calls = []
def fake_run(args, **kwargs):
    calls.append(args)
    return SimpleNamespace(returncode=0, stdout="%12\\n", stderr="")
with tempfile.TemporaryDirectory() as root:
    log = pathlib.Path(root) / "task.log"
    exit_code = pathlib.Path(root) / "task.exit_code"
    with patch.object(agent, "tmux_session_alive", return_value=False), patch.object(agent.subprocess, "run", fake_run), patch.object(agent, "simple_conda_env_name", return_value="/env"), patch.object(agent, "simple_conda_env_python", return_value="/env/bin/python"), patch.object(agent.os.path, "isfile", return_value=True), patch.object(agent.os, "access", return_value=True), patch.object(agent.time, "sleep", side_effect=AssertionError("fixed startup sleep")):
        pane = agent.start_job_in_gpu_pane("zlk-gpu-0", ["python", "job.py"], root, {"SIMPLE_EXPERIMENT_CONDA_ENV": "/env"}, log, exit_code)
assert pane == "%12", pane
assert [item[1] for item in calls] == ["new-session", "new-window"], calls
assert "exec bash" in calls[-1][-1], calls[-1]
calls.clear()
sleeps = []
def retry_run(args, **kwargs):
    calls.append(args)
    if args[1] == "new-window" and sum(item[1] == "new-window" for item in calls) == 1:
        return SimpleNamespace(returncode=1, stdout="", stderr="can't find session")
    return SimpleNamespace(returncode=0, stdout="%13\\n", stderr="")
with tempfile.TemporaryDirectory() as root:
    with patch.object(agent, "tmux_session_alive", return_value=False), patch.object(agent.subprocess, "run", retry_run), patch.object(agent, "simple_conda_env_name", return_value="/env"), patch.object(agent, "simple_conda_env_python", return_value="/env/bin/python"), patch.object(agent.os.path, "isfile", return_value=True), patch.object(agent.os, "access", return_value=True), patch.object(agent.time, "sleep", side_effect=lambda seconds: sleeps.append(seconds)):
        pane = agent.start_job_in_gpu_pane("zlk-gpu-0", ["python", "job.py"], root, {"SIMPLE_EXPERIMENT_CONDA_ENV": "/env"}, pathlib.Path(root) / "task.log", pathlib.Path(root) / "task.exit_code")
assert pane == "%13", pane
assert sleeps == [0.2], sleeps
print("gpu pane ready")
`;
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(python, ["-c", script, agent], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /gpu pane ready/);
});
