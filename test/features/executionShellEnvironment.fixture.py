"""Only extracted launch helpers; stdlib probes never run a research entry point."""
import copy, io, json, os, pathlib, subprocess, sys
from types import SimpleNamespace

repo = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo / "test/_helpers"))
from extractRuntimeFunctions import extract_runtime_functions
scheduler = extract_runtime_functions(str(repo / "dist/runtime/cluster_scheduler.py"), ["execution_shell_preflight"])
agent = extract_runtime_functions(str(repo / "dist/runtime/cluster_agent.py"), ["formal_job_command_env"])
agent.fresh_task_runtime_env = lambda: {"SIMPLE_EXPERIMENT_CONDA_ENV": "/wrong-prefix", "SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY": "stale"}
receipts = []
for index in (0, 1):
    identity = {"workflowId": "工作流 空格'\"", "commandId": "command" + str(index), "globalJobId": "工作流 空格'\":" + str(index),
                "planRevision": "revision", "codeFingerprint": "code"}
    command = {**identity, "condaEnv": ""}
    frozen = copy.deepcopy(command)
    env = agent.formal_job_command_env(command)
    assert env["SIMPLE_EXPERIMENT_CONDA_ENV"] == "" and command == frozen
    assert json.loads(env["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"]) == identity
    scheduler.simple_runtime_env = lambda base=None: dict(os.environ, **env) if base is None else dict(base)
    report = scheduler.execution_shell_preflight()
    assert report["ok"] and report["shellVerified"] and report["executionStarted"] is False, report
    assert report["identity"] == env["SIMPLE_EXPERIMENT_FORMAL_JOB_IDENTITY"]
    assert os.path.realpath(report["python"]) == os.path.realpath(sys.executable)
    receipts.append(report)
assert receipts[0]["identity"] != receipts[1]["identity"]
assert agent.formal_job_command_env({**identity, "options": {"condaEnv": "/explicit prefix"}})["SIMPLE_EXPERIMENT_CONDA_ENV"] == "/explicit prefix"

good = {"python": sys.executable, "prefix": sys.prefix, "identity": receipts[-1]["identity"]}
failures = []
class Probe:
    def __init__(self, output, stall=False):
        self.stdout, self.stderr = io.BytesIO(output), io.BytesIO(b"failure detail")
        self.returncode = None if stall else 0
        self.stall, self.reaped = stall, False
    def wait(self, timeout):
        if self.stall and self.returncode is None:
            raise subprocess.TimeoutExpired("stdlib probe", timeout)
        self.reaped = True
        return self.returncode
    def poll(self): return self.returncode
    def kill(self): self.returncode = -9

for value in ([1], {**good, "identity": "foreign"}, {**good, "python": "foreign"}, "x" * 70000):
    proc = Probe(json.dumps(value).encode("utf-8"))
    scheduler.subprocess = SimpleNamespace(Popen=lambda *args, **kw: proc, DEVNULL=subprocess.DEVNULL, PIPE=subprocess.PIPE, TimeoutExpired=subprocess.TimeoutExpired)
    report = scheduler.execution_shell_preflight()
    assert not report["ok"] and report["errorCode"] == "EXECUTION_SHELL_PREFLIGHT_FAILED" and proc.reaped, report
    failures.append(report["error"])
proc = Probe(b"", stall=True)
scheduler.subprocess.Popen = lambda *args, **kw: proc
report = scheduler.execution_shell_preflight()
assert not report["ok"] and proc.reaped and proc.returncode == -9
failures.append(report["error"])
print(json.dumps({"receipts": receipts, "failures": failures}, ensure_ascii=False))
